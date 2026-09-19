import assert from "node:assert/strict";
import { buildUserMessage, sseReader } from "./server.js";

/* ---- prompt assembly ---- */
const m = buildUserMessage({ text: "  Jane Doe\nBackend intern  ", mode: "deep" });
assert.match(m, /^<resume>\nJane Doe\nBackend intern\n<\/resume>/);
assert.match(m, /Depth: Deep/);

// unknown / missing mode falls back to standard, never "undefined"
assert.match(buildUserMessage({ text: "x", mode: "bogus" }), /Depth: Standard/);
assert.match(buildUserMessage({ text: "x" }), /Depth: Standard/);

// JD appended and §9 triggered; blank JD must not trigger it
assert.match(buildUserMessage({ text: "x", jd: "Kafka required" }), /<job_description>\nKafka required\n<\/job_description>/);
assert.doesNotMatch(buildUserMessage({ text: "x", jd: "   " }), /job_description/);

// empty input rejected rather than silently billed
assert.throws(() => buildUserMessage({ text: "   " }), /No readable resume/);
assert.throws(() => buildUserMessage({}), /No readable resume/);

/* ---- SSE stream reader ---- */
const frame = (c) => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`;

// whole frames
const whole = sseReader();
assert.equal(whole(frame("Hello") + frame(" world")), "Hello world");
assert.equal(whole("data: [DONE]\n\n"), "");

// a chunk boundary mid-JSON must not lose or duplicate text
const split = sseReader();
const wire = frame("## Verdict") + frame("\nStrong backend") + "data: [DONE]\n\n";
let got = "";
for (let i = 0; i < wire.length; i += 7) got += split(wire.slice(i, i + 7));
assert.equal(got, "## Verdict\nStrong backend");

// keep-alive comments, blank lines and role-only first deltas produce nothing
const noise = sseReader();
assert.equal(noise(": ping\n\n\n" + `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" } }] })}\n\n`), "");

// a malformed frame is skipped, not fatal, and the next one still lands
const bad = sseReader();
assert.equal(bad("data: {not json\n\n" + frame("ok")), "ok");



/* ---- byte chunks, as fetch actually delivers them ---- */
// This is the shape the server sees: Uint8Array, not string, not Buffer.
const bytes = sseReader();
const enc = new TextEncoder();
assert.equal(bytes(enc.encode(frame("Latency 800ms → 250ms"))), "Latency 800ms → 250ms");

// a multi-byte character split across two chunks must survive
const split2 = sseReader();
const wire2 = enc.encode(frame("cut p95 — 38%"));
const cut = 40; // lands inside the em dash's 3 UTF-8 bytes
assert.equal(split2(wire2.slice(0, cut)) + split2(wire2.slice(cut)), "cut p95 — 38%");



/* ---- 429 retry delay, parsed from Groq's own message ---- */
import { waitFrom } from "./server.js";
assert.equal(waitFrom("Please try again in 2.7975s"), 3048);   // 2797.5ms -> ceil + 250ms margin
assert.equal(waitFrom("Rate limit reached. try again in 850ms"), 1100);
assert.equal(waitFrom("no hint at all"), 2000);                 // sane default, never NaN
assert.equal(waitFrom(undefined), 2000);

console.log("ok — 20 assertions passed");
