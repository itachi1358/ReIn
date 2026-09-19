# Résumé Intelligence

Evidence-graded resume analysis, role matching and gap analysis. One page, one server,
no build step, no npm dependencies.

```
cp .env.example .env            # then paste your key into it
npm start                        # http://localhost:5173
```

Open **http://localhost:5173** — not the file directly, and not VS Code Live Server.
Only `server.js` answers `POST /api/analyze`.

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
