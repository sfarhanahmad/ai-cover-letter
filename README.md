# CoverCraft AI

A free AI-powered career tools suite built on Vercel + Groq + Upstash Redis.

## Live Tools

| Tool | URL | Description |
|---|---|---|
| Cover Letter Generator | `/` | AI cover letters in 30 seconds |
| LinkedIn Summary | `/linkedin.html` | Compelling LinkedIn About sections |
| Interview Prep | `/interview.html` | Tailored questions + model answers |
| Cover Letter Scorer | `/score.html` | Score out of 100 + feedback |
| AI Detector | Built into main page | Heuristic AI-content analysis |
| Humanizer | Built into main page | Rewrites text to sound more natural |

## Project Structure

```
covercraft/
├── api/
│   └── generate.js          # Single serverless endpoint — handles all actions
├── lib/
│   ├── ratelimit.js         # Upstash Redis burst rate limiter (per IP+cookie)
│   └── usage.js             # Daily usage tracking + ad-unlock logic (Redis)
├── public/
│   ├── index.html           # Main cover letter generator
│   ├── linkedin.html        # LinkedIn summary generator
│   ├── interview.html       # Interview questions generator
│   ├── score.html           # Cover letter scorer
│   ├── privacy.html         # Privacy policy
│   ├── terms.html           # Terms of service
│   ├── robots.txt           # SEO: allow all crawlers
│   └── sitemap.xml          # SEO: sitemap for Google indexing
├── sw.js                    # Monetag service worker (served from root)
└── vercel.json              # Routing, security headers, build config
```

## API Actions

All actions hit `POST /api/generate` with `credentials: 'same-origin'`.

| Action | Required fields | Returns |
|---|---|---|
| `generate` | job, company, name, experience, whyJob, tone | `{ letter }` |
| `linkedin` | name, title, experience, goal, tone | `{ summary }` |
| `interview` | job, company, jd?, experience?, count? | `{ questions }` |
| `score` | letter, jd? | `{ score, categories[], overall }` |
| `humanize` | text | `{ humanized, aiPercent, humanPercent }` |
| `detect` | text | `{ aiPercent, humanPercent, sentences }` |
| `watch_ad` | — | `{ adsWatched, adsRequired, bonusUnlocked }` |
| `usage` | — | `{ lettersUsed, lettersLimit, wordsUsed, wordsLimit, bonusUnlocked, adsWatched }` |

## Free Plan Limits

Tracked server-side via Upstash Redis (cookie + IP identity, resets at UTC midnight).

| Metric | Free | After watching 5 ads |
|---|---|---|
| Cover letters/day | 5 | 10 |
| Humanizer words/day | 2000 | 4000 |
| AI detector checks | Unlimited | Unlimited |

> **Honest note:** Limits are meaningfully harder to bypass than localStorage (server-tracked, httpOnly cookie + IP combo), but not bypass-proof. Clearing cookies + switching networks creates a fresh identity. This is the realistic ceiling without requiring user accounts.

## Environment Variables

Set these in Vercel → Settings → Environment Variables.

| Variable | Where to get it | Required |
|---|---|---|
| `GROQ_API_KEY` | console.groq.com → API Keys | ✅ Yes |
| `UPSTASH_REDIS_REST_URL` | upstash.com → your DB → REST API | ✅ Yes |
| `UPSTASH_REDIS_REST_TOKEN` | upstash.com → your DB → REST API | ✅ Yes |
| `ALLOWED_ORIGIN` | Your Vercel domain e.g. `https://aicover-letter.vercel.app` | Optional |

> ⚠️ Never paste these values into chat, code files, or GitHub. Vercel's environment variable panel is the only place they should live.

## Security

| Layer | Implementation |
|---|---|
| API key exposure | Keys in Vercel env only — never in frontend code |
| XSS | All AI output rendered via `textContent`, never `innerHTML` |
| Prompt injection | Input sanitized before reaching the AI prompt |
| Rate limiting | Per-action burst limits via Upstash Redis |
| Daily quota | Server-tracked per identity (cookie+IP), not client-side |
| Security headers | CSP, HSTS, X-Frame-Options, X-Content-Type-Options via vercel.json |
| Input validation | Type + length checked server-side on every field |
| Error handling | Internal errors logged server-side only, generic messages to client |

## Monetization

- **Monetag MultiTag** — ad network integration via `sw.js` service worker at root
- **Ad-unlock flow** — users watch 5 ads to double their daily limits (server-verified count)
- **AdSense** — eligible to apply once site has consistent traffic and original content

## Tech Stack

| Layer | Technology | Cost |
|---|---|---|
| Hosting | Vercel | Free |
| AI inference | Groq (Llama 3.3 70B) | Free tier |
| Rate limiting + usage | Upstash Redis | Free tier |
| Ads | Monetag MultiTag | Free (revenue share) |
| Fonts | Google Fonts | Free |

## Deployment

1. Push all files to a GitHub repository
2. Connect the repo to Vercel (vercel.com → Import Project)
3. Add environment variables in Vercel dashboard
4. Deploy — Vercel auto-redeploys on every `git push`

## Pages & SEO

Each tool page has:
- Unique `<title>` and `<meta name="description">`
- JSON-LD structured data (main page)
- Cross-links to other tools (for internal link equity)
- `robots.txt` allows all crawlers
- `sitemap.xml` lists all public pages

## Ad Network Setup

1. Sign up at monetag.com as a Publisher
2. Add your site URL and verify ownership via `sw.js` (already included)
3. Select **MultiTag** format
4. Copy the snippet Monetag provides and add it to `<head>` of all HTML pages
5. Add your payout method once you cross the minimum threshold

## Limitations & Known Issues

- AI detector is a **heuristic estimate** — not a certified or scientifically validated detector. Results should not be used for academic integrity, legal, or formal authorship decisions.
- Humanizer word limits (200 free / 4000 after ads) are enforced server-side but the ad-watch confirmation still relies on a client-side signal from Monetag's SDK — not airtight against a determined user faking the JS call.
- Monetag `show_XXX()` function in `index.html` requires your real Zone ID — until configured, the Watch Ad button shows a friendly error.

## License

Free to use and modify for personal projects.
