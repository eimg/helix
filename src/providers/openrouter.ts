/**
 * OpenRouter LLM provider — the only provider for v1.
 *
 * Wraps pi's `ModelRuntime`, pointed at OpenRouter. A model is referenced in
 * Helix as `provider/modelId`, where modelId may itself contain slashes
 * (OpenRouter ids look like `anthropic/claude-sonnet-4`).
 *
 * Essentials resolve in two steps:
 *   1. env / `.helix/.env` (`OPENROUTER_API_KEY`) — always wins
 *   2. `~/.pi/agent/auth.json` + `models.json` — operator's global pi install
 *
 * There is no Helix-owned `~/.helix/` secrets/models home. Repo-root `.env` is
 * for the application, not Helix.
 *
 * The runtime is built lazily and once: `ModelRuntime.create()` is async, while
 * providers are constructed synchronously all over the CLI, server, and tests.
 * Callers that never open a pi session never pay for it.
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore, type Api, type Model } from "@earendil-works/pi-ai";
import type { Provider } from "../engine/types.js";
import { OPENROUTER_API_KEY_ENV } from "../config/defaults.js";
import { resolveModelsFile, resolvePaths, type PathResolution } from "../config/paths.js";

/** A Provider backed by pi's ModelRuntime. */
export interface PiProvider extends Provider {
  /** Canonical pi model/auth runtime, created on first use and then reused. */
  modelRuntime(): Promise<ModelRuntime>;
  resolveModel(modelRef: string): Promise<Model<Api>>;
  hasAuth(): Promise<boolean>;
}

export interface OpenRouterProviderOptions {
  /** Inject for tests; otherwise resolved from the filesystem. */
  paths?: PathResolution;
}

export class OpenRouterProvider implements PiProvider {
  readonly name = "openrouter";
  private readonly apiKeyEnv = OPENROUTER_API_KEY_ENV;
  private readonly paths: PathResolution | undefined;
  private runtime: Promise<ModelRuntime> | undefined;

  constructor(opts: OpenRouterProviderOptions = {}) {
    this.paths = opts.paths;
  }

  modelRuntime(): Promise<ModelRuntime> {
    this.runtime ??= this.createRuntime();
    return this.runtime;
  }

  private async createRuntime(): Promise<ModelRuntime> {
    const paths = this.paths ?? resolvePaths();
    const runtime = await ModelRuntime.create({
      authPath: paths.piAuthFile,
      // `null` keeps model resolution on pi's built-in catalogs when the
      // operator has no models.json.
      modelsPath: resolveModelsFile(paths) ?? null,
      // Helix reads pi essentials but never writes into `~/.pi/agent/`, so the
      // dynamic catalog overlay stays process-local.
      modelsStore: new InMemoryModelsStore(),
    });

    const key = process.env[this.apiKeyEnv];
    if (key) {
      // Runtime override (not persisted). Wins over auth.json.
      await runtime.setRuntimeApiKey("openrouter", key, { allowNetwork: false });
    }
    return runtime;
  }

  /**
   * Resolve `provider/modelId` (split on the FIRST slash) to a pi Model.
   * Throws if the model is unknown to the runtime.
   */
  async resolveModel(modelRef: string): Promise<Model<Api>> {
    const runtime = await this.modelRuntime();
    const slash = modelRef.indexOf("/");
    if (slash <= 0) {
      // Bare id: assume OpenRouter.
      const m = runtime.getModel("openrouter", modelRef);
      if (!m) throw new Error(`Unknown model: ${modelRef}`);
      return m;
    }
    const provider = modelRef.slice(0, slash);
    const modelId = modelRef.slice(slash + 1);
    const m = runtime.getModel(provider, modelId);
    if (!m) throw new Error(`Unknown model: ${modelRef} (provider=${provider}, id=${modelId})`);
    return m;
  }

  /** True if an OpenRouter API key is available (env or pi auth). */
  async hasAuth(): Promise<boolean> {
    if (process.env[this.apiKeyEnv]) return true;
    const runtime = await this.modelRuntime();
    return runtime.getProviderAuthStatus("openrouter").configured;
  }
}
