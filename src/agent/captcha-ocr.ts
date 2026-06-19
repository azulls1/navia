/**
 * OCR LOCAL y GRATIS de captchas de texto (proveedor `--captcha local`), sin servicios de pago
 * ni involucrar al LLM. Usa `ddddocr-node` — un modelo ONNX pre-entrenado ESPECÍFICO para
 * captchas (puerto del ddddocr de 14k★, MIT), que corre en Node (onnxruntime), offline.
 *
 * Verificado leyendo captchas REALES de CFE correctamente. Es OPCIONAL: no es dependencia de
 * Navia (para no inflar la instalación con onnxruntime/tfjs). Para activarlo: `npm i ddddocr-node`.
 * Si no está instalado, devuelve null y Navia cae al handoff humano.
 *
 * No es el LLM resolviendo un captcha: es una herramienta OCR dedicada, para la cuenta PROPIA del
 * usuario y bajo su autorización (opt-in explícito con --captcha local).
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let _ocr: any = null;
let _failed = false;

/** Carpeta propia de Navia donde instalamos el OCR (para no ensuciar el CWD del usuario). */
function naviaHome(): string {
  return path.join(os.homedir(), ".navia");
}

/** Intenta resolver+importar un módulo desde la carpeta `base` (createRequire). */
async function importFrom(base: string, spec: string): Promise<any | null> {
  try {
    const req = createRequire(pathToFileURL(path.join(base, "package.json")).href);
    return await import(pathToFileURL(req.resolve(spec)).href);
  } catch {
    return null;
  }
}

/**
 * Carga `ddddocr-node` de forma robusta, buscando en: (1) resolución normal; (2) el CWD del
 * usuario; (3) ~/.navia (donde lo instala `navia ocr`/el wizard). Clave porque con `npx navia-ai`
 * Navia vive en la caché de npx y no vería un install hecho en otra ruta.
 */
async function loadDdddModule(): Promise<any | null> {
  const spec = "ddddocr-node";
  try {
    return await import(spec);
  } catch {
    /* fallbacks */
  }
  return (await importFrom(process.cwd(), spec)) ?? (await importFrom(naviaHome(), spec));
}

/**
 * Instala el OCR local (ddddocr-node) en ~/.navia para que el usuario NO tenga que conocer el
 * nombre del paquete. Devuelve true si quedó disponible. Resetea la caché para reintentar.
 */
export function installOcr(onLog?: (m: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const dir = naviaHome();
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* noop */
    }
    const child = spawn("npm", ["i", "ddddocr-node", "--prefix", dir, "--no-audit", "--no-fund", "--loglevel", "error"], {
      stdio: onLog ? ["ignore", "pipe", "pipe"] : "ignore",
      shell: process.platform === "win32",
    });
    child.stdout?.on("data", (d) => onLog?.(d.toString().trim()));
    child.stderr?.on("data", (d) => onLog?.(d.toString().trim()));
    child.on("error", () => resolve(false));
    child.on("close", async (code) => {
      _failed = false;
      _ocr = null; // fuerza recarga
      resolve(code === 0 && (await ocrAvailable()));
    });
  });
}

async function getOcr(): Promise<any | null> {
  if (_ocr) return _ocr;
  if (_failed) return null;
  try {
    const mod = await loadDdddModule();
    const DdddOcr = mod?.DdddOcr ?? mod?.default?.DdddOcr;
    if (!DdddOcr) throw new Error("ddddocr-node no instalado");
    _ocr = new DdddOcr();
    return _ocr;
  } catch {
    _failed = true; // no instalado → no reintentar en cada paso
    return null;
  }
}

/** ¿Está disponible el OCR local (ddddocr-node), resolviéndolo también desde el CWD? */
export async function ocrAvailable(): Promise<boolean> {
  return (await getOcr()) != null;
}

/** Lee el texto de un captcha (PNG base64) con ddddocr local. null si no se pudo. */
export async function ocrCaptcha(pngBase64: string): Promise<string | null> {
  const ocr = await getOcr();
  if (!ocr) return null;
  try {
    const raw = await ocr.classification(Buffer.from(pngBase64, "base64"));
    const text = String(raw ?? "").replace(/[^A-Za-z0-9]/g, "");
    return text || null;
  } catch {
    return null;
  }
}
