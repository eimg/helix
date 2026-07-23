import { randomUUID } from "node:crypto";
import type {
  SpecialistDefinition,
  SpecialistResult,
  SpecialistSessionFactory,
} from "../engine/types.js";
import type {
  PullRequestReview,
  PullRequestReviewCheck,
  PullRequestReviewDecision,
  PullRequestReviewEvent,
  PullRequestReviewFinding,
  PullRequestReviewRequest,
  PullRequestSpecialistReport,
} from "./types.js";
import type { PullRequestReviewStore } from "./store.js";
import type { PullRequestWorkspace } from "./workspace.js";
import { notifyPullRequestTracker } from "./callback.js";

export interface PullRequestControlOptions {
  store: PullRequestReviewStore;
  workspace: PullRequestWorkspace;
  specialists: SpecialistDefinition[];
  createSessionFactory(cwd: string): SpecialistSessionFactory;
  fetchFn?: typeof fetch;
}

export interface StartedPullRequestReview {
  review: PullRequestReview;
  duplicate: boolean;
  promise: Promise<PullRequestReview>;
}

export class PullRequestControlService {
  private readonly active = new Set<string>();
  private readonly listeners = new Map<string, Set<(event: PullRequestReviewEvent) => void>>();

  constructor(private readonly opts: PullRequestControlOptions) {}

  start(request: PullRequestReviewRequest): StartedPullRequestReview {
    const existing = this.opts.store.findByExternalEvent(request.externalEventId);
    if (existing) {
      return {
        review: existing,
        duplicate: true,
        promise: Promise.resolve(existing),
      };
    }

    const review: PullRequestReview = {
      id: randomUUID(),
      request,
      status: "running",
      startedAt: Date.now(),
      summary: "",
      findings: [],
      checks: [],
      reports: [],
      events: [{
        ts: Date.now(),
        type: "review_started",
        summary: `Review started for ${request.pullRequest.headBranch} at ${shortSha(request.pullRequest.headSha)}`,
      }],
    };
    this.opts.store.save(review);
    void notifyPullRequestTracker(review, "pr.review.started", this.opts.fetchFn);

    this.active.add(review.id);
    const promise = this.execute(review).finally(() => {
      this.active.delete(review.id);
    });
    return { review, duplicate: false, promise };
  }

  get(id: string): PullRequestReview | undefined {
    return this.opts.store.load(id);
  }

  list(limit?: number): PullRequestReview[] {
    return this.opts.store.list(limit);
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  subscribe(id: string, listener: (event: PullRequestReviewEvent) => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
    };
  }

  private async execute(initial: PullRequestReview): Promise<PullRequestReview> {
    let prepared: Awaited<ReturnType<PullRequestWorkspace["prepare"]>> | undefined;
    const review = structuredClone(initial);
    try {
      this.record(review, {
        type: "workspace_preparing",
        summary: "Preparing exact-SHA review worktree",
      });
      prepared = await this.opts.workspace.prepare({
        repositoryPath: review.request.pullRequest.repositoryPath,
        baseSha: review.request.pullRequest.baseSha,
        headSha: review.request.pullRequest.headSha,
      });
      if (prepared.headSha !== review.request.pullRequest.headSha) {
        throw new Error("Resolved head SHA changed after the review request was created");
      }
      this.record(review, {
        type: "workspace_prepared",
        summary: `Detached worktree ready at ${shortSha(prepared.headSha)}`,
        details: { baseSha: prepared.baseSha, headSha: prepared.headSha },
      });

      const definitions = requiredDefinitions(this.opts.specialists);
      const factory = this.opts.createSessionFactory(prepared.cwd);
      const reports = await Promise.all(
        definitions.map((definition) =>
          runSpecialist(
            factory,
            definition,
            review.request,
            prepared!.baseSha,
            prepared!.headSha,
            (event) => this.record(review, event),
          ),
        ),
      );
      review.reports = reports;
      review.findings = reports.flatMap((report) => report.findings);
      review.checks = [
        ...reports.flatMap((report) => report.checks),
        {
          name: "git merge-tree",
          status: prepared.mergeable ? "passed" : "failed",
          summary: prepared.mergeSummary,
        },
      ];
      if (!prepared.mergeable) {
        review.findings.push({
          severity: "blocking",
          title: "Head does not merge cleanly into the recorded base",
          details: prepared.mergeSummary,
        });
      }
      this.record(review, {
        type: "mergeability_checked",
        summary: prepared.mergeSummary,
        details: { mergeable: prepared.mergeable },
      });
      review.decision = prepared.mergeable ? decide(reports) : "changes_requested";
      review.summary = summarize(reports, review.decision);
      review.status = "completed";
    } catch (err) {
      review.status = "error";
      review.decision = "blocked";
      review.error = err instanceof Error ? err.message : String(err);
      review.summary = `Review could not complete: ${review.error}`;
      review.findings = [{
        severity: "blocking",
        title: "Review execution failed",
        details: review.error,
      }];
    } finally {
      review.finishedAt = Date.now();
      await prepared?.cleanup().catch(() => undefined);
      this.record(review, review.status === "error"
        ? {
            type: "review_error",
            summary: review.summary,
            details: { error: review.error },
          }
        : {
            type: "review_completed",
            summary: review.summary,
            details: { decision: review.decision },
          });
      await notifyPullRequestTracker(review, "pr.review.completed", this.opts.fetchFn);
    }
    return review;
  }

  private record(
    review: PullRequestReview,
    event: Omit<PullRequestReviewEvent, "ts"> & { ts?: number },
  ): void {
    const recorded: PullRequestReviewEvent = { ...event, ts: event.ts ?? Date.now() };
    review.events.push(recorded);
    this.opts.store.save(review);
    for (const listener of this.listeners.get(review.id) ?? []) listener(recorded);
  }
}

function requiredDefinitions(specialists: SpecialistDefinition[]): SpecialistDefinition[] {
  const reviewer = specialists.find((definition) => definition.name === "reviewer");
  const verifier = specialists.find((definition) => definition.name === "verifier");
  const missing = [
    reviewer ? undefined : "reviewer",
    verifier ? undefined : "verifier",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing required PR-control specialist(s): ${missing.join(", ")}`);
  }
  return [reviewer!, verifier!];
}

async function runSpecialist(
  factory: SpecialistSessionFactory,
  definition: SpecialistDefinition,
  request: PullRequestReviewRequest,
  baseSha: string,
  headSha: string,
  onEvent: (event: Omit<PullRequestReviewEvent, "ts">) => void,
): Promise<PullRequestSpecialistReport> {
  onEvent({
    type: "specialist_started",
    specialist: definition.name,
    summary: `${definition.name} started`,
  });
  const session = await factory.create(definition);
  let result: SpecialistResult;
  try {
    result = await session.run(buildTask(definition.name, request, baseSha, headSha));
  } finally {
    session.dispose();
  }
  const report = parseReport(definition.name, result);
  onEvent({
    type: "specialist_completed",
    specialist: definition.name,
    summary: `${definition.name}: ${report.verdict}`,
    details: { verdict: report.verdict },
  });
  return report;
}

function buildTask(
  specialist: string,
  request: PullRequestReviewRequest,
  baseSha: string,
  headSha: string,
): string {
  const pr = request.pullRequest;
  const role =
    specialist === "reviewer"
      ? "Review correctness, acceptance criteria, regressions, unintended changes, and maintainability. Do not edit files."
      : "Run the repository's real required verification commands and inspect their results. Do not edit files.";
  return [
    `You are independently evaluating local pull request #${pr.id}.`,
    role,
    "",
    `Title: ${pr.title}`,
    `Description: ${pr.description || "(none)"}`,
    `Origin: ${pr.origin}`,
    `Author: ${pr.author}`,
    `Base: ${pr.baseBranch} at ${baseSha}`,
    `Head: ${pr.headBranch} at ${headSha}`,
    pr.issue
      ? `Linked issue #${pr.issue.id}: ${pr.issue.title}\n${pr.issue.body}`
      : "Linked issue: none. Treat missing acceptance context as blocking only when correctness cannot be judged.",
    "",
    `Inspect the exact change with: git diff ${baseSha}...${headSha}`,
    "The working directory is a detached worktree at the exact head SHA.",
    "",
    "Return one JSON object and no prose outside it:",
    JSON.stringify({
      verdict: "pass | fail | blocked",
      summary: "short evidence-based summary",
      findings: [
        { severity: "blocking | warning | note", title: "finding title", details: "evidence and remediation" },
      ],
      checks: [
        { name: "command or check", status: "passed | failed | blocked", summary: "observed result" },
      ],
    }, null, 2),
    specialist === "reviewer"
      ? "Use checks: [] unless you personally execute a concrete check."
      : "A pass requires actual command execution. Include every command you relied on in checks.",
  ].join("\n");
}

function parseReport(
  specialist: string,
  result: SpecialistResult,
): PullRequestSpecialistReport {
  if (!result.ok) {
    return blockedReport(specialist, result, result.error || "Specialist execution failed");
  }
  const parsed = extractJsonObject(result.output);
  if (!parsed) {
    return blockedReport(specialist, result, "Specialist did not return the required JSON report");
  }
  const verdict =
    parsed.verdict === "pass" || parsed.verdict === "fail" || parsed.verdict === "blocked"
      ? parsed.verdict
      : "blocked";
  const summary = typeof parsed.summary === "string" && parsed.summary.trim()
    ? parsed.summary.trim()
    : "No summary provided.";
  return {
    specialist,
    verdict,
    summary,
    findings: normalizeFindings(parsed.findings),
    checks: normalizeChecks(parsed.checks),
    result,
  };
}

function blockedReport(
  specialist: string,
  result: SpecialistResult,
  details: string,
): PullRequestSpecialistReport {
  return {
    specialist,
    verdict: "blocked",
    summary: details,
    findings: [{ severity: "blocking", title: `${specialist} report invalid`, details }],
    checks: [],
    result,
  };
}

function decide(reports: PullRequestSpecialistReport[]): PullRequestReviewDecision {
  if (reports.some((report) => report.verdict === "blocked")) return "blocked";
  if (
    reports.some((report) => report.verdict === "fail") ||
    reports.some((report) => report.findings.some((finding) => finding.severity === "blocking")) ||
    reports.some((report) => report.checks.some((check) => check.status === "failed"))
  ) {
    return "changes_requested";
  }
  return "ready_to_merge";
}

function summarize(
  reports: PullRequestSpecialistReport[],
  decision: PullRequestReviewDecision,
): string {
  const details = reports.map((report) => `${report.specialist}: ${report.summary}`).join(" ");
  return `${decision.replaceAll("_", " ")}. ${details}`;
}

function extractJsonObject(output: string): Record<string, unknown> | undefined {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  if (!candidate) return undefined;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFindings(value: unknown): PullRequestReviewFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const finding = item as Record<string, unknown>;
    const severity =
      finding.severity === "blocking" || finding.severity === "warning" || finding.severity === "note"
        ? finding.severity
        : undefined;
    if (!severity || typeof finding.title !== "string" || typeof finding.details !== "string") return [];
    return [{ severity, title: finding.title, details: finding.details }];
  });
}

function normalizeChecks(value: unknown): PullRequestReviewCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const check = item as Record<string, unknown>;
    const status =
      check.status === "passed" || check.status === "failed" || check.status === "blocked"
        ? check.status
        : undefined;
    if (!status || typeof check.name !== "string" || typeof check.summary !== "string") return [];
    return [{ name: check.name, status, summary: check.summary }];
  });
}

function shortSha(value: string): string {
  return value.slice(0, 10);
}
