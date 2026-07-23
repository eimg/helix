import type { SpecialistResult } from "../engine/types.js";

export type PullRequestOrigin = "helix" | "external";
export type PullRequestReviewDecision = "ready_to_merge" | "changes_requested" | "blocked";
export type PullRequestReviewStatus = "running" | "completed" | "error";
export type PullRequestReviewEventType =
  | "review_started"
  | "workspace_preparing"
  | "workspace_prepared"
  | "specialist_started"
  | "specialist_completed"
  | "mergeability_checked"
  | "review_completed"
  | "review_error";

export interface PullRequestReviewEvent {
  ts: number;
  type: PullRequestReviewEventType;
  summary: string;
  specialist?: string;
  details?: Record<string, unknown>;
}

export interface PullRequestReviewRequest {
  pullRequest: {
    id: number;
    title: string;
    description: string;
    repositoryPath: string;
    baseBranch: string;
    baseSha: string;
    headBranch: string;
    headSha: string;
    author: string;
    origin: PullRequestOrigin;
    issue?: {
      id: number;
      title: string;
      body: string;
    };
  };
  callback: {
    trackerUrl: string;
    pullRequestId: number;
  };
  externalEventId: string;
}

export interface PullRequestReviewFinding {
  severity: "blocking" | "warning" | "note";
  title: string;
  details: string;
}

export interface PullRequestReviewCheck {
  name: string;
  status: "passed" | "failed" | "blocked";
  summary: string;
}

export interface PullRequestSpecialistReport {
  specialist: string;
  verdict: "pass" | "fail" | "blocked";
  summary: string;
  findings: PullRequestReviewFinding[];
  checks: PullRequestReviewCheck[];
  result: SpecialistResult;
}

export interface PullRequestReview {
  id: string;
  request: PullRequestReviewRequest;
  status: PullRequestReviewStatus;
  startedAt: number;
  finishedAt?: number;
  decision?: PullRequestReviewDecision;
  summary: string;
  findings: PullRequestReviewFinding[];
  checks: PullRequestReviewCheck[];
  reports: PullRequestSpecialistReport[];
  events: PullRequestReviewEvent[];
  error?: string;
}

export interface PullRequestReviewCallbackPayload {
  event: "pr.review.started" | "pr.review.completed";
  review: {
    id: string;
    status: PullRequestReviewStatus;
    headSha: string;
    startedAt: number;
    finishedAt?: number;
    decision?: PullRequestReviewDecision;
    summary?: string;
    findings?: PullRequestReviewFinding[];
    checks?: PullRequestReviewCheck[];
  };
  pullRequest: {
    id: number;
  };
}
