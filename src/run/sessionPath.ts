import { resolve } from "node:path";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function runSessionRoot(helixDir: string, runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new Error(`Run id is not safe for durable session storage: ${runId}`);
  }
  return resolve(helixDir, "sessions", runId);
}
