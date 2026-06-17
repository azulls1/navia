/**
 * Llave de cifrado para el vault y los perfiles de sesión.
 *
 * Objetivo de UX: el usuario NO debería tener que pensar en una "frase secreta".
 * Por eso el cifrado es transparente por defecto:
 *   1. Si define `$NAVIA_SECRET`, se usa esa frase (máxima seguridad: no toca disco;
 *      ideal para equipos compartidos o usuarios cautelosos).
 *   2. Si no, Navia genera UNA VEZ una llave aleatoria fuerte y la guarda en
 *      `~/.navia/key` (permisos restringidos). A partir de ahí cifra solo.
 *
 * Trade-off honesto: una llave en disco protege contra fisgones casuales y commits
 * accidentales, pero NO contra alguien que ya tiene acceso a tu carpeta de usuario
 * (tendría la caja fuerte y la llave). Para ese caso, usa `$NAVIA_SECRET`.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function keyFile(): string {
  return path.join(os.homedir(), ".navia", "key");
}

/** Devuelve la llave de cifrado efectiva (frase del usuario o llave auto-gestionada). */
export function resolveSecret(): string {
  const env = process.env.NAVIA_SECRET;
  if (env && env.trim()) return env;

  const file = keyFile();
  try {
    if (existsSync(file)) {
      const k = readFileSync(file, "utf8").trim();
      if (k) return k;
    }
  } catch {
    /* ilegible → regeneramos abajo */
  }

  const key = randomBytes(32).toString("hex");
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, key, { encoding: "utf8", mode: 0o600 });
    chmodSync(file, 0o600); // best-effort (en Windows el efecto es limitado)
  } catch {
    /* si no se puede persistir, igual devolvemos la llave: cifra al menos esta sesión */
  }
  return key;
}

/** De dónde sale la llave: "env" (frase del usuario) o "auto" (gestionada por Navia). */
export function secretSource(): "env" | "auto" {
  return process.env.NAVIA_SECRET && process.env.NAVIA_SECRET.trim() ? "env" : "auto";
}
