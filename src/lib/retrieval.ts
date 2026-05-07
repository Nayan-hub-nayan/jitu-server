import { supabase, type HybridSearchResult } from './supabase.js';
import { embedText } from './embeddings.js';

// ── Similarity threshold ────────────────────────────────────────
// Without a reranker, raw hybrid scores are slightly lower.
// 0.35 is the starting point per spec. Tune after testing.
const SIMILARITY_THRESHOLD = 0.35;

/**
 * Full retrieval pipeline:
 * 1. Embed the query with Gemini (RETRIEVAL_QUERY task type)
 * 2. Run hybrid_search RPC in Supabase (vector + BM25)
 * 3. Apply "I don't know" gate
 * 4. Return top 5 chunks
 */
export async function retrieve(query: string): Promise<{
  chunks: HybridSearchResult[];
  topScore: number;
  isFallback: boolean;
}> {
  // 1. Embed the query
  const queryEmbedding = await embedText(query, 'RETRIEVAL_QUERY');

  // 2. Hybrid search in Supabase
  const { data, error } = await supabase.rpc('hybrid_search', {
    query_embedding: JSON.stringify(queryEmbedding),
    query_text: query,
    match_count: 10,
    vector_weight: 0.7,
    bm25_weight: 0.3,
  });

  if (error) {
    console.error('Hybrid search error:', error);
    throw new Error(`Retrieval failed: ${error.message}`);
  }

  const results = (data as HybridSearchResult[]) ?? [];

  // 3. "I don't know" gate
  if (!results.length || results[0].similarity < SIMILARITY_THRESHOLD) {
    return {
      chunks: [],
      topScore: results[0]?.similarity ?? 0,
      isFallback: true,
    };
  }

  // 4. Take top 5
  return {
    chunks: results.slice(0, 5),
    topScore: results[0].similarity,
    isFallback: false,
  };
}
