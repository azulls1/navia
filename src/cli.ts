#!/usr/bin/env node
/**
 * CLI `navia`.
 *
 *   navia "abre example.com y dime el título"            # tarea con el navegador por defecto
 *   navia run "..." --browser firefox                    # elegir motor
 *   navia run "..." --browser chrome                     # Chrome real vía CDP (anti-Cloudflare)
 *   navia chrome                                         # solo lanzar Chrome real con depuración
 */
import { Command } from "commander";
import { config as loadEnv } from "dotenv";
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runNavia } from "./agent/agent.js";
import type { BrowserEngine } from "./browser/launch.js";

loadEnv({ quiet: true });

const program = new Command();

program
  .name("navia")
  .description("Agente de navegador autónomo con IA (Claude). Opera Chrome o Firefox reales con una instrucción.")
  .version("0.1.0");

interface RunFlags {
  browser: BrowserEngine;
  model?: string;
  headless?: boolean;
  slowMo?: string;
  cdpPort?: string;
  cdpEndpoint?: string;
  startUrl?: string;
  maxSteps?: string;
}

async function runTask(task: string, flags: RunFlags) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(pc.red("✗ Falta ANTHROPIC_API_KEY. Ponla en un archivo .env o como variable de entorno."));
    process.exit(1);
  }

  const rl = createInterface({ input, output });
  const ask = async (q: string) => (await rl.question(q)).trim();

  console.log(pc.cyan(`\n🌐 Navia — ${flags.browser}\n`) + pc.dim(`Tarea: ${task}\n`));

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
    const os = await import("node:os");
    const path = await import("node:path");
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

// Atajo: `navia "tarea"` (sin subcomando) → run
browserOpt(program.argument("[task]", "tarea en lenguaje natural").action((task: string | undefined, flags: RunFlags) => {
  if (!task) {
    program.help();
    return;
  }
  return runTask(task, flags);
}));

program.parseAsync();
