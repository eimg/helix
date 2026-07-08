/**
 * Git helpers for merge gate diff stats and PR creation context.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffStats } from "../orchestrator/mergeGate.js";

const execFileP = promisify(execFile);

export interface GitContext {
  getDiffStats(baseBranch?: string): Promise<DiffStats>;
  getCurrentBranch(): Promise<string>;
}

export interface GitContextOptions {
  cwd?: string;
  defaultBase?: string;
}

export class ShellGitContext implements GitContext {
  private readonly cwd: string;
  private readonly defaultBase: string;

  constructor(opts: GitContextOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.defaultBase = opts.defaultBase ?? "main";
  }

  async getCurrentBranch(): Promise<string> {
    const { stdout } = await execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: this.cwd });
    return stdout.trim();
  }

  async getDiffStats(baseBranch?: string): Promise<DiffStats> {
    const base = baseBranch ?? this.defaultBase;
    try {
      const { stdout } = await execFileP("git", ["diff", "--numstat", `${base}...HEAD`], { cwd: this.cwd });
      return parseNumstat(stdout);
    } catch {
      // Fallback when base branch doesn't exist locally — diff working tree vs HEAD.
      const { stdout } = await execFileP("git", ["diff", "--numstat", "HEAD"], { cwd: this.cwd });
      return parseNumstat(stdout);
    }
  }
}

function parseNumstat(stdout: string): DiffStats {
  let lines = 0;
  let files = 0;
  for (const row of stdout.trim().split("\n")) {
    if (!row.trim()) continue;
    const parts = row.split("\t");
    if (parts.length < 3) continue;
    files++;
    const added = parts[0] === "-" ? 0 : Number(parts[0]) || 0;
    const removed = parts[1] === "-" ? 0 : Number(parts[1]) || 0;
    lines += added + removed;
  }
  return { lines, files };
}

/** Injectable fake for tests. */
export class FakeGitContext implements GitContext {
  constructor(
    private readonly branch: string,
    private readonly stats: DiffStats,
  ) {}

  getCurrentBranch(): Promise<string> {
    return Promise.resolve(this.branch);
  }

  getDiffStats(): Promise<DiffStats> {
    return Promise.resolve(this.stats);
  }
}
