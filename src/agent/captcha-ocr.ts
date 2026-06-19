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

let _ocr: any = null;
let _failed = false;

async function getOcr(): Promise<any | null> {
  if (_ocr) return _ocr;
  if (_failed) return null;
  try {
    const spec = "ddddocr-node"; // especificador dinámico: opcional, no se resuelve en build
    const mod = await import(spec);
    const DdddOcr = mod.DdddOcr ?? mod.default?.DdddOcr;
    if (!DdddOcr) throw new Error("DdddOcr no encontrado");
    _ocr = new DdddOcr();
    return _ocr;
  } catch {
    _failed = true; // no instalado → no reintentar en cada paso
    return null;
  }
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
