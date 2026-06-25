import { checkRateLimit, getClientIP } from '../lib/ratelimit.js';
import { getDailyUsage, incrDailyUsage, grantBonus } from '../lib/usage.js';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const BASE_LETTERS_PER_DAY   = 5;
const BASE_WORDS_PER_DAY     = 2000;
const BONUS_LETTERS_PER_DAY  = 10;
const BONUS_WORDS_PER_DAY    = 4000;
const ADS_REQUIRED_FOR_BONUS = 5;

function setCommonHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

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
  const identity = `${cid}:${ip}`;
  const action = typeof req.body?.action === 'string' ? req.body.action : 'generate';

  const burstLimits = {
    generate:  { max: 8,  windowSec: 60 },
    humanize:  { max: 8,  windowSec: 60 },
    detect:    { max: 30, windowSec: 60 },
    watch_ad:  { max: 20, windowSec: 60 },
    linkedin:  { max: 8,  windowSec: 60 },
    interview: { max: 8,  windowSec: 60 },
    score:     { max: 8,  windowSec: 60 },
  };
  const burstCfg = burstLimits[action] || burstLimits.generate;
  const rl = await checkRateLimit(`burst:${action}:${identity}`, burstCfg.max, burstCfg.windowSec);
  res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
  if (rl.limited) {
    res.setHeader('Retry-After', String(burstCfg.windowSec));
    return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
  }

  req.identity = identity;

  if (action === 'detect')    return handleDetect(req, res);
  if (action === 'humanize')  return handleHumanize(req, res);
  if (action === 'watch_ad')  return handleWatchAd(req, res);
  if (action === 'usage')     return handleGetUsage(req, res);
  if (action === 'linkedin')  return handleLinkedIn(req, res);
  if (action === 'interview') return handleInterview(req, res);
  if (action === 'score')     return handleScore(req, res);
  return handleGenerate(req, res);
}

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
    .trim().slice(0, 1000);
}

// ── Improved AI detector ─────────────────────────────────────────────────
function scoreText(text) {
  const sentences = (text.match(/[^.!?]+[.!?]+/g) || [text]).map(s => s.trim()).filter(Boolean);
  if (sentences.length < 2) return { aiPercent: 50, humanPercent: 50 };

  const lower = text.toLowerCase();
  const words = text.split(/\s+/);

  // 1. Burstiness
  const lengths = sentences.map(s => s.split(/\s+/).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  const burstiness = Math.sqrt(variance) / (mean || 1);

  // 2. Opener repetition
  const openers = sentences.map(s => s.split(/\s+/)[0].toLowerCase());
  const uniqueOpeners = new Set(openers).size;
  const openerRepeatRatio = 1 - (uniqueOpeners / openers.length);

  // 3. AI phrases — strong signal
  const aiPhrases = [
    "in today's","it is important to note","furthermore","moreover",
    "in conclusion","leverage","delve into","plays a crucial role",
    "in the realm of","seamlessly","robust","cutting-edge","game-changer",
    "paradigm","tapestry","testament to","it's worth noting","navigating",
    "landscape","foster","underscore","pivotal","holistic","utilize",
    "facilitate","demonstrate","endeavor","commence","subsequently",
    "in summary","to summarize","as mentioned","it should be noted",
    "it is worth","one must","we must","this allows","this ensures",
    "this enables","in order to","due to the fact","as a result of",
    "i am writing to","i am excited to","i believe that my","my name is",
    "i am confident that","i would like to","please find attached",
    "thank you for your consideration","i look forward to hearing from you",
  ];
  const phraseHits = aiPhrases.reduce((n, p) => n + (lower.includes(p) ? 1 : 0), 0);

  // 4. Human signals
  const humanSignals = [
    "don't","can't","won't","i've","i'm","i'll","you're",
    "it's","that's","they're","we're","isn't","wasn't","couldn't",
    "honestly","look,","but here","so i","and i","basically",
    "actually","kind of","sort of","the thing is","here's",
    "to be honest","truth is","what i love","what drives me",
  ];
  const humanHits = humanSignals.reduce((n, p) => n + (lower.includes(p) ? 1 : 0), 0);

  // 5. Passive voice
  const passivePatterns = /\b(is|are|was|were|be|been|being)\s+\w+ed\b/gi;
  const passiveCount = (text.match(passivePatterns) || []).length;
  const passiveRatio = passiveCount / sentences.length;

  // 6. Word length
  const avgWordLen = words.reduce((a, b) => a + b.length, 0) / words.length;

  // 7. Transition word density — AI loves transitions
  const transitions = ['however','therefore','additionally','consequently','nevertheless','nonetheless','accordingly'];
  const transitionHits = transitions.reduce((n, p) => n + (lower.includes(p) ? 1 : 0), 0);

  let aiScore = 42;
  if (burstiness < 0.25) aiScore += 20;
  else if (burstiness < 0.4) aiScore += 10;
  else if (burstiness > 0.65) aiScore -= 18;
  else if (burstiness > 0.5) aiScore -= 9;

  aiScore += openerRepeatRatio * 18;
  aiScore += Math.min(phraseHits * 7, 30);
  aiScore -= Math.min(humanHits * 6, 28);
  aiScore += Math.min(passiveRatio * 14, 12);
  aiScore += Math.min(transitionHits * 4, 16);
  if (avgWordLen > 5.5) aiScore += 8;
  else if (avgWordLen < 4.0) aiScore -= 10;

  aiScore = Math.max(3, Math.min(95, Math.round(aiScore)));
  return { aiPercent: aiScore, humanPercent: 100 - aiScore };
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

async function callGroq(prompt, options = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Service temporarily unavailable.');
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: options.max_tokens || 1000,
      temperature: options.temperature ?? 0.8,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!response.ok) throw new Error(`Groq API error: ${response.status}`);
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from AI.');
  return text.trim();
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
          : `Daily limit reached. Watch ${ADS_REQUIRED_FOR_BONUS} ads to unlock ${BONUS_WORDS_PER_DAY} words/day.`,
        limitHit: true, canUnlock: !usage.bonusUnlocked,
      });
    }

    const prompt = `You are a professional human editor rewriting AI-generated text to sound authentically human-written. Apply ALL of these rules precisely:

RULES:
1. Vary sentence length dramatically — mix very short sentences (3-5 words) with medium and longer ones. Never have 3+ sentences of similar length in a row.
2. Start some sentences with conjunctions: And, But, So, Because, Yet
3. Use contractions everywhere: don't, it's, you'll, that's, I've, we're, they're, couldn't, wouldn't
4. DELETE these words entirely (replace with simpler alternatives): furthermore, moreover, in conclusion, leverage, delve, seamlessly, robust, cutting-edge, game-changer, paradigm, tapestry, testament, utilize, facilitate, implement, endeavor, commence, subsequently, holistic, pivotal, underscore, foster
5. Replace formal words with conversational ones: utilize→use, facilitate→help, demonstrate→show, endeavor→try, commence→start, subsequently→then, nevertheless→still, furthermore→also
6. Occasionally use em-dashes — like this — for natural rhythm, and ellipses... for trailing thoughts
7. Add one or two rhetorical questions where natural
8. Vary paragraph length — single-sentence paragraphs are fine and human
9. Keep ALL facts, numbers, names, achievements, and meaning EXACTLY intact
10. Remove any generic corporate buzzwords
11. Output ONLY the rewritten text — no intro, no explanation, no preamble

Text to rewrite:
"""
${text.slice(0, 6000)}
"""`;

    const humanized = await callGroq(prompt, { max_tokens: 2000, temperature: 1.05 });
    await incrDailyUsage(req.identity, { words: wordCount });
    return res.status(200).json({ humanized, ...scoreText(humanized) });
  } catch (err) {
    console.error('Humanize error:', err);
    return res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
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
          : `Daily limit of ${lettersLimit} cover letters reached. Watch ${ADS_REQUIRED_FOR_BONUS} ads to unlock ${BONUS_LETTERS_PER_DAY}/day.`,
        limitHit: true, canUnlock: !usage.bonusUnlocked,
      });
    }

    const body = req.body || {};
    const fields = { job: body.job, company: body.company, name: body.name, experience: body.experience, whyJob: body.whyJob };
    const limits = { job: 100, company: 100, name: 80, experience: 800, whyJob: 500 };
    for (const [key, max] of Object.entries(limits)) {
      if (!isNonEmptyString(fields[key], max)) {
        return res.status(400).json({ error: `Invalid or missing field: ${key}.` });
      }
    }

    const allowedTones = ['Professional', 'Confident', 'Friendly', 'Enthusiastic', 'Concise'];
    const tone = allowedTones.includes(body.tone) ? body.tone : 'Professional';
    const jd = typeof body.jd === 'string' ? body.jd.slice(0, 1000) : '';
    const templateExtra = typeof body.templateExtra === 'string' ? body.templateExtra.slice(0, 300) : '';

    const job = sanitize(fields.job);
    const company = sanitize(fields.company);
    const name = sanitize(fields.name);
    const experience = sanitize(fields.experience);
    const whyJob = sanitize(fields.whyJob);
    const jdClean = sanitize(jd);
    const jdPart = jdClean ? `\nJob description / key requirements:\n${jdClean}` : '';

    const toneGuide = {
      Professional: 'formal, confident, polished — structured and business-appropriate',
      Confident:    'assertive, direct, achievement-focused — shows clear self-belief without arrogance',
      Friendly:     'warm, conversational, approachable — feels like a person, not a corporate robot',
      Enthusiastic: 'energetic, positive, genuinely excited — shows passion for the role and company',
      Concise:      'brief, punchy, every word earns its place — no filler, maximum impact per sentence',
    };

    const prompt = `Write a high-quality, ready-to-send cover letter for a real job application.

${templateExtra}

Applicant: ${name}
Role: ${job} at ${company}${jdPart}
Experience & skills: ${experience}
Why this role: ${whyJob}
Tone: ${tone} — ${toneGuide[tone] || 'professional'}

REQUIREMENTS (follow every single one):
- Open with a compelling hook — NOT "I am writing to express my interest" or "My name is"
- First paragraph: grab attention with a specific achievement or bold statement about why this company
- Second paragraph: match 2-3 of their requirements directly to your specific experience (if JD provided, use it)
- Third paragraph: show genuine enthusiasm for THIS company specifically — mention what you know about them or why this role matters
- Closing paragraph: confident call to action, not begging
- Start with "Dear Hiring Manager," — end with applicant's name
- NO bullet points — flowing, natural prose only
- NO brackets, NO placeholder text — write the full letter as if ready to send
- NO clichés: "team player", "hard worker", "passionate about", "I am excited to apply"
- 3-4 paragraphs, 250-350 words total
- Output ONLY the letter — no explanation, no preamble, no title`;

    const letter = await callGroq(prompt, { max_tokens: 1000, temperature: 0.85 });
    await incrDailyUsage(req.identity, { letters: 1 });
    return res.status(200).json({ letter });
  } catch (err) {
    console.error('Generate error:', err);
    return res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
  }
}

async function handleLinkedIn(req, res) {
  try {
    const { name, title, experience, goal, tone = 'Professional' } = req.body || {};
    if (!isNonEmptyString(name, 80) || !isNonEmptyString(title, 100) || !isNonEmptyString(experience, 800)) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    const allowedTones = ['Professional', 'Friendly', 'Bold', 'Storytelling'];
    const safeTone = allowedTones.includes(tone) ? tone : 'Professional';

    const prompt = `Write a compelling LinkedIn About section for:

Name: ${sanitize(name)}
Title: ${sanitize(title)}
Experience & skills: ${sanitize(experience)}
Career goal: ${sanitize(goal || '')}
Tone: ${safeTone}

REQUIREMENTS:
- 180-260 words, first person, no bullet points
- Open with a compelling hook — NOT "I am a [title]" or "My name is"
- Mention 2-3 specific, concrete achievements with numbers where possible
- Show personality — recruiters read hundreds, make this memorable
- End with a clear call to action (connect, message, collaborate)
- NO clichés: passionate, dynamic, guru, ninja, rockstar, thought leader, synergy
- Tone must feel ${safeTone.toLowerCase()} throughout
- Output ONLY the summary text, nothing else`;

    const summary = await callGroq(prompt, { max_tokens: 600, temperature: 0.85 });
    return res.status(200).json({ summary });
  } catch (err) {
    console.error('LinkedIn error:', err);
    return res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
  }
}

async function handleInterview(req, res) {
  try {
    const { job, company, jd, experience, count = 8 } = req.body || {};
    if (!isNonEmptyString(job, 100) || !isNonEmptyString(company, 100)) {
      return res.status(400).json({ error: 'Job title and company are required.' });
    }
    const safeCount = Math.min(10, Math.max(3, parseInt(count, 10) || 8));
    const jdPart = jd ? `\nJob requirements: ${sanitize(jd)}` : '';
    const expPart = experience ? `\nCandidate background: ${sanitize(experience)}` : '';

    const prompt = `Generate ${safeCount} interview questions with strong model answers for:

Job: ${sanitize(job)} at ${sanitize(company)}${jdPart}${expPart}

FORMAT each exactly as:
[number]. [Question]
Answer: [2-3 sentence model answer — use STAR method for behavioral questions]

Include a mix of:
- 2-3 behavioral questions ("Tell me about a time...")
- 2-3 role-specific technical or situational questions
- 1-2 motivational/culture-fit questions
- 1 "biggest weakness" or growth-oriented question

Make answers specific and impressive, not generic. Use metrics/outcomes where possible.
Output only the numbered questions and answers, nothing else.`;

    const questions = await callGroq(prompt, { max_tokens: 2000, temperature: 0.7 });
    return res.status(200).json({ questions });
  } catch (err) {
    console.error('Interview error:', err);
    return res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
  }
}

async function handleScore(req, res) {
  try {
    const { letter, jd } = req.body || {};
    if (!isNonEmptyString(letter, 6000) || letter.trim().length < 100) {
      return res.status(400).json({ error: 'Paste your cover letter (at least 100 characters).' });
    }
    const jdPart = jd ? `\nJob description: ${sanitize(jd)}` : '';

    const prompt = `You are an expert recruiter. Score this cover letter out of 100 and give actionable feedback.${jdPart}

Cover letter:
"""
${sanitize(letter)}
"""

Respond ONLY with valid JSON in this exact format (no markdown, no extra text):
{
  "score": 72,
  "grade": "B+",
  "categories": [
    {"name": "Opening & Hook", "score": 15, "max": 20, "feedback": "Specific, actionable feedback here."},
    {"name": "Relevance to Role", "score": 18, "max": 20, "feedback": "..."},
    {"name": "Specific Achievements", "score": 14, "max": 20, "feedback": "..."},
    {"name": "Tone & Professionalism", "score": 16, "max": 20, "feedback": "..."},
    {"name": "Call to Action & Closing", "score": 9, "max": 20, "feedback": "..."}
  ],
  "strengths": ["strength 1", "strength 2"],
  "improvements": ["improvement 1", "improvement 2", "improvement 3"],
  "overall": "One sentence overall assessment and top recommendation."
}`;

    const raw = await callGroq(prompt, { max_tokens: 1000, temperature: 0.3 });
    try {
      const clean = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      return res.status(200).json(parsed);
    } catch {
      const scoreMatch = raw.match(/"score"\s*:\s*(\d+)/);
      return res.status(200).json({
        score: scoreMatch ? parseInt(scoreMatch[1], 10) : 60,
        grade: 'C+', categories: [], strengths: [], improvements: [],
        overall: raw.slice(0, 300),
      });
    }
  } catch (err) {
    console.error('Score error:', err);
    return res.status(500).json({ error: err.message || 'Something went wrong. Please try again.' });
  }
}
