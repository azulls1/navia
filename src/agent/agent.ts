/**
 * El loop del agente: conversa con Claude usando "tool use".
 * Claude pide herramientas (navigate, snapshot, click…), nosotros las ejecutamos contra
 * el navegador y le devolvemos el resultado, hasta que termina con un resumen en texto.
 */
import Anthropic from "@anthropic-ai/sdk";
import os from "node:os";
import path from "node:path";
import { BrowserDriver } from "../browser/driver.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { TOOL_DEFINITIONS, dispatchTool, type AgentHooks } from "./tools.js";
import type { BrowserEngine } from "../browser/launch.js";
import { loadSession } from "../browser/session-store.js";

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
  /** Máximo de pasos (iteraciones de tool use) antes de cortar. Default 60. */
  maxSteps?: number;
  /** Instrucciones extra para el system prompt. */
  systemExtra?: string;
  hooks?: Partial<AgentHooks>;
  /** URL inicial opcional para abrir antes de empezar. */
  startUrl?: string;
}

export interface NaviaResult {
  /** Resumen final en texto que devuelve la IA. */
  summary: string;
  steps: number;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

/**
 * Pone un breakpoint de prompt caching rodante en el último bloque del último mensaje
 * (quitando los previos para no exceder los 4 breakpoints de Anthropic). Junto con los
 * breakpoints estáticos de system y tools, cachea el prefijo creciente de la conversación
 * → ~70-90% menos de coste/latencia de input en cada turno.
 */
/**
 * Poda snapshots y screenshots viejos del historial (deja solo los `keep` más recientes,
 * reemplazando los demás por un placeholder). Evita que el contexto/coste crezca sin
 * límite manteniendo el contenido reciente —lo único accionable— intacto.
 */
function pruneHistory(messages: Anthropic.MessageParam[], keep = 2): void {
  const snapshots: any[] = [];
  const images: any[] = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as any[]) {
      if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
      for (const inner of block.content) {
        if (inner.type === "text" && typeof inner.text === "string" && inner.text.startsWith("Página:")) snapshots.push(inner);
        if (inner.type === "image") images.push(inner);
      }
    }
  }
  for (const b of snapshots.slice(0, Math.max(0, snapshots.length - keep))) {
    b.text = "[snapshot anterior elidido para ahorrar contexto — vuelve a hacer snapshot si lo necesitas]";
  }
  for (const b of images.slice(0, Math.max(0, images.length - keep))) {
    b.type = "text";
    b.text = "[screenshot anterior elidido para ahorrar contexto]";
    delete b.source;
  }
}

function setCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (Array.isArray(m.content)) for (const b of m.content as any[]) delete b.cache_control;
  }
  const last = messages[messages.length - 1];
  if (last && Array.isArray(last.content) && last.content.length) {
    (last.content[last.content.length - 1] as any).cache_control = { type: "ephemeral" };
  }
}

export class BrowserAgent {
  private client: Anthropic;
  private opts: NaviaOptions;
  private hooks: AgentHooks;

  constructor(opts: NaviaOptions) {
    this.opts = opts;
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Falta ANTHROPIC_API_KEY (pásala en opts.apiKey o como variable de entorno).");
    // maxRetries cubre errores transitorios de la API (429/5xx) con backoff automático.
    this.client = new Anthropic({ apiKey, maxRetries: 4 });
    this.hooks = {
      confirmAction: opts.hooks?.confirmAction ?? (async () => false),
      waitForHuman: opts.hooks?.waitForHuman ?? (async () => ""),
      log: opts.hooks?.log,
    };
  }

  async run(): Promise<NaviaResult> {
    const engine = this.opts.browser ?? "chromium";

    // Perfil: en chrome (CDP) la persistencia es el userDataDir; en chromium/firefox
    // se inyecta el storageState guardado.
    let storageState: unknown;
    let userDataDir = this.opts.userDataDir;
    if (this.opts.profile) {
      if (engine === "chrome") {
        userDataDir = userDataDir ?? path.join(os.homedir(), ".navia", "profiles", `chrome-${this.opts.profile}`);
      } else {
        storageState = (await loadSession(this.opts.profile)) ?? undefined;
        this.hooks.log?.(storageState ? `Perfil "${this.opts.profile}" cargado.` : `Perfil "${this.opts.profile}" no encontrado; arranco sin sesión.`);
      }
    }

    const driver = await BrowserDriver.create({
      engine,
      headless: this.opts.headless,
      slowMo: this.opts.slowMo,
      cdpPort: this.opts.cdpPort,
      cdpEndpoint: this.opts.cdpEndpoint,
      userDataDir,
      storageState,
    });

    try {
      if (this.opts.startUrl) await driver.navigate(this.opts.startUrl);

      const model = this.opts.model ?? process.env.NAVIA_MODEL ?? DEFAULT_MODEL;
      const maxSteps = this.opts.maxSteps ?? 60;
      const system = buildSystemPrompt(this.opts.systemExtra);
      // Breakpoints de caché estáticos: system (constante) y el bloque de tools (constante).
      const systemBlocks: Anthropic.TextBlockParam[] = [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ];
      const cachedTools: Anthropic.Tool[] = TOOL_DEFINITIONS.map((t, i) =>
        i === TOOL_DEFINITIONS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t,
      );

      const messages: Anthropic.MessageParam[] = [
        {
          role: "user",
          content: `Tarea: ${this.opts.task}\n\nEmpieza navegando o haciendo un snapshot según corresponda.`,
        },
      ];

      let steps = 0;
      while (steps < maxSteps) {
        steps++;
        pruneHistory(messages);
        setCacheBreakpoint(messages);
        const response = await this.client.messages.create({
          model,
          max_tokens: 4096,
          system: systemBlocks,
          tools: cachedTools,
          messages,
        });

        messages.push({ role: "assistant", content: response.content });

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );

        // Texto que va emitiendo la IA (pensamiento/avances).
        for (const block of response.content) {
          if (block.type === "text" && block.text.trim()) this.hooks.log?.(`💬 ${block.text.trim()}`);
        }

        if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
          const finalText = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
          return { summary: finalText || "(sin resumen)", steps };
        }

        // Ejecuta todas las tools pedidas y arma los tool_result.
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          try {
            const out = await dispatchTool(tu.name, tu.input as Record<string, any>, driver, this.hooks);
            const content: Anthropic.ToolResultBlockParam["content"] = [];
            if (out.text) content.push({ type: "text", text: out.text });
            if (out.imageBase64)
              content.push({
                type: "image",
                source: { type: "base64", media_type: "image/png", data: out.imageBase64 },
              });
            toolResults.push({ type: "tool_result", tool_use_id: tu.id, content });
          } catch (err) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
              is_error: true,
            });
          }
        }
        messages.push({ role: "user", content: toolResults });
      }

      return { summary: `Se alcanzó el máximo de ${maxSteps} pasos sin terminar.`, steps };
    } finally {
      await driver.close();
    }
  }
}

export async function runNavia(opts: NaviaOptions): Promise<NaviaResult> {
  return new BrowserAgent(opts).run();
}
