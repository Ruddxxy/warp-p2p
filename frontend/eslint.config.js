import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Allow unused vars prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Allow empty catch blocks (used throughout for graceful fallbacks)
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-this-alias": "off",
      // Control regex is used intentionally for filename sanitization
      "no-control-regex": "off",
    },
  },
  {
    // WarpScene uses Math.random() in useMemo([]) for one-time particle initialization — intentional
    files: ["src/components/WarpScene.tsx"],
    rules: {
      "react-hooks/purity": "off",
    },
  },
  {
    // Test files use Function type for mock signatures
    files: ["src/lib/__tests__/**"],
    rules: {
      "@typescript-eslint/no-unsafe-function-type": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "coverage/", "playwright-report/", "test-results/", "e2e/"],
  },
);
