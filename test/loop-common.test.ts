import { describe, it, expect } from "vitest";
import { withDefaultHooks, NEXT_TASK_PREFIX, resolveProfileState, LoopMetrics } from "../src/agent/loop-common.js";
import { createAnthropic } from "../src/providers/anthropic-client.js";

describe("loop-common · helpers compartidos", () => {
  it("withDefaultHooks rellena no-ops seguros y respeta los provistos", async () => {
    const d = withDefaultHooks();
    expect(await d.confirmAction("x")).toBe(false);
    expect(await d.waitForHuman("x")).toBe("");
    const log = (_: string) => {};
    const custom = withDefaultHooks({ log, confirmAction: async () => true });
    expect(custom.log).toBe(log);
    expect(await custom.confirmAction("x")).toBe(true);
    expect(await custom.waitForHuman("x")).toBe(""); // el no provisto sigue siendo no-op
  });

  it("NEXT_TASK_PREFIX es estable (lo comparten ambos loops)", () => {
    expect(NEXT_TASK_PREFIX).toMatch(/misma sesión/i);
  });

  it("resolveProfileState: sin perfil no carga nada; con chrome usa userDataDir", async () => {
    const none = await resolveProfileState("chromium", undefined, undefined);
    expect(none).toEqual({ userDataDir: undefined, storageState: undefined, loaded: false });
    const chrome = await resolveProfileState("chrome", "miperfil", undefined);
    expect(chrome.loaded).toBe(true);
    expect(chrome.userDataDir).toMatch(/chrome-miperfil$/);
    expect(chrome.storageState).toBeUndefined();
  });
});

describe("loop-common · LoopMetrics", () => {
  it("cuenta llamadas y detecta bucle (firma repetida)", () => {
    const m = new LoopMetrics();
    m.recordCall("click", { ref: "v1:7" });
    m.recordCall("click", { ref: "v1:7" }); // idéntica → loopHit
    m.recordCall("type", { ref: "v1:8", text: "x" });
    expect(m.toolCalls).toBe(3);
    expect(m.loopHits).toBe(1);
  });

  it("cuenta errores y recuperaciones (éxito tras error)", () => {
    const m = new LoopMetrics();
    m.recordCall("click", {});
    m.recordError(); // falló
    m.recordCall("snapshot", {});
    m.recordSuccess(); // éxito tras error → recovery
    m.recordCall("snapshot", {});
    m.recordSuccess(); // éxito tras éxito → NO recovery
    expect(m.toolErrors).toBe(1);
    expect(m.recoveries).toBe(1);
  });

  it("acumula tokens y es asignable como NaviaMetrics", () => {
    const m = new LoopMetrics();
    m.addTokens(100, 20);
    m.addTokens(50, 10);
    m.steps = 5;
    expect(m.tokensIn).toBe(150);
    expect(m.tokensOut).toBe(30);
    expect(JSON.parse(JSON.stringify(m))).toMatchObject({ steps: 5, tokensIn: 150, tokensOut: 30 }); // serializa limpio (sin métodos)
  });
});

describe("anthropic-client · createAnthropic", () => {
  it("lanza un error claro si no hay API key", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => createAnthropic()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (prev) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it("crea el cliente cuando se pasa una key explícita", () => {
    const c = createAnthropic("sk-ant-test");
    expect(c).toBeTruthy();
    expect(typeof c.messages.create).toBe("function");
  });
});
