import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([".next/**", "coverage/**", ".scannerwork/**", "dist/**", "data/**", "next-env.d.ts"]),
  {
    files: ["**/*.mjs"],
    extends: [js.configs.recommended],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    files: ["app/**/*.{ts,tsx}"],
    extends: [next.configs["core-web-vitals"], reactHooks.configs.flat.recommended],
  },
]);
