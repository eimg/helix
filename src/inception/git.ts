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
}
