import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/.pytest_cache/**",
      "**/__pycache__/**",
      "packages/database/generated/**",
      "race-calendar-connect/**",
      "race-operations-hub/**",
      // Unmodified upstream browser assets/examples retained for Python regression tests.
      "apps/openresults-worker/app/static/**",
      "apps/openresults-worker/examples/**",
    ],
  },
  {
    files: ["scripts/*.mjs"],
    languageOptions: { globals: { process:"readonly",console:"readonly",fetch:"readonly",AbortSignal:"readonly",URL:"readonly" } },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    }
  }
);
