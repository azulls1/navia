// Smoke test del servidor MCP usando un cliente MCP REAL: lista tools, navega y snapshot.
// Ejecuta:  node examples/mcp-smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";

const transport = new StdioClientTransport({ command: "node", args: ["dist/cli.js", "mcp", "--headless"] });
const client = new Client({ name: "navia-smoke", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.log("Tools MCP:", names.join(", "));
assert(names.includes("snapshot") && names.includes("navigate"), "faltan tools básicas");
assert(!names.includes("confirm_action"), "confirm_action no debe exponerse en MCP");

await client.callTool({ name: "navigate", arguments: { url: "https://example.com" } });
const res = await client.callTool({ name: "snapshot", arguments: {} });
const text = res.content.find((c) => c.type === "text")?.text ?? "";
console.log("\n--- snapshot vía MCP ---\n" + text);
assert(/\[ref=\d+\]/.test(text), "esperaba refs en el snapshot vía MCP");

await client.close();
console.log("\n✓ MCP smoke OK (listTools + navigate + snapshot)");
