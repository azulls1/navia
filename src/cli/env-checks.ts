/**
 * Comprobaciones de entorno: si un binario existe en el PATH (motores de IA por CLI) y si el
 * ejecutable de un navegador de Playwright está presente. Usadas por el wizard, `run` y `doctor`.
 */

/** ¿Existe el binario `bin` en el PATH (responde a --version)? */
export function cmdExists(bin: string): Promise<boolean> {
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

/** Ruta del ejecutable de un navegador de Playwright si está instalado, o null. */
export async function safeExe(launcher: { executablePath: () => string }): Promise<string | null> {
  const { existsSync } = await import("node:fs");
  try {
    const p = launcher.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
