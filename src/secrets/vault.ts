/**
 * Vault de secretos cifrado: contraseñas y secretos TOTP que la IA puede USAR pero
 * nunca VER. La IA llama a fill_credential/fill_totp con una CLAVE; el valor real se
 * lee aquí (cifrado con NAVIA_SECRET) y se inyecta en la página sin pasar por el prompt.
 *
 * Reusa el cifrado de session-store (AES-256-GCM). Vive en ~/.navia/vault.json.
 */
import { encryptJSON, decryptJSON, type EncryptedBlob } from "../browser/session-store.js";
import { resolveSecret } from "./key.js";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

interface VaultData {
  secrets: Record<string, string>;
  totp: Record<string, string>;
  /** Binding anti-phishing: clave → orígenes FQDN permitidos (ej. ["https://accounts.example.com"]). */
  origins?: Record<string, string[]>;
}

/** Normaliza un origen dado como URL completa o FQDN a la forma `https://host`. "" si no es válido. */
export function normalizeOrigin(value: string): string {
  if (!value) return "";
  try {
    const u = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    return u.origin;
  } catch {
    return "";
  }
}

function vaultFile(): string {
  return path.join(os.homedir(), ".navia", "vault.json");
}

async function read(): Promise<VaultData> {
  const raw = await readFile(vaultFile(), "utf8").catch(() => null);
  if (!raw) return { secrets: {}, totp: {} };
  const payload = JSON.parse(raw) as EncryptedBlob | { enc: false; data: VaultData };
  if (payload.enc) {
    try {
      return decryptJSON(payload, resolveSecret()) as VaultData;
    } catch {
      throw new Error(
        "No pude descifrar el vault. Si lo creaste con un NAVIA_SECRET distinto, define el mismo; " +
          "si borraste ~/.navia/key, el vault anterior ya no es recuperable.",
      );
    }
  }
  return payload.data; // formato legado en claro → se re-cifra en el próximo write
}

async function write(data: VaultData): Promise<void> {
  await mkdir(path.dirname(vaultFile()), { recursive: true });
  const payload = encryptJSON(data, resolveSecret()); // cifrado siempre (transparente)
  await writeFile(vaultFile(), JSON.stringify(payload), "utf8");
}

export async function setSecret(key: string, value: string, origins?: string[]): Promise<void> {
  const d = await read();
  d.secrets[key] = value;
  if (origins && origins.length) {
    const norm = origins.map(normalizeOrigin).filter(Boolean);
    if (norm.length) {
      d.origins = d.origins ?? {};
      d.origins[key] = [...new Set(norm)];
    }
  }
  await write(d);
}

/** Orígenes FQDN permitidos para un secreto (binding anti-phishing), o undefined si no hay. */
export async function getSecretOrigins(key: string): Promise<string[] | undefined> {
  const o = (await read()).origins?.[key];
  return o && o.length ? o : undefined;
}

/** Restringe un secreto existente a los orígenes dados (los reemplaza). */
export async function setSecretOrigins(key: string, origins: string[]): Promise<void> {
  const d = await read();
  const norm = origins.map(normalizeOrigin).filter(Boolean);
  d.origins = d.origins ?? {};
  if (norm.length) d.origins[key] = [...new Set(norm)];
  else delete d.origins[key];
  await write(d);
}

export async function setTotp(key: string, base32: string): Promise<void> {
  const d = await read();
  d.totp[key] = base32;
  await write(d);
}

export async function getSecret(key: string): Promise<string | undefined> {
  return (await read()).secrets[key];
}

export async function getTotpSecret(key: string): Promise<string | undefined> {
  return (await read()).totp[key];
}

export async function listKeys(): Promise<{ secrets: string[]; totp: string[] }> {
  const d = await read();
  return { secrets: Object.keys(d.secrets), totp: Object.keys(d.totp) };
}

/** ¿El vault actual se puede leer/descifrar? (true si no existe, está en claro, o descifra bien). */
export async function isVaultReadable(): Promise<boolean> {
  try {
    await read();
    return true;
  } catch {
    return false;
  }
}

/**
 * Respalda el vault actual (lo RENOMBRA a un .bak, NO lo borra) para poder empezar limpio
 * sin perder el archivo previo. Devuelve la ruta del respaldo, o null si no había vault.
 */
export async function backupVault(): Promise<string | null> {
  const file = vaultFile();
  if (!existsSync(file)) return null;
  let bak = `${file}.bak`;
  for (let i = 1; existsSync(bak); i++) bak = `${file}.bak${i}`;
  await rename(file, bak);
  return bak;
}
