# Design: coverage-parity-and-export

## Overview

Cinco bloques en su mayoría independientes. Los bloques 1–4 son cobertura/robustez (no cambian comportamiento de runtime salvo refactors de testabilidad que preservan la salida observable). El bloque 5 añade una feature aditiva. Orden de implementación: primero las exposiciones/refactors de testabilidad y los módulos puros, luego los tests, y por último el cableado del CLI y el bump de versión.

```
loop-common (sin cambios) ── usado por ambos loops
src/agent/cli-agent.ts   ── + export __test { extractJson, truncate, pruneTranscript }   (R1)
src/agent/tools.ts       ── dispatchTool (sin cambios)  ←── Fake_Driver en tests           (R3)
src/mcp/server.ts        ── + export buildMcpToolList(), EXCLUDED  (refactor testabilidad)  (R4)
src/agent/export.ts      ── NUEVO: toCSV, toNDJSON, resultToRows                            (R5)
src/cli.ts               ── extract: + --format / --out, usa el Exporter                    (R5)
src/index.ts             ── + re-export del Exporter                                        (R5)
```

---

## R1 — Helpers puros del CLI_Loop

`extractJson`, `truncate` y `pruneTranscript` ya existen en `cli-agent.ts` como funciones de módulo. El único cambio de producción es añadir al final, junto a las demás definiciones:

```ts
// Exporta helpers internos para tests unitarios (sin afectar el runtime de runViaCli).
export const __test = { extractJson, truncate, pruneTranscript };
```

Espejo exacto del patrón ya usado en `openai-provider.ts` (`export const __test = { … }`). Sin otros cambios.

**Tests** → `test/cli-agent.test.ts` (nuevo). Property tests con fast-check:
- **P1** `extractJson` round-trip: para cualquier objeto `fc.object()` serializado, `extractJson(JSON.stringify(o))` es deep-equal a `o`.
- **P2** `extractJson` tolera prosa alrededor: para cualquier objeto y prefijos/sufijos de texto sin llaves, `extractJson(pre + JSON.stringify(o) + post)` recupera `o`. (El prefijo/sufijo se genera con `fc.string()` filtrado para no contener `{`/`}`.)
- **P3** `truncate` acota: para cualquier `s` y `max ≥ 1`, `truncate(s,max).length ≤ max+1` y si `s.length ≤ max` entonces el resultado es exactamente `s`.
- Unit: valla de código ```` ```json ```` extraída; garbage → `null`; `pruneTranscript` conserva cabeza + última `OBSERVACIÓN`, elide las anteriores y acota la longitud.

---

## R2 — Integración del CLI_Loop (Fake_CLI)

El CLI_Provider, con `NAVIA_CLI_CMD` definido, hace: `run(parts[0], parts.slice(1), prompt /*stdin*/)` y devuelve `stdout.trim()`. Por tanto el Fake_CLI es un **programa que lee stdin (el prompt) y escribe en stdout la siguiente acción JSON programada**, manteniendo un contador entre invocaciones (un proceso nuevo por paso).

Mecanismo (sin binario externo, multiplataforma): el test escribe un script `.mjs` temporal y fija `NAVIA_CLI_CMD = "node <ruta-script>"`. El contador se persiste en un archivo temporal (`navia-fakecli-counter`) que el script lee/incrementa, y la secuencia de respuestas se pasa por una variable de entorno (`NAVIA_FAKECLI_SCRIPT`, un JSON array de acciones) que el test exporta.

```js
// fake-cli.mjs (escrito por el test en tmp)
import { readFileSync, writeFileSync } from "node:fs";
const seq = JSON.parse(process.env.NAVIA_FAKECLI_SCRIPT);
const counterFile = process.env.NAVIA_FAKECLI_COUNTER;
let n = 0; try { n = parseInt(readFileSync(counterFile, "utf8")) || 0; } catch {}
writeFileSync(counterFile, String(n + 1));
process.stdout.write(JSON.stringify(seq[Math.min(n, seq.length - 1)]));
```

> Nota: el CLI_Loop también llama a `cliComplete` para el validador post-tarea (`validateViaCli`) solo si `opts.validate` es true; los tests de integración del loop NO activan `validate`, así que cada paso del loop consume exactamente una respuesta del Fake_CLI.

**Tests** → `test/cli-agent-integration.test.ts` (nuevo). Escenarios espejo del loop API:
- tool + done → summary no vacío, steps ≥ 2, toolCalls ≥ 1.
- acción repetida → loopHits ≥ 1.
- siempre tool, `maxSteps: 2` → steps == 2, summary `/m[aá]ximo/i`.
- **P4** (opcional, `fc.integer({min:1,max:3})`): siempre tool → steps == N y summary contiene "máximo".

`afterEach` borra `NAVIA_CLI_CMD`, `NAVIA_FAKECLI_SCRIPT`, `NAVIA_FAKECLI_COUNTER` y resetea el archivo contador. Timeouts ≥ 60 s; `maxSteps ≤ 4`. Se usa `data:text/html,<h1>x</h1>` como `startUrl`.

---

## R3 — Tests directos de `dispatchTool` (Fake_Driver)

`dispatchTool(name, input, driver, hooks, policy)` solo usa un subconjunto de métodos del driver. El Fake_Driver implementa esa superficie y registra llamadas:

```ts
class FakeDriver {
  calls: Array<{ m: string; args: any[] }> = [];
  captcha = { present: false, empty: false, imgRef: "v1:img", inputRef: "v1:inp" };
  originByRef: Record<string, string> = {};
  throwOnClick = false;
  async detectTextCaptcha() { return this.captcha; }
  originForRef(ref: string) { return this.originByRef[ref] ?? "https://site.test"; }
  async type(ref: string, text: string) { this.calls.push({ m: "type", args: [ref, text] }); }
  async click(ref: string) { this.calls.push({ m: "click", args: [ref] }); if (this.throwOnClick) throw new Error("ref caduco"); }
  async screenshot(ref?: string) { this.calls.push({ m: "screenshot", args: [ref] }); return "BASE64PNG"; }
  async observe() { return { changed: true, snapshot: "Página: <snap>" }; }
  async snapshot() { return "Página: <snap>"; }
  async detectChallenge() { return null; }
  describeRef() { return null; }
  async evaluate(code: string) { this.calls.push({ m: "evaluate", args: [code] }); return []; }
  // … resto de métodos referenciados, como no-ops
}
```

- **Captcha/OCR**: `autoSolveCaptcha` llama a `ocrCaptcha(await driver.screenshot(imgRef))`. `ocrCaptcha` se importa de `captcha-ocr.ts`; para forzar un texto en el test se mockea el módulo con `vi.mock("../src/agent/captcha-ocr.js", …)` devolviendo `"ABC12"`. El caso `captcha:"off"` no necesita el mock (sale por el branch de bloqueo).
- **Origin binding**: `assertOriginAllowed` consulta `getSecretOrigins(key)` del vault. Se mockea `../src/secrets/vault.js` para devolver `["https://allowed.test"]` y un `getSecret` con valor, y se pone `originByRef[ref] = "https://evil.test"` → debe lanzar dentro de `fill_credential` y `wrapAction` lo convierte en texto "La acción falló: …anti-phishing…", sin escribir (no hay `type` con el valor en `calls`).
- **wrapAction recovery**: `throwOnClick = true` → el texto resultante contiene "La acción falló" y un snapshot.
- **Policy gates**: `evaluate` con `allowEval:false` y `screenshot` con `vision:false` salen por los guards al inicio de `dispatchTool` (no tocan el driver).

**Tests** → `test/tools-dispatch.test.ts` (nuevo). Cubren AC 1–8. Mocks con `vi.mock`/`vi.spyOn`, reseteados en `afterEach`.

---

## R4 — Testabilidad del MCP_Server

Refactor mínimo y sin cambio de comportamiento: extraer la construcción del catálogo a una función pura exportada y exportar `EXCLUDED`.

```ts
export const EXCLUDED = new Set(["confirm_action", "wait_for_human"]);

export function buildMcpToolList(defs: Anthropic.Tool[]) {
  return defs
    .filter((t) => !EXCLUDED.has(t.name))
    .map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.input_schema as Record<string, unknown> }));
}
```

`startMcpServer` pasa a usar `const tools = buildMcpToolList(TOOL_DEFINITIONS);` (idéntico resultado al map inline actual). No se toca la lógica de elicitation ni el transporte (probarlos requeriría un cliente MCP real; queda fuera de alcance).

**Tests** → `test/mcp-server.test.ts` (nuevo): `buildMcpToolList(TOOL_DEFINITIONS)` no incluye los `EXCLUDED`; incluye el resto con `{name, description:string, inputSchema}`; para cada nombre en `EXCLUDED`, ausente del catálogo.

---

## R5 — Exporter (CSV/NDJSON) + CLI

### `src/agent/export.ts` (nuevo, puro)

```ts
function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const head = cols.map(csvCell).join(",");
  const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
  return rows.length ? `${head}\n${body}` : head;
}

export function toNDJSON(rows: Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

export function resultToRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value as Record<string, unknown>[];
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const arr = entries.find(([, v]) => Array.isArray(v));
    if (entries.length === 1 && arr) return arr[1] as Record<string, unknown>[];
  }
  return [value as Record<string, unknown>];
}
```

Nota de diseño sobre el round-trip de NDJSON (AC 5.4): cada línea es exactamente `JSON.stringify(row)`, así que `JSON.parse(line)` reconstruye `row`. El `\n` final no produce línea vacía al filtrar `Boolean` antes de parsear en el test.

### CLI `navia extract`

Añadir a las opciones del subcomando `extract` en `src/cli.ts`:

```
--format <fmt>   json | csv | ndjson  (default json)
--out <archivo>  escribe el resultado en el archivo en vez de stdout
```

Tras obtener `data` de `extract(...)`:

```ts
let outStr: string;
if (format === "json") outStr = JSON.stringify(data, null, 2);
else {
  const rows = resultToRows(data);
  outStr = format === "csv" ? toCSV(rows) : toNDJSON(rows);
}
if (out) { writeFileSync(out, outStr, "utf8"); console.log(pc.green(`✓ Escrito ${rows?.length ?? ""} … en ${out}`)); }
else console.log(outStr);
```

El default (`json` a stdout) es idéntico al comportamiento actual → sin regresión.

### `src/index.ts`

```ts
export { toCSV, toNDJSON, resultToRows } from "./agent/export.js";
```

**Tests** → `test/export.test.ts` (nuevo). Property tests:
- **P5** CSV round-trip: para `fc.array(fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.constant(null))))`, parsear el CSV resultante (con un parser RFC-4180 mínimo del test) reproduce las celdas (normalizando null→"" y números→string).
- **P6** escape CSV: para cualquier string con comas/comillas/saltos, `csvCell` produce algo que el parser del test devuelve igual al original.
- **P7** NDJSON round-trip: para `fc.array(fc.object())`, `toNDJSON(rows).split("\n").filter(Boolean).map(JSON.parse)` es deep-equal a `rows`.
- Unit `resultToRows`: array→tal cual; `{items:[…]}`→`items`; objeto plano→`[obj]`.

---

## Versionado y release

- Bump `0.27.0 → 0.28.0` (minor: feature aditiva + cobertura) en los 4 archivos: `package.json`, `src/cli.ts` (`.version("0.28.0")`), `src/mcp/server.ts` (`version: "0.28.0"`), `server.json`.
- `test/version.test.ts` permanece verde (sigue siendo un match de string literal en cli.ts y server.ts).
- Flujo: typecheck + test + build verdes → commit a `main` → tag `v0.28.0` → GitHub Release → `npm publish`.

## Riesgos y mitigaciones

- **Fake_CLI lento/flaky en Windows** (spawn + shell): se usa `node <script>` directo, contador en archivo, `maxSteps ≤ 4` y timeouts ≥ 60 s. Si resultara inestable, el escenario P4 (property) puede reducirse a `numRuns: 2` o marcarse opcional; los 3 escenarios unitarios de R2 son los mandatorios.
- **Mock de `ocrCaptcha`/vault en R3**: usar `vi.mock` con rutas `.js` (ESM) y limpiar en `afterEach` para no contaminar otros tests del mismo archivo.
- **Acoplamiento R4 con `version.test.ts`**: NO se centraliza la versión (se mantiene el literal en server.ts) para no romper ese test ni el proceso de release documentado.
