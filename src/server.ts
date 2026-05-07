/**
 * server.ts — Main Express server for Ask Akash RAG backend
 *
 * POST /api/chat  — Embeds query, runs hybrid_search, prompts MiniMax M2.7,
 *                    streams response as SSE
 * GET  /api/health — Health check
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { retrieve } from './lib/retrieval.js';
import { supabase } from './lib/supabase.js';
import {
  SYSTEM_PROMPT,
  FALLBACK_RESPONSE,
  buildContextBlock,
} from './prompts.js';

// ── Express setup ───────────────────────────────────────────────
const app = express();

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);

      const allowed = config.allowedOrigins.some((pattern) => {
        if (typeof pattern === 'string') return pattern === origin;
        if (pattern instanceof RegExp) return pattern.test(origin);
        return false;
      });

      if (allowed) {
        callback(null, true);
      } else {
        // In development, allow all origins
        if (process.env.NODE_ENV !== 'production') {
          callback(null, true);
        } else {
          callback(new Error(`CORS: origin ${origin} not allowed`));
        }
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

// ── POST /api/chat — RAG + SSE streaming ─────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, sessionId } = req.body as ChatRequest;

  // Validate input
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Invalid request: messages array required.' });
    return;
  }

  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.role === 'user');

  if (!lastUserMessage) {
    res.status(400).json({ error: 'No user message found.' });
    return;
  }

  const query = lastUserMessage.content.trim();
  if (!query) {
    res.status(400).json({ error: 'User message cannot be empty.' });
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  try {
    // ── 1. Retrieve relevant chunks ──────────────────────────
    const { chunks, topScore, isFallback } = await retrieve(query);

    // ── 2. Handle fallback (no relevant context) ─────────────
    if (isFallback) {
      res.write(
        `data: ${JSON.stringify({ type: 'token', content: FALLBACK_RESPONSE })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({ type: 'done', citations: [] })}\n\n`
      );
      res.end();

      // Log the fallback conversation
      await logConversation({
        sessionId: sessionId ?? 'anonymous',
        question: query,
        answer: FALLBACK_RESPONSE,
        retrievedChunkIds: [],
        topSimilarityScore: topScore,
        wasFallback: true,
        visitorIpHash: null,
      });

      return;
    }

    // ── 3. Build context + messages for MiniMax ──────────────
    const contextBlock = buildContextBlock(chunks);

    const llmMessages: LlmMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

    // Include conversation history (last 4 exchanges max), excluding latest query.
    const historyMessages = messages.slice(-8);
    for (const msg of historyMessages) {
      if (msg.role === 'user' && msg.content !== query) {
        llmMessages.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        llmMessages.push({ role: 'assistant', content: msg.content });
      }
    }

    // Put the current question last with explicit retrieved context.
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
          max_tokens: 4096, // ~2k reasoning + ~2k answer
          stream: true,
          temperature: 0.3, // low temp for factual RAG
        }),
      }
    );

    if (!miniMaxResponse.ok) {
      const errText = await miniMaxResponse.text();
      console.error(`MiniMax API error (${miniMaxResponse.status}):`, errText);
      res.write(
        `data: ${JSON.stringify({ type: 'error', content: 'AI service error.' })}\n\n`
      );
      res.end();
      return;
    }

    // ── 5. Parse SSE from MiniMax and forward tokens ─────────
    const reader = miniMaxResponse.body?.getReader();
    if (!reader) {
      res.write(
        `data: ${JSON.stringify({ type: 'error', content: 'No response stream.' })}\n\n`
      );
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
      buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const dataStr = trimmed.slice(6); // Remove "data: "
        if (dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          const token = parsed.choices?.[0]?.delta?.content;

          if (token) {
            fullAnswer += token;
            res.write(
              `data: ${JSON.stringify({ type: 'token', content: token })}\n\n`
            );
          }
        } catch {
          // Skip malformed JSON lines (e.g. partial data)
        }
      }
    }

    // ── 6. Send done event with citations ────────────────────
    const citations = chunks.map((c) => ({
      heading: c.heading,
      source: c.surface_type,
    }));

    res.write(
      `data: ${JSON.stringify({ type: 'done', citations })}\n\n`
    );
    res.end();

    // ── 7. Log conversation to Supabase (fire-and-forget) ────
    logConversation({
      sessionId: sessionId ?? 'anonymous',
      question: query,
      answer: fullAnswer,
      retrievedChunkIds: chunks.map((c) => c.id),
      topSimilarityScore: topScore,
      wasFallback: false,
      visitorIpHash: null,
    }).catch((err) => console.error('Failed to log conversation:', err));

  } catch (err) {
    console.error('Chat endpoint error:', err);

    // Only try to write error if the response is still writable
    if (!res.writableEnded) {
      try {
        res.write(
          `data: ${JSON.stringify({ type: 'error', content: 'Something went wrong. Please try again.' })}\n\n`
        );
        res.end();
      } catch {
        // Response already ended
      }
    }
  }
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
    timestamp: new Date().toISOString(),
  });
});

// ── Start server (or export for Vercel) ──────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.listen(config.port, () => {
    console.log(`\n🚀 AskAkash server running at http://localhost:${config.port}`);
    console.log(`   POST /api/chat     → RAG + streaming response`);
    console.log(`   GET  /api/health   → health check\n`);
  });
}

export default app;
