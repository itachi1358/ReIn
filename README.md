# Résumé Intelligence

Evidence-graded resume analysis, role matching and gap analysis. One page, one server,
no build step, no npm dependencies.

```
cp .env.example .env            # then paste your key into it
npm start                        # http://localhost:5173
```

Open **http://localhost:5173** — not the file directly, and not VS Code Live Server.
Only `server.js` answers `POST /api/analyze`.

## Layout

```
public/index.html   the whole UI (static)
api/analyze.js      Vercel function -> lib/analyze.js
api/health.js       lets the page tell it is being served properly
lib/analyze.js      the shared core: prompt assembly, Groq call, 429 retry
prompt.md           the rubric; §10 defines the JSON contract
server.js           local dev only, reproduces the Vercel routing
```

PDFs are converted to text in the browser by pdf.js, so the file itself never leaves the
page — only the extracted text is sent. Scanned/image-only PDFs won't work; paste the text.
Optionally paste a job description to score against it.

| Env | Default | |
|---|---|---|
| `GROQ_API_KEY` | — | required |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | see below |
| `MAX_TOKENS` | `16384` | raise if Deep mode gets cut off |
| `PORT` | `5173` | |

The analysis rubric lives in `prompt.md` — edit it to change how the engine grades.
`npm test` checks prompt assembly and the SSE stream reader.

## Rate limits

Groq's free tier caps **tokens per minute**, not just requests. One analysis costs roughly
**6.5K tokens** (3.2K system prompt + your resume + ~3K of output) against an **8K TPM**
budget, so back-to-back runs will 429. The server retries once, honouring the delay Groq
returns, which absorbs the common case.

Models actually worth setting, measured on this rubric:

| `GROQ_MODEL` | TPM | Verdict |
|---|---|---|
| `openai/gpt-oss-120b` *(default)* | 8K | Best calibration — applies the §3 evidence caps properly. ~8s. |
| `openai/gpt-oss-20b` | 8K | 2.6× faster, valid JSON, but grades looser (missed 4 of 5 mention-only skills). |
| `groq/compound-mini` | 70K | **Don't.** Ignores JSON mode and inflates the prompt to 7.2K tokens. |
| `groq/compound` | 70K | **Don't.** Returns prose around the JSON. |

Nothing on the free tier gives both a big budget and reliable JSON. If you need volume
rather than one analysis a minute, Groq's Dev Tier is the only real fix.

## Deploying to Vercel

Zero-config: `public/` is served statically and `api/*.js` become functions. No build step.

```bash
npm i -g vercel
vercel                                  # first run links the project
vercel env add GROQ_API_KEY production  # paste the key when prompted
vercel --prod
```

Or push to GitHub and import the repo at vercel.com/new — same result, plus deploys on
every push. Either way set `GROQ_API_KEY` under **Settings → Environment Variables**;
`.env` is gitignored and is never uploaded.

`vercel.json` pins `maxDuration: 120` and ships `prompt.md` with the function via
`includeFiles` (it is read at runtime, so file tracing alone would not include it).
Hobby allows up to 300s; 120 covers a full run plus two rate-limit waits.

Optional env vars on Vercel: `GROQ_MODEL`, `MAX_TOKENS`, `RETRIES` — same defaults as local.

**Deploying makes the key reachable by anyone who finds the URL**, since there is no auth
on `/api/analyze` — every visitor spends your Groq quota. Fine for a personal link;
add auth or a rate limit before sharing it widely.
