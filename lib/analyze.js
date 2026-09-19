import { readFile } from "node:fs/promises";

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 8192;
const RETRIES = Number(process.env.RETRIES) || 3;   // 429s are a per-minute cap; wait it out

const MODES = {
  quick: "Depth: Quick. Return JSON per §10.",
  standard: "Depth: Standard. Return JSON per §10.",
  deep: "Depth: Deep. Return JSON per §10.",
};

// Read once per instance. Lazy rather than top-level so a cold serverless start
// doesn't pay for it until a request actually arrives.
let cached;
const system = async () => (cached ??= await readFile(new URL("../prompt.md", import.meta.url), "utf8"));

/** Build the single user message. Exported for test.js. */
export function buildUserMessage({ text, jd, mode }) {
  if (!text?.trim()) throw new Error("No readable resume supplied.");
  let msg = `<resume>\n${text.trim()}\n</resume>\n\n${MODES[mode] || MODES.standard}`;
  if (jd?.trim()) {
    msg += `\n\nA job description was supplied — also run §9 (JD mode).\n\n<job_description>\n${jd.trim()}\n</job_description>`;
  }
  return msg;
}

/** Groq puts the wait in the message: "Please try again in 2.7975s". Exported for test.js. */
export function waitFrom(text) {
  const m = /try again in ([\d.]+)(ms|s)\b/.exec(text || "");
  if (!m) return 2000;
  return Math.ceil(Number(m[1]) * (m[2] === "s" ? 1000 : 1)) + 250;   // +250ms so the window has actually rolled
}

const call = (body) => fetch("https://api.groq.com/openai/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" },
  body,
});

/**
 * Runs one analysis. Returns { status, body } — body is the model's JSON on 200,
 * or a plain-text explanation otherwise. Never throws for an upstream failure.
 */
export async function runAnalysis(input) {
  if (!process.env.GROQ_API_KEY) return { status: 500, body: "GROQ_API_KEY is not set on the server." };

  let message;
  try {
    message = buildUserMessage(input);
  } catch (err) {
    return { status: 400, body: err.message };
  }

  const payload = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: await system() }, { role: "user", content: message }],
  });

  let r;
  try {
    // A 429 is a per-minute token ceiling, not a bad request, and Groq returns how long
    // to wait. The cap is per minute, so a few server-timed waits ride it out instead of
    // failing the run. Anything past that is a real shortage, not a blip.
    for (let attempt = 1; ; attempt++) {
      r = await call(payload);
      if (r.status !== 429 || attempt === RETRIES) break;
      const wait = Math.min(Number(r.headers.get("retry-after")) * 1000 || waitFrom(await r.clone().text()), 30_000);
      console.log(`rate limited (attempt ${attempt}/${RETRIES}), waiting ${Math.round(wait / 100) / 10}s`);
      await new Promise((ok) => setTimeout(ok, wait));
    }
  } catch (err) {
    return { status: 502, body: `Could not reach Groq: ${err.message}` };
  }

  const text = await r.text();
  if (!r.ok) {
    let detail = text;
    try { detail = JSON.parse(text).error?.message ?? text; } catch {}
    if (r.status === 429) {
      detail += `\n\nThat is Groq's free-tier tokens-per-minute cap and ${RETRIES} attempts failed, so the budget is genuinely drained. One analysis costs ~6.5K of an 8K/min budget — give it a minute. GROQ_MODEL=openai/gpt-oss-20b is lighter and faster, but grades more loosely. The compound models have a 70K budget and are NOT usable here: they don't honour JSON mode.`;
    }
    return { status: r.status, body: `Groq ${r.status}: ${detail}` };
  }

  const content = JSON.parse(text).choices?.[0]?.message?.content;
  if (!content) return { status: 502, body: "Groq returned an empty completion." };
  return { status: 200, body: content };
}
