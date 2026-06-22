import { describe, it, expect, vi, afterEach } from "vitest";
import fc from "fast-check";
import { __test, resolveOpenAIPreset, OpenAICompatClient } from "../src/providers/openai-provider.js";

const { toOpenAITools, toOpenAIMessages, fromOpenAIResponse, calcDelay } = __test;

const noSleep = async () => {}; // sleep inyectado no-op → tests sin temporizadores reales
const cfg = (over: Partial<{ label: string; baseURL: string }> = {}) => ({ label: over.label ?? "Groq", baseURL: over.baseURL ?? "https://api.groq.com/openai/v1", apiKey: "k", model: "m" });
const okJSON = (obj: any) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());

describe("openai-provider · adaptador de formato", () => {
  it("traduce tools Anthropic → formato OpenAI function", () => {
    const tools = [{ name: "click", description: "haz click", input_schema: { type: "object", properties: { ref: { type: "string" } } } }];
    const out = toOpenAITools(tools)!;
    expect(out[0]).toEqual({
      type: "function",
      function: { name: "click", description: "haz click", parameters: { type: "object", properties: { ref: { type: "string" } } } },
    });
  });

  it("system (bloques) → mensaje system; user string → user", () => {
    const msgs = toOpenAIMessages([{ type: "text", text: "eres Navia" }], [{ role: "user", content: "hola" }]);
    expect(msgs[0]).toEqual({ role: "system", content: "eres Navia" });
    expect(msgs[1]).toEqual({ role: "user", content: "hola" });
  });

  it("assistant con tool_use → tool_calls; user con tool_result → mensaje role:tool", () => {
    const msgs = toOpenAIMessages(undefined, [
      { role: "assistant", content: [{ type: "text", text: "voy a hacer click" }, { type: "tool_use", id: "c1", name: "click", input: { ref: "v1:7" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "ok, página cambió" }] }] },
    ]);
    const asst = msgs.find((m: any) => m.role === "assistant")!;
    expect(asst.tool_calls[0]).toMatchObject({ id: "c1", type: "function", function: { name: "click" } });
    expect(JSON.parse(asst.tool_calls[0].function.arguments)).toEqual({ ref: "v1:7" });
    const tool = msgs.find((m: any) => m.role === "tool")!;
    expect(tool).toEqual({ role: "tool", tool_call_id: "c1", content: "ok, página cambió" });
  });

  it("respuesta OpenAI con tool_calls → bloques Anthropic + stop_reason tool_use", () => {
    const resp = fromOpenAIResponse({
      id: "x",
      choices: [{ message: { content: "pensando", tool_calls: [{ id: "t1", function: { name: "navigate", arguments: '{"url":"https://x.com"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(resp.stop_reason).toBe("tool_use");
    expect(resp.content).toEqual([
      { type: "text", text: "pensando" },
      { type: "tool_use", id: "t1", name: "navigate", input: { url: "https://x.com" } },
    ]);
    expect(resp.usage.input_tokens).toBe(10);
    expect(resp.usage.output_tokens).toBe(5);
  });

  it("respuesta solo texto → stop_reason end_turn; arguments inválidos → input vacío sin romper", () => {
    const plain = fromOpenAIResponse({ choices: [{ message: { content: "listo" } }] });
    expect(plain.stop_reason).toBe("end_turn");
    const bad = fromOpenAIResponse({ choices: [{ message: { tool_calls: [{ id: "t", function: { name: "x", arguments: "{no-json" } }] } }] });
    expect((bad.content[0] as any).input).toEqual({});
  });

  it("respuesta truncada (finish_reason length) → stop_reason max_tokens (no end_turn)", () => {
    const r = fromOpenAIResponse({ choices: [{ message: { content: "resumen a medi" }, finish_reason: "length" }] });
    expect(r.stop_reason).toBe("max_tokens");
  });

  it("presets: groq/ollama/openrouter con base URL correcta; env override gana", () => {
    expect(resolveOpenAIPreset("groq").baseURL).toBe("https://api.groq.com/openai/v1");
    expect(resolveOpenAIPreset("ollama").baseURL).toMatch(/localhost:11434/);
    expect(resolveOpenAIPreset("openrouter").baseURL).toBe("https://openrouter.ai/api/v1");
    process.env.NAVIA_OPENAI_MODEL = "mi-modelo";
    expect(resolveOpenAIPreset("groq").model).toBe("mi-modelo");
    delete process.env.NAVIA_OPENAI_MODEL;
  });
});

describe("openai-provider · backoff y reintentos", () => {
  it("calcDelay: exponencial dentro de rangos y acotado por el cap", () => {
    expect(calcDelay(0)).toBeGreaterThanOrEqual(500);
    expect(calcDelay(0)).toBeLessThanOrEqual(700);
    expect(calcDelay(2)).toBeGreaterThanOrEqual(2000);
    expect(calcDelay(2)).toBeLessThanOrEqual(2200);
    expect(calcDelay(20)).toBeLessThanOrEqual(30_000); // tope
  });

  it("reintenta 429 hasta 4 intentos y luego lanza con plantilla (label · baseURL)", async () => {
    const fetchMock = vi.fn(async () => new Response("rate", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = new OpenAICompatClient(cfg({ label: "Groq", baseURL: "https://x/v1" }), undefined, undefined, noSleep);
    await expect(c.messages.create({ messages: [{ role: "user", content: "hola" }] })).rejects.toThrow(/No se pudo contactar al modelo \(Groq · https:\/\/x\/v1\)/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("NO reintenta un 4xx distinto de 429 (fast-fail, 1 sola petición)", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const c = new OpenAICompatClient(cfg(), undefined, undefined, noSleep);
    await expect(c.messages.create({ messages: [] })).rejects.toThrow(/HTTP 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("onRetry se invoca con attempt 1-based, waitMs>0 y reason='HTTP 500'", async () => {
    let ok = false;
    const fetchMock = vi.fn(async () => (ok ? okJSON({ choices: [{ message: { content: "listo" } }] }) : ((ok = true), new Response("e", { status: 500 }))));
    vi.stubGlobal("fetch", fetchMock);
    const calls: any[] = [];
    const c = new OpenAICompatClient(cfg(), undefined, (a, w, r) => calls.push([a, w, r]), noSleep);
    await c.messages.create({ messages: [] });
    expect(calls[0][0]).toBe(1);
    expect(calls[0][1]).toBeGreaterThan(0);
    expect(calls[0][2]).toBe("HTTP 500");
  });

  it("SIN streamHook el body no incluye stream:true", async () => {
    let sent: any;
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return okJSON({ choices: [{ message: { content: "ok" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = new OpenAICompatClient(cfg(), undefined, undefined, noSleep);
    await c.messages.create({ messages: [] });
    expect(sent.stream).toBeUndefined();
  });

  // Feature: end-to-end-validation-improvements, Property 1: calcDelay acotado por el cap
  it("P1 · calcDelay está acotado por cap y por debajo nunca de base·2^attempt", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 }), fc.integer({ min: 100, max: 1000 }), fc.integer({ min: 5000, max: 60000 }), (attempt, base, cap) => {
        const d = calcDelay(attempt, base, cap);
        return d <= cap && d >= base * Math.pow(2, attempt);
      }),
    );
  });

  // Feature: end-to-end-validation-improvements, Property 2: 4xx no-429 falla de inmediato
  it("P2 · cualquier 4xx no-429 lanza tras exactamente 1 petición", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(400, 401, 403, 404, 422), async (status) => {
        const fetchMock = vi.fn(async () => new Response("x", { status }));
        vi.stubGlobal("fetch", fetchMock);
        const c = new OpenAICompatClient(cfg(), undefined, undefined, noSleep);
        let threw = false;
        try {
          await c.messages.create({ messages: [] });
        } catch {
          threw = true;
        }
        vi.unstubAllGlobals();
        return threw && fetchMock.mock.calls.length === 1;
      }),
      { numRuns: 20 },
    );
  });

  // Feature: end-to-end-validation-improvements, Property 3: el error final contiene label y baseURL
  it("P3 · tras agotar reintentos el mensaje incluye label y baseURL", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ minLength: 1 }), fc.string({ minLength: 1 }), async (label, baseURL) => {
        const fetchMock = vi.fn(async () => new Response("e", { status: 500 }));
        vi.stubGlobal("fetch", fetchMock);
        const c = new OpenAICompatClient({ label, baseURL, apiKey: "k", model: "m" }, undefined, undefined, noSleep);
        let msg = "";
        try {
          await c.messages.create({ messages: [] });
        } catch (e) {
          msg = (e as Error).message;
        }
        vi.unstubAllGlobals();
        return msg.includes(label) && msg.includes(baseURL);
      }),
      { numRuns: 20 },
    );
  });

  // Feature: end-to-end-validation-improvements, Property 4: onRetry recibe attempt 1-based y reason HTTP
  it("P4 · onRetry recibe attempt 1-based, waitMs>0 y reason='HTTP <status>'", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(429, 500, 502, 503), async (status) => {
        const fetchMock = vi.fn(async () => new Response("e", { status }));
        vi.stubGlobal("fetch", fetchMock);
        const calls: any[] = [];
        const c = new OpenAICompatClient(cfg(), undefined, (a, w, r) => calls.push([a, w, r]), noSleep);
        try {
          await c.messages.create({ messages: [] });
        } catch {
          /* agota reintentos */
        }
        vi.unstubAllGlobals();
        return calls.length === 3 && calls.every(([a, w, r], i) => a === i + 1 && w > 0 && r === `HTTP ${status}`);
      }),
      { numRuns: 20 },
    );
  });
});

describe("openai-provider · streaming SSE", () => {
  // Construye un Response con cuerpo SSE a partir de líneas "data: {...}".
  function sseResponse(chunks: any[]): Response {
    const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(lines));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("emite cada chunk de content por streamHook y acumula tool_calls fragmentados", async () => {
    const json = JSON.stringify({ url: "https://example.com", n: 3 });
    const mid = Math.floor(json.length / 2);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          { choices: [{ delta: { content: "pensa" } }] },
          { choices: [{ delta: { content: "ndo" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "navigate", arguments: json.slice(0, mid) } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(mid) } }] } }] },
        ]),
      ),
    );
    const got: string[] = [];
    const c = new OpenAICompatClient(cfg({ label: "Groq" }), (chunk) => got.push(chunk), undefined, noSleep);
    const resp = await c.messages.create({ messages: [] });
    expect(got).toEqual(["pensa", "ndo"]); // streamHook por cada content no vacío, en orden
    const tu = resp.content.find((b: any) => b.type === "tool_use") as any;
    expect(tu.name).toBe("navigate");
    expect(tu.input).toEqual({ url: "https://example.com", n: 3 }); // reensamblado correcto
  });

  // Feature: end-to-end-validation-improvements, Property 11: streamHook se llama por cada content no vacío
  it("P11 · streamHook recibe cada chunk de content no vacío, en orden", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 8 }), async (contents) => {
        vi.stubGlobal("fetch", vi.fn(async () => sseResponse(contents.map((content) => ({ choices: [{ delta: { content } }] })))));
        const got: string[] = [];
        const c = new OpenAICompatClient(cfg({ label: "Groq" }), (ch) => got.push(ch), undefined, noSleep);
        await c.messages.create({ messages: [] });
        vi.unstubAllGlobals();
        return JSON.stringify(got) === JSON.stringify(contents);
      }),
      { numRuns: 20 },
    );
  });

  // Feature: end-to-end-validation-improvements, Property 12: acumulación de tool-call para cualquier fragmentación
  it("P12 · los argumentos de tool_call se reensamblan para cualquier fragmentación", async () => {
    await fc.assert(
      fc.asyncProperty(fc.record({ a: fc.integer(), b: fc.string() }), fc.array(fc.integer({ min: 1, max: 10 }), { minLength: 1, maxLength: 6 }), async (objIn, splits) => {
        const json = JSON.stringify(objIn);
        // parte el JSON en fragmentos según los puntos de corte
        const frags: string[] = [];
        let pos = 0;
        for (const s of splits) {
          frags.push(json.slice(pos, pos + s));
          pos += s;
        }
        if (pos < json.length) frags.push(json.slice(pos));
        const chunks = frags.map((f, i) => ({ choices: [{ delta: { tool_calls: [{ index: 0, ...(i === 0 ? { id: "t1", function: { name: "x", arguments: f } } : { function: { arguments: f } }) }] } }] }));
        vi.stubGlobal("fetch", vi.fn(async () => sseResponse(chunks)));
        const c = new OpenAICompatClient(cfg({ label: "Groq" }), () => {}, undefined, noSleep);
        const resp = await c.messages.create({ messages: [] });
        vi.unstubAllGlobals();
        const tu = resp.content.find((b: any) => b.type === "tool_use") as any;
        return JSON.stringify(tu?.input) === JSON.stringify(objIn);
      }),
      { numRuns: 30 },
    );
  });
});
