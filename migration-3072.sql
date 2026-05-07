-- ═══════════════════════════════════════════════════════════════
-- MIGRATION: Update vector dimension from 768 → 3072
-- (gemini-embedding-001 replaces deprecated text-embedding-004)
--
-- Run this in your Supabase SQL Editor:
-- https://supabase.com/dashboard/project/rqvombgypskpehysxtek/sql/new
-- ═══════════════════════════════════════════════════════════════

-- NOTE: Supabase limits indexed vectors to 2000 dimensions. The embedding column is 3072 dimensions, so we cannot create an IVFFlat or HNSW index.
-- The column is added without an index; vector similarity searches will perform a sequential scan.
-- If you later move to a vector store that supports higher dimensions, you can add an appropriate index then.

-- 1. Drop the old embedding column and index (0 rows, no data loss)
DROP INDEX IF EXISTS chunks_embedding_idx;
ALTER TABLE chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE chunks ADD COLUMN embedding vector(3072);

-- 3. Recreate the hybrid_search function with new dimension
CREATE OR REPLACE FUNCTION hybrid_search(
  query_embedding vector(3072),
  query_text text,
  match_count int DEFAULT 10,
  vector_weight float DEFAULT 0.7,
  bm25_weight float DEFAULT 0.3
)
RETURNS TABLE (
  id uuid,
  heading text,
  content text,
  surface_type text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  WITH vector_results AS (
    SELECT id, heading, content, surface_type,
           1 - (embedding <=> query_embedding) AS vec_score
    FROM chunks
    WHERE surface_type != 'anti-corpus'
    ORDER BY embedding <=> query_embedding
    LIMIT match_count * 2
  ),
  bm25_results AS (
    SELECT id, heading, content, surface_type,
           ts_rank_cd(fts, websearch_to_tsquery('english', query_text)) AS bm25_score
    FROM chunks
    WHERE fts @@ websearch_to_tsquery('english', query_text)
      AND surface_type != 'anti-corpus'
    LIMIT match_count * 2
  ),
  combined AS (
    SELECT
      COALESCE(v.id, b.id) AS id,
      COALESCE(v.heading, b.heading) AS heading,
      COALESCE(v.content, b.content) AS content,
      COALESCE(v.surface_type, b.surface_type) AS surface_type,
      (COALESCE(v.vec_score, 0) * vector_weight +
       COALESCE(b.bm25_score, 0) * bm25_weight) AS similarity
    FROM vector_results v
    FULL OUTER JOIN bm25_results b ON v.id = b.id
  )
  SELECT id, heading, content, surface_type, similarity
  FROM combined
  ORDER BY similarity DESC
  LIMIT match_count;
$$;

-- Done! Now run `npm run sync` to populate the chunks table.
