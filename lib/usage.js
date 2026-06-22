// Daily usage + ad-unlock tracking, backed by Upstash Redis.
// All counters key off `identity` (a cookie+IP combo set in api/generate.js)
// and reset automatically at midnight UTC via Redis key expiry.
//
// Honest limitation: this is server-tracked (much harder to bypass than
// localStorage), but NOT bypass-proof. Clearing cookies + using a fresh IP
// (e.g. new mobile data session, VPN) creates a "new" identity with a fresh
// quota. There is no way to fully close this gap without requiring accounts.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function secondsUntilMidnightUTC() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  return Math.max(60, Math.floor((midnight.getTime() - now.getTime()) / 1000));
}

async function redisCommand(args) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Upstash error: ${res.status}`);
  return res.json();
}

async function redisPipeline(commands) {
  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Upstash pipeline error: ${res.status}`);
  return res.json();
}

function dayKey(identity) {
  const day = new Date().toISOString().slice(0, 10);
  return `usage:${day}:${identity}`;
}

const FALLBACK = { letters: 0, words: 0, adsWatched: 0, bonusUnlocked: false };

export async function getDailyUsage(identity) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.warn('Upstash not configured — daily usage tracking DISABLED (limits not enforced).');
    return FALLBACK;
  }
  try {
    const key = dayKey(identity);
    const result = await redisCommand(['HGETALL', key]);
    const arr = result.result || [];
    const obj = {};
    for (let i = 0; i < arr.length; i += 2) obj[arr[i]] = arr[i + 1];
    return {
      letters: parseInt(obj.letters || '0', 10),
      words: parseInt(obj.words || '0', 10),
      adsWatched: parseInt(obj.adsWatched || '0', 10),
      bonusUnlocked: obj.bonusUnlocked === '1',
    };
  } catch (err) {
    console.error('getDailyUsage failed (failing OPEN):', err.message);
    return FALLBACK;
  }
}

export async function incrDailyUsage(identity, { letters = 0, words = 0 }) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    const key = dayKey(identity);
    const cmds = [];
    if (letters) cmds.push(['HINCRBY', key, 'letters', letters]);
    if (words) cmds.push(['HINCRBY', key, 'words', words]);
    cmds.push(['EXPIRE', key, secondsUntilMidnightUTC()]);
    await redisPipeline(cmds);
  } catch (err) {
    console.error('incrDailyUsage failed:', err.message);
  }
}

/**
 * Called once per ad "watched" (frontend confirms after the ad finishes).
 * After ADS_REQUIRED ads watched today, flips bonusUnlocked = true for the
 * rest of the day, raising both daily caps.
 */
export async function grantBonus(identity, adsRequired) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return { adsWatched: adsRequired, adsRequired, bonusUnlocked: true };
  }
  try {
    const key = dayKey(identity);
    const incrResult = await redisCommand(['HINCRBY', key, 'adsWatched', 1]);
    const adsWatched = incrResult.result;
    await redisCommand(['EXPIRE', key, String(secondsUntilMidnightUTC())]);

    let bonusUnlocked = false;
    if (adsWatched >= adsRequired) {
      await redisCommand(['HSET', key, 'bonusUnlocked', '1']);
      bonusUnlocked = true;
    }
    return { adsWatched, adsRequired, bonusUnlocked };
  } catch (err) {
    console.error('grantBonus failed:', err.message);
    return { adsWatched: 0, adsRequired, bonusUnlocked: false };
  }
}
