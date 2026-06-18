// Smoke test de iframes cross-origin (OOPIF): dos servidores locales en orígenes
// distintos; el snapshot debe incluir el contenido del iframe con ref compuesto fN_id,
// y un click sobre ese ref debe funcionar (cruza el límite de proceso/frame).
import { BrowserDriver } from "../dist/index.js";
import assert from "node:assert";
import http from "node:http";

function serve(html) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

const inner = await serve(
  `<!doctype html><meta charset=utf-8><body><button id="b" onclick="this.textContent='CLICKED'">DentroDelFrame</button></body>`,
);
const innerPort = inner.address().port;
const outer = await serve(
  `<!doctype html><meta charset=utf-8><body><h1>Main</h1><iframe src="http://127.0.0.1:${innerPort}" width="400" height="200"></iframe></body>`,
);
const outerPort = outer.address().port;

const driver = await BrowserDriver.create({ engine: "chromium", headless: true });
try {
  // Distinto puerto = distinto origen → el iframe entra por la rama cross-origin.
  // Nota: localhost/127.0.0.1 NO se aíslan en procesos separados, así que este iframe es
  // same-process → su contenido entra por el árbol principal (ref simple). Esto verifica
  // la cobertura de iframes + click cruzando el frame, y que la rama OOPIF no rompe.
  // (Un OOPIF real —cross-site, p.ej. Turnstile— usa ref compuesto fN_id; no es testeable
  // localmente porque las direcciones locales no se aíslan.)
  await driver.navigate(`http://localhost:${outerPort}`);
  await driver.waitFor({ timeMs: 800 });
  const snap = await driver.snapshot();
  console.log(snap);
  const m = snap.match(/button "DentroDelFrame" \[ref=(v\d+:f?\d+_?\d*)\]/);
  assert(m, "esperaba ver el botón del iframe en el snapshot\n" + snap);

  await driver.click(m[1]);
  await driver.waitFor({ timeMs: 500 });
  const snap2 = await driver.snapshot();
  assert(snap2.includes("CLICKED"), "el click sobre el botón del iframe debió cambiarlo a CLICKED");

  console.log("\n✓ OOPIF smoke OK (cobertura de iframe + click; rama OOPIF sin romper)");
} finally {
  await driver.close();
  outer.close();
  inner.close();
}
