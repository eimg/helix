# Laravel React Project Skill

Reference skill for a Laravel application with a React frontend (standalone, not via Inertia). The Verifier uses these gates. Inherits all Laravel conventions.

## Build

```bash
npm run build
```

## Lint (optional)

```bash
npm run lint
```

Skip if no `lint` script exists.

## Tests

```bash
php artisan test
```

## Client-side unit tests (optional)

```bash
npx vitest run
```

Skip if `vitest` is not in `devDependencies`.

## Conventions

- **Components** — in `resources/js/Components/`. One file per component, PascalCase filename (e.g. `UserAvatar.tsx`). Functional components with hooks; class components are legacy.
- **Pages** — in `resources/js/Pages/` when using React Router for SPA mode. Each page is a routed component. For embedded mode, components are rendered on a DOM element via `createRoot()`.
- **Routing** — React Router v6+ in `resources/js/router/` for SPA. Inertia-style page mapping but managed client-side. Use `createBrowserRouter` for nested layouts.
- **State** — Choose based on complexity: React Context for simple shared state, Zustand or Pinia for medium complexity, TanStack Query (`@tanstack/react-query`) for server state. Avoid plain Redux unless the app is very large.
- **Build** — Vite with `@vitejs/plugin-react` (`@vitejs/plugin-react-swc` for faster builds) in `vite.config.js`. `resources/js/app.tsx` is the entry point.
- **Forms** — Axios `POST`/`PUT`/`PATCH` to Laravel API routes. Validation errors returned as JSON with `422` status. Use React Hook Form (`react-hook-form`) for complex forms with Zod (`zod`) schema validation.
- **API communication** — Axios instance in `resources/js/axios.ts` with `X-Requested-With: XMLHttpRequest` and `Accept: application/json` headers. CSRF token from `<meta name="csrf-token">`.
- **TypeScript** — all components use `.tsx`. Define prop types with `interface ComponentProps` or `type`. Use `React.FC<ComponentProps>` or inline destructured props with type annotation.
- **Testing (client)** — Vitest with `@testing-library/react`. Render with `render()`, query with `screen.getByText/Role/...`, assert with `expect(screen.getByText(...)).toBeInTheDocument()`.
- **Authentication** — Laravel Sanctum or Jetstream. `axios.get('/api/user')` to fetch the authenticated user; store in a Zustand store or React Context.
- **Coding style** — PSR-12 for PHP. React: functional components with hooks, early returns for loading/error states, custom hooks extract reusable stateful logic, `useEffect` cleanup always, TypeScript strict mode enabled, no legacy lifecycle methods.
