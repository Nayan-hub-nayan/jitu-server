import 'dotenv/config';

// ── Validate required env vars ────────────────────────────────────
function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

export const config = {
  // MiniMax (OpenAI-compatible)
  minimax: {
    baseUrl: requireEnv('OPENAI_BASE_URL'),
    apiKey: requireEnv('OPENAI_API_KEY'),
    model: 'MiniMax-M1-80k',
  },

  // Gemini embeddings
  gemini: {
    apiKey: requireEnv('GEMINI_API_KEY'),
    embeddingModel: 'text-embedding-004',
    embeddingDimension: 768,
  },

  // Supabase
  supabase: {
    url: requireEnv('SUPABASE_URL'),
    serviceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: process.env.SUPABASE_ANON_KEY ?? '',
  },

  // Notion
  notion: {
    apiKey: requireEnv('NOTION_API_KEY'),
  },

  // Server
  port: parseInt(process.env.PORT ?? '3001', 10),

  // CORS
  allowedOrigins: [
    'https://askakash.com',
    'https://*.framer.app',
    'http://localhost:3000',
    'http://localhost:5173',
  ],
} as const;
