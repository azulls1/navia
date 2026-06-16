/**
 * Generación del "snapshot" de accesibilidad — el árbol que lee la IA para decidir.
 *
 * Replica la idea del Playwright MCP: en vez de pasarle píxeles a la IA, le pasamos
 * un árbol compacto de los elementos relevantes (rol + nombre accesible) donde cada
 * elemento interactivo tiene un `ref` estable dentro del snapshot (ej. `e12`).
 *
 * La IA actúa por `ref`; el driver lo resuelve con el atributo `data-navia-ref`.
 * Los refs son EFÍMEROS: se reasignan en cada snapshot (el DOM cambia tras cada acción),
 * justo como aprendimos en los playbooks → re-snapshot antes de la siguiente acción.
 */

/** Esta función se serializa y corre DENTRO del navegador. No debe usar closures externos. */
function collectSnapshot(): string {
  const REF_ATTR = "data-navia-ref";
  let counter = 0;

  // Limpia refs anteriores (cada snapshot reasigna).
  document.querySelectorAll(`[${REF_ATTR}]`).forEach((el) => el.removeAttribute(REF_ATTR));

  const isVisible = (el: Element): boolean => {
    const style = window.getComputedStyle(el as HTMLElement);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  };

  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const ref = document.getElementById(labelledby);
      if (ref?.textContent) return ref.textContent.trim();
    }
    const placeholder = el.getAttribute("placeholder");
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      // Etiqueta asociada (<label for>) o placeholder/valor.
      const id = el.getAttribute("id");
      if (id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (lbl?.textContent?.trim()) return lbl.textContent.trim();
      }
      const parentLabel = el.closest("label");
      if (parentLabel?.textContent?.trim()) return parentLabel.textContent.trim();
      if (placeholder) return placeholder.trim();
      const name = el.getAttribute("name");
      if (name) return name.trim();
    }
    const title = el.getAttribute("title");
    if (title) return title.trim();
    if (placeholder) return placeholder.trim();
    const alt = el.getAttribute("alt");
    if (alt) return alt.trim();
    // Texto directo (acotado para no volcar bloques enteros).
    const text = (el as HTMLElement).innerText?.trim() ?? "";
    return text.length > 120 ? text.slice(0, 120) + "…" : text;
  };

  const roleOf = (el: Element): string | null => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "a":
        return (el as HTMLAnchorElement).href ? "link" : null;
      case "button":
        return "button";
      case "input": {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button") return "button";
        if (type === "hidden") return null;
        return "textbox";
      }
      case "textarea":
        return "textbox";
      case "select":
        return "combobox";
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "heading";
      case "img":
        return "img";
      case "summary":
        return "disclosure";
      default:
        if (el.hasAttribute("contenteditable")) return "textbox";
        if (el.hasAttribute("onclick") || el.getAttribute("tabindex") === "0") return "clickable";
        return null;
    }
  };

  const interactiveRoles = new Set([
    "link",
    "button",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "menuitem",
    "tab",
    "option",
    "switch",
    "clickable",
    "disclosure",
  ]);

  const lines: string[] = [];

  const walk = (el: Element, depth: number) => {
    if (!isVisible(el)) return;
    const role = roleOf(el);
    const name = role ? accessibleName(el) : "";

    if (role && (interactiveRoles.has(role) || role === "heading")) {
      counter++;
      const ref = `e${counter}`;
      el.setAttribute(REF_ATTR, ref);
      const indent = "  ".repeat(Math.min(depth, 8));
      const extras: string[] = [];
      if (el.getAttribute("aria-checked") === "true" || (el as HTMLInputElement).checked) extras.push("checked");
      if (el.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement).disabled) extras.push("disabled");
      const val = (el as HTMLInputElement).value;
      if ((role === "textbox" || role === "combobox") && val) extras.push(`value="${val.slice(0, 60)}"`);
      const extraStr = extras.length ? ` [${extras.join(", ")}]` : "";
      const nameStr = name ? ` "${name}"` : "";
      lines.push(`${indent}- ${role}${nameStr} [ref=${ref}]${extraStr}`);
    }

    for (const child of Array.from(el.children)) walk(child, depth + 1);
  };

  walk(document.body, 0);

  // Título y URL al inicio para contexto.
  const header = `Página: ${document.title}\nURL: ${location.href}\n`;
  return header + (lines.length ? lines.join("\n") : "(sin elementos interactivos visibles)");
}

import type { Page } from "playwright";

export async function takeSnapshot(page: Page): Promise<string> {
  return page.evaluate(collectSnapshot);
}

export const REF_ATTR = "data-navia-ref";
