import assert from "node:assert/strict";
import { it } from "node:test";
import { createSteeringNotifier, type SteeringNotification } from "../src/steering.js";

const notification: SteeringNotification = {
  schemaVersion: "acme.steering.notification.v1",
  id: "helix:test:1",
  source: { product: "helix", resourceType: "test", resourceId: "1", revision: "1" },
  event: { type: "test.changed", occurredAt: "2026-08-03T00:00:00.000Z", summary: "Changed" },
};

it("Steering notification is optional and binds its token to a trusted origin", async () => {
  const calls: RequestInit[] = [];
  const fetchFn = async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response("{}", { status: 202 });
  };
  createSteeringNotifier(fetchFn, undefined, "secret", "http://127.0.0.1:8323")(notification);
  createSteeringNotifier(fetchFn, "http://127.0.0.1:8323", "secret", "http://127.0.0.1:8323")(notification);
  createSteeringNotifier(fetchFn, "http://127.0.0.1:8323", "secret", "http://127.0.0.1:9999")(notification);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal((calls[0].headers as Record<string, string>).authorization, "Bearer secret");
  assert.equal((calls[1].headers as Record<string, string>).authorization, undefined);
});
