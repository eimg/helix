import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface PreparedPullRequestWorkspace {
  cwd: string;
  baseSha: string;
  headSha: string;
  mergeable: boolean;
  mergeSummary: string;
  cleanup(): Promise<void>;
}

export interface PullRequestWorkspace {
  prepare(input: {
    repositoryPath: string;
    baseSha: string;
    headSha: string;
  }): Promise<PreparedPullRequestWorkspace>;
}

export class GitPullRequestWorkspace implements PullRequestWorkspace {
  constructor(private readonly configuredRepositoryPath: string) {}

  async prepare(input: {
    repositoryPath: string;
    baseSha: string;
    headSha: string;
  }): Promise<PreparedPullRequestWorkspace> {
    const configured = resolve(this.configuredRepositoryPath);
    if (resolve(input.repositoryPath) !== configured) {
      throw new Error(
        `Pull request repository ${input.repositoryPath} does not match this Helix server (${configured})`,
      );
    }

    const baseSha = await resolveCommit(configured, input.baseSha);
    const headSha = await resolveCommit(configured, input.headSha);
    const mergeability = await checkMergeability(configured, baseSha, headSha);
    const worktreePath = await mkdtemp(join(tmpdir(), "helix-pr-review-"));
    try {
      await execFileP("git", ["worktree", "add", "--detach", worktreePath, headSha], {
        cwd: configured,
      });
    } catch (err) {
      await rm(worktreePath, { recursive: true, force: true });
      throw err;
    }

    let cleaned = false;
    return {
      cwd: worktreePath,
      baseSha,
      headSha,
      mergeable: mergeability.mergeable,
      mergeSummary: mergeability.summary,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        try {
          await execFileP("git", ["worktree", "remove", "--force", worktreePath], {
            cwd: configured,
          });
        } finally {
          await rm(worktreePath, { recursive: true, force: true });
        }
      },
    };
  }
}

async function checkMergeability(
  cwd: string,
  baseSha: string,
  headSha: string,
): Promise<{ mergeable: boolean; summary: string }> {
  try {
    await execFileP("git", ["merge-tree", "--write-tree", baseSha, headSha], { cwd });
    return { mergeable: true, summary: "Git produced a merge tree without conflicts." };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { mergeable: false, summary: `Git could not produce a clean merge tree: ${detail}` };
  }
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  const { stdout } = await execFileP("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd });
  return stdout.trim();
}
