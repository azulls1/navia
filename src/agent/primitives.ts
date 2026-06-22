/**
 * Primitivas `observe` y `act` (el "dial" estilo Stagehand, #7 del roadmap).
 *
 * Navia es agent-loop-first (`runNavia`), pero a veces quieres control DETERMINISTA: ver qué
 * acciones cumplirían una intención SIN ejecutarlas (`observe`) y luego ejecutar exactamente
 * una (`act`) sin volver a llamar al LLM. Junto con `extract` (datos tipados) y `runNavia`
 * (agente autónomo) completan las 4 primitivas:
 *
 *   observe → propone acciones candidatas (1 llamada LLM, no toca la página)
 *   act     → ejecuta una acción (por ref, SIN LLM) o, desde un string, observa y ejecuta la 1ª
 *   extract → web a datos tipados (ver extract.ts)
 *   agent   → loop autónomo (ver runNavia)
 *
 * @example
 * ```ts
 * import { BrowserDriver, observe, act } from "navia-ai";
 * const driver = await BrowserDriver.create({ engine: "chromium" });
 * await driver.navigate("https://example.com");
 * const [first] = await observe({ instruction: "el enlace 'Learn more'", driver });
 * await act(first, { driver });           // determinista, sin LLM
 * // o directo:  await act("haz clic en 'Learn more'", { driver });
 * ```
 */
import Anthropic from "@anthropic-ai/sdk";
import { BrowserDriver } from "../browser/driver.js";
import type { BrowserEngine } from "../browser/launch.js";
import { resolveModel } from "../config.js";
import { resolveProfileState } from "./loop-common.js";

export interface ObserveAction {
  action: "click" | "type" | "select_option" | "press_key";
  /** ref del snapshot (click/type/select_option). */
  ref?: string;
  /** texto a escribir (type). */
  text?: string;
  /** opciones a elegir (select_option). */
  values?: string[];
  /** tecla a pulsar (press_key). */
  key?: string;
  /** qué hace esta acción, en lenguaje natural. */
  description: string;
}

export interface ObserveOptions {
  /** Qué buscar/hacer, en lenguaje natural. */
  instruction: string;
  /** URL a abrir antes de observar. Si se omite, usa `driver` o crea uno y observa en blanco. */
  url?: string;
  /** Driver ya abierto (para observar la página actual sin relanzar el navegador). */
  driver?: BrowserDriver;
  browser?: BrowserEngine;
  headless?: boolean;
  /** Perfil guardado con `navia login` (arranca autenticado). */
  profile?: string;
  apiKey?: string;
  model?: string;
  /** Máximo de acciones candidatas a devolver (default 10). */
  limit?: number;
}

export interface ActResult {
  action: ObserveAction;
  changed: boolean;
  url: string;
  snapshot: string;
}

const MAX_CHARS = 14000;

async function ensureDriver(opts: ObserveOptions): Promise<{ driver: BrowserDriver; owns: boolean }> {
  if (opts.driver) return { driver: opts.driver, owns: false };
  const engine = opts.browser ?? "chromium";
  const { userDataDir, storageState } = await resolveProfileState(engine, opts.profile, undefined);
  return { driver: await BrowserDriver.create({ engine, headless: opts.headless, userDataDir, storageState }), owns: true };
}

const PROPOSE_TOOL: Anthropic.Tool = {
  name: "propose_actions",
  description: "Propón las acciones candidatas (SIN ejecutarlas) que cumplirían la instrucción, en orden, usando refs EXACTOS del snapshot.",
  input_schema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["click", "type", "select_option", "press_key"] },
            ref: { type: "string", description: "ref del snapshot, copiado tal cual (ej. v3:42)" },
            text: { type: "string", description: "texto a escribir (type)" },
            values: { type: "array", items: { type: "string" }, description: "opciones (select_option)" },
            key: { type: "string", description: "tecla (press_key)" },
            description: { type: "string", description: "qué hace esta acción" },
          },
          required: ["action", "description"],
        },
      },
    },
    required: ["actions"],
  },
};

/**
 * Propone (sin ejecutar) las acciones candidatas que cumplirían una instrucción sobre la
 * página actual. 1 llamada al LLM; devuelve acciones tipadas listas para `act`. Requiere API key.
 */
export async function observe(opts: ObserveOptions): Promise<ObserveAction[]> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("observe requiere ANTHROPIC_API_KEY (pásala en opts.apiKey o como variable de entorno).");

  const { driver, owns } = await ensureDriver(opts);
  try {
    if (opts.url) await driver.navigate(opts.url);
    const snapshot = await driver.snapshot();
    const client = new Anthropic({ apiKey, maxRetries: 4 });
    const resp = await client.messages.create({
      model: resolveModel(opts.model),
      max_tokens: 2048,
      tools: [PROPOSE_TOOL],
      tool_choice: { type: "tool", name: "propose_actions" },
      messages: [
        {
          role: "user",
          content: `Instrucción: ${opts.instruction}\n\nDevuelve SOLO las acciones candidatas (no ejecutes nada) llamando a propose_actions, en orden. Usa refs EXACTOS del snapshot.\n\nSNAPSHOT:\n${snapshot.slice(0, MAX_CHARS)}`,
        },
      ],
    });
    const tu = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "propose_actions");
    const actions = ((tu?.input as any)?.actions ?? []) as ObserveAction[];
    return opts.limit ? actions.slice(0, opts.limit) : actions;
  } finally {
    if (owns) await driver.close();
  }
}

async function execAction(driver: BrowserDriver, a: ObserveAction): Promise<void> {
  switch (a.action) {
    case "click":
      if (!a.ref) throw new Error("act: la acción click requiere 'ref'");
      return driver.click(a.ref);
    case "type":
      if (!a.ref) throw new Error("act: la acción type requiere 'ref'");
      return driver.type(a.ref, a.text ?? "");
    case "select_option":
      if (!a.ref) throw new Error("act: la acción select_option requiere 'ref'");
      return driver.selectOption(a.ref, a.values ?? []);
    case "press_key":
      if (!a.key) throw new Error("act: la acción press_key requiere 'key'");
      return driver.pressKey(a.key);
    default:
      throw new Error(`act: acción no soportada "${(a as any).action}"`);
  }
}

/**
 * Ejecuta UNA acción sobre un driver abierto. Si recibe un `ObserveAction` la ejecuta de forma
 * DETERMINISTA por su ref (sin LLM); si recibe un string, observa y ejecuta la primera candidata.
 * Devuelve si la página cambió + el snapshot resultante (change-observation).
 *
 * Nota: un `ObserveAction` de un `observe` ANTERIOR puede traer un ref ya caducado (el snapshot
 * avanzó) → la acción se rechaza con aviso; vuelve a `observe` y `act` seguidos.
 */
export async function act(
  target: ObserveAction | string,
  opts: { driver: BrowserDriver; apiKey?: string; model?: string },
): Promise<ActResult> {
  const driver = opts.driver;
  if (!driver) throw new Error("act requiere un driver abierto (opts.driver).");
  let action: ObserveAction;
  if (typeof target === "string") {
    const proposals = await observe({ instruction: target, driver, apiKey: opts.apiKey, model: opts.model });
    if (!proposals.length) throw new Error(`act: no encontré ninguna acción para "${target}"`);
    action = proposals[0];
  } else {
    action = target;
  }
  await execAction(driver, action);
  const obs = await driver.observe();
  return { action, changed: obs.changed, url: obs.url, snapshot: obs.snapshot };
}
