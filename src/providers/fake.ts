/** Fake provider for tests. Resolves any model id to a stub. */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { PiProvider } from "./openrouter.js";

export class FakeProvider implements PiProvider {
  name = "fake";
  private runtime: Promise<ModelRuntime> | undefined;

  /**
   * Built lazily so the common case — tests that inject stub sessions — never
   * constructs a runtime at all. Fully in-memory and offline when it is.
   */
  modelRuntime(): Promise<ModelRuntime> {
    this.runtime ??= ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStore: new InMemoryModelsStore(),
    });
    return this.runtime;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async resolveModel(_modelRef: string): Promise<Model<Api>> {
    return { id: "fake-model", provider: "fake" } as unknown as Model<Api>;
  }

  async hasAuth(): Promise<boolean> {
    return true;
  }
}
