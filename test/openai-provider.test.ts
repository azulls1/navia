import { describe, it, expect } from "vitest";
import { __test, resolveOpenAIPreset } from "../src/providers/openai-provider.js";

const { toOpenAITools, toOpenAIMessages, fromOpenAIResponse } = __test;

describe("openai-provider · adaptador de formato", () => {
  it("traduce tools Anthropic → formato OpenAI function", () => {
    const tools = [{ name: "click", description: "haz click", input_schema: { type: "object", properties: { ref: { type: "string" } } } }];
    const out = toOpenAITools(tools)!;
    expect(out[0]).toEqual({
      type: "function",
      function: { name: "click", description: "haz click", parameters: { type: "object", properties: { ref: { type: "string" } } } },
    });
  });

  it("system (bloques) → mensaje system; user string → user", () => {
    const msgs = toOpenAIMessages([{ type: "text", text: "eres Navia" }], [{ role: "user", content: "hola" }]);
    expect(msgs[0]).toEqual({ role: "system", content: "eres Navia" });
    expect(msgs[1]).toEqual({ role: "user", content: "hola" });
  });

  it("assistant con tool_use → tool_calls; user con tool_result → mensaje role:tool", () => {
    const msgs = toOpenAIMessages(undefined, [
      { role: "assistant", content: [{ type: "text", text: "voy a hacer click" }, { type: "tool_use", id: "c1", name: "click", input: { ref: "v1:7" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "ok, página cambió" }] }] },
    ]);
    const asst = msgs.find((m: any) => m.role === "assistant")!;
    expect(asst.tool_calls[0]).toMatchObject({ id: "c1", type: "function", function: { name: "click" } });
    expect(JSON.parse(asst.tool_calls[0].function.arguments)).toEqual({ ref: "v1:7" });
    const tool = msgs.find((m: any) => m.role === "tool")!;
    expect(tool).toEqual({ role: "tool", tool_call_id: "c1", content: "ok, página cambió" });
  });

  it("respuesta OpenAI con tool_calls → bloques Anthropic + stop_reason tool_use", () => {
    const resp = fromOpenAIResponse({
      id: "x",
      choices: [{ message: { content: "pensando", tool_calls: [{ id: "t1", function: { name: "navigate", arguments: '{"url":"https://x.com"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(resp.stop_reason).toBe("tool_use");
    expect(resp.content).toEqual([
      { type: "text", text: "pensando" },
      { type: "tool_use", id: "t1", name: "navigate", input: { url: "https://x.com" } },
    ]);
    expect(resp.usage.input_tokens).toBe(10);
    expect(resp.usage.output_tokens).toBe(5);
  });

  it("respuesta solo texto → stop_reason end_turn; arguments inválidos → input vacío sin romper", () => {
    const plain = fromOpenAIResponse({ choices: [{ message: { content: "listo" } }] });
    expect(plain.stop_reason).toBe("end_turn");
    const bad = fromOpenAIResponse({ choices: [{ message: { tool_calls: [{ id: "t", function: { name: "x", arguments: "{no-json" } }] } }] });
    expect((bad.content[0] as any).input).toEqual({});
  });

  it("presets: groq/ollama/openrouter con base URL correcta; env override gana", () => {
    expect(resolveOpenAIPreset("groq").baseURL).toBe("https://api.groq.com/openai/v1");
    expect(resolveOpenAIPreset("ollama").baseURL).toMatch(/localhost:11434/);
    expect(resolveOpenAIPreset("openrouter").baseURL).toBe("https://openrouter.ai/api/v1");
    process.env.NAVIA_OPENAI_MODEL = "mi-modelo";
    expect(resolveOpenAIPreset("groq").model).toBe("mi-modelo");
    delete process.env.NAVIA_OPENAI_MODEL;
  });
});
