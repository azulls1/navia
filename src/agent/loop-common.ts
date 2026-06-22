/**
 * Helpers COMPARTIDOS por los dos loops de agente (agent.ts API y cli-agent.ts CLI).
 * Antes estaban copiados en ambos y divergían (causa de bugs "según el motor"). Centralizarlos
 * aquí garantiza que login-guard, hooks por defecto, resolución de perfil y el prefijo de
 * "nueva tarea" se comporten IGUAL en los dos caminos.
 */
import os from "node:os";
import path from "node:path";
import type { BrowserDriver } from "../browser/driver.js";
import type { BrowserEngine } from "../browser/launch.js";
import { loadSession } from "../browser/session-store.js";
import type { AgentHooks } from "./tools.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { tipsBlockFor } from "./domain-memory.js";

/** Prefijo del mensaje al encadenar una nueva tarea en la misma sesión (modo chat/conversacional). */
export const NEXT_TASK_PREFIX = "Nueva tarea (misma sesión del navegador):";

export interface NaviaMetrics {
  steps: number;
  toolCalls: number;
  toolErrors: number;
  /** Tokens de entrada (incluye cache read/creation) y de salida (solo provider API). */
  tokensIn: number;
  tokensOut: number;
  /** Acciones exitosas que siguieron a un error (recuperación). */
  recoveries: number;
  /** Llamadas idénticas consecutivas (señal de bucle/atasco). */
  loopHits: number;
}

/**
 * Métricas del loop, encapsuladas. Antes los contadores + `lastSig`/`lastWasError` estaban sueltos
 * y DUPLICADOS en los dos loops (fácil de desincronizar). Es una clase pura (sin I/O) → testeable.
 * `implements NaviaMetrics` → la instancia se devuelve tal cual como `result.metrics`.
 */
export class LoopMetrics implements NaviaMetrics {
  steps = 0;
  toolCalls = 0;
  toolErrors = 0;
  tokensIn = 0;
  tokensOut = 0;
  recoveries = 0;
  loopHits = 0;
  private lastSig = "";
  private lastWasError = false;

  /** Registra una llamada a tool; cuenta `loopHits` si la firma (nombre+args) repite la anterior. */
  recordCall(name: string, input: unknown): void {
    this.toolCalls++;
    const sig = `${name}:${JSON.stringify(input ?? {})}`;
    if (sig === this.lastSig) this.loopHits++;
    this.lastSig = sig;
  }
  /** Tool ejecutada con éxito; si venía de un error, cuenta una recuperación. */
  recordSuccess(): void {
    if (this.lastWasError) this.recoveries++;
    this.lastWasError = false;
  }
  /** Tool que lanzó (error propagado). */
  recordError(): void {
    this.toolErrors++;
    this.lastWasError = true;
  }
  addTokens(input: number, output: number): void {
    this.tokensIn += input;
    this.tokensOut += output;
  }
}

/**
 * Construye el system prompt inyectando la memoria por dominio (playbooks/tips de `startUrl`).
 * Única definición (antes copiada en ambos loops). Devuelve el STRING; cada loop lo envuelve a su
 * manera (bloque con cache_control en API, texto plano en CLI).
 */
export async function buildSystemWithMemory(
  opts: { systemExtra?: string; memory?: boolean; startUrl?: string },
  log?: (m: string) => void,
): Promise<string> {
  const memoryExtra = opts.memory === false ? "" : await tipsBlockFor(opts.startUrl);
  if (memoryExtra) log?.(`🧠 Playbook del dominio cargado (${memoryExtra.split("\n").length - 1} tip(s)).`);
  return buildSystemPrompt([opts.systemExtra, memoryExtra].filter(Boolean).join("\n\n") || undefined);
}

/** Rellena los hooks opcionales con no-ops seguros. Única definición (antes duplicada 2 veces). */
export function withDefaultHooks(partial?: Partial<AgentHooks>): AgentHooks {
  return {
    confirmAction: partial?.confirmAction ?? (async () => false),
    waitForHuman: partial?.waitForHuman ?? (async () => ""),
    log: partial?.log,
    onTaskSummary: partial?.onTaskSummary,
    nextTask: partial?.nextTask,
    rememberNote: partial?.rememberNote,
  };
}

/**
 * Resuelve cómo arrancar autenticado a partir de un perfil: en `chrome` (CDP) la persistencia es el
 * userDataDir; en los demás motores se inyecta el storageState cifrado guardado. Única definición
 * (antes copiada en agent.ts, cli-agent.ts, extract.ts, primitives.ts, replay.ts, mcp/server.ts).
 */
export async function resolveProfileState(
  engine: BrowserEngine,
  profile: string | undefined,
  userDataDir: string | undefined,
): Promise<{ userDataDir?: string; storageState?: unknown; loaded: boolean }> {
  if (!profile) return { userDataDir, storageState: undefined, loaded: false };
  if (engine === "chrome") {
    return { userDataDir: userDataDir ?? path.join(os.homedir(), ".navia", "profiles", `chrome-${profile}`), loaded: true };
  }
  const storageState = (await loadSession(profile)) ?? undefined;
  return { userDataDir, storageState, loaded: storageState != null };
}

/**
 * Login-guard común: tras un "fin" del modelo, si estábamos en un login, verifica de VERDAD si entró
 * (mata el falso positivo "el form desapareció = entré"). Devuelve el mensaje de re-inyección a
 * empujar al loop (cada motor decide cómo: bloque de mensaje o línea de transcript) o null si OK.
 * Antes el bloque estaba duplicado en ambos loops y el texto ya divergía.
 */
export async function assessLoginReinjection(
  driver: BrowserDriver,
  startUrl: string | undefined,
  log?: (m: string) => void,
): Promise<{ message: string; detail: string } | null> {
  const outcome = await driver.assessLoginOutcome(startUrl);
  if (outcome.status !== "failed") return null;
  log?.(`🔎 Login NO confirmado: ${outcome.detail}`);
  return {
    detail: outcome.detail,
    message:
      `Verificación automática de login: NO tuvo éxito (${outcome.detail}). NO declares éxito. ` +
      `Reintenta así: 1 snapshot → reescribe el usuario → fill_credential la contraseña → pulsa 'Ingresar' ` +
      `(el sistema rellena el captcha solo). NO leas ni teclees el captcha tú. Si tras 2-3 intentos sigue ` +
      `fallando, resume el fallo y termina.`,
  };
}
