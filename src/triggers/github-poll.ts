/**
 * GitHub poll trigger — polls labeled open issues and invokes a callback.
 * Composes M1's issue fetch/list; injectable lister for tests.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Issue } from "../engine/types.js";

const execFileP = promisify(execFile);

export interface IssueLister {
  listOpenIssues(repo: string, labelFilter?: string): Promise<Issue[]>;
}

interface GhIssueRow {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: { name: string }[];
}

export class GitHubIssueLister implements IssueLister {
  async listOpenIssues(repo: string, labelFilter?: string): Promise<Issue[]> {
    const args = ["issue", "list", "--repo", repo, "--state", "open", "--json", "number,title,body,url,labels"];
    if (labelFilter) args.push("--label", labelFilter);
    const { stdout } = await execFileP("gh", args);
    const rows = JSON.parse(stdout) as GhIssueRow[];
    return rows.map((row) => ({
      source: "github" as const,
      repo,
      number: row.number,
      title: row.title,
      body: row.body ?? "",
      url: row.url,
      labels: (row.labels ?? []).map((l) => l.name),
    }));
  }
}

export type PollHandler = (issue: Issue) => void | Promise<void>;

export interface GitHubPollTriggerOptions {
  repo: string;
  labelFilter?: string;
  intervalSec?: number;
  lister?: IssueLister;
  onIssue: PollHandler;
  /** Issue numbers already handled this session (skip duplicates). */
  seen?: Set<number>;
  /** Injectable clock for tests. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export class GitHubPollTrigger {
  readonly repo: string;
  readonly labelFilter?: string;
  readonly intervalSec: number;
  private readonly lister: IssueLister;
  private readonly onIssue: PollHandler;
  private readonly seen: Set<number>;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private timer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(opts: GitHubPollTriggerOptions) {
    this.repo = opts.repo;
    this.labelFilter = opts.labelFilter;
    this.intervalSec = opts.intervalSec ?? 60;
    this.lister = opts.lister ?? new GitHubIssueLister();
    this.onIssue = opts.onIssue;
    this.seen = opts.seen ?? new Set();
    this.setIntervalFn = opts.setIntervalFn ?? setInterval;
    this.clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = this.setIntervalFn(() => void this.tick(), this.intervalSec * 1000);
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one poll cycle (public for tests). */
  async tick(): Promise<Issue[]> {
    if (this.polling) return [];
    this.polling = true;
    try {
      const issues = await this.lister.listOpenIssues(this.repo, this.labelFilter);
      const newIssues: Issue[] = [];
      for (const issue of issues) {
        if (issue.number == null || this.seen.has(issue.number)) continue;
        this.seen.add(issue.number);
        newIssues.push(issue);
        await this.onIssue(issue);
      }
      return newIssues;
    } finally {
      this.polling = false;
    }
  }
}

/** In-memory lister for tests. */
export class FakeIssueLister implements IssueLister {
  constructor(private readonly issues: Issue[]) {}
  listOpenIssues(_repo: string, labelFilter?: string): Promise<Issue[]> {
    if (!labelFilter) return Promise.resolve([...this.issues]);
    return Promise.resolve(this.issues.filter((i) => i.labels.includes(labelFilter)));
  }
}
