# Expo Project Skill

Reference skill for an Expo Router project. The Verifier uses these gates.

## Lint

```bash
npx expo lint
```

## Typecheck

```bash
npx tsc --noEmit
```

## Tests

```bash
npm test
```

## Build

Expo builds are cloud/platform-specific; run only when needed:

```bash
npx expo prebuild
```

## Conventions

- Use Expo Router file-based routing; `app/` directory is the source of truth.
- Prefer Expo SDK modules over bare RN packages.
- Keep platform divergence in `app/` via file extensions only when necessary.
