// Smoke test SIN API key: valida el driver y el camino CDP (snapshot AX-tree,
// shadow DOM, click y type), además de la extracción con evaluate.
// Ejecuta:  node examples/smoke.mjs
import { BrowserDriver } from "../dist/index.js";
import assert from "node:assert";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

// 3) Multi-pestaña
await driver.newTab("https://example.com");
let tabs = await driver.listTabs();
assert((tabs.match(/\[\d+\]/g) || []).length >= 2, "esperaba al menos 2 pestañas");
await driver.selectTab(0);
await driver.closeTab(1);
console.log("\n--- tabs ---\n" + (await driver.listTabs()));

// 4) Subida de archivo
const tmp = path.join(os.tmpdir(), "navia-upload-test.txt");
writeFileSync(tmp, "contenido de prueba");
await driver.page.setContent(`<input type="file" aria-label="archivo">`);
const snap3 = await driver.snapshot();
const fileRef = snap3.match(/"archivo" \[ref=(\d+)\]/);
assert(fileRef, "esperaba un ref para el input de archivo\n" + snap3);
await driver.uploadFile(fileRef[1], [tmp]);
const uploaded = await driver.evaluate("return document.querySelector('input[type=file]').files[0]?.name");
assert(uploaded === "navia-upload-test.txt", `upload falló (obtuvo '${uploaded}')`);
console.log("✓ upload OK:", uploaded);

// 5) Descarga (soft check)
await driver.page.setContent(`<a download="nota.txt" href="data:text/plain,hola">baja</a>`);
const snap4 = await driver.snapshot();
const dlRef = snap4.match(/link "baja" \[ref=(\d+)\]/);
if (dlRef) {
  await driver.click(dlRef[1]);
  await driver.waitFor({ timeMs: 1500 });
  const dls = driver.listDownloads();
  console.log(dls.length ? "✓ download OK: " + dls[dls.length - 1] : "ⓘ download no capturada (no crítico)");
}

await driver.close();
console.log("\n✓ Smoke test OK (CDP + shadow DOM + click + type + tabs + upload + download)");
