/**
 * `helix init` — scaffold a `.helix/` in the current project from the shipped
 * presets. Closes the install-to-first-run loop: `npm i -g @eimg/helix` then
 * `helix init` and you have a working config + agents + skill.
 *
 * Does NOT auto-create on `run` (silent scaffolding hides the contract; init
 * is an explicit act). Refuses to overwrite an existing config unless --force.
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // dist/ or src/

/** Resolve the Helix package root (presets/ lives there). */
function packageRoot(): string {
  // dist/cli.js -> ../ ; src/cli.ts -> ../
  return resolve(HERE, "..");
}

export interface InitOptions {
  preset?: string; // stack skill to copy (default "typescript")
  force?: boolean;
  list?: boolean;
  /** Project root to scaffold. Defaults to `process.cwd()`. */
  cwd?: string;
}

const PRESETS = ["typescript", "express", "react", "react-native", "expo"];

const CONFIG_TEMPLATE = `{
  "extensions": { "enabled": false },
  "repoContext": { "enabled": true },
  "deliverable": { "pr": false, "localPr": true, "baseBranch": "main" },
  "orchestrator": {
    "workflow": ["planner", "dev"],
    "maxIterations": 6
  },
  "inception": {
    "roles": ["architect", "scaffolder", "validator"]
  },
  "mergeGate": {
    "autoMerge": true,
    "maxDiffLines": 300,
    "maxFiles": 10
  }
}
`;

const GITIGNORE_ENTRIES = [
  ".helix/runs/",
  ".helix/runs.db*",
  ".helix/pr-reviews.db*",
  ".helix/.env",
  ".env",
];

const ENV_EXAMPLE = `# Helix — copy to .helix/.env and fill in (never commit .helix/.env)
# App/runtime secrets belong in the repo-root .env, not here.
OPENROUTER_API_KEY=

# Default model shipped with helix init (OpenRouter: xiaomi/mimo-v2.5-pro)
HELIX_MODEL=openrouter/xiaomi/mimo-v2.5-pro
`;

export function listPresets(): string[] {
  return PRESETS;
}

export function init(opts: InitOptions = {}): void {
  if (opts.list) {
    console.log("Available presets:");
    for (const p of PRESETS) console.log(`  ${p}`);
    return;
  }

  const preset = opts.preset ?? "typescript";
  if (!PRESETS.includes(preset)) {
    throw new Error(`Unknown preset: ${preset}. Available: ${PRESETS.join(", ")}`);
  }

  const cwd = resolve(opts.cwd ?? process.cwd());
  const helixDir = resolve(cwd, ".helix");
  const configPath = resolve(helixDir, "config.json");

  if (existsSync(configPath) && !opts.force) {
    throw new Error(`.helix/config.json already exists. Use --force to overwrite.`);
  }

  const pkgRoot = packageRoot();
  const agentsSrc = resolve(pkgRoot, "presets", "agents");
  const skillSrc = resolve(pkgRoot, "presets", "skills", preset);

  // 1. config.json
  mkdirSync(helixDir, { recursive: true });
  writeFileSync(configPath, CONFIG_TEMPLATE, "utf-8");
  console.log(`✓ wrote .helix/config.json`);

  // 2. agents/*.md
  const agentsDir = resolve(helixDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  let agentCount = 0;
  for (const name of ["planner.md", "dev.md"]) {
    const src = join(agentsSrc, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(agentsDir, name));
    agentCount++;
  }
  console.log(`✓ wrote .helix/agents/ (${agentCount} specialists)`);

  // PR-control reviewers are deliberately separate from implementation agents.
  const prAgentsSrc = resolve(pkgRoot, "presets", "pr-agents");
  const prAgentsDir = resolve(helixDir, "pr-agents");
  mkdirSync(prAgentsDir, { recursive: true });
  let prAgentCount = 0;
  for (const name of ["reviewer.md", "verifier.md"]) {
    const src = join(prAgentsSrc, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(prAgentsDir, name));
    prAgentCount++;
  }
  console.log(`✓ wrote .helix/pr-agents/ (${prAgentCount} PR-control specialists)`);

  // Inception bootstrap specialists (fixed roles; separate from run + PR).
  const inceptionAgentsSrc = resolve(pkgRoot, "presets", "inception-agents");
  const inceptionAgentsDir = resolve(helixDir, "inception-agents");
  mkdirSync(inceptionAgentsDir, { recursive: true });
  let inceptionAgentCount = 0;
  for (const name of ["architect.md", "scaffolder.md", "validator.md"]) {
    const src = join(inceptionAgentsSrc, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(inceptionAgentsDir, name));
    inceptionAgentCount++;
  }
  console.log(`✓ wrote .helix/inception-agents/ (${inceptionAgentCount} inception specialists)`);

  const inceptionSkillSrc = resolve(pkgRoot, "presets", "inception-skills", "foundation", "SKILL.md");
  const inceptionSkillDstDir = resolve(helixDir, "inception-skills", "foundation");
  if (existsSync(inceptionSkillSrc)) {
    mkdirSync(inceptionSkillDstDir, { recursive: true });
    copyFileSync(inceptionSkillSrc, resolve(inceptionSkillDstDir, "SKILL.md"));
    console.log("✓ wrote .helix/inception-skills/foundation/SKILL.md");
  }

  // 3. skills/<preset>/SKILL.md
  const skillDst = resolve(helixDir, "skills", preset);
  const skillFile = resolve(skillSrc, "SKILL.md");
  if (existsSync(skillFile)) {
    mkdirSync(skillDst, { recursive: true });
    copyFileSync(skillFile, resolve(skillDst, "SKILL.md"));
    console.log(`✓ wrote .helix/skills/${preset}/SKILL.md`);
  } else {
    console.log(`⚠ no skill for preset "${preset}" (skipped)`);
  }

  // 4. .gitignore — append SQLite and legacy run paths if not already present
  const gitignorePath = resolve(cwd, ".gitignore");
  let gitignore = "";
  try {
    gitignore = readFileSync(gitignorePath, "utf-8");
  } catch {
    // no .gitignore yet
  }
  const missing = GITIGNORE_ENTRIES.filter((e) => !gitignore.includes(e));
  if (missing.length > 0) {
    const addition = `\n# Helix\n${missing.join("\n")}\n`;
    appendFileSync(gitignorePath, addition, "utf-8");
    console.log(`✓ updated .gitignore (${missing.join(", ")})`);
  }

  // 5. Legacy runs/ dir (also used as a one-time SQLite import source)
  mkdirSync(resolve(helixDir, "runs"), { recursive: true });

  // 6. .helix/.env.example (only if missing) — keep Helix secrets out of root .env
  const envExamplePath = resolve(helixDir, ".env.example");
  if (!existsSync(envExamplePath)) {
    writeFileSync(envExamplePath, ENV_EXAMPLE, "utf-8");
    console.log("✓ wrote .helix/.env.example");
  }

  console.log("");
  console.log("Next steps:");
  console.log("  1. Copy .helix/.env.example → .helix/.env and set OPENROUTER_API_KEY + HELIX_MODEL");
  console.log("  2. Edit .helix/agents/*.md to match your project's needs");
  console.log("  3. Run:  helix run --title \"your task\"");
}
