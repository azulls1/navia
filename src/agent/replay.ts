/**
 * Replay determinista (action-caching): re-ejecuta una macro grabada con --record SIN
 * llamar al LLM. Las acciones sobre elementos no usan el ref efímero, sino el localizador
 * estable (rol + nombre accesible) capturado al grabar → robusto entre sesiones.
 *
 * Los secretos (fill_credential/fill_totp) NO se guardan en la macro: se reinyectan frescos
 * desde el vault en cada replay.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserDriver } from "../browser/driver.js";
import { loadSession } from "../browser/session-store.js";
import { getSecret, getTotpSecret } from "../secrets/vault.js";
import { totp } from "../secrets/totp.js";
import type { NaviaOptions } from "./agent.js";

export interface ReplayResult {
  total: number;
  ran: number;
  failed: number;
}

const READ_ONLY = new Set(["snapshot", "read_text", "list_downloads", "screenshot"]);

export async function replayMacro(file: string, opts: NaviaOptions, log?: (m: string) => void): Promise<ReplayResult> {
  const raw = await readFile(file, "utf8");
  const steps = raw
    .trim()
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.type === "action" && e.ok !== false);

  const engine = opts.browser ?? "chromium";
  let storageState: unknown;
  let userDataDir = opts.userDataDir;
  if (opts.profile) {
    if (engine === "chrome") userDataDir = userDataDir ?? path.join(os.homedir(), ".navia", "profiles", `chrome-${opts.profile}`);
    else storageState = (await loadSession(opts.profile)) ?? undefined;
  }

  const driver = await BrowserDriver.create({
    engine,
    headless: opts.headless,
    cdpPort: opts.cdpPort,
    cdpEndpoint: opts.cdpEndpoint,
    userDataDir,
    storageState,
  });

  let ran = 0;
  let failed = 0;
  try {
    for (const s of steps) {
      try {
        await replayOne(driver, s, log);
        ran++;
      } catch (e) {
        failed++;
        log?.(`  ✗ ${s.tool}: ${(e as Error).message}`);
      }
      await driver.page.waitForTimeout(250);
    }
  } finally {
    await driver.close();
  }
  return { total: steps.length, ran, failed };
}

async function replayOne(driver: BrowserDriver, s: any, log?: (m: string) => void): Promise<void> {
  const a = s.input ?? {};
  log?.(`▶ ${s.tool} ${s.locator?.role ? `(${s.locator.role} "${s.locator.name}")` : JSON.stringify(a)}`);

  // Acciones sin localizador.
  switch (s.tool) {
    case "navigate":
      await driver.navigate(a.url);
      return;
    case "press_key":
      await driver.pressKey(a.key);
      return;
    case "wait_for":
      await driver.waitFor({ text: a.text, textGone: a.text_gone, timeMs: a.time_ms });
      return;
    case "scroll":
      await driver.scroll({ direction: a.direction, amount: a.amount });
      return;
    case "navigate_back":
      await driver.navigateBack();
      return;
  }
  if (READ_ONLY.has(s.tool)) return; // lecturas: no aportan en replay

  // Acciones que requieren localizar el elemento (por rol+nombre estable).
  if (!s.locator?.role) throw new Error(`sin localizador estable para ${s.tool}`);
  const loc = driver.locateByRole(s.locator.role, s.locator.name);
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  switch (s.tool) {
    case "click":
      await loc.click({ timeout: 10000 });
      return;
    case "type":
      await loc.fill("");
      await loc.fill(a.text ?? "");
      if (a.submit) await loc.press("Enter");
      return;
    case "select_option":
      await loc.selectOption(a.values?.length === 1 ? a.values[0] : a.values);
      return;
    case "upload_file":
      await loc.setInputFiles(a.paths ?? []);
      return;
    case "fill_credential": {
      const v = await getSecret(a.key);
      if (v == null) throw new Error(`secreto "${a.key}" no existe`);
      await loc.fill("");
      await loc.fill(v);
      return;
    }
    case "fill_totp": {
      const sec = await getTotpSecret(a.key);
      if (!sec) throw new Error(`TOTP "${a.key}" no existe`);
      await loc.fill(totp(sec));
      return;
    }
    default:
      throw new Error(`tool no soportado en replay: ${s.tool}`);
  }
}
