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
  /** ¿El proveedor soporta streaming SSE fiable? Capacidad explícita (no se infiere del label). */
  supportsStream?: boolean;
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
      cfg = { label: "Groq", baseURL: "https://api.groq.com/openai/v1", apiKey: env.GROQ_API_KEY, model: "qwen3-32b", supportsStream: true };
      break;
    case "openrouter":
      cfg = {
        label: "OpenRouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: env.OPENROUTER_API_KEY,
        model: "qwen/qwen3-32b",
        headers: { "HTTP-Referer": "https://github.com/azulls1/navia", "X-Title": "Navia" },
        supportsStream: true,
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

/** Callback que recibe fragmentos de texto del LLM en tiempo real (streaming SSE). */
export type StreamHook = (chunk: string) => void;

/**
 * Delay (ms) para un reintento: backoff EXPONENCIAL con jitter. `min(base·2^intento + jitter, cap)`.
 * Exponencial (no lineal) para no amplificar la sobrecarga del proveedor ante 429/5xx; jitter para
 * desincronizar reintentos concurrentes. Defaults: base 500ms, cap 30s.
 */
/** Máximo de intentos totales (incluye el primero) ante errores transitorios 429/5xx/red. */
const MAX_ATTEMPTS = 4;

export function calcDelay(attempt: number, base = 500, cap = 30_000): number {
  const jitter = Math.random() * 200;
  return Math.min(base * Math.pow(2, attempt) + jitter, cap);
}

/** Error interno con metadatos de reintento. `fastFail`: 4xx no-429 → no reintentar. */
interface RetryError extends Error {
  fastFail?: boolean;
  reason?: string;
}
function retryError(message: string, opts: { fastFail?: boolean; reason?: string }): RetryError {
  const e = new Error(message) as RetryError;
  if (opts.fastFail) e.fastFail = true;
  if (opts.reason) e.reason = opts.reason;
  return e;
}

/**
 * Cliente que imita `anthropic.messages.create`. Traduce a `/v1/chat/completions`.
 * - Reintentos con backoff exponencial+jitter en 429/5xx y errores de red; 4xx no-429 fallan al instante.
 * - `streamHook` (opcional): si el preset es Groq/OpenRouter, consume SSE y emite tokens en tiempo real.
 * - `onRetry` (opcional): observabilidad de cada reintento.
 * - `sleep` inyectable: para tests sin temporizadores reales.
 */
export class OpenAICompatClient {
  readonly messages: { create: (params: any) => Promise<Anthropic.Message> };

  constructor(
    private cfg: OpenAIPresetConfig,
    private streamHook?: StreamHook,
    private onRetry?: (attempt: number, waitMs: number, reason: string) => void,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
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
    // Streaming solo si hay hook Y el proveedor declara soportarlo (capacidad explícita del preset).
    const useStream = !!this.streamHook && !!this.cfg.supportsStream;

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return useStream ? await this.attemptStream(url, headers, body) : await this.attemptOnce(url, headers, body);
      } catch (e) {
        const err = e as RetryError;
        lastErr = err;
        if (err.fastFail) throw err; // 4xx no-429 → no reintentar
        if (attempt === MAX_ATTEMPTS - 1) break; // último intento: sin sleep
        const waitMs = calcDelay(attempt);
        this.onRetry?.(attempt + 1, waitMs, err.reason ?? err.message);
        await this.sleep(waitMs);
      }
    }
    throw new Error(`No se pudo contactar al modelo (${this.cfg.label} · ${this.cfg.baseURL}): ${lastErr?.message ?? "desconocido"}`);
  }

  /** Un intento NO-streaming. Lanza RetryError (reintentable o fastFail) según el status. */
  private async attemptOnce(url: string, headers: Record<string, string>, body: any): Promise<Anthropic.Message> {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status === 429 || res.status >= 500) throw retryError(`${this.cfg.label} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, { reason: `HTTP ${res.status}` });
    if (!res.ok) throw retryError(`${this.cfg.label} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, { fastFail: true });
    return fromOpenAIResponse(await res.json());
  }

  /** Un intento STREAMING (SSE): emite `delta.content` por `streamHook` y acumula tool_calls. */
  private async attemptStream(url: string, headers: Record<string, string>, body: any): Promise<Anthropic.Message> {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...body, stream: true }) });
    if (res.status === 429 || res.status >= 500) throw retryError(`${this.cfg.label} HTTP ${res.status}`, { reason: `HTTP ${res.status}` });
    if (!res.ok) throw retryError(`${this.cfg.label} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, { fastFail: true });
    if (!res.body) throw new Error("respuesta de streaming sin cuerpo"); // reintentable (como error de red)

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let accText = "";
    const toolAccum = new Map<number, { id: string; name: string; args: string }>();
    let model = body.model;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          if (chunk?.model) model = chunk.model;
          const delta = chunk?.choices?.[0]?.delta;
          if (typeof delta?.content === "string" && delta.content.length) {
            accText += delta.content;
            this.streamHook!(delta.content);
          }
          for (const tc of delta?.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            if (!toolAccum.has(idx)) toolAccum.set(idx, { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" });
            const entry = toolAccum.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        } catch {
          /* chunk SSE malformado → se descarta y se sigue acumulando */
        }
      }
    }
    const blocks: any[] = [];
    if (accText.trim()) blocks.push({ type: "text", text: accText });
    for (const [, tc] of [...toolAccum.entries()].sort(([a], [b]) => a - b)) {
      let input: any = {};
      try {
        input = JSON.parse(tc.args || "{}");
      } catch {
        input = {};
      }
      blocks.push({ type: "tool_use", id: tc.id || `call_${blocks.length}`, name: tc.name, input });
    }
    const hadTool = toolAccum.size > 0;
    return {
      id: "stream_msg",
      type: "message",
      role: "assistant",
      model,
      content: blocks as any,
      stop_reason: hadTool ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
    } as Anthropic.Message;
  }
}

// Exporta helpers internos para tests unitarios (incluye calcDelay para probar el backoff sin timers).
export const __test = { toOpenAITools, toOpenAIMessages, fromOpenAIResponse, calcDelay };
