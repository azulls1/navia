/**
 * Replay determinista (action-caching): re-ejecuta una macro grabada con --record SIN
 * llamar al LLM. Las acciones sobre elementos no usan el ref efímero, sino el localizador
 * estable (rol + nombre accesible) capturado al grabar → robusto entre sesiones.
 *
 * Los secretos (fill_credential/fill_totp) NO se guardan en la macro: se reinyectan frescos
 * desde el vault en cada replay.
 */
import { readFile, writeFile } from "node:fs/promises";
import { BrowserDriver } from "../browser/driver.js";
import { resolveProfileState } from "./loop-common.js";
import { getSecret, getTotpSecret } from "../secrets/vault.js";
import { totp } from "../secrets/totp.js";
import { bestRefMatch, type Descriptor } from "./heal.js";
import type { NaviaOptions } from "./agent.js";

export interface ReplayResult {
  total: number;
  ran: number;
  failed: number;
  /** Pasos cuyo localizador se SANÓ (selector drift) y se re-cachearon. */
  healed: number;
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
  const { userDataDir, storageState } = await resolveProfileState(engine, opts.profile, opts.userDataDir);

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
  let healed = 0;
  try {
    for (const s of steps) {
      try {
        const r = await replayOne(driver, s, log);
        if (r.healed) {
          s.locator = r.healed; // re-cache: el paso queda con el localizador vigente
          healed++;
        }
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
  // Re-cacheo: si algo se sanó, persiste la macro vigente en un archivo hermano (sin tocar
  // el original) para que el próximo replay sea rápido y robusto.
  if (healed > 0) {
    const healedPath = file.replace(/\.jsonl$/i, "") + ".healed.jsonl";
    try {
      await writeFile(healedPath, steps.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf8");
      log?.(`🔧 ${healed} paso(s) sanado(s) → macro re-cacheada en ${healedPath}`);
    } catch {
      /* el re-cacheo nunca debe romper el replay */
    }
  }
  return { total: steps.length, ran, failed, healed };
}

async function replayOne(driver: BrowserDriver, s: any, log?: (m: string) => void): Promise<{ healed?: Descriptor }> {
  const a = s.input ?? {};
  log?.(`▶ ${s.tool} ${s.locator?.role ? `(${s.locator.role} "${s.locator.name}")` : JSON.stringify(a)}`);

  // Acciones sin localizador.
  switch (s.tool) {
    case "navigate":
      await driver.navigate(a.url);
      return {};
    case "press_key":
      await driver.pressKey(a.key);
      return {};
    case "wait_for":
      await driver.waitFor({ text: a.text, textGone: a.text_gone, timeMs: a.time_ms });
      return {};
    case "scroll":
      await driver.scroll({ direction: a.direction, amount: a.amount });
      return {};
    case "navigate_back":
      await driver.navigateBack();
      return {};
  }
  if (READ_ONLY.has(s.tool)) return {}; // lecturas: no aportan en replay

  // Acciones que requieren localizar el elemento (por rol+nombre estable).
  if (!s.locator?.role) throw new Error(`sin localizador estable para ${s.tool}`);

  // Camino rápido: localizador estable (rol+nombre) por Playwright.
  const runViaLoc = async (): Promise<void> => {
    const loc = driver.locateByRole(s.locator.role, s.locator.name);
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    switch (s.tool) {
      case "click":
        return loc.click({ timeout: 10000 });
      case "type":
        await loc.fill("");
        await loc.fill(a.text ?? "");
        if (a.submit) await loc.press("Enter");
        return;
      case "select_option":
        await loc.selectOption(a.values?.length === 1 ? a.values[0] : a.values);
        return;
      case "upload_file":
        return loc.setInputFiles(a.paths ?? []);
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
  };

  // Camino sanado: ejecuta por ref vigente del snapshot (tras emparejado difuso).
  const runViaRef = async (ref: string): Promise<void> => {
    switch (s.tool) {
      case "click":
        return driver.click(ref);
      case "type":
        return driver.type(ref, a.text ?? "", { submit: a.submit });
      case "select_option":
        return driver.selectOption(ref, (a.values ?? []) as string[]);
      case "upload_file":
        return driver.uploadFile(ref, (a.paths ?? []) as string[]);
      case "fill_credential": {
        const v = await getSecret(a.key);
        if (v == null) throw new Error(`secreto "${a.key}" no existe`);
        return driver.type(ref, v);
      }
      case "fill_totp": {
        const sec = await getTotpSecret(a.key);
        if (!sec) throw new Error(`TOTP "${a.key}" no existe`);
        return driver.type(ref, totp(sec));
      }
      default:
        throw new Error(`tool no soportado en replay: ${s.tool}`);
    }
  };

  try {
    await runViaLoc();
    return {};
  } catch (e) {
    // Self-healing: el localizador estable ya no resuelve (deriva de selector). Re-snapshot
    // y elige el mejor candidato del estado actual por rol+nombre; si lo hay, reintenta por ref.
    await driver.snapshot();
    const match = bestRefMatch(s.locator, driver.currentDescriptors());
    if (!match)
      throw new Error(`localizador no resoluble ni sanable (${s.locator.role} "${s.locator.name}"): ${(e as Error).message}`);
    log?.(`  🔧 sanado: "${s.locator.name}" → ${match.ref} (${match.matched.role} "${match.matched.name}", score ${match.score})`);
    await runViaRef(match.ref);
    return { healed: match.matched };
  }
}
