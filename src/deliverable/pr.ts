/**
 * PR creation + merge via `gh`. Injectable for tests.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface PullRequestInput {
  title: string;
  body: string;
  branch: string;
  base?: string;
  draft?: boolean;
  repo?: string;
}

export interface PullRequestInfo {
  url: string;
  number: number;
  branch: string;
  draft: boolean;
}

export interface PullRequestCreator {
  create(input: PullRequestInput): Promise<PullRequestInfo>;
  merge(prNumber: number, repo?: string): Promise<void>;
}

export interface GhPullRequestCreatorOptions {
  cwd?: string;
  repo?: string;
}

export class GhPullRequestCreator implements PullRequestCreator {
  private readonly cwd: string;
  private readonly repo: string | undefined;

  constructor(opts: GhPullRequestCreatorOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.repo = opts.repo;
  }

  async create(input: PullRequestInput): Promise<PullRequestInfo> {
    const args = [
      "pr",
      "create",
      "--title",
      input.title,
      "--body",
      input.body,
      "--head",
      input.branch,
    ];
    if (input.base) args.push("--base", input.base);
    if (input.draft) args.push("--draft");
    if (input.repo ?? this.repo) args.push("--repo", input.repo ?? this.repo!);

    const { stdout } = await execFileP("gh", args, { cwd: this.cwd });
    const url = stdout.trim().split("\n").pop()?.trim() ?? "";
    const number = parsePrNumber(url);
    return {
      url,
      number,
      branch: input.branch,
      draft: input.draft ?? false,
    };
  }

  async merge(prNumber: number, repo?: string): Promise<void> {
    const args = ["pr", "merge", String(prNumber), "--merge"];
    const r = repo ?? this.repo;
    if (r) args.push("--repo", r);
    await execFileP("gh", args, { cwd: this.cwd });
  }
}

function parsePrNumber(url: string): number {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

export class FakePullRequestCreator implements PullRequestCreator {
  readonly created: PullRequestInput[] = [];
  readonly merged: number[] = [];
  private counter = 1;

  async create(input: PullRequestInput): Promise<PullRequestInfo> {
    this.created.push(input);
    const number = this.counter++;
    return {
      url: `https://github.com/acme/widget/pull/${number}`,
      number,
      branch: input.branch,
      draft: input.draft ?? false,
    };
  }

  async merge(prNumber: number): Promise<void> {
    this.merged.push(prNumber);
  }
}
