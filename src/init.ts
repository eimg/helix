/**
 * `helix init` — scaffold a `.helix/` in the current project from the shipped
 * presets. Closes the install-to-first-run loop: `npm i -g @helix/cli` then
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
}

const PRESETS = ["typescript", "express", "react", "react-native", "expo"];

const CONFIG_TEMPLATE = `{
  "provider": { "name": "openrouter", "apiKeyEnv": "OPENROUTER_API_KEY" },
  "inheritPi": false,
  "extensions": { "enabled": false },
  "repoContext": { "enabled": true },
  "orchestrator": {
    "model": "openrouter/xiaomi/mimo-v2.5-pro",
    "workflow": ["planner", "dev", "verifier"],
    "maxIterations": 6,
    "loops": { "verifier-fail": { "backTo": "dev", "maxRetries": 2 } }
  },
  "mergeGate": {
    "autoMerge": true,
    "maxDiffLines": 300,
    "maxFiles": 10,
    "requireVerifierPass": true
  }
}
`;

const GITIGNORE_ENTRIES = [".helix/runs/"];

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

  const cwd = process.cwd();
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
  for (const name of ["planner.md", "dev.md", "verifier.md"]) {
    const src = join(agentsSrc, name);
    if (!existsSync(src)) continue;
    copyFileSync(src, join(agentsDir, name));
    agentCount++;
  }
  console.log(`✓ wrote .helix/agents/ (${agentCount} specialists)`);

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

  // 4. .gitignore — append runs/ if not already present
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

  // 5. runs/ dir (gitignored, but created so first run doesn't need to mkdir)
  mkdirSync(resolve(helixDir, "runs"), { recursive: true });

  console.log("");
  console.log("Next steps:");
  console.log("  1. Set your OpenRouter API key:  export OPENROUTER_API_KEY=...");
  console.log("  2. Edit .helix/agents/*.md to match your project's needs");
  console.log("  3. Run:  helix run --title \"your task\"");
}
