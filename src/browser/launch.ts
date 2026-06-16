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
import os from "node:os";
import path from "node:path";

export type BrowserEngine = "chromium" | "firefox" | "chrome";

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
}

export interface BrowserSession {
  browser?: Browser;
  context: BrowserContext;
  /** true si nos conectamos a un navegador externo (no cerrarlo al terminar). */
  attached: boolean;
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
      [`--remote-debugging-port=${port}`, `--user-data-dir=${dataDir}`, "--no-first-run", "--no-default-browser-check"],
      { detached: true, stdio: "ignore" },
    ).unref();
    endpoint = `http://localhost:${port}`;
    await waitForCdp(endpoint);
  }

  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  return { browser, context, attached: true };
}

export async function launchBrowser(opts: LaunchOptions): Promise<BrowserSession> {
  if (opts.engine === "chrome") {
    return connectChromeCdp(opts);
  }

  const launcher = opts.engine === "firefox" ? firefox : chromium;
  const browser = await launcher.launch({
    headless: opts.headless ?? false,
    slowMo: opts.slowMo ?? 0,
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
  });
  return { browser, context, attached: false };
}

export async function closeSession(session: BrowserSession): Promise<void> {
  // Si nos conectamos a un Chrome externo, NO lo cerramos (es del usuario).
  if (session.attached) {
    await session.browser?.close().catch(() => {});
    return;
  }
  await session.browser?.close().catch(() => {});
}
