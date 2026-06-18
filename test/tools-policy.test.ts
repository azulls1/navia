import { describe, it, expect } from "vitest";
import { toolDefinitions } from "../src/agent/tools.js";

const names = (p?: Parameters<typeof toolDefinitions>[0]) => toolDefinitions(p).map((t) => t.name);

describe("toolDefinitions — política de tools", () => {
  it("por defecto incluye screenshot y evaluate", () => {
    const n = names();
    expect(n).toContain("screenshot");
    expect(n).toContain("evaluate");
  });

  it("vision:false oculta screenshot (proveedor CLI sin imágenes)", () => {
    const n = names({ vision: false });
    expect(n).not.toContain("screenshot");
    expect(n).toContain("evaluate"); // las demás siguen
  });

  it("allowEval:false oculta evaluate (sitios hostiles)", () => {
    const n = names({ allowEval: false });
    expect(n).not.toContain("evaluate");
    expect(n).toContain("screenshot");
  });

  it("vision:true mantiene screenshot (proveedor API con visión)", () => {
    expect(names({ vision: true })).toContain("screenshot");
  });
});
