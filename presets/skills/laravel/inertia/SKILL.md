# Laravel Inertia Project Skill

Reference skill for a Laravel application using Inertia.js (Vue, React, or Svelte adapter). The Verifier uses these gates. Inherits all Laravel conventions — this file covers the Inertia-specific differences.

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

## Conventions

- **Pages** — one file per route in `resources/js/Pages/`. Name matches the server-side render call: `inertia()->render('Users/Index', ...)` → `resources/js/Pages/Users/Index.vue` (or `.jsx`/`.svelte`).
- **Layouts** — persistent default layout via `createInertiaApp` + `resolvePageComponent`. Use `page.component.layout` for per-page overrides.
- **Server-side rendering** — controllers return `inertia()->render('PageName', $props)`. Never return a Blade view for Inertia-powered routes. Shared data belongs in `HandleInertiaRequests` middleware.
- **Forms** — `useForm({ field: initial })` for form state, validation errors, and submission. Never use `$wire` or Alpine — Inertia manages form state via `post`, `put`, `patch`, `delete` on the `InertiaForm` instance.
- **Props** — access via `usePage().props` (Vue: `page.props` from `usePage()`, React: `usePage().props`, Svelte: `$page.props`). Keep props flat; avoid deeply nested objects.
- **Navigation** — `<Link href="...">` for client-side visits (Vue: `InertiaLink`, React: `Link`, Svelte: `InertiaLink`). Use `@inertiajs/inertia` `visit()` for programmatic navigation.
- **TypeScript** — type shared props via `PageProps` declaration merging in `resources/js/types/`. Type page-specific props with an interface near the page component.
- **Testing** — `$this->assertInertia(fn($page) => ...)` via the Inertia testing package for server-side assertions. Client-side: Cypress or Playwright with route assertions.
- **Forms & validation** — Laravel validation errors flow as `$errors` prop automatically. Display in-page via `<p v-if="form.errors.field">` / `{form.errors.field}`.
- **Flash messages** — pass via shared props (e.g. `flash.notice`). Display in a persistent notification component.
- **Coding style** — PSR-12 for PHP, per-adapter conventions for JS (Vue: Composition API `<script setup>`, React: hooks + functional components, Svelte: `<script lang="ts">`). No Inertia-specific tooling beyond what `@inertiajs/inertia` ships.
