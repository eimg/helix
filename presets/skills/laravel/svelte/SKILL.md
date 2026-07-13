# Laravel Svelte Project Skill

Reference skill for a Laravel application with a Svelte frontend (standalone, not via Inertia). The Verifier uses these gates. Inherits all Laravel conventions.

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

- **Components** — in `resources/js/Components/`. One `.svelte` file per component, PascalCase filename (e.g. `UserAvatar.svelte`). Single-file components with `<script>`, template, and `<style>` in one file.
- **Pages** — in `resources/js/Pages/` when using a client-side router (e.g. `svelte-spa-router` or `@sveltejs/kit`). For embedded mode, each Blade view mounts a Svelte component via `new Component({ target })`.
- **State** — Svelte stores (`writable`, `derived`, `readable`) in `resources/js/stores/`. Use `$store` auto-subscription syntax in templates. For server state, fetch via Axios and write to stores.
- **Build** — Vite with `@sveltejs/vite-plugin-svelte` in `vite.config.js`. `resources/js/app.js` (or `.ts`) is the entry point that imports and mounts the root component.
- **Forms** — Axios `POST`/`PUT`/`PATCH` to Laravel API routes. Validation errors returned as JSON with `422` status. Bind form inputs with `bind:value`. Show per-field errors with `{#if errors.field}` blocks.
- **API communication** — Axios instance in `resources/js/axios.js` with `X-Requested-With: XMLHttpRequest` and `Accept: application/json` headers. CSRF token from `<meta name="csrf-token">`.
- **TypeScript** — use `<script lang="ts">` in `.svelte` files. Define component props with `export let propName: Type`. Use `interface` for complex data shapes. Generate `svelte-check` for type checking.
- **Reactivity** — prefer Svelte's built-in reactivity (`$:` statements, `$store` auto-subscription) over manual subscriptions. Use `onMount`/`onDestroy` for lifecycle side effects. Avoid imperative DOM manipulation — Svelte's reactive bindings cover most cases.
- **Testing (client)** — Vitest with `@testing-library/svelte`. Render with `render(Component, { props })`, query with `screen.getByText`, test reactivity with `fireEvent`.
- **Authentication** — Laravel Sanctum or Jetstream. `axios.get('/api/user')` to fetch the authenticated user; store in a Svelte writable store.
- **Coding style** — PSR-12 for PHP. Svelte: `<script lang="ts">` for logic, template for markup, `<style scoped>` for styles. Destructure event handlers (`on:click={handler}` not `on:click={() => handler()}` ideally). Use `{#each}` with `{:else}`, `{#if}` with `{:else if}` `{:else}`. Minimal `<style>` — prefer scoped Tailwind utility classes.
