import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENROUTER_API_KEY_ENV } from "../src/config/defaults.js";
import { OpenRouterProvider } from "../src/providers/openrouter.js";
import { FakeProvider } from "../src/providers/fake.js";

/** An empty pi agent dir: no auth.json, no models.json. */
function emptyPiPaths(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `helix-provider-${label}-`));
  return {
    dir,
    paths: {
      piAuthFile: join(dir, "auth.json"),
      piModelsFile: join(dir, "models.json"),
      piAgentDir: dir,
    },
  };
}

async function withoutApiKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env[OPENROUTER_API_KEY_ENV];
  delete process.env[OPENROUTER_API_KEY_ENV];
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[OPENROUTER_API_KEY_ENV];
    else process.env[OPENROUTER_API_KEY_ENV] = prev;
  }
}

test("OpenRouterProvider resolves built-in models without auth or models.json", async () => {
  await withoutApiKey(async () => {
    const { paths } = emptyPiPaths("builtin");
    const provider = new OpenRouterProvider({ paths });
    const runtime = await provider.modelRuntime();

    const catalog = runtime.getModels("openrouter");
    assert.ok(catalog.length > 0, "pi ships a built-in OpenRouter catalog");

    // OpenRouter ids contain slashes; the ref splits on the FIRST slash only.
    const withSlash = catalog.find((model) => model.id.includes("/"));
    assert.ok(withSlash, "expected a provider-qualified OpenRouter model id");
    const resolved = await provider.resolveModel(`openrouter/${withSlash.id}`);
    assert.equal(resolved.id, withSlash.id);
    assert.equal(resolved.provider, "openrouter");
  });
});

test("OpenRouterProvider reuses one runtime and rejects unknown models", async () => {
  await withoutApiKey(async () => {
    const { paths } = emptyPiPaths("reuse");
    const provider = new OpenRouterProvider({ paths });

    const first = await provider.modelRuntime();
    const second = await provider.modelRuntime();
    assert.equal(first, second, "the runtime is built once and reused");

    await assert.rejects(
      () => provider.resolveModel("openrouter/definitely/not-a-real-model"),
      /Unknown model/,
    );
  });
});

test("OpenRouterProvider auth: env key wins, no key means unconfigured", async () => {
  const { paths } = emptyPiPaths("auth");

  await withoutApiKey(async () => {
    const provider = new OpenRouterProvider({ paths });
    assert.equal(await provider.hasAuth(), false);
    assert.equal((await provider.modelRuntime()).getProviderAuthStatus("openrouter").configured, false);
  });

  const prev = process.env[OPENROUTER_API_KEY_ENV];
  process.env[OPENROUTER_API_KEY_ENV] = "sk-helix-test-key";
  try {
    const provider = new OpenRouterProvider({ paths });
    assert.equal(await provider.hasAuth(), true);
    const status = (await provider.modelRuntime()).getProviderAuthStatus("openrouter");
    assert.equal(status.configured, true);
    // Runtime override, never persisted to auth.json.
    assert.equal(status.source, "runtime");
  } finally {
    if (prev === undefined) delete process.env[OPENROUTER_API_KEY_ENV];
    else process.env[OPENROUTER_API_KEY_ENV] = prev;
  }
});

test("OpenRouterProvider keeps the dynamic model catalog out of the pi agent dir", async () => {
  const { dir, paths } = emptyPiPaths("catalog");
  const prev = process.env[OPENROUTER_API_KEY_ENV];
  process.env[OPENROUTER_API_KEY_ENV] = "sk-helix-test-key";
  try {
    const provider = new OpenRouterProvider({ paths });
    await provider.modelRuntime();
    await provider.hasAuth();

    // pi touches auth.json itself, but Helix reads essentials without adding a
    // models-store.json overlay to the operator's global pi install.
    assert.deepEqual(readdirSync(dir), ["auth.json"]);
    assert.equal(readFileSync(paths.piAuthFile, "utf8").includes("sk-helix-test-key"), false);
  } finally {
    if (prev === undefined) delete process.env[OPENROUTER_API_KEY_ENV];
    else process.env[OPENROUTER_API_KEY_ENV] = prev;
  }
});

test("FakeProvider exposes an in-memory runtime and stub models", async () => {
  const provider = new FakeProvider();
  assert.equal(await provider.hasAuth(), true);

  const runtime = await provider.modelRuntime();
  assert.equal(runtime, await provider.modelRuntime());
  assert.ok(runtime.getProviders().length > 0);

  const model = await provider.resolveModel("anything/at-all");
  assert.equal(model.provider, "fake");
});
