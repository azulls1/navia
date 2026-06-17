/**
 * Almacén de sesiones (perfiles): guarda el `storageState` de Playwright (cookies +
 * localStorage) para reusar una sesión ya autenticada y saltarse logins/captcha repetidos.
 *
 * Seguridad: si defines la variable de entorno NAVIA_SECRET, el perfil se cifra con
 * AES-256-GCM (clave derivada con scrypt). Sin NAVIA_SECRET se guarda en claro (con aviso);
 * en ambos casos vive en ~/.navia/profiles y está cubierto por .gitignore.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { resolveSecret } from "../secrets/key.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ALGO = "aes-256-gcm";

export interface EncryptedBlob {
  enc: true;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}
export interface PlainBlob {
  enc: false;
  data: unknown;
}

function deriveKey(secret: string, salt: Buffer): Buffer {
  return scryptSync(secret, salt, 32);
}

export function encryptJSON(obj: unknown, secret: string): EncryptedBlob {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, deriveKey(secret, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return {
    enc: true,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function decryptJSON(blob: EncryptedBlob, secret: string): unknown {
  const decipher = createDecipheriv(ALGO, deriveKey(secret, Buffer.from(blob.salt, "base64")), Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const out = Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]);
  return JSON.parse(out.toString("utf8"));
}

export function profilesDir(): string {
  return path.join(os.homedir(), ".navia", "profiles");
}

/** Guarda el storageState de un perfil. Devuelve la ruta y si quedó cifrado. */
export async function saveSession(name: string, state: unknown): Promise<{ file: string; encrypted: boolean }> {
  await mkdir(profilesDir(), { recursive: true });
  const file = path.join(profilesDir(), `${name}.json`);
  const payload: EncryptedBlob = encryptJSON(state, resolveSecret()); // cifrado siempre (transparente)
  await writeFile(file, JSON.stringify(payload), "utf8");
  return { file, encrypted: true };
}

/** Carga el storageState de un perfil, o null si no existe. */
export async function loadSession(name: string): Promise<unknown | null> {
  const file = path.join(profilesDir(), `${name}.json`);
  const raw = await readFile(file, "utf8").catch(() => null);
  if (!raw) return null;
  const payload = JSON.parse(raw) as EncryptedBlob | PlainBlob;
  if (payload.enc) {
    try {
      return decryptJSON(payload, resolveSecret());
    } catch {
      throw new Error(
        `No pude descifrar el perfil "${name}". Si lo creaste con un NAVIA_SECRET distinto, define el mismo; ` +
          "si borraste ~/.navia/key, vuelve a crear el perfil con 'navia login'.",
      );
    }
  }
  return payload.data;
}
