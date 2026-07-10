/**
 * Phase A repo context: deterministic bootstrap + curated file allowlist.
 *
 * Gathered once per run (no LLM) and injected into the orchestrator prompt and
 * the first specialist wave so planners start grounded without rediscovering
 * the tree via tools. Keeps session isolation (`noContextFiles`) intact.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export interface RepoContextOptions {
  /** Default true. */
  enabled?: boolean;
  /** Directory tree depth (root = 0). Default 2. */
  treeDepth?: number;
  /** Cap on tree entries. Default 120. */
  maxTreeEntries?: number;
  /** Max chars per allowlisted file excerpt. Default 6000. */
  maxFileChars?: number;
  /** Max total chars for the whole bootstrap blob. Default 24000. */
  maxTotalChars?: number;
  /**
   * Repo-relative paths to excerpt when present.
   * Default: AGENTS.md, README.md, docs/plan.md, plus `.helix/context/*.md`.
   */
  files?: string[];
  /** Include package.json / workspace manifest summary. Default true. */
  includeManifest?: boolean;
  /** Include changed files vs default branch (best-effort git). Default true. */
  includeGitDelta?: boolean;
}

export const DEFAULT_CONTEXT_FILES = [
  "AGENTS.md",
  "README.md",
  "docs/plan.md",
];

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "vendor",
]);

export function buildRepoBootstrap(cwd: string, opts: RepoContextOptions = {}): string | undefined {
  if (opts.enabled === false) return undefined;

  const treeDepth = opts.treeDepth ?? 2;
  const maxTreeEntries = opts.maxTreeEntries ?? 120;
  const maxFileChars = opts.maxFileChars ?? 6000;
  const maxTotalChars = opts.maxTotalChars ?? 24_000;
  const includeManifest = opts.includeManifest !== false;
  const includeGitDelta = opts.includeGitDelta !== false;
  const files = opts.files ?? DEFAULT_CONTEXT_FILES;

  const sections: string[] = [
    "## Repo bootstrap (deterministic)",
    "Pre-gathered by Helix before specialists run. Prefer these facts over rediscovering layout; explore only gaps.",
    "",
    `Root: \`${cwd}\``,
  ];

  const tree = buildTree(cwd, treeDepth, maxTreeEntries);
  if (tree) {
    sections.push("", "### Directory tree", "```", tree, "```");
  }

  if (includeManifest) {
    const manifest = summarizeManifest(cwd);
    if (manifest) sections.push("", "### Manifest", manifest);
  }

  if (includeGitDelta) {
    const delta = gitDelta(cwd);
    if (delta) sections.push("", "### Git delta (best-effort)", delta);
  }

  const excerpts = collectExcerpts(cwd, files, maxFileChars);
  if (excerpts.length > 0) {
    sections.push("", "### Context files");
    for (const ex of excerpts) {
      sections.push("", `#### ${ex.path}`, "```markdown", ex.body, "```");
    }
  }

  let text = sections.join("\n").trim();
  if (text.length > maxTotalChars) {
    text = `${text.slice(0, maxTotalChars).trimEnd()}\n\n…(truncated)`;
  }
  return text;
}

export function prependRepoContext(task: string, repoContext: string | undefined): string {
  if (!repoContext) return task;
  return `${repoContext}\n\n---\n\n${task}`;
}

function buildTree(cwd: string, maxDepth: number, maxEntries: number): string | undefined {
  const lines: string[] = ["."];
  let count = 0;
  let truncated = false;

  const walk = (dir: string, depth: number, prefix: string) => {
    if (count >= maxEntries) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (count >= maxEntries) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") && entry.name !== ".helix") continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      // Skip run artifacts under .helix
      if (entry.name === "runs" && basename(dir) === ".helix") continue;

      const rel = relative(cwd, join(dir, entry.name)) || entry.name;
      lines.push(`${prefix}${entry.isDirectory() ? `${rel}/` : rel}`);
      count++;

      if (entry.isDirectory() && depth < maxDepth) {
        walk(join(dir, entry.name), depth + 1, prefix);
      }
    }
  };

  walk(cwd, 1, "");
  if (lines.length <= 1) return undefined;
  if (truncated) lines.push("…(truncated)");
  return lines.join("\n");
}

function summarizeManifest(cwd: string): string | undefined {
  const pkgPath = resolve(cwd, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      name?: string;
      private?: boolean;
      type?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      workspaces?: unknown;
    };
    const scripts = Object.keys(raw.scripts ?? {});
    const deps = Object.keys(raw.dependencies ?? {});
    const devDeps = Object.keys(raw.devDependencies ?? {});
    const lines = [
      `- package.json name: ${raw.name ?? "(unnamed)"}`,
      raw.type ? `- type: ${raw.type}` : null,
      scripts.length ? `- scripts: ${scripts.join(", ")}` : "- scripts: (none)",
      `- dependencies: ${deps.length} (${previewKeys(deps, 12)})`,
      `- devDependencies: ${devDeps.length} (${previewKeys(devDeps, 12)})`,
      raw.workspaces != null ? "- workspaces: yes" : null,
    ].filter(Boolean);
    return lines.join("\n");
  } catch {
    return undefined;
  }
}

function previewKeys(keys: string[], n: number): string {
  if (keys.length === 0) return "none";
  const shown = keys.slice(0, n).join(", ");
  return keys.length > n ? `${shown}, …` : shown;
}

function gitDelta(cwd: string): string | undefined {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const base = defaultBaseBranch(cwd);
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", `${base}...HEAD`],
      { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    const status = execFileSync("git", ["status", "--short"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    const lines = [`- branch: ${branch}`, `- base: ${base}`];
    if (changed.length > 0) {
      lines.push(`- changed vs ${base} (${changed.length}):`);
      for (const f of changed.slice(0, 40)) lines.push(`  - ${f}`);
      if (changed.length > 40) lines.push(`  - …(+${changed.length - 40} more)`);
    } else {
      lines.push(`- changed vs ${base}: (none)`);
    }
    if (status) {
      const statusLines = status.split("\n").slice(0, 30);
      lines.push("- working tree:");
      for (const s of statusLines) lines.push(`  ${s}`);
      if (status.split("\n").length > 30) lines.push("  …");
    }
    return lines.join("\n");
  } catch {
    return undefined;
  }
}

function defaultBaseBranch(cwd: string): string {
  for (const candidate of ["main", "master"]) {
    try {
      execFileSync("git", ["rev-parse", "--verify", candidate], {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return "HEAD~1";
}

function collectExcerpts(
  cwd: string,
  files: string[],
  maxFileChars: number,
): Array<{ path: string; body: string }> {
  const out: Array<{ path: string; body: string }> = [];
  const seen = new Set<string>();

  const add = (relPath: string) => {
    const normalized = relPath.replace(/^\.\//, "");
    if (seen.has(normalized)) return;
    const abs = resolve(cwd, normalized);
    const root = resolve(cwd);
    const rel = relative(root, abs);
    if (rel.startsWith("..") || rel === "") return;
    if (!existsSync(abs) || !statSync(abs).isFile()) return;
    seen.add(normalized);
    try {
      let body = readFileSync(abs, "utf-8");
      if (body.length > maxFileChars) {
        body = `${body.slice(0, maxFileChars).trimEnd()}\n\n…(truncated)`;
      }
      out.push({ path: normalized, body: body.trimEnd() });
    } catch {
      /* skip unreadable */
    }
  };

  for (const f of files) add(f);

  // Operator-maintained snippets under .helix/context/
  const contextDir = resolve(cwd, ".helix", "context");
  if (existsSync(contextDir) && statSync(contextDir).isDirectory()) {
    try {
      for (const name of readdirSync(contextDir).sort()) {
        if (!name.endsWith(".md")) continue;
        add(join(".helix/context", name));
      }
    } catch {
      /* ignore */
    }
  }

  return out;
}
