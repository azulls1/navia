import { describe, it, expect } from "vitest";
import { bestRefMatch, type Descriptor } from "../src/agent/heal.js";

const descs = (entries: Array<[string, Descriptor]>) => entries;

describe("bestRefMatch (self-healing de localizadores)", () => {
  it("prefiere coincidencia exacta de rol+nombre", () => {
    const m = bestRefMatch({ role: "button", name: "Entrar" }, descs([
      ["v9:1", { role: "button", name: "Salir" }],
      ["v9:2", { role: "button", name: "Entrar" }],
    ]));
    expect(m?.ref).toBe("v9:2");
    expect(m?.score).toBe(100);
  });

  it("sana por nombre contenido cuando el texto cambió levemente", () => {
    const m = bestRefMatch({ role: "button", name: "Guardar" }, descs([
      ["v9:1", { role: "link", name: "Guardar" }],
      ["v9:2", { role: "button", name: "Guardar cambios" }],
    ]));
    expect(m?.ref).toBe("v9:2"); // mismo rol + "Guardar" contenido
    expect(m?.score).toBe(70);
  });

  it("usa el rol único como último recurso aunque el nombre no calce", () => {
    const m = bestRefMatch({ role: "textbox", name: "Correo electrónico" }, descs([
      ["v9:1", { role: "button", name: "Enviar" }],
      ["v9:2", { role: "textbox", name: "Email" }],
    ]));
    expect(m?.ref).toBe("v9:2");
    expect(m?.score).toBe(40);
  });

  it("no sana si no hay candidato del mismo rol (evita falsos positivos)", () => {
    const m = bestRefMatch({ role: "combobox", name: "País" }, descs([
      ["v9:1", { role: "button", name: "País" }],
      ["v9:2", { role: "textbox", name: "País" }],
    ]));
    expect(m).toBeNull();
  });

  it("con varios del mismo rol y sin nombre objetivo, no inventa (score insuficiente)", () => {
    const m = bestRefMatch({ role: "link", name: "" }, descs([
      ["v9:1", { role: "link", name: "Uno" }],
      ["v9:2", { role: "link", name: "Dos" }],
    ]));
    expect(m).toBeNull(); // 30 < umbral 40
  });
});
