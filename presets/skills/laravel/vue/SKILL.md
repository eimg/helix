# Laravel Vue Project Skill

Reference skill for a Laravel application with a Vue frontend (standalone, not via Inertia). The Verifier uses these gates. Inherits all Laravel conventions.

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

- **Components** — in `resources/js/Components/`. One file per component, PascalCase filename matching the component name (e.g. `UserAvatar.vue`). Composition API with `<script setup lang="ts">` is the default.
- **Pages** — in `resources/js/Pages/` when using Vue Router for SPA mode. Each page is a routed component. For embedded mode, components are called directly in Blade via `<x-app>` or mounted on a DOM element.
- **Routing** — Vue Router in `resources/js/router/` for SPA applications. Inertia-style route-to-page mapping, but managed client-side. For embedded mode, no Vue Router — each Blade view mounts its own Vue instance.
- **State** — Pinia stores in `resources/js/stores/`. Prefer composition stores (`defineStore` with `setup()` function) over options stores. Server state fetched via Axios; cache with TanStack Query (`@tanstack/vue-query`) for data-heavy views.
- **Build** — Vite with `@vitejs/plugin-vue` in `vite.config.js`. `@vitejs/plugin-vue-jsx` only if JSX is used. `resources/js/app.js` (or `.ts`) is the entry point.
- **Forms** — Axios `POST`/`PUT`/`PATCH` to Laravel API routes. Validation errors returned as JSON with `422` status. Display errors per-field using a shared `<InputError>` component.
- **API communication** — Axios instance in `resources/js/axios.js` with `X-Requested-With: XMLHttpRequest` and `Accept: application/json` headers. CSRF token from `<meta name="csrf-token">`.
- **TypeScript** — all components use `<script setup lang="ts">`. Define prop types with `defineProps<{ ... }>()`. Emit types with `defineEmits<{ ... }>()`.
- **Testing (client)** — Vitest with `@vue/test-utils`. Mount components with `mount()` or `shallowMount()`. Pinia stores tested via `createTestingPinia()`.
- **Authentication** — Laravel Sanctum or Jetstream. `axios.get('/api/user')` to fetch the authenticated user; store in a Pinia `useAuthStore`.
- **Coding style** — PSR-12 for PHP. Vue: Composition API with `<script setup>`, single-word component tags in templates (`<UserAvatar />` not `<user-avatar />`), scoped styles with `<style scoped lang="scss">` where Sassy CSS is needed.
