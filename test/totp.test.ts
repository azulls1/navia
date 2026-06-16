import { describe, it, expect } from "vitest";
import { totp } from "../src/secrets/totp.js";

// Vector oficial RFC 6238 (SHA1): secret ASCII "12345678901234567890" en base32,
// en T=59s con paso 30s y 8 dígitos → 94287082. Con 6 dígitos → 287082.
const SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp", () => {
  it("coincide con el vector RFC 6238 (8 dígitos, T=59s)", () => {
    expect(totp(SECRET_B32, { time: 59_000, digits: 8 })).toBe("94287082");
  });

  it("genera 6 dígitos por defecto", () => {
    expect(totp(SECRET_B32, { time: 59_000 })).toBe("287082");
  });

  it("cambia con la ventana de tiempo", () => {
    const a = totp(SECRET_B32, { time: 0 });
    const b = totp(SECRET_B32, { time: 60_000 });
    expect(a).not.toBe(b);
  });
});
