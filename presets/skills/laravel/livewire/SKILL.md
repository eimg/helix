# Livewire Project Skill

Reference skill for a Laravel Livewire application (class-based components + Volt). The Verifier uses these gates. Inherits all Laravel conventions — this file covers the differences.

## Static analysis / lint

```bash
composer run lint
```

Falls back to `vendor/bin/pint --test` if no `lint` script exists. Skip if neither is available.

## Type analysis (optional)

```bash
vendor/bin/phpstan analyse
```

Skip if phpstan is not installed.

## Tests

```bash
php artisan test
```

## Component sanity

```bash
ls app/Livewire/ 2>/dev/null && ls app/Livewire/Volt/ 2>/dev/null; true
```

Quick check that expected component directories exist. Not required for every change.

## Conventions

- **Components** — full-page components live in `app/Livewire/` (one per route). Inline (child) components also in `app/Livewire/` but rendered via `<livewire:name>` in Blade. Volt single-file components (`app/Livewire/Volt/`) are preferred for simple UI islands.
- **Properties** — always `public` and typed (e.g. `public string $name`). Validated in `rules()` method or inline with `#[Rule]` attribute on the property.
- **Actions** — public methods on the component class. Use `#[Computed]` for computed properties, `#[On]` for event listeners, `#[Reactive]` to react to parent updates, `#[Locked]` for immutable properties after mount.
- **Wire directives** — `wire:model` for two-way binding (use `.live` or `.blur` modifiers intentionally), `wire:submit` on forms, `wire:click` for actions, `wire:key` on `@foreach` / `@for` / `@php` loops (always — without it Livewire breaks list diffing).
- **Navigation** — `wire:navigate` on anchor tags for SPA-like page transitions. Use `wire:navigate.hover` for prefetch. Full-page components don't need full-page reloads.
- **Events** — dispatch from Blade via `$dispatch('event', { data })`, from PHP via `$this->dispatch('event', data)`. Listen with `#[On('event')]` attribute or `$wire.on()` in Alpine.
- **Alpine.js** — `x-data`, `x-show`, `x-on` for client-side interactions that don't need a server round-trip. Never duplicate Livewire state in Alpine — use `$wire` magic to access component properties and methods.
- **Views** — component views live in `resources/views/livewire/` and match the component class name converted to kebab-case (e.g. `app/Livewire/UserProfile.php` → `resources/views/livewire/user-profile.blade.php`). Volt components carry their own template inside the `<?php ?>` block.
- **Testing** — `Livewire::test(ComponentClass::class)` for unit/interaction tests. Use fluent assertions like `->assertSet()`, `->assertSee()`, `->call()`, `->assertDispatched()`. For Volt: `Livewire::test(VoltComponent::class)` works the same way.
- **Validation** — call `$this->validate()` in actions, or rely on `#[Rule]` attributes. Error messages render via `@error` directives in the Blade view.
- **Coding style** — PSR-12 via Laravel Pint plus Livewire community conventions: component methods return `void` or simply terminate; render methods return a view. Keep component classes under 200 lines — extract children if they grow.
