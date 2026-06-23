/**
 * Test de INTEGRACIÓN del loop CLI (runViaCli) end-to-end: navegador REAL headless + un
 * Fake_CLI (binario simulado vía NAVIA_CLI_CMD que emite una secuencia programada de acciones
 * JSON). Es el espejo, para el loop CLI, del LLM mock del loop API (loop-integration.test.ts):
 * ejercita dispatch de tools, métricas/anti-bucle y terminación, para que AMBOS loops queden
 * bajo la misma red de seguridad (riesgo nº1 de AGENTS.md: que los dos loops diverjan).
 */
import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import os from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { runNavia } from "../src/agent/agent.js";

// Fake_CLI: lee stdin (el prompt, lo ignora), toma la siguiente acción de NAVIA_FAKECLI_SCRIPT
// según un contador persistido en archivo (un proceso nuevo por paso) y la imprime por stdout.
const SCRIPT = `
import { readFileSync, writeFileSync } from "node:fs";
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const seq = JSON.parse(process.env.NAVIA_FAKECLI_SCRIPT || "[]");
  const counterFile = process.env.NAVIA_FAKECLI_COUNTER;
  let n = 0;
  try { n = parseInt(readFileSync(counterFile, "utf8"), 10) || 0; } catch {}
  writeFileSync(counterFile, String(n + 1));
  process.stdout.write(JSON.stringify(seq[Math.min(n, seq.length - 1)]));
});
`;

const scriptPath = path.join(os.tmpdir(), "navia-fakecli.mjs");
const counterPath = path.join(os.tmpdir(), "navia-fakecli-counter.txt");
writeFileSync(scriptPath, SCRIPT);

/** Programa la secuencia de acciones del Fake_CLI y resetea el contador. */
function setSeq(seq: unknown[]): void {
  process.env.NAVIA_FAKECLI_SCRIPT = JSON.stringify(seq);
  process.env.NAVIA_FAKECLI_COUNTER = counterPath;
  process.env.NAVIA_CLI_CMD = `node ${scriptPath}`;
  writeFileSync(counterPath, "0");
}

afterEach(() => {
  delete process.env.NAVIA_CLI_CMD;
  delete process.env.NAVIA_FAKECLI_SCRIPT;
  delete process.env.NAVIA_FAKECLI_COUNTER;
});

const HTML = "data:text/html,<h1>x</h1><p>página de prueba</p>";

describe("integración · loop CLI (Fake_CLI + navegador real)", () => {
  it("ejecuta una tool y termina por done, con métricas coherentes", async () => {
    setSeq([{ tool: "wait_for", args: { time_ms: 10 } }, { done: true, summary: "Listo: integración CLI." }]);
    const result = await runNavia({ task: "t", provider: "claude-cli", headless: true, startUrl: HTML, maxSteps: 4 });
    expect(result.summary).toContain("Listo");
    expect(result.steps).toBeGreaterThanOrEqual(2);
    expect(result.metrics!.toolCalls).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("detecta el anti-bucle cuando repite la misma acción", async () => {
    setSeq([
      { tool: "wait_for", args: { time_ms: 5 } },
      { tool: "wait_for", args: { time_ms: 5 } },
      { done: true, summary: "fin" },
    ]);
    const result = await runNavia({ task: "t", provider: "claude-cli", headless: true, startUrl: HTML, maxSteps: 4 });
    expect(result.metrics!.loopHits).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("al alcanzar maxSteps termina exacto y reporta el máximo de pasos", async () => {
    setSeq([{ tool: "wait_for", args: { time_ms: 5 } }]); // una sola acción → se repite para siempre
    const result = await runNavia({ task: "bucle", provider: "claude-cli", headless: true, startUrl: HTML, maxSteps: 2 });
    expect(result.steps).toBe(2);
    expect(result.summary).toMatch(/m[aá]ximo/i);
  }, 60_000);

  // Feature: coverage-parity-and-export, Property 4
  it("P4 · termina en exactamente N pasos para cualquier maxSteps (1..3)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (n) => {
        setSeq([{ tool: "wait_for", args: { time_ms: 5 } }]);
        const result = await runNavia({ task: "n", provider: "claude-cli", headless: true, startUrl: HTML, maxSteps: n });
        return result.steps === n && /m[aá]ximo/i.test(result.summary);
      }),
      { numRuns: 2 }, // cada iteración lanza un navegador real → pocas corridas
    );
  }, 120_000);
});
