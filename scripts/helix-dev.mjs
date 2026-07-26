#!/usr/bin/env node
/**
 * Runs the Helix CLI from TypeScript source instead of dist, so a source checkout
 * takes effect in other projects immediately and `npm run build` stays a release step.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(packageRoot, "src/cli.ts");
const tsx = resolve(packageRoot, "node_modules/.bin/tsx");

for (const [path, hint] of [
  [entry, "the published package ships dist only"],
  [tsx, "run `npm install` in the Helix checkout"],
]) {
  if (!existsSync(path)) {
    console.error(`helix-dev needs ${path} (${hint}). Use \`helix\` for the built CLI.`);
    process.exit(1);
  }
}

const child = spawn(tsx, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, HELIX_DEV: "1" },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
