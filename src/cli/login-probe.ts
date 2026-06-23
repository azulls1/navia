/**
 * Sonda de login SIN abrir el navegador: baja el HTML de una URL y detecta si hay un formulario
 * de inicio de sesión. La usa el wizard para decidir si pedir credenciales.
 */

/**
 * Baja el HTML de una URL con un GET de bajo nivel. Usa `rejectUnauthorized:false` SOLO para esta
 * sonda de detección (lee HTML público para ver si hay login; NO envía credenciales): algunos
 * sitios (p.ej. CFE) tienen cadenas de certificado que el fetch estricto de Node rechaza pero el
 * navegador acepta. Sigue hasta 3 redirecciones; timeout 8s; corta a ~600KB.
 */
export async function fetchHtml(url: string, redirects = 3): Promise<string> {
  const { request } = await import(url.startsWith("https") ? "node:https" : "node:http");
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        rejectUnauthorized: false,
        timeout: 8000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      },
      (res: any) => {
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc && redirects > 0) {
          res.resume();
          resolve(fetchHtml(new URL(loc, url).href, redirects - 1));
          return;
        }
        let data = "";
        res.on("data", (c: Buffer) => {
          data += c.toString();
          if (data.length > 600_000) req.destroy();
        });
        res.on("end", () => resolve(data));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Detección rápida (sin abrir navegador) de si una página tiene login: baja el HTML y busca un
 * campo de contraseña o palabras clave. true si detecta login; false/null si no (en cuyo caso el
 * wizard pregunta, por si es una SPA que renderiza el login con JS).
 */
export async function detectLoginOnPage(url?: string): Promise<boolean | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  // 2 intentos: la sonda de red puede fallar puntualmente (timeout/TLS) → no queremos un falso "no".
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = (await fetchHtml(url)).toLowerCase();
      if (/type\s*=\s*["']?password/.test(html)) return true;
      if (/iniciar sesi[oó]n|inicia sesi[oó]n|log\s?in|sign\s?in|contrase|usuario y contrase|acceder/.test(html)) return true;
      return false;
    } catch {
      /* reintenta una vez */
    }
  }
  return null; // no se pudo bajar (red/SPA) → flujo de "usuario opcional"
}
