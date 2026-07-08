/** Fake provider for tests. Resolves any model id to a stub. */
import type { Provider } from "../engine/types.js";

export class FakeProvider implements Provider {
  name = "fake";
  resolveModel = async () => ({ id: "fake-model", provider: "fake" });
}
