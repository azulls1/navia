/**
 * Navia — API de librería.
 *
 * @example
 * ```ts
 * import { runNavia } from "navia-ai";
 *
 * const { summary } = await runNavia({
 *   task: "Abre example.com y dime el título de la página",
 *   browser: "chromium",
 * });
 * console.log(summary);
 * ```
 */
export { BrowserAgent, runNavia } from "./agent/agent.js";
export type { NaviaOptions, NaviaResult } from "./agent/agent.js";
export type { AgentHooks } from "./agent/tools.js";
export { BrowserDriver } from "./browser/driver.js";
export type { BrowserEngine, LaunchOptions } from "./browser/launch.js";
export { buildSystemPrompt } from "./agent/system-prompt.js";
export { replayMacro } from "./agent/replay.js";
export type { ReplayResult } from "./agent/replay.js";
