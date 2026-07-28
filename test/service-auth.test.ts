import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceAuthHeader } from "../src/integrations/serviceAuth.js";

const options = {
  configuredOrigins: ["http://127.0.0.1:8320"],
  defaultOrigin: "http://127.0.0.1:8320",
  tokenName: "HELIX_ISSUES_TOKEN",
};

test("service auth is attached only to a trusted destination origin", () => {
  assert.deepEqual(
    serviceAuthHeader("http://127.0.0.1:8320/api/webhooks/helix", "svc_secret", options),
    { Authorization: "Bearer svc_secret" },
  );
  assert.throws(
    () => serviceAuthHeader("https://attacker.example/api/webhooks/helix", "svc_secret", options),
    /untrusted origin/,
  );
});

test("an uncredentialed replaceable integration remains independent", () => {
  assert.deepEqual(
    serviceAuthHeader("https://replaceable.example/api", undefined, options),
    {},
  );
});
