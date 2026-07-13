# PHP Project Skill

Reference skill for a generic PHP project. The Verifier uses these gates.

## Syntax check

```bash
php -l
```

## Tests

```bash
vendor/bin/phpunit
```

If the project uses a different runner (pest, simpletest), prefer the script in `composer.json` `test`.

## Static analysis (optional)

```bash
vendor/bin/phpstan analyse
```

Skip if phpstan is not installed.

## Conventions

- PSR-12 coding style.
- Type declarations on all function/method parameters and return types.
- One class per file; filename matches class name (PSR-4).
- Dependency injection over static singletons.
