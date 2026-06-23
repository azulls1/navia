# Implementation Plan: coverage-parity-and-export

## Overview

Cinco bloques: cobertura del loop CLI (helpers + integración), tests directos de `dispatchTool`, tests del servidor MCP, y la feature de export CSV/NDJSON de `extract`. Se implementa de abajo a arriba: exposiciones/refactors de testabilidad y módulos puros primero, luego los tests, después el cableado del CLI, y al final el bump de versión y los checkpoints.

`fast-check` ya está instalado como devDependency (del spec anterior); no hace falta reinstalarlo.

---

## Tasks

- [x] 1. Exponer helpers puros del CLI_Loop
  - Añadir `export const __test = { extractJson, truncate, pruneTranscript };` al final de `src/agent/cli-agent.ts`, sin tocar `runViaCli`
  - Confirmar que `npm run typecheck` sigue verde (no debe haber unused)
  - _Requirements: 1.1_

- [x] 2. Tests de los helpers del CLI_Loop en `test/cli-agent.test.ts` (nuevo)
  - [x] 2.1 Unit: valla ```` ```json ````, prosa con JSON embebido, garbage→null, `truncate` por debajo/encima de `max`, `pruneTranscript` (conserva cabeza + última OBSERVACIÓN, elide anteriores, acota longitud)
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_
  - [x] 2.2 Property P1 — `extractJson` round-trip de objetos
    - **Property 1: extractJson parsea cualquier objeto JSON serializado**
    - `fc.object()` → `extractJson(JSON.stringify(o))` deep-equal `o`
    - Tag: `// Feature: coverage-parity-and-export, Property 1`
    - _Requirements: 1.2_
  - [x] 2.3 Property P2 — `extractJson` tolera prosa alrededor
    - **Property 2: extractJson recupera el objeto embebido entre texto sin llaves**
    - prefijo/sufijo `fc.string()` filtrado sin `{`/`}` → recupera `o`
    - Tag: `// Feature: coverage-parity-and-export, Property 2`
    - _Requirements: 1.4_
  - [x] 2.4 Property P3 — `truncate` acota la longitud
    - **Property 3: truncate(s,max) ≤ max+1 y es identidad si s.length ≤ max**
    - Tag: `// Feature: coverage-parity-and-export, Property 3`
    - _Requirements: 1.6_

- [x] 3. Test de integración del CLI_Loop en `test/cli-agent-integration.test.ts` (nuevo)
  - [x] 3.1 Infra Fake_CLI: helper que escribe el script `.mjs` temporal, fija `NAVIA_CLI_CMD`/`NAVIA_FAKECLI_SCRIPT`/`NAVIA_FAKECLI_COUNTER` y los limpia en `afterEach` (reset del contador incluido)
    - _Requirements: 2.1, 2.5_
  - [x] 3.2 Escenario "tool + done": acción `wait_for` luego `{"done":true,"summary":"…"}` → summary no vacío, steps ≥ 2, `toolCalls ≥ 1`
    - _Requirements: 2.2_
  - [x] 3.3 Escenario "anti-bucle": misma acción dos veces → `loopHits ≥ 1`
    - _Requirements: 2.3_
  - [x] 3.4 Escenario "max-steps": siempre tool, `maxSteps: 2` → `steps === 2`, summary `/m[aá]ximo/i`
    - _Requirements: 2.4, 2.6_
  - [x] 3.5 (Opcional) Property P4 — max-steps exacto para N en 1..3 (`fc.integer`, `numRuns: 2`)
    - **Property 4: el CLI_Loop termina en exactamente N pasos**
    - Tag: `// Feature: coverage-parity-and-export, Property 4`
    - _Requirements: 2.4_

- [x] 4. Checkpoint — `npm test` verde con R1+R2 (helpers + integración CLI). Ante dudas, preguntar al usuario.

- [x] 5. Tests directos de `dispatchTool` en `test/tools-dispatch.test.ts` (nuevo)
  - [x] 5.1 Implementar `FakeDriver` (superficie que usa `dispatchTool`, registro de llamadas) y los mocks de `ocrCaptcha` y `vault` (`vi.mock`, limpieza en `afterEach`)
    - _Requirements: 3.1–3.8_
  - [x] 5.2 AC1 origin-binding: mismatch → mensaje anti-phishing, sin escribir el valor
    - _Requirements: 3.1_
  - [x] 5.3 AC2/AC3 captcha: `off`+vacío→bloqueo sin click; `local`+OCR→rellena captcha y luego click (orden en `calls`)
    - _Requirements: 3.2, 3.3_
  - [x] 5.4 AC4/AC5 policy gates: `evaluate` con `allowEval:false`→mensaje, sin `driver.evaluate`; `screenshot` con `vision:false`→mensaje, sin `imageBase64`
    - _Requirements: 3.4, 3.5_
  - [x] 5.5 AC6/AC7 recuperación: secreto inexistente→texto "no hay secreto"; `click` que lanza→texto "La acción falló" + snapshot, sin propagar
    - _Requirements: 3.6, 3.7_
  - [x] 5.6 AC8 `confirm_action`: hook true→"APROBADO", false→"RECHAZADO"
    - _Requirements: 3.8_

- [x] 6. Refactor de testabilidad del MCP_Server + tests
  - [x] 6.1 En `src/mcp/server.ts`: exportar `EXCLUDED` y `buildMcpToolList(defs)`; `startMcpServer` usa `buildMcpToolList(TOOL_DEFINITIONS)` (resultado idéntico al map inline actual)
    - _Requirements: 4.1_
  - [x] 6.2 `test/mcp-server.test.ts` (nuevo): catálogo sin `EXCLUDED`; resto con `{name, description:string, inputSchema}`; cada nombre excluido ausente
    - _Requirements: 4.2, 4.3, 4.4_

- [x] 7. Exporter `src/agent/export.ts` (nuevo) + tests
  - [x] 7.1 Implementar `csvCell` (privada), `toCSV`, `toNDJSON`, `resultToRows` según el diseño
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6_
  - [x] 7.2 `test/export.test.ts` (nuevo) — unit: `resultToRows` (array / `{items:[…]}` / objeto plano); `toCSV` encabezado=unión de claves; celda con coma/comilla/salto entrecomillada; null→vacío; objeto→JSON
    - _Requirements: 5.1, 5.2, 5.3, 5.6_
  - [x] 7.3 Property P5 — CSV round-trip
    - **Property 5: el CSV emitido vuelve a parsear a las celdas originales (null→"", num→string)**
    - parser RFC-4180 mínimo en el test; Tag: `// Feature: coverage-parity-and-export, Property 5`
    - _Requirements: 5.2, 5.3_
  - [x] 7.4 Property P6 — escape CSV de strings arbitrarios
    - **Property 6: csvCell+parser reproduce cualquier string con comas/comillas/saltos**
    - Tag: `// Feature: coverage-parity-and-export, Property 6`
    - _Requirements: 5.3_
  - [x] 7.5 Property P7 — NDJSON round-trip
    - **Property 7: toNDJSON.split.filter(Boolean).map(JSON.parse) deep-equals rows**
    - `fc.array(fc.object())`; Tag: `// Feature: coverage-parity-and-export, Property 7`
    - _Requirements: 5.4_

- [x] 8. Cablear el Exporter en el CLI y la API pública
  - [x] 8.1 `src/cli.ts` subcomando `extract`: opciones `--format <json|csv|ndjson>` (default json) y `--out <archivo>`; usar `resultToRows`+`toCSV`/`toNDJSON`; `--out`→`writeFileSync`, si no→stdout; default json idéntico al actual
    - _Requirements: 5.5_
  - [x] 8.2 `src/index.ts`: re-exportar `toCSV`, `toNDJSON`, `resultToRows`
    - _Requirements: 5.7_

- [x] 9. Bump de versión a 0.28.0 (4 archivos)
  - `package.json`, `src/cli.ts` (`.version("0.28.0")`), `src/mcp/server.ts` (`version: "0.28.0"`), `server.json`
  - Verificar `test/version.test.ts` verde
  - _Requirements: (constraints)_

- [x] 10. Checkpoint final — gates verdes
  - `npm run typecheck` && `npm test` && `npm run build` todos verdes
  - Ante cualquier fallo, diagnosticar y corregir; preguntar al usuario si hay dudas de alcance

---

## Notes

- `fast-check` ya instalado (spec previo). Property tests tagueados `// Feature: coverage-parity-and-export, Property N`.
- R1/R4/R5 son refactors aditivos o módulos nuevos → riesgo bajo. R2 (Fake_CLI) y R3 (mocks ESM) son los de mayor cuidado.
- Bloques independientes: si R2 (integración CLI) resultara flaky en Windows, sus 3 escenarios unitarios (3.2–3.4) son mandatorios y P4 (3.5) es opcional.
- No se centraliza la versión (se mantiene el literal en `mcp/server.ts`) para no romper `version.test.ts` ni el flujo de release de `AGENTS.md`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "6.1", "7.1"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3", "2.4", "6.2", "7.2", "7.3", "7.4", "7.5"] },
    { "id": 2, "tasks": ["3.1", "5.1"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "3.5", "5.2", "5.3", "5.4", "5.5", "5.6"] },
    { "id": 4, "tasks": ["4"] },
    { "id": 5, "tasks": ["8.1", "8.2"] },
    { "id": 6, "tasks": ["9"] },
    { "id": 7, "tasks": ["10"] }
  ]
}
```
