# React Native Project Skill

Reference skill for a bare React Native project. The Verifier uses these gates.

## Typecheck

```bash
npx tsc --noEmit
```

## Lint

```bash
npm run lint
```

## Tests

```bash
npm test
```

## Build (Android / iOS)

Builds are expensive and platform-specific; run only when the change touches native or platform code:

```bash
# Android
cd android && ./gradlew assembleDebug

# iOS
cd ios && xcodebuild -workspace App.xcworkspace -scheme App -sdk iphonesimulator
```

## Conventions

- Keep platform-specific files (`*.ios.tsx` / `*.android.tsx`) only when truly divergent.
- Avoid the main thread for heavy work.
