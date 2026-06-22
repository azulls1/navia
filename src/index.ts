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
export type { NaviaOptions, NaviaResult, NaviaMetrics } from "./agent/agent.js";
export type { AgentHooks, ToolPolicy } from "./agent/tools.js";
export { dispatchTool, toolDefinitions, TOOL_DEFINITIONS } from "./agent/tools.js";
export { BrowserDriver } from "./browser/driver.js";
export type { BrowserEngine, LaunchOptions } from "./browser/launch.js";
export { buildSystemPrompt } from "./agent/system-prompt.js";
export { extract } from "./agent/extract.js";
export type { ExtractOptions } from "./agent/extract.js";
export { observe, act } from "./agent/primitives.js";
export type { ObserveAction, ObserveOptions, ActResult } from "./agent/primitives.js";
export { cliComplete } from "./providers/cli-provider.js";
export { OpenAICompatClient, resolveOpenAIPreset } from "./providers/openai-provider.js";
export type { OpenAIPresetConfig } from "./providers/openai-provider.js";
export { ocrCaptcha } from "./agent/captcha-ocr.js";
export { runEval, judgeTask, parseDataset, summarizeReport } from "./agent/eval.js";
export type { EvalTask, EvalCaseResult, EvalReport, RunEvalOptions } from "./agent/eval.js";
export { replayMacro } from "./agent/replay.js";
export type { ReplayResult } from "./agent/replay.js";
export { setSecret, setTotp, getSecret, getTotpSecret, listKeys, getSecretOrigins, setSecretOrigins, normalizeOrigin } from "./secrets/vault.js";
export { addTip, loadPlaybook, listPlaybooks, formatTips, domainOf, tipsBlockFor } from "./agent/domain-memory.js";
export type { Tip, Playbook } from "./agent/domain-memory.js";
