// Boundary enforcement: new code must import workspace packages via @mesh/*
// aliases (mapped in tsconfig.json `paths` + packages/*/package.json `exports`).
// Legacy relative deep imports (`../../protocol/src/index`) still compile for
// backward compatibility but are discouraged — migrate on touch.
import tseslint from "typescript-eslint";

export default [
  {
    files: ["packages/**/*.ts", "apps/**/*.ts", "tests/**/*.ts"],
    // Without a TypeScript parser ESLint falls back to espree, which cannot
    // read `import type`, generics, or annotations — every source file failed
    // with "Parsing error: Unexpected token" and NO rule ever ran. The
    // boundary rule below was silently dead across the whole repo.
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    rules: {
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["../../protocol/src/*", "../../protocol/src/index"],
              message: "Use @mesh/protocol instead of deep relative imports.",
            },
            {
              group: ["../../config/src/*", "../../core/src/*", "../../event-store/src/*"],
              message: "Use @mesh/* aliases instead of deep relative imports.",
            },
            {
              group: ["../../../packages/*/src/*"],
              message: "Apps must import workspace packages via @mesh/* aliases.",
            },
          ],
        },
      ],
    },
  },
];
