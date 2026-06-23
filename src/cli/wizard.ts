/**
 * Modo interactivo (wizard): da la bienvenida y pregunta todo lo necesario (motor de IA, URL,
 * login, tarea, navegador, bitácora), guarda la contraseña en el vault cifrado y ejecuta vía
 * runTask. Es la parte conversacional del CLI, aislada del wiring de comandos.
 */
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { BrowserEngine } from "../browser/launch.js";
import { setSecret } from "../secrets/vault.js";
import type { RunFlags } from "./shared.js";
import { askHidden, attachEscToExit } from "./tty.js";
import { cmdExists } from "./env-checks.js";
import { detectLoginOnPage } from "./login-probe.js";
import { runTask, chooseWorkspace } from "./run.js";

/** Banner ASCII de bienvenida (solo en modo interactivo, no en --json/CI). */
function banner(version: string): string {
  const art = [
    "   ███╗   ██╗ █████╗ ██╗   ██╗██╗ █████╗ ",
    "   ████╗  ██║██╔══██╗██║   ██║██║██╔══██╗",
    "   ██╔██╗ ██║███████║██║   ██║██║███████║",
    "   ██║╚██╗██║██╔══██║╚██╗ ██╔╝██║██╔══██║",
    "   ██║ ╚████║██║  ██║ ╚████╔╝ ██║██║  ██║",
    "   ╚═╝  ╚═══╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚═╝  ╚═╝",
  ].join("\n");
  return pc.cyan(art) + pc.dim(`\n   Agente de navegador con IA · v${version}\n`);
}

/** Detecta si Navia corre DENTRO de otra IA/agente (Claude Code, OpenCode, Cursor…). */
function detectAgentHost(): string | null {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "Claude Code";
  if (process.env.OPENCODE || process.env.OPENCODE_BIN) return "OpenCode";
  if (process.env.OPENCLAW) return "OpenClaw";
  if (process.env.CURSOR_AGENT || process.env.CURSOR_TRACE_ID) return "Cursor";
  return null;
}

export async function runWizard(base: Partial<RunFlags>, version: string): Promise<void> {
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

  console.log("\n" + banner(version));
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
      const { isVaultReadable, backupVault } = await import("../secrets/vault.js");
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
      const { secretSource } = await import("../secrets/key.js");
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
      const { ocrAvailable, installOcr } = await import("../agent/captcha-ocr.js");
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
