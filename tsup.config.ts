import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: false,
  treeshake: true,
  clean: true,
  outDir: "dist",
  minify: false,
  target: "es2020",
});
