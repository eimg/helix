import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubPollTrigger, FakeIssueLister } from "../src/triggers/github-poll.js";
import type { Issue } from "../src/engine/types.js";

const issue = (n: number): Issue => ({
  source: "github",
  repo: "acme/widget",
  number: n,
  title: `Issue ${n}`,
  body: "",
  url: `https://github.com/acme/widget/issues/${n}`,
  labels: ["helix"],
});

test("poll: invokes handler for new labeled issues once", async () => {
  const seen: Issue[] = [];
  const poll = new GitHubPollTrigger({
    repo: "acme/widget",
    labelFilter: "helix",
    lister: new FakeIssueLister([issue(1), issue(2)]),
    onIssue: async (i) => {
      seen.push(i);
    },
  });

  const first = await poll.tick();
  assert.equal(first.length, 2);
  assert.equal(seen.length, 2);

  const second = await poll.tick();
  assert.equal(second.length, 0);
  assert.equal(seen.length, 2);
});

test("poll: filters by label via lister", async () => {
  const seen: number[] = [];
  const poll = new GitHubPollTrigger({
    repo: "acme/widget",
    labelFilter: "helix",
    lister: new FakeIssueLister([
      issue(1),
      { ...issue(2), labels: [] },
    ]),
    onIssue: async (i) => {
      seen.push(i.number!);
    },
  });

  await poll.tick();
  assert.deepEqual(seen, [1]);
});
