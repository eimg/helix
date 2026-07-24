/**
 * Post-run deliverable pipeline: merge gate evaluation, PR creation, merge/approval.
 */
import type { Run } from "../engine/types.js";
import type { MergeGateConfig } from "../orchestrator/workflow.js";
import { evaluateMergeGate } from "../orchestrator/mergeGate.js";
import type { GitContext } from "../deliverable/git.js";
import type { PullRequestCreator } from "../deliverable/pr.js";

export interface DeliverablePipeline {
  finalize(
    run: Run,
    mergeGate: MergeGateConfig,
    context?: DeliverableFinalizeContext,
  ): Promise<Run>;
}

export interface DeliverableFinalizeContext {
  /** Run-specific checkout in which specialists performed implementation. */
  cwd: string;
  /** Stable canonical repository path shared with PR control. */
  repositoryPath: string;
  branch?: string;
  baseBranch?: string;
  baseSha?: string;
}

export interface DeliverablePipelineDeps {
  git: GitContext;
  pr: PullRequestCreator;
  repo?: string;
  baseBranch?: string;
}

export class DefaultDeliverablePipeline implements DeliverablePipeline {
  constructor(private readonly deps: DeliverablePipelineDeps) {}

  async finalize(run: Run, mergeGate: MergeGateConfig): Promise<Run> {
    if (run.status !== "done") {
      run.approvalStatus = "none";
      return run;
    }

    try {
      const stats = await this.deps.git.getDiffStats(this.deps.baseBranch);
      const gate = evaluateMergeGate({ stats, config: mergeGate });
      run.mergeGateResult = gate;

      const branch = await this.deps.git.getCurrentBranch();
      const title = run.issue.title;
      const body = buildPrBody(run);
      const draft = gate.action === "pending-approval";

      run.pullRequest = await this.deps.pr.create({
        title,
        body,
        branch,
        base: this.deps.baseBranch,
        draft,
        repo: this.deps.repo,
      });

      if (gate.action === "auto-merge") {
        await this.deps.pr.merge(run.pullRequest.number, this.deps.repo);
        run.approvalStatus = "approved";
      } else {
        run.approvalStatus = "pending";
      }
    } catch (err) {
      run.deliverableError = err instanceof Error ? err.message : String(err);
      run.approvalStatus = "none";
    }

    return run;
  }
}

export class NoOpDeliverablePipeline implements DeliverablePipeline {
  async finalize(run: Run): Promise<Run> {
    run.approvalStatus = "none";
    return run;
  }
}

function buildPrBody(run: Run): string {
  const parts = [
    `Helix run \`${run.id}\` for: ${run.issue.title}`,
    "",
    run.finalDecision?.kind === "done" ? run.finalDecision.reason : "",
  ];
  if (run.finalDecision?.kind === "done" && run.finalDecision.deliverable) {
    parts.push("", "## Deliverable", run.finalDecision.deliverable);
  }
  return parts.filter(Boolean).join("\n");
}

/** Approve a pending run: merge its PR. */
export async function approveRun(run: Run, pr: PullRequestCreator, repo?: string): Promise<Run> {
  if (run.approvalStatus !== "pending") {
    throw new Error(`Run ${run.id} is not pending approval (status: ${run.approvalStatus ?? "none"}).`);
  }
  if (!run.pullRequest) {
    throw new Error(`Run ${run.id} has no pull request to merge.`);
  }
  await pr.merge(run.pullRequest.number, repo);
  run.approvalStatus = "approved";
  return run;
}

/** Reject a pending run. Does not close the PR (operator can do that manually). */
export function rejectRun(run: Run): Run {
  if (run.approvalStatus !== "pending") {
    throw new Error(`Run ${run.id} is not pending approval (status: ${run.approvalStatus ?? "none"}).`);
  }
  run.approvalStatus = "rejected";
  return run;
}
