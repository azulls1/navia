import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { validateConfig } from "../src/config.js";

describe("config · validateConfig (esquema)", () => {
  it("acepta una config válida y conserva los campos conocidos", () => {
    const c = validateConfig({ model: "claude-sonnet-4-6", browser: "chromium", provider: "openai", workspace: true, profile: "p" });
    expect(c).toEqual({ model: "claude-sonnet-4-6", browser: "chromium", provider: "openai", workspace: true, profile: "p" });
  });

  it("rechaza model no-string, browser/provider inválidos y workspace de tipo erróneo", () => {
    expect(() => validateConfig({ model: 42 })).toThrow(/model/);
    expect(() => validateConfig({ browser: "safari" })).toThrow(/browser.*safari|safari.*browser/);
    expect(() => validateConfig({ provider: "gemini" })).toThrow(/provider/);
    expect(() => validateConfig({ workspace: 42 })).toThrow(/workspace/);
  });

  it("ignora campos desconocidos (compatibilidad hacia adelante)", () => {
    const c = validateConfig({ model: "m", futuro: 123, otro: { x: 1 } });
    expect(c).toEqual({ model: "m" });
  });

  it("rechaza una raíz que no es objeto plano (null, array, primitivo)", () => {
    for (const bad of [null, [1, 2], 42, true, "x"]) expect(() => validateConfig(bad)).toThrow();
  });

  // Feature: end-to-end-validation-improvements, Property 5: validateConfig rechaza model no-string
  it("P5 · rechaza cualquier model que no sea string", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.boolean(), fc.array(fc.string()), fc.constant(null)), (model) => {
        try {
          validateConfig({ model });
          return false;
        } catch (e) {
          return (e as Error).message.includes("model");
        }
      }),
    );
  });

  // Feature: end-to-end-validation-improvements, Property 6: validateConfig rechaza browsers inválidos
  it("P6 · rechaza cualquier browser fuera del conjunto válido (mensaje con campo y valor)", () => {
    const valid = new Set(["chromium", "chrome", "firefox", "patchright"]);
    fc.assert(
      fc.property(
        fc.string().filter((s) => !valid.has(s)),
        (browser) => {
          try {
            validateConfig({ browser });
            return false;
          } catch (e) {
            const m = (e as Error).message;
            return m.includes("browser") && m.includes(browser);
          }
        },
      ),
    );
  });

  // Feature: end-to-end-validation-improvements, Property 7: validateConfig rechaza providers inválidos
  it("P7 · rechaza cualquier provider fuera del conjunto válido", () => {
    const valid = new Set(["auto", "api", "claude-cli", "openai"]);
    fc.assert(
      fc.property(
        fc.string().filter((s) => !valid.has(s)),
        (provider) => {
          try {
            validateConfig({ provider });
            return false;
          } catch (e) {
            return (e as Error).message.includes("provider");
          }
        },
      ),
    );
  });

  // Feature: end-to-end-validation-improvements, Property 8: validateConfig rechaza workspace no-bool no-string
  it("P8 · rechaza workspace que no sea boolean ni string", () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer(), fc.constant(null), fc.array(fc.string())), (workspace) => {
        try {
          validateConfig({ workspace });
          return false;
        } catch (e) {
          return (e as Error).message.includes("workspace");
        }
      }),
    );
  });

  // Feature: end-to-end-validation-improvements, Property 9: validateConfig elimina campos desconocidos
  it("P9 · solo devuelve claves conocidas", () => {
    const known = new Set(["model", "browser", "provider", "workspace", "profile"]);
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), (dict) => {
        let out: any;
        try {
          out = validateConfig({ ...dict, model: "m" });
        } catch {
          return true; // si algún campo conocido vino con tipo inválido, lanzar es correcto
        }
        return Object.keys(out).every((k) => known.has(k));
      }),
    );
  });

  // Feature: end-to-end-validation-improvements, Property 10: validateConfig rechaza raíces no-objeto
  it("P10 · rechaza cualquier raíz que no sea objeto plano", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(null), fc.array(fc.anything()), fc.integer(), fc.boolean(), fc.string()), (root) => {
        try {
          validateConfig(root);
          return false;
        } catch {
          return true;
        }
      }),
    );
  });
});
