/**
 * OpenRouter LLM provider — the only provider for v1.
 *
 * Wraps pi's AuthStorage + ModelRegistry, pointed at OpenRouter. A model is
 * referenced in Helix as `provider/modelId`, where modelId may itself contain
 * slashes (OpenRouter ids look like `anthropic/claude-sonnet-4`).
 *
 * Essentials resolve in two steps:
 *   1. env / project `.env` (`OPENROUTER_API_KEY`) — always wins
 *   2. `~/.pi/agent/auth.json` + `models.json` — operator's global pi install
 *
 * There is no Helix-owned `~/.helix/` secrets/models home.
 */
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Provider } from "../engine/types.js";
import { OPENROUTER_API_KEY_ENV } from "../config/defaults.js";
import { resolveAuthFile, resolveModelsFile, type PathResolution } from "../config/paths.js";

/** A Provider backed by pi's AuthStorage + ModelRegistry. */
export interface PiProvider extends Provider {
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  resolveModel(modelRef: string): Promise<Model<Api>>;
  hasAuth(): boolean;
}

export interface OpenRouterProviderOptions {
  /** Inject for tests; otherwise resolved from the filesystem. */
  paths?: PathResolution;
}

export class OpenRouterProvider implements PiProvider {
  readonly name = "openrouter";
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  private readonly apiKeyEnv = OPENROUTER_API_KEY_ENV;

  constructor(opts: OpenRouterProviderOptions = {}) {
    const authFile = resolveAuthFile(opts.paths);
    this.authStorage = authFile ? AuthStorage.create(authFile) : AuthStorage.create();

    const modelsFile = resolveModelsFile(opts.paths);
    this.modelRegistry = modelsFile
      ? ModelRegistry.create(this.authStorage, modelsFile)
      : ModelRegistry.create(this.authStorage);

    const key = process.env[this.apiKeyEnv];
    if (key) {
      // Runtime override (not persisted). Wins over auth.json.
      this.authStorage.setRuntimeApiKey("openrouter", key);
    }
  }

  /**
   * Resolve `provider/modelId` (split on the FIRST slash) to a pi Model.
   * Throws if the model is unknown to the registry.
   */
  async resolveModel(modelRef: string): Promise<Model<Api>> {
    const slash = modelRef.indexOf("/");
    if (slash <= 0) {
      // Bare id: assume OpenRouter.
      const m = this.modelRegistry.find("openrouter", modelRef);
      if (!m) throw new Error(`Unknown model: ${modelRef}`);
      return m;
    }
    const provider = modelRef.slice(0, slash);
    const modelId = modelRef.slice(slash + 1);
    const m = this.modelRegistry.find(provider, modelId);
    if (!m) throw new Error(`Unknown model: ${modelRef} (provider=${provider}, id=${modelId})`);
    return m;
  }

  /** True if an OpenRouter API key is available (env or pi auth). */
  hasAuth(): boolean {
    return Boolean(process.env[this.apiKeyEnv]) || this.modelRegistry.getProviderAuthStatus("openrouter").configured;
  }
}
