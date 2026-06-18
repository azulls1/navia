/**
 * Self-healing de localizadores para el replay determinista (#6 del roadmap).
 *
 * Cuando un paso grabado ya no resuelve por su localizador estable (rol + nombre accesible),
 * el sitio cambió levemente (texto retocado, nodo reordenado). En vez de fallar, buscamos el
 * MEJOR candidato del snapshot actual con un emparejado difuso por rol + nombre y reintentamos
 * por ese ref. Es determinista (no necesita LLM ni API key) → cubre la mayoría de la deriva de
 * selectores; el fallback por IA es una capa posterior opcional.
 *
 * Función pura (sin navegador) para poder testearla.
 */
export interface Descriptor {
  role: string;
  name: string;
}

const norm = (s: string): string => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export interface RefMatch {
  ref: string;
  score: number;
  matched: Descriptor;
}

/**
 * Elige el mejor ref del snapshot actual para un localizador grabado. Puntúa por rol igual +
 * similitud de nombre (exacto > contiene > contenido-en > rol único). Devuelve null si nada
 * supera el umbral mínimo (evita "sanar" hacia un elemento equivocado).
 */
export function bestRefMatch(target: Descriptor, descriptors: Array<[string, Descriptor]>): RefMatch | null {
  const tName = norm(target.name);
  const sameRole = descriptors.filter(([, d]) => d.role === target.role);
  let best: RefMatch | null = null;
  for (const [ref, d] of sameRole) {
    const n = norm(d.name);
    let score = 0;
    if (tName && n === tName) score = 100;
    else if (tName && n.includes(tName)) score = 70;
    else if (tName && n.length > 0 && tName.includes(n)) score = 60;
    else if (!tName) score = 30; // sin nombre objetivo: cualquier mismo-rol es débil
    if (score > (best?.score ?? 0)) best = { ref, score, matched: { role: d.role, name: d.name } };
  }
  // Último recurso: si solo hay UN elemento de ese rol, es casi seguro el mismo.
  if (!best && sameRole.length === 1) {
    const [ref, d] = sameRole[0];
    best = { ref, score: 40, matched: { role: d.role, name: d.name } };
  }
  return best && best.score >= 40 ? best : null;
}
