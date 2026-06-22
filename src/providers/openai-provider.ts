/**
 * Provider OpenAI-compatible — IA GRATIS para usuarios sin API key de Anthropic ni Claude CLI.
 *
 * Casi todos los modelos gratis (Groq, OpenRouter, Ollama local, Together, DeepSeek, Gemini-beta…)
 * exponen el endpoint estándar `POST /v1/chat/completions` de OpenAI CON tool-calling. Este módulo
 * implementa un CLIENTE que IMITA la interfaz del SDK de Anthropic (`client.messages.create`) y
 * traduce ida y vuelta — así el loop del agente (agent.ts) NO cambia: solo se le inyecta este
 * cliente en vez del de Anthropic cuando `--provider openai`.
 *
 * Decisión: visión DESACTIVADA por defecto (como el provider CLI) → no se mandan imágenes; el
 * captcha lo resuelve igual el OCR local (ddddocr). Esto mantiene el adaptador simple y compatible
 * con modelos gratis sin visión (la mayoría). Investigación 2026 (deep-research) recomienda Groq
 * `qwen3-32b` (cloud, sin tarjeta) u Ollama `qwen3:14b/32b` (local) por su tool-use fiable.
 */
import type Anthropic from "@anthropic-ai/sdk";

export interface OpenAIPresetConfig {
  baseURL: string;
  apiKey?: string;
  model: string;
  /** Cabecera(s) extra que algún proveedor requiere (p.ej. OpenRouter recomienda Referer/Title). */
  headers?: Record<string, string>;
  label: string;
}

/** Presets listos para los proveedores gratis más recomendados (deep-research 2026). */
export function resolveOpenAIPreset(preset: string | undefined): OpenAIPresetConfig {
  const env = process.env;
  const p = (preset ?? env.NAVIA_OPENAI_PRESET ?? "").toLowerCase();
  // Overrides explícitos (ganan sobre el preset): para cualquier endpoint OpenAI-compatible a mano.
  const baseOverride = env.NAVIA_OPENAI_BASE_URL;
  const keyOverride = env.NAVIA_OPENAI_API_KEY;
  const modelOverride = env.NAVIA_OPENAI_MODEL;

  let cfg: OpenAIPresetConfig;
  switch (p) {
    case "groq":
      cfg = { label: "Groq", baseURL: "https://api.groq.com/openai/v1", apiKey: env.GROQ_API_KEY, model: "qwen3-32b" };
      break;
    case "openrouter":
      cfg = {
        label: "OpenRouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: env.OPENROUTER_API_KEY,
        model: "qwen/qwen3-32b",
        headers: { "HTTP-Referer": "https://github.com/azulls1/navia", "X-Title": "Navia" },
      };
      break;
    case "ollama":
      // Local: no requiere API key (se manda una dummy porque algunos clientes la exigen).
      cfg = { label: "Ollama (local)", baseURL: "http://localhost:11434/v1", apiKey: "ollama", model: "qwen3:14b" };
      break;
    default:
      // Sin preset → endpoint genérico por env (NAVIA_OPENAI_*). Sirve para cualquier proveedor.
      cfg = { label: "OpenAI-compatible", baseURL: baseOverride ?? "http://localhost:11434/v1", apiKey: keyOverride, model: modelOverride ?? "qwen3:14b" };
  }
  if (baseOverride) cfg.baseURL = baseOverride;
  if (keyOverride) cfg.apiKey = keyOverride;
  if (modelOverride) cfg.model = modelOverride;
  return cfg;
}

/** Traduce las tools (formato Anthropic) al formato `tools` de OpenAI (`type:function`). */
function toOpenAITools(tools: any[] | undefined): any[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object", properties: {} } },
  }));
}

/**
 * Traduce `tool_choice` (formato Anthropic) al de OpenAI. CLAVE: respeta el choice FORZADO
 * (`{type:"tool",name}` → obliga a llamar esa tool), que usa el validador post-tarea (verdict).
 * Mapearlo siempre a "auto" hacía que el modelo respondiera texto y el validador fallara.
 */
function toOpenAIToolChoice(choice: any, hasTools: boolean): any {
  if (!hasTools) return undefined;
  if (choice?.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } };
  if (choice?.type === "any") return "required";
  return "auto";
}

/** Extrae el texto de un `content` de bloques Anthropic (ignora imágenes: visión off por defecto). */
function blocksToText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b?.type === "text" ? b.text : b?.type === "image" ? "[imagen omitida]" : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Traduce (system + messages en formato Anthropic) a la lista `messages` de OpenAI.
 * - system (array de bloques text) → un mensaje role:system.
 * - assistant con tool_use → tool_calls.
 * - user con tool_result → un mensaje role:tool por cada resultado (lo que exige OpenAI).
 */
function toOpenAIMessages(system: any, messages: any[]): any[] {
  const out: any[] = [];
  const sysText = blocksToText(system);
  if (sysText.trim()) out.push({ role: "system", content: sysText });

  for (const m of messages) {
    const content = m.content;
    if (typeof content === "string") {
      out.push({ role: m.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (m.role === "assistant") {
      const text = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      const toolCalls = content
        .filter((b: any) => b.type === "tool_use")
        .map((b: any) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg: any = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      // user: los tool_result van como mensajes role:tool; el texto suelto como user.
      const toolResults = content.filter((b: any) => b.type === "tool_result");
      for (const tr of toolResults) out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: blocksToText(tr.content) || "(ok)" });
      const userText = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
      const hasImg = content.some((b: any) => b.type === "image");
      if (userText.trim() || hasImg) out.push({ role: "user", content: userText || "[imagen omitida]" });
    }
  }
  return out;
}

/** Traduce la respuesta de OpenAI a un objeto con la forma de `Anthropic.Message`. */
function fromOpenAIResponse(json: any): Anthropic.Message {
  const choice = json?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const blocks: any[] = [];
  if (msg.content && String(msg.content).trim()) blocks.push({ type: "text", text: String(msg.content) });
  for (const tc of msg.tool_calls ?? []) {
    let input: any = {};
    try {
      input = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      input = {}; // algunos modelos mandan JSON inválido; degradamos a vacío en vez de romper el loop
    }
    blocks.push({ type: "tool_use", id: tc.id ?? `call_${blocks.length}`, name: tc.function?.name, input });
  }
  const hadToolCalls = (msg.tool_calls ?? []).length > 0;
  // Mapea finish_reason de OpenAI → stop_reason de Anthropic (fiel: "length"→"max_tokens" para que
  // un truncamiento NO se confunda con un final limpio en métricas/recorder).
  const finish = choice.finish_reason;
  const stop_reason = hadToolCalls ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn";
  return {
    id: json?.id ?? "msg_openai",
    type: "message",
    role: "assistant",
    model: json?.model ?? "openai-compatible",
    content: blocks as any,
    stop_reason,
    stop_sequence: null,
    // cache_* van a 0: los endpoints OpenAI-compatible no reportan prompt-caching de Anthropic.
    usage: { input_tokens: json?.usage?.prompt_tokens ?? 0, output_tokens: json?.usage?.completion_tokens ?? 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
  } as Anthropic.Message;
}

/**
 * Cliente que imita `anthropic.messages.create`. Traduce a `/v1/chat/completions`, con reintentos
 * básicos para errores transitorios (429/5xx). `tool_choice:"auto"` para que el modelo elija tool o texto.
 */
export class OpenAICompatClient {
  readonly messages: { create: (params: any) => Promise<Anthropic.Message> };

  constructor(private cfg: OpenAIPresetConfig) {
    this.messages = { create: (params: any) => this.create(params) };
  }

  private async create(params: any): Promise<Anthropic.Message> {
    const body = {
      model: params.model || this.cfg.model,
      messages: toOpenAIMessages(params.system, params.messages),
      tools: toOpenAITools(params.tools),
      tool_choice: toOpenAIToolChoice(params.tool_choice, !!params.tools?.length),
      max_tokens: params.max_tokens ?? 4096,
      temperature: 0,
    };
    const url = this.cfg.baseURL.replace(/\/$/, "") + "/chat/completions";
    const headers: Record<string, string> = { "Content-Type": "application/json", ...(this.cfg.headers ?? {}) };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`${this.cfg.label} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); // backoff lineal
          continue;
        }
        if (!res.ok) throw new Error(`${this.cfg.label} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return fromOpenAIResponse(await res.json());
      } catch (e) {
        lastErr = e as Error;
        if (attempt === 3) break;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    throw new Error(`No se pudo contactar al modelo (${this.cfg.label} · ${this.cfg.baseURL}): ${lastErr?.message ?? "desconocido"}`);
  }
}

// Exporta los traductores para tests unitarios.
export const __test = { toOpenAITools, toOpenAIMessages, fromOpenAIResponse };
