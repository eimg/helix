import type { ManageSession } from "./types.js";

export interface ManageStore {
  save(session: ManageSession): void;
  load(id: string): ManageSession | undefined;
}

export class MemoryManageStore implements ManageStore {
  readonly sessions = new Map<string, ManageSession>();

  save(session: ManageSession): void {
    this.sessions.set(session.id, structuredClone(session));
  }

  load(id: string): ManageSession | undefined {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : undefined;
  }
}
