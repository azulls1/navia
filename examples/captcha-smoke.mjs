// Smoke del flujo de captcha/login (v0.23.0): detección determinista del captcha de imagen,
// estado vacío/relleno, y verificación REAL de login. Sin API key (solo driver).
//   node examples/captcha-smoke.mjs
import { BrowserDriver } from "../dist/index.js";
import assert from "node:assert";

const driver = await BrowserDriver.create({ engine: "chromium", headless: true });
try {
  // Formulario tipo CFE: usuario + password + captcha de imagen + "Ingresar".
  const cap = `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='150' height='50'><rect width='150' height='50' fill='%23eee'/><text x='12' y='35' font-size='28'>PCF53</text></svg>`;
  await driver.page.setContent(`
    <form>
      <label>USUARIO:</label><input type="text" name="txtUsuario">
      <label>CONTRASEÑA:</label><input type="password" name="txtPassword">
      <img id="cap" width="150" height="50" src="${cap}">
      <label for="txtCaptcha">INGRESA EL TEXTO QUE APARECE EN LA IMAGEN:</label>
      <input id="txtCaptcha" name="txtCaptcha" type="text">
      <button id="ingresar" type="button">INGRESAR</button>
    </form>`);
  await driver.waitFor({ timeMs: 400 });
  await driver.snapshot();

  // 1) Detecta el captcha y lo marca VACÍO, con refs del input y del <img>.
  const c1 = await driver.detectTextCaptcha();
  console.log("detectTextCaptcha (vacío):", JSON.stringify(c1));
  assert(c1.present, "debió detectar el captcha de imagen");
  assert(c1.empty, "el captcha debe estar vacío");
  assert(c1.inputRef, "debió devolver inputRef del captcha");
  assert(c1.imgRef, "debió devolver imgRef del <img> del captcha");

  // 2) Recorte+preprocesado del captcha por ref (no debe romper).
  const shot = await driver.screenshot(c1.imgRef);
  assert(typeof shot === "string" && shot.length > 100, "screenshot del captcha debió devolver base64");
  console.log("✓ screenshot recortado del captcha OK (" + shot.length + " b64 chars)");

  // 3) Tras escribir el captcha, ya NO está vacío.
  await driver.type(c1.inputRef, "PCF53");
  const c2 = await driver.detectTextCaptcha();
  assert(c2.present && !c2.empty, "tras escribir, el captcha NO debe figurar vacío");
  console.log("✓ gating: captcha vacío→lleno detectado correctamente");

  // 4) Verificación de login: con el form presente (password visible) = FALLÓ / no confirmado.
  const before = await driver.assessLoginOutcome("about:blank");
  console.log("assessLoginOutcome (form presente):", JSON.stringify(before));
  assert(before.status === "failed", "con el form de login presente debe ser 'failed' (no entró)");

  // 5) Página 'logueada' (sin password, con 'Cerrar sesión') = SUCCESS.
  await driver.page.setContent(`<h1>Mi Espacio</h1><a href="#">Cerrar sesión</a><p>Bienvenido</p>`);
  await driver.waitFor({ timeMs: 200 });
  const after = await driver.assessLoginOutcome("about:blank");
  console.log("assessLoginOutcome (logueado):", JSON.stringify(after));
  assert(after.status === "success", "sin password + 'Cerrar sesión' debe ser 'success'");

  console.log("\n✓ Captcha smoke OK (detección + refs + recorte + gating + verificación de login)");
} finally {
  await driver.close();
}
