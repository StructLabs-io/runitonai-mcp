/**
 * KV-backed sliding-hour rate limiter.
 *
 * Each (scope, key) pair gets a counter that resets every hour. We use a key
 * suffix of "YYYY-MM-DDTHH" so a single KV read + put handles both the read
 * and the windowing. KV TTL is 2 hours so a counter doesn't linger forever
 * after the window passes.
 *
 * This is good-enough for Phase 1's deterrence-grade limits. If burst
 * detection becomes a concern, swap in a Durable Object.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

export async function checkAndIncrement(
  kv: KVNamespace,
  scope: string,
  key: string,
  limitPerHour: number,
): Promise<RateLimitResult> {
  const hourBucket = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
  const fullKey = `rl:${scope}:${key}:${hourBucket}`;
  const current = await kv.get(fullKey);
  const count = current ? parseInt(current, 10) : 0;
  if (count >= limitPerHour) {
    return { allowed: false, remaining: 0, limit: limitPerHour };
  }
  // 2h TTL so the key auto-expires after its window closes.
  await kv.put(fullKey, String(count + 1), { expirationTtl: 60 * 60 * 2 });
  return {
    allowed: true,
    remaining: limitPerHour - (count + 1),
    limit: limitPerHour,
  };
}
