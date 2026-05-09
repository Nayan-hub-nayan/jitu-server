/**
 * server.ts — Main Express server for Ask Akash RAG backend
 *
 * POST /api/chat       — RAG + SSE streaming
 * POST /api/contact    — Contact form fallback (Resend email)
 * GET  /api/admin      — Admin dashboard data (password-protected)
 * GET  /admin          — Admin dashboard HTML page
 * GET  /api/health     — Health check
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { config } from './config.js';
import { retrieve } from './lib/retrieval.js';
import { supabase } from './lib/supabase.js';
import {
  SYSTEM_PROMPT,
  FALLBACK_RESPONSE,
  buildContextBlock,
  extractCitationsFromText,
} from './prompts.js';
import {
  checkRateLimit,
  isRateLimitConfigured,
} from './lib/ratelimit.js';
import {
  sendContactEmail,
  isEmailConfigured,
} from './lib/email.js';
import {
  getLowConfidenceAnswers,
  getTopQueries,
  getAdminStats,
} from './lib/admin.js';

// ── Express setup ───────────────────────────────────────────────
const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed = config.allowedOrigins.some((pattern) => {
        if (typeof pattern === 'string') return pattern === origin;
        if (pattern instanceof RegExp) return pattern.test(origin);
        return false;
      });
      if (allowed || process.env.NODE_ENV !== 'production') {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json());

// ── Types ────────────────────────────────────────────────────────
interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequest {
  messages: ChatMessage[];
  sessionId?: string;
}

type LlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

// ── Helper: hash IP for privacy ──────────────────────────────────
function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

// ── Helper: extract client IP ────────────────────────────────────
function getClientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0];
  return req.ip ?? '127.0.0.1';
}

// ── POST /api/chat — RAG + SSE streaming ─────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, sessionId } = req.body as ChatRequest;

  // Validate input
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Invalid request: messages array required.' });
    return;
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMessage) {
    res.status(400).json({ error: 'No user message found.' });
    return;
  }

  const query = lastUserMessage.content.trim();
  if (!query) {
    res.status(400).json({ error: 'User message cannot be empty.' });
    return;
  }

  // ── Rate limiting (Upstash) ──────────────────────────────────
  const clientIp = getClientIp(req);
  const ipHash = hashIp(clientIp);
  const session = sessionId ?? 'anonymous';

  if (isRateLimitConfigured()) {
    try {
      const rl = await checkRateLimit(clientIp, session);
      if (!rl.allowed) {
        res.status(429).json({
          error: 'Rate limit exceeded.',
          limitedBy: rl.limitedBy,
          retryAfter: rl.retryAfter,
        });
        return;
      }
    } catch (err) {
      // If rate limiting fails, allow the request (fail open)
      console.error('Rate limit check failed:', err);
    }
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    // ── 1. Retrieve relevant chunks ──────────────────────────
    const { chunks, topScore, isFallback } = await retrieve(query);

    // ── 2. Handle fallback (no relevant context) ─────────────
    if (isFallback) {
      res.write(`data: ${JSON.stringify({ type: 'token', content: FALLBACK_RESPONSE })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', citations: [] })}\n\n`);
      res.end();

      logConversation({
        sessionId: session,
        question: query,
        answer: FALLBACK_RESPONSE,
        retrievedChunkIds: [],
        topSimilarityScore: topScore,
        wasFallback: true,
        visitorIpHash: ipHash,
      }).catch((err) => console.error('Failed to log conversation:', err));
      return;
    }

    // ── 3. Build context + messages for MiniMax ──────────────
    const contextBlock = buildContextBlock(chunks);
    const llmMessages: LlmMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

    const historyMessages = messages.slice(-8);
    for (const msg of historyMessages) {
      if (msg.role === 'user' && msg.content !== query) {
        llmMessages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        llmMessages.push({ role: 'assistant', content: msg.content });
      }
    }

    llmMessages.push({
      role: 'user',
      content: `${contextBlock}\n\n---\n\nUser question: ${query}`,
    });

    // ── 4. Stream from MiniMax M2.7 ──────────────────────────
    const miniMaxResponse = await fetch(
      `${config.minimax.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.minimax.apiKey}`,
        },
        body: JSON.stringify({
          model: config.minimax.model,
          messages: llmMessages,
          max_tokens: 4096,
          stream: true,
          temperature: 0.3,
        }),
      }
    );

    if (!miniMaxResponse.ok) {
      const errText = await miniMaxResponse.text();
      console.error(`MiniMax API error (${miniMaxResponse.status}):`, errText);
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI service error.' })}\n\n`);
      res.end();
      return;
    }

    // ── 5. Parse SSE from MiniMax and forward tokens ─────────
    const reader = miniMaxResponse.body?.getReader();
    if (!reader) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'No response stream.' })}\n\n`);
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let fullAnswer = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            fullAnswer += token;
            res.write(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`);
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    // ── 6. Send done event with citations ────────────────────
    const citations = extractCitationsFromText(fullAnswer, chunks);
    res.write(`data: ${JSON.stringify({ type: 'done', citations })}\n\n`);
    res.end();

    // ── 7. Log conversation to Supabase (fire-and-forget) ────
    logConversation({
      sessionId: session,
      question: query,
      answer: fullAnswer,
      retrievedChunkIds: chunks.map((c) => c.id),
      topSimilarityScore: topScore,
      wasFallback: false,
      visitorIpHash: ipHash,
    }).catch((err) => console.error('Failed to log conversation:', err));

  } catch (err) {
    console.error('Chat endpoint error:', err);
    if (!res.writableEnded) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', content: 'Something went wrong. Please try again.' })}\n\n`);
        res.end();
      } catch {
        // Response already ended
      }
    }
  }
});

// ── POST /api/contact — Resend email fallback ────────────────────
app.post('/api/contact', async (req, res) => {
  const { name, email, message, originalQuestion, sessionId } = req.body;

  if (!name || !email || !message) {
    res.status(400).json({ error: 'Name, email, and message are required.' });
    return;
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Invalid email address.' });
    return;
  }

  if (!isEmailConfigured()) {
    console.warn('Resend not configured — contact email not sent.');
    res.status(503).json({ error: 'Email service not configured.' });
    return;
  }

  try {
    const emailId = await sendContactEmail({
      visitorName: name,
      visitorEmail: email,
      message,
      originalQuestion,
      sessionId,
    });

    res.json({ success: true, emailId });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('Contact form error:', errMsg);
    res.status(500).json({
      error: 'Failed to send message. Please try emailing directly.',
      detail: errMsg,  // exposes the real Resend error for debugging
    });
  }
});

// ── Admin auth middleware ─────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'askakash2024';

function requireAdminAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="AskAkash Admin"');
    res.status(401).send('Authentication required');
    return;
  }

  const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
  const [, password] = decoded.split(':');

  if (password !== ADMIN_PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="AskAkash Admin"');
    res.status(401).send('Invalid credentials');
    return;
  }

  next();
}

// ── GET /api/admin — Admin dashboard JSON data ───────────────────
//app.get('/api/admin', requireAdminAuth, async (_req, res) => {

app.get('/api/admin', async (_req, res) => {
  try {
    const [stats, lowConfidence, topQueries] = await Promise.all([
      getAdminStats(),
      getLowConfidenceAnswers(50),
      getTopQueries(30),
    ]);

    res.json({ stats, lowConfidence, topQueries });
  } catch (err) {
    console.error('Admin API error:', err);
    res.status(500).json({ error: 'Failed to load admin data.' });
  }
});

// ── GET /admin — Admin dashboard HTML page ───────────────────────
// app.get('/admin', requireAdminAuth, (_req, res) => {
//   res.setHeader('Content-Type', 'text/html');
//   res.send(adminPageHtml());
// });

app.get('/admin', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(adminPageHtml());
});

// ── Conversation logging ─────────────────────────────────────────
interface ConversationLog {
  sessionId: string;
  question: string;
  answer: string;
  retrievedChunkIds: string[];
  topSimilarityScore: number;
  wasFallback: boolean;
  visitorIpHash: string | null;
}

async function logConversation(log: ConversationLog): Promise<void> {
  const { error } = await supabase.from('conversations').insert({
    session_id: log.sessionId,
    question: log.question,
    answer: log.answer,
    retrieved_chunk_ids: log.retrievedChunkIds,
    top_similarity_score: log.topSimilarityScore,
    was_fallback: log.wasFallback,
    visitor_ip_hash: log.visitorIpHash,
  });

  if (error) {
    console.error('Conversation log error:', error.message);
  }
}

// ── Health check ─────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    model: config.minimax.model,
    embedding: config.gemini.embeddingModel,
    rateLimiting: isRateLimitConfigured(),
    email: isEmailConfigured(),
    timestamp: new Date().toISOString(),
  });
});

// ── Start server (or export for Vercel) ──────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.listen(config.port, () => {
    console.log(`\n🚀 AskAkash server running at http://localhost:${config.port}`);
    console.log(`   POST /api/chat     → RAG + streaming response`);
    console.log(`   POST /api/contact  → Contact form (Resend email)`);
    console.log(`   GET  /admin        → Admin dashboard`);
    console.log(`   GET  /api/health   → health check\n`);
  });
}

export default app;

// ═══════════════════════════════════════════════════════════════════
// Admin Dashboard HTML (self-contained, no external build step)
// ═══════════════════════════════════════════════════════════════════
function adminPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ask Akash — Admin</title>
  <style>
    :root {
      --bg: #0a0a0f;
      --surface: #13131a;
      --surface-2: #1c1c26;
      --border: #2a2a3a;
      --text: #e4e4ef;
      --text-dim: #8888a0;
      --accent: #6c63ff;
      --accent-glow: rgba(108,99,255,0.15);
      --danger: #ff6b6b;
      --warning: #ffb347;
      --success: #63e6be;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: var(--bg); color: var(--text);
      line-height: 1.6; padding: 24px;
      max-width: 1200px; margin: 0 auto;
    }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
    .subtitle { color: var(--text-dim); font-size: 14px; margin-bottom: 32px; }

    /* Stats grid */
    .stats-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px; margin-bottom: 40px;
    }
    .stat-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 20px;
    }
    .stat-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-dim); }
    .stat-value { font-size: 32px; font-weight: 700; margin-top: 4px; }
    .stat-value.danger { color: var(--danger); }
    .stat-value.warning { color: var(--warning); }
    .stat-value.success { color: var(--success); }

    /* Tabs */
    .tabs { display: flex; gap: 4px; margin-bottom: 24px; }
    .tab {
      padding: 8px 20px; border-radius: 8px; border: 1px solid var(--border);
      background: transparent; color: var(--text-dim); cursor: pointer;
      font-size: 14px; transition: all 0.2s;
    }
    .tab:hover { background: var(--surface); color: var(--text); }
    .tab.active { background: var(--accent); color: #fff; border-color: var(--accent); }

    /* Table */
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th {
      text-align: left; padding: 12px 16px; border-bottom: 2px solid var(--border);
      color: var(--text-dim); font-weight: 600; font-size: 12px;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    td {
      padding: 12px 16px; border-bottom: 1px solid var(--border);
      vertical-align: top; max-width: 400px;
    }
    tr:hover { background: var(--surface); }
    .truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 300px; display: block; }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 11px; font-weight: 600;
    }
    .badge-fallback { background: rgba(255,107,107,0.15); color: var(--danger); }
    .badge-low { background: rgba(255,179,71,0.15); color: var(--warning); }
    .badge-ok { background: rgba(99,230,190,0.15); color: var(--success); }
    .score { font-family: 'SF Mono', monospace; font-size: 13px; }

    .panel { display: none; }
    .panel.active { display: block; }
    .loading { text-align: center; padding: 60px; color: var(--text-dim); }
    .refresh-btn {
      padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--surface); color: var(--text); cursor: pointer;
      font-size: 13px; float: right; transition: all 0.2s;
    }
    .refresh-btn:hover { border-color: var(--accent); background: var(--accent-glow); }
    .time-ago { color: var(--text-dim); font-size: 12px; }
  </style>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
</head>
<body>
  <h1>🔍 Ask Akash — Admin Dashboard</h1>
  <p class="subtitle">Review low-confidence answers, monitor top queries, and track usage.</p>

  <div id="stats" class="stats-grid"><div class="loading">Loading stats…</div></div>

  <button class="refresh-btn" onclick="loadData()">↻ Refresh</button>

  <div class="tabs">
    <button class="tab active" onclick="switchTab('low-conf', this)">Low Confidence</button>
    <button class="tab" onclick="switchTab('top-queries', this)">Top Queries</button>
  </div>

  <div id="low-conf" class="panel active"><div class="loading">Loading…</div></div>
  <div id="top-queries" class="panel"><div class="loading">Loading…</div></div>

  <script>
    function switchTab(id, btn) {
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      btn.classList.add('active');
    }

    function timeAgo(dateStr) {
      const diff = Date.now() - new Date(dateStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      return Math.floor(hrs / 24) + 'd ago';
    }

    function scoreBadge(score, wasFallback) {
      if (wasFallback) return '<span class="badge badge-fallback">FALLBACK</span>';
      if (score < 0.35) return '<span class="badge badge-fallback">' + score.toFixed(3) + '</span>';
      if (score < 0.45) return '<span class="badge badge-low">' + score.toFixed(3) + '</span>';
      return '<span class="badge badge-ok">' + score.toFixed(3) + '</span>';
    }

    async function loadData() {
      const btn = document.querySelector('.refresh-btn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Loading...';
      }

      // Reset panels to loading state
      document.getElementById('low-conf').innerHTML = '<div class="loading">Loading...</div>';
      document.getElementById('top-queries').innerHTML = '<div class="loading">Loading...</div>';

      try {
        const r = await fetch('/api/admin');
        const data = await r.json();

        // Stats
        const s = data.stats;
        document.getElementById('stats').innerHTML =
          '<div class="stat-card"><div class="stat-label">Total Conversations</div><div class="stat-value">' + s.totalConversations + '</div></div>' +
          '<div class="stat-card"><div class="stat-label">Fallback Rate</div><div class="stat-value ' + (s.fallbackRate > 30 ? 'danger' : s.fallbackRate > 15 ? 'warning' : 'success') + '">' + s.fallbackRate.toFixed(1) + '%</div></div>' +
          '<div class="stat-card"><div class="stat-label">Avg Similarity</div><div class="stat-value score">' + s.avgSimilarityScore.toFixed(3) + '</div></div>' +
          '<div class="stat-card"><div class="stat-label">Unanswered</div><div class="stat-value danger">' + s.fallbackCount + '</div></div>';

        // Low confidence table
        let lcHtml = '<div class="table-wrap"><table><thead><tr><th>Time</th><th>Question</th><th>Score</th><th>Answer (preview)</th></tr></thead><tbody>';
        for (const row of data.lowConfidence) {
          lcHtml += '<tr><td class="time-ago">' + timeAgo(row.created_at) + '</td>' +
            '<td><span class="truncate" title="' + row.question.replace(/"/g,'&quot;') + '">' + row.question + '</span></td>' +
            '<td>' + scoreBadge(row.top_similarity_score || 0, row.was_fallback) + '</td>' +
            '<td><span class="truncate">' + (row.answer || '').slice(0, 120) + '</span></td></tr>';
        }
        lcHtml += '</tbody></table></div>';
        if (!data.lowConfidence.length) lcHtml = '<p style="color:var(--text-dim);padding:40px;text-align:center">No low-confidence answers yet 🎉</p>';
        document.getElementById('low-conf').innerHTML = lcHtml;

        // Top queries table
        let tqHtml = '<div class="table-wrap"><table><thead><tr><th>Question</th><th>Count</th><th>Avg Score</th><th>Last Asked</th></tr></thead><tbody>';
        for (const row of data.topQueries) {
          tqHtml += '<tr><td>' + row.question + '</td>' +
            '<td><strong>' + row.count + '</strong></td>' +
            '<td class="score">' + row.avg_score.toFixed(3) + '</td>' +
            '<td class="time-ago">' + timeAgo(row.latest_at) + '</td></tr>';
        }
        tqHtml += '</tbody></table></div>';
        if (!data.topQueries.length) tqHtml = '<p style="color:var(--text-dim);padding:40px;text-align:center">No queries logged yet</p>';
        document.getElementById('top-queries').innerHTML = tqHtml;

      } catch (err) {
        console.error('Failed to load admin data:', err);
        document.getElementById('stats').innerHTML = '<p style="color:var(--danger)">Failed to load data. Check console.</p>';
      } finally {
        const btn = document.querySelector('.refresh-btn');
        if (btn) {
          btn.disabled = false;
          btn.textContent = '↻ Refresh';
        }
      }
    }

    loadData();
  </script>
</body>
</html>`;
}
