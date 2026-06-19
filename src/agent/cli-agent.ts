/**
 * Runner autónomo por CLI (sin API key): loop ReAct sobre un binario de IA de la terminal
 * (p.ej. `claude`). En cada paso le pasamos system + herramientas + historial y le pedimos
 * la PRÓXIMA acción como JSON; la ejecutamos contra el navegador y repetimos.
 *
 * Es menos eficiente que el tool-use nativo de la API (un proceso por paso), pero permite
 * usar Navia con cualquier cuenta de IA ya autenticada en la terminal.
 */
import os from "node:os";
import path from "node:path";
import { BrowserDriver } from "../browser/driver.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { toolDefinitions, dispatchTool, type AgentHooks, type ToolPolicy } from "./tools.js";
import { loadSession } from "../browser/session-store.js";
import { cliComplete } from "../providers/cli-provider.js";
import { createRecorder, preview } from "./trajectory.js";
import { createWorkspace } from "./workspace.js";
import { tipsBlockFor } from "./domain-memory.js";
import type { NaviaOptions, NaviaResult } from "./agent.js";

function extractJson(s: string): any | null {
  if (!s) return null;
  let t = s.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    /* intenta recortar */
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch {
      /* noop */
    }
  }
  return null;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/**
 * Mantiene el historial acotado y BARATO. Aprendizaje de los logs: con auto-snapshot cada
 * observación trae la página completa → el prompt del CLI crece y se ralentiza. Solución:
 * dejar SOLO la última observación en detalle y elidir las anteriores (la IA solo necesita
 * el estado actual; el historial de acciones basta para el contexto). Además acota la cola.
 */
function pruneTranscript(transcript: string[], keepTail = 20): void {
  let lastObs = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].startsWith("OBSERVACIÓN:")) {
      lastObs = i;
      break;
    }
  }
  for (let i = 0; i < transcript.length; i++) {
    if (i !== lastObs && transcript[i].startsWith("OBSERVACIÓN:") && transcript[i].length > 200) {
      transcript[i] = "OBSERVACIÓN: [elidida; usa snapshot si necesitas releer ese estado]";
    }
  }
  if (transcript.length > keepTail + 1) {
    const head = transcript[0];
    const tail = transcript.slice(transcript.length - keepTail);
    transcript.length = 0;
    transcript.push(head, "(… historial antiguo elidido …)", ...tail);
  }
}

/** Validador post-tarea para el modo CLI: pide un veredicto JSON sobre el estado real. */
async function validateViaCli(
  driver: BrowserDriver,
  opts: NaviaOptions,
  task: string,
  summary: string,
): Promise<{ done: boolean; reason: string; suggestion?: string } | null> {
  try {
    const snap = await driver.snapshot();
    const raw = await cliComplete(
      `Tarea original del usuario: ${task}\nLo que el agente reporta haber hecho: ${summary}\nEstado ACTUAL de la página (árbol de accesibilidad):\n${truncate(snap, 8000)}\n\n¿La tarea se completó REALMENTE? Sé estricto pero justo. Responde ÚNICAMENTE con UN objeto JSON, sin texto alrededor: {"done":true|false,"reason":"...","suggestion":"..."}`,
      { command: opts.cliCommand, model: opts.model, timeoutMs: 120000 },
    );
    const v = extractJson(raw);
    if (!v || typeof v.done !== "boolean") return null;
    return { done: v.done, reason: v.reason ?? "", suggestion: v.suggestion };
  } catch {
    return null;
  }
}

export async function runViaCli(opts: NaviaOptions, hooks: AgentHooks): Promise<NaviaResult> {
  const engine = opts.browser ?? "chromium";

  let storageState: unknown;
  let userDataDir = opts.userDataDir;
  if (opts.profile) {
    if (engine === "chrome") userDataDir = userDataDir ?? path.join(os.homedir(), ".navia", "profiles", `chrome-${opts.profile}`);
    else storageState = (await loadSession(opts.profile)) ?? undefined;
  }

  const driver = await BrowserDriver.create({
    engine,
    headless: opts.headless,
    slowMo: opts.slowMo,
    cdpPort: opts.cdpPort,
    cdpEndpoint: opts.cdpEndpoint,
    userDataDir,
    storageState,
    allowDomains: opts.allowDomains,
  });
  // El `claude`/`ant` CLI SÍ leen imágenes (les pasamos el PNG): hay visión. Solo el CLI
  // genérico (NAVIA_CLI_CMD) no sabemos si la tiene → ahí no.
  const cliHasVision = !process.env.NAVIA_CLI_CMD;
  const policy: ToolPolicy = { allowEval: opts.allowEval, vision: cliHasVision };

  try {
    if (opts.startUrl) await driver.navigate(opts.startUrl);

    // Memoria por dominio: inyecta tips aprendidos del dominio (de startUrl) si los hay.
    const memoryExtra = opts.memory === false ? "" : await tipsBlockFor(opts.startUrl);
    if (memoryExtra) hooks.log?.(`🧠 Playbook del dominio cargado (${memoryExtra.split("\n").length - 1} tip(s)).`);
    const system = buildSystemPrompt([opts.systemExtra, memoryExtra].filter(Boolean).join("\n\n") || undefined);
    const toolCatalog = toolDefinitions(policy).map(
      (t) => `- ${t.name}: ${t.description}\n    args: ${JSON.stringify((t.input_schema as any).properties ?? {})}`,
    ).join("\n");

    const transcript: string[] = [`TAREA: ${opts.task}`];
    // Grounding: si ya navegamos a una URL, sembramos un snapshot inicial para que el modelo
    // SEPA que la página está abierta (si no, en modo CLI puede creer que no hay página y pedir
    // la URL en vez de leerla).
    if (opts.startUrl) {
      const snap0 = await driver.snapshot().catch(() => "");
      if (snap0) transcript.push(`NOTA: ya navegué a ${opts.startUrl} y la página YA está abierta. NO pidas la URL.\nOBSERVACIÓN: ${truncate(snap0, 4000)}`);
    }
    const maxSteps = opts.maxSteps ?? 60;

    // Workspace = carpeta-bitácora (memoria) por tarea. Si se pide, la grabación va también allí.
    let ws: Awaited<ReturnType<typeof createWorkspace>>["ws"] | undefined;
    if (opts.workspace) {
      const stamp = new Date().toISOString();
      const created = await createWorkspace(opts.task, stamp, typeof opts.workspace === "string" ? { dir: opts.workspace } : undefined);
      ws = created.ws;
      hooks.log?.(`🧠 Workspace: ${ws.dir}  [${created.where}]`);
    }
    const recorder = createRecorder(opts.record, undefined, ws);
    if (recorder.path) hooks.log?.(`📝 Trayectoria: ${recorder.path}`);
    await recorder.log({ type: "start", task: opts.task, engine, provider: "claude-cli" });

    let totalSteps = 0;
    const metrics = { steps: 0, toolCalls: 0, toolErrors: 0, tokensIn: 0, tokensOut: 0, recoveries: 0, loopHits: 0 };
    let lastWasError = false;
    let lastSig = "";
    let loginContext = false;
    let loginVerifyFails = 0;
    // Imágenes (p.ej. captcha) capturadas que se adjuntan al SIGUIENTE prompt del CLI para que las lea.
    let pendingImages: string[] = [];
    let imgCounter = 0;
    // Bucle de CONVERSACIÓN: resuelve una tarea y, si hay hook nextTask, pide la siguiente
    // reusando el MISMO navegador/sesión y el historial (transcript) acumulado.
    for (;;) {
      let summary: string | null = null;
      let validateAttempts = 0;
      for (let step = 1; step <= maxSteps; step++) {
        totalSteps++;
        const prompt = `${system}

HERRAMIENTAS DISPONIBLES (usa exactamente estos nombres):
${toolCatalog}

HISTORIAL:
${transcript.join("\n")}

Decide la PRÓXIMA acción para avanzar la tarea. Responde ÚNICAMENTE con UN objeto JSON, sin texto ni explicación alrededor, en UNA de estas formas:
{"thought":"razonamiento breve","tool":"<nombre exacto>","args":{ ... }}
o, si la tarea ya está completa o no puedes continuar:
{"done":true,"summary":"resumen claro de lo que hiciste y los datos obtenidos"}`;

        let raw: string;
        try {
          // Adjunta las imágenes pendientes (p.ej. el captcha capturado) a ESTE prompt y las consume.
          const attach = pendingImages;
          pendingImages = [];
          raw = await cliComplete(prompt, { command: opts.cliCommand, model: opts.model, timeoutMs: 180000 }, attach);
        } catch (e) {
          return { summary: `Error del proveedor CLI: ${(e as Error).message}`, steps: totalSteps };
        }

        const action = extractJson(raw);
        if (!action) {
          transcript.push(`(respuesta no-JSON ignorada: ${truncate(raw, 200)})`);
          pruneTranscript(transcript);
          continue;
        }
        if (action.done) {
          const s: string = action.summary ?? "(sin resumen)";
          // Verificación DETERMINISTA de login (mata el falso positivo de "entré" sin haber entrado).
          if (loginContext && loginVerifyFails < 2) {
            const outcome = await driver.assessLoginOutcome(opts.startUrl);
            if (outcome.status === "failed") {
              loginVerifyFails++;
              hooks.log?.(`🔎 Login NO confirmado: ${outcome.detail}`);
              await recorder.log({ step: totalSteps, type: "login-check", status: "failed", detail: preview(outcome.detail) });
              transcript.push(
                `VERIFICACIÓN DE LOGIN: NO tuvo éxito (${outcome.detail}). NO declares éxito. Si hay un CAPTCHA y NO tienes visión, llama a wait_for_human para que la persona lo escriba y reintenta enviar. No afirmes que entraste si no lo confirmaste.`,
              );
              continue;
            }
          }
          // Validador post-tarea (opt-in): verifica el estado real; si no se cumplió, re-inyecta.
          if (opts.validate && validateAttempts < 1) {
            validateAttempts++;
            const v = await validateViaCli(driver, opts, opts.task, s);
            if (v && v.done === false) {
              hooks.log?.(`🔎 Validación: incompleta — ${v.reason}`);
              await recorder.log({ step: totalSteps, type: "validation", done: false, reason: preview(v.reason) });
              transcript.push(
                `VALIDACIÓN AUTOMÁTICA: la tarea AÚN no parece completa. Motivo: ${v.reason}.${v.suggestion ? ` Sugerencia: ${v.suggestion}.` : ""} Continúa intentándolo; si de verdad es imposible, explica por qué.`,
              );
              continue;
            }
          }
          summary = s;
          await recorder.log({ step: totalSteps, type: "done", summary: preview(s) });
          await ws?.writeSummary(s);
          break;
        }
        if (!action.tool) {
          transcript.push("(acción sin 'tool' ignorada)");
          continue;
        }

        hooks.log?.(`💭 ${action.thought ?? ""} → ${action.tool} ${JSON.stringify(action.args ?? {})}`);
        const locator = typeof action.args?.ref === "string" ? driver.describeRef(action.args.ref) : null;
        metrics.toolCalls++;
        if (action.tool === "fill_credential" || action.tool === "fill_totp") loginContext = true;
        const sig = `${action.tool}:${JSON.stringify(action.args ?? {})}`;
        if (sig === lastSig) metrics.loopHits++;
        lastSig = sig;
        try {
          const out = await dispatchTool(action.tool, action.args ?? {}, driver, hooks, policy);
          if (lastWasError) metrics.recoveries++;
          lastWasError = false;
          let obs: string;
          if (out.imageBase64) {
            // Guarda la captura en un PNG y la deja pendiente: el CLI la LEERÁ en el próximo turno.
            const p = path.join(os.tmpdir(), `navia-shot-${process.pid}-${++imgCounter}.png`);
            try {
              const { writeFileSync } = await import("node:fs");
              writeFileSync(p, Buffer.from(out.imageBase64, "base64"));
              pendingImages.push(p);
              obs = "(captura tomada y ADJUNTA: la verás como imagen en tu próximo turno; léela y úsala, p.ej. para el texto del captcha)";
            } catch {
              obs = "(captura tomada pero no se pudo guardar para leerla)";
            }
          } else {
            obs = out.text ?? "(ok)";
          }
          hooks.log?.(`✓ ${action.tool}`);
          transcript.push(`ACCIÓN ${step}: ${action.tool} ${JSON.stringify(action.args ?? {})}`);
          transcript.push(`OBSERVACIÓN: ${truncate(obs, 4000)}`);
          await recorder.log({ step: totalSteps, type: "action", thought: action.thought, tool: action.tool, input: action.args ?? {}, locator: locator ?? undefined, ok: true, result: preview(obs) });
        } catch (e) {
          metrics.toolErrors++;
          lastWasError = true;
          hooks.log?.(`✗ ${action.tool}: ${(e as Error).message}`);
          transcript.push(`ERROR en ${action.tool}: ${(e as Error).message}`);
          await recorder.log({ step: totalSteps, type: "action", tool: action.tool, input: action.args ?? {}, locator: locator ?? undefined, ok: false, error: (e as Error).message });
        }
        pruneTranscript(transcript);
      }

      if (summary === null) summary = `Se alcanzó el máximo de ${maxSteps} pasos sin terminar.`;

      hooks.onTaskSummary?.(summary, totalSteps);
      const next = hooks.nextTask ? await hooks.nextTask() : null;
      if (!next) {
        metrics.steps = totalSteps;
        return { summary, steps: totalSteps, metrics };
      }
      transcript.push(`NUEVA TAREA (misma sesión del navegador): ${next}`);
    }
  } finally {
    await driver.close();
  }
}
