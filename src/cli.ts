#!/usr/bin/env node
/**
 * CLI `navia`.
 *
 *   navia "abre example.com y dime el título"            # tarea con el navegador por defecto
 *   navia run "..." --browser firefox                    # elegir motor
 *   navia run "..." --browser chrome                     # Chrome real vía CDP (anti-Cloudflare)
 *   navia chrome                                         # solo lanzar Chrome real con depuración
 *   navia login <perfil>                                 # iniciar sesión y guardar perfil
 *   navia secret set <clave>                             # guardar un secreto cifrado
 */
import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { runNavia, resolveProvider } from "./agent/agent.js";
import { BrowserDriver } from "./browser/driver.js";
import { saveSession } from "./browser/session-store.js";
import { setSecret, setTotp, listKeys } from "./secrets/vault.js";
import { startMcpServer } from "./mcp/server.js";
import os from "node:os";
import path from "node:path";
import type { BrowserEngine } from "./browser/launch.js";
import { loadConfigSync, saveConfig, type NaviaConfig } from "./config.js";

loadEnv({ quiet: true });

// Config persistente del usuario (~/.navia/config.json): defaults para no repetir flags.
const cfg: NaviaConfig = loadConfigSync();

// Silencia SOLO el DeprecationWarning DEP0190 (spawn con shell:true + args). Los CLIs de IA
// en Windows (claude.cmd/ant.cmd) requieren shell; el contenido no confiable viaja por stdin,
// no por argv, así que la advertencia no aplica a nuestro uso. No silencia otros warnings.
const _origEmitWarning = process.emitWarning.bind(process);
(process as any).emitWarning = (warning: unknown, ...rest: any[]): void => {
  const code = rest[0] && typeof rest[0] === "object" ? rest[0].code : rest[1];
  if (code === "DEP0190") return;
  (_origEmitWarning as any)(warning, ...rest);
};

const program = new Command();

program
  .name("navia")
  .description("Agente de navegador autónomo con IA (Claude). Opera Chrome o Firefox reales con una instrucción.")
  .version("0.26.1");

interface RunFlags {
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

/**
 * Pregunta al inicio DÓNDE guardar la bitácora/memoria. Portátil: las opciones se
 * construyen en runtime según el equipo (vaults de Obsidian detectados, base por
 * defecto del SO, o una ruta a mano). Devuelve la carpeta base elegida.
 */
async function chooseWorkspace(existing?: ReturnType<typeof createInterface>): Promise<string | undefined> {
  const { detectObsidianVaults, defaultWorkspaceBase } = await import("./agent/workspace.js");
  const vaults = detectObsidianVaults();
  const folderBase = defaultWorkspaceBase();
  const rl = existing ?? createInterface({ input, output });
  const ownRl = !existing;
  try {
    console.log(pc.cyan("\n🧠 ¿Dónde guardo la bitácora/memoria de esta tarea?"));
    const choices: string[] = [];
    console.log(`  ${choices.length + 1}) Crear carpeta en  ${pc.dim(path.join(folderBase, "Navia Runs"))}`);
    choices.push(path.join(folderBase, "Navia Runs"));
    for (const v of vaults) {
      console.log(`  ${choices.length + 1}) Vault de Obsidian ${pc.dim(path.join(v, "Navia Runs"))}`);
      choices.push(path.join(v, "Navia Runs"));
    }
    const customIdx = choices.length + 1;
    console.log(`  ${customIdx}) Ruta personalizada…`);
    const ans = (await rl.question(pc.cyan(`Elige [1-${customIdx}] (Enter=1): `))).trim();
    const n = ans ? Number.parseInt(ans, 10) : 1;
    if (n === customIdx) {
      const custom = (await rl.question(pc.cyan("Escribe la ruta donde guardar: "))).trim();
      return custom || choices[0];
    }
    return choices[n - 1] ?? choices[0];
  } finally {
    if (ownRl) rl.close();
  }
}

/**
 * Pregunta de entrada OCULTA reutilizando el MISMO readline del wizard (no abre/cierra
 * otro, lo que dejaba un salto de línea fantasma que la siguiente pregunta se comía).
 * Enmascara lo tecleado redibujando solo el prompt en cada pulsación.
 */
function askHidden(rl: ReturnType<typeof createInterface>, query: string): Promise<string> {
  const onData = (buf: Buffer) => {
    const s = buf.toString();
    if (s === "\n" || s === "\r" || s === "\r\n" || s === "") return; // Enter/EOT: no enmascarar
    output.write("\x1b[2K\r" + query); // borra la línea y reescribe solo el prompt (oculta el valor)
  };
  process.stdin.on("data", onData);
  return rl.question(query).then((v) => {
    process.stdin.removeListener("data", onData);
    return v.trim();
  });
}

/**
 * Hace que pulsar ESC salga de Navia limpiamente mientras se responden los prompts del wizard.
 * Usa los eventos `keypress` que readline ya emite en modo terminal. Devuelve un detach() para
 * dejar de escuchar (p.ej. antes de lanzar la tarea, para no cortar una sesión con navegador).
 */
function attachEscToExit(rl: ReturnType<typeof createInterface>): () => void {
  if (!input.isTTY) return () => {};
  emitKeypressEvents(input);
  const onKey = (_s: string, key: { name?: string } | undefined): void => {
    if (key?.name === "escape") {
      input.removeListener("keypress", onKey);
      output.write(pc.dim("\n\n👋 Saliendo de Navia (ESC).\n"));
      try {
        rl.close();
      } catch {
        /* noop */
      }
      try {
        input.setRawMode?.(false);
      } catch {
        /* noop */
      }
      process.exit(0);
    }
  };
  input.on("keypress", onKey);
  return () => input.removeListener("keypress", onKey);
}

/**
 * Baja el HTML de una URL con un GET de bajo nivel. Usa `rejectUnauthorized:false` SOLO para esta
 * sonda de detección (lee HTML público para ver si hay login; NO envía credenciales): algunos
 * sitios (p.ej. CFE) tienen cadenas de certificado que el fetch estricto de Node rechaza pero el
 * navegador acepta. Sigue hasta 3 redirecciones; timeout 8s; corta a ~600KB.
 */
async function fetchHtml(url: string, redirects = 3): Promise<string> {
  const { request } = await import(url.startsWith("https") ? "node:https" : "node:http");
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        rejectUnauthorized: false,
        timeout: 8000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      },
      (res: any) => {
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc && redirects > 0) {
          res.resume();
          resolve(fetchHtml(new URL(loc, url).href, redirects - 1));
          return;
        }
        let data = "";
        res.on("data", (c: Buffer) => {
          data += c.toString();
          if (data.length > 600_000) req.destroy();
        });
        res.on("end", () => resolve(data));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Detección rápida (sin abrir navegador) de si una página tiene login: baja el HTML y busca un
 * campo de contraseña o palabras clave. true si detecta login; false/null si no (en cuyo caso el
 * wizard pregunta, por si es una SPA que renderiza el login con JS).
 */
async function detectLoginOnPage(url?: string): Promise<boolean | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  // 2 intentos: la sonda de red puede fallar puntualmente (timeout/TLS) → no queremos un falso "no".
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = (await fetchHtml(url)).toLowerCase();
      if (/type\s*=\s*["']?password/.test(html)) return true;
      if (/iniciar sesi[oó]n|inicia sesi[oó]n|log\s?in|sign\s?in|contrase|usuario y contrase|acceder/.test(html)) return true;
      return false;
    } catch {
      /* reintenta una vez */
    }
  }
  return null; // no se pudo bajar (red/SPA) → flujo de "usuario opcional"
}

async function runTask(task: string, flags: RunFlags) {
  // Si pidió --workspace SIN ruta y estamos en terminal interactiva (y sin $NAVIA_WORKSPACE),
  // pregunta dónde guardar (carpeta nueva, vault de Obsidian, o ruta a mano).
  if (flags.workspace === true && process.stdin.isTTY && !process.env.NAVIA_WORKSPACE) {
    flags.workspace = await chooseWorkspace();
  }

  const provider = resolveProvider({ task, provider: flags.provider, apiKey: undefined });
  if (provider === "api" && !process.env.ANTHROPIC_API_KEY) {
    console.error(pc.red("✗ Provider 'api' sin ANTHROPIC_API_KEY. Pon la key, usa --provider claude-cli, o instala el CLI `claude`."));
    process.exit(1);
  }
  if (provider === "claude-cli") {
    const bin = flags.cliCommand ?? "claude";
    if (!(await cmdExists(bin))) {
      console.error(
        pc.red(`✗ No hay motor de IA: el CLI "${bin}" no está instalado y no hay ANTHROPIC_API_KEY.`) +
          pc.dim("\n  Soluciones: define ANTHROPIC_API_KEY (--provider api), instala el CLI 'claude'/'ant', usa IA gratis (--provider openai --openai-preset groq|ollama), o pásalo con --cli-command."),
      );
      process.exit(1);
    }
  }
  if (provider === "openai") {
    // IA gratis (Groq/OpenRouter/Ollama…). Validamos que haya key salvo Ollama (local, no la necesita).
    const { resolveOpenAIPreset } = await import("./providers/openai-provider.js");
    const oc = resolveOpenAIPreset(flags.openaiPreset);
    const isLocal = /localhost|127\.0\.0\.1/.test(oc.baseURL);
    if (!isLocal && !oc.apiKey) {
      console.error(
        pc.red(`✗ ${oc.label}: falta API key.`) +
          pc.dim(`\n  Consíguela gratis y expórtala. Groq: GROQ_API_KEY · OpenRouter: OPENROUTER_API_KEY · o genérico: NAVIA_OPENAI_API_KEY. Local sin key: --openai-preset ollama.`),
      );
      process.exit(1);
    }
  }

  const rl = createInterface({ input, output });
  const ask = async (q: string) => (await rl.question(q)).trim();

  const motor =
    provider === "claude-cli"
      ? `${flags.browser} · IA: CLI (${flags.cliCommand ?? "claude"})`
      : provider === "openai"
        ? `${flags.browser} · IA: gratis (${(await import("./providers/openai-provider.js")).resolveOpenAIPreset(flags.openaiPreset).label})`
        : `${flags.browser} · IA: API`;
  console.log(pc.cyan(`\n🌐 Navia — ${motor}\n`) + pc.dim(`Tarea: ${task}\n`));

  try {
    const result = await runNavia({
      task,
      browser: flags.browser,
      model: flags.model,
      headless: flags.headless,
      slowMo: flags.slowMo ? Number(flags.slowMo) : undefined,
      cdpPort: flags.cdpPort ? Number(flags.cdpPort) : undefined,
      cdpEndpoint: flags.cdpEndpoint,
      startUrl: flags.startUrl,
      profile: flags.profile,
      provider: flags.provider,
      cliCommand: flags.cliCommand,
      openaiPreset: flags.openaiPreset,
      record: flags.record,
      workspace: flags.workspace === false ? false : (flags.workspace ?? cfg.workspace), // false = "no" explícito; no reactivar desde cfg
      maxSteps: flags.maxSteps ? Number(flags.maxSteps) : undefined,
      validate: flags.validate,
      memory: flags.memory,
      allowEval: flags.eval,
      allowDomains: flags.allowDomain,
      captcha: flags.captcha,
      hooks: {
        log: (msg) => console.log(pc.dim(msg)),
        confirmAction: async (description) => {
          if (flags.yes) {
            console.log(pc.yellow(`\n⚠️  Auto-aprobado (--yes): ${description}`));
            return true;
          }
          console.log(pc.yellow(`\n⚠️  Acción que requiere confirmación:\n   ${description}`));
          const a = await ask(pc.yellow("¿Aprobar? (s/N): "));
          return a.toLowerCase() === "s" || a.toLowerCase() === "si" || a.toLowerCase() === "y";
        },
        waitForHuman: async (reason) => {
          console.log(pc.yellow(`\n🙋 Necesito que hagas algo en la ventana del navegador:\n   ${reason}`));
          return ask(pc.yellow("Cuando termines, presiona Enter (o escribe una nota): "));
        },
        // Memoria por dominio: una nota dejada en wait_for_human se guarda como tip del sitio.
        rememberNote:
          flags.memory === false
            ? undefined
            : async (url, note) => {
                const { addTip, domainOf } = await import("./agent/domain-memory.js");
                await addTip(url, { note });
                console.log(pc.dim(`🧠 Nota guardada en el playbook de ${domainOf(url) || url}.`));
              },
        // Modo conversación: muestra el resumen de cada tarea…
        onTaskSummary: (summary, steps) => {
          console.log(pc.green(`\n✓ Terminado en ${steps} pasos.\n`));
          console.log(summary);
        },
        // …y, si es chat, pide la siguiente reusando el MISMO navegador/sesión.
        nextTask: flags.chat
          ? async () => {
              const n = await ask(pc.cyan("\n🧠 ¿Qué hago ahora? (Enter o 'salir' para terminar): "));
              const norm = n.toLowerCase();
              // Vacío, palabra exacta corta, o frase que EMPIEZA con intención de salir.
              const quiere_salir =
                !norm ||
                /^(no|nada|ya|listo)$/.test(norm) ||
                /^(salir|sal|exit|quit|q|fin|terminar|termina|cerrar|cierra|adios|adiós|chao|chau|bye)\b/.test(norm);
              return quiere_salir ? null : n;
            }
          : undefined,
      },
    });
    const m = result.metrics;
    if (m) {
      console.log(
        pc.dim(
          `\n📊 ${m.steps} pasos · ${m.toolCalls} tools` +
            (m.toolErrors ? ` (${m.toolErrors} err, ${m.recoveries} recup)` : "") +
            (m.loopHits ? ` · ${m.loopHits} repetidas` : "") +
            (m.tokensIn ? ` · ${m.tokensIn + m.tokensOut} tokens` : ""),
        ),
      );
    }
  } catch (err) {
    console.error(pc.red(`\n✗ Error: ${(err as Error).message}`));
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

/** Banner ASCII de bienvenida (solo en modo interactivo, no en --json/CI). */
function banner(): string {
  const art = [
    "   ███╗   ██╗ █████╗ ██╗   ██╗██╗ █████╗ ",
    "   ████╗  ██║██╔══██╗██║   ██║██║██╔══██╗",
    "   ██╔██╗ ██║███████║██║   ██║██║███████║",
    "   ██║╚██╗██║██╔══██║╚██╗ ██╔╝██║██╔══██║",
    "   ██║ ╚████║██║  ██║ ╚████╔╝ ██║██║  ██║",
    "   ╚═╝  ╚═══╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚═╝  ╚═╝",
  ].join("\n");
  return pc.cyan(art) + pc.dim(`\n   Agente de navegador con IA · v${program.version()}\n`);
}

/**
 * Modo interactivo: da la bienvenida y pregunta todo lo necesario (URL, login,
 * tarea, motor, proveedor), guarda la contraseña en el vault cifrado y ejecuta.
 * Se lanza con `navia` sin tarea, o con `navia start`.
 */
/** Detecta si Navia corre DENTRO de otra IA/agente (Claude Code, OpenCode, Cursor…). */
function detectAgentHost(): string | null {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "Claude Code";
  if (process.env.OPENCODE || process.env.OPENCODE_BIN) return "OpenCode";
  if (process.env.OPENCLAW) return "OpenClaw";
  if (process.env.CURSOR_AGENT || process.env.CURSOR_TRACE_ID) return "Cursor";
  return null;
}

async function runWizard(base: Partial<RunFlags>): Promise<void> {
  // No-interactivo (lo ejecuta otra IA/agente o un pipe): el wizard no puede pedir datos → no colgar.
  if (!process.stdin.isTTY) {
    const host = detectAgentHost();
    console.error(pc.yellow(`\n⚠️  Modo interactivo no disponible${host ? ` (detecté: ${host})` : " (no hay terminal interactiva)"}.`));
    console.error(pc.dim("El wizard necesita una terminal real para hacerte preguntas. Opciones:\n"));
    console.error(pc.cyan("  • En una terminal real:    ") + 'npx navia-ai start');
    console.error(pc.cyan("  • Dentro de una IA (MCP):  ") + "npx navia-ai mcp" + pc.dim("   (añádelo a tu cliente MCP)"));
    console.error(pc.cyan("  • Sin preguntas (flags):   ") + 'npx navia-ai run "tu tarea" --start-url https://… --browser firefox');
    process.exitCode = 1;
    return;
  }

  console.log("\n" + banner());
  console.log(pc.bold("\n ¡Bienvenido! Te hago unas preguntas para preparar la tarea.") + pc.dim("\n (Enter para el valor por defecto entre corchetes · ESC para salir)\n"));

  let rl = createInterface({ input, output });
  const detachEsc = attachEscToExit(rl); // ESC sale de Navia mientras se responden las preguntas
  const ask = async (q: string, def?: string): Promise<string> => {
    const hint = def ? pc.dim(` [${def}]`) : "";
    const a = (await rl.question(pc.cyan(q) + hint + " ")).trim();
    return a || def || "";
  };

  try {
    // 1) Motor de IA — AUTOMÁTICO (sin forzar elección):
    //    API key si existe (rápido) → si no, el CLI claude/ant (gratis) → si no hay nada, pide la key.
    let provider: RunFlags["provider"];
    let cliCommand = base.cliCommand;
    let openaiPreset = base.openaiPreset;
    if (process.env.ANTHROPIC_API_KEY) {
      provider = "api";
      console.log(pc.dim("🤖 Motor de IA: API key de Anthropic (rápido).\n"));
    } else {
      const [hasClaude, hasAnt] = await Promise.all([cmdExists("claude"), cmdExists("ant")]);
      const cliName = hasAnt ? "ant" : hasClaude ? "claude" : null;
      if (cliName) {
        provider = "claude-cli";
        cliCommand = cliName;
        console.log(pc.dim(`🤖 Motor de IA: tu CLI '${cliName}' (gratis, más lento). Para más velocidad define ANTHROPIC_API_KEY.\n`));
      } else {
        // No hay ANTHROPIC_API_KEY ni CLI → ofrecemos IA GRATIS (sin pagar nada) o pegar una key.
        console.log(pc.yellow("⚠️  No detecté API key de Anthropic ni el CLI 'claude'/'ant'. Puedes usar IA GRATIS:"));
        console.log(`  ${pc.bold("1)")} 🦙 Local con ${pc.bold("Ollama")} ${pc.dim("(gratis, privado, sin límites; requiere instalar Ollama y un modelo, p.ej. 'ollama pull qwen3:14b')")}`);
        console.log(`  ${pc.bold("2)")} ☁️  ${pc.bold("Groq")} en la nube ${pc.dim("(gratis, rápido; crea una API key gratis en console.groq.com — sin tarjeta)")}`);
        console.log(`  ${pc.bold("3)")} 🔑 Pegar mi ${pc.bold("ANTHROPIC_API_KEY")} ${pc.dim("(de pago, máxima fiabilidad)")}`);
        const choice = (await ask("Elige [1-3]", "1")).trim();
        if (choice === "2") {
          provider = "openai";
          openaiPreset = "groq";
          const gk = process.env.GROQ_API_KEY || (await askHidden(rl, pc.cyan("🔑 Pega tu GROQ_API_KEY (gsk_…, gratis en console.groq.com, no se muestra): ")));
          if (!gk) {
            console.log(pc.red("\n✗ Groq necesita una API key (gratis). Consíguela en https://console.groq.com/keys y vuelve a correr."));
            return;
          }
          process.env.GROQ_API_KEY = gk;
          console.log(pc.green("✓ Groq listo (modelo qwen3-32b, gratis).") + pc.dim(" (Para no repetir: $env:GROQ_API_KEY=…)\n"));
        } else if (choice === "3") {
          provider = "api";
          const key = await askHidden(rl, pc.cyan("🔑 Pega tu ANTHROPIC_API_KEY (sk-ant-…, no se muestra): "));
          if (!key) {
            console.log(pc.red("\n✗ Sin motor de IA no puedo continuar."));
            return;
          }
          process.env.ANTHROPIC_API_KEY = key;
          console.log(pc.green("✓ API key cargada para esta sesión.") + pc.dim(' (Para no repetir: $env:ANTHROPIC_API_KEY="sk-ant-…")\n'));
        } else {
          // Default: Ollama local.
          provider = "openai";
          openaiPreset = "ollama";
          const model = process.env.NAVIA_OPENAI_MODEL || "qwen3:14b";
          if (!(await cmdExists("ollama"))) {
            console.log(pc.yellow(`\n⚠️  No veo 'ollama' instalado. Instálalo desde https://ollama.com y luego: ${pc.bold(`ollama pull ${model}`)}`));
            console.log(pc.dim("   (Cuando esté corriendo, vuelve a ejecutar 'navia'.)"));
            return;
          }
          console.log(pc.green(`✓ Usaré Ollama local (modelo ${model}).`) + pc.dim(` (Si no lo tienes: 'ollama pull ${model}'. Cambia con $env:NAVIA_OPENAI_MODEL)\n`));
        }
      }
    }

    const startUrl = (await ask("🌐 ¿URL de inicio?")).replace(/[\s\\]+$/, ""); // quita \ o espacios al final
    // Login: NO preguntamos "¿requiere login? s/N". Sondeamos la página; si detectamos login, lo
    // decimos; si la sonda no concluye (red/SPA), igual ofrecemos credenciales (Enter = omitir).
    // Así es consistente: pidas o no usuario, decide el flujo — sin un paso confuso que a veces sale.
    const detected = await detectLoginOnPage(startUrl);
    console.log(detected ? pc.dim("🔐 Detecté un formulario de login en la página.") : pc.dim("🔐 ¿Vas a iniciar sesión? Si sí, pon el usuario; si no, deja vacío (Enter)."));

    let user = "";
    let secretKey = "";
    user = await ask(detected ? "   👤 Usuario" : "   👤 Usuario (Enter si NO requiere login)");
    const wantsLogin = user.length > 0;
    if (wantsLogin) {

      // Si hay un vault previo ilegible (cifrado con otra llave), NO borrar: respaldar y seguir.
      const { isVaultReadable, backupVault } = await import("./secrets/vault.js");
      if (!(await isVaultReadable())) {
        console.log(pc.yellow("\n   ⚠️  Hay un vault de contraseñas previo que no puedo descifrar (se creó con otra llave/NAVIA_SECRET)."));
        console.log(pc.dim("   (Esto es SOLO el archivo de contraseñas de Navia, ~/.navia/vault.json. Tu bóveda de Obsidian NO se toca.)"));
        const resp = await ask("   ¿Lo respaldo (.bak, no se borra) y sigo? (S/n)", "S");
        if (!/^(s|y)/i.test(resp)) {
          console.log(pc.dim("   Cancelado. Si lo cifraste con un NAVIA_SECRET, defínelo ($env:NAVIA_SECRET=…) y vuelve a correr."));
          return;
        }
        const bak = await backupVault();
        if (bak) console.log(pc.green(`   ✓ Vault previo respaldado en: ${bak}`));
      }

      const pass = await askHidden(rl, pc.cyan("   🔑 Contraseña (no se muestra): "));
      secretKey = "wizard-login";
      await setSecret(secretKey, pass);
      const { secretSource } = await import("./secrets/key.js");
      console.log(
        pc.green(`   ✓ Contraseña guardada y cifrada`) +
          pc.dim(secretSource() === "env" ? " (con tu NAVIA_SECRET)." : " (llave gestionada por Navia en ~/.navia/key)."),
      );
    }

    const taskPrompt = await ask("🧠 ¿Qué quieres que haga?");
    if (!taskPrompt) {
      console.log(pc.red("\n✗ Necesito una instrucción para continuar."));
      return;
    }
    const browser = (await ask("🖥️  Motor del navegador (chromium|firefox|chrome|patchright)", base.browser ?? "chromium")) as BrowserEngine;

    // Captcha: SIN preguntar (igual que el login). Siempre se intenta con OCR local; si falta el
    // lector, se instala solo la 1ª vez. Si no se puede, en runtime cae a pedírtelo a mano.
    const captcha: "off" | "local" = "local";
    if (wantsLogin) {
      const { ocrAvailable, installOcr } = await import("./agent/captcha-ocr.js");
      if (await ocrAvailable()) {
        console.log(pc.dim("🔓 Captcha: lo resolveré automáticamente con OCR local."));
      } else {
        console.log(pc.dim("🔓 Preparando el lector de captcha local (gratis, solo la 1ª vez)…"));
        const ok = await installOcr();
        console.log(ok ? pc.green("   ✓ Lector de captcha listo (resolveré los captchas solo).") : pc.yellow("   No se pudo instalar; si aparece un captcha te lo pediré a mano."));
      }
    }

    // Bitácora/registro: detecta bóvedas de Obsidian y deja elegir dónde crear la carpeta de Navia.
    let workspace: boolean | string | undefined = base.workspace;
    const wantsWs = /^(s|y)/i.test(await ask("🧠 ¿Guardar bitácora/registro de la tarea? (S/n)", "S"));
    if (wantsWs) {
      workspace = await chooseWorkspace(rl); // reusa el mismo readline; lista vaults de Obsidian + carpeta + ruta
    } else {
      workspace = false; // elección EXPLÍCITA de "no" → runTask no debe reactivarla desde cfg
    }

    // Arma la tarea: si hay login, instruye usar fill_credential (la contraseña nunca pasa por el modelo).
    const task = wantsLogin
      ? `Primero inicia sesión: el usuario es "${user}"; para la contraseña usa fill_credential(ref, "${secretKey}") (NUNCA la teclees tú). Luego: ${taskPrompt}`
      : taskPrompt;

    // Vista previa del comando equivalente.
    const eq =
      `navia run ${JSON.stringify(taskPrompt)} --browser ${browser}` +
      (startUrl ? ` --start-url ${startUrl}` : "") +
      (captcha === "local" ? " --captcha local" : "") +
      ` --provider ${provider}` +
      (provider === "openai" && openaiPreset ? ` --openai-preset ${openaiPreset}` : "");
    console.log(pc.dim("\n ─────────────────────────────────────────────"));
    console.log(" Voy a ejecutar:\n   " + pc.cyan(eq));

    const go = await ask("\n▶ ¿Confirmas? (S/n)", "S");
    detachEsc(); // a partir de aquí arranca la tarea (posible navegador) → ya no cortamos con ESC
    rl.close();
    if (!/^(s|y)/i.test(go)) {
      console.log(pc.dim("Cancelado."));
      return;
    }

    await runTask(task, {
      ...base,
      browser,
      provider,
      cliCommand,
      openaiPreset,
      workspace,
      captcha,
      chat: true, // el wizard es conversacional: al terminar pregunta "¿qué hago ahora?"
      startUrl: startUrl || base.startUrl,
    } as RunFlags);
  } finally {
    detachEsc();
    rl.close();
  }
}

const browserOpt = (cmd: Command) =>
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

// `navia run "tarea"` — también es el comando por defecto: `navia "tarea"`.
browserOpt(
  program
    .command("run", { isDefault: true })
    .description("Ejecutar una tarea (comando por defecto)")
    .argument("[task]", "qué hacer, en lenguaje natural"),
).action((task: string | undefined, flags: RunFlags) => {
  // Sin tarea → modo interactivo (bienvenida + preguntas guiadas).
  if (!task) return runWizard(flags);
  return runTask(task, flags);
});

// `navia start` — modo interactivo explícito (bienvenida + preguntas).
browserOpt(program.command("start").description("Modo interactivo guiado: bienvenida y preguntas (URL, login, tarea, motor)…")).action(
  (flags: RunFlags) => runWizard(flags),
);

// `navia extract` — extracción estructurada y tipada (web → JSON conforme a un schema).
program
  .command("extract [instruccion]")
  .description("Extraer datos estructurados de una página a JSON validado contra un schema (web → datos).")
  .option("--url <url>", "URL a abrir antes de extraer")
  .option("--schema <archivo>", "archivo .json con el schema JSON deseado")
  .option("-b, --browser <engine>", "motor: chromium | firefox | chrome | patchright", (process.env.NAVIA_BROWSER as BrowserEngine) || "chromium")
  .option("-p, --profile <name>", "perfil guardado con 'navia login'")
  .option("-m, --model <model>", "modelo de Claude")
  .option("--headless", "ejecutar sin ventana visible")
  .action(async (instruccion: string | undefined, opts: { url?: string; schema?: string; browser: BrowserEngine; profile?: string; model?: string; headless?: boolean }) => {
    if (!instruccion || !opts.schema) {
      console.error(pc.red("✗ Uso: navia extract \"qué extraer\" --schema schema.json [--url https://...]"));
      process.exit(1);
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(pc.red("✗ extract necesita ANTHROPIC_API_KEY (usa una API key; no funciona con el proveedor CLI)."));
      process.exit(1);
    }
    const { readFile } = await import("node:fs/promises");
    const { extract } = await import("./agent/extract.js");
    let schema: Record<string, any>;
    try {
      schema = JSON.parse(await readFile(opts.schema, "utf8"));
    } catch (e) {
      console.error(pc.red(`✗ No pude leer/parsear el schema "${opts.schema}": ${(e as Error).message}`));
      process.exit(1);
    }
    console.log(pc.cyan(`\n🔎 Navia extract — ${opts.url ?? "(página actual)"}\n`) + pc.dim(`Extraer: ${instruccion}\n`));
    try {
      const data = await extract({
        instruction: instruccion,
        schema,
        url: opts.url,
        browser: opts.browser,
        profile: opts.profile,
        model: opts.model,
        headless: opts.headless,
      });
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(pc.red(`\n✗ Error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  });

// `navia replay <archivo>` — re-ejecuta una macro grabada con --record, sin LLM.
program
  .command("replay <archivo>")
  .description("Re-ejecutar una macro (JSONL de --record) de forma determinista, SIN IA ni API key.")
  .option("-b, --browser <engine>", "motor: chromium | firefox | chrome | patchright", (process.env.NAVIA_BROWSER as BrowserEngine) || "chromium")
  .option("-p, --profile <name>", "perfil guardado con 'navia login'")
  .option("--headless", "ejecutar sin ventana visible")
  .action(async (archivo: string, opts: { browser: BrowserEngine; profile?: string; headless?: boolean }) => {
    const { replayMacro } = await import("./agent/replay.js");
    console.log(pc.cyan(`\n🔁 Navia replay — ${archivo}\n`));
    try {
      const r = await replayMacro(archivo, { task: "", browser: opts.browser, profile: opts.profile, headless: opts.headless }, (m) =>
        console.log(pc.dim(m)),
      );
      console.log(
        (r.failed === 0 ? pc.green("\n✓") : pc.yellow("\n•")) +
          ` Replay: ${r.ran}/${r.total} acciones OK` +
          (r.failed ? `, ${r.failed} fallaron` : "") +
          (r.healed ? pc.cyan(` · ${r.healed} sanada(s)`) : ""),
      );
    } catch (err) {
      console.error(pc.red(`\n✗ Error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  });

// `navia eval` — corre un dataset de tareas (sitios vivos) y las juzga con un juez LLM (WebJudge).
program
  .command("eval")
  .description("Evalúa Navia sobre un dataset de tareas (JSONL Online-Mind2Web-ish) con un juez LLM. Reporta tasa de éxito + métricas.")
  .option("--dataset <archivo>", "JSONL de tareas {task_id, task, url, level}; por defecto un set de muestra")
  .option("-b, --browser <engine>", "motor: chromium | firefox | chrome | patchright", (process.env.NAVIA_BROWSER as BrowserEngine) || "chromium")
  .option("-m, --model <model>", "modelo de Claude (agente y juez)")
  .option("--provider <p>", "motor de IA: auto | api | claude-cli", "auto")
  .option("--headless", "ejecutar sin ventana visible")
  .option("--max-steps <n>", "máximo de pasos por tarea (default 30)")
  .option("--report <archivo>", "guardar el reporte JSON en esta ruta")
  .action(async (o: { dataset?: string; browser: BrowserEngine; model?: string; provider?: "auto" | "api" | "claude-cli"; headless?: boolean; maxSteps?: string; report?: string }) => {
    const { runEval, parseDataset } = await import("./agent/eval.js");
    const { readFile, writeFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dsPath = o.dataset ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "eval", "sample.jsonl");
    let dataset;
    try {
      dataset = parseDataset(await readFile(dsPath, "utf8"));
    } catch (e) {
      console.error(pc.red(`✗ No pude leer el dataset (${dsPath}): ${(e as Error).message}`));
      process.exitCode = 1;
      return;
    }
    console.log(pc.cyan(`\n🧪 Navia eval — ${dataset.length} tarea(s) · ${o.browser}\n`));
    try {
      const report = await runEval({
        dataset,
        browser: o.browser,
        model: o.model,
        provider: o.provider,
        headless: o.headless,
        maxSteps: o.maxSteps ? Number(o.maxSteps) : 30,
        onCase: (c) =>
          console.log(
            `${c.success ? pc.green("✓") : pc.red("✗")} [${c.task_id}] ${c.steps} pasos · ${(c.ms / 1000).toFixed(1)}s` +
              (c.metrics?.tokensIn ? ` · ${c.metrics.tokensIn + c.metrics.tokensOut} tok` : "") +
              pc.dim(` — ${c.reason}`),
          ),
      });
      console.log(
        pc.cyan(`\n📊 Éxito: ${report.passed}/${report.total} (${(report.successRate * 100).toFixed(0)}%)`) +
          ` · pasos medios ${report.avgSteps.toFixed(1)} · ${report.totalTokens} tokens`,
      );
      for (const [lvl, s] of Object.entries(report.byLevel)) console.log(pc.dim(`   ${lvl}: ${s.passed}/${s.total}`));
      if (o.report) {
        await writeFile(o.report, JSON.stringify(report, null, 2), "utf8");
        console.log(pc.dim(`\nReporte guardado en ${o.report}`));
      }
    } catch (err) {
      console.error(pc.red(`\n✗ Error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  });

// `navia doctor` — verifica que el entorno esté listo.
function cmdExists(bin: string): Promise<boolean> {
  return new Promise(async (resolve) => {
    const { spawn } = await import("node:child_process");
    try {
      // En Windows muchos CLIs son .cmd/.ps1 → hace falta shell. Pasamos el comando como UNA
      // sola cadena (sin array de args) para no disparar el DeprecationWarning DEP0190.
      const child =
        process.platform === "win32"
          ? spawn(`"${bin}" --version`, { shell: true, stdio: "ignore", windowsHide: true })
          : spawn(bin, ["--version"], { stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill();
        resolve(false);
      }, 5000);
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    } catch {
      resolve(false);
    }
  });
}

async function safeExe(launcher: { executablePath: () => string }): Promise<string | null> {
  const { existsSync } = await import("node:fs");
  try {
    const p = launcher.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

program
  .command("doctor")
  .description("Verifica que el entorno esté listo (Node, navegadores, motor de IA, secretos).")
  .action(async () => {
    const ok = (b: boolean) => (b ? pc.green("✓") : pc.red("✗"));
    console.log(pc.cyan("\n🩺 Navia doctor\n"));

    const major = Number(process.versions.node.split(".")[0]);
    console.log(`${ok(major >= 20)} Node ${process.versions.node} ${major >= 20 ? "" : pc.dim("(requiere >=20)")}`);

    const hasKey = !!process.env.ANTHROPIC_API_KEY;
    const [hasClaude, hasAnt] = await Promise.all([cmdExists("claude"), cmdExists("ant")]);
    const engines = [hasKey ? "ANTHROPIC_API_KEY" : null, hasAnt ? "ant CLI" : null, hasClaude ? "claude CLI" : null].filter(Boolean);
    console.log(
      `${ok(engines.length > 0)} Motor de IA: ${engines.join(", ") || pc.dim("ninguno → pon ANTHROPIC_API_KEY, o instala 'claude'/'ant'")}`,
    );

    const { chromium, firefox } = await import("playwright");
    const cPath = await safeExe(chromium);
    const fPath = await safeExe(firefox);
    console.log(`${ok(!!cPath)} Chromium de Playwright ${cPath ? "" : pc.dim("→ npx playwright install chromium")}`);
    console.log(`${ok(!!fPath)} Firefox de Playwright ${fPath ? "" : pc.dim("→ npx playwright install firefox")}`);

    console.log(
      process.env.NAVIA_SECRET
        ? `${pc.green("✓")} Cifrado: NAVIA_SECRET definido (perfiles/vault cifrados con tu frase)`
        : `${pc.green("✓")} Cifrado: llave gestionada por Navia ${pc.dim("(~/.navia/key; define NAVIA_SECRET para usar tu propia frase)")}`,
    );

    const listo = major >= 20 && engines.length > 0 && !!cPath;
    console.log(listo ? pc.green("\n✓ Listo para usar Navia.") : pc.yellow("\n• Faltan piezas arriba; revisa las pistas."));
  });

// `navia chrome` — solo lanzar Chrome real con depuración (para el truco anti-Cloudflare)
program
  .command("chrome")
  .description("Lanzar Chrome real con --remote-debugging-port (perfil dedicado). Luego usa --browser chrome.")
  .option("--cdp-port <port>", "puerto", "9222")
  .action(async (opts: { cdpPort: string }) => {
    const { spawn } = await import("node:child_process");
    const { existsSync } = await import("node:fs");
    const candidates =
      process.platform === "win32"
        ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"]
        : process.platform === "darwin"
          ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
          : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
    const chromePath = candidates.find((p) => existsSync(p));
    if (!chromePath) {
      console.error(pc.red("✗ No encontré Chrome instalado."));
      process.exit(1);
    }
    const dataDir = path.join(os.homedir(), ".navia", "chrome-profile");
    spawn(chromePath, [`--remote-debugging-port=${opts.cdpPort}`, `--user-data-dir=${dataDir}`, "--no-first-run"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    console.log(pc.green(`✓ Chrome lanzado con depuración en el puerto ${opts.cdpPort}.`));
    console.log(pc.dim(`Ahora ejecuta:  navia run "tu tarea" --browser chrome --cdp-port ${opts.cdpPort}`));
  });

/** Lee una línea sin eco (para secretos), para no dejarlos en el historial del shell. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let val = "";
    const onData = (chunk: string) => {
      const code = chunk.charCodeAt(0);
      if (code === 13 || code === 10 || code === 4) {
        // Enter / EOT → terminar
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(val);
      } else if (code === 3) {
        process.exit(1); // Ctrl-C
      } else if (code === 127 || code === 8) {
        val = val.slice(0, -1); // backspace
      } else {
        val += chunk;
      }
    };
    stdin.on("data", onData);
  });
}

// `navia secret …` — gestiona secretos cifrados (para fill_credential / fill_totp)
const secret = program.command("secret").description("Gestiona secretos cifrados (contraseñas, TOTP) para fill_credential/fill_totp");
secret
  .command("set <clave>")
  .description("Guarda una contraseña/secreto (te lo pide sin mostrarlo)")
  .option(
    "--origin <url>",
    "restringe el secreto a este origen (FQDN/URL); repetible. Anti-phishing: solo se rellena ahí",
    (v: string, acc: string[]) => [...acc, v],
    [] as string[],
  )
  .action(async (clave: string, o: { origin: string[] }) => {
    const { isVaultReadable } = await import("./secrets/vault.js");
    if (!(await isVaultReadable())) {
      console.error(
        pc.red("✗ No puedo leer el vault actual (cifrado con otra llave/NAVIA_SECRET).") +
          pc.dim("\n  Si lo cifraste con un NAVIA_SECRET, defínelo y reintenta. O empieza limpio (respalda el viejo): navia secret reset"),
      );
      process.exit(1);
    }
    const value = await promptHidden(`Valor para "${clave}" (no se muestra): `);
    await setSecret(clave, value, o.origin);
    const bind = o.origin.length ? pc.dim(` · restringido a ${o.origin.join(", ")}`) : "";
    console.log(pc.green(`✓ Secreto "${clave}" guardado. Úsalo con fill_credential(ref, "${clave}").`) + bind);
  });
secret
  .command("totp <clave>")
  .description("Guarda un secreto TOTP en base32 (te lo pide sin mostrarlo)")
  .action(async (clave: string) => {
    const value = await promptHidden(`Secreto TOTP (base32) para "${clave}": `);
    await setTotp(clave, value.replace(/\s/g, ""));
    console.log(pc.green(`✓ TOTP "${clave}" guardado. Úsalo con fill_totp(ref, "${clave}").`));
  });
secret
  .command("list")
  .description("Lista las claves guardadas (no muestra valores)")
  .action(async () => {
    const { secrets, totp } = await listKeys();
    console.log(pc.cyan("Secretos:"), secrets.length ? secrets.join(", ") : pc.dim("(ninguno)"));
    console.log(pc.cyan("TOTP:"), totp.length ? totp.join(", ") : pc.dim("(ninguno)"));
  });
secret
  .command("reset")
  .description("Empieza un vault limpio. NO borra: respalda el vault actual a un .bak (útil si quedó cifrado con otra llave).")
  .action(async () => {
    const { backupVault } = await import("./secrets/vault.js");
    const bak = await backupVault();
    if (bak) console.log(pc.green(`✓ Vault respaldado en: ${bak}`) + pc.dim("\n  El próximo 'secret set' / wizard creará uno nuevo cifrado."));
    else console.log(pc.dim("No había vault que respaldar; empezarás limpio."));
  });

// `navia ocr` — instala el OCR local de captcha (para no teclear el nombre del paquete).
program
  .command("ocr")
  .description("Instala el OCR local GRATIS de captcha (en ~/.navia) para usar --captcha local")
  .action(async () => {
    const { installOcr, ocrAvailable } = await import("./agent/captcha-ocr.js");
    if (await ocrAvailable()) {
      console.log(pc.green("✓ El OCR local ya está disponible."));
      return;
    }
    console.log(pc.cyan("Instalando OCR local de captcha…") + pc.dim(" (puede tardar la primera vez)"));
    const ok = await installOcr((m) => process.stdout.write(pc.dim(m + "\n")));
    console.log(ok ? pc.green("\n✓ OCR local instalado. Úsalo con --captcha local (o respóndele 's' al wizard).") : pc.red("\n✗ No se pudo instalar. Revisa tu conexión/npm."));
    process.exitCode = ok ? 0 : 1;
  });

// `navia init` — escribe ~/.navia/config.json con tus valores por defecto.
program
  .command("init")
  .description("Crea/actualiza ~/.navia/config.json (modelo, motor, perfil, provider, workspace) para no repetir flags")
  .option("-m, --model <model>", "modelo de Claude por defecto")
  .option("-b, --browser <engine>", "motor por defecto: chromium | firefox | chrome | patchright")
  .option("-p, --profile <name>", "perfil por defecto")
  .option("--provider <p>", "motor de IA por defecto: auto | api | claude-cli")
  .option("--workspace [dir]", "guardar bitácora por defecto (true o una ruta base)")
  .action(async (o: { model?: string; browser?: BrowserEngine; profile?: string; provider?: "auto" | "api" | "claude-cli"; workspace?: boolean | string }) => {
    const current = loadConfigSync();
    const anyFlag = o.model || o.browser || o.profile || o.provider || o.workspace !== undefined;
    let next: NaviaConfig = { ...current };
    if (anyFlag) {
      next = { ...current, ...o };
    } else {
      // Interactivo: Enter para conservar el valor actual.
      const rl = createInterface({ input, output });
      const askv = async (label: string, cur?: string) => {
        const a = (await rl.question(pc.cyan(`${label}${cur ? ` [${cur}]` : ""}: `))).trim();
        return a || cur;
      };
      next.model = await askv("Modelo de Claude (Enter para omitir)", current.model);
      next.browser = (await askv("Motor (chromium/firefox/chrome/patchright)", current.browser)) as BrowserEngine | undefined;
      next.profile = await askv("Perfil por defecto (Enter para omitir)", current.profile);
      next.provider = (await askv("Provider (auto/api/claude-cli)", current.provider)) as NaviaConfig["provider"];
      rl.close();
    }
    const file = saveConfig(next);
    console.log(pc.green(`✓ Config guardada en ${file}`));
    console.log(pc.dim(JSON.stringify(loadConfigSync(), null, 2)));
  });

// `navia create <nombre>` — andamiaje de un proyecto mínimo que usa navia-ai.
program
  .command("create <nombre>")
  .description("Crea una carpeta de proyecto con navia.config.json, .env.example, tasks.txt y un script de ejemplo")
  .action(async (nombre: string) => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const dir = path.resolve(process.cwd(), nombre);
    if (existsSync(dir)) {
      console.error(pc.red(`✗ Ya existe: ${dir}`));
      process.exitCode = 1;
      return;
    }
    await mkdir(dir, { recursive: true });
    const files: Record<string, string> = {
      "navia.config.json": JSON.stringify({ browser: "chromium", provider: "auto", model: "claude-sonnet-4-6" }, null, 2) + "\n",
      ".env.example": "# Copia a .env y rellena. Sin API key, Navia usa el CLI 'claude'/'ant' de tu terminal.\nANTHROPIC_API_KEY=\n",
      "tasks.txt": "Abre example.com y dime el título de la página\n",
      "run.mjs":
        `import { runNavia } from "navia-ai";\n\n` +
        `const { summary, metrics } = await runNavia({\n` +
        `  task: "Abre example.com y dime el título de la página",\n` +
        `  browser: "chromium",\n` +
        `});\n` +
        `console.log(summary);\n` +
        `console.log(metrics);\n`,
      "README.md": `# ${nombre}\n\nProyecto de automatización con [navia-ai](https://www.npmjs.com/package/navia-ai).\n\n\`\`\`bash\nnpm i navia-ai\nnode run.mjs\n# o vía CLI:\nnpx navia-ai "abre example.com y dime el título"\n\`\`\`\n`,
    };
    for (const [name, content] of Object.entries(files)) await writeFile(path.join(dir, name), content, "utf8");
    console.log(pc.green(`✓ Proyecto creado en ${dir}`));
    console.log(pc.dim(`  ${Object.keys(files).join(", ")}\n  Siguiente: cd ${nombre} && npm i navia-ai && node run.mjs`));
  });

// `navia playbook` — gestiona la memoria por dominio (tips que Navia reinyecta al volver al sitio).
const playbook = program.command("playbook").description("Memoria por dominio: tips reutilizables que Navia inyecta al volver a un sitio");
playbook
  .command("list")
  .description("Lista los dominios con playbook guardado")
  .action(async () => {
    const { listPlaybooks } = await import("./agent/domain-memory.js");
    const domains = await listPlaybooks();
    console.log(pc.cyan("Playbooks:"), domains.length ? domains.join(", ") : pc.dim("(ninguno)"));
  });
playbook
  .command("show <dominio>")
  .description("Muestra los tips guardados de un dominio")
  .action(async (dominio: string) => {
    const { loadPlaybook, formatTips, domainOf } = await import("./agent/domain-memory.js");
    const d = domainOf(dominio) || dominio.toLowerCase();
    const pb = await loadPlaybook(d);
    console.log(pb.tips.length ? formatTips(d, pb.tips) : pc.dim(`Sin tips para ${d}.`));
  });
playbook
  .command("add <dominio>")
  .description("Añade un tip a un dominio (nota libre o estructurado scope/action/constraint)")
  .option("--note <texto>", "nota libre")
  .option("--scope <texto>", "cuándo aplica")
  .option("--action <texto>", "qué hacer")
  .option("--constraint <texto>", "restricción / cuidado")
  .action(async (dominio: string, o: { note?: string; scope?: string; action?: string; constraint?: string }) => {
    const { addTip, domainOf } = await import("./agent/domain-memory.js");
    if (!o.note && !o.scope && !o.action && !o.constraint) {
      console.error(pc.red("Da al menos --note o --scope/--action/--constraint."));
      process.exitCode = 1;
      return;
    }
    await addTip(dominio, { note: o.note, scope: o.scope, action: o.action, constraint: o.constraint });
    console.log(pc.green(`✓ Tip añadido al playbook de ${domainOf(dominio) || dominio}.`));
  });

// `navia login <perfil>` — abre el navegador para iniciar sesión y guarda el perfil.
program
  .command("login <perfil>")
  .description("Abre el navegador para que inicies sesión y guarda la sesión (cookies/almacenamiento) en un perfil reutilizable.")
  .option("-b, --browser <engine>", "motor: chromium | firefox | chrome", (process.env.NAVIA_BROWSER as BrowserEngine) || "chromium")
  .option("--start-url <url>", "URL del login a abrir")
  .action(async (perfil: string, opts: { browser: BrowserEngine; startUrl?: string }) => {
    const rl = createInterface({ input, output });
    const driver = await BrowserDriver.create({
      engine: opts.browser,
      headless: false,
      userDataDir: opts.browser === "chrome" ? path.join(os.homedir(), ".navia", "profiles", `chrome-${perfil}`) : undefined,
    });
    try {
      if (opts.startUrl) await driver.navigate(opts.startUrl);
      console.log(pc.yellow(`\n🔐 Inicia sesión en la ventana del navegador (resuelve captcha/2FA si aparece).`));
      await rl.question(pc.yellow("Cuando hayas iniciado sesión, presiona Enter para guardar el perfil… "));
      const state = await driver.getStorageState();
      const { file } = await saveSession(perfil, state);
      const { secretSource } = await import("./secrets/key.js");
      console.log(pc.green(`✓ Perfil "${perfil}" guardado (cifrado): ${file}`));
      console.log(pc.dim(secretSource() === "env" ? "  Cifrado con tu NAVIA_SECRET." : "  Cifrado con la llave gestionada por Navia (~/.navia/key)."));
      console.log(pc.dim(`  Úsalo:  navia run "tu tarea" --browser ${opts.browser} --profile ${perfil}`));
    } finally {
      await driver.close();
      rl.close();
    }
  });

// `navia mcp` — servidor MCP por stdio (para Claude Desktop/Code/Cursor)
program
  .command("mcp")
  .description("Iniciar Navia como servidor MCP (stdio): expone sus herramientas de navegador a un cliente MCP.")
  .option("-b, --browser <engine>", "motor: chromium | firefox | chrome", (process.env.NAVIA_BROWSER as BrowserEngine) || "chromium")
  .option("-p, --profile <name>", "perfil guardado con 'navia login' (arranca autenticado)")
  .option("--headless", "ejecutar sin ventana visible")
  .option("--cdp-port <port>", "puerto de depuración para --browser chrome")
  .option("--cdp-endpoint <url>", "conectar a un Chrome ya abierto")
  .action(async (opts: { browser: BrowserEngine; profile?: string; headless?: boolean; cdpPort?: string; cdpEndpoint?: string }) => {
    await startMcpServer({
      browser: opts.browser,
      profile: opts.profile,
      headless: opts.headless,
      cdpPort: opts.cdpPort ? Number(opts.cdpPort) : undefined,
      cdpEndpoint: opts.cdpEndpoint,
    });
  });

program.parseAsync();
