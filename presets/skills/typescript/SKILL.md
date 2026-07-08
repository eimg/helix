# TypeScript Project Skill

Reference skill for a generic TypeScript project. The Verifier uses these gates.

## Build / typecheck

```bash
npx tsc --noEmit
```

## Tests

```bash
npm test
```

If the project uses a specific runner (vitest, jest, node --test), prefer the script in `package.json` `test`.

## Lint

```bash
npm run lint
```

Skip if no `lint` script exists.

## Conventions

- Prefer narrow types; avoid `any`.
- Keep functions pure where practical; side effects belong at the edges.
- One concern per file.
