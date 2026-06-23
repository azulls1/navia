/**
 * Detección de retos anti-bot, captcha de texto-en-imagen y veredicto de login.
 * Separado de driver.ts: la heurística de captcha es una función SERIALIZABLE que corre en el
 * navegador (como collectSnapshot), y la clasificación de challenge + el veredicto de login son
 * funciones PURAS (entrada → salida) → testeables sin navegador. El driver solo orquesta:
 * recoge los datos de la página y llama a estas.
 */

/** Resultado de la heurística de captcha de texto-en-imagen (corre en el navegador). */
export interface TextCaptchaHit {
  present: boolean;
  empty: boolean;
  hasImg: boolean;
}

/**
 * Heurística DOM (SERIALIZABLE: se pasa a page.evaluate, sin closures externos) para un CAPTCHA
 * de texto-en-imagen propio: un `<input>` de texto vacío junto a un `<img>` de captcha, con
 * label/atributos tipo "ingresa el texto de la imagen"/"txtCaptcha". Marca el input/img con
 * atributos `data-navia-cap-*` para que el driver resuelva sus refs por selector.
 */
export function findTextCaptcha(): TextCaptchaHit {
  const norm = (s: string | null | undefined) => (s || "").toLowerCase();
  const reAttr = /captcha|c[oó]?digo|codigo|imagen|image|verif|seguridad|security|caracteres|characters/i;
  const reLabel = /(enter|type|ingresa|escribe|introduce)[\s\S]{0,30}(text|texto|c[oó]digo|code|characters|caracteres)|(texto|c[oó]digo|code)[\s\S]{0,20}(imagen|image)|security code|c[oó]digo de seguridad/i;
  const isCapImg = (img: HTMLImageElement) => {
    const w = img.naturalWidth || img.width,
      h = img.naturalHeight || img.height;
    if (!w || !h) return false;
    const ratio = w / h,
      src = norm(img.src);
    return w >= 50 && w <= 420 && h >= 16 && h <= 160 && ratio > 1.4 && !/(logo|icon|sprite|avatar|banner|header)/.test(src);
  };
  const inputs = Array.from(document.querySelectorAll("input")).filter((i) => {
    const t = (i.getAttribute("type") || "text").toLowerCase();
    return ["text", "", "tel", "number"].includes(t);
  }) as HTMLInputElement[];
  let best: { inp: HTMLInputElement; img: HTMLImageElement | null; score: number } | null = null;
  for (const inp of inputs) {
    const attrs = norm([inp.name, inp.id, inp.className, inp.placeholder, inp.getAttribute("aria-label")].join(" "));
    let score = reAttr.test(attrs) ? 2 : 0;
    let labelText = "";
    if (inp.id) {
      const l = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
      if (l) labelText = norm(l.textContent);
    }
    const ctx = norm((inp.closest("div,td,fieldset,form,section") as HTMLElement | null)?.textContent);
    if (reLabel.test(labelText) || reLabel.test(ctx)) score += 2;
    const scope = (inp.closest("div,td,fieldset,form,section") as HTMLElement | null) || document.body;
    const img = (Array.from(scope.querySelectorAll("img")) as HTMLImageElement[]).find(isCapImg) || null;
    if (img) score += 1; // la imagen corrobora pero no basta sola (evita falsos positivos)
    // Requiere señal fuerte de captcha (atributo o label), no solo "input cerca de img".
    const strong = reAttr.test(attrs) || reLabel.test(labelText) || reLabel.test(ctx);
    if (strong && (!best || score > best.score)) best = { inp, img, score };
  }
  if (!best) return { present: false, empty: false, hasImg: false };
  best.inp.setAttribute("data-navia-cap-input", "1");
  if (best.img) best.img.setAttribute("data-navia-cap-img", "1");
  return { present: true, empty: (best.inp.value || "").trim() === "", hasImg: !!best.img };
}

/**
 * Clasifica un muro anti-bot a partir de señales baratas de la página (title/url/urls de iframes).
 * Pura → testeable. Devuelve el nombre del reto o null.
 */
export function classifyChallenge(input: { url: string; title: string; frameUrls: string }): string | null {
  const url = input.url.toLowerCase();
  const title = input.title.toLowerCase();
  if (title.includes("just a moment") || title.includes("checking your browser") || title.includes("attention required"))
    return "Cloudflare";
  if (url.includes("challenges.cloudflare.com") || url.includes("/cdn-cgi/challenge")) return "Cloudflare";
  const frameUrls = input.frameUrls.toLowerCase();
  if (frameUrls.includes("turnstile") || frameUrls.includes("challenges.cloudflare.com")) return "Cloudflare Turnstile";
  if (frameUrls.includes("hcaptcha.com")) return "hCaptcha";
  if (frameUrls.includes("recaptcha")) return "reCAPTCHA";
  if (frameUrls.includes("captcha-delivery.com")) return "DataDome";
  return null;
}

export interface LoginAssessment {
  status: "success" | "failed" | "unknown";
  detail: string;
}

/**
 * Veredicto DETERMINISTA de si un login tuvo éxito, a partir del estado recogido por el driver
 * (url actual, si sigue el campo password, el texto visible y la url del login). Pura → testeable.
 *  - failed: error/captcha incorrecto, o sigue el campo password.
 *  - success: ya NO hay password Y (enlace de sesión visible o se salió de la URL de login).
 *  - unknown: no se puede afirmar.
 */
export function assessLogin(input: { url: string; stillPassword: boolean; text: string; loginUrl?: string }): LoginAssessment {
  const text = input.text.toLowerCase();
  const errorRe =
    /captcha\s+(incorrect|inv[aá]lid|no coincide|err[oó]ne)|c[oó]digo\s+(incorrect|inv[aá]lid)|texto[\s\S]{0,20}(incorrect|no coincide)|usuario o contrase|credenciales\s+(inv|incorrect)|datos incorrectos|intente de nuevo|vuelva? a intentar|inicio de sesi[oó]n fallid|incorrect (password|username)|invalid (credentials|captcha)/i;
  const sessionRe = /cerrar sesi[oó]n|cerrar sesion|logout|log out|sign\s?out|mi cuenta|mi perfil|salir\b/i;
  const loginUrlRe = /login|signin|sign-in|acceso|autenticaci|iniciar.?sesi/i;
  if (errorRe.test(text)) return { status: "failed", detail: "la página muestra un error de login/captcha" };
  const movedAway = !!input.loginUrl && input.url !== input.loginUrl && !loginUrlRe.test(input.url.toLowerCase());
  if (!input.stillPassword && (sessionRe.test(text) || movedAway))
    return { status: "success", detail: sessionRe.test(text) ? "enlace de sesión visible y sin formulario de login" : "saliste de la URL de login y no hay formulario" };
  if (input.stillPassword) return { status: "failed", detail: "sigues en el formulario de login (el campo de contraseña sigue presente)" };
  return { status: "unknown", detail: "no se pudo confirmar el resultado del login" };
}
