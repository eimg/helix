import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Issue } from "../engine/types.js";

const execFileP = promisify(execFile);

export interface PreparedRunWorkspace {
  cwd: string;
  repositoryPath: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  cleanup(): Promise<void>;
}

export interface PrepareRunWorkspaceInput {
  runId: string;
  issue: Issue;
  /** When set and the branch still exists, continue from its tip instead of branching from main. */
  reuseBranch?: string;
}

export interface RunWorkspaceManager {
  prepare(input: PrepareRunWorkspaceInput): Promise<PreparedRunWorkspace>;
}

/**
 * Creates one named branch and isolated Git worktree per linked implementation
 * run. The canonical checkout is never switched or mutated.
 */
export class GitRunWorkspaceManager implements RunWorkspaceManager {
  private readonly repositoryPath: string;
  private readonly baseBranch: string;

  constructor(repositoryPath: string, baseBranch = "main") {
    this.repositoryPath = resolve(repositoryPath);
    this.baseBranch = baseBranch;
  }

  async prepare(input: PrepareRunWorkspaceInput): Promise<PreparedRunWorkspace> {
    await assertRepository(this.repositoryPath);
    const baseSha = await git(this.repositoryPath, [
      "rev-parse",
      "--verify",
      `${this.baseBranch}^{commit}`,
    ]);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "helix-run-"));
    const cwd = join(temporaryRoot, "repo");

    const reuseBranch = input.reuseBranch?.trim();
    let branch = buildBranchName(input.issue, input.runId);
    let startPoint = baseSha;
    let createBranch = true;

    if (reuseBranch) {
      try {
        startPoint = await git(this.repositoryPath, [
          "rev-parse",
          "--verify",
          `${reuseBranch}^{commit}`,
        ]);
        branch = reuseBranch;
        createBranch = false;
      } catch {
        // Branch was pruned or never local; fall back to a fresh feature branch.
      }
    }

    try {
      if (createBranch) {
        await git(this.repositoryPath, [
          "worktree",
          "add",
          "-b",
          branch,
          cwd,
          startPoint,
        ]);
      } else {
        await git(this.repositoryPath, [
          "worktree",
          "add",
          cwd,
          branch,
        ]);
      }
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }

    return {
      cwd,
      repositoryPath: this.repositoryPath,
      branch,
      baseBranch: this.baseBranch,
      baseSha,
      cleanup: async () => {
        try {
          await git(this.repositoryPath, ["worktree", "remove", "--force", cwd]);
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      },
    };
  }
}

async function assertRepository(cwd: string): Promise<void> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    throw new Error(`${cwd} is not a Git working tree`);
  }
}

function buildBranchName(issue: Issue, runId: string): string {
  const issuePart = issue.external ? `issue-${issue.external.issueId}` : "run";
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "change";
  return `helix/${issuePart}-${slug}-${runId.slice(0, 8)}`;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd });
  return stdout.trim();
}
