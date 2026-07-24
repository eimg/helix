import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BootstrapAcceptedResult,
  BootstrapExecuteResult,
  BootstrapPreview,
  WorkspaceStatus,
} from "../../src/inception/service";
import type { InceptionJob } from "../../src/inception/job";
import { api } from "./api";

type BootstrapResult = BootstrapPreview | BootstrapExecuteResult | BootstrapAcceptedResult;

export function BootstrapPage() {
  const client = useQueryClient();
  const workspace = useQuery({
    queryKey: ["workspace"],
    queryFn: () => api<WorkspaceStatus>("/workspace"),
    refetchInterval: (query) => {
      const state = query.state.data?.bootstrap.state;
      return state === "running" ? 1500 : false;
    },
  });
  const [exportPath, setExportPath] = useState("");
  const [force, setForce] = useState(false);
  const [last, setLast] = useState<BootstrapResult | null>(null);

  const dryRun = useMutation({
    mutationFn: () =>
      api<BootstrapPreview>("/bootstrap", {
        method: "POST",
        body: JSON.stringify({ exportPath: exportPath.trim(), dryRun: true, force }),
      }),
    onSuccess: (data) => setLast(data),
  });

  const execute = useMutation({
    mutationFn: () =>
      api<BootstrapExecuteResult | BootstrapAcceptedResult>("/bootstrap", {
        method: "POST",
        body: JSON.stringify({ exportPath: exportPath.trim(), execute: true, force }),
      }),
    onSuccess: async (data) => {
      setLast(data);
      await client.invalidateQueries({ queryKey: ["workspace"] });
      await client.invalidateQueries({ queryKey: ["manage-inception-agents"] });
      await client.invalidateQueries({ queryKey: ["manage-inception-skills"] });
      await client.invalidateQueries({ queryKey: ["config-snapshot"] });
    },
  });

  const runAgents = useMutation({
    mutationFn: () =>
      api<BootstrapExecuteResult | BootstrapAcceptedResult>("/bootstrap", {
        method: "POST",
        body: JSON.stringify({
          runAgents: true,
          exportPath: exportPath.trim() || undefined,
        }),
      }),
    onSuccess: async (data) => {
      setLast(data);
      await client.invalidateQueries({ queryKey: ["workspace"] });
    },
  });

  const status = workspace.data;
  const specialists = status?.inception.specialists ?? [];
  const skills = status?.inception.skills ?? [];
  const state = status?.bootstrap.state;
  const available = state === "ready";
  const completed = state === "completed";
  const canRunAgents = status?.bootstrap.canRunAgents === true;
  const running = state === "running";
  const failed = state === "failed";
  const awaitingAgents = state === "awaiting_agents";
  const busy = dryRun.isPending || execute.isPending || runAgents.isPending || running;
  const error =
    dryRun.error?.message ??
    execute.error?.message ??
    runAgents.error?.message ??
    workspace.error?.message;
  const job = status?.bootstrap.job;

  const submitDryRun = (event: FormEvent) => {
    event.preventDefault();
    if (!exportPath.trim() || !available) return;
    dryRun.mutate();
  };

  const chipLabel = workspace.isPending
    ? "checking"
    : running
      ? "agents running"
      : awaitingAgents
        ? "awaiting agents"
        : failed
          ? "failed"
          : available
            ? busy
              ? "working"
              : "ready"
            : completed
              ? "done"
              : "unavailable";
  const chipTone =
    running || (available && busy)
      ? "running"
      : completed
        ? "done"
        : failed
          ? "error"
          : awaitingAgents
            ? "running"
            : workspace.isPending
              ? "idle"
              : available
                ? "done"
                : "error";

  return (
    <main className="workspace bootstrap-workspace">
      <div className="top-grid">
        <section className="panel form-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">
                {completed || awaitingAgents || failed || running
                  ? "Project inception"
                  : "Empty-workspace inception"}
              </span>
              <h2>Bootstrap</h2>
              <p className="panel-description">
                {completed
                  ? "This project's bootstrap is complete. Here's the inception status and foundation outcome."
                  : awaitingAgents || failed
                    ? "Export is on disk. Run architect → scaffolder → validator to build the project foundation (requires OPENROUTER_API_KEY in .env)."
                    : running
                      ? "Inception agents are building the project foundation…"
                      : "Load a Prelude export, then create git + Helix wiring and run bootstrap specialists with auto-loaded inception skills."}
              </p>
            </div>
            <StatusChip label={chipLabel} tone={chipTone} />
          </div>

          {status && completed && (
            <div className="bootstrap-banner bootstrap-banner-success" role="status">
              <p>{status.bootstrap.reason}</p>
              {job && <JobProgress job={job} />}
              <div className="form-actions" style={{ marginTop: 10 }}>
                <a className="btn btn-primary" href="/">Open Run</a>
                <a className="btn btn-ghost" href="/manage">Manage</a>
                <a className="btn btn-ghost" href="/reviews">PR Reviews</a>
              </div>
            </div>
          )}

          {status && state === "blocked" && (
            <p className="bootstrap-banner bootstrap-banner-blocked" role="status">
              {status.bootstrap.reason}
            </p>
          )}

          {status && (awaitingAgents || failed || running) && (
            <div
              className={`bootstrap-banner ${failed ? "bootstrap-banner-blocked" : running ? "" : "bootstrap-banner-success"}`}
              role="status"
            >
              <p>{status.bootstrap.reason}</p>
              {job && <JobProgress job={job} />}
              {(canRunAgents || failed) && !running && (
                <div className="agent-run-box">
                  <label className="field">
                    <span>Prelude export (optional if already stored)</span>
                    <div className="agent-run-row">
                      <input
                        type="text"
                        value={exportPath}
                        onChange={(event) => setExportPath(event.target.value)}
                        placeholder="/path/to/prelude/data/exports/1/v1"
                        disabled={busy}
                      />
                      <button
                        className="btn btn-primary"
                        type="button"
                        disabled={busy}
                        onClick={() => runAgents.mutate()}
                      >
                        {runAgents.isPending ? "Starting…" : failed ? "Retry agents" : "Run inception agents"}
                      </button>
                    </div>
                  </label>
                </div>
              )}
            </div>
          )}

          {status && available && !status.empty && (
            <p className="bootstrap-banner" role="status">
              Extra files in this folder ({status.foreignEntries.slice(0, 4).join(", ")}
              {status.foreignEntries.length > 4 ? ", …" : ""}). Turn on force to execute anyway.
            </p>
          )}

          {available && (
            <form onSubmit={submitDryRun}>
              <label className="field">
                <span>Prelude export directory</span>
                <input
                  type="text"
                  value={exportPath}
                  onChange={(event) => setExportPath(event.target.value)}
                  placeholder="/path/to/prelude/data/exports/1/v1"
                  disabled={!available || busy}
                  required
                />
              </label>
              <label className="force-row">
                <input
                  type="checkbox"
                  checked={force}
                  onChange={(event) => setForce(event.target.checked)}
                  disabled={!available || busy}
                />
                Force overwrite / allow non-empty folder
              </label>
              <div className="form-actions">
                <button className="btn btn-ghost" type="submit" disabled={!available || busy || !exportPath.trim()}>
                  {dryRun.isPending ? "Validating…" : "Dry run"}
                </button>
                <button
                  className="btn btn-primary"
                  type="button"
                  disabled={!available || busy || !exportPath.trim()}
                  onClick={() => {
                    if (
                      confirm(
                        "Create git + Helix scaffolding, then run architect → scaffolder → validator?",
                      )
                    ) {
                      execute.mutate();
                    }
                  }}
                >
                  {execute.isPending ? "Starting…" : "Execute"}
                </button>
              </div>
            </form>
          )}
          {error && <p className="form-error">{error}</p>}
        </section>

        <section className="panel bootstrap-side-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Workspace</span>
              <h2>This folder</h2>
            </div>
          </div>
          {workspace.isPending && <p className="empty-row">Checking workspace…</p>}
          {status && (
            <>
              <div className="config-kv bootstrap-kv">
                <div className="kv-row"><span>Path</span><code>{status.cwd}</code></div>
                <div className="kv-row"><span>Git</span><code>{status.hasGit ? "yes" : "will create"}</code></div>
                <div className="kv-row"><span>Helix</span><code>{status.hasHelixConfig ? "scaffolded" : "will create"}</code></div>
                <div className="kv-row"><span>Empty</span><code>{status.empty ? "yes" : "no"}</code></div>
                <div className="kv-row"><span>State</span><code>{status.bootstrap.state}</code></div>
                <div className="kv-row"><span>Roles</span><code>{status.inception.roles.join(" → ")}</code></div>
              </div>
              <div className="bootstrap-specialists">
                <div className="manage-subheading">
                  <h3>Bootstrap specialists</h3>
                  <span>{specialists.length}</span>
                </div>
                <ul className="bootstrap-specialist-list">
                  {specialists.map((item) => (
                    <li key={item.name}>
                      <div className="resource-title">
                        <strong>{item.name}</strong>
                        <span className={`resource-source ${item.source}`}>{item.source.replace("_", " ")}</span>
                      </div>
                      <span>{item.description}</span>
                    </li>
                  ))}
                  {!specialists.length && (
                    <li className="inventory-empty">No bootstrap specialists resolved.</li>
                  )}
                </ul>
              </div>
              <div className="bootstrap-specialists">
                <div className="manage-subheading">
                  <h3>Bootstrap skills</h3>
                  <span>{skills.length}</span>
                </div>
                <p className="inventory-note">
                  Auto-loaded into architect / scaffolder / validator sessions. Edit via Manage.
                </p>
                <ul className="bootstrap-specialist-list">
                  {skills.map((item) => (
                    <li key={item.name}>
                      <div className="resource-title">
                        <strong>{item.name}</strong>
                        <span className={`resource-source ${item.source}`}>{item.source.replace("_", " ")}</span>
                      </div>
                      <span>{item.relativePath}</span>
                    </li>
                  ))}
                  {!skills.length && (
                    <li className="inventory-empty">No bootstrap skills resolved.</li>
                  )}
                </ul>
              </div>
            </>
          )}
        </section>
      </div>

      {last && <BootstrapResultPanel result={last} />}
    </main>
  );
}

function JobProgress({ job }: { job: InceptionJob }) {
  return (
    <ul className="bootstrap-specialist-list job-progress-list" style={{ marginTop: 12 }}>
      {job.roles.map((role) => (
        <li key={role.role} className={`job-role job-role-${role.status}`}>
          <div className="resource-title">
            <span className="job-role-label">
              <span
                className={`job-dot ${role.status === "running" ? "job-pulse" : `job-dot-${role.status}`}`}
                aria-hidden="true"
              />
              <strong>{role.role}</strong>
            </span>
            <span className={`status-pill ${roleStatusTone(role.status)}`}>{role.status}</span>
          </div>
          {role.error && <span>{role.error}</span>}
        </li>
      ))}
    </ul>
  );
}

function roleStatusTone(status: string): string {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "pending":
    default:
      return "pending";
  }
}

function BootstrapResultPanel({ result }: { result: BootstrapResult }) {
  const preview = result.dryRun ? result : result.preview;
  const materialize = result.dryRun ? null : result.materialize;
  const job = result.dryRun ? null : "job" in result ? result.job : null;
  const previewSkills = preview.skills ?? [];
  const accepted = !result.dryRun && "accepted" in result && result.accepted;
  return (
    <section className="panel result-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">
            {result.dryRun ? "Dry run result" : accepted ? "Bootstrap started" : "Bootstrap result"}
          </span>
          <h2>{preview.pickup.name} · v{preview.pickup.version}</h2>
        </div>
        <StatusChip
          label={result.dryRun ? "preview" : accepted ? "running" : job?.status ?? "done"}
          tone={result.dryRun || accepted || job?.status === "running_agents" ? "running" : "done"}
        />
      </div>
      <div className="config-kv bootstrap-kv">
        <div className="kv-row"><span>Export</span><code>{preview.pickup.exportDir}</code></div>
        <div className="kv-row">
          <span>Brief</span>
          <code>{preview.pickup.brief.replace(/\s+/g, " ").trim().slice(0, 180) || "(empty)"}</code>
        </div>
        <div className="kv-row">
          <span>Documents</span>
          <code>{preview.pickup.documents} in manifest · {preview.pickup.documentsOnDisk} on disk</code>
        </div>
        <div className="kv-row"><span>Artifacts</span><code>{preview.pickup.artifacts}</code></div>
        <div className="kv-row"><span>Primer notes</span><code>{preview.pickup.primerNotes}</code></div>
        <div className="kv-row">
          <span>Skills</span>
          <code>
            {previewSkills.length
              ? previewSkills.map((item) => `${item.name} (${item.source.replace("_", " ")})`).join(", ")
              : "none"}
          </code>
        </div>
        {materialize && (
          <>
            <div className="kv-row"><span>Git</span><code>initialized</code></div>
            <div className="kv-row">
              <span>Wrote</span>
              <code>
                {materialize.documentsWritten} docs · {materialize.artifactsWritten} artifacts ·{" "}
                {materialize.primerNotesWritten} primer
              </code>
            </div>
            <div className="kv-row"><span>Target</span><code>{materialize.targetDir}</code></div>
          </>
        )}
      </div>
      {job && <JobProgress job={job} />}
      {!result.dryRun && job?.status === "completed" && (
        <p className="bootstrap-banner bootstrap-banner-success">
          Inception agents finished. PR Reviews is available — start a run when ready.
        </p>
      )}
      {!result.dryRun && accepted && (
        <p className="bootstrap-banner">
          Agents are running in the background. This page polls until they finish.
        </p>
      )}
    </section>
  );
}

function StatusChip({ label, tone }: { label: string; tone: "idle" | "running" | "done" | "error" }) {
  return <span className={`status-pill ${tone === "idle" ? "" : tone}`}>{label}</span>;
}
