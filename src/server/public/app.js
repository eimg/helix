const form = document.getElementById("run-form");
const formPanel = document.querySelector(".form-panel");
const historyPanel = document.querySelector(".history-panel");
const titleEl = document.getElementById("title");
const bodyEl = document.getElementById("body");
const submitBtn = document.getElementById("submit");
const statusPill = document.getElementById("status-pill");
const logEl = document.getElementById("log");
const resultPanel = document.getElementById("result-panel");
const resultEl = document.getElementById("result");
const clearBtn = document.getElementById("clear-log");
const historyListEl = document.getElementById("history-list");
const refreshHistoryBtn = document.getElementById("refresh-history");

let activeSource = null;
let selectedRunId = null;
let historyPollTimer = null;
let userPinnedSelection = false;
/** @type {Set<string>} */
const knownRunIds = new Set();
let runHistory = [];
/** @type {Map<string, HTMLDetailsElement>} */
const specialistBlocks = new Map();
/** @type {Map<string, HTMLElement>} */
const workingEls = new Map();

/** @type {Set<string>} */
const activeSpecialists = new Set();

function syncHistoryHeight() {
  if (!formPanel || !historyPanel) return;
  if (window.matchMedia("(max-width: 900px)").matches) {
    historyPanel.style.removeProperty("height");
    return;
  }
  const h = Math.round(formPanel.getBoundingClientRect().height);
  if (h > 0) historyPanel.style.height = `${h}px`;
}

if (formPanel && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(() => syncHistoryHeight()).observe(formPanel);
}
window.addEventListener("resize", syncHistoryHeight);

clearBtn.addEventListener("click", () => {
  logEl.innerHTML = "";
  specialistBlocks.clear();
  clearAllWorking();
  showLogPlaceholder(selectedRunId ? "Log cleared." : undefined);
});

refreshHistoryBtn.addEventListener("click", () => void loadHistory());

historyListEl.addEventListener("click", (e) => {
  const deleteBtn = e.target.closest("[data-delete-run-id]");
  if (deleteBtn) {
    e.preventDefault();
    e.stopPropagation();
    void deleteRun(deleteBtn.dataset.deleteRunId);
    return;
  }
  const item = e.target.closest("[data-run-id]");
  if (!item) return;
  userPinnedSelection = true;
  void openRun(item.dataset.runId);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = titleEl.value.trim();
  const body = bodyEl.value.trim();
  if (!title) return;

  setRunning(true);
  setPill("running", "running");

  try {
    const res = await fetch("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, body }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const { id } = await res.json();
    userPinnedSelection = false;
    await loadHistory();
    startHistoryPoll();
    await openRun(id);
  } catch (err) {
    appendLine(formatError(err instanceof Error ? err.message : String(err)));
    setPill("error", "error");
  } finally {
    setRunning(false);
  }
});

function setRunning(running) {
  submitBtn.disabled = running;
  titleEl.disabled = running;
  bodyEl.disabled = running;
}

function setPill(klass, label) {
  statusPill.className = `pill ${klass}`;
  statusPill.textContent = label;
}

function showLogPlaceholder(message) {
  logEl.innerHTML = `<p class="log-empty">${escapeHtml(message ?? "Submit a task or select a run from history.")}</p>`;
}

async function loadHistory() {
  try {
    const res = await fetch("/runs?limit=50");
    if (!res.ok) return;
    const prevIds = new Set(knownRunIds);
    runHistory = await res.json();
    for (const run of runHistory) knownRunIds.add(run.id);
    renderHistory();

    const newLive = runHistory.filter(
      (r) => (r.live || r.status === "running") && !prevIds.has(r.id)
    );
    if (newLive.length > 0 && !userPinnedSelection) {
      void openRun(newLive[0].id);
    }
    if (runHistory.some((r) => r.live || r.status === "running")) {
      startHistoryPoll();
    }
  } catch {
    /* ignore */
  }
}

function renderHistory() {
  if (runHistory.length === 0) {
    historyListEl.innerHTML = '<li class="history-empty">No runs yet.</li>';
    requestAnimationFrame(syncHistoryHeight);
    return;
  }

  historyListEl.innerHTML = runHistory
    .map((run) => {
      const active = run.id === selectedRunId ? " active" : "";
      const live = run.live || run.status === "running";
      const pillClass = live ? "live" : run.status;
      const pillLabel = live ? "live" : run.status;
      const deleteBtn = live
        ? ""
        : `<button type="button" class="history-delete" data-delete-run-id="${escapeHtml(run.id)}" title="Delete run" aria-label="Delete run">×</button>`;
      return `<li class="history-item${active}" data-run-id="${escapeHtml(run.id)}">
        <div class="history-item-top">
          <p class="history-title" title="${escapeHtml(run.title)}">${escapeHtml(run.title)}</p>
          ${deleteBtn}
        </div>
        <div class="history-item-foot">
          <p class="history-meta">${escapeHtml(shortId(run.id))} · ${escapeHtml(timeAgo(run.startedAt))}</p>
          <span class="pill ${pillClass}">${escapeHtml(pillLabel)}</span>
        </div>
      </li>`;
    })
    .join("");
  requestAnimationFrame(syncHistoryHeight);
}

async function deleteRun(id) {
  if (!id) return;
  const run = runHistory.find((r) => r.id === id);
  const label = run?.title ? `"${run.title}"` : shortId(id);
  if (!window.confirm(`Delete run ${label}? This cannot be undone.`)) return;

  try {
    const res = await fetch(`/runs/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 204) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    knownRunIds.delete(id);
    if (selectedRunId === id) {
      if (activeSource) {
        activeSource.close();
        activeSource = null;
      }
      selectedRunId = null;
      userPinnedSelection = false;
      resultPanel.classList.add("hidden");
      setPill("idle", "idle");
      showLogPlaceholder();
    }
    await loadHistory();
  } catch (err) {
    appendLine(formatError(err instanceof Error ? err.message : String(err)));
  }
}

function startHistoryPoll() {
  if (historyPollTimer) return;
  historyPollTimer = setInterval(() => {
    void loadHistory();
    if (!selectedRunId) return;
    const selected = runHistory.find((r) => r.id === selectedRunId);
    if (selected && (selected.live || selected.status === "running")) {
      void refreshSelectedRun();
    }
  }, 2000);
}

function stopHistoryPoll() {
  if (!historyPollTimer) return;
  clearInterval(historyPollTimer);
  historyPollTimer = null;
}

async function refreshSelectedRun() {
  if (!selectedRunId) return;
  try {
    const run = await fetchRun(selectedRunId);
    setPill(run.status, run.status);
    if (run.status !== "running") showResult(run);
  } catch {
    /* ignore */
  }
}

async function openRun(id) {
  if (activeSource) {
    activeSource.close();
    activeSource = null;
  }

  selectedRunId = id;
  renderHistory();
  resultPanel.classList.add("hidden");
  logEl.innerHTML = "";
  specialistBlocks.clear();
  clearAllWorking();
  setPill("running", "running");

  try {
    await streamRun(id);
    const run = await fetchRun(id);
    showResult(run);
    setPill(run.status, run.status);
    await loadHistory();
    if (!runHistory.some((r) => r.live || r.status === "running")) stopHistoryPoll();
  } catch (err) {
    appendLine(formatError(err instanceof Error ? err.message : String(err)));
    setPill("error", "error");
  }
}

function streamRun(id) {
  return new Promise((resolve) => {
    const source = new EventSource(`/runs/${id}/events`);
    activeSource = source;

    source.onmessage = (msg) => {
      let event;
      try {
        event = JSON.parse(msg.data);
      } catch {
        return;
      }
      handleEvent(event);
      if (event.type === "run_done" || event.type === "run_escalated" || event.type === "run_error") {
        clearAllWorking();
        source.close();
        activeSource = null;
        resolve();
      }
    };

    source.onerror = () => {
      source.close();
      activeSource = null;
      resolve();
    };
  });
}

async function fetchRun(id) {
  const res = await fetch(`/runs/${id}`);
  if (!res.ok) throw new Error(`Failed to load run ${id}`);
  return res.json();
}

function handleEvent(event) {
  if (event.type === "specialist_started") {
    handleSpecialistStarted(event);
  } else if (event.type === "specialist_activity") {
    handleSpecialistActivity(event);
  } else if (event.type === "specialist_finished") {
    handleSpecialistFinished(event);
  } else {
    for (const line of formatEvent(event)) {
      appendLine(line);
    }
  }

  switch (event.type) {
    case "run_started":
      setWorking("orchestrator", "Orchestrator");
      break;
    case "orchestrator_decided":
      clearWorking("orchestrator");
      break;
    case "specialist_started": {
      const name = event.details?.specialist ?? event.summary;
      activeSpecialists.add(name);
      setWorking(name, name);
      break;
    }
    case "specialist_finished": {
      const name = event.details?.specialist ?? event.summary;
      activeSpecialists.delete(name);
      clearWorking(name);
      if (activeSpecialists.size === 0) setWorking("orchestrator", "Orchestrator");
      break;
    }
    case "run_done":
    case "run_escalated":
    case "run_error":
    case "gate_blocked":
      clearAllWorking();
      break;
  }
}

function specialistKey(event) {
  const name = event.details?.specialist ?? event.summary;
  const invocationId = event.details?.invocationId;
  return invocationId != null ? `${name}:${invocationId}` : name;
}

function handleSpecialistStarted(event) {
  const name = event.details?.specialist ?? event.summary;
  const task = previewText(event.details?.task ?? "", 100);
  const ts = timeStr(event.ts);
  const key = specialistKey(event);

  const empty = logEl.querySelector(".log-empty");
  if (empty) empty.remove();

  const details = document.createElement("details");
  details.className = "specialist-block";
  details.dataset.specialistKey = key;
  details.innerHTML =
    `<summary class="specialist-summary">` +
    `<span class="ts">${ts}</span> ` +
    `<span class="tag tag-start">→ ${escapeHtml(name)}</span> ` +
    `<span class="specialist-status">running</span>` +
  `</summary>` +
    `<div class="specialist-body">` +
    (task ? `<p class="specialist-task">${escapeHtml(task)}</p>` : "") +
    `</div>`;
  logEl.appendChild(details);
  specialistBlocks.set(key, details);
  scrollLog();
}

function handleSpecialistActivity(event) {
  const key = specialistKey(event);
  const block = specialistBlocks.get(key);
  if (!block) return;
  const body = block.querySelector(".specialist-body");
  if (!body) return;
  const kind = event.details?.kind === "text" ? "text" : "tool";
  const line = document.createElement("p");
  line.className = `specialist-line specialist-line-${kind}`;
  line.textContent = String(event.details?.line ?? event.summary);
  body.appendChild(line);
  scrollLog();
}

function handleSpecialistFinished(event) {
  const name = event.details?.specialist ?? event.summary;
  const ok = event.details?.ok !== false;
  const key = specialistKey(event);
  const block = specialistBlocks.get(key);

  if (block) {
    const status = block.querySelector(".specialist-status");
    if (status) {
      status.className = `specialist-status ${ok ? "ok" : "fail"}`;
      status.textContent = ok ? "finished" : "failed";
    }
    const summaryTag = block.querySelector(".tag-start");
    if (summaryTag) {
      summaryTag.className = `tag ${ok ? "tag-ok" : "tag-fail"}`;
      summaryTag.textContent = `${ok ? "✓" : "✗"} ${name}`;
    }
    const output = String(event.details?.output ?? event.details?.error ?? "").trim();
    if (output) {
      const body = block.querySelector(".specialist-body");
      const hasText = body?.querySelector(".specialist-line-text");
      if (body && !hasText) {
        const line = document.createElement("p");
        line.className = "specialist-line specialist-line-text";
        line.textContent = previewText(output, 800);
        body.appendChild(line);
      }
    }
  } else {
    const ts = timeStr(event.ts);
    const tag = ok ? "tag-ok" : "tag-fail";
    const icon = ok ? "✓" : "✗";
    appendLine(
      `<p class="event"><span class="ts">${ts}</span> <span class="tag ${tag}">${icon} ${escapeHtml(name)}</span> ${ok ? "finished" : "failed"}</p>`
    );
  }
  scrollLog();
}

function setWorking(key, label) {
  clearWorking(key);
  const empty = logEl.querySelector(".log-empty");
  if (empty) empty.remove();

  const el = document.createElement("p");
  el.className = "event working";
  el.dataset.worker = key;
  el.innerHTML =
    `<span class="working-pulse" aria-hidden="true"></span>` +
    `<span class="tag tag-working">${escapeHtml(label)}</span> running…`;
  logEl.appendChild(el);
  workingEls.set(key, el);
  scrollLog();
}

function clearWorking(key) {
  const el = workingEls.get(key);
  if (el) {
    el.remove();
    workingEls.delete(key);
  }
}

function clearAllWorking() {
  activeSpecialists.clear();
  for (const key of [...workingEls.keys()]) clearWorking(key);
}

function scrollLog() {
  logEl.scrollTop = logEl.scrollHeight;
}

function appendLine(html) {
  const empty = logEl.querySelector(".log-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.innerHTML = html;
  logEl.appendChild(div);
  scrollLog();
}

function formatError(message) {
  return `<p class="event"><span class="tag tag-error">✗ error</span> ${escapeHtml(message)}</p>`;
}

function showResult(run) {
  resultPanel.classList.remove("hidden");
  const elapsed =
    run.finishedAt != null
      ? `${Math.max(1, Math.round((run.finishedAt - run.startedAt) / 1000))}s`
      : "?";
  const specialists = run.results?.length ?? 0;

  const parts = [
    `<p class="stat">${specialists} specialist${specialists === 1 ? "" : "s"} · ${elapsed} · <strong>${escapeHtml(run.status)}</strong></p>`,
  ];

  if (run.finalDecision?.kind === "done" && run.finalDecision.deliverable) {
    parts.push(`<p><strong>Deliverable</strong></p><pre>${escapeHtml(run.finalDecision.deliverable)}</pre>`);
  } else if (run.finalDecision?.kind === "escalate") {
    parts.push(`<p><strong>Reason</strong></p><pre>${escapeHtml(run.finalDecision.reason)}</pre>`);
  }

  if (run.pullRequest?.url) {
    parts.push(`<p><a href="${escapeHtml(run.pullRequest.url)}" target="_blank" rel="noopener">Pull request #${run.pullRequest.number}</a></p>`);
  }
  if (run.approvalStatus === "pending") parts.push(`<p>Awaiting approval</p>`);
  if (run.deliverableError) parts.push(`<p class="tag-fail">${escapeHtml(run.deliverableError)}</p>`);

  resultEl.innerHTML = parts.join("");
}

function formatEvent(event) {
  if (event.type === "issue_fetched") return [];

  const ts = timeStr(event.ts);
  const lines = [];

  switch (event.type) {
    case "run_started": {
      const title = event.summary.replace(/^Run for /, "");
      lines.push(section(`<span class="ts">${ts}</span> <span class="tag tag-run">▶ Run</span> ${escapeHtml(title)}`));
      break;
    }
    case "orchestrator_decided": {
      const d = event.details?.decision;
      const iter = event.details?.iteration;
      const iterLabel = iter != null ? ` · turn ${iter + 1}` : "";
      const head = d ? formatDecisionHead(d) : escapeHtml(event.summary);
      lines.push(section(`<span class="ts">${ts}</span> <span class="tag tag-orch">↳ Orchestrator${iterLabel}</span> ${escapeHtml(head)}`));
      if (d?.reason) lines.push(`<span class="detail">${escapeHtml(previewText(d.reason, 120))}</span>`);
      break;
    }
    case "specialist_started":
    case "specialist_activity":
    case "specialist_finished":
      break;
    case "run_done":
      lines.push(section(`<span class="ts">${ts}</span> <span class="tag tag-done">■ Done</span> ${escapeHtml(event.summary)}`));
      break;
    case "run_escalated":
      lines.push(section(`<span class="ts">${ts}</span> <span class="tag tag-escalated">▲ Escalated</span> ${escapeHtml(event.summary)}`));
      break;
    case "run_error":
      lines.push(section(`<span class="ts">${ts}</span> <span class="tag tag-error">✗ Error</span> ${escapeHtml(event.summary)}`));
      break;
    case "gate_blocked":
      lines.push(section(`<span class="ts">${ts}</span> <span class="tag tag-fail">⊘ Gate</span> ${escapeHtml(event.summary)}`));
      break;
    default:
      lines.push(`<p class="event"><span class="ts">${ts}</span> ${escapeHtml(event.summary)}</p>`);
  }
  return lines;
}

function section(inner) {
  return `<p class="event section">${inner}</p>`;
}

function formatDecisionHead(d) {
  if (d.kind === "run") return `run ${d.specialists.map((s) => s.specialist).join(", ")}`;
  return d.kind;
}

function timeStr(ts) {
  return new Date(ts).toISOString().slice(11, 19);
}

function timeAgo(ts) {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ago`;
}

function shortId(id) {
  return String(id).slice(0, 8);
}

function previewText(text, maxChars = 160) {
  const trimmed = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

showLogPlaceholder();
syncHistoryHeight();
void loadHistory().then(() => {
  const live = runHistory.find((r) => r.live || r.status === "running");
  if (live && !selectedRunId) void openRun(live.id);
  startHistoryPoll();
  syncHistoryHeight();
});
