/** Fake provider for tests. Resolves any model id to a stub. */
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { PiProvider } from "./openrouter.js";

export class FakeProvider implements PiProvider {
  name = "fake";
  readonly authStorage: AuthStorage;
  readonly modelRegistry: ModelRegistry;

  constructor() {
    this.authStorage = AuthStorage.inMemory();
    this.modelRegistry = ModelRegistry.inMemory(this.authStorage);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async resolveModel(_modelRef: string): Promise<Model<Api>> {
    return { id: "fake-model", provider: "fake" } as unknown as Model<Api>;
  }

  hasAuth(): boolean {
    return true;
  }
}
