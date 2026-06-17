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
import { stdin as input, stdout as output } from "node:process";
import { runNavia, resolveProvider } from "./agent/agent.js";
import { BrowserDriver } from "./browser/driver.js";
import { saveSession } from "./browser/session-store.js";
import { setSecret, setTotp, listKeys } from "./secrets/vault.js";
import { startMcpServer } from "./mcp/server.js";
import os from "node:os";
import path from "node:path";
import type { BrowserEngine } from "./browser/launch.js";

loadEnv({ quiet: true });

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
  .version("0.21.0");

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
  provider?: "auto" | "api" | "claude-cli";
  cliCommand?: string;
  record?: boolean | string;
  yes?: boolean;
  workspace?: boolean | string;
  chat?: boolean;
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
          pc.dim("\n  Soluciones: define ANTHROPIC_API_KEY (--provider api), instala el CLI 'claude'/'ant', o pásalo con --cli-command."),
      );
      process.exit(1);
    }
  }

  const rl = createInterface({ input, output });
  const ask = async (q: string) => (await rl.question(q)).trim();

  const motor = provider === "claude-cli" ? `${flags.browser} · IA: CLI (${flags.cliCommand ?? "claude"})` : `${flags.browser} · IA: API`;
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
      record: flags.record,
      workspace: flags.workspace,
      maxSteps: flags.maxSteps ? Number(flags.maxSteps) : undefined,
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
    void result;
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
  console.log(pc.bold("\n ¡Bienvenido! Te hago unas preguntas para preparar la tarea.") + pc.dim("\n (Enter para el valor por defecto entre corchetes)\n"));

  let rl = createInterface({ input, output });
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
        // No hay ningún motor → ahí SÍ pedimos la API key (no se puede funcionar sin LLM).
        provider = "api";
        console.log(pc.yellow("⚠️  No detecté un motor de IA (ni ANTHROPIC_API_KEY ni el CLI 'claude'/'ant')."));
        const key = await askHidden(rl, pc.cyan("🔑 Pega tu ANTHROPIC_API_KEY (sk-ant-…, no se muestra): "));
        if (!key) {
          console.log(pc.red("\n✗ Sin motor de IA no puedo continuar. Define ANTHROPIC_API_KEY o instala el CLI 'claude'."));
          return;
        }
        process.env.ANTHROPIC_API_KEY = key;
        console.log(pc.green("✓ API key cargada para esta sesión.") + pc.dim(' (Para no repetir: $env:ANTHROPIC_API_KEY="sk-ant-…")\n'));
      }
    }

    const startUrl = await ask("🌐 ¿URL de inicio?");
    const wantsLogin = /^(s|y)/i.test(await ask("🔐 ¿Requiere login? (s/N)", "N"));

    let user = "";
    let secretKey = "";
    if (wantsLogin) {
      user = await ask("   👤 Usuario");

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

    // Bitácora/registro: detecta bóvedas de Obsidian y deja elegir dónde crear la carpeta de Navia.
    let workspace: boolean | string | undefined = base.workspace;
    const wantsWs = /^(s|y)/i.test(await ask("🧠 ¿Guardar bitácora/registro de la tarea? (S/n)", "S"));
    if (wantsWs) {
      workspace = await chooseWorkspace(rl); // reusa el mismo readline; lista vaults de Obsidian + carpeta + ruta
    } else {
      workspace = undefined;
    }

    // Arma la tarea: si hay login, instruye usar fill_credential (la contraseña nunca pasa por el modelo).
    const task = wantsLogin
      ? `Primero inicia sesión: el usuario es "${user}"; para la contraseña usa fill_credential(ref, "${secretKey}") (NUNCA la teclees tú). Luego: ${taskPrompt}`
      : taskPrompt;

    // Vista previa del comando equivalente.
    const eq =
      `navia run ${JSON.stringify(taskPrompt)} --browser ${browser}` +
      (startUrl ? ` --start-url ${startUrl}` : "") +
      ` --provider ${provider}`;
    console.log(pc.dim("\n ─────────────────────────────────────────────"));
    console.log(" Voy a ejecutar:\n   " + pc.cyan(eq));

    const go = await ask("\n▶ ¿Confirmas? (S/n)", "S");
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
      workspace,
      chat: true, // el wizard es conversacional: al terminar pregunta "¿qué hago ahora?"
      startUrl: startUrl || base.startUrl,
    } as RunFlags);
  } finally {
    rl.close();
  }
}

const browserOpt = (cmd: Command) =>
  cmd
    .option("-b, --browser <engine>", "motor: chromium | firefox | chrome | patchright", (process.env.NAVIA_BROWSER as BrowserEngine) || "chromium")
    .option("-m, --model <model>", "modelo de Claude (default claude-sonnet-4-6)")
    .option("--headless", "ejecutar sin ventana visible")
    .option("--slow-mo <ms>", "ralentizar acciones N ms (útil para anti-bot)")
    .option("--cdp-port <port>", "puerto de depuración para --browser chrome (default 9222)")
    .option("--cdp-endpoint <url>", "conectar a un Chrome ya abierto, ej http://localhost:9222")
    .option("--start-url <url>", "abrir esta URL antes de empezar")
    .option("-p, --profile <name>", "usar un perfil guardado con 'navia login' (arranca autenticado)")
    .option("--provider <p>", "motor de IA: auto | api | claude-cli (auto: API key si existe, si no el CLI claude)", "auto")
    .option("--cli-command <bin>", "binario del CLI para --provider claude-cli: 'ant' (recomendado, completado limpio) o 'claude' (fallback). Default claude")
    .option("--record [path]", "registrar la corrida en JSONL (default ~/.navia/trajectories/; o una ruta. Tip: usa --workspace para bitácora completa)")
    .option("--workspace [dir]", "crear carpeta-bitácora (memoria) por tarea (auto: Obsidian/Escritorio, o la ruta dada)")
    .option("--yes", "auto-aprobar acciones irreversibles (¡solo entornos de prueba!)")
    .option("--chat", "modo conversación: al terminar, mantiene el navegador y pide la siguiente tarea")
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
        (r.failed === 0 ? pc.green("\n✓") : pc.yellow("\n•")) + ` Replay: ${r.ran}/${r.total} acciones OK` + (r.failed ? `, ${r.failed} fallaron` : ""),
      );
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
  .action(async (clave: string) => {
    const { isVaultReadable } = await import("./secrets/vault.js");
    if (!(await isVaultReadable())) {
      console.error(
        pc.red("✗ No puedo leer el vault actual (cifrado con otra llave/NAVIA_SECRET).") +
          pc.dim("\n  Si lo cifraste con un NAVIA_SECRET, defínelo y reintenta. O empieza limpio (respalda el viejo): navia secret reset"),
      );
      process.exit(1);
    }
    const value = await promptHidden(`Valor para "${clave}" (no se muestra): `);
    await setSecret(clave, value);
    console.log(pc.green(`✓ Secreto "${clave}" guardado. Úsalo con fill_credential(ref, "${clave}").`));
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
