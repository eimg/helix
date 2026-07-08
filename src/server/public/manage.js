const form = document.getElementById("manage-form");
const promptEl = document.getElementById("prompt");
const submitBtn = document.getElementById("submit");
const followUpBtn = document.getElementById("follow-up");
const statusPill = document.getElementById("status-pill");
const logEl = document.getElementById("log");
const previewPanel = document.getElementById("preview-panel");
const previewEl = document.getElementById("preview");
const applyBtn = document.getElementById("apply");
const discardBtn = document.getElementById("discard");
const forceEl = document.getElementById("force-overwrite");
const clearBtn = document.getElementById("clear-log");
const inventoryEl = document.getElementById("inventory");

let sessionId = null;
let activeSource = null;
let currentDrafts = null;

loadInventory();

clearBtn.addEventListener("click", () => {
  logEl.innerHTML = "";
  showLogPlaceholder();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = promptEl.value.trim();
  if (!text) return;

  if (sessionId) {
    await sendFollowUp(text);
    return;
  }

  await startSession(text);
});

followUpBtn.addEventListener("click", async () => {
  const text = promptEl.value.trim();
  if (!text || !sessionId) return;
  await sendFollowUp(text);
});

applyBtn.addEventListener("click", async () => {
  if (!sessionId || !currentDrafts?.length) return;
  setBusy(true);
  try {
    const res = await fetch(`/manage/sessions/${sessionId}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: forceEl.checked }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    appendLine(formatEvent({ type: "applied", summary: data.events?.at(-1)?.summary ?? "Applied" }));
    setPill("applied", "applied");
    previewPanel.classList.add("hidden");
    resetSession();
    await loadInventory();
  } catch (err) {
    appendLine(formatError(err instanceof Error ? err.message : String(err)));
  } finally {
    setBusy(false);
  }
});

discardBtn.addEventListener("click", async () => {
  if (!sessionId) return;
  setBusy(true);
  try {
    await fetch(`/manage/sessions/${sessionId}/discard`, { method: "POST" });
    appendLine(`<p class="event"><span class="tag tag-muted">Discarded</span> session closed</p>`);
    previewPanel.classList.add("hidden");
    resetSession();
    setPill("idle", "idle");
  } finally {
    setBusy(false);
  }
});

async function loadInventory() {
  try {
    const [agents, skills] = await Promise.all([
      fetch("/manage/agents").then((r) => r.json()),
      fetch("/manage/skills").then((r) => r.json()),
    ]);
    const agentText =
      agents.length === 0
        ? "No agents"
        : agents.map((a) => `<li><strong>${escapeHtml(a.name)}</strong> — ${escapeHtml(a.description || a.relativePath)}</li>`).join("");
    const skillText =
      skills.length === 0
        ? "No skills"
        : skills.map((s) => `<li><strong>${escapeHtml(s.name)}</strong> <span class="muted">${escapeHtml(s.relativePath)}</span></li>`).join("");
    inventoryEl.innerHTML = `<div class="inventory-grid"><div><h3>Agents</h3><ul>${agentText}</ul></div><div><h3>Skills</h3><ul>${skillText}</ul></div></div>`;
  } catch {
    inventoryEl.innerHTML = `<p class="muted">Could not load inventory</p>`;
  }
}

async function startSession(prompt) {
  setBusy(true);
  setPill("active", "working");
  logEl.innerHTML = "";
  previewPanel.classList.add("hidden");
  currentDrafts = null;

  try {
    const res = await fetch("/manage/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    sessionId = data.id;
    followUpBtn.classList.remove("hidden");
    promptEl.value = "";
    promptEl.placeholder = "Follow up — refine the draft or ask a question…";

    await streamSession(sessionId);
    const session = await fetchSession(sessionId);
    showDrafts(session.drafts);
    setPill(session.status, session.status);
  } catch (err) {
    appendLine(formatError(err instanceof Error ? err.message : String(err)));
    setPill("error", "error");
    resetSession();
  } finally {
    setBusy(false);
  }
}

async function sendFollowUp(content) {
  if (!sessionId) return;
  setBusy(true);
  setPill("active", "working");
  try {
    const res = await fetch(`/manage/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const session = await res.json();
    if (!res.ok) throw new Error(session.error || `HTTP ${res.status}`);

    appendLine(`<p class="event"><span class="tag tag-user">You</span> ${escapeHtml(content)}</p>`);
    if (session.messages.at(-1)?.role === "assistant") {
      appendLine(`<p class="event"><span class="tag tag-assistant">Assistant</span> ${escapeHtml(session.messages.at(-1).content)}</p>`);
    }
    promptEl.value = "";
    showDrafts(session.drafts);
    setPill(session.status, session.status);
  } catch (err) {
    appendLine(formatError(err instanceof Error ? err.message : String(err)));
  } finally {
    setBusy(false);
  }
}

function streamSession(id) {
  return new Promise((resolve) => {
    if (activeSource) activeSource.close();
    const source = new EventSource(`/manage/sessions/${id}/events?live=1`);
    activeSource = source;

    source.onmessage = (msg) => {
      let event;
      try {
        event = JSON.parse(msg.data);
      } catch {
        return;
      }
      handleEvent(event);
      if (event.type === "assistant_replied" || event.type === "applied" || event.type === "error") {
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

async function fetchSession(id) {
  const res = await fetch(`/manage/sessions/${id}`);
  if (!res.ok) throw new Error(`Failed to load session ${id}`);
  return res.json();
}

function handleEvent(event) {
  const html = formatEvent(event);
  if (html) appendLine(html);

  if (event.type === "draft_updated" && event.details?.drafts) {
    previewPanel.classList.remove("hidden");
  }
}

function showDrafts(drafts) {
  if (!drafts?.length) {
    previewPanel.classList.add("hidden");
    currentDrafts = null;
    return;
  }
  currentDrafts = drafts;
  previewPanel.classList.remove("hidden");
  previewEl.innerHTML = drafts
    .map(
      (d) =>
        `<details open><summary>${escapeHtml(d.relativePath)} <span class="tag tag-draft">${escapeHtml(d.kind)}</span></summary><pre>${escapeHtml(d.content)}</pre></details>`,
    )
    .join("");
}

function resetSession() {
  sessionId = null;
  currentDrafts = null;
  followUpBtn.classList.add("hidden");
  promptEl.placeholder = "Create a verifier that runs eslint and tsc…";
  if (activeSource) {
    activeSource.close();
    activeSource = null;
  }
}

function setBusy(busy) {
  submitBtn.disabled = busy;
  followUpBtn.disabled = busy;
  applyBtn.disabled = busy;
  discardBtn.disabled = busy;
  promptEl.disabled = busy;
}

function setPill(klass, label) {
  statusPill.className = `pill ${klass}`;
  statusPill.textContent = label;
}

function showLogPlaceholder() {
  logEl.innerHTML = '<p class="log-empty">Describe an agent or skill to create or edit.</p>';
}

function appendLine(html) {
  const empty = logEl.querySelector(".log-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.innerHTML = html;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

function formatError(message) {
  return `<p class="event"><span class="tag tag-error">✗ error</span> ${escapeHtml(message)}</p>`;
}

function formatEvent(event) {
  const ts = timeStr(event.ts);
  switch (event.type) {
    case "session_started":
      return `<p class="event section"><span class="ts">${ts}</span> <span class="tag tag-run">▶ Session</span> started</p>`;
    case "message_sent":
      return `<p class="event"><span class="tag tag-user">You</span> ${escapeHtml(event.details?.content ?? event.summary)}</p>`;
    case "assistant_replied":
      return `<p class="event"><span class="tag tag-assistant">Assistant</span> ${escapeHtml(event.details?.message ?? event.summary)}</p>`;
    case "draft_updated":
      return `<p class="event"><span class="tag tag-draft">Draft</span> ${escapeHtml(event.summary)}</p>`;
    case "applied":
      return `<p class="event"><span class="tag tag-done">✓ Applied</span> ${escapeHtml(event.summary)}</p>`;
    case "error":
      return `<p class="event"><span class="tag tag-error">✗ Error</span> ${escapeHtml(event.summary)}</p>`;
    default:
      return `<p class="event"><span class="ts">${ts}</span> ${escapeHtml(event.summary)}</p>`;
  }
}

function timeStr(ts) {
  return new Date(ts).toISOString().slice(11, 19);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

showLogPlaceholder();
