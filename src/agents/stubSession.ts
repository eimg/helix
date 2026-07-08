/** Stub specialist session + factory for tests. Returns canned outputs. */
import type {
  SpecialistDefinition,
  SpecialistResult,
  SpecialistSession,
  SpecialistSessionFactory,
} from "../engine/types.js";

export class StubSpecialistSession implements SpecialistSession {
  constructor(
    readonly name: string,
    private output: string,
    private delayMs = 0,
  ) {}
  async run(task: string): Promise<SpecialistResult> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    return {
      specialist: this.name,
      task,
      ok: true,
      output: this.output,
      usage: { input: 10, output: 20, cost: 0.0001, turns: 1 },
    };
  }
  dispose(): void {}
}

/** Factory that maps each definition to a canned output via a lookup. */
export class StubSpecialistFactory implements SpecialistSessionFactory {
  constructor(
    public definitions: SpecialistDefinition[],
    private outputs: Record<string, string>,
    private delayMs = 0,
  ) {}
  async create(def: SpecialistDefinition): Promise<SpecialistSession> {
    return new StubSpecialistSession(def.name, this.outputs[def.name] ?? "(stub)", this.delayMs);
  }
}
