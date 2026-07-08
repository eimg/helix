const form = document.getElementById("run-form");
const titleEl = document.getElementById("title");
const bodyEl = document.getElementById("body");
const submitBtn = document.getElementById("submit");
const statusPill = document.getElementById("status-pill");
const logEl = document.getElementById("log");
const resultPanel = document.getElementById("result-panel");
const resultEl = document.getElementById("result");
const clearBtn = document.getElementById("clear-log");

let activeSource = null;
/** @type {Map<string, HTMLElement>} */
const workingEls = new Map();
/** @type {Set<string>} */
const activeSpecialists = new Set();

clearBtn.addEventListener("click", () => {
  logEl.innerHTML = "";
  clearAllWorking();
  showLogPlaceholder();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = titleEl.value.trim();
  const body = bodyEl.value.trim();
  if (!title) return;

  setRunning(true);
  setPill("running", "running");
  resultPanel.classList.add("hidden");
  logEl.innerHTML = "";
  clearAllWorking();

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
    await streamRun(id);
    const run = await fetchRun(id);
    showResult(run);
    setPill(run.status, run.status);
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

function showLogPlaceholder() {
  logEl.innerHTML = '<p class="log-empty">Submit a task to start a run.</p>';
}

function streamRun(id) {
  return new Promise((resolve, reject) => {
    if (activeSource) activeSource.close();
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
      // SSE closes when run finishes — fetch final state either way
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
  for (const line of formatEvent(event)) {
    appendLine(line);
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
      if (activeSpecialists.size === 0) {
        setWorking("orchestrator", "Orchestrator");
      }
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
  for (const key of [...workingEls.keys()]) {
    clearWorking(key);
  }
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
  if (run.approvalStatus === "pending") {
    parts.push(`<p>Awaiting approval</p>`);
  }
  if (run.deliverableError) {
    parts.push(`<p class="tag-fail">${escapeHtml(run.deliverableError)}</p>`);
  }
  if (run.runFile) {
    parts.push(`<p class="stat">Run file: ${escapeHtml(run.runFile)}</p>`);
  }

  resultEl.innerHTML = parts.join("");
}

function formatEvent(event) {
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
      if (d?.reason) lines.push(`<span class="detail">${escapeHtml(d.reason)}</span>`);
      break;
    }
    case "specialist_started": {
      const name = event.details?.specialist ?? event.summary;
      const task = fullText(event.details?.task ?? "");
      lines.push(`<p class="event"><span class="ts">${ts}</span> <span class="tag tag-start">→ ${escapeHtml(name)}</span> ${task ? "task" : "starting"}</p>`);
      if (task) lines.push(`<span class="detail">${escapeHtml(task)}</span>`);
      break;
    }
    case "specialist_finished": {
      const name = event.details?.specialist ?? event.summary;
      const ok = event.details?.ok !== false;
      const output = event.details?.output ?? "";
      const error = event.details?.error ?? "";
      const tag = ok ? "tag-ok" : "tag-fail";
      const icon = ok ? "✓" : "✗";
      lines.push(`<p class="event"><span class="ts">${ts}</span> <span class="tag ${tag}">${icon} ${escapeHtml(name)}</span> ${ok ? "finished" : "failed"}</p>`);
      const body = fullText(ok ? output : error || output);
      if (body) lines.push(`<span class="detail">${escapeHtml(body)}</span>`);
      break;
    }
    case "run_done":
      lines.push(section(`<span class="ts">${ts}</span> <span class="tag tag-done">■ Done</span> ${escapeHtml(event.summary)}`));
      if (event.details?.deliverable) lines.push(`<span class="detail">${escapeHtml(String(event.details.deliverable))}</span>`);
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

function fullText(text) {
  return String(text ?? "").trim();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

showLogPlaceholder();
