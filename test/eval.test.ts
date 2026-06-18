import { describe, it, expect } from "vitest";
import { parseDataset, summarizeReport, type EvalCaseResult } from "../src/agent/eval.js";

describe("eval harness", () => {
  it("parseDataset acepta task/confirmed_task y url/website", () => {
    const jsonl = [
      JSON.stringify({ task_id: "a", confirmed_task: "haz X", website: "https://ex.com", level: "easy" }),
      JSON.stringify({ id: 7, task: "haz Y", url: "https://ex.com/2" }),
      "   ",
      JSON.stringify({ task: "" }), // sin tarea → descartado
    ].join("\n");
    const tasks = parseDataset(jsonl);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual({ task_id: "a", task: "haz X", url: "https://ex.com", level: "easy" });
    expect(tasks[1].task_id).toBe("7");
    expect(tasks[1].url).toBe("https://ex.com/2");
  });

  it("summarizeReport agrega tasa de éxito, niveles y tokens", () => {
    const cases: EvalCaseResult[] = [
      { task_id: "1", level: "easy", success: true, reason: "", steps: 3, ms: 1000, metrics: { steps: 3, toolCalls: 3, toolErrors: 0, tokensIn: 100, tokensOut: 20, recoveries: 0, loopHits: 0 } },
      { task_id: "2", level: "easy", success: false, reason: "", steps: 5, ms: 2000 },
      { task_id: "3", level: "hard", success: true, reason: "", steps: 7, ms: 3000, metrics: { steps: 7, toolCalls: 7, toolErrors: 1, tokensIn: 200, tokensOut: 30, recoveries: 1, loopHits: 0 } },
    ];
    const r = summarizeReport(cases);
    expect(r.total).toBe(3);
    expect(r.passed).toBe(2);
    expect(r.successRate).toBeCloseTo(2 / 3);
    expect(r.byLevel.easy).toEqual({ total: 2, passed: 1 });
    expect(r.byLevel.hard).toEqual({ total: 1, passed: 1 });
    expect(r.avgSteps).toBeCloseTo(5);
    expect(r.totalTokens).toBe(350);
  });
});
