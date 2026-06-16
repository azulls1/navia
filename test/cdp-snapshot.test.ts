import { describe, it, expect } from "vitest";
import { parseAxTree, type AXNode } from "../src/browser/cdp-snapshot.js";

/** AX-tree de ejemplo, con la forma que devuelve Accessibility.getFullAXTree. */
const sampleTree: AXNode[] = [
  { nodeId: "1", role: { value: "WebArea" }, name: { value: "Login" }, childIds: ["2", "3", "4", "5"] },
  { nodeId: "2", role: { value: "heading" }, name: { value: "Inicia sesión" }, backendDOMNodeId: 10, childIds: [] },
  { nodeId: "3", role: { value: "textbox" }, name: { value: "Correo" }, backendDOMNodeId: 11, childIds: [] },
  {
    nodeId: "4",
    role: { value: "textbox" },
    name: { value: "Contraseña" },
    backendDOMNodeId: 12,
    properties: [{ name: "value", value: { value: "secreto" } }],
    childIds: [],
  },
  { nodeId: "5", role: { value: "button" }, name: { value: "Entrar" }, backendDOMNodeId: 13, childIds: [] },
];

describe("parseAxTree", () => {
  it("usa backendDOMNodeId como ref estable de los interactivos", () => {
    const { text, refs } = parseAxTree(sampleTree);
    expect(text).toContain('textbox "Correo" [ref=11]');
    expect(text).toContain('button "Entrar" [ref=13]');
    expect(refs.has("11")).toBe(true);
    expect(refs.has("13")).toBe(true);
  });

  it("incluye headings pero NO les asigna ref", () => {
    const { text, refs } = parseAxTree(sampleTree);
    expect(text).toContain('heading "Inicia sesión"');
    expect(refs.has("10")).toBe(false);
  });

  it("expone el value actual de un campo", () => {
    const { text } = parseAxTree(sampleTree);
    expect(text).toMatch(/textbox "Contraseña" \[ref=12\] \[value="secreto"\]/);
  });

  it("omite roles de ruido (generic/none/StaticText)", () => {
    const noisy: AXNode[] = [
      { nodeId: "1", role: { value: "WebArea" }, childIds: ["2", "3"] },
      { nodeId: "2", role: { value: "generic" }, backendDOMNodeId: 20, childIds: [] },
      { nodeId: "3", role: { value: "StaticText" }, name: { value: "hola" }, backendDOMNodeId: 21, childIds: [] },
    ];
    const { refs } = parseAxTree(noisy);
    expect(refs.size).toBe(0);
  });

  it("marca interactivos por la propiedad focusable aunque el rol no sea estándar", () => {
    const tree: AXNode[] = [
      { nodeId: "1", role: { value: "WebArea" }, childIds: ["2"] },
      {
        nodeId: "2",
        role: { value: "img" },
        name: { value: "Abrir menú" },
        backendDOMNodeId: 30,
        properties: [{ name: "focusable", value: { value: true } }],
        childIds: [],
      },
    ];
    const { refs } = parseAxTree(tree);
    expect(refs.has("30")).toBe(true);
  });
});
