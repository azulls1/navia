# Requirements Document

## Introduction

Este documento define **coverage-parity-and-export**, la siguiente ronda de madurez de Navia (navia-ai), que agrupa cuatro mejoras de calidad/fiabilidad y una feature de usuario, identificadas tras la pasada de cobertura del proyecto:

1. **Tests del loop CLI (helpers puros)** — `cli-agent.ts` tiene helpers puros sin testear (`extractJson`, `truncate`, `pruneTranscript`). Se exponen vía `__test` y se cubren con tests unitarios y de propiedad.
2. **Test de integración del loop CLI (paridad con el loop API)** — la red de integración actual (`test/loop-integration.test.ts`) solo cubre el loop API (`BrowserAgent`). El loop CLI (`runViaCli`) — el otro de los **dos loops que deben comportarse igual** — no tiene test de integración. Es el riesgo estructural nº1 que advierte `AGENTS.md`.
3. **Tests directos de `dispatchTool`** — la única fuente de verdad de la ejecución de herramientas (`src/agent/tools.ts`) solo está testeada indirectamente. La lógica crítica de **seguridad** (binding de origen anti-phishing, gate del captcha, recuperación de refs caducos, gates de política) carece de tests directos.
4. **Tests del servidor MCP** — `src/mcp/server.ts` no tiene tests; el filtrado de herramientas no expuestas (`confirm_action`/`wait_for_human`) y la forma del catálogo MCP no están verificados.
5. **Feature: export de `extract` a CSV/NDJSON** — `extract` solo devuelve JSON tipado en memoria; falta poder volcarlo a formatos tabulares para uso real (hojas de cálculo, pipelines).

**Glosario de términos**

- **API_Loop**: el loop de agente con tool-use nativo de Anthropic en `BrowserAgent.run()` (`src/agent/agent.ts`).
- **CLI_Loop**: el loop ReAct alternativo en `runViaCli` (`src/agent/cli-agent.ts`), que usa un binario de terminal como proveedor.
- **CLI_Provider**: `cliComplete` en `src/providers/cli-provider.ts`; con `NAVIA_CLI_CMD` definido ejecuta ese comando pasándole el prompt por stdin y devuelve su stdout.
- **dispatchTool**: la función en `src/agent/tools.ts` que ejecuta cada herramienta contra el `BrowserDriver`.
- **Fake_Driver**: un doble de pruebas que implementa solo la superficie de `BrowserDriver` que usa `dispatchTool`, sin lanzar un navegador real.
- **Fake_CLI**: un script Node invocado vía `NAVIA_CLI_CMD` que emite una secuencia programada de acciones JSON, el equivalente al `mockLLM` del API_Loop para el CLI_Loop.
- **MCP_Server**: `startMcpServer` en `src/mcp/server.ts`.
- **Extract**: la primitiva `extract` en `src/agent/extract.ts` (web → JSON tipado).
- **Exporter**: el módulo nuevo `src/agent/export.ts` con `toCSV` y `toNDJSON`.
- **Rows**: una lista de objetos planos (`Record<string, unknown>[]`) derivada del resultado de `extract` para exportar.

---

## Requirements

### Requirement 1: Tests del loop CLI — helpers puros

**User Story:** Como desarrollador de Navia, quiero tests unitarios y de propiedad sobre los helpers puros del CLI_Loop, para que el parsing de la respuesta del modelo y la poda del historial no se rompan en silencio al refactorizar.

#### Acceptance Criteria

1. THE CLI_Loop module (`src/agent/cli-agent.ts`) SHALL exportar un objeto `__test` que incluya `extractJson`, `truncate` y `pruneTranscript`, sin cambiar el comportamiento de runtime de `runViaCli`.
2. WHEN `extractJson` recibe una cadena que es exactamente un objeto JSON válido, THEN SHALL devolver un objeto profundamente igual al original.
3. WHEN `extractJson` recibe un objeto JSON envuelto en una valla de código (```` ```json … ``` ````), THEN SHALL extraer y parsear el contenido de la valla.
4. WHEN `extractJson` recibe prosa con un objeto JSON embebido (texto antes y/o después), THEN SHALL recuperar el objeto recortando desde el primer `{` hasta el último `}`.
5. WHEN `extractJson` recibe una cadena sin JSON parseable (o vacía), THEN SHALL devolver `null`.
6. WHEN `truncate(s, max)` recibe `s` con longitud menor o igual a `max`, THEN SHALL devolver `s` sin cambios; WHEN la longitud es mayor que `max`, THEN SHALL devolver una cadena que termina en `…` y cuya longitud es menor o igual a `max + 1`.
7. WHEN `pruneTranscript` recibe un transcript con varias líneas `OBSERVACIÓN:` largas, THEN SHALL conservar intacta SOLO la última observación, elidir las observaciones largas anteriores, y conservar siempre el primer elemento (la línea `TAREA:`).
8. WHEN `pruneTranscript` recibe un transcript con más de `keepTail + 1` elementos, THEN el transcript resultante SHALL tener una longitud acotada (cabeza + marcador de elisión + los `keepTail` últimos) y SHALL conservar el primer y el último elemento originales.

---

### Requirement 2: Test de integración del loop CLI (paridad con el API)

**User Story:** Como desarrollador de Navia, quiero un test de integración del CLI_Loop equivalente al del API_Loop, para que ambos loops queden bajo la misma red de seguridad y no diverjan en comportamiento observable (métricas, terminación, anti-bucle).

#### Acceptance Criteria

1. THE Integration suite del CLI_Loop SHALL ejercitar `runNavia({ provider: "claude-cli", … })` (o `runViaCli`) contra un documento `data:text/html,…` con un navegador headless **real** y un Fake_CLI definido vía `NAVIA_CLI_CMD`.
2. WHEN el Fake_CLI emite una acción de herramienta válida seguida de un `{"done":true,"summary":…}`, THEN the suite SHALL verificar que `NaviaResult.summary` no está vacío, que `NaviaResult.steps` es mayor o igual a 2 y que `metrics.toolCalls` es mayor o igual a 1.
3. WHEN el Fake_CLI emite dos veces consecutivas la misma acción (misma firma nombre+args), THEN the suite SHALL verificar que `metrics.loopHits` es mayor o igual a 1.
4. WHEN el Fake_CLI emite siempre una acción de herramienta (nunca `done`) y se fija `maxSteps`, THEN the suite SHALL verificar que `NaviaResult.steps` es igual a `maxSteps` y que `NaviaResult.summary` contiene el mensaje de máximo de pasos.
5. THE suite SHALL fijar `NAVIA_CLI_CMD` (y las variables que necesite el Fake_CLI) antes de cada test y restaurarlas/eliminarlas en `afterEach`, sin requerir ningún binario externo instalado.
6. FOR ALL escenarios, THE suite SHALL usar `maxSteps` menor o igual a 4 y un timeout por test de al menos 60 000 ms (cada caso lanza un navegador real).

---

### Requirement 3: Tests directos de `dispatchTool` con Fake_Driver

**User Story:** Como mantenedor de Navia, quiero tests directos sobre `dispatchTool` con un Fake_Driver, para que la lógica de seguridad y de recuperación quede fijada sin depender de un navegador real ni de un LLM.

#### Acceptance Criteria

1. WHEN se invoca `fill_credential` con un secreto que tiene orígenes permitidos (binding) y el origen real del ref NO coincide, THEN `dispatchTool` SHALL no escribir el valor en el campo y el resultado SHALL contener un mensaje anti-phishing identificando el secreto y el origen.
2. WHEN se invoca `click` con `captcha: "off"` y el Fake_Driver reporta un captcha de imagen vacío presente, THEN `dispatchTool` SHALL devolver un mensaje de bloqueo que guíe a `wait_for_human` y NO SHALL ejecutar el click.
3. WHEN se invoca `click` con `captcha: "local"`, hay un captcha de imagen vacío y el OCR resuelve un texto, THEN `dispatchTool` SHALL rellenar el campo del captcha antes de ejecutar el click (el Fake_Driver registra ambas llamadas en orden).
4. WHEN se invoca `evaluate` con la política `allowEval: false`, THEN `dispatchTool` SHALL devolver un mensaje indicando que la herramienta está deshabilitada y NO SHALL llamar a `driver.evaluate`.
5. WHEN se invoca `screenshot` con la política `vision: false`, THEN `dispatchTool` SHALL devolver el mensaje que indica que no se pueden ver imágenes y NO SHALL devolver `imageBase64`.
6. WHEN se invoca `fill_credential` con una clave de secreto inexistente, THEN el resultado de `dispatchTool` SHALL contener un mensaje indicando que no hay tal secreto (recuperación vía `wrapAction`, sin propagar excepción).
7. WHEN una acción basada en ref (p. ej. `click`) lanza dentro de `wrapAction`, THEN `dispatchTool` SHALL devolver un texto que contenga la indicación de fallo de la acción y un snapshot fresco re-leído, sin propagar la excepción al llamador.
8. WHEN se invoca `confirm_action`, THEN `dispatchTool` SHALL devolver "APROBADO…" si el hook `confirmAction` resuelve `true` y "RECHAZADO…" si resuelve `false`.

---

### Requirement 4: Tests del servidor MCP

**User Story:** Como usuario de Navia vía MCP (Claude Desktop/Code/Cursor), quiero que el catálogo de herramientas que expone el MCP_Server esté verificado, para que las herramientas que asumen TTY no se ofrezcan y el resto se exponga con la forma correcta.

#### Acceptance Criteria

1. THE MCP_Server module SHALL exponer una función pura `buildMcpToolList(defs)` que filtre el conjunto `EXCLUDED` (`confirm_action`, `wait_for_human`) y mapee cada herramienta restante a la forma MCP `{ name, description, inputSchema }`. Esta refactorización NO SHALL cambiar las herramientas que `startMcpServer` ofrece en runtime.
2. WHEN se llama `buildMcpToolList(TOOL_DEFINITIONS)`, THEN el resultado NO SHALL contener `confirm_action` ni `wait_for_human`.
3. WHEN se llama `buildMcpToolList(TOOL_DEFINITIONS)`, THEN FOR ALL las demás herramientas de `TOOL_DEFINITIONS` el resultado SHALL incluir una entrada con su `name`, una `description` de tipo string y un `inputSchema` igual a su `input_schema`.
4. THE conjunto `EXCLUDED` SHALL exportarse para que el test verifique que cada nombre excluido está efectivamente ausente del catálogo.

---

### Requirement 5: Export de `extract` a CSV/NDJSON

**User Story:** Como usuario de Navia, quiero exportar el resultado de `extract` a CSV o NDJSON (a stdout o a un archivo), para usar los datos extraídos en hojas de cálculo o pipelines sin post-procesar el JSON a mano.

**Definición de formatos:**
- **CSV** sigue RFC 4180: separador coma, fin de línea `\n`, un campo se entrecomilla con `"` si contiene coma, comilla doble o salto de línea, y las comillas internas se duplican (`"` → `""`).
- **NDJSON**: una línea de JSON por fila (`JSON.stringify(row)` + `\n`).

#### Acceptance Criteria

1. THE Exporter module (`src/agent/export.ts`) SHALL exportar `toCSV(rows: Record<string, unknown>[], columns?: string[]): string` y `toNDJSON(rows: Record<string, unknown>[]): string`, ambas funciones puras (sin I/O).
2. WHEN `toCSV` recibe `rows` sin `columns`, THEN SHALL derivar el encabezado como la unión ordenada de las claves presentes en las filas (primera aparición), y emitir una fila de encabezado seguida de una fila por objeto.
3. WHEN un valor de celda contiene coma, comilla doble o salto de línea, THEN `toCSV` SHALL entrecomillarlo y duplicar las comillas internas; WHEN un valor es `null` o `undefined`, THEN SHALL emitir una celda vacía; WHEN un valor es un objeto o array, THEN SHALL emitir su `JSON.stringify`.
4. WHEN `toNDJSON` recibe `rows`, THEN SHALL devolver una cadena con una línea `JSON.stringify(row)` por fila terminada en `\n`, tal que cada línea no vacía vuelve a parsear (`JSON.parse`) a la fila original.
5. THE CLI `navia extract` SHALL aceptar `--format <json|csv|ndjson>` (default `json`) y `--out <archivo>` (opcional); con `--out` SHALL escribir el resultado en el archivo, y sin `--out` SHALL imprimirlo por stdout. El comportamiento por defecto (`json` a stdout) SHALL mantenerse idéntico al actual.
6. THE Exporter SHALL incluir un helper `resultToRows(value): Record<string, unknown>[]` que convierta el resultado de `extract` en `Rows`: si es un array de objetos lo usa tal cual; si es un objeto con exactamente una propiedad de tipo array, usa ese array; en otro caso, envuelve el valor en una lista de un elemento.
7. THE biblioteca pública (`src/index.ts`) SHALL re-exportar `toCSV`, `toNDJSON` y `resultToRows` sin romper ninguna firma exportada existente.

---

## Non-functional / constraints

- TypeScript estricto (`noUnusedLocals`/`noUnusedParameters` ON); sin `any` salvo lo inevitable.
- No romper la API pública de `src/index.ts` (solo cambios aditivos).
- Centralizar, no duplicar: helpers compartidos en `loop-common.ts`/`config.ts`.
- Gates verdes antes de commitear: `npm run typecheck`, `npm test`, `npm run build`.
- Bump de versión a `0.28.0` tocando los 4 archivos (`package.json`, `src/cli.ts`, `src/mcp/server.ts`, `server.json`); `test/version.test.ts` debe seguir verde.
