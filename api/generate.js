import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Rate limiters per action
const limiters = {
  generate:  new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(8,  "1 m"), prefix: "rl:generate"  }),
  humanize:  new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(8,  "1 m"), prefix: "rl:humanize"  }),
  detect:    new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(30, "1 m"), prefix: "rl:detect"    }),
  watch_ad:  new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(20, "1 m"), prefix: "rl:watch_ad"  }),
  linkedin:  new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(8,  "1 m"), prefix: "rl:linkedin"  }),
  interview: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(8,  "1 m"), prefix: "rl:interview" }),
  score:     new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(8,  "1 m"), prefix: "rl:score"     }),
  email_subject: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(8, "1 m"), prefix: "rl:email_subject" }),
  thank_you: new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(8,  "1 m"), prefix: "rl:thank_you" }),
  cv_score:  new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(8,  "1 m"), prefix: "rl:cv_score"  }),
};

// Daily limits per plan
const DAILY_LIMITS = {
  standard: {
    letters:        5,
    linkedin:       3,
    interview:      3,
    score:          5,
    email_subject:  5,
    thank_you:      3,
    cv_score:       3,
    humanizer_words: 2000,
  },
  unlocked: {
    letters:        10,
    linkedin:       8,
    interview:      8,
    score:          10,
    email_subject:  10,
    thank_you:      8,
    cv_score:       8,
    humanizer_words: 4000,
  },
};

function getIP(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.headers["x-real-ip"] ||
    "unknown"
  );
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

async function getUsage(ip) {
  const day = todayKey();
  const [
    lettersUsed, linkedinUsed, interviewUsed, scoreUsed,
    emailSubjectUsed, thankYouUsed, cvScoreUsed,
    wordsUsed, adsWatched
  ] = await Promise.all([
    redis.get(`usage:${ip}:${day}:letters`)        .then(v => parseInt(v) || 0),
    redis.get(`usage:${ip}:${day}:linkedin`)       .then(v => parseInt(v) || 0),
    redis.get(`usage:${ip}:${day}:interview`)      .then(v => parseInt(v) || 0),
    redis.get(`usage:${ip}:${day}:score`)          .then(v => parseInt(v) || 0),
    redis.get(`usage:${ip}:${day}:email_subject`)  .then(v => parseInt(v) || 0),
    redis.get(`usage:${ip}:${day}:thank_you`)      .then(v => parseInt(v) || 0),
    redis.get(`usage:${ip}:${day}:cv_score`)       .then(v => parseInt(v) || 0),
    redis.get(`usage:${ip}:${day}:words`)          .then(v => parseInt(v) || 0),
    redis.get(`usage:${ip}:ads_watched`)           .then(v => parseInt(v) || 0),
  ]);

  const bonusUnlocked = adsWatched >= 5;
  const plan = bonusUnlocked ? "unlocked" : "standard";
  const limits = DAILY_LIMITS[plan];

  return {
    lettersUsed, linkedinUsed, interviewUsed, scoreUsed,
    emailSubjectUsed, thankYouUsed, cvScoreUsed,
    wordsUsed, adsWatched,
    bonusUnlocked,
    limits,
    lettersLimit:       limits.letters,
    linkedinLimit:      limits.linkedin,
    interviewLimit:     limits.interview,
    scoreLimit:         limits.score,
    emailSubjectLimit:  limits.email_subject,
    thankYouLimit:      limits.thank_you,
    cvScoreLimit:       limits.cv_score,
    wordsLimit:         limits.humanizer_words,
    adsRequired: 5,
  };
}

async function incrementUsage(ip, field, amount = 1) {
  const day = todayKey();
  const key = `usage:${ip}:${day}:${field}`;
  await redis.incr(key);
  await redis.expireat(key, Math.floor(new Date(day + "T23:59:59Z").getTime() / 1000));
}

async function callGroq(messages, maxTokens = 1200) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: maxTokens,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq error ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const origin = req.headers.origin;
  const allowed = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const ip = getIP(req);
  const body = req.body || {};
  const action = body.action || "generate";

  try {
    // ── USAGE ────────────────────────────────────────────────────────────
    if (action === "usage") {
      const usage = await getUsage(ip);
      return res.status(200).json(usage);
    }

    // ── WATCH AD ─────────────────────────────────────────────────────────
    if (action === "watch_ad") {
      const { success } = await limiters.watch_ad.limit(ip);
      if (!success) return res.status(429).json({ error: "Too many requests. Slow down." });

      const adsWatched = await redis.incr(`usage:${ip}:ads_watched`);
      const bonusUnlocked = adsWatched >= 5;
      return res.status(200).json({ adsWatched, bonusUnlocked, adsRequired: 5 });
    }

    // ── DETECT ───────────────────────────────────────────────────────────
    if (action === "detect") {
      const { success } = await limiters.detect.limit(ip);
      if (!success) return res.status(429).json({ error: "Too many requests. Slow down." });

      const text = body.text || "";
      if (!text.trim()) return res.status(400).json({ error: "No text provided." });

      const result = await callGroq([{
        role: "user",
        content: `Analyze this text and estimate what percentage was written by AI vs a human.
Return ONLY JSON like: {"aiPercent": 62, "humanPercent": 38}
No explanation. No markdown. Just JSON.

Text:
${text.slice(0, 3000)}`
      }], 100);

      const parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
      return res.status(200).json(parsed);
    }

    // ── HUMANIZE ─────────────────────────────────────────────────────────
    if (action === "humanize") {
      const { success } = await limiters.humanize.limit(ip);
      if (!success) return res.status(429).json({ error: "Too many requests. Slow down." });

      const usage = await getUsage(ip);
      const wordCount = (body.text || "").split(/\s+/).filter(Boolean).length;

      if (usage.wordsUsed >= usage.wordsLimit) {
        return res.status(429).json({
          error: `Daily humanizer limit reached (${usage.wordsLimit} words). ${usage.bonusUnlocked ? "Resets at midnight UTC." : "Watch 5 ads to unlock 4000 words/day."}`,
          limitReached: true,
        });
      }
      if (usage.wordsUsed + wordCount > usage.wordsLimit) {
        return res.status(429).json({
          error: `This would exceed your daily limit. You have ${usage.wordsLimit - usage.wordsUsed} words remaining.`,
          limitReached: true,
        });
      }

      const humanized = await callGroq([{
        role: "user",
        content: `Rewrite this text to sound naturally human-written. Use varied sentence lengths, contractions, and a conversational but professional tone. Avoid AI patterns like starting every sentence with "I" or overusing transitional phrases.

Text:
${body.text}

Return ONLY the rewritten text. No explanation.`
      }], 1500);

      await incrementUsage(ip, "words", wordCount);

      const detectResult = await callGroq([{
        role: "user",
        content: `Analyze this text and estimate what percentage was written by AI vs a human.
Return ONLY JSON like: {"aiPercent": 22, "humanPercent": 78}
No explanation. No markdown. Just JSON.

Text:
${humanized.slice(0, 3000)}`
      }], 100);

      const { aiPercent, humanPercent } = JSON.parse(detectResult.replace(/```json|```/g, "").trim());
      return res.status(200).json({ humanized, aiPercent, humanPercent });
    }

    // ── GENERATE COVER LETTER ─────────────────────────────────────────────
    if (action === "generate") {
      const { success } = await limiters.generate.limit(ip);
      if (!success) return res.status(429).json({ error: "Too many requests. Slow down." });

      const usage = await getUsage(ip);
      if (usage.lettersUsed >= usage.lettersLimit) {
        return res.status(429).json({
          error: `Daily cover letter limit reached (${usage.lettersLimit}/day). ${usage.bonusUnlocked ? "Resets at midnight UTC." : "Watch 5 ads to unlock 10 letters/day."}`,
          limitReached: true,
        });
      }

      const { job, company, name, jd, experience, whyJob, tone, templateExtra } = body;
      if (!job || !name) return res.status(400).json({ error: "Job title and name are required." });

      const letter = await callGroq([{
        role: "user",
        content: `Write a ${tone || "Professional"} cover letter for ${name} applying for ${job} at ${company || "the company"}.
${jd ? `Job Description:\n${jd}\n` : ""}
${experience ? `Experience:\n${experience}\n` : ""}
${whyJob ? `Why this role:\n${whyJob}\n` : ""}
${templateExtra ? `Style notes:\n${templateExtra}\n` : ""}
Write a complete, ATS-friendly cover letter. Plain text only. No markdown.`
      }], 1200);

      await incrementUsage(ip, "letters");
      return res.status(200).json({ letter });
    }

    // ── LINKEDIN ──────────────────────────────────────────────────────────
    if (action === "linkedin") {
      const { success } = await limiters.linkedin.limit(ip);
      if (!success) return res.status(429).json({ error: "Too many requests. Slow down." });

      const usage = await getUsage(ip);
      if (usage.linkedinUsed >= usage.linkedinLimit) {
        return res.status(429).json({
          error: `Daily LinkedIn limit reached (${usage.linkedinLimit}/day). ${usage.bonusUnlocked ? "Resets at midnight UTC." : "Watch 5 ads to unlock 8/day."}`,
          limitReached: true,
        });
      }

      const { name, title, experience, goal, tone } = body;
      if (!name || !title) return res.status(400).json({ error: "Name and title are required." });

      const summary = await callGroq([{
        role: "user",
        content: `Write a LinkedIn About section for ${name}, a ${title}.
Tone: ${tone || "Professional"}
Experience: ${experience || "Not specified"}
Career goal: ${goal || "Not specified"}
Length: 180–260 words. No hashtags. No emojis. Plain text only.`
      }], 600);

      await incrementUsage(ip, "linkedin");
      return res.status(200).json({ summary });
    }

    // ── INTERVIEW ─────────────────────────────────────────────────────────
    if (action === "interview") {
      const { success } = await limiters.interview.limit(ip);
      if (!success) return res.status(429).json({ error: "Too many requests. Slow down." });

      const usage = await getUsage(ip);
      if (usage.interviewUsed >= usage.interviewLimit) {
        return res.status(429).json({
          error: `Daily interview prep limit reached (${usage.interviewLimit}/day). ${usage.bonusUnlocked ? "Resets at midnight UTC." : "Watch 5 ads to unlock 8/day."}`,
          limitReached: true,
        });
      }

      const { job, company, jd, experience, count } = body;
      if (!job) return res.status(400).json({ error: "Job title is required." });

      const questions = await callGroq([{
        role: "user",
        content: `Generate ${count || 5} interview questions with STAR method answers for a ${job} role${company ? ` at ${company}` : ""}.
${jd ? `Job Description:\n${jd}\n` : ""}
${experience ? `Candidate experience:\n${experience}\n` : ""}
Mix behavioral, technical, and motivational questions.
Format each as:
Q1. [Question]
Answer: [STAR answer]

Plain text only.`
      }], 2000);

      await incrementUsage(ip, "interview");
      return res.status(200).json({ questions });
    }

    // ── SCORE COVER LETTER ────────────────────────────────────────────────
    if (action === "score") {
      const { success } = await limiters.score.limit(ip);
      if (!success) return res.status(429).json({ error: "Too many requests. Slow down." });

      const usage = await getUsage(ip);
      if (usage.scoreUsed >= usage.scoreLimit) {
        return res.status(429).json({
          error: `Daily scoring limit reached (${usage.scoreLimit}/day). ${usage.bonusUnlocked ? "Resets at midnight UTC." : "Watch 5 ads to unlock 10/day."}`,
          limitReached: true,
        });
      }

      const { letter, jd } = body;
      if (!letter) return res.status(400).json({ error: "Cover letter text is required." });

      const result = await callGroq([{
        role: "user",
        content: `Score this cover letter out of 100. ${jd ? "Use the job description for relevance scoring." : ""}
${jd ? `Job Description:\n${jd}\n` : ""}
Cover Letter:
${letter}

Return ONLY JSON:
{
  "score": 74,
  "grade": "B",
  "categories": [
    {"name": "Opening & Hook", "score": 14, "max": 20, "feedback": "..."},
    {"name": "Relevance to Role", "score": 14, "max": 20, "feedback": "..."},
    {"name": "Specific Achievements", "score": 14, "max": 20, "feedback": "..."},
    {"name": "Tone & Professionalism", "score": 16, "max": 20, "feedback": "..."},
    {"name": "Call to Action & Closing", "score": 16, "max": 20, "feedback": "..."}
  ],
  "strengths": ["...", "..."],
  "improvements": ["...", "..."],
  "overall": "..."
}
No markdown. No explanation. Just JSON.`
      }], 1000);

      const parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
      await incrementUsage(ip, "score");
      return res.status(200).json(parsed);
    }

    // ── EMAIL SUBJECT LINE ────────────────────────────────────────────────
    if (action === "email_subject") {
      const { success } = await limiters.email_subject.limit(ip);
      if (!success) return res.status(429).json({ error: "Too many requests. Slow down." });

      const usage = await getUsage(ip);
      if (usage.emailSubjectUsed >= usage.emailSubjectLimit) {
        return res.status(429).json({
          error: `Daily email subject limit reached (${usage.emailSubjectLimit}/day). ${usage.bonusUnlocked ? "Resets at midnight UTC." : "Watch 5 ads to unlock 10/day."}`,
          limitReached: true,
        });
      }

      const { job, company, name, tone } = body;
      if (!job) return res.status(400).json({ error: "Job title is required." });

      const result = await callGroq([{
        role: "user",
        content: `Generate 5 email subject lines for a job application.
Role: ${job}
Company: ${company || "the company"}
Applicant: ${name || "Applicant"}
Tone: ${tone || "Professional"}

Return ONLY JSON array:
["Subject 1", "Subject 2", "Subject 3", "Subject 4", "Subject 5"]
No markdown. No explanation. Just JSON array.`
      }], 300);

      const subjects = JSON.parse(result.replace(/```json|```/g, "").trim());
      await incrementUsage(ip, "email_subject");
      return res.status(200).json({ subjects });
    }

    // ── THANK-YOU EMAIL ───────────────────────────────────────────────────
    if (action === "thank_you") {
      const { success } = await limiters.thank_you.limit(ip);
      if (!success) return res.status(429).json({ error: "Too many requests. Slow down." });

      const usage = await getUsage(ip);
      if (usage.thankYouUsed >= usage.thankYouLimit) {
        return res.status(429).json({
          error: `Daily thank-you email limit reached (${usage.thankYouLimit}/day). ${usage.bonusUnlocked ? "Resets at midnight UTC." : "Watch 5 ads to unlock 8/day."}`,
          limitReached: true,
        });
      }

      const { job, company, interviewerName, keyPoints, tone } = body;
      if (!job) return res.status(400).json({ error: "Job title is required." });

      const email = await callGroq([{
        role: "user",
        content: `Write a professional post-interview thank-you email.
Role: ${job}
Company: ${company || "the company"}
Interviewer: ${interviewerName || "the interviewer"}
Tone: ${tone || "Professional"}
Key discussion points to reference: ${keyPoints || "general discussion about the role"}

Write a complete email with subject line and body. Keep it concise (150-200 words). Plain text only.`
      }], 600);

      await incrementUsage(ip, "thank_you");
      return res.status(200).json({ email });
    }

    // ── ATS CV SCORE ──────────────────────────────────────────────────────
    if (action === "cv_score") {
      const { success } = await limiters.cv_score.limit(ip);
      if (!success) return res.status(429).json({ error: "Too many requests. Slow down." });

      const usage = await getUsage(ip);
      if (usage.cvScoreUsed >= usage.cvScoreLimit) {
        return res.status(429).json({
          error: `Daily CV scoring limit reached (${usage.cvScoreLimit}/day). ${usage.bonusUnlocked ? "Resets at midnight UTC." : "Watch 5 ads to unlock 8/day."}`,
          limitReached: true,
        });
      }

      const { cvText, jd } = body;
      if (!cvText) return res.status(400).json({ error: "CV text is required." });

      const result = await callGroq([{
        role: "user",
        content: `Score this CV/Resume for ATS compatibility and overall quality out of 100.
${jd ? `Job Description (for relevance scoring):\n${jd}\n` : ""}
CV:
${cvText.slice(0, 4000)}

Return ONLY JSON:
{
  "score": 74,
  "grade": "B",
  "atsScore": 68,
  "categories": [
    {"name": "Contact Information", "score": 18, "max": 20, "feedback": "..."},
    {"name": "Work Experience", "score": 16, "max": 25, "feedback": "..."},
    {"name": "Skills & Keywords", "score": 14, "max": 20, "feedback": "..."},
    {"name": "Education", "score": 14, "max": 15, "feedback": "..."},
    {"name": "Formatting & ATS Readability", "score": 12, "max": 20, "feedback": "..."}
  ],
  "strengths": ["...", "..."],
  "improvements": ["...", "..."],
  "missingKeywords": ["...", "..."],
  "overall": "..."
}
No markdown. No explanation. Just JSON.`
      }], 1000);

      const parsed = JSON.parse(result.replace(/```json|```/g, "").trim());
      await incrementUsage(ip, "cv_score");
      return res.status(200).json(parsed);
    }

    return res.status(400).json({ error: "Unknown action." });

  } catch (err) {
    console.error("API error:", err.message);

    // Graceful error messages
    if (err.message.includes("Groq error")) {
      return res.status(503).json({
        error: "AI service is temporarily unavailable. Please try again in a moment.",
        retryAfter: 10,
      });
    }
    if (err.message.includes("JSON")) {
      return res.status(500).json({ error: "Failed to parse AI response. Please try again." });
    }
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
}
