/**
 * El loop del agente: conversa con Claude usando "tool use".
 * Claude pide herramientas (navigate, snapshot, click…), nosotros las ejecutamos contra
 * el navegador y le devolvemos el resultado, hasta que termina con un resumen en texto.
 */
import Anthropic from "@anthropic-ai/sdk";
import { BrowserDriver } from "../browser/driver.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { TOOL_DEFINITIONS, dispatchTool, type AgentHooks } from "./tools.js";
import type { BrowserEngine } from "../browser/launch.js";

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

export class BrowserAgent {
  private client: Anthropic;
  private opts: NaviaOptions;
  private hooks: AgentHooks;

  constructor(opts: NaviaOptions) {
    this.opts = opts;
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Falta ANTHROPIC_API_KEY (pásala en opts.apiKey o como variable de entorno).");
    this.client = new Anthropic({ apiKey });
    this.hooks = {
      confirmAction: opts.hooks?.confirmAction ?? (async () => false),
      waitForHuman: opts.hooks?.waitForHuman ?? (async () => ""),
      log: opts.hooks?.log,
    };
  }

  async run(): Promise<NaviaResult> {
    const driver = await BrowserDriver.create({
      engine: this.opts.browser ?? "chromium",
      headless: this.opts.headless,
      slowMo: this.opts.slowMo,
      cdpPort: this.opts.cdpPort,
      cdpEndpoint: this.opts.cdpEndpoint,
      userDataDir: this.opts.userDataDir,
    });

    try {
      if (this.opts.startUrl) await driver.navigate(this.opts.startUrl);

      const model = this.opts.model ?? process.env.NAVIA_MODEL ?? DEFAULT_MODEL;
      const maxSteps = this.opts.maxSteps ?? 60;
      const system = buildSystemPrompt(this.opts.systemExtra);

      const messages: Anthropic.MessageParam[] = [
        {
          role: "user",
          content: `Tarea: ${this.opts.task}\n\nEmpieza navegando o haciendo un snapshot según corresponda.`,
        },
      ];

      let steps = 0;
      while (steps < maxSteps) {
        steps++;
        const response = await this.client.messages.create({
          model,
          max_tokens: 4096,
          system,
          tools: TOOL_DEFINITIONS,
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
