# Express Project Skill

Reference skill for an Express API project. The Verifier uses these gates.

## Typecheck / build

```bash
npx tsc --noEmit
```

## Tests (supertest-based)

```bash
npm test
```

## Lint

```bash
npm run lint
```

## Conventions

- Routes in `src/routes/`; handlers thin — delegate to services.
- Validate input at the boundary (zod / valibot).
- Errors flow through a single error-handling middleware; never swallow.
