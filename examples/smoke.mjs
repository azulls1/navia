// Smoke test SIN API key: valida el driver y el camino CDP (snapshot AX-tree,
// shadow DOM, click y type), además de la extracción con evaluate.
// Ejecuta:  node examples/smoke.mjs
import { BrowserDriver } from "../dist/index.js";
import assert from "node:assert";

const driver = await BrowserDriver.create({ engine: "chromium", headless: true });

// 1) Página real: snapshot CDP (refs = backendNodeId) + extracción con evaluate.
await driver.navigate("https://example.com");
const snap = await driver.snapshot();
console.log(snap);
assert(/\[ref=\d+\]/.test(snap), "esperaba refs numéricos (backendNodeId) del snapshot CDP");
const links = await driver.evaluate("return [...document.querySelectorAll('a')].map(a => a.href)");
assert(Array.isArray(links) && links.length >= 1, "esperaba extraer enlaces con evaluate");
console.log("Enlaces extraídos:", JSON.stringify(links));

// 2) Shadow DOM + acciones vía CDP (lo que el snapshot viejo NO veía).
await driver.page.setContent(`<div id="host"></div><script>
  const sr = document.getElementById('host').attachShadow({ mode: 'open' });
  const b = document.createElement('button'); b.textContent = 'Shadow Btn'; b.onclick = () => { window.__clicked = true; };
  const i = document.createElement('input'); i.setAttribute('aria-label', 'Campo');
  sr.append(b, i);
</script>`);
const snap2 = await driver.snapshot();
console.log("\n--- snapshot shadow DOM ---\n" + snap2);
assert(snap2.includes("Shadow Btn"), "el snapshot CDP debe ver el botón dentro del shadow DOM");

const btn = snap2.match(/button "Shadow Btn" \[ref=(\d+)\]/);
assert(btn, "esperaba un ref para el botón del shadow DOM");
await driver.click(btn[1]);
assert(await driver.evaluate("return window.__clicked === true"), "el click vía CDP debió disparar onclick");

const box = snap2.match(/textbox "Campo" \[ref=(\d+)\]/);
assert(box, "esperaba un ref para el input del shadow DOM");
await driver.type(box[1], "hola");
const val = await driver.evaluate("return document.getElementById('host').shadowRoot.querySelector('input').value");
assert(val === "hola", `type vía CDP debió escribir 'hola' (obtuvo '${val}')`);

await driver.close();
console.log("\n✓ Smoke test OK (CDP snapshot + shadow DOM + click + type)");
