/**
 * Driver del navegador — la capa de "manos" de la IA.
 *
 * Dos caminos de lectura/acción:
 *  - CDP (chromium / chrome): snapshot vía Accessibility.getFullAXTree (no muta el DOM,
 *    atraviesa shadow DOM, refs estables por backendDOMNodeId) y acciones resueltas por
 *    backendNodeId vía CDP.
 *  - Legacy (firefox, que no habla CDP): el snapshot por inyección de JS de snapshot.ts.
 */
import type { Page, CDPSession } from "playwright";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { takeSnapshot, REF_ATTR } from "./snapshot.js";
import { parseAxTree, type AXNode } from "./cdp-snapshot.js";
import { launchBrowser, closeSession, type BrowserSession, type LaunchOptions, type BrowserEngine } from "./launch.js";

export interface FillField {
  ref: string;
  value: string;
  type?: "text" | "checkbox" | "radio" | "combobox";
}

export class BrowserDriver {
  private session!: BrowserSession;
  private engine: BrowserEngine = "chromium";
  /** undefined = aún no se intentó; null = no disponible (firefox); CDPSession = activo. */
  private cdp?: CDPSession | null;
  private refMode: "cdp" | "legacy" = "legacy";
  /** Firma del último estado observado (url + hash del snapshot), para change-observation. */
  private lastSig: string | null = null;
  /** Rutas de archivos descargados durante la sesión. */
  private downloads: string[] = [];
  page!: Page;

  static async create(opts: LaunchOptions): Promise<BrowserDriver> {
    const driver = new BrowserDriver();
    driver.session = await launchBrowser(opts);
    driver.engine = opts.engine;
    const ctx = driver.session.context;
    driver.page = ctx.pages()[0] ?? (await ctx.newPage());
    // Captura descargas de cualquier pestaña (actual o nueva).
    ctx.on("page", (p) => driver.attachPage(p));
    driver.attachPage(driver.page);
    return driver;
  }

  /** Engancha el guardado automático de descargas en una pestaña. */
  private attachPage(page: Page): void {
    page.on("download", async (d) => {
      try {
        const dir = path.join(os.homedir(), ".navia", "downloads");
        await mkdir(dir, { recursive: true });
        const fp = path.join(dir, d.suggestedFilename());
        await d.saveAs(fp);
        this.downloads.push(fp);
      } catch {
        /* noop */
      }
    });
  }

  /** Cambia el contexto CDP/refs al cambiar de pestaña. */
  private resetForNewPage(): void {
    this.cdp = undefined;
    this.refMode = "legacy";
    this.lastSig = null;
  }

  /** Crea (una vez) la sesión CDP si el motor la soporta. Firefox → null. */
  private async ensureCdp(): Promise<CDPSession | null> {
    if (this.cdp !== undefined) return this.cdp;
    if (this.engine === "firefox") {
      this.cdp = null;
      return null;
    }
    try {
      const client = await this.page.context().newCDPSession(this.page);
      await client.send("DOM.enable").catch(() => {});
      await client.send("Accessibility.enable").catch(() => {});
      this.cdp = client;
    } catch {
      this.cdp = null; // p.ej. un build sin CDP → fallback legacy
    }
    return this.cdp;
  }

  private legacyLocator(ref: string) {
    return this.page.locator(`[${REF_ATTR}="${ref}"]`).first();
  }

  /** Resuelve un ref CDP (backendNodeId) a un objectId remoto para actuar sobre él. */
  private async resolveCdpRef(ref: string): Promise<string> {
    const backendNodeId = Number(ref);
    if (!Number.isFinite(backendNodeId)) throw new Error(`ref inválido "${ref}" (haz snapshot)`);
    const res = (await this.cdp!.send("DOM.resolveNode", { backendNodeId } as any)) as any;
    const objectId = res?.object?.objectId;
    if (!objectId) throw new Error(`no se pudo resolver el ref ${ref} (puede haber cambiado; haz snapshot)`);
    return objectId;
  }

  private async callOn(objectId: string, fnDecl: string, args: unknown[] = []): Promise<void> {
    await this.cdp!.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: fnDecl,
      arguments: args.map((value) => ({ value })),
      awaitPromise: true,
    } as any);
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  }

  /** Lee la página (CDP o legacy) y devuelve el texto del snapshot. */
  private async readSnapshot(): Promise<string> {
    await this.page.waitForLoadState("domcontentloaded").catch(() => {});
    const cdp = await this.ensureCdp();
    if (cdp) {
      try {
        const { nodes } = (await cdp.send("Accessibility.getFullAXTree", {} as any)) as unknown as { nodes: AXNode[] };
        const parsed = parseAxTree(nodes);
        this.refMode = "cdp";
        const title = await this.page.title().catch(() => "");
        return `Página: ${title}\nURL: ${this.page.url()}\n${parsed.text}`;
      } catch {
        // si CDP falla puntualmente, caemos al método legacy
      }
    }
    this.refMode = "legacy";
    return takeSnapshot(this.page);
  }

  async snapshot(): Promise<string> {
    const text = await this.readSnapshot();
    this.lastSig = this.signatureOf(text);
    return text;
  }

  private signatureOf(snapshotText: string): string {
    return createHash("sha1").update(this.page.url() + "\n" + snapshotText).digest("hex");
  }

  /**
   * Change-observation: ¿la página cambió respecto al último snapshot/observación?
   * Reemplaza la "verificación" ficticia: si una acción no cambia nada observable,
   * la IA lo sabe y puede intentar otra cosa en vez de seguir a ciegas.
   */
  async observe(): Promise<{ changed: boolean; url: string }> {
    const text = await this.readSnapshot();
    const sig = this.signatureOf(text);
    const changed = this.lastSig !== null && sig !== this.lastSig;
    this.lastSig = sig;
    return { changed, url: this.page.url() };
  }

  /** storageState (cookies + localStorage) del contexto actual, para guardar un perfil. */
  async getStorageState(): Promise<unknown> {
    return this.session.context.storageState();
  }

  async click(ref: string): Promise<void> {
    if (this.refMode === "cdp" && this.cdp) {
      const objectId = await this.resolveCdpRef(ref);
      await this.callOn(objectId, 'function(){ this.scrollIntoView({block:"center",inline:"center"}); this.click(); }');
      return;
    }
    const loc = this.legacyLocator(ref);
    try {
      await loc.click({ timeout: 8000 });
    } catch {
      await loc.evaluate((el) => (el as HTMLElement).click());
    }
  }

  async type(ref: string, text: string, opts?: { submit?: boolean; slowly?: boolean }): Promise<void> {
    if (this.refMode === "cdp" && this.cdp) {
      const objectId = await this.resolveCdpRef(ref);
      // Enfoca y limpia vía JS; teclea con eventos reales (amigable con React).
      await this.callOn(objectId, 'function(){ this.scrollIntoView({block:"center"}); this.focus(); if ("value" in this) this.value=""; }');
      await this.page.keyboard.type(text, { delay: opts?.slowly ? 60 : 0 });
      if (opts?.submit) await this.page.keyboard.press("Enter");
      return;
    }
    const loc = this.legacyLocator(ref);
    await loc.click({ timeout: 8000 }).catch(() => {});
    await loc.fill("").catch(() => {});
    if (opts?.slowly) await loc.pressSequentially(text, { delay: 60 });
    else await loc.fill(text);
    if (opts?.submit) await loc.press("Enter");
  }

  async fillForm(fields: FillField[]): Promise<void> {
    for (const f of fields) {
      if (this.refMode === "cdp" && this.cdp) {
        const objectId = await this.resolveCdpRef(f.ref);
        switch (f.type) {
          case "checkbox":
          case "radio": {
            const want = f.value === "true" || f.value === "1";
            await this.callOn(objectId, "function(v){ if (this.checked !== v) this.click(); }", [want]);
            break;
          }
          case "combobox":
            await this.callOn(
              objectId,
              "function(v){ const o=[...this.options].find(o=>o.label===v||o.value===v||o.text===v); if(o)this.value=o.value; this.dispatchEvent(new Event('change',{bubbles:true})); }",
              [f.value],
            );
            break;
          default:
            await this.callOn(objectId, 'function(){ this.focus(); if("value" in this) this.value=""; }');
            await this.page.keyboard.type(f.value, { delay: 0 });
        }
        continue;
      }
      const loc = this.legacyLocator(f.ref);
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
    if (this.refMode === "cdp" && this.cdp) {
      const objectId = await this.resolveCdpRef(ref);
      await this.callOn(
        objectId,
        "function(vals){ for (const o of this.options) o.selected = vals.includes(o.value)||vals.includes(o.label)||vals.includes(o.text); this.dispatchEvent(new Event('change',{bubbles:true})); }",
        [values],
      );
      return;
    }
    const loc = this.legacyLocator(ref);
    await loc.selectOption(values.length === 1 ? values[0] : values);
  }

  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  /** Ejecuta JS arbitrario en la página (extracción masiva / clics tercos). */
  async evaluate(code: string): Promise<unknown> {
    return this.page.evaluate(`(() => { ${code} })()`);
  }

  async waitFor(opts: { text?: string; textGone?: string; timeMs?: number }): Promise<void> {
    if (opts.timeMs) await this.page.waitForTimeout(opts.timeMs);
    if (opts.text) await this.page.getByText(opts.text, { exact: false }).first().waitFor({ state: "visible", timeout: 30000 });
    if (opts.textGone)
      await this.page.getByText(opts.textGone, { exact: false }).first().waitFor({ state: "hidden", timeout: 30000 });
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
   * del reto o null, para delegar al humano antes de gastar pasos del LLM.
   */
  async detectChallenge(): Promise<string | null> {
    try {
      const url = this.page.url().toLowerCase();
      const title = (await this.page.title().catch(() => "")).toLowerCase();
      if (title.includes("just a moment") || title.includes("checking your browser") || title.includes("attention required"))
        return "Cloudflare";
      if (url.includes("challenges.cloudflare.com") || url.includes("/cdn-cgi/challenge")) return "Cloudflare";
      // page.frames() incluye iframes cross-origin (Turnstile vive en uno).
      const frameUrls = this.page
        .frames()
        .map((f) => f.url().toLowerCase())
        .join(" ");
      if (frameUrls.includes("turnstile") || frameUrls.includes("challenges.cloudflare.com")) return "Cloudflare Turnstile";
      if (frameUrls.includes("hcaptcha.com")) return "hCaptcha";
      if (frameUrls.includes("recaptcha")) return "reCAPTCHA";
      if (frameUrls.includes("captcha-delivery.com")) return "DataDome";
      return null;
    } catch {
      return null;
    }
  }

  async navigateBack(): Promise<void> {
    await this.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  }

  /** Sube archivos a un <input type="file"> por su ref. */
  async uploadFile(ref: string, paths: string[]): Promise<void> {
    if (this.refMode === "cdp" && this.cdp) {
      await this.cdp.send("DOM.setFileInputFiles", { files: paths, backendNodeId: Number(ref) } as any);
      return;
    }
    await this.legacyLocator(ref).setInputFiles(paths);
  }

  /** Archivos descargados hasta ahora (rutas absolutas en ~/.navia/downloads). */
  listDownloads(): string[] {
    return [...this.downloads];
  }

  async listTabs(): Promise<string> {
    const pages = this.session.context.pages();
    const lines = await Promise.all(
      pages.map(async (p, i) => `${p === this.page ? "*" : " "} [${i}] ${(await p.title().catch(() => "")) || "(sin título)"} — ${p.url()}`),
    );
    return "Pestañas (* = actual):\n" + lines.join("\n");
  }

  async selectTab(index: number): Promise<void> {
    const pages = this.session.context.pages();
    if (!pages[index]) throw new Error(`No existe la pestaña ${index}`);
    this.page = pages[index];
    await this.page.bringToFront().catch(() => {});
    this.resetForNewPage();
  }

  async newTab(url?: string): Promise<void> {
    // El listener de descargas se engancha solo vía ctx.on("page").
    this.page = await this.session.context.newPage();
    this.resetForNewPage();
    if (url) await this.navigate(url);
  }

  async closeTab(index: number): Promise<void> {
    const pages = this.session.context.pages();
    if (!pages[index]) throw new Error(`No existe la pestaña ${index}`);
    const closing = pages[index];
    await closing.close().catch(() => {});
    if (closing === this.page) {
      this.page = this.session.context.pages()[0];
      this.resetForNewPage();
    }
  }

  async close(): Promise<void> {
    await closeSession(this.session);
  }
}
