import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORT) || 5173;
const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 8192;  // compound-mini caps here; deep mode uses ~2k
const MAX_BODY = 2 * 1024 * 1024;
const RETRIES = Number(process.env.RETRIES) || 3;   // 429s are a per-minute cap; wait it out

const here = (f) => new URL(f, import.meta.url);
const SYSTEM = await readFile(here("prompt.md"), "utf8");

const MODES = {
  quick: "Depth: Quick. Return JSON per §10.",
  standard: "Depth: Standard. Return JSON per §10.",
  deep: "Depth: Deep. Return JSON per §10.",
};

/** Build the single user message. Exported for test.js. */
export function buildUserMessage({ text, jd, mode }) {
  if (!text?.trim()) throw new Error("No readable resume supplied.");
  let msg = `<resume>\n${text.trim()}\n</resume>\n\n${MODES[mode] || MODES.standard}`;
  if (jd?.trim()) {
    msg += `\n\nA job description was supplied — also run §9 (JD mode).\n\n<job_description>\n${jd.trim()}\n</job_description>`;
  }
  return msg;
}

/**
 * Stateful OpenAI-style SSE reader: feed it raw stream chunks, get back assistant text.
 * Owns the UTF-8 decode (fetch yields Uint8Array, and a chunk can split a multi-byte
 * character) and buffers the trailing partial line (a chunk can split mid-JSON).
 * Exported for test.js.
 */
export function sseReader() {
  const decoder = new TextDecoder();
  let buf = "";
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    let out = "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        out += JSON.parse(payload).choices?.[0]?.delta?.content ?? "";
      } catch {
        // ponytail: a malformed frame is dropped, not fatal. Revisit if Groq ever
        // sends multi-line JSON payloads (the spec allows it; nothing emits it today).
      }
    }
    return out;
  };
}

const call = (body) => fetch("https://api.groq.com/openai/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, "content-type": "application/json" },
  body,
});

/** Groq puts the wait in the message: "Please try again in 2.7975s". Exported for test.js. */
export function waitFrom(text) {
  const m = /try again in ([\d.]+)(ms|s)\b/.exec(text || "");
  if (!m) return 2000;
  return Math.ceil(Number(m[1]) * (m[2] === "s" ? 1000 : 1)) + 250;   // +250ms so the window has actually rolled
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("Resume too large (2MB of text).")); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
    req.on("error", reject);
  });
}

async function analyze(req, res) {
  let message;
  try {
    message = buildUserMessage(JSON.parse(await readBody(req)));
  } catch (err) {
    res.writeHead(400, { "content-type": "text/plain" }).end(err.message);
    return;
  }

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: true,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: message },
    ],
  });

  let upstream;
  try {
    // A 429 is a per-minute token ceiling, not a bad request, and Groq returns how long
    // to wait. The cap is per minute, so a few server-timed waits ride it out instead of
    // failing the run. Anything past that is a real shortage, not a blip.
    for (let attempt = 1; ; attempt++) {
      upstream = await call(body);
      if (upstream.status !== 429 || attempt === RETRIES) break;
      const wait = Math.min(Number(upstream.headers.get("retry-after")) * 1000 || waitFrom(await upstream.clone().text()), 30_000);
      console.log(`rate limited (attempt ${attempt}/${RETRIES}), waiting ${Math.round(wait / 100) / 10}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain" }).end(`Could not reach Groq: ${err.message}`);
    return;
  }

  if (!upstream.ok) {
    const body = await upstream.text();
    let detail = body;
    try { detail = JSON.parse(body).error?.message ?? body; } catch {}
    if (upstream.status === 429) {
      detail += `\n\nThat is Groq's free-tier tokens-per-minute cap and ${RETRIES} attempts failed, so the budget is genuinely drained. One analysis costs ~6.5K of an 8K/min budget — give it a minute. GROQ_MODEL=openai/gpt-oss-20b is lighter and faster, but grades more loosely. The compound models have a 70K budget and are NOT usable here: they don't honour JSON mode.`;
    }
    res.writeHead(upstream.status, { "content-type": "text/plain" }).end(`Groq ${upstream.status}: ${detail}`);
    return;
  }

  res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  const read = sseReader();
  try {
    for await (const chunk of upstream.body) res.write(read(chunk));
  } catch (err) {
    console.error(err);
    res.write(`\n\n> **Stream interrupted:** ${err.message}`);
  }
  res.end();
}

const server = createServer(async (req, res) => {
  if (req.url === "/api/health") return res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  if (req.method === "POST" && req.url === "/api/analyze") return analyze(req, res);
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(await readFile(here("index.html")));
    return;
  }
  res.writeHead(404).end("Not found");
});

// Only listen when run directly, so test.js can import the helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.GROQ_API_KEY) {
    console.error("\n  GROQ_API_KEY is not set.\n  PowerShell:  $env:GROQ_API_KEY=\"gsk_...\"\n");
    process.exit(1);
  }
  server.listen(PORT, () => console.log(`\n  AI Resume  →  http://localhost:${PORT}   (${MODEL})\n`));
}
