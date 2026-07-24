import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PullRequestReview } from "../../src/pr-control/types";
import { api, timeAgo } from "./api";

type Review = PullRequestReview & { live: boolean };

export function ReviewsPage() {
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const reviews = useQuery({
    queryKey: ["pr-reviews"],
    queryFn: () => api<Review[]>("/pr-reviews?limit=100"),
    refetchInterval: (query) => query.state.data?.some((item) => item.live) ? 2_000 : 10_000,
  });
  useEffect(() => {
    if (!selectedId && reviews.data?.length) setSelectedId(reviews.data.find((item) => item.live)?.id ?? reviews.data[0].id);
  }, [reviews.data, selectedId]);
  const detail = useQuery({
    queryKey: ["pr-review", selectedId],
    queryFn: () => api<Review>(`/pr-reviews/${selectedId}`),
    enabled: selectedId !== null,
    refetchInterval: (query) => query.state.data?.live ? 2_000 : false,
  });
  useEffect(() => {
    if (!selectedId || !detail.data?.live) return;
    const source = new EventSource(`/pr-reviews/${selectedId}/events`);
    source.onmessage = () => {
      void client.invalidateQueries({ queryKey: ["pr-review", selectedId] });
      void client.invalidateQueries({ queryKey: ["pr-reviews"] });
    };
    return () => source.close();
  }, [client, detail.data?.live, selectedId]);
  const active = reviews.data?.filter((item) => item.live) ?? [];
  const history = reviews.data?.filter((item) => !item.live && (!filter || (filter === "error" ? item.status === "error" : item.decision === filter))) ?? [];
  return (
    <main className="workspace review-workspace">
      <aside className="panel review-sidebar">
        <div className="panel-heading"><div><span className="eyebrow">PR control</span><h2>Pull request reviews</h2></div><button className="btn btn-ghost btn-sm" onClick={() => reviews.refetch()}>Refresh</button></div>
        <ReviewGroup title="Active" items={active} selectedId={selectedId} onSelect={setSelectedId} />
        <div className="review-filter">
          {["", "ready_to_merge", "changes_requested", "blocked", "error"].map((value) => (
            <button key={value || "all"} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
              {value ? value.replaceAll("_", " ") : "all"}
            </button>
          ))}
        </div>
        <ReviewGroup title="History" items={history} selectedId={selectedId} onSelect={setSelectedId} />
      </aside>
      <section className="panel review-detail-panel">
        {selectedId && detail.isPending && <Empty text="Loading review…" />}
        {detail.isError && <Empty text={detail.error.message} />}
        {detail.data && <ReviewDetail review={detail.data} />}
        {!selectedId && <Empty text="Select a review to inspect its evidence." />}
      </section>
    </main>
  );
}

function ReviewGroup({ title, items, selectedId, onSelect }: { title: string; items: Review[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return <section className="review-group"><h3>{title}<span>{items.length}</span></h3><ul>{items.map((review) => (
    <li key={review.id}><button className={selectedId === review.id ? "active" : ""} onClick={() => onSelect(review.id)}>
      <strong>{review.request.pullRequest.title}</strong>
      <span>{review.request.pullRequest.headBranch} · {review.request.pullRequest.headSha.slice(0, 10)}</span>
      <small>{timeAgo(review.startedAt)} <Status review={review} /></small>
    </button></li>
  ))}{!items.length && <li className="empty-row">No {title.toLowerCase()} reviews.</li>}</ul></section>;
}

function ReviewDetail({ review }: { review: Review }) {
  const pr = review.request.pullRequest;
  const tracker = new URL(review.request.callback.trackerUrl);
  tracker.searchParams.set("pr", String(review.request.callback.pullRequestId));
  return <article className="review-detail">
    <div className="review-detail-head"><div><span className="eyebrow">Local PR #{pr.id} · {pr.origin}</span><h2>{pr.title}</h2><p>{pr.description || "No description provided."}</p></div><Status review={review} /></div>
    <dl className="meta-grid">
      <div><dt>Repository</dt><dd>{pr.repositoryPath}</dd></div><div><dt>Branches</dt><dd>{pr.headBranch} → {pr.baseBranch}</dd></div>
      <div><dt>Base SHA</dt><dd><code>{pr.baseSha}</code></dd></div><div><dt>Head SHA</dt><dd><code>{pr.headSha}</code></dd></div>
      <div><dt>Author</dt><dd>{pr.author}</dd></div><div><dt>Started</dt><dd>{new Date(review.startedAt).toLocaleString()}</dd></div>
    </dl>
    <a className="result-link" href={tracker.toString()} target="_blank" rel="noreferrer">Open in Acme Issues ↗</a>
    <EvidenceSection title="Activity">{review.events.length ? <ol className="timeline">{review.events.map((event, index) => {
      const tone = event.type === "review_error"
        ? "error"
        : event.type === "review_completed" || event.type === "mergeability_checked" || event.type === "specialist_completed"
          ? "complete"
          : "";
      return <li className={tone} key={`${event.ts}-${index}`}><span className="timeline-marker" aria-hidden="true" /><div><strong>{event.specialist ? `${event.specialist} · ` : ""}{event.type.replaceAll("_", " ")}</strong><time>{new Date(event.ts).toLocaleTimeString()}</time><p>{event.summary}</p></div></li>;
    })}</ol> : <Empty text="No lifecycle events recorded." />}</EvidenceSection>
    <EvidenceSection title="Review outcome"><p className="review-summary">{review.summary || (review.live ? "Review in progress." : "No summary recorded.")}</p>{review.error && <p className="error-text">{review.error}</p>}</EvidenceSection>
    <EvidenceSection title="Checks"><div className="evidence-list">{review.checks.map((check) => <article className={`evidence check-evidence ${check.status}`} key={check.name}><span className="check-marker" aria-label={check.status}>{check.status === "passed" ? "✓" : check.status === "failed" ? "×" : "!"}</span><div><strong>{check.name}</strong><p>{check.summary}</p></div></article>)}{!review.checks.length && <Empty text="Checks will appear as specialists finish." />}</div></EvidenceSection>
    <EvidenceSection title="Findings"><div className="evidence-list">{review.findings.map((finding, index) => <article className={`evidence finding-evidence ${finding.severity}`} key={`${finding.title}-${index}`}><span className="finding-badge">{finding.severity}</span><div><strong>{finding.title}</strong><p>{finding.details}</p></div></article>)}{!review.findings.length && <Empty text="No findings recorded." />}</div></EvidenceSection>
    <EvidenceSection title="Specialist reports">{review.reports.map((report) => <details className="report" key={report.specialist}><summary><strong>{report.specialist}</strong><span className={`status-pill ${report.verdict}`}>{report.verdict}</span></summary><p>{report.summary}</p><details><summary>Raw specialist output</summary><pre>{report.result.output || report.result.error}</pre></details></details>)}{!review.reports.length && <Empty text="Reports will appear when specialists finish." />}</EvidenceSection>
  </article>;
}

function EvidenceSection({ title, children }: { title: string; children: React.ReactNode }) { return <section className="evidence-section"><h3>{title}</h3>{children}</section>; }
function Status({ review }: { review: Review }) {
  const value = review.live ? "reviewing" : review.status === "running" ? "interrupted" : review.status === "error" ? "error" : review.decision ?? review.status;
  return <span className={`status-pill review-status ${value}`}>{value.replaceAll("_", " ")}</span>;
}
function Empty({ text }: { text: string }) { return <p className="empty-row">{text}</p>; }
