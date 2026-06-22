/**
 * Test de INTEGRACIÓN del loop de agente (agent.ts) end-to-end: navegador REAL headless +
 * un LLM MOCK (servidor HTTP OpenAI-compatible que devuelve una secuencia de acciones programada).
 * Es la red de seguridad para refactorizar el núcleo del loop (LoopMetrics, executeToolCall) sin
 * romper comportamiento: ejercita dispatch de tools, conteo de métricas, anti-bucle y fin por texto.
 */
import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import http from "node:http";
import { runNavia } from "../src/agent/agent.js";

let srv: http.Server | undefined;
afterEach(() => {
  srv?.close();
  srv = undefined;
  delete process.env.NAVIA_OPENAI_BASE_URL;
  delete process.env.NAVIA_OPENAI_MODEL;
});

/** Levanta un endpoint /chat/completions que responde la secuencia dada, turno a turno. */
async function mockLLM(responses: any[]): Promise<string> {
  let i = 0;
  srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r));
    });
  });
  await new Promise<void>((r) => srv!.listen(0, r));
  return `http://127.0.0.1:${(srv!.address() as any).port}/v1`;
}

function toolTurn(name: string, args: object, id: string) {
  return { choices: [{ message: { content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 2 } };
}
function textTurn(text: string) {
  return { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
}
/** Turno truncado por longitud (finish_reason: "length"). */
function lengthTurn(text = "respuesta a medi") {
  return { choices: [{ message: { content: text }, finish_reason: "length" }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
}

describe("integración · loop de agente (LLM mock + navegador real)", () => {
  it("ejecuta tools, cuenta métricas/anti-bucle y termina por texto", async () => {
    // Secuencia: wait_for, wait_for (repetida → loopHit), luego resumen final.
    const base = await mockLLM([toolTurn("wait_for", { time_ms: 10 }, "c1"), toolTurn("wait_for", { time_ms: 10 }, "c2"), textTurn("Listo: terminé la prueba de integración.")]);
    process.env.NAVIA_OPENAI_BASE_URL = base;
    process.env.NAVIA_OPENAI_MODEL = "mock";

    const result = await runNavia({
      task: "prueba de integración",
      provider: "openai",
      headless: true,
      startUrl: "data:text/html,<h1>hola</h1><p>página de prueba</p>",
      maxSteps: 6,
    });

    expect(result.summary).toContain("terminé");
    expect(result.metrics.toolCalls).toBe(2); // dos wait_for
    expect(result.metrics.toolErrors).toBe(0);
    expect(result.metrics.loopHits).toBeGreaterThanOrEqual(1); // la 2ª wait_for repite la firma
    expect(result.steps).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("una respuesta truncada (finish_reason length) no cuenta como error y el loop continúa", async () => {
    const base = await mockLLM([lengthTurn(), toolTurn("wait_for", { time_ms: 10 }, "c1"), textTurn("Hecho tras truncado.")]);
    process.env.NAVIA_OPENAI_BASE_URL = base;
    process.env.NAVIA_OPENAI_MODEL = "mock";
    const result = await runNavia({ task: "t", provider: "openai", headless: true, startUrl: "data:text/html,<h1>x</h1>", maxSteps: 6 });
    expect(result.metrics.toolErrors).toBe(0);
    expect(result.steps).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("al alcanzar maxSteps termina exacto y reporta el mensaje de máximo de pasos", async () => {
    const base = await mockLLM([toolTurn("wait_for", { time_ms: 5 }, "loop")]); // el mock SIEMPRE repite tool → nunca termina solo
    process.env.NAVIA_OPENAI_BASE_URL = base;
    process.env.NAVIA_OPENAI_MODEL = "mock";
    const result = await runNavia({ task: "bucle", provider: "openai", headless: true, startUrl: "data:text/html,<h1>x</h1>", maxSteps: 2 });
    expect(result.steps).toBe(2);
    expect(result.summary).toMatch(/m[aá]ximo/i);
  }, 60_000);

  // Feature: end-to-end-validation-improvements, Property 13: terminación por max-steps exacta para cualquier N
  it("P13 · termina en exactamente N pasos para cualquier maxSteps (1..3)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 3 }), async (n) => {
        let i = 0;
        const server = http.createServer((req, res) => {
          let b = "";
          req.on("data", (c) => (b += c));
          req.on("end", () => {
            i++;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(toolTurn("wait_for", { time_ms: 5 }, `s${i}`))); // siempre tool → nunca termina
          });
        });
        await new Promise<void>((r) => server.listen(0, r));
        process.env.NAVIA_OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}/v1`;
        process.env.NAVIA_OPENAI_MODEL = "mock";
        try {
          const result = await runNavia({ task: "n", provider: "openai", headless: true, startUrl: "data:text/html,<h1>x</h1>", maxSteps: n });
          return result.steps === n && /m[aá]ximo/i.test(result.summary);
        } finally {
          server.close();
          delete process.env.NAVIA_OPENAI_BASE_URL;
          delete process.env.NAVIA_OPENAI_MODEL;
        }
      }),
      { numRuns: 3 }, // cada iteración lanza un navegador real → pocas corridas
    );
  }, 120_000);
});
