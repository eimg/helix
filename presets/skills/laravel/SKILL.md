# Laravel Project Skill

Reference skill for a Laravel application. The Verifier uses these gates.

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

Migrates the testing database and runs PHPUnit. If the test DB requires extra setup, check `phpunit.xml` for environment variables.

## Route sanity

```bash
php artisan route:list --except-vendor
```

Confirm public routes are registered, named, and point to the right controllers. Not required for every change — skip if routes are untouched.

## Conventions

- **Models** — extend `Illuminate\Database\Eloquent\Model`; use type hints on relationships (`HasMany<Post>` docblocks); keep Eloquent scopes in the model, filters in a dedicated query builder class.
- **Controllers** — thin; one responsibility per controller resource. Form requests (`php artisan make:request`) sit in `App\Http\Requests` and own all validation + authorization.
- **Actions / Jobs** — single-action classes in `App\Actions` or `App\Jobs`. Name reflects the action (e.g. `HandleSubscriptionRenewal`). Invokable controllers are also acceptable for simple endpoints.
- **Validation** — always delegate to Form Request classes; never inline `$request->validate()` in controllers.
- **Routes** — file-based (`routes/web.php`, `routes/api.php`); prefer `Route::resource()` for standard CRUD, explicit `Route::get/post()` for custom endpoints. Use route names and `route()` helper.
- **Blade** — components go in `resources/views/components/`; use `Illuminate\View\Component` classes with `render()` returning a Blade view. Minimise raw `<?php` in templates.
- **Migrations** — irreversible migrations must include a `down()` method (unless destructive). Every column change gets its own migration; never squash migrations shared on a team branch.
- **Factories & Seeders** — `Database\Factories\` for fake data; `Database\Seeders\` for real reference data. Never seed in migrations.
- **Service providers** — register bindings, events, and singletons; put behaviour in stand-alone classes, not closures in `boot()`.
- **Coding style** — PSR-12 as enforced by Laravel Pint. `php artisan pint` before commit.
