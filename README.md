# 🌐 Navia

> Agente de navegador autónomo con IA. Le das una **instrucción en lenguaje natural** y abre un navegador **real** (Chrome o Firefox), lee la página, hace clic, llena formularios, extrae datos y opera **cualquier portal web** — como lo haría una persona.

Funciona con tu **API key de Anthropic (Claude)**. Sin scripts a medida por sitio: la IA descubre los botones y campos en vivo con el método **navegar → leer → actuar → verificar**.

```bash
npx navia-ai "abre example.com y dime de qué trata la página"
```

---

## ✨ Qué hace

- 🧠 **Una instrucción, no un script.** Describes la tarea; Navia decide los pasos.
- 🦊 **Chrome o Firefox reales** a elegir.
- 🛡️ **Anti-Cloudflare incluido.** Modo `--browser chrome` que se conecta por **CDP a un Chrome real** → `navigator.webdriver=false` → pasa el muro "Just a moment…". No es evasión: es tu navegador.
- 👁️ **Lee como humano:** árbol de accesibilidad (no píxeles) + screenshots para verificar con visión.
- 🧩 **Extracción masiva** con JavaScript (listados → JSON).
- 🔐 **Seguro por diseño:** pide confirmación antes de acciones irreversibles (enviar, pagar, borrar) y te cede la ventana para login / captcha / 2FA.
- 📦 **CLI + librería** (TypeScript, ESM).

## 📦 Instalación

```bash
npm install -g navia-ai      # global, para usar el comando `navia`
# o sin instalar:
npx navia-ai "tu tarea"
```

Primera vez (instala los navegadores de Playwright):

```bash
npx playwright install chromium firefox
```

Configura tu API key (archivo `.env` o variable de entorno):

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

## 🚀 Uso (CLI)

```bash
# Navegador por defecto (Chromium)
navia "busca 'camisetas' en example-shop.com y lístame los primeros 5 productos con precio"

# Firefox
navia run "entra a mi-portal.com, inicia sesión y descarga mi última factura" --browser firefox

# Chrome real (sitios con Cloudflare)
navia chrome                                   # 1) lanza Chrome con depuración
navia run "busca empleos de QA en {portal}" --browser chrome   # 2) la tarea

# Otras opciones
navia "..." --headless           # sin ventana
navia "..." --slow-mo 300        # ir lento (anti rate-limit)
navia "..." --start-url https://...   # abrir una URL antes de empezar
navia "..." --model claude-opus-4-8   # otro modelo
```

Durante la ejecución:
- Si hace falta **login / captcha / 2FA**, Navia pausa y te pasa la ventana.
- Antes de algo **irreversible**, te pide confirmación (`s/N`).

## 🧑‍💻 Uso (librería)

```ts
import { runNavia } from "navia-ai";

const { summary, steps } = await runNavia({
  task: "Abre example.com y extrae todos los enlaces del menú principal",
  browser: "chromium",
  hooks: {
    log: (m) => console.log(m),
    confirmAction: async (desc) => /* tu lógica */ true,
    waitForHuman: async (reason) => { /* resolver y */ return ""; },
  },
});

console.log(summary);
```

## 🔧 Cómo funciona (arquitectura)

```
Tu instrucción ─► BrowserAgent (loop de tool-use con Claude)
                      │  navigate · snapshot · click · type · fill_form · evaluate · wait_for · screenshot
                      ▼
                 BrowserDriver (Playwright)
                      ▼
        Chrome real (CDP)  /  Firefox  /  Chromium  ─►  el sitio web
```

1. **snapshot** = árbol de accesibilidad con `ref` por elemento (la IA actúa por `ref`).
   - En **Chromium/Chrome** el snapshot se construye con **CDP** (`Accessibility.getFullAXTree`): no muta el DOM, atraviesa **shadow DOM**, y los `ref` son **estables** (`backendNodeId`). Las acciones se resuelven por CDP.
   - En **Firefox** (que no habla CDP) se usa un snapshot por inyección de JS como *fallback*; ahí los `ref` son efímeros → re-snapshotea tras cambios del DOM.
2. **evaluate** ejecuta JS para extraer listados o resolver clics tercos.
3. **detectChallenge** reconoce muros (Cloudflare/Turnstile/hCaptcha/reCAPTCHA/DataDome) y cede la ventana al humano.
4. El **system prompt** lleva destilado el método probado en producción.

| Motor | Cuándo usarlo |
|---|---|
| `chromium` (default) | La mayoría de sitios. |
| `firefox` | Alternativa; algunos portales se portan mejor. |
| `chrome` (CDP) | 🔑 Sitios con muro **Cloudflare**. Lanza tu Chrome real y se conecta por CDP. |

## ⚠️ Uso responsable

Navia opera un navegador real con tus credenciales y tu sesión. Úsalo solo en sitios y cuentas **propias o con autorización**, respetando los Términos de Servicio. El truco CDP **no burla** protecciones por fuerza: usa tu navegador real. No incluye solvers de captcha ni stealth: cuando hace falta un humano (captcha/2FA), te cede la ventana.

## 📄 Licencia

MIT
