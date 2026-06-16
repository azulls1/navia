// Smoke del replay determinista (action-caching): construye una macro a mano y la
// re-ejecuta SIN LLM; verifica que type + click funcionaron por localizador estable.
import { replayMacro } from "../dist/index.js";
import assert from "node:assert";
import http from "node:http";
import { writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let lastName = null;
const server = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    if (req.url.startsWith("/done")) {
      lastName = new URL(req.url, "http://x").searchParams.get("name");
      res.end("ok");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<!doctype html><meta charset=utf-8><body>
      <input id="n" aria-label="Nombre">
      <button onclick="fetch('/done?name='+encodeURIComponent(document.getElementById('n').value))">Saluda</button>
    </body>`);
  });
  s.listen(0, "127.0.0.1", () => resolve(s));
});
const port = server.address().port;

const macro = [
  { type: "action", tool: "navigate", input: { url: `http://127.0.0.1:${port}` }, ok: true },
  { type: "action", tool: "type", input: { text: "Sam" }, locator: { role: "textbox", name: "Nombre" }, ok: true },
  { type: "action", tool: "click", input: {}, locator: { role: "button", name: "Saluda" }, ok: true },
  { type: "action", tool: "wait_for", input: { time_ms: 800 }, ok: true },
];
const file = path.join(os.tmpdir(), `navia-macro-${Date.now()}.jsonl`);
writeFileSync(file, macro.map((s) => JSON.stringify(s)).join("\n"));

try {
  const r = await replayMacro(file, { task: "", browser: "chromium", headless: true }, (m) => console.log(m));
  console.log("resultado:", r);
  assert(r.failed === 0, "no debía fallar ninguna acción");
  assert(lastName === "Sam", `el replay debió escribir 'Sam' y hacer click (server recibió '${lastName}')`);
  console.log("\n✓ Replay smoke OK (macro determinista: type + click por localizador estable)");
} finally {
  server.close();
  rmSync(file, { force: true });
}
