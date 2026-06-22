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

/** Resuelve el modelo: explícito > env NAVIA_MODEL > default. Usado por todos los flujos Anthropic. */
export function resolveModel(model?: string): string {
  return model ?? process.env.NAVIA_MODEL ?? DEFAULT_MODEL;
}

export function configPath(): string {
  return path.join(os.homedir(), ".navia", "config.json");
}

/** Lee la config de forma SÍNCRONA (para poder usarla como default de las opciones del CLI). */
export function loadConfigSync(): NaviaConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as NaviaConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: NaviaConfig): string {
  const file = configPath();
  mkdirSync(path.dirname(file), { recursive: true });
  // Quita claves vacías para mantener el archivo limpio.
  const clean = Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined && v !== "")) as NaviaConfig;
  writeFileSync(file, JSON.stringify(clean, null, 2), "utf8");
  return file;
}
