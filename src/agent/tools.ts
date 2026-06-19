/**
 * Definición de herramientas (esquema para la API de Anthropic) + el dispatcher
 * que ejecuta cada herramienta contra el BrowserDriver.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { BrowserDriver, FillField } from "../browser/driver.js";
import { getSecret, getTotpSecret, getSecretOrigins } from "../secrets/vault.js";
import { totp } from "../secrets/totp.js";
import { spotlight, injectionBanner } from "./safety.js";

/**
 * Binding anti-phishing/anti-exfiltración: si el secreto tiene orígenes permitidos, el origen
 * REAL del frame del ref DEBE coincidir, o no se rellena. Rechazo DURO (sin HITL): teclear una
 * credencial en un origen inesperado —p.ej. un iframe cross-origin hostil— es justo el vector
 * de exfiltración que cerramos. Si el secreto no tiene binding, no restringe (opt-in).
 */
async function assertOriginAllowed(driver: BrowserDriver, ref: string, key: string): Promise<void> {
  const allowed = await getSecretOrigins(key);
  if (!allowed || !allowed.length) return;
  const origin = driver.originForRef(ref);
  if (!allowed.includes(origin)) {
    throw new Error(
      `🔒 El secreto "${key}" está restringido a ${allowed.join(", ")}, pero el elemento está en ${origin || "(origen desconocido)"}. ` +
        `No se rellena (anti-phishing). Si es legítimo: navia secret set ${key} --origin ${origin || "<origen>"}`,
    );
  }
}

export interface AgentHooks {
  /** Pedir confirmación humana para una acción irreversible. Devuelve true si se aprueba. */
  confirmAction: (description: string) => Promise<boolean>;
  /** Pausar para que el humano resuelva algo en la ventana (login/captcha). Devuelve nota opcional. */
  waitForHuman: (reason: string) => Promise<string>;
  /** Log de progreso. */
  log?: (msg: string) => void;
  /** Modo conversación: se llama al terminar cada tarea con su resumen (para mostrarlo). */
  onTaskSummary?: (summary: string, steps: number) => void;
  /**
   * Modo conversación: tras terminar una tarea, pide la SIGUIENTE (reusando el mismo
   * navegador/sesión y contexto). Devuelve la próxima instrucción, o null para terminar.
   */
  nextTask?: () => Promise<string | null>;
  /** Memoria por dominio: guardar una nota/tip aprendido para el dominio actual (opt-in). */
  rememberNote?: (url: string, note: string) => Promise<void>;
}

/** Política de herramientas: gatea capacidades según el entorno (JS arbitrario, visión). */
export interface ToolPolicy {
  /** Permitir la tool `evaluate` (ejecución de JS). Default true; ponlo en false para sitios hostiles. */
  allowEval?: boolean;
  /** ¿El proveedor VE imágenes? El provider CLI es solo texto → sin visión, `screenshot` es inútil
   *  (no puede leer la imagen) y solo provoca bucles; se oculta y se delega lo visual a wait_for_human. */
  vision?: boolean;
}

/** Catálogo de tools filtrado según la política (lo que VE el modelo). */
export function toolDefinitions(policy?: ToolPolicy): Anthropic.Tool[] {
  return TOOL_DEFINITIONS.filter((t) => {
    if (policy?.allowEval === false && t.name === "evaluate") return false;
    if (policy?.vision === false && t.name === "screenshot") return false;
    return true;
  });
}

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "navigate",
    description: "Ir a una URL en el navegador.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "URL completa (https://...)" } },
      required: ["url"],
    },
  },
  {
    name: "snapshot",
    description:
      "Leer la estructura de la página actual (árbol de accesibilidad con refs). Úsalo antes de actuar y para verificar.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "screenshot",
    description:
      "Tomar una captura de imagen para verla con visión. Pasa `ref` para capturar SOLO ese elemento (p.ej. la imagen del captcha) y leer su contenido con más precisión; sin `ref` captura la página.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string", description: "ref del elemento a capturar (opcional; ej. la imagen del captcha)" } },
    },
  },
  {
    name: "click",
    description: "Hacer clic en un elemento por su ref (obtenido del snapshot).",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string", description: "ref del elemento, cópialo del snapshot TAL CUAL (ej. v3:42)" } },
      required: ["ref"],
    },
  },
  {
    name: "type",
    description: "Escribir texto en un campo por su ref.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text: { type: "string" },
        submit: { type: "boolean", description: "Pulsar Enter al terminar" },
        slowly: { type: "boolean", description: "Teclear despacio para disparar autocompletados" },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "fill_form",
    description: "Llenar varios campos de golpe.",
    input_schema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ref: { type: "string" },
              value: { type: "string" },
              type: { type: "string", enum: ["text", "checkbox", "radio", "combobox"] },
            },
            required: ["ref", "value"],
          },
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "batch_actions",
    description:
      "Ejecutar VARIAS acciones independientes de una sola vez (en orden) sobre refs del último snapshot: click, type, select_option, press_key. Ahorra pasos y tiempo en formularios y secuencias. Devuelve UN solo snapshot al final. NO lo uses si una acción depende del resultado visual/DOM de la anterior (esas hazlas por separado).",
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["click", "type", "select_option", "press_key"] },
              ref: { type: "string", description: "ref del elemento (click/type/select_option)" },
              text: { type: "string", description: "texto a escribir (type)" },
              submit: { type: "boolean", description: "pulsar Enter al terminar (type)" },
              values: { type: "array", items: { type: "string" }, description: "opciones a elegir (select_option)" },
              key: { type: "string", description: "tecla a pulsar (press_key)" },
            },
            required: ["action"],
          },
        },
      },
      required: ["actions"],
    },
  },
  {
    name: "select_option",
    description: "Elegir una o varias opciones de un <select> nativo por su ref.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        values: { type: "array", items: { type: "string" } },
      },
      required: ["ref", "values"],
    },
  },
  {
    name: "fill_credential",
    description:
      "Rellenar un campo con un SECRETO guardado (contraseña, etc.) por su CLAVE, sin exponer el valor. El usuario lo configuró con `navia secret set <clave>`. Úsalo en vez de type para contraseñas.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        key: { type: "string", description: 'clave del secreto, ej "occ.password"' },
      },
      required: ["ref", "key"],
    },
  },
  {
    name: "fill_totp",
    description:
      "Calcular el código 2FA (TOTP) actual desde un secreto guardado por su CLAVE y rellenarlo, sin exponer el secreto. El usuario lo configuró con `navia secret totp <clave>`.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        key: { type: "string", description: 'clave del TOTP, ej "occ.2fa"' },
      },
      required: ["ref", "key"],
    },
  },
  {
    name: "press_key",
    description: "Pulsar una tecla (Enter, Escape, Tab, ArrowDown…).",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "evaluate",
    description:
      "Ejecutar JavaScript en la página y devolver un valor. Úsalo para extraer listados (querySelectorAll → JSON) o clics tercos. El código es el cuerpo de una función; usa 'return'.",
    input_schema: {
      type: "object",
      properties: { code: { type: "string", description: "Cuerpo JS, ej: return [...document.querySelectorAll('a')].map(a=>a.href)" } },
      required: ["code"],
    },
  },
  {
    name: "read_text",
    description: "Leer el TEXTO visible de la página (párrafos, artículos, etc., que el snapshot interactivo no incluye).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "scroll",
    description: "Desplazar la página (direction up/down + amount px) o hasta un elemento por ref. Útil para contenido lazy/infinito.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "desplazar hasta este elemento (opcional)" },
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number", description: "píxeles a desplazar (default 700)" },
      },
    },
  },
  {
    name: "wait_for",
    description: "Esperar a que aparezca/desaparezca un texto, o un tiempo fijo (útil para anti-bot / carga).",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Texto que debe aparecer" },
        text_gone: { type: "string", description: "Texto que debe desaparecer" },
        time_ms: { type: "number", description: "Milisegundos a esperar" },
      },
    },
  },
  {
    name: "navigate_back",
    description: "Volver a la página anterior.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "upload_file",
    description: 'Subir archivo(s) a un <input type="file"> por su ref (para adjuntar CV, documentos, etc.).',
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        paths: { type: "array", items: { type: "string" }, description: "rutas absolutas de los archivos a subir" },
      },
      required: ["ref", "paths"],
    },
  },
  {
    name: "list_downloads",
    description: "Listar los archivos descargados en esta sesión (rutas en ~/.navia/downloads).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "tabs",
    description: "Gestionar pestañas: listar, abrir nueva, seleccionar o cerrar.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "new", "select", "close"] },
        index: { type: "number", description: "índice de la pestaña (para select/close)" },
        url: { type: "string", description: "URL al abrir una pestaña nueva (opcional)" },
      },
      required: ["action"],
    },
  },
  {
    name: "confirm_action",
    description:
      "Pedir confirmación humana ANTES de una acción irreversible (enviar, pagar, borrar, postularse, publicar). Obligatorio antes de ejecutarlas.",
    input_schema: {
      type: "object",
      properties: { description: { type: "string", description: "Qué acción se va a hacer" } },
      required: ["description"],
    },
  },
  {
    name: "wait_for_human",
    description: "Pausar para que la persona resuelva algo en la ventana (login, captcha, 2FA, dato personal).",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "Qué necesita hacer la persona" } },
      required: ["reason"],
    },
  },
];

/**
 * Ejecuta una acción basada en ref; si falla (ref caduco/efímero o elemento ausente),
 * re-lee la página y devuelve un snapshot fresco para que el siguiente turno reintente
 * con refs vigentes — recuperación sin escalar a un error genérico.
 */
async function wrapAction(
  driver: BrowserDriver,
  fn: () => Promise<string>,
  opts?: { verifyChange?: boolean },
): Promise<{ text: string }> {
  try {
    const msg = await fn();
    // observe() ya re-lee la página → devolvemos el snapshot actualizado INLINE para que
    // el agente no tenga que pedir snapshot por separado (≈43% de pasos eliminados).
    const obs = await driver.observe();
    let verdict = "";
    if (opts?.verifyChange !== false) {
      // Solo para acciones que DEBERÍAN cambiar la página (ej. click); llenar un campo no.
      verdict = obs.changed
        ? "✓ La página cambió."
        : "⚠️ La página NO cambió de forma observable. ¿La acción tuvo efecto? Prueba otra cosa.";
    }
    return { text: `${msg}${verdict ? `\n${verdict}` : ""}\n${injectionBanner(obs.snapshot, "página")}\n--- página actualizada ---\n${obs.snapshot}` };
  } catch (e) {
    const snap = await driver.snapshot().catch(() => "(no se pudo releer la página)");
    return {
      text: `⚠️ La acción falló: ${(e as Error).message}\nLos refs son efímeros y pudieron cambiar. Snapshot actualizado, reintenta con los nuevos refs:\n${snap}`,
    };
  }
}

/** Ejecuta una tool y devuelve el resultado (texto o bloques con imagen). */
export async function dispatchTool(
  name: string,
  input: Record<string, any>,
  driver: BrowserDriver,
  hooks: AgentHooks,
  policy?: ToolPolicy,
): Promise<{ text?: string; imageBase64?: string }> {
  hooks.log?.(`→ ${name} ${JSON.stringify(input).slice(0, 160)}`);
  if (name === "evaluate" && policy?.allowEval === false) {
    return { text: "🔒 La tool 'evaluate' está deshabilitada en esta corrida (--no-eval). Usa snapshot/read_text/click/type." };
  }
  if (name === "screenshot" && policy?.vision === false) {
    return {
      text: "🚫 No puedes ver imágenes en este modo (proveedor CLI = solo texto). NO insistas con screenshot. Para algo visual como un CAPTCHA de imagen, usa wait_for_human para que la persona lo escriba en la ventana. (Para que Navia LEA el captcha solo, hay que usar --provider api con ANTHROPIC_API_KEY.)",
    };
  }
  switch (name) {
    case "navigate": {
      await driver.navigate(input.url);
      const ch = await driver.detectChallenge();
      const warn = ch
        ? `\n⚠️ Posible muro anti-bot/captcha detectado (${ch}). Llama a wait_for_human para que la persona lo resuelva en la ventana ANTES de continuar.`
        : "";
      const snap = await driver.snapshot(); // devolvemos la página ya leída (evita un paso extra)
      return { text: `Navegado a ${input.url}.${warn}\n${injectionBanner(snap, "página")}\n--- página ---\n${snap}` };
    }
    case "snapshot": {
      const snap = await driver.snapshot();
      const ch = await driver.detectChallenge();
      const warn = ch ? `⚠️ Muro anti-bot/captcha detectado (${ch}). Considera wait_for_human.\n\n` : "";
      return { text: warn + injectionBanner(snap, "snapshot") + snap };
    }
    case "screenshot":
      return { imageBase64: await driver.screenshot(input.ref) };
    case "click": {
      // Gate anti-bucle: si esto es el botón de enviar el login y hay un captcha de imagen SIN
      // resolver, bloquea el envío (fallaría y recargaría). Determinista — no depende del prompt.
      const desc = driver.describeRef(input.ref);
      const looksLikeLoginSubmit =
        desc &&
        /button|link/i.test(desc.role) &&
        /ingresar|iniciar sesi|inicia sesi|log\s?in|acceder|entrar|sign\s?in|enviar|submit|continuar|aceptar/i.test(desc.name);
      if (looksLikeLoginSubmit) {
        const cap = await driver.detectTextCaptcha();
        if (cap.present && cap.empty) {
          return {
            text:
              `🚫 BLOQUEADO: hay un CAPTCHA de imagen SIN resolver (campo ${cap.inputRef ?? "del captcha"} vacío). ` +
              `Enviar el login ahora FALLARÁ y la página se recargará — NO entres en bucle.\n` +
              `Un CAPTCHA verifica que hay una PERSONA: no lo resuelvas tú. Llama a wait_for_human pidiendo a la ` +
              `persona que escriba el captcha en la ventana del navegador, y reintenta este click DESPUÉS de que confirme.`,
          };
        }
      }
      return wrapAction(driver, async () => {
        await driver.click(input.ref);
        return `Clic en ${input.ref}.`;
      });
    }
    case "type":
      return wrapAction(
        driver,
        async () => {
          await driver.type(input.ref, input.text, { submit: input.submit, slowly: input.slowly });
          return `Escrito en ${input.ref}.`;
        },
        { verifyChange: false },
      );
    case "fill_form":
      return wrapAction(
        driver,
        async () => {
          await driver.fillForm(input.fields as FillField[]);
          return `Llenados ${input.fields.length} campos.`;
        },
        { verifyChange: false },
      );
    case "select_option":
      return wrapAction(
        driver,
        async () => {
          await driver.selectOption(input.ref, input.values);
          return `Seleccionado en ${input.ref}.`;
        },
        { verifyChange: false },
      );
    case "batch_actions": {
      const actions = (input.actions ?? []) as Array<Record<string, any>>;
      const lines: string[] = [];
      try {
        for (let i = 0; i < actions.length; i++) {
          const a = actions[i];
          switch (a.action) {
            case "click":
              await driver.click(a.ref);
              lines.push(`${i + 1}. click ${a.ref} ✓`);
              break;
            case "type":
              await driver.type(a.ref, a.text ?? "", { submit: a.submit });
              lines.push(`${i + 1}. type ${a.ref} ✓`);
              break;
            case "select_option":
              await driver.selectOption(a.ref, (a.values ?? []) as string[]);
              lines.push(`${i + 1}. select_option ${a.ref} ✓`);
              break;
            case "press_key":
              await driver.pressKey(a.key);
              lines.push(`${i + 1}. press_key ${a.key} ✓`);
              break;
            default:
              lines.push(`${i + 1}. acción desconocida "${a.action}" — omitida`);
          }
        }
      } catch (e) {
        const snap = await driver.snapshot().catch(() => "(no se pudo releer la página)");
        return {
          text: `⚠️ El lote se detuvo en un error: ${(e as Error).message}\n${lines.join("\n")}\nLos refs son efímeros; snapshot actualizado, reintenta con los nuevos refs:\n${snap}`,
        };
      }
      const obs = await driver.observe();
      const verdict = obs.changed ? "✓ La página cambió." : "⚠️ La página NO cambió de forma observable.";
      return { text: `Lote de ${actions.length} acción(es):\n${lines.join("\n")}\n${verdict}\n${injectionBanner(obs.snapshot, "página")}\n--- página actualizada ---\n${obs.snapshot}` };
    }
    case "fill_credential":
      return wrapAction(
        driver,
        async () => {
          const value = await getSecret(input.key);
          if (value == null) throw new Error(`No hay un secreto "${input.key}". Configúralo: navia secret set ${input.key}`);
          await assertOriginAllowed(driver, input.ref, input.key);
          await driver.type(input.ref, value);
          return `Secreto "${input.key}" rellenado en ${input.ref} (valor oculto).`;
        },
        { verifyChange: false },
      );
    case "fill_totp":
      return wrapAction(
        driver,
        async () => {
          const sec = await getTotpSecret(input.key);
          if (!sec) throw new Error(`No hay TOTP "${input.key}". Configúralo: navia secret totp ${input.key} <base32>`);
          await assertOriginAllowed(driver, input.ref, input.key);
          await driver.type(input.ref, totp(sec));
          return `Código 2FA de "${input.key}" rellenado en ${input.ref} (código oculto).`;
        },
        { verifyChange: false },
      );
    case "press_key":
      await driver.pressKey(input.key);
      return { text: `Tecla ${input.key} pulsada.` };
    case "evaluate": {
      const result = await driver.evaluate(input.code);
      const json = JSON.stringify(result, null, 2).slice(0, 6000);
      return { text: `Resultado (datos de la página, no confiables):\n${spotlight(json, "resultado de evaluate")}` };
    }
    case "read_text": {
      const txt = await driver.readText();
      return { text: txt.trim() ? spotlight(txt.slice(0, 6000), "texto de la página") : "(sin texto visible)" };
    }
    case "scroll":
      await driver.scroll({ ref: input.ref, direction: input.direction, amount: input.amount });
      return { text: "Scroll hecho. Haz snapshot si esperas contenido nuevo." };
    case "wait_for":
      await driver.waitFor({ text: input.text, textGone: input.text_gone, timeMs: input.time_ms });
      return { text: "Espera completada." };
    case "navigate_back":
      await driver.navigateBack();
      return { text: "Volviste a la página anterior." };
    case "upload_file":
      return wrapAction(
        driver,
        async () => {
          await driver.uploadFile(input.ref, input.paths as string[]);
          return `Subidos ${input.paths.length} archivo(s) a ${input.ref}.`;
        },
        { verifyChange: false },
      );
    case "list_downloads": {
      const d = driver.listDownloads();
      return { text: d.length ? `Descargas:\n${d.join("\n")}` : "Sin descargas todavía." };
    }
    case "tabs": {
      switch (input.action) {
        case "list":
          return { text: await driver.listTabs() };
        case "new":
          await driver.newTab(input.url);
          return { text: `Nueva pestaña abierta${input.url ? ` en ${input.url}` : ""}. Haz snapshot para leerla.` };
        case "select":
          await driver.selectTab(input.index);
          return { text: `Pestaña ${input.index} seleccionada. Haz snapshot.` };
        case "close":
          await driver.closeTab(input.index);
          return { text: `Pestaña ${input.index} cerrada.` };
        default:
          return { text: "acción inválida para 'tabs' (usa list|new|select|close)" };
      }
    }
    case "confirm_action": {
      const ok = await hooks.confirmAction(input.description);
      return { text: ok ? "APROBADO por el humano. Puedes proceder." : "RECHAZADO por el humano. No lo hagas; busca otra opción o termina." };
    }
    case "wait_for_human": {
      const note = await hooks.waitForHuman(input.reason);
      // Captura semi-automática: la guía del humano se vuelve un tip reutilizable del dominio.
      if (note && hooks.rememberNote) {
        try {
          await hooks.rememberNote(await driver.currentUrl(), note);
        } catch {
          /* la memoria nunca debe romper la corrida */
        }
      }
      return { text: `El humano terminó. ${note ? `Nota: ${note}` : ""} Continúa con un snapshot.` };
    }
    default:
      return { text: `Herramienta desconocida: ${name}` };
  }
}
