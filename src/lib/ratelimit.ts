/**
 * ratelimit.ts — Upstash Redis rate limiting
 *
 * Two limits per CLAUDE.md spec:
 *   - Per IP:      20 questions / hour  (sliding window)
 *   - Per session:  50 questions / total (fixed window, 24h TTL so it resets daily)
 *
 * Uses @upstash/ratelimit backed by @upstash/redis (free tier: 10k commands/day).
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ── Redis client ─────────────────────────────────────────────────
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL ?? '',
  token: process.env.UPSTASH_REDIS_REST_TOKEN ?? '',
});

// ── Per-IP limiter: 20 requests per 1 hour (sliding window) ─────
const ipLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '1 h'),
  prefix: 'rl:ip',
  analytics: true,
});

// ── Per-session limiter: 50 requests total (24h fixed window) ───
const sessionLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.fixedWindow(50, '24 h'),
  prefix: 'rl:session',
  analytics: true,
});

export interface RateLimitResult {
  allowed: boolean;
  /** Which limit was hit — 'ip' | 'session' | null */
  limitedBy: 'ip' | 'session' | null;
  /** Seconds until the limit resets */
  retryAfter: number;
}

/**
 * Check both rate limits. Returns immediately if either is exceeded.
 */
export async function checkRateLimit(
  ip: string,
  sessionId: string
): Promise<RateLimitResult> {
  // Check both in parallel
  const [ipResult, sessionResult] = await Promise.all([
    ipLimiter.limit(ip),
    sessionLimiter.limit(sessionId),
  ]);

  if (!ipResult.success) {
    return {
      allowed: false,
      limitedBy: 'ip',
      retryAfter: Math.ceil((ipResult.reset - Date.now()) / 1000),
    };
  }

  if (!sessionResult.success) {
    return {
      allowed: false,
      limitedBy: 'session',
      retryAfter: Math.ceil((sessionResult.reset - Date.now()) / 1000),
    };
  }

  return { allowed: true, limitedBy: null, retryAfter: 0 };
}

/**
 * Returns true if Upstash env vars are configured.
 * When not configured, rate limiting is skipped (dev mode).
 */
export function isRateLimitConfigured(): boolean {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL &&
    process.env.UPSTASH_REDIS_REST_TOKEN
  );
}
