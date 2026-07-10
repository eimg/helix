/** Stub specialist session + factory for tests. Returns canned outputs. */
import type {
  SpecialistDefinition,
  SpecialistResult,
  SpecialistRunOptions,
  SpecialistSession,
  SpecialistSessionFactory,
} from "../engine/types.js";

export class StubSpecialistSession implements SpecialistSession {
  constructor(
    readonly name: string,
    private output: string,
    private delayMs = 0,
    private fail = false,
  ) {}
  async run(task: string, _opts?: SpecialistRunOptions): Promise<SpecialistResult> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return {
      specialist: this.name,
      task,
      ok: !this.fail,
      output: this.output,
      usage: { input: 10, output: 20, cost: 0.0001, turns: 1 },
      error: this.fail ? "stub failure" : undefined,
    };
  }
  dispose(): void {}
}

/**
 * Factory that maps each definition to a canned output via a lookup.
 * `failures` is a set of specialist names that return ok:false.
 */
export class StubSpecialistFactory implements SpecialistSessionFactory {
  constructor(
    public definitions: SpecialistDefinition[],
    private outputs: Record<string, string>,
    private delayMs = 0,
    private failures: Set<string> = new Set(),
  ) {}
  async create(def: SpecialistDefinition): Promise<SpecialistSession> {
    return new StubSpecialistSession(def.name, this.outputs[def.name] ?? "(stub)", this.delayMs, this.failures.has(def.name));
  }
}
