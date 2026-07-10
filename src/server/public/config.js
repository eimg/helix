/**
 * Config tab — read-only observability for resolved Helix settings.
 */
const root = document.getElementById("config-root");
const statusEl = document.getElementById("config-status");
const refreshBtn = document.getElementById("refresh-config");

refreshBtn.addEventListener("click", () => loadSnapshot());
loadSnapshot();

async function loadSnapshot() {
  statusEl.textContent = "Loading…";
  root.innerHTML = `<p class="muted">Loading snapshot…</p>`;
  try {
    const res = await fetch("/config/snapshot");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();
    root.innerHTML = renderSnapshot(snap);
    statusEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    root.innerHTML = `<p class="config-error">Failed to load config: ${escapeHtml(msg)}</p>`;
    statusEl.textContent = "Error";
  }
}

function renderSnapshot(s) {
  return [
    section("Active models", renderModels(s)),
    section("Provider & auth", renderProvider(s)),
    section("Flags & paths", renderFlags(s)),
    section("Workflow", renderWorkflow(s)),
    section("Merge gate & deliverable", renderGate(s)),
    section("Triggers", renderTriggers(s)),
    section("Repo context", renderRepoContext(s)),
    section("Resources", renderResources(s)),
    section("Raw wiring config", `<pre class="config-raw">${escapeHtml(JSON.stringify(s.config, null, 2))}</pre>`),
  ].join("");
}

function section(title, body) {
  return `<section class="panel config-section">
    <div class="panel-head"><h2>${escapeHtml(title)}</h2></div>
    ${body}
  </section>`;
}

function renderModels(s) {
  const orch = s.models.orchestrator;
  const rows = s.models.specialists
    .map((sp) => {
      const model = sp.model.value ?? "—";
      const wf = sp.inWorkflow
        ? `<span class="pill done">workflow</span>`
        : `<span class="pill">idle</span>`;
      return `<tr>
        <td><code>${escapeHtml(sp.name)}</code></td>
        <td><code>${escapeHtml(model)}</code></td>
        <td>${sourceBadge(sp.model.source)}${detailHint(sp.model.detail)}</td>
        <td>${wf}</td>
      </tr>`;
    })
    .join("");

  return `<div class="config-kv">
    <div class="config-kv-row">
      <span class="config-k">Orchestrator</span>
      <span class="config-v"><code>${escapeHtml(orch.value)}</code> ${sourceBadge(orch.source)}${detailHint(orch.detail)}</span>
    </div>
  </div>
  <table class="config-table">
    <thead>
      <tr><th>Specialist</th><th>Model</th><th>Source</th><th></th></tr>
    </thead>
    <tbody>${rows || `<tr><td colspan="4" class="muted">No specialists loaded</td></tr>`}</tbody>
  </table>`;
}

function renderProvider(s) {
  const authOk = s.provider.authConfigured;
  return `<div class="config-kv">
    ${kv("Provider", `<code>${escapeHtml(s.provider.name)}</code>`)}
    ${kv("API key env", `<code>${escapeHtml(s.provider.apiKeyEnv)}</code>`)}
    ${kv(
      "Auth",
      `${authOk
        ? `<span class="pill done">configured</span>`
        : `<span class="pill error">missing</span>`}
       ${sourceBadge(s.provider.authSource)}${detailHint(s.provider.authDetail)}`
    )}
    ${kv(
      "Models file",
      `${s.provider.modelsFile.value
        ? `<code>${escapeHtml(s.provider.modelsFile.value)}</code>`
        : `<span class="muted">${escapeHtml(s.provider.modelsFile.detail ?? "built-in")}</span>`}
       ${sourceBadge(s.provider.modelsFile.source)}`
    )}
  </div>`;
}

function renderFlags(s) {
  return `<div class="config-kv">
    ${kv("Extensions", boolPill(s.flags.extensionsEnabled), "extensions.enabled")}
    ${kv("Repo context", boolPill(s.flags.repoContextEnabled), "repoContext.enabled")}
    ${kv("GitHub PR deliverable", boolPill(s.flags.deliverablePr), "deliverable.pr")}
    ${kv("Helix dir", `<code>${escapeHtml(s.paths.helixDir)}</code>`)}
    ${kv("Repo cwd", `<code>${escapeHtml(s.paths.cwd)}</code>`)}
    ${kv("pi agent dir", `<code>${escapeHtml(s.paths.piAgentDir)}</code> <span class="muted">— auth/models fallback</span>`)}
    ${kv(".env", s.paths.envFileExists
      ? `<code>${escapeHtml(s.paths.envFile)}</code> <span class="pill done">present</span>`
      : `<code>${escapeHtml(s.paths.envFile)}</code> <span class="pill">absent</span>`)}
  </div>`;
}

function renderWorkflow(s) {
  const steps = s.workflow.steps.map((step) => `<code class="config-chip">${escapeHtml(step)}</code>`).join(" → ");
  const loops = Object.entries(s.workflow.loops ?? {});
  const loopRows = loops.length
    ? loops
        .map(
          ([name, loop]) =>
            `<tr><td><code>${escapeHtml(name)}</code></td><td>→ <code>${escapeHtml(loop.backTo)}</code></td><td>max ${loop.maxRetries}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="muted">No loops configured</td></tr>`;

  return `<div class="config-kv">
    ${kv("Sequence", steps || `<span class="muted">empty</span>`)}
    ${kv("Max iterations", String(s.workflow.maxIterations))}
  </div>
  <table class="config-table">
    <thead><tr><th>Loop</th><th>Back to</th><th>Retries</th></tr></thead>
    <tbody>${loopRows}</tbody>
  </table>`;
}

function renderGate(s) {
  const g = s.mergeGate ?? {};
  return `<div class="config-kv">
    ${kv("Auto merge", g.autoMerge === undefined ? mutedDash() : boolPill(g.autoMerge), "autoMerge")}
    ${kv("Max diff lines", g.maxDiffLines === undefined ? mutedDash() : String(g.maxDiffLines), "maxDiffLines")}
    ${kv("Max files", g.maxFiles === undefined ? mutedDash() : String(g.maxFiles), "maxFiles")}
    ${kv("Require verifier pass", g.requireVerifierPass === undefined ? mutedDash() : boolPill(g.requireVerifierPass), "requireVerifierPass")}
    ${kv("GitHub PR deliverable", boolPill(s.flags.deliverablePr), "deliverable.pr")}
  </div>`;
}

function renderTriggers(s) {
  const gh = s.triggers?.github;
  if (!gh) {
    return `<p class="muted">No GitHub trigger configured (inline / HTTP runs only).</p>`;
  }
  return `<div class="config-kv">
    ${kv("Repo", `<code>${escapeHtml(gh.repo)}</code>`)}
    ${kv("Label filter", gh.labelFilter ? `<code>${escapeHtml(gh.labelFilter)}</code>` : mutedDash())}
    ${kv("Mode", `<code>${escapeHtml(gh.mode ?? "poll")}</code>`)}
    ${kv("Interval", gh.intervalSec ? `${gh.intervalSec}s` : mutedDash())}
  </div>`;
}

function renderRepoContext(s) {
  const files = (s.repoContext.files ?? [])
    .map((f) => `<li><code>${escapeHtml(f)}</code></li>`)
    .join("");
  return `<div class="config-kv">
    ${kv("Enabled", boolPill(s.repoContext.enabled))}
  </div>
  <p class="config-note">Bootstrap allowlist</p>
  <ul class="config-list">${files || `<li class="muted">none</li>`}</ul>`;
}

function renderResources(s) {
  const skills = (s.resources.skills ?? [])
    .map((sk) => `<li><code>${escapeHtml(sk.name)}</code> <span class="muted">${escapeHtml(sk.relativePath)}</span></li>`)
    .join("");
  return `<div class="config-kv">
    ${kv("Agents dir", `<code>${escapeHtml(s.resources.agentsDir)}</code>`)}
    ${kv("Skills dir", `<code>${escapeHtml(s.resources.skillsDir)}</code>`)}
  </div>
  <p class="config-note">Skills (always loaded into specialist sessions)</p>
  <ul class="config-list">${skills || `<li class="muted">none</li>`}</ul>`;
}

function kv(label, valueHtml, key) {
  const keyHint = key
    ? `<span class="config-key" title="config.json key">${escapeHtml(key)}</span>`
    : "";
  return `<div class="config-kv-row">
    <span class="config-k">${escapeHtml(label)}${keyHint}</span>
    <span class="config-v">${valueHtml}</span>
  </div>`;
}

function sourceBadge(source) {
  const label = {
    env: "env",
    default: "default",
    agent: "agent",
    pi: "pi",
    built_in: "built-in",
    none: "none",
  }[source] ?? source;
  return `<span class="source-badge source-${escapeHtml(source)}">${escapeHtml(label)}</span>`;
}

function detailHint(detail) {
  if (!detail) return "";
  return ` <span class="muted config-detail" title="${escapeAttr(detail)}">${escapeHtml(shortPath(detail))}</span>`;
}

function boolPill(on) {
  return on
    ? `<span class="pill done">on</span>`
    : `<span class="pill">off</span>`;
}

function mutedDash() {
  return `<span class="muted">—</span>`;
}

function shortPath(p) {
  if (p.length <= 56) return p;
  return `…${p.slice(-52)}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
