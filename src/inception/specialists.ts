/**
 * Factory helper for bootstrap specialists — same pi sessions as run, but
 * with the inception skill pack (`.helix/inception-skills/`).
 */
import type { SpecialistDefinition } from "../engine/types.js";
import type { PiProvider } from "../providers/openrouter.js";
import { PiSpecialistSessionFactory, type PiSpecialistFactoryOptions } from "../agents/session.js";

export function createInceptionSpecialistFactory(
  provider: PiProvider,
  definitions: SpecialistDefinition[],
  opts: Omit<PiSpecialistFactoryOptions, "skillPack"> = {},
): PiSpecialistSessionFactory {
  return new PiSpecialistSessionFactory(provider, definitions, {
    ...opts,
    skillPack: "inception",
  });
}
