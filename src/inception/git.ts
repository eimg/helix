/**
 * Sync git helpers for empty-workspace inception (create project repo in place).
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** True when `cwd` has its own `.git` directory or file (not merely a parent worktree). */
export function hasOwnGitDir(cwd: string): boolean {
  return existsSync(resolve(cwd, ".git"));
}

/** Create a new git repository at `cwd`. Fails if that directory already owns a `.git`. */
export function gitInit(cwd: string): void {
  const root = resolve(cwd);
  if (hasOwnGitDir(root)) {
    throw new Error(`Refusing git init: ${root} already has its own Git repository`);
  }
  execFileSync("git", ["init"], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Name the default branch so local PR worktrees can branch from `main`.
  try {
    execFileSync("git", ["branch", "-M", "main"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Older git without -M still works once the first commit lands on main.
  }
}

/** True when `ref` resolves to a commit in `cwd`. */
export function hasCommit(cwd: string, ref = "main"): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: resolve(cwd),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage and commit the current tree so later Helix implementation runs have a
 * base SHA for isolated worktrees / local PRs. Honors `.gitignore` (so
 * repo-root `.env` and `.helix/.env` stay out). No-ops when there is nothing
 * new to commit and a HEAD already exists.
 */
export function commitBootstrapTree(cwd: string, message = "Helix bootstrap foundation"): string {
  const root = resolve(cwd);
  if (!hasOwnGitDir(root)) {
    throw new Error(`Cannot commit bootstrap tree: ${root} is not a Git repository`);
  }
  execFileSync("git", ["add", "-A"], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (!staged && hasCommit(root, "HEAD")) {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  const args = staged
    ? ["commit", "-m", message]
    : ["commit", "--allow-empty", "-m", message];
  execFileSync(
    "git",
    ["-c", "user.name=Helix", "-c", "user.email=helix@local", ...args],
    {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    execFileSync("git", ["branch", "-M", "main"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Ignore if already on main.
  }
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
