/**
 * Vault de secretos cifrado: contraseñas y secretos TOTP que la IA puede USAR pero
 * nunca VER. La IA llama a fill_credential/fill_totp con una CLAVE; el valor real se
 * lee aquí (cifrado con NAVIA_SECRET) y se inyecta en la página sin pasar por el prompt.
 *
 * Reusa el cifrado de session-store (AES-256-GCM). Vive en ~/.navia/vault.json.
 */
import { encryptJSON, decryptJSON, type EncryptedBlob } from "../browser/session-store.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface VaultData {
  secrets: Record<string, string>;
  totp: Record<string, string>;
}

function vaultFile(): string {
  return path.join(os.homedir(), ".navia", "vault.json");
}

async function read(): Promise<VaultData> {
  const raw = await readFile(vaultFile(), "utf8").catch(() => null);
  if (!raw) return { secrets: {}, totp: {} };
  const payload = JSON.parse(raw) as EncryptedBlob | { enc: false; data: VaultData };
  if (payload.enc) {
    const secret = process.env.NAVIA_SECRET;
    if (!secret) throw new Error("El vault está cifrado; define NAVIA_SECRET para usarlo.");
    return decryptJSON(payload, secret) as VaultData;
  }
  return payload.data;
}

async function write(data: VaultData): Promise<void> {
  await mkdir(path.dirname(vaultFile()), { recursive: true });
  const secret = process.env.NAVIA_SECRET;
  const payload = secret ? encryptJSON(data, secret) : { enc: false as const, data };
  await writeFile(vaultFile(), JSON.stringify(payload), "utf8");
}

export async function setSecret(key: string, value: string): Promise<void> {
  const d = await read();
  d.secrets[key] = value;
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
