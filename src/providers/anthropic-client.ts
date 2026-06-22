/**
 * Creación centralizada del cliente Anthropic. Antes estaba repetida en agent.ts, eval.ts,
 * extract.ts y primitives.ts (mismo `new Anthropic({ apiKey, maxRetries: 4 })` + misma validación
 * de que existe la key). Única fuente de verdad → un solo sitio si cambia maxRetries/timeout.
 */
import Anthropic from "@anthropic-ai/sdk";

export function createAnthropic(apiKey?: string): Anthropic {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Falta ANTHROPIC_API_KEY (pásala en opts.apiKey o como variable de entorno).");
  // maxRetries cubre errores transitorios de la API (429/5xx) con backoff automático.
  return new Anthropic({ apiKey: key, maxRetries: 4 });
}
