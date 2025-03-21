import pluginJs from "@eslint/js";
import securityPlugin from "eslint-plugin-security";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  // Top-level ignores for all configurations
  {
    ignores: [
      "dist/**",
      "**/dist/**",
      "node_modules/**",
      "**/node_modules/**",
      "coverage/**",
      "build/**",
      "temp/**",
      "tmp/**",
      "**/*.log",
    ],
  },

  // Base language options for all files
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // JavaScript-specific configurations
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-console": "off",
      semi: ["error", "always"],
      quotes: ["error", "double"],
    },
  },

  // TypeScript core configurations
  {
    files: ["**/*.ts"],
    languageOptions: {
      // skipcq: JS-P1003
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: process.cwd(),
      },
      globals: {
        NodeJS: "readonly",
      },
    },
    plugins: {
      // skipcq: JS-P1003
      "@typescript-eslint": tseslint.plugin,
      security: securityPlugin,
    },
  },

  // Apply recommended configs and styling
  pluginJs.configs.recommended,
  // skipcq: JS-P1003
  ...tseslint.configs.recommended,
  // skipcq: JS-P1003
  ...tseslint.configs.stylistic,

  // Combined rules for TypeScript files
  {
    files: ["**/*.ts"],
    rules: {
      // Code quality rules
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "no-param-reassign": "warn",
      "prefer-promise-reject-errors": "warn",

      // Security rules
      "security/detect-object-injection": "warn",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-unsafe-regex": "warn",
      "security/detect-buffer-noassert": "error",
      "security/detect-eval-with-expression": "error",
      "security/detect-no-csrf-before-method-override": "error",
      "security/detect-possible-timing-attacks": "warn",
      "security/detect-pseudoRandomBytes": "warn",
      "security/detect-new-buffer": "error",
      "security/detect-child-process": "error",
      "security/detect-disable-mustache-escape": "error",
      "security/detect-non-literal-fs-filename": "warn",
      "no-eval": "error",
      "no-new-func": "error",
      "no-implied-eval": "error",
    },
  },

  // File-specific exceptions - documented security patterns
  {
    files: [
      "src/utilities/cnf/index.ts",
      "src/utilities/database/**/*.ts",
      "src/utilities/debugUtils.ts",
      "src/utilities/loadCommands.ts",
      "src/utilities/loadEvents.ts",
      "src/utilities/logger.ts",
      "src/utilities/routines/**/*.ts",
      "src/utilities/startup.ts",
      "src/utilities/registerCommands.ts",
      "src/utilities/securityExceptions.ts",
    ],
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },
  {
    files: [
      "src/events/interactionCreate.ts",
      "src/utilities/apiErrorHandler.ts",
      "src/utilities/database/DatabaseManager.ts",
      "src/utils/shutdown.ts",
      "src/utilities/startup.ts",
      "src/utilities/securityExceptions.ts",
    ],
    rules: {
      "security/detect-object-injection": "off",
    },
  },
  {
    files: [
      "src/utilities/regex.ts",
      "src/utilities/securityExceptions.ts",
      "src/utilities/cnf/defaults.ts",
      "src/commands/public/thread.ts",
    ],
    rules: {
      "security/detect-non-literal-regexp": "off",
      "security/detect-unsafe-regex": "off",
    },
  },
  {
    files: ["src/commands/private/eval.ts"],
    rules: {
      "no-new-func": "off",
      "no-eval": "off",
      "no-implied-eval": "off",
      "@typescript-eslint/no-implied-eval": "off",
      "security/detect-eval-with-expression": "off",
    },
  },
];
