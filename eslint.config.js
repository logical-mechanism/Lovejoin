// Single shared ESLint config for the whole pnpm workspace.
//
// Rule philosophy: catch real bugs (no-undef, no-unused-vars,
// react-hooks/rules-of-hooks) and let Prettier handle every stylistic
// concern (no eslint-plugin-prettier overlap, no double-formatting
// passes). Keep the surface narrow so this config doesn't fight existing
// patterns - tighten later in dedicated PRs.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // Apply to TS / TSX / JS files only. Aiken, Rust, Markdown, JSON live
  // outside ESLint's domain.
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "**/.vite/**",
      "**/.cache/**",
      "ui/public/**",
      "contracts/build/**",
      "contracts/.build/**",
      "crypto/ref/target/**",
      "artifacts/**",
      "papers/**",
      // Generated typedoc HTML + assets (issue #41). Linting third-party
      // navigation.js / search.js shipped by typedoc would only ever
      // produce false positives.
      "offchain/docs/**",
      "**/*.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Defaults for every TS/JS file in the workspace.
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.es2023,
      },
    },
    rules: {
      // Lots of legitimate `any` in tx-builder + mesh shims; flagging
      // these all at once would bury actionable errors. Re-enable in a
      // follow-up once individual modules are tightened.
      "@typescript-eslint/no-explicit-any": "off",

      // Allow `_`-prefixed args / catches / vars to signal "intentionally
      // unused". Matches the convention already in the codebase.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // mesh + cbor-x types leak `{}` and `Function` into a handful of
      // generic constraints; downgrade so this PR doesn't double as a
      // typings overhaul.
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-wrapper-object-types": "off",

      // `require(...)` is occasionally needed for vite plugin shims and
      // CJS-only deps in scripts/. Allow.
      "@typescript-eslint/no-require-imports": "off",

      // ts-expect-error / ts-ignore have legitimate uses around mesh's
      // partial typings; require a description so the why is visible.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": "allow-with-description",
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 5,
        },
      ],

      // Bytes / hex constants are easier to read literally than via
      // numeric separators. Don't fight that.
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },

  // UI workspace: React + browser globals + hooks rules.
  {
    files: ["ui/**/*.{ts,tsx,js,jsx}"],
    plugins: {
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2023,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,

      // React 19 + the new JSX transform = no need to import React in
      // every file; turn off the legacy rules that demand it.
      "react/react-in-jsx-scope": "off",
      "react/jsx-uses-react": "off",

      // The codebase passes a lot of optional/typed children through
      // generic wrappers; PropTypes are unnecessary in a TS app.
      "react/prop-types": "off",

      // i18next strings frequently include curly braces for
      // interpolation placeholders, which trips the rule on raw JSX
      // text. We lint i18n separately via ui/scripts/check-i18n.mjs.
      "react/no-unescaped-entities": "off",
    },
  },

  // Test files: vitest globals + node + relax a few rules so test
  // scaffolding doesn't have to fight the linter.
  {
    files: [
      "**/*.test.{ts,tsx}",
      "**/test/**/*.{ts,tsx}",
      "**/tests/**/*.{ts,tsx}",
      "**/__tests__/**/*.{ts,tsx}",
      "stress-tests/**/*.{ts,tsx}",
      "integration-tests/**/*.{ts,tsx}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },

  // Playwright e2e specs: same relaxations as vitest tests, plus rules
  // that fight Playwright's fixture pattern. `test.extend({ ctx: async
  // ({}, use) => ... })` is canonical Playwright — the empty destructure
  // means "no upstream fixtures consumed", and `use` is the fixture
  // injector callback (not React's `use` hook).
  {
    files: ["ui/e2e/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      "no-empty-pattern": "off",
      "react-hooks/rules-of-hooks": "off",
    },
  },

  // Build / config / script files run on Node only.
  {
    files: [
      "**/*.config.{ts,js,mjs,cjs}",
      "**/scripts/**/*.{ts,js,mjs,cjs}",
      "scripts/**/*.{ts,js,mjs,cjs}",
      "infra/**/*.{ts,js,mjs,cjs}",
      "Makefile.*",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Disable every rule Prettier already covers. MUST be last so it
  // wins the rule resolution.
  prettierConfig,
);
