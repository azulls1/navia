import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * El vault debe cifrar SIEMPRE de forma transparente: sin que el usuario defina
 * NAVIA_SECRET, Navia genera una llave en ~/.navia/key y cifra con ella.
 * Usamos un home temporal (USERPROFILE/HOME) para no tocar el ~/.navia real.
 */
describe("vault cifrado transparente", () => {
  const origUser = process.env.USERPROFILE;
  const origHome = process.env.HOME;
  const origSecret = process.env.NAVIA_SECRET;
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "navia-vault-"));
    process.env.USERPROFILE = tmp;
    process.env.HOME = tmp;
    delete process.env.NAVIA_SECRET;
  });
  afterAll(() => {
    if (origUser === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUser;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origSecret !== undefined) process.env.NAVIA_SECRET = origSecret;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it("guarda y recupera un secreto, cifrado en disco, sin frase del usuario", async () => {
    const { setSecret, getSecret, listKeys } = await import("../src/secrets/vault.js");
    await setSecret("atlas.pass", "SuperSecreta-123");

    expect(await getSecret("atlas.pass")).toBe("SuperSecreta-123");
    expect((await listKeys()).secrets).toContain("atlas.pass");

    // Se generó la llave auto-gestionada.
    expect(existsSync(path.join(tmp, ".navia", "key"))).toBe(true);

    // El archivo del vault está cifrado: el valor NO aparece en claro.
    const raw = readFileSync(path.join(tmp, ".navia", "vault.json"), "utf8");
    expect(raw).not.toContain("SuperSecreta-123");
    expect(JSON.parse(raw).enc).toBe(true);
  });
});
