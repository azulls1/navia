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
import { TOOL_DEFINITIONS, dispatchTool, type AgentHooks } from "./tools.js";
import { loadSession } from "../browser/session-store.js";
import { cliComplete } from "../providers/cli-provider.js";
import { createRecorder, preview } from "./trajectory.js";
import { createWorkspace } from "./workspace.js";
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
  });

  try {
    if (opts.startUrl) await driver.navigate(opts.startUrl);

    const system = buildSystemPrompt(opts.systemExtra);
    const toolCatalog = TOOL_DEFINITIONS.map(
      (t) => `- ${t.name}: ${t.description}\n    args: ${JSON.stringify((t.input_schema as any).properties ?? {})}`,
    ).join("\n");

    const transcript: string[] = [`TAREA: ${opts.task}`];
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
    // Bucle de CONVERSACIÓN: resuelve una tarea y, si hay hook nextTask, pide la siguiente
    // reusando el MISMO navegador/sesión y el historial (transcript) acumulado.
    for (;;) {
      let summary: string | null = null;
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
          raw = await cliComplete(prompt, { command: opts.cliCommand, model: opts.model, timeoutMs: 180000 });
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
        try {
          const out = await dispatchTool(action.tool, action.args ?? {}, driver, hooks);
          const obs = out.text ?? (out.imageBase64 ? "(captura tomada; no visible en modo CLI)" : "(ok)");
          transcript.push(`ACCIÓN ${step}: ${action.tool} ${JSON.stringify(action.args ?? {})}`);
          transcript.push(`OBSERVACIÓN: ${truncate(obs, 4000)}`);
          await recorder.log({ step: totalSteps, type: "action", thought: action.thought, tool: action.tool, input: action.args ?? {}, locator: locator ?? undefined, ok: true, result: preview(obs) });
        } catch (e) {
          transcript.push(`ERROR en ${action.tool}: ${(e as Error).message}`);
          await recorder.log({ step: totalSteps, type: "action", tool: action.tool, input: action.args ?? {}, locator: locator ?? undefined, ok: false, error: (e as Error).message });
        }
        pruneTranscript(transcript);
      }

      if (summary === null) summary = `Se alcanzó el máximo de ${maxSteps} pasos sin terminar.`;

      hooks.onTaskSummary?.(summary, totalSteps);
      const next = hooks.nextTask ? await hooks.nextTask() : null;
      if (!next) return { summary, steps: totalSteps };
      transcript.push(`NUEVA TAREA (misma sesión del navegador): ${next}`);
    }
  } finally {
    await driver.close();
  }
}
