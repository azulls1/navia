/**
 * Tests del Exporter (CSV RFC-4180 + NDJSON) y de resultToRows. Funciones puras → property-based.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { toCSV, toNDJSON, resultToRows } from "../src/agent/export.js";

/** Parser CSV mínimo RFC-4180 (campos entrecomillados con "" interno y saltos de línea). */
function parseCSV(text: string): string[][] {
  if (text === "") return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** Normaliza un valor como lo hace csvCell (null→"", objeto→JSON, resto→String). */
function norm(v: unknown): string {
  if (v == null) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

describe("export · resultToRows", () => {
  it("array → tal cual", () => {
    expect(resultToRows([{ a: 1 }, { a: 2 }])).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it("objeto con una sola propiedad array → ese array", () => {
    expect(resultToRows({ items: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });
  it("objeto plano (varias props) → envuelto en lista", () => {
    expect(resultToRows({ a: 1, b: 2 })).toEqual([{ a: 1, b: 2 }]);
  });
  it("objeto con una prop NO array → envuelto en lista", () => {
    expect(resultToRows({ a: 1 })).toEqual([{ a: 1 }]);
  });
});

describe("export · toCSV", () => {
  it("encabezado = unión ordenada de claves; celdas faltantes vacías", () => {
    expect(toCSV([{ a: 1, b: 2 }, { a: 3, c: 4 }])).toBe("a,b,c\n1,2,\n3,,4");
  });
  it("entrecomilla comas, comillas y saltos; null→vacío; objeto→JSON", () => {
    expect(toCSV([{ x: "a,b" }])).toBe('x\n"a,b"');
    expect(toCSV([{ x: 'he"llo' }])).toBe('x\n"he""llo"');
    expect(toCSV([{ x: "l1\nl2" }])).toBe('x\n"l1\nl2"');
    expect(toCSV([{ x: null }])).toBe("x\n");
    expect(toCSV([{ x: { k: 1 } }])).toBe('x\n"{""k"":1}"');
  });
  it("sin filas → solo (posible) encabezado vacío", () => {
    expect(toCSV([])).toBe("");
  });

  // Feature: coverage-parity-and-export, Property 5
  it("P5 · el CSV emitido vuelve a parsear a las celdas normalizadas", () => {
    const rowArb = fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.constant(null)), { minKeys: 1 });
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 1 }), (rows) => {
        const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
        const parsed = parseCSV(toCSV(rows));
        expect(parsed[0]).toEqual(cols); // encabezado
        for (let i = 0; i < rows.length; i++) {
          const expected = cols.map((c) => norm((rows[i] as Record<string, unknown>)[c]));
          expect(parsed[i + 1]).toEqual(expected);
        }
      }),
    );
  });

  // Feature: coverage-parity-and-export, Property 6
  it("P6 · cualquier string con comas/comillas/saltos round-trips", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const parsed = parseCSV(toCSV([{ v: s }]));
        expect(parsed[1][0]).toBe(s);
      }),
    );
  });
});

describe("export · toNDJSON", () => {
  it("una línea JSON por fila, terminada en \\n", () => {
    expect(toNDJSON([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
  });
  it("sin filas → cadena vacía", () => {
    expect(toNDJSON([])).toBe("");
  });

  // Feature: coverage-parity-and-export, Property 7
  it("P7 · split/filter/JSON.parse reproduce las filas", () => {
    const scalar = fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null));
    const rowArb = fc.dictionary(fc.string(), fc.oneof(scalar, fc.array(scalar)));
    fc.assert(
      fc.property(fc.array(rowArb), (rows) => {
        const back = toNDJSON(rows)
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        expect(back).toEqual(rows);
      }),
    );
  });
});
