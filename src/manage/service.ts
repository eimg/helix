/**
 * Manage sessions — prompt-driven agent/skill authoring (separate from issue runs).
 */
import { randomUUID } from "node:crypto";
import type { HelixConfig } from "../config.js";
import type { PiProvider } from "../providers/openrouter.js";
import { applyDrafts } from "./apply.js";
import { LlmManageAuthor } from "./author.js";
import { ManageEventStream } from "./eventStream.js";
import { loadManageInventory } from "./inventory.js";
import { MemoryManageStore, type ManageStore } from "./store.js";
import type { ManageAuthor, ManageEvent, ManageSession } from "./types.js";

export interface ManageServiceOptions {
  helixDir: string;
  config: HelixConfig;
  provider: PiProvider;
  store?: ManageStore;
  createAuthor?: (sessionId: string) => ManageAuthor;
}

export class ManageService {
  private readonly helixDir: string;
  private readonly provider: PiProvider;
  private readonly store: ManageStore;
  private readonly createAuthor: (sessionId: string) => ManageAuthor;
  private readonly authors = new Map<string, ManageAuthor>();
  private readonly streams = new Map<string, ManageEventStream>();

  constructor(opts: ManageServiceOptions) {
    this.helixDir = opts.helixDir;
    this.provider = opts.provider;
    this.store = opts.store ?? new MemoryManageStore();
    this.createAuthor =
      opts.createAuthor ??
      (() =>
        new LlmManageAuthor(this.provider, {
          helixDir: this.helixDir,
          modelRef: opts.config.orchestrator.model,
          inheritPi: opts.config.inheritPi,
          extensions: opts.config.extensions,
        }));
  }

  getInventory() {
    return loadManageInventory(this.helixDir);
  }

  startSession(prompt: string): { id: string; eventStream: ManageEventStream; promise: Promise<ManageSession> } {
    const id = randomUUID();
    const eventStream = this.streamFor(id);
    this.ensureAuthor(id);

    const session: ManageSession = {
      id,
      status: "active",
      startedAt: Date.now(),
      messages: [],
      drafts: [],
      events: [],
    };

    const promise = this.runTurn(session, prompt, eventStream);
    return { id, eventStream, promise };
  }

  eventStreamFor(id: string): ManageEventStream | undefined {
    return this.streams.get(id);
  }

  async sendMessage(id: string, content: string): Promise<ManageSession> {
    const session = this.store.load(id);
    if (!session) throw new Error("Manage session not found");
    if (session.status !== "active") throw new Error(`Session is ${session.status}, not active`);

    this.ensureAuthor(id);
    return this.runTurn(session, content, this.streamFor(id));
  }

  applySession(id: string, force = false): ManageSession {
    const session = this.store.load(id);
    if (!session) throw new Error("Manage session not found");
    if (session.drafts.length === 0) throw new Error("No drafts to apply");

    const result = applyDrafts(this.helixDir, session.drafts, force);
    if (!result.ok) {
      throw new Error(result.errors.join("; "));
    }

    session.status = "applied";
    session.finishedAt = Date.now();
    const appliedEvent: ManageEvent = {
      ts: Date.now(),
      type: "applied",
      summary: `Applied ${result.written.length} file(s)`,
      details: { written: result.written },
    };
    this.pushEvent(session, appliedEvent);
    this.streamFor(id).emit(appliedEvent);
    this.store.save(session);
    this.closeSession(session.id);
    return session;
  }

  discardSession(id: string): ManageSession {
    const session = this.store.load(id);
    if (!session) throw new Error("Manage session not found");
    session.status = "discarded";
    session.finishedAt = Date.now();
    this.store.save(session);
    this.closeSession(id);
    return session;
  }

  getSession(id: string): ManageSession | undefined {
    return this.store.load(id);
  }

  private async runTurn(
    session: ManageSession,
    userText: string,
    eventStream: ManageEventStream,
  ): Promise<ManageSession> {
    const emit = (event: ManageEvent) => {
      this.pushEvent(session, event);
      eventStream.emit(event);
    };

    if (session.messages.length === 0) {
      emit({
        ts: Date.now(),
        type: "session_started",
        summary: "Manage session started",
      });
    }

    session.messages.push({ role: "user", content: userText.trim() });
    emit({
      ts: Date.now(),
      type: "message_sent",
      summary: userText.trim().split("\n")[0] ?? userText.trim(),
      details: { content: userText.trim() },
    });
    this.store.save(session);

    const author = this.ensureAuthor(session.id);

    try {
      const inventory = loadManageInventory(this.helixDir);
      const history = session.messages.slice(0, -1);
      const turn = await author.complete(userText, history, inventory);

      session.messages.push({ role: "assistant", content: turn.message });
      if (turn.drafts.length > 0) {
        session.drafts = turn.drafts;
        emit({
          ts: Date.now(),
          type: "draft_updated",
          summary: `${turn.drafts.length} draft(s) ready`,
          details: { drafts: turn.drafts.map((d) => d.relativePath) },
        });
      }

      emit({
        ts: Date.now(),
        type: "assistant_replied",
        summary: turn.message.split("\n")[0] ?? turn.message,
        details: { message: turn.message, draftCount: turn.drafts.length },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.status = "error";
      session.error = message;
      session.finishedAt = Date.now();
      emit({ ts: Date.now(), type: "error", summary: message });
      this.closeSession(session.id);
    }

    this.store.save(session);
    return session;
  }

  private ensureAuthor(id: string): ManageAuthor {
    let author = this.authors.get(id);
    if (!author) {
      author = this.createAuthor(id);
      this.authors.set(id, author);
    }
    return author;
  }

  private streamFor(id: string): ManageEventStream {
    let stream = this.streams.get(id);
    if (!stream) {
      stream = new ManageEventStream();
      this.streams.set(id, stream);
    }
    return stream;
  }

  private closeSession(id: string): void {
    this.authors.get(id)?.dispose?.();
    this.authors.delete(id);
    this.streams.delete(id);
  }

  private pushEvent(session: ManageSession, event: ManageEvent): void {
    session.events.push(event);
  }
}
