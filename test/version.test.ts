import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * La versión vive en 3 sitios (package.json, cli.ts, mcp/server.ts). Si se desincronizan,
 * el CLI o el servidor MCP reportarían una versión equivocada. Este test lo evita.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version as string;

describe("versión sincronizada en todo el código", () => {
  it("cli.ts declara la misma versión que package.json", () => {
    const cli = readFileSync(path.join(root, "src", "cli.ts"), "utf8");
    expect(cli).toContain(`.version("${version}")`);
  });

  it("mcp/server.ts declara la misma versión que package.json", () => {
    const srv = readFileSync(path.join(root, "src", "mcp", "server.ts"), "utf8");
    expect(srv).toContain(`version: "${version}"`);
  });
});
