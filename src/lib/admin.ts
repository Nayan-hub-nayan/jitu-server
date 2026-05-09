/**
 * admin.ts — Admin dashboard data queries
 *
 * Provides data for the /admin page:
 *   - Low-confidence answers (top_similarity_score < 0.45)
 *   - Top queries (most common questions)
 *   - Unanswered rate (% fallbacks)
 */

import { supabase } from './supabase.js';

// ── Types ────────────────────────────────────────────────────────
export interface LowConfidenceEntry {
  id: string;
  question: string;
  answer: string;
  top_similarity_score: number | null;
  was_fallback: boolean;
  session_id: string;
  created_at: string;
}

export interface TopQuery {
  question: string;
  count: number;
  avg_score: number;
  latest_at: string;
}

export interface AdminStats {
  totalConversations: number;
  fallbackCount: number;
  fallbackRate: number; // 0–100 percentage
  avgSimilarityScore: number;
}

// ── Low-confidence answers ───────────────────────────────────────
/**
 * Fetch conversations where the similarity score is below 0.45,
 * ordered by most recent first. These need human review.
 */
export async function getLowConfidenceAnswers(
  limit = 50,
  offset = 0
): Promise<LowConfidenceEntry[]> {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, question, answer, top_similarity_score, was_fallback, session_id, created_at')
    .or('top_similarity_score.lt.0.45,was_fallback.eq.true')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    console.error('Admin: low-confidence query error:', error.message);
    throw new Error(`Failed to fetch low-confidence answers: ${error.message}`);
  }

  return (data as LowConfidenceEntry[]) ?? [];
}

// ── Top queries ──────────────────────────────────────────────────
/**
 * Get the most frequently asked questions, grouped by exact text.
 * Returns count, average similarity score, and last asked timestamp.
 */
export async function getTopQueries(limit = 30): Promise<TopQuery[]> {
  // Supabase JS client doesn't support GROUP BY natively,
  // so we use an RPC or raw query. For simplicity, fetch all
  // recent conversations and aggregate in-memory.
  const { data, error } = await supabase
    .from('conversations')
    .select('question, top_similarity_score, created_at')
    .order('created_at', { ascending: false })
    .limit(500);

  if (error) {
    console.error('Admin: top queries error:', error.message);
    throw new Error(`Failed to fetch top queries: ${error.message}`);
  }

  if (!data || data.length === 0) return [];

  // Aggregate by normalized question text
  const queryMap = new Map<
    string,
    { count: number; totalScore: number; latestAt: string }
  >();

  for (const row of data) {
    const normalized = row.question.trim().toLowerCase();
    const existing = queryMap.get(normalized);

    if (existing) {
      existing.count++;
      existing.totalScore += row.top_similarity_score ?? 0;
      if (row.created_at > existing.latestAt) {
        existing.latestAt = row.created_at;
      }
    } else {
      queryMap.set(normalized, {
        count: 1,
        totalScore: row.top_similarity_score ?? 0,
        latestAt: row.created_at,
      });
    }
  }

  // Convert to array, sort by count descending
  const results: TopQuery[] = [];
  for (const [question, agg] of queryMap) {
    results.push({
      question,
      count: agg.count,
      avg_score: agg.count > 0 ? agg.totalScore / agg.count : 0,
      latest_at: agg.latestAt,
    });
  }

  results.sort((a, b) => b.count - a.count);
  return results.slice(0, limit);
}

// ── Overall stats ────────────────────────────────────────────────
/**
 * Compute summary statistics for the admin dashboard.
 */
export async function getAdminStats(): Promise<AdminStats> {
  const { count: totalConversations, error: countError } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true });

  if (countError) {
    console.error('Admin: stats count error:', countError.message);
  }

  const { count: fallbackCount, error: fallbackError } = await supabase
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .eq('was_fallback', true);

  if (fallbackError) {
    console.error('Admin: fallback count error:', fallbackError.message);
  }

  // Fetch scores for average calculation
  const { data: scoreData, error: scoreError } = await supabase
    .from('conversations')
    .select('top_similarity_score')
    .not('top_similarity_score', 'is', null)
    .limit(1000);

  if (scoreError) {
    console.error('Admin: score avg error:', scoreError.message);
  }

  const total = totalConversations ?? 0;
  const fallbacks = fallbackCount ?? 0;

  let avgScore = 0;
  if (scoreData && scoreData.length > 0) {
    const sum = scoreData.reduce(
      (acc, row) => acc + (row.top_similarity_score ?? 0),
      0
    );
    avgScore = sum / scoreData.length;
  }

  return {
    totalConversations: total,
    fallbackCount: fallbacks,
    fallbackRate: total > 0 ? (fallbacks / total) * 100 : 0,
    avgSimilarityScore: avgScore,
  };
}
