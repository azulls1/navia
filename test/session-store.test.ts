import { describe, it, expect } from "vitest";
import { encryptJSON, decryptJSON } from "../src/browser/session-store.js";

describe("session-store cifrado", () => {
  const sample = { cookies: [{ name: "sid", value: "abc123" }], origins: [] };

  it("cifra y descifra (round-trip) con el mismo secreto", () => {
    const blob = encryptJSON(sample, "mi-secreto");
    expect(blob.enc).toBe(true);
    expect(blob.data).not.toContain("abc123"); // el valor no aparece en claro
    expect(decryptJSON(blob, "mi-secreto")).toEqual(sample);
  });

  it("falla al descifrar con un secreto incorrecto", () => {
    const blob = encryptJSON(sample, "correcto");
    expect(() => decryptJSON(blob, "incorrecto")).toThrow();
  });

  it("usa salt/iv aleatorios (dos cifrados distintos del mismo dato difieren)", () => {
    const a = encryptJSON(sample, "s");
    const b = encryptJSON(sample, "s");
    expect(a.data).not.toEqual(b.data);
  });
});
