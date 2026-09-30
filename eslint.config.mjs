import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", ".claude/**", "artifacts/**", "**/coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        structuredClone: "readonly",
        queueMicrotask: "readonly",
        window: "readonly",
        document: "readonly",
        EventSource: "readonly",
        navigator: "readonly",
        performance: "readonly",
        crypto: "readonly",
      },
    },
    rules: {
      // The codebase initializes before try/finally blocks on purpose; the rule flags that idiom.
      "no-useless-assignment": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
);
