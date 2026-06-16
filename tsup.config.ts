import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "node20",
  dts: true,
  sourcemap: true,
  clean: true,
  shims: true,
  // El shebang vive como hashbang al inicio de src/cli.ts (esbuild lo preserva solo
  // en ese entry). Así NO se cuela en dist/index.js, el entry de librería.
});
