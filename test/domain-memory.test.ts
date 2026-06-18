import { describe, it, expect } from "vitest";
import { domainOf, mergeTip, formatTips, type Tip } from "../src/agent/domain-memory.js";

describe("domain-memory (playbooks por dominio)", () => {
  it("normaliza el dominio (quita www, baja a minúsculas)", () => {
    expect(domainOf("https://www.Example.com/path?q=1")).toBe("example.com");
    expect(domainOf("http://sub.example.com")).toBe("sub.example.com");
    expect(domainOf("no-es-url")).toBe("");
    expect(domainOf(undefined)).toBe("");
  });

  it("mergeTip deduplica tips equivalentes (misma clave)", () => {
    const base: Tip[] = [{ note: "Espera el captcha" }];
    const same = mergeTip(base, { note: "espera el captcha" }); // case-insensitive
    expect(same).toBe(base); // sin cambios → misma referencia
    const added = mergeTip(base, { note: "Otra cosa" });
    expect(added).toHaveLength(2);
  });

  it("formatTips renderiza nota libre y tip estructurado", () => {
    const out = formatTips("example.com", [
      { note: "El botón 'Entrar' se habilita al reescribir el email" },
      { scope: "checkout", action: "confirmar dirección", constraint: "no enviar sin código postal" },
    ]);
    expect(out).toContain("example.com");
    expect(out).toContain("- El botón 'Entrar' se habilita");
    expect(out).toContain("[checkout] confirmar dirección — no enviar sin código postal");
  });

  it("formatTips vacío devuelve string vacío", () => {
    expect(formatTips("example.com", [])).toBe("");
  });
});
