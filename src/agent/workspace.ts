/**
 * Workspace de tarea (la "memoria/cerebro" de Navia).
 *
 * Cada corrida crea una carpeta nombrada por la tarea con:
 *  - bitacora.md   → log humano legible (lo que va pensando/haciendo, paso a paso)
 *  - trajectory.jsonl → registro estructurado (para `navia replay`)
 *  - resumen.md    → resultado final
 *  - capturas/     → screenshots (si los hay)
 *
 * Ubicación (en orden): --workspace <dir> · $NAVIA_WORKSPACE · vault Obsidian detectado
 * ($NAVIA_OBSIDIAN o carpetas típicas) · Escritorio. Así, si se interrumpe la corrida,
 * queda registro de dónde iba y se puede retomar/replay.
 */
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Workspace {
  dir: string;
  trajectoryPath: string;
  logStep(entry: Record<string, unknown>): Promise<void>;
  writeSummary(text: string): Promise<void>;
  capturasDir: string;
}

function slugify(task: string): string {
  return (
    task
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "tarea"
  );
}

/**
 * Detecta vaults de Obsidian en el equipo (puede haber varios). Genérico y portátil:
 * respeta $NAVIA_OBSIDIAN, y escanea ~/Documents, ~ y ~/Obsidian buscando cualquier
 * carpeta con `.obsidian` (la firma de un vault). No hardcodea nombres ni rutas personales.
 */
export function detectObsidianVaults(): string[] {
  const found: string[] = [];
  if (process.env.NAVIA_OBSIDIAN && existsSync(process.env.NAVIA_OBSIDIAN)) found.push(process.env.NAVIA_OBSIDIAN);
  const home = os.homedir();
  const roots = [path.join(home, "Documents"), home, path.join(home, "Obsidian")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    if (existsSync(path.join(root, ".obsidian"))) found.push(root); // el propio root es un vault
    try {
      for (const name of readdirSync(root)) {
        const child = path.join(root, name);
        if (existsSync(path.join(child, ".obsidian"))) found.push(child); // un hijo directo es un vault
      }
    } catch {
      /* sin permisos de lectura → siguiente */
    }
  }
  return [...new Set(found)];
}

/** Base sensata para crear una carpeta en CUALQUIER equipo: Escritorio → Documentos → home. */
export function defaultWorkspaceBase(): string {
  const home = os.homedir();
  for (const c of [path.join(home, "Desktop"), path.join(home, "Documents")]) {
    if (existsSync(c)) return c;
  }
  return home;
}

function findObsidianBase(): string | null {
  return detectObsidianVaults()[0] ?? null;
}

async function resolveBase(explicit?: string): Promise<{ base: string; where: string }> {
  if (explicit) return { base: explicit, where: explicit };
  if (process.env.NAVIA_WORKSPACE) return { base: process.env.NAVIA_WORKSPACE, where: process.env.NAVIA_WORKSPACE };
  const obs = findObsidianBase();
  if (obs) return { base: path.join(obs, "Navia Runs"), where: `Obsidian (${obs})` };
  const desktop = path.join(os.homedir(), "Desktop");
  const base = existsSync(desktop) ? desktop : os.homedir();
  return { base: path.join(base, "Navia Runs"), where: base };
}

/** Crea (o reutiliza) el workspace de una tarea. `stamp` evita Date.now() para reproducibilidad. */
export async function createWorkspace(task: string, stamp: string, opts?: { dir?: string }): Promise<{ ws: Workspace; where: string }> {
  const { base, where } = await resolveBase(opts?.dir);
  const ts = stamp.replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(base, `${slugify(task)}-${ts}`);
  const capturasDir = path.join(dir, "capturas");
  await mkdir(capturasDir, { recursive: true });

  const trajectoryPath = path.join(dir, "trajectory.jsonl");
  const bitacora = path.join(dir, "bitacora.md");

  await writeFile(
    bitacora,
    `# Bitácora — Navia\n\n- **Tarea:** ${task}\n- **Inicio:** ${stamp}\n\n## Pasos\n\n`,
    "utf8",
  );

  const ws: Workspace = {
    dir,
    trajectoryPath,
    capturasDir,
    async logStep(entry) {
      try {
        await appendFile(trajectoryPath, JSON.stringify({ t: stamp, ...entry }) + "\n", "utf8");
        // Línea humana en la bitácora.
        let line = "";
        if (entry.type === "action") {
          const ok = entry.ok === false ? "❌" : "✓";
          const loc = (entry as any).locator?.name ? ` «${(entry as any).locator.name}»` : "";
          line = `- ${ok} **${entry.tool}**${loc} ${entry.thought ? `— ${entry.thought}` : ""}`;
          if (entry.error) line += ` _(error: ${entry.error})_`;
        } else if (entry.type === "thought") {
          line = `- 💭 ${entry.text}`;
        } else if (entry.type === "done") {
          line = `\n## Resultado\n\n${entry.summary ?? ""}`;
        } else if (entry.type === "start") {
          line = `- ▶️ Inicio (motor ${(entry as any).engine}, IA ${(entry as any).provider})`;
        }
        if (line) await appendFile(bitacora, line + "\n", "utf8");
      } catch {
        /* el registro nunca debe romper la corrida */
      }
    },
    async writeSummary(text) {
      try {
        await writeFile(path.join(dir, "resumen.md"), `# Resumen\n\n${text}\n`, "utf8");
      } catch {
        /* noop */
      }
    },
  };
  return { ws, where };
}
