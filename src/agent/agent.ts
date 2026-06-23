/**
 * El loop del agente: conversa con Claude usando "tool use".
 * Claude pide herramientas (navigate, snapshot, click…), nosotros las ejecutamos contra
 * el navegador y le devolvemos el resultado, hasta que termina con un resumen en texto.
 */
import Anthropic from "@anthropic-ai/sdk";
import { BrowserDriver } from "../browser/driver.js";
import { toolDefinitions, dispatchTool, type AgentHooks, type ToolPolicy } from "./tools.js";
import type { BrowserEngine } from "../browser/launch.js";
import { createRecorder, preview } from "./trajectory.js";
import { createWorkspace } from "./workspace.js";
import { OpenAICompatClient, resolveOpenAIPreset } from "../providers/openai-provider.js";
import { DEFAULT_MAX_STEPS, resolveModel } from "../config.js";
import { withDefaultHooks, resolveProfileState, assessLoginReinjection, NEXT_TASK_PREFIX, buildSystemWithMemory, LoopMetrics, type NaviaMetrics } from "./loop-common.js";
import { createAnthropic } from "../providers/anthropic-client.js";

export type { NaviaMetrics }; // re-exportado (definido en loop-common) para la API pública

export interface NaviaOptions {
  /** Instrucción en lenguaje natural de lo que se quiere lograr. */
  task: string;
  /** Motor del navegador. */
  browser?: BrowserEngine;
  /** API key de Anthropic (o vía env ANTHROPIC_API_KEY). */
  apiKey?: string;
  /** Modelo (default claude-sonnet-4-6). */
  model?: string;
  headless?: boolean;
  slowMo?: number;
  cdpPort?: number;
  cdpEndpoint?: string;
  userDataDir?: string;
  /** Nombre de perfil guardado con `navia login` para arrancar autenticado. */
  profile?: string;
  /** Motor de inferencia: "auto" (default), "api" (ANTHROPIC_API_KEY), "claude-cli" (CLI de la terminal) u "openai" (IA gratis vía endpoint OpenAI-compatible: Groq/Ollama/OpenRouter…). */
  provider?: "auto" | "api" | "claude-cli" | "openai";
  /** Binario del CLI para provider claude-cli (default "claude"). */
  cliCommand?: string;
  /** Preset del provider openai-compatible: "groq" | "openrouter" | "ollama" (o genérico vía env NAVIA_OPENAI_*). */
  openaiPreset?: string;
  /** Registrar la corrida en JSONL: true (ruta por defecto) o una ruta de archivo. */
  record?: boolean | string;
  /** Crear carpeta-bitácora (memoria) por tarea: true (auto: Obsidian/Escritorio) o una ruta base. */
  workspace?: boolean | string;
  /** Máximo de pasos (iteraciones de tool use) antes de cortar. Default 60. */
  maxSteps?: number;
  /** Instrucciones extra para el system prompt. */
  systemExtra?: string;
  hooks?: Partial<AgentHooks>;
  /** URL inicial opcional para abrir antes de empezar. */
  startUrl?: string;
  /**
   * Validación automática post-tarea (estilo Skyvern, sin planner pesado): al "terminar",
   * un juez LLM verifica contra el objetivo usando el estado actual; si no se cumplió,
   * re-inyecta al loop con el diagnóstico (una vez por tarea). Cuesta 1 llamada extra.
   */
  validate?: boolean;
  /**
   * Memoria por dominio (playbooks): inyecta tips aprendidos del dominio (de startUrl) en el
   * system prompt y guarda notas de wait_for_human como tips. Default ON (solo actúa si hay tips).
   */
  memory?: boolean;
  /** Permitir la tool `evaluate` (ejecución de JS). Default true; false la deshabilita (sitios hostiles). */
  allowEval?: boolean;
  /** Allow-list de dominios (red): aborta peticiones fuera de la lista (anti-exfiltración). */
  allowDomains?: string[];
  /** Captcha de imagen: "off" (handoff humano, default) | "local" (OCR ddddocr local, opt-in). */
  captcha?: "off" | "local";
}

export interface NaviaResult {
  /** Resumen final en texto que devuelve la IA. */
  summary: string;
  steps: number;
  /** Métricas de la corrida (para evals/observabilidad). */
  metrics?: NaviaMetrics;
}


/** Tool del validador post-tarea: el juez SOLO puede responder con este veredicto tipado. */
const VERDICT_TOOL: Anthropic.Tool = {
  name: "verdict",
  description: "Veredicto de si la tarea del usuario se cumplió realmente, mirando el estado actual de la página.",
  input_schema: {
    type: "object",
    properties: {
      done: { type: "boolean", description: "true solo si la tarea se completó de verdad" },
      reason: { type: "string", description: "por qué se cumplió o qué falta" },
      suggestion: { type: "string", description: "si falta algo, qué hacer a continuación" },
    },
    required: ["done", "reason"],
  },
};

/** Marcador del snapshot inline que devuelven navigate y cada acción (auto-snapshot). */
const INLINE_SNAPSHOT_MARK = "--- página";

/** ¿Este bloque de texto contiene un snapshot de página (standalone o inline)? */
function holdsSnapshot(text: string): boolean {
  return text.startsWith("Página:") || text.includes(INLINE_SNAPSHOT_MARK);
}

/**
 * Poda snapshots y screenshots viejos del historial (deja solo los `keep` más recientes,
 * reemplazando los demás por un placeholder). Evita que el contexto/coste crezca sin
 * límite manteniendo el contenido reciente —lo único accionable— intacto.
 *
 * Importante: con auto-snapshot, la mayoría de los snapshots NO llegan como bloque suelto
 * ("Página:…") sino INLINE al final del resultado de navigate/click/type ("--- página…").
 * Aquí cubrimos ambos: del bloque inline se conserva el mensaje de la acción y se elide solo
 * la parte del snapshot, que es lo voluminoso. La elisión es idempotente → una vez podado un
 * bloque queda estable, sin re-romper el prefijo cacheado en los siguientes turnos.
 */
function pruneHistory(messages: Anthropic.MessageParam[], keep = 2): void {
  const snapshots: any[] = [];
  const images: any[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as any[]) {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      for (const inner of block.content) {
        if (inner.type === "text" && typeof inner.text === "string" && holdsSnapshot(inner.text)) snapshots.push(inner);
        if (inner.type === "image") images.push(inner);
      }
    }
  }
  for (const b of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    const mark = b.text.indexOf(INLINE_SNAPSHOT_MARK);
    if (mark !== -1) {
      // Conserva el mensaje de la acción; elide el snapshot voluminoso que venía detrás.
      b.text = b.text.slice(0, mark).trimEnd() + "\n[snapshot elidido para ahorrar contexto — vuelve a hacer snapshot si lo necesitas]";
    } else {
      b.text = "[snapshot anterior elidido para ahorrar contexto — vuelve a hacer snapshot si lo necesitas]";
    }
  }
  for (const b of images.slice(0, Math.max(0, images.length - keep))) {
    b.type = "text";
    b.text = "[screenshot anterior elidido para ahorrar contexto]";
    delete b.source;
  }
}

/**
 * Caching frecuencia-ordenado: el prefijo va de lo ESTÁTICO a lo VOLÁTIL.
 *  - system y tools (constantes) llevan su breakpoint estático en run().
 *  - Aquí, en los mensajes: un breakpoint ANCLA en el primer mensaje (la tarea, que no
 *    cambia → cache de larga vida, sobrevive al TTL de 5 min entre turnos lentos) y uno
 *    RODANTE en el último bloque (captura el prefijo creciente de la conversación). Con la
 *    elisión idempotente de pruneHistory, el prefijo entre ambos se mantiene estable → el
 *    snapshot volátil queda al final y se maximizan los aciertos de cache turno a turno.
 * Anthropic admite 4 breakpoints: system + tools + ancla + rodante = 4.
 */
function setCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (Array.isArray(m.content)) for (const b of m.content as any[]) delete b.cache_control;
  }
  const lastBlock = (m: Anthropic.MessageParam | undefined): any | null =>
    m && Array.isArray(m.content) && m.content.length ? (m.content[m.content.length - 1] as any) : null;

  // Ancla estática: primer mensaje (la tarea inicial, inmutable).
  const anchor = lastBlock(messages[0]);
  if (anchor) anchor.cache_control = { type: "ephemeral" };

  // Rodante: último bloque del último mensaje (prefijo creciente).
  const rolling = lastBlock(messages[messages.length - 1]);
  if (rolling) rolling.cache_control = { type: "ephemeral" };
}

// Interfaz mínima que el loop necesita del cliente LLM (la cumplen tanto el SDK de Anthropic como
// el shim OpenAI-compatible). Permite intercambiar el backend sin tocar el loop.
type MessagesClient = { messages: { create: (params: any) => Promise<Anthropic.Message> } };

export class BrowserAgent {
  private client: MessagesClient;
  private opts: NaviaOptions;
  private hooks: AgentHooks;
  /** true cuando el backend es un endpoint OpenAI-compatible gratis (Groq/Ollama/…) → sin visión. */
  private readonly isOpenAI: boolean;

  constructor(opts: NaviaOptions) {
    this.opts = opts;
    this.isOpenAI = opts.provider === "openai";
    if (this.isOpenAI) {
      // IA GRATIS: endpoint OpenAI-compatible. No requiere ANTHROPIC_API_KEY.
      const log = opts.hooks?.log;
      this.client = new OpenAICompatClient(
        resolveOpenAIPreset(opts.openaiPreset),
        log ? (chunk: string) => log(chunk) : undefined, // streamHook: tokens en tiempo real (Groq/OpenRouter)
        log ? (attempt: number, waitMs: number, reason: string) => log(`⚠️ Reintento ${attempt}/3 (${reason}), esperando ${Math.round(waitMs)}ms`) : undefined, // onRetry
      );
    } else {
      this.client = createAnthropic(opts.apiKey);
    }
    this.hooks = withDefaultHooks(opts.hooks);
  }

  async run(): Promise<NaviaResult> {
    const engine = this.opts.browser ?? "chromium";

    // Perfil: en chrome (CDP) la persistencia es el userDataDir; en otros motores el storageState.
    const prof = await resolveProfileState(engine, this.opts.profile, this.opts.userDataDir);
    const { userDataDir, storageState } = prof;
    if (this.opts.profile && engine !== "chrome") {
      this.hooks.log?.(prof.loaded ? `Perfil "${this.opts.profile}" cargado.` : `Perfil "${this.opts.profile}" no encontrado; arranco sin sesión.`);
    }

    const driver = await BrowserDriver.create({
      engine,
      headless: this.opts.headless,
      slowMo: this.opts.slowMo,
      cdpPort: this.opts.cdpPort,
      cdpEndpoint: this.opts.cdpEndpoint,
      userDataDir,
      storageState,
      allowDomains: this.opts.allowDomains,
    });
    // Anthropic API ve imágenes; el endpoint OpenAI-compatible gratis va SIN visión (como el CLI):
    // no se mandan screenshots y el captcha lo resuelve el OCR local igualmente.
    const policy: ToolPolicy = { allowEval: this.opts.allowEval, vision: !this.isOpenAI, captcha: this.opts.captcha };

    try {
      if (this.opts.startUrl) await driver.navigate(this.opts.startUrl);

      // En OpenAI-compatible el modelo lo fija el preset/env (el shim cae a cfg.model si va vacío),
      // NO el DEFAULT_MODEL de Anthropic (que no existe en Groq/Ollama).
      const model = this.isOpenAI ? (this.opts.model ?? process.env.NAVIA_OPENAI_MODEL ?? "") : resolveModel(this.opts.model);
      const maxSteps = this.opts.maxSteps ?? DEFAULT_MAX_STEPS;
      // Workspace = carpeta-bitácora (memoria) por tarea; si se pide, la grabación va también allí.
      let ws: Awaited<ReturnType<typeof createWorkspace>>["ws"] | undefined;
      if (this.opts.workspace) {
        const created = await createWorkspace(
          this.opts.task,
          new Date().toISOString(),
          typeof this.opts.workspace === "string" ? { dir: this.opts.workspace } : undefined,
        );
        ws = created.ws;
        this.hooks.log?.(`🧠 Workspace: ${ws.dir}  [${created.where}]`);
      }
      const recorder = createRecorder(this.opts.record, undefined, ws);
      if (recorder.path) this.hooks.log?.(`📝 Trayectoria: ${recorder.path}`);

      // Validador post-tarea (opt-in): juez LLM que mira el estado real y dice si se cumplió.
      const validateTask = async (candidate: string): Promise<{ done: boolean; reason: string; suggestion?: string }> => {
        try {
          const snap = await driver.snapshot();
          const resp = await this.client.messages.create({
            model,
            max_tokens: 1024,
            tools: [VERDICT_TOOL],
            tool_choice: { type: "tool", name: "verdict" },
            messages: [
              {
                role: "user",
                content: `Tarea original del usuario: ${this.opts.task}\n\nLo que el agente reporta haber hecho: ${candidate}\n\nEstado ACTUAL de la página (árbol de accesibilidad):\n${snap.slice(0, 12000)}\n\n¿La tarea se completó REALMENTE? Sé estricto pero justo. Llama a verdict(done, reason, suggestion).`,
              },
            ],
          });
          const tu = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "verdict");
          const v = tu?.input as any;
          return { done: !!v?.done, reason: v?.reason ?? "", suggestion: v?.suggestion };
        } catch {
          return { done: true, reason: "validador no disponible (no bloquea)" };
        }
      };
      await recorder.log({ type: "start", task: this.opts.task, engine, model, provider: this.isOpenAI ? "openai" : "api" });
      // Memoria por dominio: inyecta tips aprendidos del dominio (de startUrl) si los hay.
      const system = await buildSystemWithMemory(this.opts, this.hooks.log);
      // Breakpoints de caché estáticos: system (constante) y el bloque de tools (constante).
      const systemBlocks: Anthropic.TextBlockParam[] = [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ];
      const tools = toolDefinitions(policy);
      const cachedTools: Anthropic.Tool[] = tools.map((t, i) =>
        i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t,
      );

      const messages: Anthropic.MessageParam[] = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: this.opts.startUrl
                ? `Tarea: ${this.opts.task}\n\nYa navegué a ${this.opts.startUrl} y la página YA está abierta (NO pidas la URL). Empieza con un snapshot para leerla.`
                : `Tarea: ${this.opts.task}\n\nEmpieza navegando o haciendo un snapshot según corresponda.`,
            },
          ],
        },
      ];

      let totalSteps = 0;
      const metrics = new LoopMetrics();
      let loginContext = false; // se activa al usar fill_credential/fill_totp → verificamos el login
      let loginVerifyFails = 0; // tope de re-inyecciones por login no confirmado (anti-bucle)
      // Bucle de CONVERSACIÓN: cada iteración resuelve una tarea; si hay hook nextTask, al
      // terminar pide la siguiente reusando el MISMO navegador/sesión y el historial completo.
      for (;;) {
        let steps = 0;
        let summary: string | null = null;
        let validateAttempts = 0;
        let truncationContinues = 0; // veces que pedimos continuar tras un truncado por longitud (tope anti-bucle)
        while (steps < maxSteps) {
          steps++;
          totalSteps++;
          pruneHistory(messages);
          setCacheBreakpoint(messages);
          const response = await this.client.messages.create({
            model,
            max_tokens: 4096,
            system: systemBlocks,
            tools: cachedTools,
            messages,
          });

          const u = response.usage as any;
          metrics.addTokens((u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0), u?.output_tokens ?? 0);
          messages.push({ role: "assistant", content: response.content });

          const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

          // Texto que va emitiendo la IA (pensamiento/avances).
          for (const block of response.content) {
            if (block.type === "text" && block.text.trim()) {
              this.hooks.log?.(`💬 ${block.text.trim()}`);
              await recorder.log({ step: totalSteps, type: "thought", text: preview(block.text.trim()) });
            }
          }

          if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
            // Respuesta CORTADA por longitud (max_tokens) sin pedir tool: el modelo no terminó.
            // En vez de tomar un resumen a medias como final, le pedimos continuar (tope anti-bucle).
            if (response.stop_reason === "max_tokens" && truncationContinues < 2) {
              truncationContinues++;
              this.hooks.log?.("✂️ Respuesta truncada por longitud; pido continuar.");
              messages.push({ role: "user", content: [{ type: "text", text: "Tu respuesta anterior se cortó por longitud. Continúa exactamente donde quedaste (no repitas lo ya dicho)." }] });
              continue;
            }
            const candidate = response.content
              .filter((b): b is Anthropic.TextBlock => b.type === "text")
              .map((b) => b.text)
              .join("\n")
              .trim();
            // Verificación DETERMINISTA de login (mata el falso positivo "el form desapareció = entré").
            if (loginContext && loginVerifyFails < 2) {
              const reinject = await assessLoginReinjection(driver, this.opts.startUrl, this.hooks.log);
              if (reinject) {
                loginVerifyFails++;
                await recorder.log({ step: totalSteps, type: "login-check", status: "failed", detail: preview(reinject.detail) });
                messages.push({ role: "user", content: [{ type: "text", text: reinject.message }] });
                continue;
              }
            }
            // Validador post-tarea: si está activo y aún no se reintentó, verifica el estado
            // real; si no se cumplió, re-inyecta el diagnóstico y sigue (una vez).
            if (this.opts.validate && validateAttempts < 1) {
              validateAttempts++;
              const v = await validateTask(candidate);
              if (!v.done) {
                this.hooks.log?.(`🔎 Validación: incompleta — ${v.reason}`);
                await recorder.log({ step: totalSteps, type: "validation", done: false, reason: preview(v.reason) });
                messages.push({
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: `Validación automática: la tarea AÚN no parece completa. Motivo: ${v.reason}.${v.suggestion ? ` Sugerencia: ${v.suggestion}.` : ""} Continúa intentándolo; si de verdad es imposible, explica por qué.`,
                    },
                  ],
                });
                continue;
              }
            }
            summary = candidate;
            await recorder.log({ step: totalSteps, type: "done", summary: preview(summary) });
            break;
          }

          // Ejecuta todas las tools pedidas y arma los tool_result.
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            const refForLoc = (tu.input as any)?.ref;
            const locator = typeof refForLoc === "string" ? driver.describeRef(refForLoc) : null;
            metrics.recordCall(tu.name, tu.input);
            if (tu.name === "fill_credential" || tu.name === "fill_totp") loginContext = true;
            try {
              const out = await dispatchTool(tu.name, tu.input as Record<string, any>, driver, this.hooks, policy);
              metrics.recordSuccess();
              const content: Anthropic.ToolResultBlockParam["content"] = [];
              if (out.text) content.push({ type: "text", text: out.text });
              if (out.imageBase64)
                content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: out.imageBase64 } });
              this.hooks.log?.(`✓ ${tu.name}`);
              toolResults.push({ type: "tool_result", tool_use_id: tu.id, content });
              await recorder.log({
                step: totalSteps,
                type: "action",
                tool: tu.name,
                input: tu.input,
                locator: locator ?? undefined,
                ok: true,
                result: preview(out.text ?? (out.imageBase64 ? "[screenshot]" : "")),
              });
            } catch (err) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: tu.id,
                content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
                is_error: true,
              });
              metrics.recordError();
              this.hooks.log?.(`✗ ${tu.name}: ${(err as Error).message}`);
              await recorder.log({ step: totalSteps, type: "action", tool: tu.name, input: tu.input, locator: locator ?? undefined, ok: false, error: (err as Error).message });
            }
          }
          messages.push({ role: "user", content: toolResults });
        }

        if (summary === null) {
          summary = `Se alcanzó el máximo de ${maxSteps} pasos sin terminar.`;
          await recorder.log({ step: totalSteps, type: "done", summary: "max-steps" });
        }

        await ws?.writeSummary(summary); // resumen.md en la bitácora (igual que el loop CLI)
        this.hooks.onTaskSummary?.(summary, totalSteps);
        const next = this.hooks.nextTask ? await this.hooks.nextTask() : null;
        if (!next) {
          metrics.steps = totalSteps;
          return { summary, steps: totalSteps, metrics };
        }
        messages.push({ role: "user", content: [{ type: "text", text: `${NEXT_TASK_PREFIX} ${next}` }] });
      }
    } finally {
      await driver.close();
    }
  }
}

/** Decide el proveedor: explícito, o auto (API key si existe; si no, CLI claude). */
export function resolveProvider(opts: NaviaOptions): "api" | "claude-cli" | "openai" {
  if (opts.provider && opts.provider !== "auto") return opts.provider;
  return opts.apiKey || process.env.ANTHROPIC_API_KEY ? "api" : "claude-cli";
}

export async function runNavia(opts: NaviaOptions): Promise<NaviaResult> {
  if (resolveProvider(opts) === "claude-cli") {
    const { runViaCli } = await import("./cli-agent.js");
    return runViaCli(opts, withDefaultHooks(opts.hooks));
  }
  return new BrowserAgent(opts).run();
}
