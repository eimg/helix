import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BootstrapExecuteResult, BootstrapPreview, WorkspaceStatus } from "../../src/inception/service";
import { api } from "./api";

type BootstrapResult = BootstrapPreview | BootstrapExecuteResult;

export function BootstrapPage() {
  const client = useQueryClient();
  const workspace = useQuery({
    queryKey: ["workspace"],
    queryFn: () => api<WorkspaceStatus>("/workspace"),
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
      api<BootstrapExecuteResult>("/bootstrap", {
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

  const status = workspace.data;
  const specialists = status?.inception.specialists ?? [];
  const skills = status?.inception.skills ?? [];
  const available = status?.bootstrap.available === true;
  const busy = dryRun.isPending || execute.isPending;
  const error = dryRun.error?.message ?? execute.error?.message ?? workspace.error?.message;

  const submitDryRun = (event: FormEvent) => {
    event.preventDefault();
    if (!exportPath.trim() || !available) return;
    dryRun.mutate();
  };

  return (
    <main className="workspace bootstrap-workspace">
      <div className="top-grid">
        <section className="panel form-panel">
          <div className="panel-heading">
            <div>
              <span className="eyebrow">Empty-workspace inception</span>
              <h2>Bootstrap</h2>
              <p className="panel-description">
                Load a Prelude export, then create git and Helix wiring in this folder.
                Bootstrap specialists auto-load inception skills when they run; author skills in Manage.
              </p>
            </div>
            <StatusChip
              label={
                workspace.isPending ? "checking" : available ? (busy ? "working" : "ready") : "unavailable"
              }
              tone={available ? (busy ? "running" : "done") : workspace.isPending ? "idle" : "error"}
            />
          </div>

          {status && !available && (
            <p className="bootstrap-banner bootstrap-banner-blocked" role="status">
              {status.bootstrap.reason}
            </p>
          )}
          {status && available && !status.empty && (
            <p className="bootstrap-banner" role="status">
              Extra files in this folder ({status.foreignEntries.slice(0, 4).join(", ")}
              {status.foreignEntries.length > 4 ? ", …" : ""}). Turn on force to execute anyway.
            </p>
          )}

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
                  if (confirm("Create a new git repository and Helix project in this folder?")) execute.mutate();
                }}
              >
                {execute.isPending ? "Executing…" : "Execute"}
              </button>
            </div>
          </form>
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

function BootstrapResultPanel({ result }: { result: BootstrapResult }) {
  const preview = result.dryRun ? result : result.preview;
  const materialize = result.dryRun ? null : result.materialize;
  const previewSkills = preview.skills ?? [];
  return (
    <section className="panel result-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{result.dryRun ? "Dry run result" : "Bootstrap complete"}</span>
          <h2>{preview.pickup.name} · v{preview.pickup.version}</h2>
        </div>
        <StatusChip label={result.dryRun ? "preview" : "done"} tone={result.dryRun ? "running" : "done"} />
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
      {!result.dryRun && (
        <p className="bootstrap-banner bootstrap-banner-success">
          PR Reviews is available now. Configure <code>.env</code>, then start a run.
        </p>
      )}
    </section>
  );
}

function StatusChip({ label, tone }: { label: string; tone: "idle" | "running" | "done" | "error" }) {
  return <span className={`status-pill ${tone === "idle" ? "" : tone}`}>{label}</span>;
}
