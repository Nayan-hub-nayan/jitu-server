import "dotenv/config";
import OpenAI from "openai";
import express from "express";
import cors from "cors";

// ── OpenAI client (pointed at OpenRouter) ──────────────────────────
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://askakash.com",
    "X-Title": "Smart Portfolio Server",
  }
});

const SYSTEM_PROMPT = "You are a friendly and professional AI assistant.";

// Fallback chain — tries models in order, moves to next on any error
const MODELS = [
  "openai/gpt-oss-120b:free",  // primary (new)
  "openai/gpt-oss-20b:free",   // fallback (old)
];

const BASE_PARAMS = {
  temperature: 1.0,
  top_p: 0.95,
  max_tokens: 2048,
};

async function callWithFallback(buildParams) {
  let lastErr;
  for (const model of MODELS) {
    try {
      const result = await client.chat.completions.create(buildParams(model));
      console.log(`[model] succeeded: ${model}`);
      return { result, model };
    } catch (err) {
      console.warn(`[model] ${model} failed — ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

// ── Express setup ───────────────────────────────────────────────
const app = express();
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────────
// Route 1:  POST /api/chat   (standard JSON response)
//   Frontend sends:   { "message": "Hello" }
//   Backend replies:  { "reply": "Hi there! ...", "model": "..." }
// ─────────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ reply: "No message provided." });

  try {
    const { result, model } = await callWithFallback((model) => ({
      ...BASE_PARAMS,
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
    }));

    const reply = result.choices[0].message.content;
    res.json({ reply, model });
  } catch (err) {
    console.error("All models failed:", err.message);
    res.status(502).json({ reply: "Error: AI service unavailable." });
  }
});

// ─────────────────────────────────────────────────────────────────
// Route 2:  POST /api/chat/stream   (Server-Sent Events streaming)
//   Frontend sends:   { "message": "Hello" }
//   Backend streams:  text/event-stream with chunked tokens
// ─────────────────────────────────────────────────────────────────
app.post("/api/chat/stream", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "No message provided." });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Try each model until one opens a stream successfully
  let stream;
  let usedModel;
  let lastErr;

  for (const model of MODELS) {
    try {
      stream = await client.chat.completions.create({
        ...BASE_PARAMS,
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message },
        ],
        stream: true,
      });
      usedModel = model;
      console.log(`[model] streaming: ${model}`);
      break;
    } catch (err) {
      console.warn(`[model] ${model} stream failed — ${err.message}`);
      lastErr = err;
    }
  }

  if (!stream) {
    console.error("All models failed for stream:", lastErr?.message);
    res.write(`data: ${JSON.stringify({ error: "Stream failed." })}\n\n`);
    return res.end();
  }

  // Tell the frontend which model is responding
  res.write(`data: ${JSON.stringify({ model: usedModel })}\n\n`);

  try {
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Stream read error:", err.message);
    res.write(`data: ${JSON.stringify({ error: "Stream interrupted." })}\n\n`);
    res.end();
  }
});

// ── Health check ────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", models: MODELS });
});

// ── Start server (or export for Vercel) ─────────────────────────
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`\n Server running at http://localhost:${PORT}`);
    console.log(`   POST /api/chat          → standard JSON response`);
    console.log(`   POST /api/chat/stream   → real-time streaming`);
    console.log(`   GET  /api/health        → health check`);
    console.log(`   Models: ${MODELS.join(" → ")}\n`);
  });
}

export default app;
