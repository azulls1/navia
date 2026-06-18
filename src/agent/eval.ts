/**
 * `navia eval` (#13 del roadmap): harness de evaluación sobre tareas de sitios vivos
 * (formato Online-Mind2Web) con un juez LLM estilo WebJudge.
 *
 * Para cada tarea: corre el agente, mide fiabilidad/coste (#14 — steps, tokens, recoveries,
 * loopHits, tiempo) y un juez decide éxito/fallo a partir del objetivo y el resumen del agente.
 * Reporta tasa de éxito global y por nivel + métricas agregadas.
 *
 * Nota honesta: el juez v1 valora (tarea + resumen del agente). El juez por SCREENSHOTS clave
 * del WebJudge completo (Online-Mind2Web schema v2) queda como capa posterior; para validación
 * por estado en vivo, usa el flag `--validate` (juez sobre el snapshot real durante la corrida).
 */
import Anthropic from "@anthropic-ai/sdk";
import { runNavia, type NaviaOptions, type NaviaMetrics } from "./agent.js";

export interface EvalTask {
  task_id: string;
  task: string;
  url?: string;
  level?: string;
}

export interface EvalCaseResult {
  task_id: string;
  level?: string;
  success: boolean;
  reason: string;
  steps: number;
  ms: number;
  metrics?: NaviaMetrics;
}

export interface EvalReport {
  total: number;
  passed: number;
  successRate: number;
  byLevel: Record<string, { total: number; passed: number }>;
  avgSteps: number;
  totalTokens: number;
  cases: EvalCaseResult[];
}

const DEFAULT_MODEL = "claude-sonnet-4-6";

const JUDGE_TOOL: Anthropic.Tool = {
  name: "verdict",
  description: "Veredicto de si la tarea se cumplió, a partir del objetivo y el resultado reportado.",
  input_schema: {
    type: "object",
    properties: {
      success: { type: "boolean", description: "true solo si la tarea se cumplió de verdad" },
      reason: { type: "string", description: "justificación breve" },
    },
    required: ["success", "reason"],
  },
};

/** Juez LLM estilo WebJudge (v1: sobre objetivo + resumen del agente). Requiere API key. */
export async function judgeTask(
  task: string,
  summary: string,
  opts: { apiKey?: string; model?: string } = {},
): Promise<{ success: boolean; reason: string }> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("judgeTask requiere ANTHROPIC_API_KEY.");
  const client = new Anthropic({ apiKey, maxRetries: 4 });
  const resp = await client.messages.create({
    model: opts.model ?? process.env.NAVIA_MODEL ?? DEFAULT_MODEL,
    max_tokens: 512,
    tools: [JUDGE_TOOL],
    tool_choice: { type: "tool", name: "verdict" },
    messages: [
      {
        role: "user",
        content: `Objetivo de la tarea: ${task}\n\nResultado reportado por el agente: ${summary}\n\n¿La tarea se cumplió? Sé estricto: si el resultado es vago, ambiguo o no responde al objetivo, márcalo como fallo. Llama a verdict(success, reason).`,
      },
    ],
  });
  const tu = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "verdict");
  const v = tu?.input as any;
  return { success: !!v?.success, reason: v?.reason ?? "" };
}

/** Parsea un dataset JSONL (formato Online-Mind2Web-ish) a EvalTask[]. */
export function parseDataset(jsonl: string): EvalTask[] {
  return jsonl
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      const o = JSON.parse(l);
      return {
        task_id: String(o.task_id ?? o.id ?? i),
        task: o.confirmed_task ?? o.task ?? o.instruction ?? "",
        url: o.url ?? o.website,
        level: o.level ?? o.difficulty,
      } as EvalTask;
    })
    .filter((t) => t.task);
}

/** Agrega los resultados por caso en un reporte (función pura, testeable). */
export function summarizeReport(cases: EvalCaseResult[]): EvalReport {
  const byLevel: Record<string, { total: number; passed: number }> = {};
  let passed = 0;
  let steps = 0;
  let tokens = 0;
  for (const c of cases) {
    if (c.success) passed++;
    steps += c.steps;
    tokens += (c.metrics?.tokensIn ?? 0) + (c.metrics?.tokensOut ?? 0);
    const lvl = c.level ?? "n/a";
    byLevel[lvl] = byLevel[lvl] ?? { total: 0, passed: 0 };
    byLevel[lvl].total++;
    if (c.success) byLevel[lvl].passed++;
  }
  return {
    total: cases.length,
    passed,
    successRate: cases.length ? passed / cases.length : 0,
    byLevel,
    avgSteps: cases.length ? steps / cases.length : 0,
    totalTokens: tokens,
    cases,
  };
}

export interface RunEvalOptions extends Omit<NaviaOptions, "task" | "startUrl"> {
  dataset: EvalTask[];
  /** reloj inyectable (ms). Default Date.now. */
  now?: () => number;
  onCase?: (r: EvalCaseResult) => void;
}

/** Corre el dataset completo: por cada tarea, agente → juez → caso. Devuelve el reporte. */
export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const now = opts.now ?? (() => Date.now());
  const cases: EvalCaseResult[] = [];
  for (const t of opts.dataset) {
    const t0 = now();
    let summary = "";
    let steps = 0;
    let metrics: NaviaMetrics | undefined;
    try {
      const res = await runNavia({ ...opts, task: t.task, startUrl: t.url });
      summary = res.summary;
      steps = res.steps;
      metrics = res.metrics;
    } catch (e) {
      summary = `ERROR de ejecución: ${(e as Error).message}`;
    }
    let verdict = { success: false, reason: "" };
    try {
      verdict = await judgeTask(t.task, summary, { apiKey: opts.apiKey, model: opts.model });
    } catch (e) {
      verdict = { success: false, reason: `juez no disponible: ${(e as Error).message}` };
    }
    const c: EvalCaseResult = { task_id: t.task_id, level: t.level, success: verdict.success, reason: verdict.reason, steps, ms: now() - t0, metrics };
    cases.push(c);
    opts.onCase?.(c);
  }
  return summarizeReport(cases);
}
