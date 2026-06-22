/**
 * Proveedor de inferencia por CLI: usa un binario de IA ya autenticado en la terminal
 * como motor — SIN necesidad de API key. Le pasamos el prompt y devolvemos el texto.
 *
 * Hay tres modos, en orden de fiabilidad:
 *
 *  1. `ant` (Anthropic CLI) — RECOMENDADO. `ant messages create` es un endpoint de
 *     completado de un solo turno sobre el MISMO login OAuth (`ant auth login`), sin key.
 *     Devuelve texto limpio (el JSON de acción que pedimos), sin la persona de agente de
 *     Claude Code. Instalar: ver https://platform.claude.com/docs/en/api/sdks/cli
 *
 *  2. Genérico — define NAVIA_CLI_CMD="mi-cli --flag" y se usa tal cual (stdout = respuesta).
 *
 *  3. `claude` (Claude Code) — FALLBACK FRÁGIL. `claude -p` es un AGENTE interactivo, no un
 *     endpoint de completado: su propio system prompt puede ignorar el "responde solo JSON"
 *     y contestar en prosa (de ahí los "respuesta no-JSON ignorada"). Lo ejecutamos desde un
 *     cwd neutro para no cargar el CLAUDE.md del proyecto, pero NO es de fiar para el loop.
 *     Usa `ant` si puedes.
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModel } from "../config.js";

/**
 * Una ÚNICA carpeta scratch por proceso para el modo `claude`. Antes se creaba y borraba
 * en cada llamada, lo que en Windows provocaba EPERM (el `claude` hijo aún la tenía abierta)
 * y cortaba la corrida. Ahora se crea una vez, se reutiliza, y el SO la limpia al salir.
 */
let scratchDir: string | null = null;
function getScratch(): string {
  if (scratchDir) return scratchDir;
  scratchDir = mkdtempSync(join(tmpdir(), "navia-cli-"));
  writeFileSync(join(scratchDir, "CLAUDE.md"), "Responde ÚNICAMENTE con el objeto JSON pedido. Nada de prosa ni explicación.\n");
  return scratchDir;
}

export interface CliProviderOptions {
  /** Binario base (default "claude"). Pon "ant" para el modo recomendado. Ignorado si NAVIA_CLI_CMD. */
  command?: string;
  /** Modelo a usar (solo modo `ant`). Default claude-sonnet-4-6. */
  model?: string;
  timeoutMs?: number;
}

/** Lanza un proceso, le escribe `stdin`, y resuelve con su stdout (o rechaza). */
function run(
  bin: string,
  args: string[],
  stdin: string,
  opts: { timeoutMs?: number; cwd?: string } | undefined,
): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32", // resolver claude.cmd / ant.cmd en Windows
      cwd: opts?.cwd,
    });
    let out = "";
    let err = "";
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          child.kill();
          reject(new Error(`El CLI '${bin}' no respondió en ${opts.timeoutMs}ms.`));
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`No se pudo ejecutar '${bin}': ${e.message}. ¿Está instalado y en el PATH?`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ out, err, code });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

export async function cliComplete(prompt: string, opts?: CliProviderOptions, imagePaths?: string[]): Promise<string> {
  const envCmd = process.env.NAVIA_CLI_CMD;
  const imgs = imagePaths?.filter(Boolean) ?? [];

  // Modo 2: CLI genérico definido por el usuario (stdout = respuesta). No sabemos si ve
  // imágenes → si las hay, al menos le pasamos las rutas como texto (best-effort).
  if (envCmd) {
    const parts = envCmd.split(" ").filter(Boolean);
    const p = imgs.length ? `${prompt}\n\n(Imágenes disponibles en: ${imgs.join(", ")})` : prompt;
    const { out, err, code } = await run(parts[0], parts.slice(1), p, { timeoutMs: opts?.timeoutMs });
    if (code !== 0 && !out) throw new Error(`El CLI '${parts[0]}' salió con código ${code}: ${err.slice(0, 300)}`);
    return out.trim();
  }

  const bin = opts?.command ?? "claude";

  // Modo 1: Anthropic CLI — completado limpio sobre el login OAuth, sin key.
  // El cuerpo de la petición va por stdin como JSON (JSON.stringify escapa todo de forma
  // segura, evitando problemas de comillas/llaves en argv, sobre todo en Windows).
  if (bin === "ant") {
    // Con imágenes: bloques de imagen (base64) + texto → ant SÍ ve (Messages API estándar).
    const content: any[] = imgs.map((p) => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: readFileSync(p).toString("base64") },
    }));
    content.push({ type: "text", text: prompt });
    const body = JSON.stringify({
      model: resolveModel(opts?.model),
      max_tokens: 8192,
      messages: [{ role: "user", content: imgs.length ? content : prompt }],
    });
    // `--transform` saca el primer bloque de texto; `-r` lo imprime sin comillas.
    const args = ["messages", "create", "--transform", 'content.#(type=="text").text', "-r"];
    const { out, err, code } = await run("ant", args, body, { timeoutMs: opts?.timeoutMs });
    if (code !== 0) {
      throw new Error(
        `'ant messages create' salió con código ${code}: ${err.slice(0, 300)}. ` +
          `¿Hiciste 'ant auth login'? Si no tienes 'ant', instala el Anthropic CLI o usa --provider api.`,
      );
    }
    return out.trim();
  }

  // Modo 3: claude (Claude Code) — fallback. Lo corremos desde un cwd temporal neutro
  // (carpeta reutilizada) para no arrastrar el CLAUDE.md/contexto del proyecto.
  // Con imágenes: le pasamos las RUTAS y le pedimos leerlas con su herramienta Read (Claude
  // Code lee PNGs locales perfectamente — verificado).
  const scratch = getScratch();
  {
    const p = imgs.length
      ? `${prompt}\n\nIMÁGENES ADJUNTAS — léelas con tu herramienta Read (rutas absolutas) y úsalas para tu respuesta:\n${imgs.join("\n")}`
      : prompt;
    const args = ["-p", "--output-format", "json"];
    const { out, err, code } = await run("claude", args, p, { timeoutMs: opts?.timeoutMs, cwd: scratch });
    if (code !== 0 && !out) throw new Error(`El CLI 'claude' salió con código ${code}: ${err.slice(0, 300)}`);
    // Claude Code envuelve la respuesta en JSON: { ..., result: "<texto>" }. Sacamos .result.
    try {
      const j = JSON.parse(out);
      return String(j.result ?? "").trim();
    } catch {
      return out.trim(); // cae a stdout crudo
    }
  }
}
