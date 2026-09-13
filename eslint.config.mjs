// Boundary enforcement: flags relative deep imports that reach across package
// boundaries (`../../protocol/src/index`). These warnings mark the migration
// surface — they are not yet actionable one file at a time.
//
// READ THIS BEFORE "FIXING" A WARNING. `@mesh/*` resolves at COMPILE time only
// (tsconfig.json `paths`). tsc does not rewrite the specifier, so the emitted
// `require("@mesh/protocol")` has to resolve through node_modules at runtime,
// and it does not:
//   - packages/*/package.json `exports` points at `./src/index.ts`, so Node
//     type-strips the source and then fails on its extensionless relative
//     imports (`./types`) — ERR_MODULE_NOT_FOUND. Making that work means a
//     NodeNext `.js`-extension migration across every package.
//   - Pointing `main` at the top-level dist instead does not work either: Node
//     resolves `main` against the symlink location under node_modules, not the
//     package realpath, so a `../../` escape lands in node_modules/dist.
// Both routes end at the same place: `exports` cannot name a path outside its
// own package, and this repo compiles every package into ONE top-level dist/.
// Runtime `@mesh/*` therefore needs per-package output directories — a build
// restructure, not an import rewrite. Until that lands, changing an import to
// `@mesh/*` produces code that compiles green and crashes on start.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["packages/**/*.ts", "apps/**/*.ts", "apps/**/*.tsx", "tests/**/*.ts"],
    // Without a TypeScript parser ESLint falls back to espree, which cannot
    // read `import type`, generics, or annotations — every source file failed
    // with "Parsing error: Unexpected token" and NO rule ever ran. The
    // boundary rule below was silently dead across the whole repo.
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "no-restricted-imports": [
        "warn",
        {
          patterns: [
            {
              group: ["../../protocol/src/*", "../../protocol/src/index"],
              message: "Crosses a package boundary. Do NOT switch this to @mesh/protocol yet - it compiles but does not resolve at runtime; see the note at the top of this file.",
            },
            {
              group: ["../../config/src/*", "../../core/src/*", "../../event-store/src/*"],
              message: "Crosses a package boundary. Do NOT switch this to an @mesh/* alias yet - it compiles but does not resolve at runtime; see the note at the top of this file.",
            },
            {
              group: ["../../../packages/*/src/*"],
              message: "App reaches into package src/. Do NOT switch this to an @mesh/* alias yet - it compiles but does not resolve at runtime; see the note at the top of this file.",
            },
          ],
        },
      ],
    },
  },
];
