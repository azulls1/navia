/**
 * Tests de los helpers PUROS del loop CLI (cli-agent.ts), expuestos vía __test:
 * parsing tolerante de la respuesta del modelo (extractJson), recorte (truncate) y poda del
 * historial (pruneTranscript). Sin navegador ni proceso externo.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { __test } from "../src/agent/cli-agent.js";

const { extractJson, truncate, pruneTranscript } = __test;

// Generador JSON-safe (round-trip exacto por JSON.parse/stringify).
const jsonScalar = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
const jsonDict = fc.dictionary(fc.string(), jsonScalar);

describe("cli-agent · extractJson", () => {
  it("parsea un objeto JSON directo", () => {
    expect(extractJson('{"tool":"snapshot","args":{}}')).toEqual({ tool: "snapshot", args: {} });
  });

  it("extrae JSON de una valla de código ```json", () => {
    expect(extractJson('```json\n{"done":true,"summary":"ok"}\n```')).toEqual({ done: true, summary: "ok" });
  });

  it("recupera el objeto embebido entre prosa", () => {
    expect(extractJson('Claro, aquí tienes:\n{"tool":"click","args":{"ref":"v1:2"}}\n¡listo!')).toEqual({
      tool: "click",
      args: { ref: "v1:2" },
    });
  });

  it("devuelve null si no hay JSON parseable", () => {
    expect(extractJson("no hay json aquí")).toBeNull();
    expect(extractJson("")).toBeNull();
  });

  // Feature: coverage-parity-and-export, Property 1
  it("P1 · round-trip de cualquier objeto JSON serializado", () => {
    fc.assert(
      fc.property(jsonDict, (o) => {
        expect(extractJson(JSON.stringify(o))).toEqual(o);
      }),
    );
  });

  // Feature: coverage-parity-and-export, Property 2
  it("P2 · recupera el objeto embebido entre texto sin llaves", () => {
    const noBraces = fc.string().map((s) => s.replace(/[{}]/g, ""));
    fc.assert(
      fc.property(jsonDict, noBraces, noBraces, (o, pre, post) => {
        expect(extractJson(pre + JSON.stringify(o) + post)).toEqual(o);
      }),
    );
  });
});

describe("cli-agent · truncate", () => {
  it("no toca cadenas dentro del límite", () => {
    expect(truncate("hola", 10)).toBe("hola");
  });
  it("recorta y añade … al pasarse", () => {
    const r = truncate("abcdefghij", 4);
    expect(r).toBe("abcd…");
    expect(r.length).toBe(5);
  });

  // Feature: coverage-parity-and-export, Property 3
  it("P3 · longitud ≤ max+1 y es identidad si cabe", () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 60 }), (s, max) => {
        const r = truncate(s, max);
        expect(r.length).toBeLessThanOrEqual(max + 1);
        if (s.length <= max) expect(r).toBe(s);
      }),
    );
  });
});

describe("cli-agent · pruneTranscript", () => {
  it("conserva la cabeza y SOLO la última observación; elide las anteriores largas", () => {
    const longObs = (tag: string) => `OBSERVACIÓN: ${tag}${"x".repeat(300)}`;
    const t = ["TAREA: hacer algo", longObs("a"), longObs("b"), longObs("c")];
    pruneTranscript(t);
    expect(t[0]).toBe("TAREA: hacer algo");
    expect(t[1]).toBe("OBSERVACIÓN: [elidida; usa snapshot si necesitas releer ese estado]");
    expect(t[2]).toBe("OBSERVACIÓN: [elidida; usa snapshot si necesitas releer ese estado]");
    expect(t[3].length).toBeGreaterThan(200); // la última se mantiene intacta
  });

  it("acota la cola dejando cabeza + marcador + últimos keepTail", () => {
    const t = ["TAREA: x", ...Array.from({ length: 30 }, (_, i) => `ACCIÓN ${i}`)];
    const last = t[t.length - 1];
    pruneTranscript(t, 20);
    expect(t.length).toBe(22); // cabeza + marcador + 20
    expect(t[0]).toBe("TAREA: x");
    expect(t[1]).toBe("(… historial antiguo elidido …)");
    expect(t[t.length - 1]).toBe(last);
  });
});
