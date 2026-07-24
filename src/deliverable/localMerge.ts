import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface LocalPullRequestMergeInput {
  id: number;
  title: string;
  repositoryPath: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
}

export interface LocalPullRequestMergeResult {
  mergeCommitSha: string;
  baseBranch: string;
  headSha: string;
  repositoryPath: string;
}

/**
 * Human-initiated merge of a reviewed local PR head into the base branch.
 * Always runs against this Helix server's repository (Issues may not know the path).
 */
export async function mergeLocalPullRequest(
  repositoryPath: string,
  pullRequest: LocalPullRequestMergeInput,
): Promise<LocalPullRequestMergeResult> {
  const cwd = resolve(repositoryPath);
  await assertRepository(cwd);

  const dirty = await git(cwd, ["status", "--porcelain"]);
  if (dirty) {
    throw new Error("Repository working tree is not clean; commit or stash local changes before merging");
  }

  try {
    await git(cwd, ["rev-parse", "--verify", `${pullRequest.headSha}^{commit}`]);
  } catch {
    throw new Error(
      `Reviewed head ${pullRequest.headSha.slice(0, 8)} is not in this Helix workspace (${cwd})`,
    );
  }

  if (await refExists(cwd, pullRequest.headBranch)) {
    const branchTip = await git(cwd, ["rev-parse", "--verify", `${pullRequest.headBranch}^{commit}`]);
    if (branchTip !== pullRequest.headSha) {
      throw new Error(
        `Head branch ${pullRequest.headBranch} no longer points at the reviewed SHA ${pullRequest.headSha.slice(0, 8)}`,
      );
    }
  }

  const previousRef = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let merged = false;
  try {
    await git(cwd, ["checkout", "--quiet", pullRequest.baseBranch]);
    const message = `Merge local PR #${pullRequest.id}: ${pullRequest.title}`.slice(0, 120);
    try {
      await git(cwd, ["merge", "--no-ff", "-m", message, pullRequest.headSha]);
    } catch (error) {
      try {
        await git(cwd, ["merge", "--abort"]);
      } catch {
        // Ignore abort failures when merge never started.
      }
      throw new Error(`Git merge failed: ${formatGitError(error)}`);
    }
    merged = true;
    const mergeCommitSha = await git(cwd, ["rev-parse", "HEAD"]);
    return {
      mergeCommitSha,
      baseBranch: pullRequest.baseBranch,
      headSha: pullRequest.headSha,
      repositoryPath: cwd,
    };
  } finally {
    if (!merged && previousRef && previousRef !== "HEAD") {
      try {
        await git(cwd, ["checkout", "--quiet", previousRef]);
      } catch {
        // Leave the repo where Git stopped; the merge error is the important signal.
      }
    }
  }
}

async function assertRepository(cwd: string): Promise<void> {
  let inside: string;
  try {
    inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new Error(`Repository path is not a Git working tree: ${cwd}`);
  }
  if (inside !== "true") {
    throw new Error(`Repository path is not a Git working tree: ${cwd}`);
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function formatGitError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const err = error as Error & { stderr?: string | Buffer };
  const stderr = typeof err.stderr === "string"
    ? err.stderr
    : Buffer.isBuffer(err.stderr)
      ? err.stderr.toString("utf8")
      : "";
  return (stderr.trim() || err.message).trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    maxBuffer: 5 * 1024 * 1024,
  });
  return stdout.trim();
}
