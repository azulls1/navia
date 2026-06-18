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
  /**
   * Versión del snapshot vigente. Cada lectura la incrementa y los refs se emiten como
   * `v<N>:<ref>`. Antes de actuar validamos que la versión del ref coincida con la actual
   * → si el modelo reusa un ref de un snapshot viejo (DOM ya mutado), lo rechazamos con un
   * mensaje claro en vez de actuar sobre un nodo obsoleto/reemplazado (arXiv 2511.19477).
   */
  private snapshotVersion = 0;
  /** Rutas de archivos descargados durante la sesión. */
  private downloads: string[] = [];
  /** Sesiones CDP por iframe cross-origin (OOPIF), por ordinal del último snapshot. */
  private frameSessions = new Map<number, CDPSession>();
  /** Origen (https://host) de cada OOPIF por ordinal, para binding anti-phishing del vault. */
  private frameOrigins = new Map<number, string>();
  /** ref → {role, name} del último snapshot, para grabar macros (action-caching). */
  private refDescriptors = new Map<string, { role: string; name: string }>();
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
    // Allow-list de red (anti-exfiltración): aborta peticiones a dominios no permitidos.
    if (opts.allowDomains?.length) {
      const allow = opts.allowDomains.map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
      await ctx.route("**/*", (route) => {
        try {
          const host = new URL(route.request().url()).hostname.toLowerCase();
          const ok = !host || allow.some((d) => host === d || host.endsWith("." + d));
          return ok ? route.continue() : route.abort();
        } catch {
          return route.continue();
        }
      });
    }
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
    for (const s of this.frameSessions.values()) s.detach().catch(() => {});
    this.frameSessions.clear();
    this.frameOrigins.clear();
  }

  /**
   * Origen REAL (https://host) del frame donde vive un ref — NO la barra de direcciones.
   * Para refs de OOPIF (`fN_`) devuelve el origen de ESE iframe (clave anti-phishing: no
   * teclear una contraseña en un iframe cross-origin que no sea el esperado). Para refs del
   * frame principal/same-process, el origen top-level. "" si no se puede determinar.
   */
  originForRef(refRaw: string): string {
    try {
      const ref = refRaw.replace(/^v\d+:/, "");
      const m = ref.match(/^f(\d+)_(\d+)$/);
      if (m) {
        const o = this.frameOrigins.get(Number(m[1]));
        if (o) return o;
      }
      return new URL(this.page.url()).origin;
    } catch {
      return "";
    }
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

  /**
   * Valida y quita el prefijo de versión `v<N>:` de un ref. Si la versión no es la del
   * snapshot vigente, el ref es de una lectura anterior (el DOM pudo cambiar) → error claro
   * para forzar un snapshot nuevo. Los refs sin prefijo (legacy/Firefox) se aceptan tal cual.
   */
  private stripVersion(ref: string): string {
    const v = ref.match(/^v(\d+):(.*)$/s);
    if (!v) return ref;
    if (Number(v[1]) !== this.snapshotVersion)
      throw new Error(
        `el ref "${ref}" es de un snapshot anterior (v${v[1]}, actual v${this.snapshotVersion}); haz snapshot y usa los refs nuevos`,
      );
    return v[2];
  }

  /**
   * Resuelve un ref a {sesión CDP, objectId}. Los refs compuestos `fN_<id>` apuntan a un
   * iframe cross-origin (OOPIF) y usan la sesión de ese frame; los simples, la principal.
   */
  private async resolveRef(refRaw: string): Promise<{ session: CDPSession; objectId: string }> {
    const ref = this.stripVersion(refRaw);
    const m = ref.match(/^f(\d+)_(\d+)$/);
    let session: CDPSession | undefined;
    let backendNodeId: number;
    if (m) {
      session = this.frameSessions.get(Number(m[1]));
      backendNodeId = Number(m[2]);
      if (!session) throw new Error(`ref de iframe "${ref}" caduco; haz snapshot`);
    } else {
      session = this.cdp!;
      backendNodeId = Number(ref);
      if (!Number.isFinite(backendNodeId)) throw new Error(`ref inválido "${ref}" (haz snapshot)`);
    }
    const res = (await session.send("DOM.resolveNode", { backendNodeId } as any)) as any;
    const objectId = res?.object?.objectId;
    if (!objectId) throw new Error(`no se pudo resolver el ref ${ref} (puede haber cambiado; haz snapshot)`);
    return { session, objectId };
  }

  private async callOn(session: CDPSession, objectId: string, fnDecl: string, args: unknown[] = []): Promise<void> {
    await session.send("Runtime.callFunctionOn", {
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
        // Versiona los refs de esta lectura: cada snapshot sube la versión y los refs nacen
        // como `v<N>:<id>` → actuar con un ref viejo se rechaza (ver stripVersion).
        const verPrefix = `v${++this.snapshotVersion}:`;
        const parsed = parseAxTree(nodes, verPrefix);
        this.refMode = "cdp";
        this.refDescriptors = new Map(parsed.descriptors);
        const title = await this.page.title().catch(() => "");
        const frameText = await this.snapshotChildFrames(verPrefix);
        return `Página: ${title}\nURL: ${this.page.url()}\n${parsed.text}${frameText}`;
      } catch {
        // si CDP falla puntualmente, caemos al método legacy
      }
    }
    this.refMode = "legacy";
    return takeSnapshot(this.page);
  }

  /**
   * El getFullAXTree de la página NO incluye el contenido de los iframes. Aquí lo añadimos:
   *  1) Frames same-process: getFullAXTree({frameId}) sobre la sesión principal → refs simples
   *     (el backendNodeId resuelve en el proceso principal).
   *  2) OOPIF (cross-site, otro proceso): sesión CDP propia del frame → refs compuestos
   *     `fN_<backendNodeId>` (donde viven Turnstile, logins y pagos cross-origin).
   */
  private async snapshotChildFrames(verPrefix = ""): Promise<string> {
    for (const s of this.frameSessions.values()) s.detach().catch(() => {});
    this.frameSessions.clear();
    this.frameOrigins.clear();
    let out = "";

    // (1) Frames same-process vía frameId sobre la sesión principal.
    const sameProcessFrameIds = new Set<string>();
    try {
      const { frameTree } = (await this.cdp!.send("Page.getFrameTree", {} as any)) as any;
      const children: Array<{ id: string; url: string }> = [];
      const collect = (node: any) => {
        for (const c of node.childFrames ?? []) {
          children.push({ id: c.frame.id, url: c.frame.url });
          collect(c);
        }
      };
      collect(frameTree);
      for (const f of children) {
        sameProcessFrameIds.add(f.id);
        try {
          const { nodes } = (await this.cdp!.send("Accessibility.getFullAXTree", { frameId: f.id } as any)) as unknown as { nodes: AXNode[] };
          const parsed = parseAxTree(nodes, verPrefix);
          for (const [k, v] of parsed.descriptors) this.refDescriptors.set(k, v);
          if (parsed.refs.size > 0) out += `\n[iframe: ${f.url || "(?)"}]\n${parsed.text}`;
        } catch {
          /* OOPIF u otro proceso → lo intenta (2) */
        }
      }
    } catch {
      /* sin frame tree */
    }

    // (2) OOPIF: sesión propia del frame, refs compuestos.
    const ctx = this.page.context();
    let ordinal = 0;
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      const url = frame.url();
      if (!url || url === "about:blank") continue;
      let fs: CDPSession;
      try {
        fs = await ctx.newCDPSession(frame); // same-process lanza → ya cubierto en (1)
      } catch {
        continue;
      }
      ordinal++;
      try {
        await fs.send("DOM.enable").catch(() => {});
        await fs.send("Accessibility.enable").catch(() => {});
        const { nodes } = (await fs.send("Accessibility.getFullAXTree", {} as any)) as unknown as { nodes: AXNode[] };
        this.frameSessions.set(ordinal, fs);
        try {
          this.frameOrigins.set(ordinal, new URL(url).origin);
        } catch {
          /* url no parseable → sin binding para este frame */
        }
        const parsed = parseAxTree(nodes, `${verPrefix}f${ordinal}_`);
        for (const [k, v] of parsed.descriptors) this.refDescriptors.set(k, v);
        out += `\n[iframe ${ordinal} (cross-origin): ${url}]\n${parsed.text}`;
      } catch {
        out += `\n[iframe ${ordinal} (cross-origin): ${url}] (no se pudo leer)`;
      }
    }
    return out;
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
  async observe(): Promise<{ changed: boolean; url: string; snapshot: string }> {
    const text = await this.readSnapshot();
    const sig = this.signatureOf(text);
    const changed = this.lastSig !== null && sig !== this.lastSig;
    this.lastSig = sig;
    return { changed, url: this.page.url(), snapshot: text };
  }

  /** storageState (cookies + localStorage) del contexto actual, para guardar un perfil. */
  async getStorageState(): Promise<unknown> {
    return this.session.context.storageState();
  }

  /** Descriptor estable (rol + nombre accesible) de un ref del último snapshot, para macros. */
  describeRef(ref: string): { role: string; name: string } | null {
    return this.refDescriptors.get(ref) ?? null;
  }

  /** Todos los descriptores (ref → rol+nombre) del último snapshot, para self-healing del replay. */
  currentDescriptors(): Array<[string, { role: string; name: string }]> {
    return [...this.refDescriptors.entries()];
  }

  /** Resuelve un localizador estable {role, name} a un Locator de Playwright (para replay). */
  locateByRole(role: string, name?: string) {
    const r = role as Parameters<Page["getByRole"]>[0];
    return name ? this.page.getByRole(r, { name, exact: false }).first() : this.page.getByRole(r).first();
  }

  async click(ref: string): Promise<void> {
    if (this.refMode === "cdp" && this.cdp) {
      const { session, objectId } = await this.resolveRef(ref);
      await this.callOn(session, objectId, 'function(){ this.scrollIntoView({block:"center",inline:"center"}); this.click(); }');
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
      const { session, objectId } = await this.resolveRef(ref);
      // Enfoca y limpia vía JS; teclea con eventos reales (amigable con React).
      await this.callOn(session, objectId, 'function(){ this.scrollIntoView({block:"center"}); this.focus(); if ("value" in this) this.value=""; }');
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
        const { session, objectId } = await this.resolveRef(f.ref);
        switch (f.type) {
          case "checkbox":
          case "radio": {
            const want = f.value === "true" || f.value === "1";
            await this.callOn(session, objectId, "function(v){ if (this.checked !== v) this.click(); }", [want]);
            break;
          }
          case "combobox":
            await this.callOn(
              session,
              objectId,
              "function(v){ const o=[...this.options].find(o=>o.label===v||o.value===v||o.text===v); if(o)this.value=o.value; this.dispatchEvent(new Event('change',{bubbles:true})); }",
              [f.value],
            );
            break;
          default:
            await this.callOn(session, objectId, 'function(){ this.focus(); if("value" in this) this.value=""; }');
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
      const { session, objectId } = await this.resolveRef(ref);
      await this.callOn(
        session,
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

  /** Texto visible de la página (párrafos, etc., que el snapshot interactivo no incluye). */
  async readText(): Promise<string> {
    return (await this.page.evaluate(() => (document.body && document.body.innerText) || "").catch(() => "")) as string;
  }

  /** Desplaza la página, o hasta un elemento por ref (contenido lazy/infinito). */
  async scroll(opts: { ref?: string; direction?: "up" | "down"; amount?: number }): Promise<void> {
    if (opts.ref) {
      if (this.refMode === "cdp" && this.cdp) {
        const { session, objectId } = await this.resolveRef(opts.ref);
        await this.callOn(session, objectId, 'function(){ this.scrollIntoView({block:"center"}); }');
      } else {
        await this.legacyLocator(opts.ref).scrollIntoViewIfNeeded().catch(() => {});
      }
      return;
    }
    const dy = (opts.amount ?? 700) * (opts.direction === "up" ? -1 : 1);
    await this.page.evaluate((y) => window.scrollBy(0, y), dy);
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
  async uploadFile(refRaw: string, paths: string[]): Promise<void> {
    if (this.refMode === "cdp" && this.cdp) {
      const ref = this.stripVersion(refRaw);
      const m = ref.match(/^f(\d+)_(\d+)$/);
      const session = m ? this.frameSessions.get(Number(m[1])) : this.cdp;
      if (!session) throw new Error(`ref de iframe "${ref}" caduco; haz snapshot`);
      await session.send("DOM.setFileInputFiles", { files: paths, backendNodeId: Number(m ? m[2] : ref) } as any);
      return;
    }
    await this.legacyLocator(refRaw).setInputFiles(paths);
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
