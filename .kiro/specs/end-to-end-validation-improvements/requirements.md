# Requirements Document

## Introduction

Este documento define los requisitos para **end-to-end-validation-improvements**, un conjunto de mejoras de calidad y fiabilidad para Navia (navia-ai). Las mejoras cubren cuatro áreas identificadas en el análisis del código:

1. **Tests de integración del flujo principal** — cobertura del ciclo completo `runNavia → BrowserAgent.run → dispatchTool → BrowserDriver` con escenarios adicionales al test de integración básico ya existente.
2. **Retry con backoff exponencial** en `OpenAICompatClient` — sustituir el backoff lineal actual (`800ms × intento`) por exponencial con jitter para distribuir la carga en errores de tasa.
3. **Validación del esquema de config** — `~/.navia/config.json` actualmente se acepta sin validar campos ni tipos; se debe rechazar con mensajes claros.
4. **Streaming de respuesta en el CLI** — emitir tokens en tiempo real conforme llegan del LLM en lugar de esperar al turno completo, mejorando la percepción de progreso.

**Glosario de términos**

- **Agent_Loop**: El bucle principal de razonamiento y acción en `BrowserAgent.run()` (archivo `src/agent/agent.ts`).
- **BrowserDriver**: La capa de "manos" sobre Playwright/CDP que ejecuta acciones en el navegador (`src/browser/driver.ts`).
- **CLI_Runner**: El módulo `runViaCli` en `src/agent/cli-agent.ts`, loop alternativo usando un binario de terminal como proveedor LLM.
- **Config_Loader**: Las funciones `loadConfigSync` y `saveConfig` en `src/config.ts`.
- **Config_Schema**: El contrato de tipos válidos para `~/.navia/config.json`, definido por la interfaz `NaviaConfig`.
- **dispatchTool**: La función en `src/agent/tools.ts` que despacha herramientas hacia el `BrowserDriver`.
- **Integration_Suite**: El conjunto de tests de integración del loop de agente en `test/loop-integration.test.ts`.
- **LLM_Mock**: Servidor HTTP local que simula respuestas del LLM para tests de integración sin coste ni red externa.
- **NaviaResult**: El tipo de retorno de `runNavia`, que incluye `summary`, `steps` y `metrics`.
- **OpenAICompatClient**: El cliente adaptador para endpoints OpenAI-compatible en `src/providers/openai-provider.ts`.
- **Retry_Policy**: El conjunto de reglas que gobiernan reintentos ante errores transitorios (429, 5xx) en `OpenAICompatClient`.
- **Stream_Hook**: El callback opcional `hooks.log` que el Agent_Loop llama con mensajes de progreso en tiempo real.
- **Token_Stream**: La API de streaming de `/v1/chat/completions` (Server-Sent Events con `data: {...}`) que devuelven los endpoints OpenAI-compatible.

---

## Requirements

### Requirement 1: Tests de integración del flujo completo

**User Story:** Como desarrollador de Navia, quiero tests de integración que cubran los escenarios clave del ciclo `runNavia → BrowserAgent.run → dispatchTool → BrowserDriver`, para que refactorizaciones del núcleo del loop no rompan el comportamiento observable sin que los tests lo detecten.

#### Acceptance Criteria

1. WHEN el Agent_Loop ejecuta al menos una tool exitosa seguida de una tool que lanza un error de JavaScript (capturado por el loop, no propagado), THEN the Integration_Suite SHALL verificar que `metrics.toolErrors` es mayor que cero y que `metrics.recoveries` es igual a cero (error sin éxito posterior en la misma corrida de prueba).

2. WHEN el Agent_Loop recibe del LLM_Mock una respuesta cuyo `finish_reason` es `"length"` (respuesta truncada), THEN the Integration_Suite SHALL verificar que `NaviaResult.metrics.toolErrors` no aumenta, que el loop continúa al siguiente turno, y que `NaviaResult.steps` es mayor o igual a 2.

3. WHEN el Agent_Loop alcanza el límite de pasos `maxSteps`, THEN the Integration_Suite SHALL verificar que `NaviaResult.summary` contiene el mensaje de máximo de pasos y que `NaviaResult.steps` es igual a `maxSteps`.

4. WHEN el LLM_Mock devuelve el mismo tool call dos veces consecutivas (firma idéntica: mismo nombre e input), THEN the Integration_Suite SHALL verificar que `NaviaResult.metrics.loopHits` es mayor o igual a uno.

5. WHEN el Agent_Loop ejecuta las tools `navigate` y `snapshot` en secuencia sobre un documento HTML de prueba en `data:text/html,...`, THEN the Integration_Suite SHALL verificar que `NaviaResult.summary` no está vacío y que `NaviaResult.steps` es mayor que cero.

6. THE Integration_Suite SHALL establecer ella misma las variables `NAVIA_OPENAI_BASE_URL` y `NAVIA_OPENAI_MODEL` antes de cada test y restaurarlas al valor previo en afterEach, de modo que no se requiera ninguna variable de entorno externa para ejecutar la suite.

7. FOR ALL escenarios de la Integration_Suite, WHEN el test termina (tanto en éxito como en fallo), THE Integration_Suite SHALL detener el servidor LLM_Mock y restaurar las variables de entorno en un bloque afterEach o finally para no contaminar otros tests.

---

### Requirement 2: Retry con backoff exponencial en OpenAICompatClient

**User Story:** Como operador de Navia usando Groq o cualquier endpoint OpenAI-compatible, quiero que los reintentos ante errores 429/5xx usen backoff exponencial con jitter, para que las ráfagas de solicitudes no amplifiquen la sobrecarga del proveedor.

#### Acceptance Criteria

1. WHEN el OpenAICompatClient recibe un HTTP 429 o un HTTP 5xx en un intento que no sea el último (attempt < 3), THEN the Retry_Policy SHALL esperar un tiempo calculado como `min(base * 2^intento + jitter, tope_máximo)` antes del reintento, donde `base` es 500ms, `tope_máximo` es 30 000ms y `jitter` es un valor aleatorio uniforme entre 0 y 200ms.

2. THE Retry_Policy SHALL realizar como máximo 4 intentos en total (intentos 0, 1, 2 y 3); si el intento 3 también falla, lanza el error final sin esperar.

3. WHEN el OpenAICompatClient supera el número máximo de reintentos, THEN the OpenAICompatClient SHALL lanzar un `Error` cuyo mensaje siga la plantilla: `"No se pudo contactar al modelo (<cfg.label> · <cfg.baseURL>): <mensaje del último error>"`.

4. WHEN el OpenAICompatClient recibe un error de red (excepción en `fetch`) en un intento que no sea el último, THEN the Retry_Policy SHALL aplicar el mismo backoff exponencial con jitter que para los errores HTTP 429/5xx.

5. WHEN el OpenAICompatClient recibe un HTTP 4xx distinto de 429 (p.ej. 400, 401, 403), THEN the OpenAICompatClient SHALL lanzar un `Error` inmediatamente sin reintentar.

6. THE OpenAICompatClient SHALL exportar la función de cálculo de delay como `calcDelay(attempt: number, base?: number, cap?: number): number` dentro del objeto `__test`, de modo que sea testeable unitariamente sin mocks de temporizador.

---

### Requirement 3: Validación del esquema de config

**User Story:** Como usuario de Navia, quiero que `~/.navia/config.json` sea validado al cargarse, para que un valor inválido (p.ej. `"browser": "safari"` o `"workspace": 42`) produzca un mensaje de error claro en lugar de fallos silenciosos o comportamientos inesperados más adelante.

#### Acceptance Criteria

1. WHEN el Config_Loader lee un archivo `config.json` que contiene un campo `model` con un valor que no es de tipo `string`, THEN the Config_Loader SHALL lanzar un `Error` cuyo mensaje identifique el campo (`model`) y el tipo recibido.

2. WHEN el Config_Loader lee un archivo `config.json` que contiene un campo `browser` con un valor que no pertenece al conjunto `{"chromium", "chrome", "firefox", "patchright"}`, THEN the Config_Loader SHALL lanzar un `Error` cuyo mensaje identifique el campo (`browser`) y el valor recibido.

3. WHEN el Config_Loader lee un archivo `config.json` que contiene un campo `provider` con un valor que no pertenece al conjunto `{"auto", "api", "claude-cli", "openai"}`, THEN the Config_Loader SHALL lanzar un `Error` cuyo mensaje identifique el campo (`provider`) y el valor recibido.

4. WHEN el Config_Loader lee un archivo `config.json` que contiene un campo `workspace` con un valor que no es de tipo `boolean` ni de tipo `string`, THEN the Config_Loader SHALL lanzar un `Error` cuyo mensaje identifique el campo (`workspace`) y el tipo recibido.

5. WHEN el Config_Loader lee un archivo `config.json` con campos desconocidos (no presentes en `NaviaConfig`), THEN the Config_Loader SHALL ignorar dichos campos y no lanzar error, para mantener compatibilidad hacia adelante con versiones futuras.

6. WHEN el archivo `config.json` no existe, THEN the Config_Loader SHALL devolver un objeto `NaviaConfig` vacío (`{}`).

7. WHEN el archivo `config.json` está vacío o contiene JSON malformado (no parseable), THEN the Config_Loader SHALL lanzar un `Error` cuyo mensaje indique la ruta del archivo y que el contenido no es JSON válido.

8. IF el valor parseado de `config.json` no es un objeto plano (es decir, es `null`, un array, un número, un booleano o una cadena en la raíz), THEN the `validateConfig(raw: unknown): NaviaConfig` SHALL lanzar un `Error` indicando que el valor raíz no es un objeto. En caso contrario, `validateConfig` SHALL retornar un `NaviaConfig` con solo los campos conocidos y válidos.

---

### Requirement 4: Streaming de respuesta en el CLI de Navia

**User Story:** Como usuario del CLI de Navia (`navia run`), quiero ver los tokens del LLM aparecer en tiempo real conforme se generan, para percibir que el agente está progresando sin esperar al turno completo.

**Definición de Stream_Hook:** `type StreamHook = (chunk: string) => void` — callback síncrono que recibe fragmentos de texto.

#### Acceptance Criteria

1. WHEN el OpenAICompatClient recibe una respuesta del endpoint con `stream: true` activado, THE OpenAICompatClient SHALL llamar a `Stream_Hook` con el valor de `choices[0].delta.content` de cada chunk recibido siempre que dicho valor sea una cadena no vacía, antes de que el stream termine.

2. WHEN el OpenAICompatClient recibe un stream que incluye tool_calls parciales (deltas de `choices[0].delta.tool_calls`), THE OpenAICompatClient SHALL acumular los fragmentos de `function.arguments` hasta recibir el evento `[DONE]`; IF un fragmento de `function.arguments` no es JSON válido parcial, THE OpenAICompatClient SHALL descartarlo y continuar acumulando; THEN construir el bloque `tool_use` completo antes de retornar la `Anthropic.Message`.

3. IF el Stream_Hook no es provisto por el llamador (es `undefined`), THEN the OpenAICompatClient SHALL omitir el campo `stream` del cuerpo de la petición y retornar la respuesta completa sin activar ningún procesamiento SSE.

4. IF la conexión se interrumpe durante el streaming (error en el ReadableStream o en el parse de SSE), THEN the OpenAICompatClient SHALL descartar los datos parciales acumulados del stream interrumpido y aplicar la Retry_Policy (backoff exponencial) reiniciando la petición completa desde el principio.

5. THE OpenAICompatClient SHALL mantener la interfaz pública `messages.create(params)` sin cambios de firma; el streaming se activará pasando `Stream_Hook` mediante un mecanismo interno (p.ej. campo en el constructor o parámetro de `create`) que no altere la firma visible del método.

6. WHERE el proveedor OpenAI-compatible activo es `"groq"` o `"openrouter"`, THE OpenAICompatClient SHALL activar streaming automáticamente cuando el `Stream_Hook` esté disponible.

7. WHEN el CLI de Navia ejecuta una corrida con `--provider openai` y `hooks.log` está definido, THEN THE CLI_Runner SHALL pasar `hooks.log` como `Stream_Hook` al `OpenAICompatClient` antes de iniciar el loop del agente, de modo que los tokens aparezcan en la salida estándar en tiempo real.

---

### Requirement 5: Observabilidad de la Retry_Policy en logs

**User Story:** Como operador de Navia, quiero que los reintentos del cliente LLM queden reflejados en el log de progreso, para poder diagnosticar problemas de tasa o conectividad sin necesidad de activar logs de debug adicionales.

#### Acceptance Criteria

1. WHEN el OpenAICompatClient inicia un reintento (attempt 1–3) tras un error 429 o 5xx, THEN the OpenAICompatClient SHALL invocar `onRetry(attempt, waitMs, reason)` — donde `attempt` es el número de intento en curso (1-based), `waitMs` es el delay calculado antes del sleep y `reason` es `"HTTP <código>"` — inmediatamente antes de ejecutar el sleep de backoff.

2. WHEN el OpenAICompatClient inicia un reintento (attempt 1–3) tras un error de red, THEN the OpenAICompatClient SHALL invocar `onRetry(attempt, waitMs, reason)` — donde `reason` es el mensaje de la excepción de red — inmediatamente antes de ejecutar el sleep de backoff.

3. THE OpenAICompatClient SHALL aceptar un parámetro opcional `onRetry?: (attempt: number, waitMs: number, reason: string) => void` en el constructor; si no se provee, los reintentos ocurren en silencio. El `Stream_Hook` y `onRetry` son mecanismos independientes: se invocan por separado si ambos están disponibles.
