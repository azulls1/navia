/**
 * Lanzamiento / conexión del navegador.
 *
 * Tres modos (todo lo aprendido en los playbooks):
 *  - "firefox"  → Firefox lanzado por Playwright. Funciona para la mayoría de portales.
 *  - "chromium" → Chromium lanzado por Playwright. Default.
 *  - "chrome"   → 🔑 Chrome REAL del usuario vía CDP (truco anti-Cloudflare).
 *
 * El truco CDP: Cloudflare ("Just a moment…") bloquea al navegador que LANZA Playwright
 * por fingerprint (navigator.webdriver=true, banderas de automatización). Si en cambio
 * nos CONECTAMOS por CDP a un Chrome real que ya está abierto (lanzado por el usuario, no
 * por Playwright), `navigator.webdriver=false` y el muro pasa. No es evasión: es el
 * navegador real del usuario.
 */
import { chromium, firefox, type Browser, type BrowserContext } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

/**
 * Descarga el navegador de Playwright (`chromium`/`firefox`) la 1ª vez. Un usuario que solo hizo
 * `npm i -g navia-ai` no tiene los binarios → Playwright falla con "Executable doesn't exist".
 * En vez de pedirle que corra `npx playwright install`, lo hacemos por él (una vez).
 */
function installPlaywrightBrowser(kind: "chromium" | "firefox"): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = createRequire(import.meta.url);
    let cli: string | null = null;
    for (const pkg of ["playwright-core", "playwright"]) {
      try {
        const candidate = path.join(path.dirname(req.resolve(`${pkg}/package.json`)), "cli.js");
        if (existsSync(candidate)) {
          cli = candidate;
          break;
        }
      } catch {
        /* prueba el siguiente */
      }
    }
    const child = cli
      ? spawn(process.execPath, [cli, "install", kind], { stdio: "inherit" })
      : spawn("npx", ["playwright", "install", kind], { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`No se pudo descargar el navegador (código ${code}).`))));
  });
}

/** Lanza el navegador; si falta el binario, lo descarga (una vez) y reintenta. */
async function launchOrInstall(kind: "chromium" | "firefox", launch: () => Promise<Browser>): Promise<Browser> {
  try {
    return await launch();
  } catch (e) {
    const msg = String((e as Error).message || "");
    if (/Executable doesn't exist|playwright install|please run the following/i.test(msg)) {
      console.error(`[navia] Descargando el navegador (${kind}) por primera vez… esto puede tardar un par de minutos.`);
      await installPlaywrightBrowser(kind);
      return await launch(); // reintenta tras instalar
    }
    throw e;
  }
}

export type BrowserEngine = "chromium" | "firefox" | "chrome" | "patchright";

/**
 * Flags anti-automatización para TODO motor basado en Chromium (chromium lanzado por
 * Playwright y el Chrome real que spawneamos para CDP). Son los mismos que aplica patchright:
 * quitan banderas delatoras baratas de detectar (no eliminan el leak de Runtime.enable —eso
 * lo dan el snapshot CDP nativo y patchright—, pero suben el listón con coste cero).
 */
const CHROMIUM_STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-popup-blocking",
  "--disable-component-update",
  "--disable-default-apps",
];

export interface LaunchOptions {
  engine: BrowserEngine;
  headless?: boolean;
  slowMo?: number;
  /** Puerto de depuración para el modo `chrome` (CDP). Default 9222. */
  cdpPort?: number;
  /** Endpoint CDP ya existente (ej. http://localhost:9222). Si se da, se conecta sin lanzar. */
  cdpEndpoint?: string;
  /** Perfil dedicado para el Chrome real (no toca tu Chrome normal). */
  userDataDir?: string;
  /** storageState de Playwright (cookies+localStorage) para arrancar autenticado (chromium/firefox). */
  storageState?: unknown;
  /**
   * Allow-list de dominios (red): si se da, se ABORTAN las peticiones a dominios fuera de la
   * lista → red de seguridad anti-exfiltración (aunque el modelo sea engañado, la conexión al
   * dominio atacante no sale). Estricto: puede romper CDNs de terceros; úsalo en runs cerrados.
   */
  allowDomains?: string[];
}

export interface BrowserSession {
  browser?: Browser;
  context: BrowserContext;
  /** true si nos conectamos a un navegador externo (no cerrarlo al terminar). */
  attached: boolean;
  /** true si NOSOTROS creamos el contexto (entonces sí podemos cerrarlo sin afectar al usuario). */
  ownsContext: boolean;
}

/** Rutas típicas de Chrome por sistema operativo. */
function findChromePath(): string | null {
  const platform = process.platform;
  const candidates: string[] =
    platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          path.join(os.homedir(), "AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"),
        ]
      : platform === "darwin"
        ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
        : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser"];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function waitForCdp(endpoint: string, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  const versionUrl = `${endpoint.replace(/\/$/, "")}/json/version`;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(versionUrl);
      if (res.ok) return;
    } catch {
      // aún arrancando
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No se pudo conectar al CDP en ${endpoint} (¿Chrome no abrió?).`);
}

/**
 * Modo `chrome`: lanza un Chrome real con --remote-debugging-port y se conecta por CDP.
 * Si se pasa `cdpEndpoint`, solo se conecta (no lanza).
 */
async function connectChromeCdp(opts: LaunchOptions): Promise<BrowserSession> {
  const port = opts.cdpPort ?? 9222;
  let endpoint = opts.cdpEndpoint;

  if (!endpoint) {
    const chromePath = findChromePath();
    if (!chromePath) {
      throw new Error(
        "No encontré Chrome instalado. Instálalo o usa --browser chromium / firefox, " +
          "o lanza Chrome a mano y pasa --cdp-endpoint http://localhost:9222.",
      );
    }
    const dataDir = opts.userDataDir ?? path.join(os.homedir(), ".navia", "chrome-profile");
    spawn(
      chromePath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${dataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
        ...CHROMIUM_STEALTH_ARGS,
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
    endpoint = `http://localhost:${port}`;
    await waitForCdp(endpoint);
  }

  const browser = await chromium.connectOverCDP(endpoint);
  const existing = browser.contexts()[0];
  const context = existing ?? (await browser.newContext());
  // Solo somos dueños del contexto si lo creamos nosotros (no había ninguno).
  return { browser, context, attached: true, ownsContext: !existing };
}

/**
 * Motor `patchright`: Playwright parcheado que elimina el leak de Runtime.enable y otras
 * señales de automatización (la fuga anti-bot #1). Es opt-in (no es dependencia de Navia):
 * el usuario instala `npm i patchright && npx patchright install chromium`. Lanza un
 * contexto persistente con Chrome real (canal "chrome") para máximo sigilo.
 */
async function launchPatchright(opts: LaunchOptions): Promise<BrowserSession> {
  let pw: any;
  try {
    const spec = "patchright"; // especificador dinámico: opcional, no se resuelve en build
    pw = await import(spec);
  } catch {
    throw new Error(
      "El motor 'patchright' es opcional y no está instalado. Instálalo:\n" +
        "  npm i patchright && npx patchright install chromium\n" +
        "o usa --browser chromium | chrome | firefox.",
    );
  }
  const dataDir = opts.userDataDir ?? path.join(os.homedir(), ".navia", "patchright-profile");
  const headless = opts.headless ?? false;
  const base = {
    headless,
    viewport: { width: 1280, height: 800 }, // viewport fijo y estable (ver nota en launchBrowser)
    slowMo: opts.slowMo ?? 0,
  };
  let context;
  try {
    // Canal "chrome" (Chrome real instalado) = recomendado por patchright.
    context = await pw.chromium.launchPersistentContext(dataDir, { ...base, channel: "chrome" });
  } catch {
    // Sin Chrome instalado → usa el Chromium de patchright.
    context = await pw.chromium.launchPersistentContext(dataDir, base);
  }
  return { browser: context.browser() ?? undefined, context, attached: false, ownsContext: true };
}

export async function launchBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  if (opts.engine === "chrome") {
    return connectChromeCdp(opts);
  }
  if (opts.engine === "patchright") {
    return launchPatchright(opts);
  }

  // Endurecimiento básico anti-bot (señales JS clásicas). NO elimina el leak de
  // Runtime.enable (eso requiere snapshot CDP / Patchright; ver roadmap), pero quita
  // las banderas de automatización más baratas de detectar.
  const headless = opts.headless ?? false;
  // ESTABILIDAD: usamos Chromium BUNDLED (no el Chrome real del usuario vía channel:"chrome")
  // y un VIEWPORT FIJO (no viewport:null + --start-maximized). El experimento de v0.22.3 (Chrome
  // real maximizado) provocaba cierres inesperados del navegador ("Target page/context/browser
  // has been closed") y render a medias. Para conectar a TU Chrome real existe el motor `chrome`
  // (CDP). El viewport 1280×800 renderiza bien (form visible) y Playwright ajusta la ventana al
  // viewport (sin márgenes en blanco). Quien necesite Chrome real coherente: --browser chrome.
  let browser: Browser;
  if (opts.engine === "firefox") {
    browser = await launchOrInstall("firefox", () =>
      firefox.launch({
        headless,
        slowMo: opts.slowMo ?? 0,
        firefoxUserPrefs: { "dom.webdriver.enabled": false, useAutomationExtension: false },
      }),
    );
  } else {
    browser = await launchOrInstall("chromium", () =>
      chromium.launch({
        headless,
        slowMo: opts.slowMo ?? 0,
        args: CHROMIUM_STEALTH_ARGS,
        ignoreDefaultArgs: ["--enable-automation"],
      }),
    );
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }, // fijo y estable; la ventana se ajusta al viewport
    storageState: (opts.storageState as any) ?? undefined,
    acceptDownloads: true,
  });
  return { browser, context, attached: false, ownsContext: true };
}

export async function closeSession(session: BrowserSession): Promise<void> {
  if (session.attached) {
    // Conexión CDP a un Chrome del usuario: NUNCA cerramos el navegador (cerraría su
    // Chrome real y destruiría su sesión/perfil). Solo cerramos el contexto si lo
    // creamos nosotros; si reusamos el suyo, lo dejamos intacto y soltamos la conexión.
    if (session.ownsContext) await session.context.close().catch(() => {});
    return;
  }
  // No-attached: cierra el browser; si es contexto persistente (patchright), no hay
  // objeto browser → cerramos el contexto.
  if (session.browser) await session.browser.close().catch(() => {});
  else await session.context.close().catch(() => {});
}
