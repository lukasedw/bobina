# Phase 1 — Scaffold & toolchain

**Goal:** Replace the bare scaffold with a proper, git-installable TypeScript
library toolchain. After this phase, later phases can write code and validate.

Read `PLAN.md` first.

## Starting state

The repo currently has a placeholder `package.json` (`private: true`, target
`es2016`, `commonjs`, build = `tsc`), a `tsconfig.json` (es2016/commonjs), and
`src/index.ts` containing only a `console.log`. Replace these.

## Tasks

1. **`package.json`** — rewrite:
   - `"name": "bobina"`, `"version": "0.1.0"`, drop `"private"`.
   - `"description"`: "HTTP cassettes (record/replay) for the modern Node fetch era."
   - `"license": "MIT"`, `"author": "Lucas Guedes"`.
   - `"type": "module"`.
   - `"exports"`: `{ ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" } }`.
   - `"main": "./dist/index.cjs"`, `"module": "./dist/index.js"`, `"types": "./dist/index.d.ts"`.
   - `"files": ["dist"]`.
   - `"engines": { "node": ">=20" }`.
   - Scripts: `build` (tsup), `dev` (tsup --watch), `typecheck` (`tsc --noEmit`),
     `test` (`vitest run`), `test:watch` (`vitest`), `lint` (`eslint .`),
     `lint:fix` (`eslint . --fix`), `format` (`prettier --write .`),
     `format:check` (`prettier --check .`), and `prepare` (`tsup`) so the package
     builds when installed as a git dependency.
   - `dependencies`: `@mswjs/interceptors` (latest 0.x).
   - `devDependencies`: `typescript`, `tsup`, `vitest`, `eslint`,
     `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`,
     `@eslint/js`, `prettier`, `@types/node`.
2. **`tsconfig.json`** — `target: ES2022`, `module: NodeNext`,
   `moduleResolution: NodeNext`, `strict: true`, `declaration: true`,
   `skipLibCheck: true`, `verbatimModuleSyntax: true`, `outDir: dist`,
   `include: ["src"]`. No `any`, no implicit returns.
3. **`tsup.config.ts`** — entry `src/index.ts`, `format: ['esm', 'cjs']`,
   `dts: true`, `clean: true`, `target: 'node20'`, `sourcemap: true`.
4. **`vitest.config.ts`** — node environment, `include: ['tests/**/*.test.ts']`.
5. **`eslint.config.mjs`** — flat config: `@eslint/js` recommended +
   `typescript-eslint` recommended-type-checked. Rules: `no-explicit-any` error,
   no `@ts-ignore`. Ignore `dist/`, `node_modules/`, `examples/`.
6. **`prettier.config.mjs`** — single quotes, trailing commas, width 100.
7. **`src/index.ts`** — replace the `console.log` with a temporary
   `export const VERSION = '0.1.0';` (real exports land in later phases).
8. **`tests/smoke.test.ts`** — a trivial test importing `VERSION` so `pnpm test`
   has something green to run.
9. **`LICENSE`** — MIT, `Copyright (c) 2026 Lucas Guedes`.
10. **`README.md`** — skeleton: name, one-line pitch, install-from-GitHub
    snippet (`pnpm add github:lukasedw/bobina`), a "Status: alpha" note, and a
    placeholder API section (filled in Phase 6).
11. **`.gitignore`** — ensure `dist/`, `node_modules/`, `*.log`, `.DS_Store`,
    coverage output are ignored. Keep existing entries.
12. **`.github/workflows/ci.yml`** — on push/PR: pnpm install, `pnpm lint`,
    `pnpm exec tsc --noEmit`, `pnpm test`, `pnpm build`. Matrix Node 20 & 22.

## Validation (must pass)

```bash
pnpm install
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build
```

`pnpm build` must emit `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`.

## Done criteria

- All five validation commands green.
- `dist/` produced with ESM + CJS + types.
- No `any`, no `@ts-ignore` anywhere.
