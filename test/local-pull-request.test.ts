import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalPullRequestDeliverablePipeline } from "../src/deliverable/localPullRequest.js";
import { mergeLocalPullRequest } from "../src/deliverable/localMerge.js";
import type { Run } from "../src/engine/types.js";
import { GitPullRequestWorkspace } from "../src/pr-control/workspace.js";
import { GitRunWorkspaceManager } from "../src/run/workspace.js";
import { createRunContext, startRun, maybeWireLocalPullRequest } from "../src/run/bootstrap.js";
import { MemoryRunStore } from "../src/state/runStore.js";
import { FakeProvider } from "../src/providers/fake.js";
import { NoOpDeliverablePipeline } from "../src/deliverable/pipeline.js";
import { LocalPullRequestDeliverablePipeline } from "../src/deliverable/localPullRequest.js";

test("local deliverable registers a committed feature branch without merging it", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "helix-local-pr-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd });
    execFileSync("git", ["config", "user.email", "helix@test.local"], { cwd });
    execFileSync("git", ["config", "user.name", "Helix Test"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-b", "feature/change"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\nchange\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "change"], { cwd });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();

    const workspace = await new GitPullRequestWorkspace(cwd).prepare({
      repositoryPath: cwd,
      baseSha,
      headSha,
    });
    assert.equal(workspace.headSha, headSha);
    assert.equal(workspace.mergeable, true);
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.cwd, encoding: "utf8" }).trim(),
      headSha,
    );
    const worktreePath = workspace.cwd;
    await workspace.cleanup();
    assert.equal(existsSync(worktreePath), false);

    let posted: Record<string, unknown> | undefined;
    const pipeline = new LocalPullRequestDeliverablePipeline({
      cwd,
      fetchFn: async (_url, init) => {
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: 12,
          headBranch: "feature/change",
          status: "draft",
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      },
    });
    const run: Run = {
      id: "run-local",
      issue: {
        source: "inline",
        title: "Change",
        body: "",
        labels: [],
        external: { trackerUrl: "http://issues.test", issueId: 3 },
      },
      startedAt: 1,
      finishedAt: 2,
      status: "done",
      events: [],
      results: [],
      finalDecision: { kind: "done", reason: "implemented", deliverable: "file.txt" },
    };

    const result = await pipeline.finalize(run, {
      autoMerge: false,
      maxDiffLines: 100,
      maxFiles: 5,
      else: "draft-pr-and-notify",
    });
    assert.equal(result.pullRequest?.number, 12);
    assert.equal(result.pullRequest?.draft, true);
    assert.equal(posted?.origin, "helix");
    assert.equal(posted?.headBranch, "feature/change");
    assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim(), "feature/change");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run workspace creates an isolated feature branch and preserves it after cleanup", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "helix-run-workspace-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd });
    execFileSync("git", ["config", "user.email", "helix@test.local"], { cwd });
    execFileSync("git", ["config", "user.name", "Helix Test"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd });

    const manager = new GitRunWorkspaceManager(cwd, "main");
    const workspace = await manager.prepare({
      runId: "12345678-abcd",
      issue: {
        source: "inline",
        title: "Add useful thing",
        body: "",
        labels: [],
        external: { trackerUrl: "http://issues.test", issueId: 9 },
      },
    });
    assert.equal(workspace.branch, "helix/issue-9-add-useful-thing-12345678");
    assert.equal(
      execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim(),
      "main",
    );
    assert.equal(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: workspace.cwd,
        encoding: "utf8",
      }).trim(),
      workspace.branch,
    );
    const worktreePath = workspace.cwd;
    await workspace.cleanup();
    assert.equal(existsSync(worktreePath), false);
    assert.match(
      execFileSync("git", ["branch", "--list", workspace.branch], {
        cwd,
        encoding: "utf8",
      }),
      new RegExp(workspace.branch.replaceAll("/", "\\/")),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("local deliverable safely commits remaining worktree changes before registration", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "helix-local-pr-finalize-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd });
    execFileSync("git", ["config", "user.email", "helix@test.local"], { cwd });
    execFileSync("git", ["config", "user.name", "Helix Test"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd });

    const workspace = await new GitRunWorkspaceManager(cwd, "main").prepare({
      runId: "abcdefgh-1234",
      issue: {
        source: "inline",
        title: "Change without manual commit",
        body: "",
        labels: [],
        external: { trackerUrl: "http://issues.test", issueId: 11 },
      },
    });
    writeFileSync(join(workspace.cwd, "file.txt"), "base\nauto committed\n");
    let posted: Record<string, unknown> | undefined;
    const pipeline = new LocalPullRequestDeliverablePipeline({
      cwd,
      fetchFn: async (_url, init) => {
        posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: 13,
          headBranch: workspace.branch,
          status: "draft",
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      },
    });
    const run = localRun("run-auto", "Change without manual commit");
    const result = await pipeline.finalize(run, mergeGate(), workspace);

    assert.equal(result.deliverableError, undefined);
    assert.equal(result.pullRequest?.number, 13);
    assert.equal(posted?.repositoryPath, cwd);
    assert.equal(posted?.headBranch, workspace.branch);
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: workspace.cwd,
        encoding: "utf8",
      }).trim(),
      "",
    );
    assert.equal(
      execFileSync("git", ["log", "-1", "--pretty=%s"], {
        cwd: workspace.cwd,
        encoding: "utf8",
      }).trim(),
      "Helix: Change without manual commit",
    );
    await workspace.cleanup();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("local deliverable refuses to auto-commit sensitive paths", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "helix-local-pr-sensitive-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd });
    execFileSync("git", ["config", "user.email", "helix@test.local"], { cwd });
    execFileSync("git", ["config", "user.name", "Helix Test"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd });
    const workspace = await new GitRunWorkspaceManager(cwd, "main").prepare({
      runId: "sensitive-1234",
      issue: {
        source: "inline",
        title: "Unsafe change",
        body: "",
        labels: [],
        external: { trackerUrl: "http://issues.test", issueId: 12 },
      },
    });
    // .env is normally ignored; force-add it to model an agent staging a secret.
    writeFileSync(join(workspace.cwd, ".env"), "TOKEN=secret\n");
    execFileSync("git", ["add", "-f", ".env"], { cwd: workspace.cwd });
    let called = false;
    const pipeline = new LocalPullRequestDeliverablePipeline({
      cwd,
      fetchFn: async () => {
        called = true;
        return new Response("{}", { status: 201 });
      },
    });
    const result = await pipeline.finalize(
      localRun("run-sensitive", "Unsafe change"),
      mergeGate(),
      workspace,
    );

    assert.match(result.deliverableError ?? "", /refused to auto-commit.*\.env/i);
    assert.equal(result.pullRequest, undefined);
    assert.equal(called, false);
    assert.match(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: workspace.cwd,
        encoding: "utf8",
      }),
      /\.env/,
    );
    await workspace.cleanup();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("workspace preparation failure is persisted as a visible error run", async () => {
  const store = new MemoryRunStore();
  const ctx = createRunContext({
    helixDir: resolve("examples/ts/.helix"),
    store,
    provider: new FakeProvider(),
    deliverable: new NoOpDeliverablePipeline(),
    workspace: {
      prepare: async () => {
        throw new Error("base branch is unavailable");
      },
    },
  });
  const { promise } = startRun(ctx, {
    source: "inline",
    title: "Cannot prepare",
    body: "",
    labels: [],
    external: { trackerUrl: "http://issues.test", issueId: 15 },
  });
  const run = await promise;

  assert.equal(run.status, "error");
  assert.equal(run.deliverableError, "base branch is unavailable");
  assert.equal(run.events.at(-1)?.type, "run_error");
  assert.equal(store.load(run.id)?.status, "error");
});

test("local deliverable patches an existing PR on continuation instead of creating another", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "helix-local-pr-patch-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd });
    execFileSync("git", ["config", "user.email", "helix@test.local"], { cwd });
    execFileSync("git", ["config", "user.name", "Helix Test"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd });
    execFileSync("git", ["checkout", "-b", "helix/issue-3-existing"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\nfeedback\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "address feedback"], { cwd });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const baseSha = execFileSync("git", ["rev-parse", "main"], { cwd, encoding: "utf8" }).trim();

    let method: string | undefined;
    let url: string | undefined;
    let patched: Record<string, unknown> | undefined;
    const pipeline = new LocalPullRequestDeliverablePipeline({
      cwd,
      fetchFn: async (requestUrl, init) => {
        method = init?.method;
        url = String(requestUrl);
        patched = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          id: 44,
          headBranch: "helix/issue-3-existing",
          status: "draft",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    const result = await pipeline.finalize(localRun("run-continue", "Address feedback"), mergeGate(), {
      cwd,
      repositoryPath: cwd,
      branch: "helix/issue-3-existing",
      baseBranch: "main",
      baseSha,
      existingPullRequestId: 44,
    });

    assert.equal(result.deliverableError, undefined);
    assert.equal(result.pullRequest?.number, 44);
    assert.equal(method, "PATCH");
    assert.equal(url, "http://issues.test/api/pull-requests/44");
    assert.equal(patched?.headSha, headSha);
    assert.equal(patched?.headBranch, "helix/issue-3-existing");
    assert.equal(patched?.origin, undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("run workspace reuses an existing PR branch when requested", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "helix-reuse-branch-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd });
    execFileSync("git", ["config", "user.email", "helix@test.local"], { cwd });
    execFileSync("git", ["config", "user.name", "Helix Test"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd });
    execFileSync("git", ["checkout", "-b", "helix/issue-9-existing"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\nprior\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "prior"], { cwd });
    const priorSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "main"], { cwd });

    const workspace = await new GitRunWorkspaceManager(cwd, "main").prepare({
      runId: "cont-aaaa-bbbb",
      issue: {
        source: "inline",
        title: "Continue work",
        body: "",
        labels: [],
        external: { trackerUrl: "http://issues.test", issueId: 9 },
      },
      reuseBranch: "helix/issue-9-existing",
    });

    assert.equal(workspace.branch, "helix/issue-9-existing");
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspace.cwd,
        encoding: "utf8",
      }).trim(),
      priorSha,
    );
    await workspace.cleanup();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Helix local merge merges the reviewed head into the base branch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "helix-local-merge-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd });
    execFileSync("git", ["config", "user.email", "helix@test.local"], { cwd });
    execFileSync("git", ["config", "user.name", "Helix Test"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd });
    execFileSync("git", ["checkout", "-b", "feature/ready"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\nready\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "ready"], { cwd });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "main"], { cwd });

    const result = await mergeLocalPullRequest(cwd, {
      id: 9,
      title: "Ready change",
      repositoryPath: "/ignored/by/helix",
      baseBranch: "main",
      headBranch: "feature/ready",
      headSha,
    });

    assert.equal(result.repositoryPath, resolve(cwd));
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(),
      result.mergeCommitSha,
    );
    assert.match(
      execFileSync("git", ["show", "HEAD:file.txt"], { cwd, encoding: "utf8" }),
      /ready/,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stale NoOp deliverable upgrades to local PR once git has a base commit", () => {
  const cwd = mkdtempSync(join(tmpdir(), "helix-wire-local-pr-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd });
    execFileSync("git", ["config", "user.email", "helix@test.local"], { cwd });
    execFileSync("git", ["config", "user.name", "Helix Test"], { cwd });
    writeFileSync(join(cwd, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd });
    execFileSync("git", ["commit", "-m", "base"], { cwd });

    const ctx = createRunContext({
      helixDir: resolve("examples/ts/.helix"),
      cwd,
      store: new MemoryRunStore(),
      provider: new FakeProvider(),
      deliverable: new NoOpDeliverablePipeline(),
    });
    assert.equal(ctx.workspace, undefined);
    assert.ok(ctx.deliverable instanceof NoOpDeliverablePipeline);

    maybeWireLocalPullRequest(ctx);
    assert.ok(ctx.deliverable instanceof LocalPullRequestDeliverablePipeline);
    assert.ok(ctx.workspace);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function localRun(id: string, title: string): Run {
  return {
    id,
    issue: {
      source: "inline",
      title,
      body: "",
      labels: [],
      external: { trackerUrl: "http://issues.test", issueId: 3 },
    },
    startedAt: 1,
    finishedAt: 2,
    status: "done",
    events: [],
    results: [],
    finalDecision: { kind: "done", reason: "implemented" },
  };
}

function mergeGate() {
  return {
    autoMerge: false,
    maxDiffLines: 100,
    maxFiles: 5,
    else: "draft-pr-and-notify" as const,
  };
}
