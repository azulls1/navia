/**
 * Helpers de terminal (TTY): entrada oculta para secretos y salir con ESC durante el wizard.
 * Aislados del wiring de comandos para poder razonarlos/reutilizarlos por separado.
 */
import pc from "picocolors";
import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";

/**
 * Pregunta de entrada OCULTA reutilizando el MISMO readline del wizard (no abre/cierra
 * otro, lo que dejaba un salto de línea fantasma que la siguiente pregunta se comía).
 * Enmascara lo tecleado redibujando solo el prompt en cada pulsación.
 */
export function askHidden(rl: ReturnType<typeof createInterface>, query: string): Promise<string> {
  const onData = (buf: Buffer) => {
    const s = buf.toString();
    if (s === "\n" || s === "\r" || s === "\r\n" || s === "") return; // Enter/EOT: no enmascarar
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
export function attachEscToExit(rl: ReturnType<typeof createInterface>): () => void {
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

/** Lee una línea sin eco (para secretos), para no dejarlos en el historial del shell. */
export function promptHidden(question: string): Promise<string> {
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
