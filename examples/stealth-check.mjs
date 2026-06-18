// Stealth-check (#18): por cada motor lee señales clave de automatización y FALLA si aparece un
// leak NUEVO respecto a un baseline COMMITEADO. El stealth es un objetivo móvil (un update de
// Playwright/Chrome puede reintroducir una fuga) → esto lo vuelve una alarma automática en CI.
//
// Compara contra baseline, no contra absolutos: así una limitación CONOCIDA (p.ej. Playwright
// Firefox no puede ocultar navigator.webdriver) no rompe el build, pero una REGRESIÓN sí.
//
// Nota: comprobación LIGERA (señales JS), offline. La suite completa (rebrowser-bot-detector /
// CreepJS / Scrapfly servidos localmente) es la capa siguiente.
//
//   node examples/stealth-check.mjs                 # chromium + firefox vs baseline
//   node examples/stealth-check.mjs --update-baseline
//   STEALTH_ENGINES=chromium node examples/stealth-check.mjs
import { BrowserDriver } from "../dist/index.js";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(here, "stealth-baseline.json");
const engines = (process.env.STEALTH_ENGINES || "chromium,firefox").split(",").map((s) => s.trim()).filter(Boolean);
const update = process.argv.includes("--update-baseline");

// Señales "rojas": una regresión a true respecto al baseline marca el build.
const RED = ["webdriver"];

async function probe(engine) {
  let driver;
  try {
    driver = await BrowserDriver.create({ engine, headless: true });
    await driver.navigate("https://example.com");
    return await driver.evaluate(`return {
      webdriver: navigator.webdriver === true,
      hasChrome: typeof window.chrome !== 'undefined',
      languages: (navigator.languages || []).length,
      plugins: (navigator.plugins || []).length
    }`);
  } finally {
    await driver?.close();
  }
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
} catch {
  /* sin baseline aún → se puede crear con --update-baseline */
}

const report = {};
let failed = 0;
for (const engine of engines) {
  try {
    const s = await probe(engine);
    report[engine] = s;
    const base = baseline[engine] ?? {};
    const regressions = RED.filter((k) => s[k] === true && base[k] !== true);
    if (regressions.length) {
      console.error(`✗ [${engine}] REGRESIÓN de stealth: ${regressions.join(", ")} (no estaba en el baseline)`);
      failed++;
    } else {
      console.log(`✓ [${engine}] sin regresiones (webdriver=${s.webdriver})`);
    }
  } catch (e) {
    console.error(`⚠️ [${engine}] no se pudo evaluar: ${e.message}`); // motor ausente → no marca rojo
    report[engine] = { error: e.message };
  }
}

if (update) {
  writeFileSync(BASELINE, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`\n✓ Baseline actualizado: ${BASELINE}`);
  process.exit(0);
}

console.log("\n--- reporte stealth ---\n" + JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
