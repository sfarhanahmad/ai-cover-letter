import { checkRateLimit, getClientIP } from '../lib/ratelimit.js';
import { getDailyUsage, incrDailyUsage, grantBonus } from '../lib/usage.js';

// ── Config ───────────────────────────────────────────────────────────────
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Free daily limits (per IP+cookie identity, resets at UTC midnight)
const BASE_LETTERS_PER_DAY = 5;
const BASE_WORDS_PER_DAY = 2000;
// After watching ads, bonus allowance unlocked for that day
const BONUS_LETTERS_PER_DAY = 10;   // total after unlock (not additive — see usage.js)
const BONUS_WORDS_PER_DAY = 4000;
const ADS_REQUIRED_FOR_BONUS = 5;

function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

// Identity used to track daily usage: a server-set httpOnly cookie (harder to
// clear accidentally than localStorage) combined with IP as a fallback signal.
// Honest limitation: this is NOT bulletproof — clearing cookies in dev tools,
// using a private/incognito window, or switching networks can reset it. There
// is no fully bypass-proof way to do this without requiring accounts.
function getOrSetClientId(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  let cid = cookies.ccraft_cid;
  if (!cid) {
    cid = 'c_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    res.setHeader('Set-Cookie', `ccraft_cid=${cid}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax; Secure`);
  }
  return cid;
}

function parseCookies(str) {
  const out = {};
  str.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

export default async function handler(req, res) {
  setCommonHeaders(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const bodySize = JSON.stringify(req.body || {}).length;
  if (bodySize > 50_000) return res.status(413).json({ error: 'Request too large.' });

  const ip = getClientIP(req);
  const cid = getOrSetClientId(req, res);
  const identity = `${cid}:${ip}`; // combine both signals
  const action = typeof req.body?.action === 'string' ? req.body.action : 'generate';

  // Per-minute burst protection (separate from the daily quota below)
  const burstLimits = {
    generate: { max: 8, windowSec: 60 },
    humanize: { max: 8, windowSec: 60 },
    detect:   { max: 30, windowSec: 60 },
    watch_ad: { max: 20, windowSec: 60 },
  };
  const burstCfg = burstLimits[action] || burstLimits.generate;
  const rl = await checkRateLimit(`burst:${action}:${identity}`, burstCfg.max, burstCfg.windowSec);
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
  if (rl.limited) {
    res.setHeader('Retry-After', String(burstCfg.windowSec));
    return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
  }

  req.identity = identity;

  if (action === 'detect') return handleDetect(req, res);
  if (action === 'humanize') return handleHumanize(req, res);
  if (action === 'watch_ad') return handleWatchAd(req, res);
  if (action === 'usage') return handleGetUsage(req, res);
  if (action === 'linkedin') return handleLinkedIn(req, res);
  if (action === 'interview') return handleInterview(req, res);
  if (action === 'score') return handleScore(req, res);
  return handleGenerate(req, res);
}

// ── Validation helpers ──────────────────────────────────────────────────
function isNonEmptyString(v, maxLen) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= maxLen;
}

function sanitize(s = '') {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[<>]/g, '')
    .replace(/ignore (previous|all|the above)\s*(instructions?)?/gi, '')
    .replace(/system\s*prompt/gi, '')
    .replace(/you are now/gi, '')
    .trim()
    .slice(0, 1000);
}

// ── Free heuristic AI-detector ──────────────────────────────────────────
// Estimates "AI-likelihood" using sentence-length variance (burstiness),
// repeated sentence openers, and common AI-stock phrases.
// This is a heuristic estimate, NOT a scientifically validated detector.
function scoreText(text) {
  const sentences = (text.match(/[^.!?]+[.!?]+/g) || [text]).map(s => s.trim()).filter(Boolean);
  if (sentences.length < 2) return { aiPercent: 50, humanPercent: 50, sentences: sentences.length };

  const lengths = sentences.map(s => s.split(/\s+/).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  const stdDev = Math.sqrt(variance);
  const burstiness = stdDev / (mean || 1);

  const openers = sentences.map(s => s.split(/\s+/).slice(0, 2).join(' ').toLowerCase());
  const uniqueOpeners = new Set(openers).size;
  const openerRepeatRatio = 1 - (uniqueOpeners / openers.length);

  const aiPhrases = [
    'in today\'s', 'it is important to note', 'furthermore', 'moreover',
    'in conclusion', 'leverage', 'delve into', 'plays a crucial role',
    'in the realm of', 'unlock', 'unleash', 'seamlessly', 'robust solution',
    'cutting-edge', 'game-changer', 'paradigm', 'tapestry', 'testament to',
  ];
  const lower = text.toLowerCase();
  const phraseHits = aiPhrases.reduce((n, p) => n + (lower.includes(p) ? 1 : 0), 0);

  let aiScore = 50;
  aiScore += (0.35 - Math.min(burstiness, 0.6)) * 100;
  aiScore += openerRepeatRatio * 25;
  aiScore += phraseHits * 6;
  aiScore = Math.max(2, Math.min(98, Math.round(aiScore)));

  return { aiPercent: aiScore, humanPercent: 100 - aiScore, sentences: sentences.length };
}

async function handleDetect(req, res) {
  try {
    const { text } = req.body || {};
    if (!isNonEmptyString(text, 6000) || text.trim().length < 30) {
      return res.status(400).json({ error: 'Paste between 30 and 6000 characters to analyze.' });
    }
    return res.status(200).json(scoreText(text));
  } catch (err) {
    console.error('Detect error:', err);
    return res.status(500).json({ error: 'Something went wrong analyzing the text.' });
  }
}

// ── Usage + ad-unlock endpoints ──────────────────────────────────────────
async function handleGetUsage(req, res) {
  const usage = await getDailyUsage(req.identity);
  return res.status(200).json({
    lettersUsed: usage.letters,
    lettersLimit: usage.bonusUnlocked ? BONUS_LETTERS_PER_DAY : BASE_LETTERS_PER_DAY,
    wordsUsed: usage.words,
    wordsLimit: usage.bonusUnlocked ? BONUS_WORDS_PER_DAY : BASE_WORDS_PER_DAY,
    bonusUnlocked: usage.bonusUnlocked,
    adsWatched: usage.adsWatched,
    adsRequired: ADS_REQUIRED_FOR_BONUS,
  });
}

async function handleWatchAd(req, res) {
  try {
    const result = await grantBonus(req.identity, ADS_REQUIRED_FOR_BONUS);
    return res.status(200).json(result);
  } catch (err) {
    console.error('watch_ad error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
}

async function handleHumanize(req, res) {
  try {
    const { text } = req.body || {};
    if (!isNonEmptyString(text, 30000) || text.trim().length < 20) {
      return res.status(400).json({ error: 'Paste at least 20 characters of text.' });
    }

    const usage = await getDailyUsage(req.identity);
    const wordsLimit = usage.bonusUnlocked ? BONUS_WORDS_PER_DAY : BASE_WORDS_PER_DAY;
    const wordCount = text.trim().split(/\s+/).length;

    if (usage.words + wordCount > wordsLimit) {
      return res.status(429).json({
        error: usage.bonusUnlocked
          ? `Daily humanizer limit of ${wordsLimit} words reached. Come back tomorrow.`
          : `Daily humanizer limit of ${wordsLimit} words reached. Watch ${ADS_REQUIRED_FOR_BONUS} short ads to unlock ${BONUS_WORDS_PER_DAY} words/day.`,
        limitHit: true,
        canUnlock: !usage.bonusUnlocked,
      });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Service temporarily unavailable.' });

    const prompt = `You are an expert editor rewriting AI-generated text to sound fully human. Apply ALL rules below:

1. Mix sentence lengths aggressively — some very short (3-5 words), some longer
2. Start some sentences with: And, But, So, Look, Honestly, Here's the thing
3. Use contractions everywhere: don't, it's, you'll, that's, I've, we're, they're
4. DELETE these words entirely: furthermore, moreover, in conclusion, leverage, delve, seamlessly, robust, cutting-edge, game-changer, paradigm, tapestry, testament, "it is important to note", "in today's", "in the realm of", "plays a crucial role", unleash, unlock
5. Swap formal for casual: utilize→use, facilitate→help, implement→set up, demonstrate→show, endeavor→try
6. Occasionally use em-dashes — like this — and ellipses... for natural rhythm
7. Vary paragraph length — some single-sentence paragraphs are fine
8. Keep every fact, number, name, and meaning exactly intact
9. Output ONLY the rewritten text, no explanation or preamble

Text:
"""
${text.slice(0, 6000)}
"""`;

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        temperature: 1.1,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      console.error('Groq API error:', response.status);
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }

    const data = await response.json();
    const out = data?.choices?.[0]?.message?.content;
    if (!out) return res.status(502).json({ error: 'Empty response. Please try again.' });

    await incrDailyUsage(req.identity, { words: wordCount });

    return res.status(200).json({ humanized: out.trim(), ...scoreText(out) });

  } catch (err) {
    console.error('Humanize error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

async function handleGenerate(req, res) {
  try {
    const usage = await getDailyUsage(req.identity);
    const lettersLimit = usage.bonusUnlocked ? BONUS_LETTERS_PER_DAY : BASE_LETTERS_PER_DAY;

    if (usage.letters >= lettersLimit) {
      return res.status(429).json({
        error: usage.bonusUnlocked
          ? `Daily limit of ${lettersLimit} cover letters reached. Come back tomorrow.`
          : `Daily limit of ${lettersLimit} cover letters reached. Watch ${ADS_REQUIRED_FOR_BONUS} short ads to unlock ${BONUS_LETTERS_PER_DAY}/day.`,
        limitHit: true,
        canUnlock: !usage.bonusUnlocked,
      });
    }

    const body = req.body || {};
    const fields = {
      job: body.job, company: body.company, name: body.name,
      experience: body.experience, whyJob: body.whyJob,
    };

    const limits = { job: 100, company: 100, name: 80, experience: 800, whyJob: 500 };
    for (const [key, max] of Object.entries(limits)) {
      if (!isNonEmptyString(fields[key], max)) {
        return res.status(400).json({ error: `Invalid or missing field: ${key}.` });
      }
    }

    const allowedTones = ['Professional', 'Confident', 'Friendly', 'Enthusiastic', 'Concise'];
    const tone = allowedTones.includes(body.tone) ? body.tone : 'Professional';
    const jd = typeof body.jd === 'string' ? body.jd.slice(0, 1000) : '';

    const job = sanitize(fields.job);
    const company = sanitize(fields.company);
    const name = sanitize(fields.name);
    const experience = sanitize(fields.experience);
    const whyJob = sanitize(fields.whyJob);
    const jdClean = sanitize(jd);

    const jdPart = jdClean ? `\nJob description / key requirements:\n${jdClean}` : '';

    const prompt = `Write a ${tone.toLowerCase()} cover letter for a job application.

Applicant: ${name}
Applying for: ${job} at ${company}${jdPart}
Experience and skills: ${experience}
Why they want this role: ${whyJob}

Rules:
- Write a complete, ready-to-send cover letter
- Tone: ${tone.toLowerCase()}
- Do NOT open with clichés like "I am writing to express my interest"
- Mention the company and job title naturally in the text
- 3 to 4 paragraphs, flowing prose, no bullet points
- End with a confident call to action
- Do NOT use [brackets] or placeholder text
- Start with "Dear Hiring Manager," and close with the applicant's name
- Output only the letter — no preamble, no explanation`;

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Service temporarily unavailable.' });

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1000,
        temperature: 0.8,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      console.error('Groq API error:', response.status);
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return res.status(502).json({ error: 'Empty response from AI. Please try again.' });

    await incrDailyUsage(req.identity, { letters: 1 });

    return res.status(200).json({ letter: text });

  } catch (err) {
    console.error('Generate error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// ── LinkedIn Summary Generator ──────────────────────────────────────────
async function handleLinkedIn(req, res) {
  try {
    const { name, title, experience, goal, tone = 'Professional' } = req.body || {};
    if (!isNonEmptyString(name, 80) || !isNonEmptyString(title, 100) || !isNonEmptyString(experience, 800)) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    const allowedTones = ['Professional', 'Friendly', 'Bold', 'Storytelling'];
    const safeTone = allowedTones.includes(tone) ? tone : 'Professional';
    const prompt = `Write a compelling LinkedIn About/Summary section for the following person.

Name: ${sanitize(name)}
Job title: ${sanitize(title)}
Experience and skills: ${sanitize(experience)}
What they're looking for: ${sanitize(goal || '')}
Tone: ${safeTone}

Rules:
- 150-250 words, first person, no bullet points
- Tone must be ${safeTone.toLowerCase()}
- Start with a hook — NOT "I am a [job title]"
- Mention 2-3 specific achievements or skills naturally
- End with a clear call to action (connect, message, etc.)
- Do NOT use clichés like "passionate", "dynamic", "guru", "ninja", "rockstar"
- Output only the summary text, nothing else`;

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Service temporarily unavailable.' });
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 500, temperature: 0.8, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) return res.status(502).json({ error: 'AI service error. Please try again.' });
    const data = await response.json();
    const summary = data?.choices?.[0]?.message?.content;
    if (!summary) return res.status(502).json({ error: 'Empty response. Please try again.' });
    return res.status(200).json({ summary: summary.trim() });
  } catch (err) {
    console.error('LinkedIn error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// ── Interview Questions Generator ───────────────────────────────────────
async function handleInterview(req, res) {
  try {
    const { job, company, jd, experience, count = 8 } = req.body || {};
    if (!isNonEmptyString(job, 100) || !isNonEmptyString(company, 100)) {
      return res.status(400).json({ error: 'Job title and company are required.' });
    }
    const safeCount = Math.min(10, Math.max(3, parseInt(count, 10) || 8));
    const jdPart = jd ? `\nJob requirements: ${sanitize(jd)}` : '';
    const expPart = experience ? `\nCandidate background: ${sanitize(experience)}` : '';
    const prompt = `Generate ${safeCount} interview questions with model answers for the following role.

Job: ${sanitize(job)} at ${sanitize(company)}${jdPart}${expPart}

Format each as:
[number]. [Question]
Answer: [2-3 sentence model answer using STAR method where relevant]

Include a mix of: behavioral, situational, role-specific technical, and motivational questions.
Output only the numbered questions and answers, nothing else.`;

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Service temporarily unavailable.' });
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1500, temperature: 0.7, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) return res.status(502).json({ error: 'AI service error. Please try again.' });
    const data = await response.json();
    const questions = data?.choices?.[0]?.message?.content;
    if (!questions) return res.status(502).json({ error: 'Empty response. Please try again.' });
    return res.status(200).json({ questions: questions.trim() });
  } catch (err) {
    console.error('Interview error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// ── Cover Letter Scorer ─────────────────────────────────────────────────
async function handleScore(req, res) {
  try {
    const { letter, jd } = req.body || {};
    if (!isNonEmptyString(letter, 6000) || letter.trim().length < 100) {
      return res.status(400).json({ error: 'Paste your cover letter (at least 100 characters).' });
    }
    const jdPart = jd ? `\nJob description: ${sanitize(jd)}` : '';
    const prompt = `Score the following cover letter out of 100 and provide structured feedback.${jdPart}

Cover letter:
"""
${sanitize(letter)}
"""

Respond ONLY with valid JSON in this exact format (no markdown, no extra text):
{
  "score": 72,
  "categories": [
    {"name": "Opening & Hook", "feedback": "..."},
    {"name": "Relevance to Role", "feedback": "..."},
    {"name": "Specific Achievements", "feedback": "..."},
    {"name": "Tone & Professionalism", "feedback": "..."},
    {"name": "Call to Action & Closing", "feedback": "..."}
  ],
  "overall": "One sentence overall recommendation."
}`;

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Service temporarily unavailable.' });
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 800, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) return res.status(502).json({ error: 'AI service error. Please try again.' });
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (!raw) return res.status(502).json({ error: 'Empty response. Please try again.' });
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      return res.status(200).json(parsed);
    } catch {
      // Fallback if JSON parsing fails — extract score with regex
      const scoreMatch = raw.match(/"score"\s*:\s*(\d+)/);
      return res.status(200).json({
        score: scoreMatch ? parseInt(scoreMatch[1], 10) : 60,
        categories: [],
        overall: raw.slice(0, 300),
      });
    }
  } catch (err) {
    console.error('Score error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
