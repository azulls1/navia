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

const program = new Command();

program
  .name("navia")
  .description("Agente de navegador autónomo con IA (Claude). Opera Chrome o Firefox reales con una instrucción.")
  .version("0.4.0");

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
}

async function runTask(task: string, flags: RunFlags) {
  const provider = resolveProvider({ task, provider: flags.provider, apiKey: undefined });
  if (provider === "api" && !process.env.ANTHROPIC_API_KEY) {
    console.error(pc.red("✗ Provider 'api' sin ANTHROPIC_API_KEY. Pon la key, usa --provider claude-cli, o instala el CLI `claude`."));
    process.exit(1);
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
      maxSteps: flags.maxSteps ? Number(flags.maxSteps) : undefined,
      hooks: {
        log: (msg) => console.log(pc.dim(msg)),
        confirmAction: async (description) => {
          console.log(pc.yellow(`\n⚠️  Acción que requiere confirmación:\n   ${description}`));
          const a = await ask(pc.yellow("¿Aprobar? (s/N): "));
          return a.toLowerCase() === "s" || a.toLowerCase() === "si" || a.toLowerCase() === "y";
        },
        waitForHuman: async (reason) => {
          console.log(pc.yellow(`\n🙋 Necesito que hagas algo en la ventana del navegador:\n   ${reason}`));
          return ask(pc.yellow("Cuando termines, presiona Enter (o escribe una nota): "));
        },
      },
    });

    console.log(pc.green("\n✓ Terminado en " + result.steps + " pasos.\n"));
    console.log(result.summary);
  } catch (err) {
    console.error(pc.red(`\n✗ Error: ${(err as Error).message}`));
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

const browserOpt = (cmd: Command) =>
  cmd
    .option("-b, --browser <engine>", "motor: chromium | firefox | chrome", (process.env.NAVIA_BROWSER as BrowserEngine) || "chromium")
    .option("-m, --model <model>", "modelo de Claude (default claude-sonnet-4-6)")
    .option("--headless", "ejecutar sin ventana visible")
    .option("--slow-mo <ms>", "ralentizar acciones N ms (útil para anti-bot)")
    .option("--cdp-port <port>", "puerto de depuración para --browser chrome (default 9222)")
    .option("--cdp-endpoint <url>", "conectar a un Chrome ya abierto, ej http://localhost:9222")
    .option("--start-url <url>", "abrir esta URL antes de empezar")
    .option("-p, --profile <name>", "usar un perfil guardado con 'navia login' (arranca autenticado)")
    .option("--provider <p>", "motor de IA: auto | api | claude-cli (auto: API key si existe, si no el CLI claude)", "auto")
    .option("--cli-command <bin>", "binario del CLI para --provider claude-cli: 'ant' (recomendado, completado limpio) o 'claude' (fallback). Default claude")
    .option("--max-steps <n>", "máximo de pasos (default 60)");

// `navia run "tarea"`
browserOpt(program.command("run").description("Ejecutar una tarea").argument("<task>", "qué hacer, en lenguaje natural")).action(
  (task: string, flags: RunFlags) => runTask(task, flags),
);

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
    if (!process.env.NAVIA_SECRET) console.log(pc.yellow("⚠️  Sin NAVIA_SECRET el vault se guarda en claro. Define NAVIA_SECRET para cifrarlo."));
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
      const { file, encrypted } = await saveSession(perfil, state);
      console.log(pc.green(`✓ Perfil "${perfil}" guardado${encrypted ? " (cifrado)" : ""}: ${file}`));
      if (!encrypted) console.log(pc.dim("  Tip: define NAVIA_SECRET para cifrar el perfil (contiene cookies de sesión)."));
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

// Atajo: `navia "tarea"` (sin subcomando) → run
browserOpt(program.argument("[task]", "tarea en lenguaje natural").action((task: string | undefined, flags: RunFlags) => {
  if (!task) {
    program.help();
    return;
  }
  return runTask(task, flags);
}));

program.parseAsync();
