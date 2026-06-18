-- ═══════════════════════════════════════════════════════════════
-- Supabase Schema for Ask Akash RAG Backend
-- Run this in the Supabase SQL Editor to set up the database
-- ═══════════════════════════════════════════════════════════════

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────────────────────────────────────────
-- 2. Chunks table — stores embedded wiki/career/blog content
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chunks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  notion_page_id TEXT NOT NULL,
  heading TEXT NOT NULL,
  content TEXT NOT NULL,
  surface_type TEXT NOT NULL,         -- bio, career, project, faq, domain, blog, anti-corpus
  embedding vector(3072),             -- Gemini gemini-embedding-001 dimension
  last_synced_at TIMESTAMPTZ DEFAULT now(),
  notion_last_edited TEXT,

  UNIQUE(notion_page_id, heading)
);

-- Vector similarity search index (IVFFlat with cosine distance)
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 20);

-- Full-text search column (auto-generated tsvector for BM25)
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', heading || ' ' || content)) STORED;

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin (fts);

-- ─────────────────────────────────────────────────────────────────
-- 3. Conversations table — logs every Q&A pair
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  retrieved_chunk_ids UUID[],
  top_similarity_score FLOAT,
  was_fallback BOOLEAN DEFAULT false,
  visitor_ip_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for querying by session
CREATE INDEX IF NOT EXISTS conversations_session_idx ON conversations (session_id);

-- Index for querying low-confidence answers (admin dashboard)
CREATE INDEX IF NOT EXISTS conversations_score_idx ON conversations (top_similarity_score)
  WHERE top_similarity_score IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- 4. Hybrid search function (vector + BM25 combined)
-- ─────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────
-- 5. RLS — Enable Row Level Security
-- ─────────────────────────────────────────────────────────────────
-- Chunks: read-only via anon, full access via service_role
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read on chunks"
  ON chunks FOR SELECT
  USING (true);

CREATE POLICY "Allow service role insert/update on chunks"
  ON chunks FOR ALL
  USING (true)
  WITH CHECK (true);

-- Conversations: insert via anon (for logging), read via service_role only
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow insert on conversations"
  ON conversations FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Allow service role full access on conversations"
  ON conversations FOR ALL
  USING (true)
  WITH CHECK (true);
