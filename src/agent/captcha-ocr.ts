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
import path from "node:path";

let _ocr: any = null;
let _failed = false;

/**
 * Carga `ddddocr-node` de forma robusta: (1) resolución normal; (2) desde el CWD del usuario
 * (clave: si Navia corre vía `npx navia-ai`, vive en la caché de npx y NO ve el `ddddocr-node`
 * que el usuario instaló en su carpeta — aquí lo resolvemos desde process.cwd()).
 */
async function loadDdddModule(): Promise<any | null> {
  const spec = "ddddocr-node";
  try {
    return await import(spec);
  } catch {
    /* sigue al fallback por CWD */
  }
  try {
    const req = createRequire(pathToFileURL(path.join(process.cwd(), "package.json")).href);
    const resolved = req.resolve(spec);
    return await import(pathToFileURL(resolved).href);
  } catch {
    return null;
  }
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
