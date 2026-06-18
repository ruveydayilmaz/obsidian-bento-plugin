import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["src/**/*.{ts,tsx,js}", "*.js"],
    ignores: ["dist/**", "build/**"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
      },
      globals: {
        ...globals.browser,
      },
    },
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],
  },
]);
