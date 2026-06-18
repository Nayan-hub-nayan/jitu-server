/**
 * server.ts — Main Express server for Ask Jitu backend
 *
 * POST /api/chat       — Local Markdown-based LLM endpoint with JSON responses
 * POST /api/contact    — Contact form fallback (Resend email)
 * GET  /api/health     — Health check
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import {
  SYSTEM_PROMPT,
  getJituInfoContext,
} from './prompts.js';
import {
  checkRateLimit,
  isRateLimitConfigured,
} from './lib/ratelimit.js';
import {
  sendContactEmail,
  isEmailConfigured,
} from './lib/email.js';

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

// ── Helper: extract client IP ────────────────────────────────────
function getClientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  if (Array.isArray(forwarded)) return forwarded[0];
  return req.ip ?? '127.0.0.1';
}

// ── POST /api/chat — Chat endpoint ───────────────────────────────
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
    // ── 1. Build messages for LLM ──────────────
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
      content: `Here is the official information about Jitendra (Jitu) Raut. Base your answer ONLY on this information. Do not invent anything.\n\n<JITU_INFO>\n${getJituInfoContext()}\n</JITU_INFO>\n\n---\n\nUser Question: ${query}`,
    });

    // ── 2. Stream from OpenRouter with model fallback ──────────────
    const endpoint = config.llm.baseUrl.endsWith('/chat/completions')
      ? config.llm.baseUrl
      : `${config.llm.baseUrl}/chat/completions`;

    let llmResponse: Response | null = null;
    let usedModel: string | null = null;

    for (const model of config.llm.models) {
      console.log(`[model] trying: ${model}`);
      try {
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.llm.apiKey}`,
            'HTTP-Referer': 'https://askakash.com',
            'X-Title': 'Ask Jitu Server',
          },
          body: JSON.stringify({
            model,
            messages: llmMessages,
            max_tokens: 4096,
            stream: true,
            temperature: 0.3,
          }),
        });

        if (resp.ok) {
          llmResponse = resp;
          usedModel = model;
          console.log(`[model] succeeded: ${model}`);
          break;
        }

        const errText = await resp.text();
        console.warn(`[model] ${model} returned ${resp.status}: ${errText}`);
      } catch (fetchErr) {
        console.warn(`[model] ${model} fetch failed:`, fetchErr);
      }
    }

    if (!llmResponse || !usedModel) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI service error.' })}\n\n`);
      res.end();
      return;
    }

    // ── 3. Parse SSE from LLM and forward tokens ─────────
    const reader = llmResponse.body?.getReader();
    if (!reader) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'No response stream.' })}\n\n`);
      res.end();
      return;
    }

    const decoder = new TextDecoder();
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
            res.write(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`);
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    // Send done event
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

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
      detail: errMsg,
    });
  }
});

// ── Health check ─────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    models: config.llm.models,
    rateLimiting: isRateLimitConfigured(),
    email: isEmailConfigured(),
    timestamp: new Date().toISOString(),
  });
});

// ── Start server (or export for Vercel) ──────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.listen(config.port, () => {
    console.log(`\n🚀 Ask Jitu server running at http://localhost:${config.port}`);
    console.log(`   POST /api/chat     → Local Data + JSON Streaming`);
    console.log(`   POST /api/contact  → Contact form (Resend email)`);
    console.log(`   GET  /api/health   → Health check\n`);
  });
}

export default app;
