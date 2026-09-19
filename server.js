// Local dev only. On Vercel, public/ is served statically and api/*.js are functions;
// this file just reproduces that locally so `npm start` needs no extra tooling.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { runAnalysis } from "./lib/analyze.js";

const PORT = Number(process.env.PORT) || 5173;
const MAX_BODY = 2 * 1024 * 1024;

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

createServer(async (req, res) => {
  if (req.url === "/api/health") return res.writeHead(200, { "content-type": "text/plain" }).end("ok");

  if (req.method === "POST" && req.url === "/api/analyze") {
    let input;
    try {
      input = JSON.parse(await readBody(req));
    } catch (err) {
      return res.writeHead(400, { "content-type": "text/plain" }).end(err.message);
    }
    const { status, body } = await runAnalysis(input);
    return res
      .writeHead(status, { "content-type": status === 200 ? "application/json" : "text/plain", "cache-control": "no-store" })
      .end(body);
  }

  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(await readFile(new URL("./public/index.html", import.meta.url)));
  }
  res.writeHead(404).end("Not found");
}).listen(PORT, () => {
  if (!process.env.GROQ_API_KEY) console.error("  warning: GROQ_API_KEY is not set — analyses will fail.");
  console.log(`\n  AI Resume  →  http://localhost:${PORT}\n`);
});
