/**
 * Servidor MCP (Model Context Protocol) de Navia.
 *
 * Expone las herramientas de navegador de Navia (driver con snapshot CDP, refs estables,
 * detector de captcha, perfiles y vault) por stdio, para que clientes como Claude
 * Desktop/Code/Cursor las usen directamente. Aquí el LLM del cliente conduce: no hay
 * loop de agente propio.
 *
 * Reutiliza TOOL_DEFINITIONS + dispatchTool (una sola fuente de verdad de las tools).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import os from "node:os";
import path from "node:path";
import { BrowserDriver } from "../browser/driver.js";
import { TOOL_DEFINITIONS, dispatchTool, type AgentHooks } from "../agent/tools.js";
import { loadSession } from "../browser/session-store.js";
import { getSecret, getTotpSecret, setSecret, setTotp } from "../secrets/vault.js";
import type { BrowserEngine } from "../browser/launch.js";

export interface McpOptions {
  browser?: BrowserEngine;
  profile?: string;
  headless?: boolean;
  cdpPort?: number;
  cdpEndpoint?: string;
}

// confirm_action / wait_for_human asumen TTY: en MCP el humano aprueba en su cliente.
const EXCLUDED = new Set(["confirm_action", "wait_for_human"]);

export async function startMcpServer(opts: McpOptions): Promise<void> {
  const engine = opts.browser ?? "chromium";
  let driver: BrowserDriver | null = null;

  const getDriver = async (): Promise<BrowserDriver> => {
    if (driver) return driver;
    let storageState: unknown;
    let userDataDir: string | undefined;
    if (opts.profile) {
      if (engine === "chrome") userDataDir = path.join(os.homedir(), ".navia", "profiles", `chrome-${opts.profile}`);
      else storageState = (await loadSession(opts.profile)) ?? undefined;
    }
    driver = await BrowserDriver.create({
      engine,
      headless: opts.headless,
      cdpPort: opts.cdpPort,
      cdpEndpoint: opts.cdpEndpoint,
      userDataDir,
      storageState,
    });
    return driver;
  };

  // En MCP, stdout es el canal del protocolo → los logs van a stderr.
  const hooks: AgentHooks = {
    confirmAction: async () => true,
    waitForHuman: async () => "",
    log: (m) => console.error(`[navia] ${m}`),
  };

  const tools = TOOL_DEFINITIONS.filter((t) => !EXCLUDED.has(t.name)).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.input_schema as Record<string, unknown>,
  }));

  const server = new Server({ name: "navia", version: "0.24.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, any>;
    if (EXCLUDED.has(name)) return { content: [{ type: "text", text: "Herramienta no disponible en MCP." }], isError: true };

    // Elicitation de credenciales: si la tool necesita un secreto que no está en el vault, se lo
    // PEDIMOS al usuario por el canal seguro del cliente MCP (no por el contexto del modelo) y lo
    // guardamos cifrado. Degrada con gracia si el cliente no soporta elicitation.
    if ((name === "fill_credential" || name === "fill_totp") && typeof args.key === "string") {
      const exists = name === "fill_credential" ? await getSecret(args.key) : await getTotpSecret(args.key);
      if (exists == null) {
        try {
          const res = await server.elicitInput({
            message: `Navia necesita "${args.key}" para ${name === "fill_credential" ? "rellenar una credencial" : "calcular un código 2FA"}. Se guarda cifrado y NUNCA se muestra al modelo.`,
            requestedSchema: {
              type: "object",
              properties: {
                value: { type: "string", title: name === "fill_credential" ? "Contraseña/secreto" : "Secreto TOTP (base32)" },
              },
              required: ["value"],
            },
          });
          if (res.action === "accept" && res.content?.value) {
            const value = String(res.content.value);
            if (name === "fill_credential") await setSecret(args.key, value);
            else await setTotp(args.key, value.replace(/\s/g, ""));
          }
        } catch {
          /* cliente sin elicitation → dispatchTool devolverá el error normal "no hay secreto" */
        }
      }
    }
    try {
      const out = await dispatchTool(name, args, await getDriver(), hooks);
      const content: Array<Record<string, unknown>> = [];
      if (out.text) content.push({ type: "text", text: out.text });
      if (out.imageBase64) content.push({ type: "image", data: out.imageBase64, mimeType: "image/png" });
      if (content.length === 0) content.push({ type: "text", text: "(ok)" });
      return { content };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
    }
  });

  const cleanup = async () => {
    try {
      await driver?.close();
    } catch {
      /* noop */
    }
  };
  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  await server.connect(new StdioServerTransport());
  console.error(`[navia] servidor MCP listo (stdio · motor ${engine}${opts.profile ? ` · perfil ${opts.profile}` : ""}).`);
}
