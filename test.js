import assert from "node:assert/strict";
import { buildUserMessage, waitFrom, runAnalysis } from "./lib/analyze.js";

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

/* ---- 429 retry delay, parsed from Groq's own message ---- */
assert.equal(waitFrom("Please try again in 2.7975s"), 3048);   // 2797.5ms -> ceil + 250ms margin
assert.equal(waitFrom("Rate limit reached. try again in 850ms"), 1100);
assert.equal(waitFrom("no hint at all"), 2000);                 // sane default, never NaN
assert.equal(waitFrom(undefined), 2000);

/* ---- runAnalysis returns errors instead of throwing, and won't call out on bad input ---- */
const key = process.env.GROQ_API_KEY;
delete process.env.GROQ_API_KEY;
assert.deepEqual(await runAnalysis({ text: "x" }), { status: 500, body: "GROQ_API_KEY is not set on the server." });

process.env.GROQ_API_KEY = "test-key-never-used";
const empty = await runAnalysis({ text: "   " });
assert.equal(empty.status, 400);                                // rejected before any network call
assert.match(empty.body, /No readable resume/);

if (key === undefined) delete process.env.GROQ_API_KEY;
else process.env.GROQ_API_KEY = key;

console.log("ok — 15 assertions passed");
