import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Electron main/preload run in Node (CommonJS), not the Next/browser env.
    "electron/**",
    // Node tooling scripts (release automation).
    "scripts/**",
    // Build artifacts — packaged app, bundled deps, standalone server.
    "release/**",
  ]),
]);

export default eslintConfig;
