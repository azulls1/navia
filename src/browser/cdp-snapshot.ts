/**
 * Parser puro del árbol de accesibilidad de CDP (Accessibility.getFullAXTree).
 *
 * Por qué CDP en vez de inyectar JS (como hacía snapshot.ts):
 *  - NO muta el DOM (el viejo escribía data-navia-ref → detectable por MutationObserver).
 *  - El AX-tree atraviesa shadow DOM (open) e iframes same-origin "gratis".
 *  - Da identidad ESTABLE por `backendDOMNodeId`: el mismo nodo conserva el mismo ref
 *    entre snapshots (a diferencia de los e1/e2… posicionales y efímeros de antes), lo
 *    que habilita reusar refs y, más adelante, action-caching.
 *
 * Esta función es pura (AX nodes → texto) para poder testearla sin navegador.
 */

export interface AXValue {
  value?: unknown;
}
export interface AXProperty {
  name: string;
  value: AXValue;
}
export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  properties?: AXProperty[];
  backendDOMNodeId?: number;
  childIds?: string[];
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
]);

const SKIP_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "InlineTextBox",
  "LineBreak",
  "StaticText",
  "RootWebArea",
  "WebArea",
  "document",
]);

function truncate(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export interface ParsedSnapshot {
  text: string;
  /** refs válidos en este snapshot (cada ref ES un backendDOMNodeId en texto). */
  refs: Set<string>;
}

export function parseAxTree(nodes: AXNode[], refPrefix = ""): ParsedSnapshot {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);

  const childSet = new Set<string>();
  for (const n of nodes) for (const c of n.childIds ?? []) childSet.add(c);
  const roots = nodes.filter((n) => !childSet.has(n.nodeId));

  const prop = (n: AXNode, name: string): unknown => n.properties?.find((p) => p.name === name)?.value?.value;

  const lines: string[] = [];
  const refs = new Set<string>();

  const walk = (id: string, depth: number): void => {
    const n = byId.get(id);
    if (!n) return;
    const role = (n.role?.value as string | undefined) ?? "";
    let nextDepth = depth;

    if (!n.ignored && role && !SKIP_ROLES.has(role)) {
      const name = (n.name?.value ?? "").toString().trim();
      const focusable = prop(n, "focusable") === true;
      const interactive = (INTERACTIVE_ROLES.has(role) || focusable) && n.backendDOMNodeId != null;

      if (interactive) {
        const ref = `${refPrefix}${n.backendDOMNodeId}`;
        refs.add(ref);
        const flags: string[] = [];
        if (prop(n, "checked") === true || prop(n, "checked") === "true") flags.push("checked");
        if (prop(n, "disabled") === true) flags.push("disabled");
        const value = prop(n, "value");
        if (value != null && value !== "") flags.push(`value="${truncate(String(value), 60)}"`);
        const extra = flags.length ? ` [${flags.join(", ")}]` : "";
        const nameStr = name ? ` "${truncate(name)}"` : "";
        lines.push(`${"  ".repeat(Math.min(depth, 8))}- ${role}${nameStr} [ref=${ref}]${extra}`);
        nextDepth = depth + 1;
      } else if (role === "heading" && name) {
        lines.push(`${"  ".repeat(Math.min(depth, 8))}- heading "${truncate(name)}"`);
        nextDepth = depth + 1;
      }
    }

    for (const c of n.childIds ?? []) walk(c, nextDepth);
  };

  for (const r of roots) walk(r.nodeId, 0);

  return { text: lines.length ? lines.join("\n") : "(sin elementos interactivos visibles)", refs };
}
