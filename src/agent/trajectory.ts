/**
 * Trajectory recording: registra cada paso de una corrida en JSONL para depurar,
 * reproducir o construir evals. Se guarda en ~/.navia/trajectories/ (o una ruta dada).
 *
 * No registra valores de secretos: fill_credential/fill_totp solo llevan la CLAVE en sus
 * args, nunca el valor. Las observaciones se truncan para acotar el archivo.
 */
import { mkdir, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Recorder {
  path: string | null;
  log(entry: Record<string, unknown>): Promise<void>;
}

const NOOP: Recorder = { path: null, async log() {} };

export function createRecorder(record?: boolean | string, stamp?: string): Recorder {
  if (!record) return NOOP;
  const ts = (stamp ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const file = typeof record === "string" ? record : path.join(os.homedir(), ".navia", "trajectories", `run-${ts}.jsonl`);
  let ensured = false;
  return {
    path: file,
    async log(entry) {
      try {
        if (!ensured) {
          await mkdir(path.dirname(file), { recursive: true });
          ensured = true;
        }
        await appendFile(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n", "utf8");
      } catch {
        /* el registro nunca debe romper la corrida */
      }
    },
  };
}

export function preview(s: string, max = 1200): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
