/**
 * TOTP (RFC 6238) puro, sin dependencias — genera el código de 6 dígitos de una app
 * autenticadora a partir del secreto base32. Permite a Navia rellenar el 2FA usando
 * `fill_totp` sin que el secreto pase nunca por el LLM.
 */
import { createHmac } from "node:crypto";

function base32Decode(b32: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = b32.replace(/=+$/g, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totp(secretBase32: string, opts?: { time?: number; step?: number; digits?: number }): string {
  const step = opts?.step ?? 30;
  const digits = opts?.digits ?? 6;
  const counter = Math.floor((opts?.time ?? Date.now()) / 1000 / step);
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}
