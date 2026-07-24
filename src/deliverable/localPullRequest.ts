import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Run } from "../engine/types.js";
import type { DeliverableFinalizeContext, DeliverablePipeline } from "./pipeline.js";
import type { MergeGateConfig } from "../orchestrator/workflow.js";

const execFileP = promisify(execFile);

interface CreatedLocalPullRequest {
  id: number;
  headBranch: string;
  status: string;
}

export interface LocalPullRequestDeliverableOptions {
  cwd: string;
  baseBranch?: string;
  fetchFn?: typeof fetch;
}

/**
 * Finalizes a Helix-owned implementation branch and registers it as a draft
 * local PR in Acme Issues. It never merges or pushes.
 */
export class LocalPullRequestDeliverablePipeline implements DeliverablePipeline {
  private readonly cwd: string;
  private readonly baseBranch: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: LocalPullRequestDeliverableOptions) {
    this.cwd = resolve(opts.cwd);
    this.baseBranch = opts.baseBranch ?? "main";
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async finalize(
    run: Run,
    _mergeGate: MergeGateConfig,
    context?: DeliverableFinalizeContext,
  ): Promise<Run> {
    const external = run.issue.external;
    if (run.status !== "done" || !external) {
      run.approvalStatus = "none";
      return run;
    }

    try {
      const runCwd = resolve(context?.cwd ?? this.cwd);
      const repositoryPath = resolve(context?.repositoryPath ?? this.cwd);
      const headBranch = await git(runCwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (!headBranch || headBranch === "HEAD") {
        throw new Error("Local PR requires a named head branch");
      }
      if (context?.branch && headBranch !== context.branch) {
        throw new Error(
          `Helix-managed branch changed during the run (expected ${context.branch}, found ${headBranch})`,
        );
      }
      const baseBranch = context?.baseBranch ?? this.baseBranch;
      if (headBranch === baseBranch) {
        throw new Error(`Local PR head branch must differ from base branch ${baseBranch}`);
      }

      if (context?.branch) {
        await commitRemainingChanges(runCwd, run);
      }
      const status = await git(runCwd, ["status", "--porcelain"]);
      if (status.trim()) {
        throw new Error(
          context?.branch
            ? "Helix could not leave the implementation worktree clean after finalization"
            : "Local PR requires a clean working tree with all implementation changes committed",
        );
      }
      const baseSha = context?.baseSha
        ?? await git(repositoryPath, ["rev-parse", "--verify", `${baseBranch}^{commit}`]);
      const headSha = await git(runCwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const changedPaths = await git(runCwd, ["diff", "--name-only", `${baseSha}...${headSha}`]);
      if (!changedPaths) {
        throw new Error("Local PR has no committed change relative to its base");
      }

      const trackerBase = external.trackerUrl.replace(/\/$/, "");
      const existingId = context?.existingPullRequestId;
      const description = buildDescription(run);
      let pullRequestId: number;
      let responseBranch = headBranch;

      if (existingId !== undefined) {
        const url = `${trackerBase}/api/pull-requests/${existingId}`;
        const response = await this.fetchFn(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "X-Helix-Run-Id": run.id },
          body: JSON.stringify({
            description,
            baseBranch,
            baseSha,
            headBranch,
            headSha,
          }),
        });
        if (!response.ok) {
          throw new Error(`Acme Issues rejected local PR update (HTTP ${response.status})`);
        }
        const updated = await response.json() as CreatedLocalPullRequest;
        if (!Number.isInteger(updated.id) || updated.id <= 0) {
          throw new Error("Acme Issues returned an invalid local PR response");
        }
        pullRequestId = updated.id;
        if (typeof updated.headBranch === "string" && updated.headBranch.trim()) {
          responseBranch = updated.headBranch;
        }
      } else {
        const url = `${trackerBase}/api/pull-requests`;
        const response = await this.fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Helix-Run-Id": run.id },
          body: JSON.stringify({
            issueId: external.issueId,
            title: run.issue.title,
            description,
            repositoryPath,
            baseBranch,
            baseSha,
            headBranch,
            headSha,
            author: "helix",
            origin: "helix",
          }),
        });
        if (!response.ok) {
          throw new Error(`Acme Issues rejected local PR creation (HTTP ${response.status})`);
        }
        const created = await response.json() as CreatedLocalPullRequest;
        if (!Number.isInteger(created.id) || created.id <= 0) {
          throw new Error("Acme Issues returned an invalid local PR response");
        }
        pullRequestId = created.id;
        if (typeof created.headBranch === "string" && created.headBranch.trim()) {
          responseBranch = created.headBranch;
        }
      }

      run.pullRequest = {
        number: pullRequestId,
        branch: responseBranch,
        draft: true,
        url: `${trackerBase}/?pr=${pullRequestId}`,
      };
      // Readiness and the human merge record live in Acme Issues PR control,
      // not in Helix's provisional GitHub approve/merge endpoints.
      run.approvalStatus = "none";
    } catch (err) {
      run.deliverableError = err instanceof Error ? err.message : String(err);
      run.approvalStatus = "none";
    }
    return run;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout.trim();
}

async function commitRemainingChanges(cwd: string, run: Run): Promise<void> {
  const status = await git(cwd, ["status", "--porcelain"]);
  if (!status) return;

  const paths = await changedPaths(cwd);
  for (const path of paths) {
    await assertSafeImplementationPath(cwd, path);
  }

  await git(cwd, ["add", "--all", "--", "."]);
  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  if (!staged) return;
  const title = run.issue.title.replace(/\s+/g, " ").trim().slice(0, 120) || "implementation";
  await git(cwd, [
    "-c",
    "user.name=Helix",
    "-c",
    "user.email=helix@local",
    "commit",
    "-m",
    `Helix: ${title}`,
  ]);
}

async function changedPaths(cwd: string): Promise<string[]> {
  const outputs = await Promise.all([
    git(cwd, ["diff", "--name-only", "-z", "HEAD"]),
    git(cwd, ["diff", "--cached", "--name-only", "-z"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set(
    outputs.flatMap((output) => output.split("\0").filter(Boolean)),
  )];
}

async function assertSafeImplementationPath(cwd: string, path: string): Promise<void> {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const name = segments.at(-1)?.toLowerCase() ?? "";
  const unsafe =
    normalized.startsWith("/")
    || segments.includes("..")
    || segments.includes(".git")
    || segments.includes(".helix")
    || (name.startsWith(".env") && name !== ".env.example")
    || /(?:^|[._-])(credentials?|secrets?|private[-_]?key)(?:[._-]|$)/i.test(name)
    || /\.(?:pem|p12|pfx|key)$/i.test(name)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i.test(name);
  if (unsafe) {
    throw new Error(`Helix refused to auto-commit sensitive or runtime path: ${path}`);
  }

  try {
    const stats = await lstat(resolve(cwd, path));
    if (stats.isSymbolicLink()) {
      throw new Error(`Helix refused to auto-commit symbolic link: ${path}`);
    }
    if (stats.isFile() && stats.size > 10 * 1024 * 1024) {
      throw new Error(`Helix refused to auto-commit file larger than 10 MiB: ${path}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    // Deleted paths are safe once their tracked path has passed the checks above.
  }
}

function buildDescription(run: Run): string {
  const parts = [`Helix implementation run ${run.id}.`];
  if (run.finalDecision?.kind === "done") {
    if (run.finalDecision.reason) parts.push(run.finalDecision.reason);
    if (run.finalDecision.deliverable) parts.push("", run.finalDecision.deliverable);
  }
  return parts.join("\n");
}
