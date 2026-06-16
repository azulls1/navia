/**
 * Definición de herramientas (esquema para la API de Anthropic) + el dispatcher
 * que ejecuta cada herramienta contra el BrowserDriver.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { BrowserDriver, FillField } from "../browser/driver.js";
import { getSecret, getTotpSecret } from "../secrets/vault.js";
import { totp } from "../secrets/totp.js";

export interface AgentHooks {
  /** Pedir confirmación humana para una acción irreversible. Devuelve true si se aprueba. */
  confirmAction: (description: string) => Promise<boolean>;
  /** Pausar para que el humano resuelva algo en la ventana (login/captcha). Devuelve nota opcional. */
  waitForHuman: (reason: string) => Promise<string>;
  /** Log de progreso. */
  log?: (msg: string) => void;
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
    description: "Tomar una captura de imagen de la página para verla con visión.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "click",
    description: "Hacer clic en un elemento por su ref (obtenido del snapshot).",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string", description: "ref del elemento, ej. e12" } },
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
async function wrapAction(driver: BrowserDriver, fn: () => Promise<string>): Promise<{ text: string }> {
  try {
    const msg = await fn();
    // Change-observation: verificación REAL de si la acción tuvo efecto observable.
    const obs = await driver.observe();
    const verdict = obs.changed
      ? "✓ La página cambió tras la acción."
      : "⚠️ La página NO cambió de forma observable. ¿La acción tuvo efecto? Verifica con snapshot/screenshot o prueba otra cosa.";
    return { text: `${msg}\n${verdict}` };
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
): Promise<{ text?: string; imageBase64?: string }> {
  hooks.log?.(`→ ${name} ${JSON.stringify(input).slice(0, 160)}`);
  switch (name) {
    case "navigate": {
      await driver.navigate(input.url);
      const ch = await driver.detectChallenge();
      const warn = ch
        ? `\n⚠️ Posible muro anti-bot/captcha detectado (${ch}). Llama a wait_for_human para que la persona lo resuelva en la ventana ANTES de continuar.`
        : "";
      return { text: `Navegado a ${input.url}. Llama a snapshot para leer la página.${warn}` };
    }
    case "snapshot": {
      const snap = await driver.snapshot();
      const ch = await driver.detectChallenge();
      return { text: (ch ? `⚠️ Muro anti-bot/captcha detectado (${ch}). Considera wait_for_human.\n\n` : "") + snap };
    }
    case "screenshot":
      return { imageBase64: await driver.screenshot() };
    case "click":
      return wrapAction(driver, async () => {
        await driver.click(input.ref);
        return `Clic en ${input.ref}. Haz snapshot para ver el resultado.`;
      });
    case "type":
      return wrapAction(driver, async () => {
        await driver.type(input.ref, input.text, { submit: input.submit, slowly: input.slowly });
        return `Escrito en ${input.ref}.`;
      });
    case "fill_form":
      return wrapAction(driver, async () => {
        await driver.fillForm(input.fields as FillField[]);
        return `Llenados ${input.fields.length} campos.`;
      });
    case "select_option":
      return wrapAction(driver, async () => {
        await driver.selectOption(input.ref, input.values);
        return `Seleccionado en ${input.ref}.`;
      });
    case "fill_credential":
      return wrapAction(driver, async () => {
        const value = await getSecret(input.key);
        if (value == null) throw new Error(`No hay un secreto "${input.key}". Configúralo: navia secret set ${input.key}`);
        await driver.type(input.ref, value);
        return `Secreto "${input.key}" rellenado en ${input.ref} (valor oculto).`;
      });
    case "fill_totp":
      return wrapAction(driver, async () => {
        const sec = await getTotpSecret(input.key);
        if (!sec) throw new Error(`No hay TOTP "${input.key}". Configúralo: navia secret totp ${input.key} <base32>`);
        await driver.type(input.ref, totp(sec));
        return `Código 2FA de "${input.key}" rellenado en ${input.ref} (código oculto).`;
      });
    case "press_key":
      await driver.pressKey(input.key);
      return { text: `Tecla ${input.key} pulsada.` };
    case "evaluate": {
      const result = await driver.evaluate(input.code);
      return { text: `Resultado:\n${JSON.stringify(result, null, 2).slice(0, 6000)}` };
    }
    case "wait_for":
      await driver.waitFor({ text: input.text, textGone: input.text_gone, timeMs: input.time_ms });
      return { text: "Espera completada." };
    case "navigate_back":
      await driver.navigateBack();
      return { text: "Volviste a la página anterior." };
    case "confirm_action": {
      const ok = await hooks.confirmAction(input.description);
      return { text: ok ? "APROBADO por el humano. Puedes proceder." : "RECHAZADO por el humano. No lo hagas; busca otra opción o termina." };
    }
    case "wait_for_human": {
      const note = await hooks.waitForHuman(input.reason);
      return { text: `El humano terminó. ${note ? `Nota: ${note}` : ""} Continúa con un snapshot.` };
    }
    default:
      return { text: `Herramienta desconocida: ${name}` };
  }
}
