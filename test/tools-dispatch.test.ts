/**
 * Tests DIRECTOS de dispatchTool con un Fake_Driver (sin navegador) y mocks de OCR/vault.
 * Fijan la lógica de seguridad y recuperación: binding de origen (anti-phishing), gate del
 * captcha, gates de política (eval/visión), errores de secreto y recuperación de refs caducos.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocks de los módulos que dispatchTool consume para I/O sensible.
vi.mock("../src/agent/captcha-ocr.js", () => ({ ocrCaptcha: vi.fn(async () => "") }));
vi.mock("../src/secrets/vault.js", () => ({
  getSecret: vi.fn(async () => null),
  getTotpSecret: vi.fn(async () => null),
  getSecretOrigins: vi.fn(async () => null),
}));

import { dispatchTool } from "../src/agent/tools.js";
import type { AgentHooks } from "../src/agent/tools.js";
import type { BrowserDriver } from "../src/browser/driver.js";
import { ocrCaptcha } from "../src/agent/captcha-ocr.js";
import { getSecret, getSecretOrigins } from "../src/secrets/vault.js";

interface Captcha {
  present: boolean;
  empty: boolean;
  imgRef?: string;
  inputRef?: string;
}

/** Doble de pruebas: solo la superficie que usa dispatchTool, con registro de llamadas. */
class FakeDriver {
  calls: { m: string; args: unknown[] }[] = [];
  captcha: Captcha = { present: false, empty: false, imgRef: "v1:img", inputRef: "v1:inp" };
  originByRef: Record<string, string> = {};
  throwOnClick = false;
  async detectTextCaptcha(): Promise<Captcha> { return this.captcha; }
  originForRef(ref: string): string { return this.originByRef[ref] ?? "https://site.test"; }
  async type(ref: string, text: string): Promise<void> { this.calls.push({ m: "type", args: [ref, text] }); }
  async click(ref: string): Promise<void> {
    this.calls.push({ m: "click", args: [ref] });
    if (this.throwOnClick) throw new Error("ref caduco");
  }
  async screenshot(ref?: string): Promise<string> { this.calls.push({ m: "screenshot", args: [ref] }); return "PNGBASE64"; }
  async observe(): Promise<{ changed: boolean; snapshot: string }> { return { changed: true, snapshot: "contenido de la página" }; }
  async snapshot(): Promise<string> { return "contenido de la página"; }
  async detectChallenge(): Promise<string | null> { return null; }
  describeRef(): null { return null; }
  async evaluate(code: string): Promise<unknown> { this.calls.push({ m: "evaluate", args: [code] }); return []; }
}

const hooks = (over?: Partial<AgentHooks>): AgentHooks => ({
  confirmAction: async () => false,
  waitForHuman: async () => "",
  log: () => {},
  ...over,
});

const asDriver = (f: FakeDriver): BrowserDriver => f as unknown as BrowserDriver;
const types = (f: FakeDriver) => f.calls.filter((c) => c.m === "type");

beforeEach(() => {
  vi.mocked(ocrCaptcha).mockReset().mockResolvedValue("");
  vi.mocked(getSecret).mockReset().mockResolvedValue(null as never);
  vi.mocked(getSecretOrigins).mockReset().mockResolvedValue(null as never);
});

describe("dispatchTool · seguridad y recuperación", () => {
  it("AC1 · binding de origen: rechazo anti-phishing sin escribir el secreto", async () => {
    const f = new FakeDriver();
    f.originByRef["v1:pwd"] = "https://evil.test";
    vi.mocked(getSecret).mockResolvedValue("supersecret" as never);
    vi.mocked(getSecretOrigins).mockResolvedValue(["https://allowed.test"] as never);
    const r = await dispatchTool("fill_credential", { ref: "v1:pwd", key: "shop.pw" }, asDriver(f), hooks(), {});
    expect(r.text).toContain("anti-phishing");
    expect(types(f).filter((c) => c.args[1] === "supersecret")).toHaveLength(0);
  });

  it("AC2 · captcha off: bloquea el submit y no hace click", async () => {
    const f = new FakeDriver();
    f.captcha = { present: true, empty: true, imgRef: "v1:img", inputRef: "v1:inp" };
    const r = await dispatchTool("click", { ref: "v1:btn" }, asDriver(f), hooks(), { captcha: "off" });
    expect(r.text).toContain("OCR automático está desactivado");
    expect(f.calls.find((c) => c.m === "click")).toBeUndefined();
  });

  it("AC3 · captcha local: resuelve con OCR y luego hace click (en orden)", async () => {
    const f = new FakeDriver();
    f.captcha = { present: true, empty: true, imgRef: "v1:img", inputRef: "v1:inp" };
    vi.mocked(ocrCaptcha).mockResolvedValue("ABC12");
    await dispatchTool("click", { ref: "v1:btn" }, asDriver(f), hooks(), { captcha: "local" });
    expect(f.calls.map((c) => c.m)).toEqual(["screenshot", "type", "click"]);
    expect(types(f)[0].args).toEqual(["v1:inp", "ABC12"]);
  });

  it("AC4 · evaluate deshabilitado por política no toca el driver", async () => {
    const f = new FakeDriver();
    const r = await dispatchTool("evaluate", { code: "return 1" }, asDriver(f), hooks(), { allowEval: false });
    expect(r.text).toContain("deshabilitada");
    expect(f.calls.find((c) => c.m === "evaluate")).toBeUndefined();
  });

  it("AC5 · screenshot sin visión no devuelve imagen", async () => {
    const r = await dispatchTool("screenshot", {}, asDriver(new FakeDriver()), hooks(), { vision: false });
    expect(r.text).toContain("No puedes ver imágenes");
    expect(r.imageBase64).toBeUndefined();
  });

  it("AC6 · fill_credential con secreto inexistente reporta el error (sin propagar)", async () => {
    const r = await dispatchTool("fill_credential", { ref: "v1:pwd", key: "no.existe" }, asDriver(new FakeDriver()), hooks(), {});
    expect(r.text).toContain("No hay un secreto");
  });

  it("AC7 · una acción que lanza se recupera con snapshot fresco (sin propagar)", async () => {
    const f = new FakeDriver();
    f.throwOnClick = true;
    const r = await dispatchTool("click", { ref: "v1:btn" }, asDriver(f), hooks(), {});
    expect(r.text).toContain("La acción falló");
    expect(r.text).toContain("contenido de la página");
  });

  it("AC8 · confirm_action refleja la decisión humana", async () => {
    const ok = await dispatchTool("confirm_action", { description: "borrar" }, asDriver(new FakeDriver()), hooks({ confirmAction: async () => true }), {});
    expect(ok.text).toContain("APROBADO");
    const no = await dispatchTool("confirm_action", { description: "borrar" }, asDriver(new FakeDriver()), hooks({ confirmAction: async () => false }), {});
    expect(no.text).toContain("RECHAZADO");
  });
});
