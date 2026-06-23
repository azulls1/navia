/**
 * Exporta el resultado de `extract` (web → JSON tipado) a formatos tabulares: CSV (RFC 4180)
 * y NDJSON. Funciones PURAS (sin I/O) → fáciles de testear; el CLI decide stdout vs archivo.
 */

/** Serializa una celda CSV: null/undefined → vacío; objeto/array → JSON; entrecomilla si hace falta. */
function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // RFC 4180: si contiene coma, comilla doble o salto de línea, se entrecomilla y se duplican las comillas.
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Convierte una lista de objetos planos a CSV. Sin `columns`, el encabezado es la unión ordenada
 * de las claves (primera aparición). Devuelve solo el encabezado si no hay filas.
 */
export function toCSV(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const head = cols.map(csvCell).join(",");
  if (!rows.length) return head;
  const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
  return `${head}\n${body}`;
}

/** Convierte una lista de objetos a NDJSON: una línea `JSON.stringify(row)` por fila. */
export function toNDJSON(rows: Record<string, unknown>[]): string {
  return rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
}

/**
 * Normaliza el resultado de `extract` a filas exportables:
 *  - array → tal cual
 *  - objeto con EXACTAMENTE una propiedad array (p.ej. `{ items: [...] }`) → ese array
 *  - cualquier otro caso → el valor envuelto en una lista de un elemento
 */
export function resultToRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const arr = entries.find(([, v]) => Array.isArray(v));
    if (entries.length === 1 && arr) return arr[1] as Record<string, unknown>[];
  }
  return [value as Record<string, unknown>];
}
