/**
 * Driver del navegador — la capa de "manos" de la IA.
 * Cada método mapea a una acción que la IA puede pedir (navigate, click, type, …),
 * inspirado en las tools del Playwright MCP que ya conocíamos.
 */
import type { Page } from "playwright";
import { takeSnapshot, REF_ATTR } from "./snapshot.js";
import { launchBrowser, closeSession, type BrowserSession, type LaunchOptions } from "./launch.js";

export interface FillField {
  ref: string;
  value: string;
  type?: "text" | "checkbox" | "radio" | "combobox";
}

export class BrowserDriver {
  private session!: BrowserSession;
  page!: Page;

  static async create(opts: LaunchOptions): Promise<BrowserDriver> {
    const driver = new BrowserDriver();
    driver.session = await launchBrowser(opts);
    const ctx = driver.session.context;
    driver.page = ctx.pages()[0] ?? (await ctx.newPage());
    return driver;
  }

  private locator(ref: string) {
    return this.page.locator(`[${REF_ATTR}="${ref}"]`).first();
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  }

  async snapshot(): Promise<string> {
    // Pequeña espera de red para estabilizar el DOM antes de leer.
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    return takeSnapshot(this.page);
  }

  async click(ref: string): Promise<void> {
    const loc = this.locator(ref);
    try {
      await loc.click({ timeout: 8000 });
    } catch {
      // Clic "terco" (fuera de viewport o interceptado): forzar vía JS (aprendizaje OCC).
      await loc.evaluate((el) => (el as HTMLElement).click());
    }
  }

  async type(ref: string, text: string, opts?: { submit?: boolean; slowly?: boolean }): Promise<void> {
    const loc = this.locator(ref);
    await loc.click({ timeout: 8000 }).catch(() => {});
    await loc.fill("").catch(() => {});
    if (opts?.slowly) {
      // Teclear despacio dispara autocompletados (aprendizaje formularios).
      await loc.pressSequentially(text, { delay: 60 });
    } else {
      await loc.fill(text);
    }
    if (opts?.submit) await loc.press("Enter");
  }

  async fillForm(fields: FillField[]): Promise<void> {
    for (const f of fields) {
      const loc = this.locator(f.ref);
      switch (f.type) {
        case "checkbox":
        case "radio":
          if (f.value === "true" || f.value === "1") await loc.check().catch(() => loc.click());
          else await loc.uncheck().catch(() => {});
          break;
        case "combobox":
          await loc.selectOption({ label: f.value }).catch(() => loc.selectOption(f.value));
          break;
        default:
          await loc.fill(f.value);
      }
    }
  }

  async selectOption(ref: string, values: string[]): Promise<void> {
    const loc = this.locator(ref);
    await loc.selectOption(values.length === 1 ? values[0] : values);
  }

  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  /** Ejecuta JS arbitrario en la página (extracción masiva / clics tercos). */
  async evaluate(code: string): Promise<unknown> {
    // El código recibido debe ser el cuerpo de una función que retorna un valor.
    return this.page.evaluate(`(() => { ${code} })()`);
  }

  async waitFor(opts: { text?: string; textGone?: string; timeMs?: number }): Promise<void> {
    if (opts.timeMs) await this.page.waitForTimeout(opts.timeMs);
    if (opts.text) await this.page.getByText(opts.text, { exact: false }).first().waitFor({ state: "visible", timeout: 30000 });
    if (opts.textGone) await this.page.getByText(opts.textGone, { exact: false }).first().waitFor({ state: "hidden", timeout: 30000 });
  }

  async screenshot(): Promise<string> {
    const buf = await this.page.screenshot({ type: "png", fullPage: false });
    return buf.toString("base64");
  }

  async currentUrl(): Promise<string> {
    return this.page.url();
  }

  /**
   * Detección barata (title/url/iframes) de muros anti-bot/captcha. Devuelve el nombre
   * del reto o null. Permite delegar al humano ANTES de gastar pasos del LLM peleando
   * contra el muro. (La detección completa por iframe llegará con el snapshot CDP, Fase 1.)
   */
  async detectChallenge(): Promise<string | null> {
    try {
      const url = this.page.url().toLowerCase();
      const title = (await this.page.title().catch(() => "")).toLowerCase();
      if (title.includes("just a moment") || title.includes("checking your browser") || title.includes("attention required"))
        return "Cloudflare";
      if (url.includes("challenges.cloudflare.com") || url.includes("/cdn-cgi/challenge")) return "Cloudflare";
      const frames = (
        (await this.page
          .evaluate(() => Array.from(document.querySelectorAll("iframe")).map((f) => (f as HTMLIFrameElement).src || "").join(" "))
          .catch(() => "")) as string
      ).toLowerCase();
      if (frames.includes("turnstile") || frames.includes("challenges.cloudflare.com")) return "Cloudflare Turnstile";
      if (frames.includes("hcaptcha.com")) return "hCaptcha";
      if (frames.includes("recaptcha")) return "reCAPTCHA";
      if (frames.includes("captcha-delivery.com")) return "DataDome";
      return null;
    } catch {
      return null;
    }
  }

  async navigateBack(): Promise<void> {
    await this.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  }

  async close(): Promise<void> {
    await closeSession(this.session);
  }
}
