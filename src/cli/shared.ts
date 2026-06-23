/**
 * Estado y opciones compartidas por los comandos del CLI: la config persistente del usuario
 * (~/.navia/config.json, defaults para no repetir flags), el tipo RunFlags y el grupo de
 * opciones de navegador/IA reutilizable (browserOpt) que aplican `run` y `start`.
 */
import type { Command } from "commander";
import type { BrowserEngine } from "../browser/launch.js";
import { loadConfigSync, type NaviaConfig } from "../config.js";

// Config persistente del usuario (~/.navia/config.json): defaults para no repetir flags.
export const cfg: NaviaConfig = loadConfigSync();

export interface RunFlags {
  browser: BrowserEngine;
  model?: string;
  headless?: boolean;
  slowMo?: string;
  cdpPort?: string;
  cdpEndpoint?: string;
  startUrl?: string;
  maxSteps?: string;
  profile?: string;
  provider?: "auto" | "api" | "claude-cli" | "openai";
  cliCommand?: string;
  openaiPreset?: string;
  record?: boolean | string;
  yes?: boolean;
  workspace?: boolean | string;
  chat?: boolean;
  validate?: boolean;
  memory?: boolean;
  eval?: boolean;
  allowDomain?: string[];
  captcha?: "off" | "local";
}

/** Grupo de opciones de navegador/IA reutilizable (las comparten `run` y `start`). */
export const browserOpt = (cmd: Command) =>
  cmd
    .option("-b, --browser <engine>", "motor: chromium | firefox | chrome | patchright", (process.env.NAVIA_BROWSER as BrowserEngine) || cfg.browser || "chromium")
    .option("-m, --model <model>", "modelo de Claude (default claude-sonnet-4-6)", cfg.model)
    .option("--headless", "ejecutar sin ventana visible")
    .option("--slow-mo <ms>", "ralentizar acciones N ms (útil para anti-bot)")
    .option("--cdp-port <port>", "puerto de depuración para --browser chrome (default 9222)")
    .option("--cdp-endpoint <url>", "conectar a un Chrome ya abierto, ej http://localhost:9222")
    .option("--start-url <url>", "abrir esta URL antes de empezar")
    .option("-p, --profile <name>", "usar un perfil guardado con 'navia login' (arranca autenticado)", cfg.profile)
    .option("--provider <p>", "motor de IA: auto | api | claude-cli | openai (auto: API key si existe, si no el CLI claude)", cfg.provider || "auto")
    .option("--cli-command <bin>", "binario del CLI para --provider claude-cli: 'ant' (recomendado, completado limpio) o 'claude' (fallback). Default claude")
    .option("--openai-preset <p>", "para --provider openai (IA GRATIS, endpoint OpenAI-compatible): groq | openrouter | ollama. O configura NAVIA_OPENAI_BASE_URL/_API_KEY/_MODEL")
    .option("--record [path]", "registrar la corrida en JSONL (default ~/.navia/trajectories/; o una ruta. Tip: usa --workspace para bitácora completa)")
    .option("--workspace [dir]", "crear carpeta-bitácora (memoria) por tarea (auto: Obsidian/Escritorio, o la ruta dada)")
    .option("--yes", "auto-aprobar acciones irreversibles (¡solo entornos de prueba!)")
    .option("--chat", "modo conversación: al terminar, mantiene el navegador y pide la siguiente tarea")
    .option("--validate", "validación post-tarea: al terminar, un juez verifica el resultado y reintenta una vez si no se cumplió")
    .option("--captcha <modo>", "captcha de imagen: local (OCR local automático, default) | off (lo escribe la persona)", "local")
    .option("--no-memory", "no inyectar ni guardar playbooks por dominio (memoria de sitio)")
    .option("--no-eval", "deshabilitar la tool 'evaluate' (ejecución de JS) — recomendado en sitios no confiables")
    .option(
      "--allow-domain <dominio>",
      "allow-list de red: solo permite peticiones a estos dominios (repetible; anti-exfiltración)",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option("--max-steps <n>", "máximo de pasos (default 60)");
