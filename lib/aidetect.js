// lib/aidetect.js
//
// Heuristic AI-text detector.
//
// Instead of asking an LLM "what % of this is AI?" (unreliable — LLMs are
// notoriously bad judges of their own or similar models' output, and this
// is why scores would paradoxically go UP after humanizing), this scores
// real linguistic signals that correlate with LLM-generated text:
//
//   1. Burstiness        — humans vary sentence length a lot; LLMs are flat
//   2. Lexical diversity  — type-token ratio; LLMs often repeat vocabulary
//   3. AI stock phrases   — "moreover", "in today's fast-paced world", etc.
//   4. Transition density — LLMs overuse connector words
//   5. Contraction usage  — humans use "don't"/"I've"; LLMs under-use them
//   6. Sentence-opener repetition — LLMs love starting sentences the same way
//   7. Punctuation patterns — em-dash / semicolon overuse is a strong tell
//   8. Average sentence length — LLMs trend toward uniform, longer sentences
//
// Each signal produces a 0–100 "AI-likelihood" sub-score. We combine them
// with weights tuned by how strong/reliable each signal is, then squash
// through a logistic curve so scores cluster realistically (very human text
// lands 5–25%, heavily-AI text lands 75–95%, genuinely ambiguous text lands
// near 50%) instead of bouncing between 0 and 100.

const AI_STOCK_PHRASES = [
  "in today's fast-paced", "in the ever-evolving", "in conclusion",
  "it is important to note", "it's important to note", "it is worth noting",
  "moreover", "furthermore", "additionally,", "in addition,",
  "on the other hand", "at the end of the day", "when it comes to",
  "plays a crucial role", "plays a vital role", "plays a significant role",
  "in this digital age", "navigate the complexities", "navigate the landscape",
  "unlock the potential", "unleash the potential", "unlock your potential",
  "delve into", "dive into", "deep dive",
  "a testament to", "stands as a testament", "in essence",
  "ultimately,", "in summary,", "to summarize,", "overall,",
  "it goes without saying", "needless to say",
  "robust", "seamless", "seamlessly", "leverage", "leveraging",
  "synergy", "synergize", "holistic", "paradigm shift",
  "game-changer", "game changer", "cutting-edge", "state-of-the-art",
  "tapestry of", "rich tapestry", "a journey", "embark on",
  "foster a culture", "cultivate a culture", "drive impact",
  "passionate about", "thrilled to", "excited to share",
  "i am writing to express", "i am excited to apply",
  "look no further", "in the world of", "the importance of",
  "myriad of", "a myriad of", "plethora of", "a plethora of",
  "elevate your", "transform your", "revolutionize the way",
  "not only... but also", "not only does", "whether you're",
  "from x to y", "the key to success", "in order to",
];

const TRANSITION_WORDS = [
  "however", "moreover", "furthermore", "additionally", "consequently",
  "therefore", "thus", "hence", "nevertheless", "nonetheless",
  "subsequently", "accordingly", "meanwhile", "alternatively",
  "in addition", "as a result", "for instance", "for example",
  "in contrast", "on the other hand", "in summary", "in conclusion",
];

const CONTRACTIONS = [
  "don't", "didn't", "doesn't", "isn't", "wasn't", "weren't", "aren't",
  "i've", "i'm", "i'll", "i'd", "we've", "we're", "we'll", "we'd",
  "you've", "you're", "you'll", "you'd", "it's", "that's", "there's",
  "can't", "couldn't", "wouldn't", "shouldn't", "won't", "haven't",
  "hasn't", "hadn't", "let's", "who's", "what's",
];

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function splitWords(text) {
  return (text.toLowerCase().match(/[a-z']+/g) || []);
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Logistic squash so the combined raw score (roughly -3..+3) maps to a
// believable 0-100 percentage instead of linear extremes.
function squash(x, midpoint = 0, steepness = 1.1) {
  const v = 1 / (1 + Math.exp(-steepness * (x - midpoint)));
  return Math.round(v * 100);
}

export function detectAIScore(rawText) {
  const text = (rawText || "").trim();
  if (!text || text.length < 40) {
    // Too short to analyze meaningfully — return a neutral-ish low-confidence score
    return { aiPercent: 50, humanPercent: 50, confidence: "low", signals: {} };
  }

  const sentences = splitSentences(text);
  const words = splitWords(text);
  const wordCount = words.length;
  const lower = text.toLowerCase();

  // ── 1. Burstiness (sentence length variation) ──────────────────────────
  const sentenceLengths = sentences.map(s => splitWords(s).length).filter(n => n > 0);
  const avgLen = mean(sentenceLengths);
  const lenStd = stddev(sentenceLengths);
  // Coefficient of variation: humans typically >0.5, LLMs often <0.35
  const burstiness = avgLen > 0 ? lenStd / avgLen : 0;
  const burstinessSignal = squash(0.55 - burstiness, 0, 6); // low burstiness -> high AI score

  // ── 2. Lexical diversity (type-token ratio) ─────────────────────────────
  const uniqueWords = new Set(words);
  const ttr = wordCount > 0 ? uniqueWords.size / wordCount : 1;
  // Normalize for length (TTR naturally drops with length) using a simple
  // moving-average-type-token-ratio approximation over 50-word windows.
  let mattrSum = 0, mattrCount = 0;
  const windowSize = 50;
  if (wordCount >= windowSize) {
    for (let i = 0; i <= wordCount - windowSize; i += 10) {
      const window = words.slice(i, i + windowSize);
      mattrSum += new Set(window).size / windowSize;
      mattrCount++;
    }
  }
  const mattr = mattrCount > 0 ? mattrSum / mattrCount : ttr;
  // Humans trend higher MATTR (~0.7+), repetitive AI text trends lower (~0.55-0.65)
  const diversitySignal = squash(0.66 - mattr, 0, 8);

  // ── 3. AI stock phrases ──────────────────────────────────────────────────
  let phraseHits = 0;
  for (const phrase of AI_STOCK_PHRASES) {
    if (lower.includes(phrase)) phraseHits++;
  }
  const phraseDensity = phraseHits / Math.max(1, wordCount / 100); // hits per 100 words
  const phraseSignal = squash(phraseDensity - 0.3, 0, 1.4);

  // ── 4. Transition word density ────────────────────────────────────────
  let transitionHits = 0;
  for (const t of TRANSITION_WORDS) {
    const re = new RegExp(`\\b${t}\\b`, "gi");
    transitionHits += (lower.match(re) || []).length;
  }
  const transitionDensity = transitionHits / Math.max(1, sentences.length);
  const transitionSignal = squash(transitionDensity - 0.12, 0, 5);

  // ── 5. Contraction usage (inverse signal — fewer contractions = more AI) ─
  let contractionHits = 0;
  for (const c of CONTRACTIONS) {
    const re = new RegExp(`\\b${c.replace("'", "'")}\\b`, "gi");
    contractionHits += (lower.match(re) || []).length;
  }
  const contractionDensity = contractionHits / Math.max(1, sentences.length);
  const contractionSignal = squash(0.08 - contractionDensity, 0, 8);

  // ── 6. Repeated sentence openers ─────────────────────────────────────────
  const openers = sentences.map(s => {
    const w = splitWords(s);
    return w.slice(0, 2).join(" ");
  }).filter(Boolean);
  const openerCounts = {};
  for (const o of openers) openerCounts[o] = (openerCounts[o] || 0) + 1;
  const maxOpenerRepeat = Math.max(0, ...Object.values(openerCounts));
  const openerRepeatRatio = sentences.length > 0 ? maxOpenerRepeat / sentences.length : 0;
  const openerSignal = squash(openerRepeatRatio - 0.15, 0, 6);

  // ── 7. Punctuation tells (em-dash / semicolon overuse) ──────────────────
  const emDashCount = (text.match(/—|--/g) || []).length;
  const semicolonCount = (text.match(/;/g) || []).length;
  const punctDensity = (emDashCount + semicolonCount) / Math.max(1, sentences.length);
  const punctSignal = squash(punctDensity - 0.18, 0, 5);

  // ── 8. Average sentence length (very long uniform sentences trend AI) ───
  const lengthSignal = squash((avgLen - 19) / 6, 0, 1.2);

  // ── Combine with weights ─────────────────────────────────────────────────
  const weights = {
    burstiness:   0.26,
    diversity:    0.16,
    phrase:       0.22,
    transition:   0.12,
    contraction:  0.10,
    opener:       0.08,
    punct:        0.04,
    length:       0.02,
  };

  const weightedSum =
    burstinessSignal   * weights.burstiness +
    diversitySignal    * weights.diversity +
    phraseSignal       * weights.phrase +
    transitionSignal   * weights.transition +
    contractionSignal  * weights.contraction +
    openerSignal       * weights.opener +
    punctSignal        * weights.punct +
    lengthSignal       * weights.length;

  let aiPercent = Math.round(weightedSum);
  aiPercent = Math.max(2, Math.min(98, aiPercent)); // never claim total certainty

  const confidence = wordCount < 80 ? "low" : wordCount < 200 ? "medium" : "high";

  return {
    aiPercent,
    humanPercent: 100 - aiPercent,
    confidence,
    signals: {
      burstiness: Math.round(burstinessSignal),
      lexicalDiversity: Math.round(diversitySignal),
      stockPhrases: Math.round(phraseSignal),
      transitionDensity: Math.round(transitionSignal),
      contractionUsage: Math.round(contractionSignal),
      sentenceOpenerRepetition: Math.round(openerSignal),
      punctuationPatterns: Math.round(punctSignal),
      sentenceLength: Math.round(lengthSignal),
    },
  };
}
