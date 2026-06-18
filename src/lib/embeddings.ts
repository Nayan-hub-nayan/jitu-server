import { config } from '../config.js';

// ── Gemini text-embedding-004 wrapper ────────────────────────────
// Free tier: 1,500 RPM, 1M tokens/day
// Output dimension: 768

type TaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

interface GeminiEmbedResponse {
  embedding: {
    values: number[];
  };
}

/**
 * Embed text using Gemini text-embedding-004.
 *
 * @param text   - The text to embed
 * @param taskType - RETRIEVAL_DOCUMENT for wiki chunks, RETRIEVAL_QUERY for user questions
 * @returns 768-dimensional embedding vector
 */
export async function embedText(
  text: string,
  taskType: TaskType
): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.embeddingModel}:embedContent?key=${config.gemini.apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${config.gemini.embeddingModel}`,
      content: { parts: [{ text }] },
      taskType,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Gemini embedding error (${response.status}): ${errorBody}`
    );
  }

  const data = (await response.json()) as GeminiEmbedResponse;
  return data.embedding.values;
}

/**
 * Embed multiple texts with rate-limit-safe batching.
 * Processes sequentially with a small delay to stay within free tier limits.
 */
export async function embedBatch(
  texts: string[],
  taskType: TaskType,
  delayMs = 50
): Promise<number[][]> {
  const embeddings: number[][] = [];

  for (const text of texts) {
    const embedding = await embedText(text, taskType);
    embeddings.push(embedding);

    // Small delay to avoid rate limiting on free tier
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return embeddings;
}
