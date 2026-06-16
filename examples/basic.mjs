// Ejemplo mínimo de uso como librería.
// Ejecuta:  node examples/basic.mjs   (con ANTHROPIC_API_KEY en el entorno)
import { runNavia } from "navia-ai";

const { summary, steps } = await runNavia({
  task: "Abre https://example.com y dime el título y el primer párrafo.",
  browser: "chromium",
  hooks: { log: (m) => console.log(m) },
});

console.log(`\n=== Resumen (${steps} pasos) ===\n${summary}`);
