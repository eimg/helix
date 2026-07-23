const state = {
  reviews: [],
  selectedId: null,
  filter: "",
  source: null,
  sourceReviewId: null,
  reviewsRenderKey: null,
  detailRenderKey: null,
  loading: false,
};

const els = {
  activeList: document.getElementById("active-review-list"),
  historyList: document.getElementById("review-history-list"),
  activeCount: document.getElementById("active-review-count"),
  historyCount: document.getElementById("history-review-count"),
  detail: document.getElementById("review-detail"),
  refresh: document.getElementById("refresh-reviews"),
  filters: [...document.querySelectorAll("[data-review-filter]")],
};

async function api(path) {
  const response = await fetch(path);
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || response.statusText);
  }
  return response.json();
}

async function loadReviews({ preserveSelection = true, forceRender = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  try {
    const reviews = await api("/pr-reviews?limit=100");
    const renderKey = JSON.stringify(reviews);
    const changed = forceRender || renderKey !== state.reviewsRenderKey;
    state.reviews = reviews;
    state.reviewsRenderKey = renderKey;
    if (changed) renderLists();
    if (!preserveSelection || !state.selectedId) {
      const first = state.reviews.find((review) => review.live) ?? state.reviews[0];
      if (first) await selectReview(first.id);
      return;
    }
    if (changed && state.reviews.some((review) => review.id === state.selectedId)) {
      await refreshSelectedReview();
    }
  } catch (error) {
    renderPageError(error.message);
  } finally {
    state.loading = false;
  }
}

function renderLists() {
  const active = state.reviews.filter((review) => review.live);
  const history = state.reviews.filter((review) => {
    if (review.live) return false;
    if (!state.filter) return true;
    if (state.filter === "error") return review.status === "error";
    return review.decision === state.filter;
  });
  els.activeCount.textContent = String(active.length);
  els.historyCount.textContent = String(history.length);
  els.activeList.innerHTML = active.length
    ? active.map(reviewListItem).join("")
    : '<li class="review-list-empty">No active reviews.</li>';
  els.historyList.innerHTML = history.length
    ? history.map(reviewListItem).join("")
    : '<li class="review-list-empty">No matching reviews.</li>';

  for (const item of document.querySelectorAll("[data-review-id]")) {
    item.addEventListener("click", () => void selectReview(item.dataset.reviewId));
  }
}

function reviewListItem(review) {
  const selected = review.id === state.selectedId ? " active" : "";
  const status = displayStatus(review);
  return `<li>
    <button class="review-list-item${selected}" type="button" data-review-id="${escapeHtml(review.id)}">
      <span class="review-list-title">${escapeHtml(review.request.pullRequest.title)}</span>
      <span class="review-list-branch">${escapeHtml(review.request.pullRequest.headBranch)} · ${escapeHtml(shortSha(review.request.pullRequest.headSha))}</span>
      <span class="review-list-foot">
        <span>${escapeHtml(timeAgo(review.startedAt))}</span>
        <span class="pill ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>
      </span>
    </button>
  </li>`;
}

async function selectReview(id) {
  state.selectedId = id;
  state.detailRenderKey = null;
  renderLists();
  await refreshSelectedReview();
}

async function refreshSelectedReview() {
  if (!state.selectedId) return;
  try {
    const review = await api(`/pr-reviews/${encodeURIComponent(state.selectedId)}`);
    const renderKey = JSON.stringify(review);
    if (renderKey !== state.detailRenderKey) {
      renderDetail(review);
      state.detailRenderKey = renderKey;
    }
    connectReviewEvents(review);
  } catch (error) {
    renderPageError(error.message);
  }
}

function connectReviewEvents(review) {
  if (review.live && state.source && state.sourceReviewId === review.id) return;
  state.source?.close();
  state.source = null;
  state.sourceReviewId = null;
  if (!review.live) return;

  const source = new EventSource(`/pr-reviews/${encodeURIComponent(review.id)}/events`);
  state.source = source;
  state.sourceReviewId = review.id;
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data);
      if (event.type === "review_completed" || event.type === "review_error") {
        source.close();
        state.source = null;
        state.sourceReviewId = null;
      }
      void loadReviews();
    } catch {
      // Ignore malformed progress frames; the durable review snapshot remains authoritative.
    }
  };
  source.onerror = () => {
    source.close();
    if (state.source === source) {
      state.source = null;
      state.sourceReviewId = null;
    }
  };
}

function renderDetail(review) {
  const pr = review.request.pullRequest;
  const status = displayStatus(review);
  const trackerUrl = safeTrackerUrl(review);
  els.detail.innerHTML = `
    <div class="review-detail-head">
      <div>
        <p class="review-eyebrow">Local PR #${escapeHtml(pr.id)} · ${escapeHtml(pr.origin)}</p>
        <h2>${escapeHtml(pr.title)}</h2>
        <p class="review-description">${escapeHtml(pr.description || "No description provided.")}</p>
      </div>
      <span class="pill review-status ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>
    </div>

    <dl class="review-meta">
      <div><dt>Repository</dt><dd>${escapeHtml(pr.repositoryPath)}</dd></div>
      <div><dt>Branches</dt><dd>${escapeHtml(pr.baseBranch)} ← ${escapeHtml(pr.headBranch)}</dd></div>
      <div><dt>Base SHA</dt><dd><code>${escapeHtml(pr.baseSha)}</code></dd></div>
      <div><dt>Head SHA</dt><dd><code>${escapeHtml(pr.headSha)}</code></dd></div>
      <div><dt>Author</dt><dd>${escapeHtml(pr.author)}</dd></div>
      <div><dt>Started</dt><dd>${escapeHtml(formatTime(review.startedAt))}</dd></div>
    </dl>

    <div class="review-actions">
      ${trackerUrl ? `<a class="review-external-link" href="${escapeHtml(trackerUrl)}" target="_blank" rel="noreferrer">Open in Acme Issues ↗</a>` : ""}
      <span class="review-id">Review ${escapeHtml(shortId(review.id))}</span>
    </div>

    <section class="review-section">
      <h3>Activity</h3>
      ${renderActivity(review.events ?? [])}
    </section>

    <section class="review-section">
      <h3>Review outcome</h3>
      ${reviewOutcomeContext(review)}
      <p class="review-summary">${escapeHtml(review.summary || (review.live ? "Review in progress." : "No summary recorded."))}</p>
      ${review.error ? `<p class="review-error">${escapeHtml(review.error)}</p>` : ""}
    </section>

    <section class="review-section">
      <h3>Checks</h3>
      ${renderChecks(review.checks ?? [])}
    </section>

    <section class="review-section">
      <h3>Findings</h3>
      ${renderFindings(review.findings ?? [])}
    </section>

    <section class="review-section">
      <h3>Specialist reports</h3>
      ${renderReports(review.reports ?? [])}
    </section>
  `;
}

function renderActivity(events) {
  if (!events.length) return '<p class="review-section-empty">No lifecycle events were recorded for this older review.</p>';
  return `<ol class="review-timeline">${events.map((event) => `
    <li class="${escapeHtml(event.type)}">
      <span class="review-timeline-marker"></span>
      <div>
        <p><strong>${escapeHtml(eventLabel(event))}</strong><time>${escapeHtml(formatTime(event.ts))}</time></p>
        <span>${escapeHtml(event.summary)}</span>
      </div>
    </li>
  `).join("")}</ol>`;
}

function renderChecks(checks) {
  if (!checks.length) return '<p class="review-section-empty">Checks will appear as specialists finish.</p>';
  return `<div class="review-evidence-list">${checks.map((check) => `
    <article class="review-evidence ${escapeHtml(check.status)}">
      <span class="review-evidence-icon" aria-hidden="true">${checkStatusIcon(check.status)}</span>
      <div><strong>${escapeHtml(check.name)}</strong><p>${escapeHtml(check.summary)}</p></div>
    </article>
  `).join("")}</div>`;
}

function checkStatusIcon(status) {
  if (status === "passed") {
    return '<svg viewBox="0 0 16 16"><path d="M3.5 8.25 6.5 11l6-6.25"/></svg>';
  }
  if (status === "failed") {
    return '<svg viewBox="0 0 16 16"><path d="m5 5 6 6M11 5l-6 6"/></svg>';
  }
  return '<svg viewBox="0 0 16 16"><path d="M8 4.25v4.5"/><path d="M8 11.75h.01"/></svg>';
}

function renderFindings(findings) {
  if (!findings.length) return '<p class="review-section-empty">No findings recorded.</p>';
  return `<div class="review-evidence-list">${findings.map((finding) => `
    <article class="review-evidence ${escapeHtml(finding.severity)}">
      <span class="review-finding-severity">${escapeHtml(finding.severity)}</span>
      <div><strong>${escapeHtml(finding.title)}</strong><p>${escapeHtml(finding.details)}</p></div>
    </article>
  `).join("")}</div>`;
}

function renderReports(reports) {
  if (!reports.length) return '<p class="review-section-empty">Reports will appear when Reviewer and Verifier finish.</p>';
  return `<div class="review-reports">${reports.map((report) => `
    <details class="review-report">
      <summary>
        <strong>${escapeHtml(report.specialist)}</strong>
        <span class="pill ${escapeHtml(report.verdict)}">${escapeHtml(report.verdict)}</span>
      </summary>
      <p>${escapeHtml(report.summary)}</p>
      <details class="review-raw-report">
        <summary>Raw specialist output</summary>
        <pre>${escapeHtml(report.result?.output || report.result?.error || "No raw output recorded.")}</pre>
      </details>
    </details>
  `).join("")}</div>`;
}

function eventLabel(event) {
  if (event.specialist) {
    return `${event.specialist} · ${event.type.replaceAll("_", " ")}`;
  }
  return event.type.replaceAll("_", " ");
}

function displayStatus(review) {
  if (review.live) return { label: "reviewing", className: "live" };
  if (review.status === "running") return { label: "interrupted", className: "interrupted" };
  if (review.status === "error") return { label: "review error", className: "error" };
  if (review.decision === "ready_to_merge") return { label: "review passed", className: "ready_to_merge" };
  if (review.decision === "changes_requested") return { label: "review failed", className: "changes_requested" };
  if (review.decision === "blocked") return { label: "review blocked", className: "blocked" };
  return { label: review.status.replaceAll("_", " "), className: review.status };
}

function reviewOutcomeContext(review) {
  if (review.live || review.status === "running") return "";
  const outcome = review.decision === "ready_to_merge"
    ? "Ready to merge at review completion."
    : review.decision === "changes_requested"
      ? "Changes were requested at review completion."
      : review.decision === "blocked"
        ? "The review was blocked at completion."
        : "The review did not produce a merge-readiness decision.";
  return `<p class="review-outcome-context">${escapeHtml(outcome)} Acme Issues is authoritative for the current PR lifecycle.</p>`;
}

function safeTrackerUrl(review) {
  try {
    const url = new URL(review.request.callback.trackerUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.searchParams.set("pr", String(review.request.callback.pullRequestId));
    return url.toString();
  } catch {
    return "";
  }
}

function renderPageError(message) {
  els.detail.innerHTML = `<div class="review-empty"><h2>Unable to load reviews</h2><p>${escapeHtml(message)}</p></div>`;
}

function shortSha(value) {
  return String(value).slice(0, 10);
}

function shortId(value) {
  return String(value).slice(0, 8);
}

function formatTime(value) {
  return new Date(value).toLocaleString();
}

function timeAgo(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

els.refresh.addEventListener("click", () => void loadReviews({ forceRender: true }));
for (const button of els.filters) {
  button.addEventListener("click", () => {
    state.filter = button.dataset.reviewFilter;
    for (const item of els.filters) item.classList.toggle("active", item === button);
    renderLists();
  });
}

void loadReviews({ preserveSelection: false });
setInterval(() => void loadReviews(), 3000);
