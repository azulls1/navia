#!/usr/bin/env node
/**
 * CLI `navia` — registro de comandos y wiring. La lógica vive en src/cli/*:
 *   shared.ts (cfg, RunFlags, browserOpt) · run.ts (runTask) · wizard.ts (modo interactivo)
 *   tty.ts (entrada oculta/ESC) · login-probe.ts (sonda de login) · env-checks.ts (binarios)
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
import { BrowserDriver } from "./browser/driver.js";
import { saveSession } from "./browser/session-store.js";
import { setSecret, setTotp, listKeys } from "./secrets/vault.js";
import { startMcpServer } from "./mcp/server.js";
import os from "node:os";
import path from "node:path";
import type { BrowserEngine } from "./browser/launch.js";
import { loadConfigSync, saveConfig, type NaviaConfig } from "./config.js";
import { cfg, browserOpt, type RunFlags } from "./cli/shared.js";
import { runTask } from "./cli/run.js";
import { runWizard } from "./cli/wizard.js";
import { cmdExists, safeExe } from "./cli/env-checks.js";
import { promptHidden } from "./cli/tty.js";

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
  .version("0.28.0");

// `navia run "tarea"` — también es el comando por defecto: `navia "tarea"`.
browserOpt(
  program
    .command("run", { isDefault: true })
    .description("Ejecutar una tarea (comando por defecto)")
    .argument("[task]", "qué hacer, en lenguaje natural"),
).action((task: string | undefined, flags: RunFlags) => {
  // Sin tarea → modo interactivo (bienvenida + preguntas guiadas).
  if (!task) return runWizard(flags, program.version()!);
  return runTask(task, flags);
});

// `navia start` — modo interactivo explícito (bienvenida + preguntas).
browserOpt(program.command("start").description("Modo interactivo guiado: bienvenida y preguntas (URL, login, tarea, motor)…")).action(
  (flags: RunFlags) => runWizard(flags, program.version()!),
);

// `navia extract` — extracción estructurada y tipada (web → JSON conforme a un schema).
program
  .command("extract [instruccion]")
  .description("Extraer datos estructurados de una página a JSON validado contra un schema (web → datos).")
  .option("--url <url>", "URL a abrir antes de extraer")
  .option("--schema <archivo>", "archivo .json con el schema JSON deseado")
  .option("-b, --browser <engine>", "motor: chromium | firefox | chrome | patchright", (process.env.NAVIA_BROWSER as BrowserEngine) || cfg.browser || "chromium")
  .option("-p, --profile <name>", "perfil guardado con 'navia login'")
  .option("-m, --model <model>", "modelo de Claude")
  .option("--headless", "ejecutar sin ventana visible")
  .option("--format <fmt>", "formato de salida: json | csv | ndjson", "json")
  .option("--out <archivo>", "escribir el resultado en un archivo (por defecto: stdout)")
  .action(async (instruccion: string | undefined, opts: { url?: string; schema?: string; browser: BrowserEngine; profile?: string; model?: string; headless?: boolean; format: string; out?: string }) => {
    if (!instruccion || !opts.schema) {
      console.error(pc.red("✗ Uso: navia extract \"qué extraer\" --schema schema.json [--url https://...] [--format csv|ndjson] [--out archivo]"));
      process.exit(1);
    }
    if (!["json", "csv", "ndjson"].includes(opts.format)) {
      console.error(pc.red(`✗ --format inválido "${opts.format}"; usa json | csv | ndjson.`));
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
      let outStr: string;
      let count = "";
      if (opts.format === "json") {
        outStr = JSON.stringify(data, null, 2);
      } else {
        const { toCSV, toNDJSON, resultToRows } = await import("./agent/export.js");
        const rows = resultToRows(data);
        count = `${rows.length} fila(s) `;
        outStr = opts.format === "csv" ? toCSV(rows) : toNDJSON(rows);
      }
      if (opts.out) {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(opts.out, outStr, "utf8");
        console.log(pc.green(`✓ ${count}escritas en ${opts.out} (${opts.format}).`));
      } else {
        console.log(outStr);
      }
    } catch (err) {
      console.error(pc.red(`\n✗ Error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  });

// `navia replay <archivo>` — re-ejecuta una macro grabada con --record, sin LLM.
program
  .command("replay <archivo>")
  .description("Re-ejecutar una macro (JSONL de --record) de forma determinista, SIN IA ni API key.")
  .option("-b, --browser <engine>", "motor: chromium | firefox | chrome | patchright", (process.env.NAVIA_BROWSER as BrowserEngine) || cfg.browser || "chromium")
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
  .option("-b, --browser <engine>", "motor: chromium | firefox | chrome | patchright", (process.env.NAVIA_BROWSER as BrowserEngine) || cfg.browser || "chromium")
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
  .option("-b, --browser <engine>", "motor: chromium | firefox | chrome", (process.env.NAVIA_BROWSER as BrowserEngine) || cfg.browser || "chromium")
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
  .option("-b, --browser <engine>", "motor: chromium | firefox | chrome", (process.env.NAVIA_BROWSER as BrowserEngine) || cfg.browser || "chromium")
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
