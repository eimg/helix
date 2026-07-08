/**
 * GitHub trigger — M1: manual fetch only, via `gh issue view --json`.
 *
 * `fetchIssue` is the building block M2's GitHubPollTrigger will compose. The
 * `Trigger` interface is kept minimal for now; M2 adds polling/webhook.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Issue, Trigger } from "../engine/types.js";

const execFileP = promisify(execFile);

interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: { name: string }[];
}

export class GitHubTrigger implements Trigger {
  readonly source = "github" as const;
  constructor(readonly repo: string) {}

  async fetchIssue(number: number): Promise<Issue> {
    const { stdout } = await execFileP("gh", [
      "issue",
      "view",
      String(number),
      "--repo",
      this.repo,
      "--json",
      "number,title,body,url,labels",
    ]);
    const data = JSON.parse(stdout) as GhIssue;
    return {
      source: "github",
      repo: this.repo,
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      url: data.url,
      labels: (data.labels ?? []).map((l) => l.name),
    };
  }
}

/** Manual trigger for tests / CLI: wrap a pre-fetched issue. */
export class ManualTrigger implements Trigger {
  readonly source = "github" as const;
  constructor(private readonly issue: Issue) {}
  async fetchIssue(): Promise<Issue> {
    return this.issue;
  }
}
