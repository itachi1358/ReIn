import { runAnalysis } from "../lib/analyze.js";

export const config = { maxDuration: 120 };   // worst case: 2 rate-limit waits + a full run

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("POST only");

  // Vercel parses JSON bodies for us; locally the dev server hands us a string.
  const input = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const { status, body } = await runAnalysis(input);
  res.status(status).setHeader("content-type", status === 200 ? "application/json" : "text/plain").send(body);
}
