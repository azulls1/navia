/**
 * Config persistente de Navia (#15): valores por defecto en ~/.navia/config.json para no
 * repetir flags. Precedencia: flag de CLI > variable de entorno > config > default interno.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserEngine } from "./browser/launch.js";

export interface NaviaConfig {
  model?: string;
  browser?: BrowserEngine;
  profile?: string;
  provider?: "auto" | "api" | "claude-cli" | "openai";
  workspace?: boolean | string;
}

/** Modelo de Claude por defecto (única fuente de verdad para todos los módulos). */
export const DEFAULT_MODEL = "claude-sonnet-4-6";
/** Máximo de pasos por defecto del loop de agente. */
export const DEFAULT_MAX_STEPS = 60;
/** Recorte del contenido de página inyectado al prompt en extract/observe (control de coste). */
export const EXTRACT_MAX_CHARS = 14000;

/** Resuelve el modelo: explícito > env NAVIA_MODEL > default. Usado por todos los flujos Anthropic. */
export function resolveModel(model?: string): string {
  return model ?? process.env.NAVIA_MODEL ?? DEFAULT_MODEL;
}

export function configPath(): string {
  return path.join(os.homedir(), ".navia", "config.json");
}

const VALID_BROWSERS = new Set(["chromium", "chrome", "firefox", "patchright"]);
const VALID_PROVIDERS = new Set(["auto", "api", "claude-cli", "openai"]);

/**
 * Valida el contenido de config.json contra el esquema NaviaConfig: rechaza tipos/valores inválidos
 * con un mensaje claro (en vez de fallos silenciosos más adelante) e IGNORA campos desconocidos
 * (compatibilidad hacia adelante). Lanza si la raíz no es un objeto plano.
 */
export function validateConfig(raw: unknown): NaviaConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.json: el valor raíz debe ser un objeto, se obtuvo ${Array.isArray(raw) ? "array" : raw === null ? "null" : typeof raw}`);
  }
  const obj = raw as Record<string, unknown>;
  const out: NaviaConfig = {};
  if ("model" in obj) {
    if (typeof obj.model !== "string") throw new Error(`config.json: el campo "model" debe ser string, se obtuvo ${typeof obj.model}`);
    out.model = obj.model;
  }
  if ("browser" in obj) {
    if (!VALID_BROWSERS.has(obj.browser as string)) throw new Error(`config.json: el campo "browser" tiene un valor inválido "${obj.browser}"; se esperaba uno de ${[...VALID_BROWSERS].join(", ")}`);
    out.browser = obj.browser as BrowserEngine;
  }
  if ("provider" in obj) {
    if (!VALID_PROVIDERS.has(obj.provider as string)) throw new Error(`config.json: el campo "provider" tiene un valor inválido "${obj.provider}"; se esperaba uno de ${[...VALID_PROVIDERS].join(", ")}`);
    out.provider = obj.provider as NaviaConfig["provider"];
  }
  if ("workspace" in obj) {
    if (typeof obj.workspace !== "boolean" && typeof obj.workspace !== "string") throw new Error(`config.json: el campo "workspace" debe ser boolean o string, se obtuvo ${typeof obj.workspace}`);
    out.workspace = obj.workspace as NaviaConfig["workspace"];
  }
  if ("profile" in obj) {
    if (typeof obj.profile !== "string") throw new Error(`config.json: el campo "profile" debe ser string, se obtuvo ${typeof obj.profile}`);
    out.profile = obj.profile;
  }
  return out;
}

/** Lee la config de forma SÍNCRONA (para poder usarla como default de las opciones del CLI). */
export function loadConfigSync(): NaviaConfig {
  const file = configPath();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; // sin archivo → config vacía
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${file}: el contenido no es JSON válido.`);
  }
  return validateConfig(raw);
}

export function saveConfig(cfg: NaviaConfig): string {
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  // Quita claves vacías para mantener el archivo limpio.
  const clean = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== "")) as NaviaConfig;
  writeFileSync(file, JSON.stringify(clean, null, 2), "utf8");
  return file;
}
