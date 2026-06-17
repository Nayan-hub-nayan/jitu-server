import "dotenv/config";
import OpenAI from "openai";
import express from "express";
import cors from "cors";

// ── OpenAI client (pointed at OpenRouter) ──────────────────────────
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1", // Using OpenRouter base URL (without /chat/completions)
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://askakash.com", // Optional, replace with your site URL
    "X-Title": "Smart Portfolio Server", // Optional, replace with your site name
  }
});

const SYSTEM_PROMPT = "You are a friendly and professional AI assistant.";

// ── Express setup ───────────────────────────────────────────────
const app = express();
//app.use(cors());
app.use(cors({
  origin: "*", // allow requests from any domain
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────────────────────────
// Route 1:  POST /api/chat   (standard JSON response)
//   Frontend sends:   { "message": "Hello" }
//   Backend replies:  { "reply": "Hi there! ..." }
// ─────────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ reply: "No message provided." });
  }

  try {
    const completion = await client.chat.completions.create({
      model: "openai/gpt-oss-120b:free",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
      temperature: 1.0,
      top_p: 0.95,
      max_tokens: 2048,
    });

    const reply = completion.choices[0].message.content;
    res.json({ reply });
  } catch (err) {
    console.error("MiniMax API error:", err.message);
    res.status(502).json({ reply: "Error: AI service unavailable." });
  }
});

// ─────────────────────────────────────────────────────────────────
// Route 2:  POST /api/chat/stream   (Server-Sent Events streaming)
//   Frontend sends:   { "message": "Hello" }
//   Backend streams:  text/event-stream with chunked tokens
//
//   💡 This is the EFFICIENT option — words appear in real-time
//      instead of waiting for the full response.
// ─────────────────────────────────────────────────────────────────
app.post("/api/chat/stream", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "No message provided." });
  }

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = await client.chat.completions.create({
      model: "openai/gpt-oss-120b:free",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: message },
      ],
      temperature: 1.0,
      top_p: 0.95,
      max_tokens: 2048,
      stream: true, // ← enable streaming
    });

    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) {
        // Send each token as an SSE event
        res.write(`data: ${JSON.stringify({ token })}\n\n`);
      }
    }

    // Signal end of stream
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("Stream error:", err.message);
    res.write(`data: ${JSON.stringify({ error: "Stream failed." })}\n\n`);
    res.end();
  }
});

// ── Health check ────────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", model: "openai/gpt-oss-120b:free" });
});

// ── Start server (or export for Vercel) ─────────────────────────
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}`);
    console.log(`   POST /api/chat          → standard JSON response`);
    console.log(`   POST /api/chat/stream   → real-time streaming`);
    console.log(`   GET  /api/health        → health check\n`);
  });
}

export default app;
