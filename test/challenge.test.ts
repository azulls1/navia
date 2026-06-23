/**
 * Tests de la lógica PURA de detección extraída de driver.ts: clasificación de muros anti-bot
 * (classifyChallenge) y veredicto determinista de login (assessLogin). Sin navegador.
 */
import { describe, it, expect } from "vitest";
import { classifyChallenge, assessLogin } from "../src/browser/challenge.js";

describe("challenge · classifyChallenge", () => {
  const base = { url: "https://site.test/", title: "Inicio", frameUrls: "" };
  it("Cloudflare por title", () => {
    expect(classifyChallenge({ ...base, title: "Just a moment..." })).toBe("Cloudflare");
    expect(classifyChallenge({ ...base, title: "Attention Required!" })).toBe("Cloudflare");
  });
  it("Cloudflare por url de challenge", () => {
    expect(classifyChallenge({ ...base, url: "https://x/cdn-cgi/challenge-platform/" })).toBe("Cloudflare");
  });
  it("Turnstile / hCaptcha / reCAPTCHA / DataDome por iframe", () => {
    expect(classifyChallenge({ ...base, frameUrls: "https://challenges.cloudflare.com/turnstile/x" })).toBe("Cloudflare Turnstile");
    expect(classifyChallenge({ ...base, frameUrls: "https://hcaptcha.com/captcha" })).toBe("hCaptcha");
    expect(classifyChallenge({ ...base, frameUrls: "https://www.recaptcha.net/x" })).toBe("reCAPTCHA");
    expect(classifyChallenge({ ...base, frameUrls: "https://geo.captcha-delivery.com/x" })).toBe("DataDome");
  });
  it("null si no hay señales", () => {
    expect(classifyChallenge(base)).toBeNull();
  });
});

describe("challenge · assessLogin", () => {
  it("error visible → failed", () => {
    expect(assessLogin({ url: "https://x/login", stillPassword: false, text: "Usuario o contraseña incorrectos" }).status).toBe("failed");
    expect(assessLogin({ url: "https://x/login", stillPassword: false, text: "Captcha incorrecto, vuelva a intentar" }).status).toBe("failed");
  });
  it("sigue el campo password → failed", () => {
    expect(assessLogin({ url: "https://x/home", stillPassword: true, text: "bienvenido" }).status).toBe("failed");
  });
  it("sin password + enlace de sesión → success", () => {
    expect(assessLogin({ url: "https://x/login", stillPassword: false, text: "Bienvenido — Cerrar sesión" }).status).toBe("success");
  });
  it("sin password + salió de la URL de login → success", () => {
    const r = assessLogin({ url: "https://x/dashboard", stillPassword: false, text: "panel", loginUrl: "https://x/login" });
    expect(r.status).toBe("success");
  });
  it("sin señales claras → unknown", () => {
    expect(assessLogin({ url: "https://x/page", stillPassword: false, text: "contenido cualquiera" }).status).toBe("unknown");
  });
});
