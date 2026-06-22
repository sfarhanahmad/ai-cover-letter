// Upstash Redis-backed rate limiter (REST API — no SDK install needed).
// Falls back to a permissive allow if Upstash isn't configured, so local/dev
// testing doesn't break, but logs a warning so it's obvious in production.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCommand(args) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Upstash error: ${res.status}`);
  return res.json();
}

/**
 * Sliding-window-ish fixed-window rate limit using Redis INCR + EXPIRE.
 * @param {string} key   unique key, e.g. `rl:generate:1.2.3.4`
 * @param {number} max   max requests allowed in the window
 * @param {number} windowSec  window length in seconds
 * @returns {Promise<{limited: boolean, remaining: number}>}
 */
export async function checkRateLimit(key, max, windowSec) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn('Upstash not configured — rate limiting is DISABLED. Set UPSTASH_REDIS_REST_URL / TOKEN.');
    return { limited: false, remaining: max };
  }
  try {
    const incrResult = await redisCommand(['INCR', key]);
    const count = incrResult.result;
    if (count === 1) {
      await redisCommand(['EXPIRE', key, windowSec]);
    }
    return { limited: count > max, remaining: Math.max(0, max - count) };
  } catch (err) {
    console.error('Rate limit check failed (failing OPEN to avoid blocking real users):', err.message);
    // Fail open rather than breaking the whole app if Redis has a hiccup.
    return { limited: false, remaining: max };
  }
}

export function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
