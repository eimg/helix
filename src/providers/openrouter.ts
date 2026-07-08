/**
 * OpenRouter LLM provider — the only provider for v1.
 *
 * Wraps pi's AuthStorage + ModelRegistry, pointed at OpenRouter. A model is
 * referenced in Helix config as `provider/modelId`, where modelId may itself
 * contain slashes (OpenRouter ids look like `anthropic/claude-sonnet-4`).
 *
 * The same AuthStorage/ModelRegistry instance is shared by the specialist
 * session factory and the LLM orchestrator driver, so every in-process pi
 * session in a run shares one credential/config source.
 */
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Provider } from "../engine/types.js";

/** A Provider backed by pi's AuthStorage + ModelRegistry. */
export interface PiProvider extends Provider {
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  resolveModel(modelRef: string): Promise<Model<Api>>;
}

export interface OpenRouterProviderOptions {
  /** Env var name holding the OpenRouter API key. Default OPENROUTER_API_KEY. */
  apiKeyEnv?: string;
  /** Override the auth.json path (tests / custom layouts). */
  authFilePath?: string;
}

export class OpenRouterProvider implements PiProvider {
  readonly name = "openrouter";
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;
  private readonly apiKeyEnv: string;

  constructor(opts: OpenRouterProviderOptions = {}) {
    this.apiKeyEnv = opts.apiKeyEnv ?? "OPENROUTER_API_KEY";
    this.authStorage = opts.authFilePath ? AuthStorage.create(opts.authFilePath) : AuthStorage.create();
    this.modelRegistry = ModelRegistry.create(this.authStorage);

    const key = process.env[this.apiKeyEnv];
    if (key) {
      // Runtime override (not persisted). Wins over auth.json + env auto-resolution.
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

  /** True if an OpenRouter API key is available (env or auth.json). */
  hasAuth(): boolean {
    return Boolean(process.env[this.apiKeyEnv]) || this.modelRegistry.getProviderAuthStatus("openrouter").configured;
  }
}
