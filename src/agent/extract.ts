/**
 * `extract` — extracción ESTRUCTURADA y tipada desde la página.
 *
 * Das un schema JSON (lo que quieres) + una instrucción; Navia lee la página
 * (texto + árbol de accesibilidad) y devuelve un objeto que cumple el schema.
 * Usa el mecanismo de "tool use" de la API: forzamos una tool cuyo input_schema
 * ES tu schema, así el modelo SOLO puede responder con datos conformes (con
 * reintento si no lo hace). Es la primitiva que faltaba para web → datos.
 *
 * @example
 * ```ts
 * import { extract } from "navia-ai";
 * const data = await extract({
 *   url: "https://news.ycombinator.com",
 *   instruction: "las 5 noticias principales con título y puntos",
 *   schema: {
 *     type: "object",
 *     properties: {
 *       items: {
 *         type: "array",
 *         items: { type: "object", properties: { title: { type: "string" }, points: { type: "number" } }, required: ["title"] },
 *       },
 *     },
 *     required: ["items"],
 *   },
 * });
 * ```
 */
import Anthropic from "@anthropic-ai/sdk";
import os from "node:os";
import path from "node:path";
import { BrowserDriver } from "../browser/driver.js";
import { loadSession } from "../browser/session-store.js";
import type { BrowserEngine } from "../browser/launch.js";

export interface ExtractOptions {
  /** Qué extraer, en lenguaje natural. */
  instruction: string;
  /** Schema JSON de la forma deseada. La raíz puede ser cualquier tipo (se envuelve si no es objeto). */
  schema: Record<string, any>;
  /** URL a abrir antes de extraer. Si se omite, usa un `driver` ya provisto o falla. */
  url?: string;
  /** Driver ya abierto (para extraer de la página actual sin relanzar el navegador). */
  driver?: BrowserDriver;
  browser?: BrowserEngine;
  headless?: boolean;
  /** Perfil guardado con `navia login` (arranca autenticado). */
  profile?: string;
  apiKey?: string;
  model?: string;
}

const DEFAULT_MODEL = "claude-sonnet-4-6";
const MAX_CHARS = 14000; // recorte del contenido para no inflar el prompt/coste.

/** Envuelve schemas con raíz no-objeto para poder usarlos como input_schema de una tool. */
function asObjectSchema(schema: Record<string, any>): { schema: Anthropic.Tool["input_schema"]; wrapped: boolean } {
  if (schema && schema.type === "object") return { schema: schema as Anthropic.Tool["input_schema"], wrapped: false };
  return {
    schema: { type: "object", properties: { result: schema }, required: ["result"] } as Anthropic.Tool["input_schema"],
    wrapped: true,
  };
}

/**
 * Extrae datos estructurados de una página y los devuelve tipados (validados contra `schema`).
 * Lanza si no consigue una respuesta conforme tras el reintento.
 */
export async function extract<T = unknown>(opts: ExtractOptions): Promise<T> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("extract requiere ANTHROPIC_API_KEY (pásala en opts.apiKey o como variable de entorno).");

  const ownsDriver = !opts.driver;
  let driver = opts.driver;
  if (!driver) {
    const engine = opts.browser ?? "chromium";
    let storageState: unknown;
    let userDataDir: string | undefined;
    if (opts.profile) {
      if (engine === "chrome") userDataDir = path.join(os.homedir(), ".navia", "profiles", `chrome-${opts.profile}`);
      else storageState = (await loadSession(opts.profile)) ?? undefined;
    }
    driver = await BrowserDriver.create({ engine, headless: opts.headless, userDataDir, storageState });
  }

  try {
    if (opts.url) await driver.navigate(opts.url);
    const [text, snapshot] = await Promise.all([driver.readText().catch(() => ""), driver.snapshot().catch(() => "")]);
    const pageContent = `TEXTO DE LA PÁGINA:\n${text}\n\nESTRUCTURA (árbol de accesibilidad):\n${snapshot}`.slice(0, MAX_CHARS);

    const { schema, wrapped } = asObjectSchema(opts.schema);
    const client = new Anthropic({ apiKey, maxRetries: 4 });
    const tool: Anthropic.Tool = {
      name: "extract",
      description: "Devuelve los datos extraídos de la página conforme al schema. Usa null/omite los campos que no encuentres; no inventes.",
      input_schema: schema,
    };

    const userMsg = (extraHint = "") =>
      `Extrae de la siguiente página exactamente esto: ${opts.instruction}\n\nDevuelve el resultado llamando a la tool "extract". No inventes datos: si algo no está, omítelo o ponlo en null.${extraHint}\n\n${pageContent}`;

    // Hasta 2 intentos: forzamos la tool; si el modelo no la usa, reintentamos insistiendo.
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await client.messages.create({
        model: opts.model ?? process.env.NAVIA_MODEL ?? DEFAULT_MODEL,
        max_tokens: 4096,
        tools: [tool],
        tool_choice: { type: "tool", name: "extract" },
        messages: [{ role: "user", content: userMsg(attempt ? "\n\n(Intento previo no devolvió la tool; responde SOLO llamando a extract.)" : "") }],
      });
      const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "extract");
      if (toolUse) {
        const data = toolUse.input as Record<string, unknown>;
        return (wrapped ? (data as { result: T }).result : (data as T));
      }
    }
    throw new Error("extract no obtuvo una respuesta conforme al schema tras 2 intentos.");
  } finally {
    if (ownsDriver) await driver.close();
  }
}
