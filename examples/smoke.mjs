// Smoke test del driver SIN API key: lanza Chromium, navega y muestra el snapshot.
import { BrowserDriver } from "../dist/index.js";

const driver = await BrowserDriver.create({ engine: "chromium", headless: true });
await driver.navigate("https://example.com");
const snap = await driver.snapshot();
console.log(snap);
const links = await driver.evaluate("return [...document.querySelectorAll('a')].map(a => ({text: a.innerText, href: a.href}))");
console.log("\nEnlaces extraídos vía evaluate:", JSON.stringify(links));
await driver.close();
console.log("\n✓ Smoke test OK");
