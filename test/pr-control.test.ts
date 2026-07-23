import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { resolve } from "node:path";
import { PullRequestControlService } from "../src/pr-control/service.js";
import { MemoryPullRequestReviewStore } from "../src/pr-control/store.js";
import type {
  PreparedPullRequestWorkspace,
  PullRequestWorkspace,
} from "../src/pr-control/workspace.js";
import type { PullRequestReviewRequest } from "../src/pr-control/types.js";
import { loadSpecialists } from "../src/agents/loader.js";
import { StubSpecialistFactory } from "../src/agents/stubSession.js";
import { createApp } from "../src/server/app.js";
import { createRunContext } from "../src/run/bootstrap.js";
import { MemoryRunStore } from "../src/state/runStore.js";
import { FakeProvider } from "../src/providers/fake.js";

const fixtureDir = resolve("examples/ts/.helix");
const definitions = loadSpecialists(resolve(fixtureDir, "pr-agents"));

class FakeWorkspace implements PullRequestWorkspace {
  cleaned = false;
  async prepare(input: {
    repositoryPath: string;
    baseSha: string;
    headSha: string;
  }): Promise<PreparedPullRequestWorkspace> {
    return {
      cwd: input.repositoryPath,
      baseSha: input.baseSha,
      headSha: input.headSha,
      mergeable: true,
      mergeSummary: "clean",
      cleanup: async () => {
        this.cleaned = true;
      },
    };
  }
}

function reviewRequest(): PullRequestReviewRequest {
  return {
    pullRequest: {
      id: 9,
      title: "Fix login",
      description: "Reject empty passwords",
      repositoryPath: "/tmp/repo",
      baseBranch: "main",
      baseSha: "base-sha",
      headBranch: "fix/login",
      headSha: "head-sha",
      author: "helix",
      origin: "helix",
      issue: { id: 7, title: "Login failure", body: "Empty passwords return 500" },
    },
    callback: { trackerUrl: "http://issues.test", pullRequestId: 9 },
    externalEventId: "pull-request:9:head:head-sha",
  };
}

function report(verdict: "pass" | "fail", specialist: string): string {
  return JSON.stringify({
    verdict,
    summary: `${specialist} ${verdict}`,
    findings: verdict === "fail"
      ? [{ severity: "blocking", title: "Regression", details: "Observed a broken edge case" }]
      : [],
    checks: specialist === "verifier"
      ? [{ name: "npm test", status: verdict === "pass" ? "passed" : "failed", summary: verdict }]
      : [],
  });
}

test("PR control runs independent reviewer and verifier and marks exact SHA ready", async () => {
  const store = new MemoryPullRequestReviewStore();
  const workspace = new FakeWorkspace();
  const callbacks: unknown[] = [];
  const service = new PullRequestControlService({
    store,
    workspace,
    specialists: definitions,
    createSessionFactory: () => new StubSpecialistFactory(definitions, {
      reviewer: report("pass", "reviewer"),
      verifier: report("pass", "verifier"),
    }),
    fetchFn: async (_url, init) => {
      callbacks.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    },
  });

  const started = service.start(reviewRequest());
  assert.equal(started.duplicate, false);
  const completed = await started.promise;
  assert.equal(completed.status, "completed");
  assert.equal(completed.decision, "ready_to_merge");
  assert.deepEqual(completed.reports.map((item) => item.specialist).sort(), ["reviewer", "verifier"]);
  assert.equal(completed.checks[0]?.name, "npm test");
  assert.equal(workspace.cleaned, true);
  assert.equal(callbacks.length, 2);
  assert.equal(completed.events[0]?.type, "review_started");
  assert.ok(completed.events.some((event) => event.type === "workspace_prepared"));
  assert.deepEqual(
    completed.events
      .filter((event) => event.type === "specialist_started")
      .map((event) => event.specialist)
      .sort(),
    ["reviewer", "verifier"],
  );
  assert.ok(completed.events.some((event) => event.type === "mergeability_checked"));
  assert.equal(completed.events.at(-1)?.type, "review_completed");

  const duplicate = service.start(reviewRequest());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.review.id, completed.id);
});

test("blocking specialist evidence requests changes", async () => {
  const store = new MemoryPullRequestReviewStore();
  const service = new PullRequestControlService({
    store,
    workspace: new FakeWorkspace(),
    specialists: definitions,
    createSessionFactory: () => new StubSpecialistFactory(definitions, {
      reviewer: report("fail", "reviewer"),
      verifier: report("pass", "verifier"),
    }),
    fetchFn: async () => new Response(null, { status: 200 }),
  });

  const completed = await service.start(reviewRequest()).promise;
  assert.equal(completed.decision, "changes_requested");
  assert.equal(completed.findings[0]?.severity, "blocking");
});

test("PR review HTTP API starts and returns a separate review record", async () => {
  const store = new MemoryPullRequestReviewStore();
  const service = new PullRequestControlService({
    store,
    workspace: new FakeWorkspace(),
    specialists: definitions,
    createSessionFactory: () => new StubSpecialistFactory(definitions, {
      reviewer: report("pass", "reviewer"),
      verifier: report("pass", "verifier"),
    }, 20),
    fetchFn: async () => new Response(null, { status: 200 }),
  });
  const ctx = createRunContext({
    helixDir: fixtureDir,
    store: new MemoryRunStore(),
    provider: new FakeProvider(),
  });
  const app = createApp({ ctx, prControl: service });

  const started = await request(app).post("/pr-reviews").send(reviewRequest()).expect(202);
  assert.equal(started.body.headSha, "head-sha");
  const active = await request(app).get("/pr-reviews").expect(200);
  assert.equal(active.body[0].live, true);
  await new Promise((done) => setTimeout(done, 60));
  const got = await request(app).get(`/pr-reviews/${started.body.id}`).expect(200);
  assert.equal(got.body.decision, "ready_to_merge");
  assert.equal(got.body.live, false);
  const listed = await request(app).get("/pr-reviews").expect(200);
  assert.equal(listed.body.length, 1);
  const events = await request(app).get(`/pr-reviews/${started.body.id}/events`).expect(200);
  assert.match(events.text, /"type":"review_started"/);
  assert.match(events.text, /"type":"specialist_completed"/);
  assert.match(events.text, /"type":"review_completed"/);

  const page = await request(app).get("/reviews").expect(200);
  assert.match(page.text, /id="root"/);
  const legacyPage = await request(app).get("/legacy/reviews").expect(200);
  assert.match(legacyPage.text, /PR Reviews/);
  assert.match(legacyPage.text, /active-review-list/);
  assert.match(legacyPage.text, />Passed</);
  const script = await request(app).get("/reviews.js").expect(200);
  assert.match(script.text, /pr-reviews/);
  assert.match(script.text, /review passed/);
});
