import { describe, it, expect } from "vitest";
import { createRecorder, preview } from "../src/agent/trajectory.js";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("trajectory recorder", () => {
  it("no hace nada si record es falsy", async () => {
    const r = createRecorder(false);
    expect(r.path).toBeNull();
    await r.log({ a: 1 }); // no debe lanzar
  });

  it("escribe JSONL (una línea por entrada) en la ruta dada", async () => {
    const file = path.join(os.tmpdir(), `navia-traj-${Date.now()}.jsonl`);
    const r = createRecorder(file);
    expect(r.path).toBe(file);
    await r.log({ type: "start", task: "x" });
    await r.log({ step: 1, type: "action", tool: "navigate" });
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.type).toBe("start");
    expect(first.t).toBeTruthy(); // timestamp añadido
    expect(JSON.parse(lines[1]).tool).toBe("navigate");
    await rm(file, { force: true });
  });

  it("preview trunca textos largos", () => {
    expect(preview("hola", 10)).toBe("hola");
    expect(preview("x".repeat(50), 10)).toBe("x".repeat(10) + "…");
  });
});
