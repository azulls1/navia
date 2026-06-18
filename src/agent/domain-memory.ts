/**
 * Memoria por dominio / playbooks (#9 del roadmap, estilo ColorBrowserAgent).
 *
 * Guarda "lógica operativa" reutilizable POR DOMINIO (no la traza concreta) como tips, y los
 * reinyecta en el system prompt cuando Navia vuelve a ese sitio → el agente aprende cada sitio
 * con el uso en vez de redescubrirlo. Persistencia simple en JSON (~/.navia/playbooks/<dominio>.json);
 * retrieval por hostname (URL pattern), sin embeddings (eso sería una capa posterior).
 *
 * Plantilla de tip (Scope/Action/Constraint/Goal); también admite una nota libre (p.ej. la que
 * deja un humano en wait_for_human → conocimiento reutilizable).
 */
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Tip {
  /** Cuándo aplica (página/sección/condición). */
  scope?: string;
  /** Qué hacer. */
  action?: string;
  /** Restricción / cuidado. */
  constraint?: string;
  /** Cómo se alinea con el objetivo. */
  goalAlignment?: string;
  /** Nota libre (p.ej. guía dejada por el humano). */
  note?: string;
}

export interface Playbook {
  domain: string;
  tips: Tip[];
  updated?: string;
}

const PLAYBOOK_DIR = path.join(os.homedir(), ".navia", "playbooks");

/** Hostname normalizado (sin www) de una URL; "" si no es parseable. */
export function domainOf(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function fileFor(domain: string): string {
  return path.join(PLAYBOOK_DIR, domain.replace(/[^a-z0-9.-]/gi, "_") + ".json");
}

/** Clave canónica de un tip, para deduplicar. */
function tipKey(t: Tip): string {
  return JSON.stringify([t.scope ?? "", t.action ?? "", t.constraint ?? "", t.goalAlignment ?? "", t.note ?? ""].map((s) => s.trim().toLowerCase()));
}

/** Inserta un tip si no es duplicado; devuelve la lista resultante (función pura). */
export function mergeTip(tips: Tip[], tip: Tip): Tip[] {
  const key = tipKey(tip);
  if (tips.some((t) => tipKey(t) === key)) return tips;
  return [...tips, tip];
}

/** Renderiza los tips de un dominio como bloque para el system prompt (función pura). */
export function formatTips(domain: string, tips: Tip[]): string {
  if (!tips.length) return "";
  const lines = tips.map((t) => {
    if (t.note && !t.action && !t.scope) return `- ${t.note}`;
    const scope = t.scope ? `[${t.scope}] ` : "";
    const action = t.action ?? "";
    const constraint = t.constraint ? ` — ${t.constraint}` : "";
    const goal = t.goalAlignment ? ` (objetivo: ${t.goalAlignment})` : "";
    const note = t.note ? ` ${t.note}` : "";
    return `- ${scope}${action}${constraint}${goal}${note}`.trim();
  });
  return `NOTAS APRENDIDAS DE ESTE SITIO (${domain}) — tenlas en cuenta:\n${lines.join("\n")}`;
}

/** Lee el playbook de un dominio (o uno vacío si no existe). */
export async function loadPlaybook(domain: string): Promise<Playbook> {
  if (!domain) return { domain, tips: [] };
  try {
    const raw = await readFile(fileFor(domain), "utf8");
    const pb = JSON.parse(raw) as Playbook;
    return { domain, tips: Array.isArray(pb.tips) ? pb.tips : [], updated: pb.updated };
  } catch {
    return { domain, tips: [] };
  }
}

/** Bloque de tips listo para inyectar, a partir de una URL. "" si no hay nada. */
export async function tipsBlockFor(url?: string): Promise<string> {
  const domain = domainOf(url);
  if (!domain) return "";
  const pb = await loadPlaybook(domain);
  return formatTips(domain, pb.tips);
}

/** Añade un tip al playbook del dominio (dedupe) y lo persiste. No lanza si falla la escritura. */
export async function addTip(domainOrUrl: string, tip: Tip, stamp = new Date().toISOString()): Promise<void> {
  const domain = domainOf(domainOrUrl) || domainOrUrl.toLowerCase();
  if (!domain || (!tip.note && !tip.action && !tip.scope && !tip.constraint)) return;
  try {
    const pb = await loadPlaybook(domain);
    const tips = mergeTip(pb.tips, tip);
    if (tips === pb.tips) return; // duplicado: nada que escribir
    await mkdir(PLAYBOOK_DIR, { recursive: true });
    await writeFile(fileFor(domain), JSON.stringify({ domain, tips, updated: stamp }, null, 2), "utf8");
  } catch {
    /* la memoria nunca debe romper la corrida */
  }
}

/** Lista los dominios con playbook guardado. */
export async function listPlaybooks(): Promise<string[]> {
  try {
    const files = await readdir(PLAYBOOK_DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}
