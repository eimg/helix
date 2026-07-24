import { useQuery } from "@tanstack/react-query";
import type { ConfigSnapshot } from "../../src/config/snapshot";
import { api } from "./api";

export function ConfigPage() {
  const query = useQuery({ queryKey: ["config-snapshot"], queryFn: () => api<ConfigSnapshot>("/config/snapshot") });
  if (query.isPending) {
    return (
      <main className="workspace">
        <section className="panel config-page">
          <p className="empty-row">Loading configuration…</p>
        </section>
      </main>
    );
  }
  if (query.isError) {
    return (
      <main className="workspace">
        <section className="panel config-page">
          <p className="error-text">{query.error.message}</p>
        </section>
      </main>
    );
  }
  const snap = query.data;
  const githubGateActive = snap.flags.deliverablePr;
  const bootstrapSkills = snap.inception.skills ?? [];
  const bootstrapSkillPaths = snap.inception.skillPaths ?? [];

  return (
    <main className="workspace config-workspace">
      <div className="page-title">
        <div>
          <span className="eyebrow">Runtime observability</span>
          <h2>Configuration</h2>
          <p>Resolved settings and provenance. Secrets are never displayed.</p>
        </div>
        <button className="btn btn-ghost" onClick={() => query.refetch()}>
          Refresh
        </button>
      </div>

      <ConfigSection title="Active models">
        <KV label="Orchestrator" value={`${snap.models.orchestrator.value} · ${snap.models.orchestrator.source}`} />
        {snap.models.specialists.map((item) => (
          <KV
            key={item.name}
            label={item.name}
            value={`${item.model.value ?? "—"} · ${item.model.source}${item.inWorkflow ? " · workflow" : ""}`}
          />
        ))}
      </ConfigSection>

      <ConfigSection title="Provider & auth">
        <KV label="Provider" value={snap.provider.name} />
        <KV label="API key env" value={snap.provider.apiKeyEnv} />
        <KV
          label="Auth"
          value={`${snap.provider.authConfigured ? "configured" : "missing"} · ${snap.provider.authSource}`}
        />
        <KV label="Models file" value={snap.provider.modelsFile.value ?? snap.provider.modelsFile.detail ?? "built-in"} />
      </ConfigSection>

      <ConfigSection title="Flags & paths">
        <KV label="Extensions" value={onOff(snap.flags.extensionsEnabled)} />
        <KV label="Repo context" value={onOff(snap.flags.repoContextEnabled)} />
        <KV label="Local PR deliverable" value={onOff(snap.flags.deliverableLocalPr)} />
        <KV label="GitHub PR deliverable" value={onOff(snap.flags.deliverablePr)} />
        <KV label="Helix dir" value={snap.paths.helixDir} />
        <KV label="Repo cwd" value={snap.paths.cwd} />
        <KV label="pi agent dir" value={snap.paths.piAgentDir} />
      </ConfigSection>

      <ConfigSection title="Workflow">
        <KV label="Sequence" value={snap.workflow.steps.join(" → ")} />
        <KV label="Max iterations" value={String(snap.workflow.maxIterations)} />
        <KV label="Skills pack" value=".helix/skills/ · auto-loaded into run sessions" />
        <KV label="Skills" value={snap.resources.skills.map((item) => item.name).join(", ") || "none"} />
      </ConfigSection>

      <ConfigSection title="PR control">
        <KV label="Process" value="reviewer + verifier · concurrent" />
        {snap.models.prSpecialists.map((item) => (
          <KV
            key={item.name}
            label={item.name}
            value={`${item.model.value ?? "—"} · ${item.model.source} model · ${item.definitionSource.replace("_", " ")} definition`}
          />
        ))}
        <KV label="Definitions dir" value={snap.resources.prAgentsDir} />
        <KV label="Skills pack" value="run skills (.helix/skills/) · shared with workflow sessions" />
      </ConfigSection>

      <ConfigSection title="Bootstrap">
        <KV label="Process" value={`${snap.inception.roles.join(" → ")} · fixed roles`} />
        <KV
          label="Skills auto-load"
          value={snap.inception.skillsAutoLoad !== false ? "on · inception skill pack" : "off"}
        />
        {snap.models.inceptionSpecialists.map((item) => (
          <KV
            key={item.name}
            label={item.name}
            value={`${item.model.value ?? "—"} · ${item.model.source} model · ${item.definitionSource.replace("_", " ")} definition`}
          />
        ))}
        {bootstrapSkills.length === 0 ? (
          <KV label="Skills" value="none · add via Manage under inception-skills/" />
        ) : (
          bootstrapSkills.map((item) => (
            <KV
              key={item.name}
              label={`Skill · ${item.name}`}
              value={`${item.source.replace("_", " ")} · ${item.relativePath}`}
            />
          ))
        )}
        <KV
          label="Skill paths"
          value={bootstrapSkillPaths.length ? bootstrapSkillPaths.join(", ") : "none resolved"}
        />
        <KV label="Agents dir" value={snap.resources.inceptionAgentsDir} />
        <KV label="Skills dir" value={snap.resources.inceptionSkillsDir} />
      </ConfigSection>

      <ConfigSection title="GitHub delivery gate">
        <KV label="Status" value={githubGateActive ? "active" : "inactive · GitHub PR deliverable off"} />
        <KV label="Auto merge" value={`${onOff(snap.mergeGate?.autoMerge === true)} · configured`} />
        <KV label="Max diff lines" value={optional(snap.mergeGate?.maxDiffLines)} />
        <KV label="Max files" value={optional(snap.mergeGate?.maxFiles)} />
      </ConfigSection>

      <ConfigSection title="Triggers">
        <KV label="GitHub repo" value={snap.triggers?.github?.repo ?? "not configured"} />
        <KV label="Mode" value={snap.triggers?.github?.mode ?? "poll"} />
        <KV label="Label filter" value={snap.triggers?.github?.labelFilter ?? "none"} />
        <KV
          label="Interval"
          value={snap.triggers?.github?.intervalSec ? `${snap.triggers.github.intervalSec}s` : "default"}
        />
      </ConfigSection>

      <ConfigSection title="Repository context">
        <KV label="Enabled" value={onOff(snap.repoContext.enabled)} />
        <KV label="Files" value={snap.repoContext.files.join(", ") || "none"} />
      </ConfigSection>

      <ConfigSection title="Resources">
        <KV label="Workflow agents" value={snap.resources.agentsDir} />
        <KV label="PR agents" value={snap.resources.prAgentsDir} />
        <KV label="Bootstrap agents" value={snap.resources.inceptionAgentsDir} />
        <KV label="Run skills" value={snap.resources.skillsDir} />
        <KV label="Bootstrap skills" value={snap.resources.inceptionSkillsDir} />
        <KV
          label="Run skill names"
          value={snap.resources.skills.map((item) => item.name).join(", ") || "none"}
        />
        <KV
          label="Bootstrap skill names"
          value={
            bootstrapSkills.length
              ? bootstrapSkills.map((item) => `${item.name} (${item.source.replace("_", " ")})`).join(", ")
              : snap.resources.inceptionSkills.map((item) => item.name).join(", ") || "none"
          }
        />
      </ConfigSection>

      <ConfigSection title="Raw wiring config">
        <pre className="config-raw">{JSON.stringify(snap.config, null, 2)}</pre>
      </ConfigSection>
    </main>
  );
}

function ConfigSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel config-section">
      <h3>{title}</h3>
      <div className="config-kv">{children}</div>
    </section>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="kv-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function onOff(value: boolean) {
  return value ? "on" : "off";
}

function optional(value: number | undefined) {
  return value === undefined ? "not set" : String(value);
}
