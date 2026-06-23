/**
 * Ejecución de una tarea desde el CLI: `runTask` (arma hooks de log/confirmación/chat y llama a
 * runNavia) y `chooseWorkspace` (pregunta dónde guardar la bitácora). Separado del wiring de
 * comandos y del wizard para acotar responsabilidades.
 */
import pc from "picocolors";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runNavia, resolveProvider } from "../agent/agent.js";
import { cfg, type RunFlags } from "./shared.js";
import { cmdExists } from "./env-checks.js";

/**
 * Pregunta al inicio DÓNDE guardar la bitácora/memoria. Portátil: las opciones se
 * construyen en runtime según el equipo (vaults de Obsidian detectados, base por
 * defecto del SO, o una ruta a mano). Devuelve la carpeta base elegida.
 */
export async function chooseWorkspace(existing?: ReturnType<typeof createInterface>): Promise<string | undefined> {
  const { detectObsidianVaults, defaultWorkspaceBase } = await import("../agent/workspace.js");
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

export async function runTask(task: string, flags: RunFlags) {
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
    const { resolveOpenAIPreset } = await import("../providers/openai-provider.js");
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
        ? `${flags.browser} · IA: gratis (${(await import("../providers/openai-provider.js")).resolveOpenAIPreset(flags.openaiPreset).label})`
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
                const { addTip, domainOf } = await import("../agent/domain-memory.js");
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
