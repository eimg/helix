/** Scripted orchestrator for tests: replays a fixed list of decisions. */
import type { Orchestrator, OrchestratorDecision, OrchestratorInput } from "../engine/types.js";

export class ScriptedOrchestrator implements Orchestrator {
  private i = 0;
  constructor(private script: OrchestratorDecision[]) {}
  async decide(_input: OrchestratorInput): Promise<OrchestratorDecision> {
    if (this.i >= this.script.length) throw new Error("ScriptedOrchestrator: script exhausted");
    return this.script[this.i++];
  }
}
