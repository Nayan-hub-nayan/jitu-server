import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

// ── Supabase client (service role for backend operations) ────────
export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  {
    auth: { persistSession: false },
  }
);

// ── Types ────────────────────────────────────────────────────────
export interface ChunkRow {
  id: string;
  notion_page_id: string;
  heading: string;
  content: string;
  surface_type: string;
  embedding: number[];
  last_synced_at: string;
  notion_last_edited: string | null;
}

export interface ConversationRow {
  id: string;
  session_id: string;
  question: string;
  answer: string;
  retrieved_chunk_ids: string[];
  top_similarity_score: number | null;
  was_fallback: boolean;
  visitor_ip_hash: string | null;
  created_at: string;
}

export interface HybridSearchResult {
  id: string;
  heading: string;
  content: string;
  surface_type: string;
  similarity: number;
}
