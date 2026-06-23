/**
 * Tests del catálogo de herramientas del servidor MCP (función pura buildMcpToolList):
 * las herramientas que asumen TTY (confirm_action/wait_for_human) NO se exponen, y el resto
 * se mapea a la forma { name, description, inputSchema }. Sin levantar el transporte stdio.
 */
import { describe, it, expect } from "vitest";
import { buildMcpToolList, EXCLUDED } from "../src/mcp/server.js";
import { TOOL_DEFINITIONS } from "../src/agent/tools.js";

describe("mcp · buildMcpToolList", () => {
  const list = buildMcpToolList(TOOL_DEFINITIONS);
  const names = list.map((t) => t.name);

  it("no expone las herramientas excluidas (TTY)", () => {
    for (const excluded of EXCLUDED) {
      expect(names).not.toContain(excluded);
    }
    expect(names).not.toContain("confirm_action");
    expect(names).not.toContain("wait_for_human");
  });

  it("incluye TODAS las demás herramientas con la forma MCP correcta", () => {
    for (const def of TOOL_DEFINITIONS) {
      if (EXCLUDED.has(def.name)) continue;
      const entry = list.find((t) => t.name === def.name);
      expect(entry, `falta ${def.name}`).toBeDefined();
      expect(typeof entry!.description).toBe("string");
      expect(entry!.inputSchema).toBe(def.input_schema);
    }
  });

  it("el catálogo tiene exactamente (total − excluidas) herramientas", () => {
    const expected = TOOL_DEFINITIONS.filter((t) => !EXCLUDED.has(t.name)).length;
    expect(list.length).toBe(expected);
  });
});
