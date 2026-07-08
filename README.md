# Helix

Agent orchestration loop built on [pi](https://pi.dev). Takes a work item (GitHub issue or inline task) and drives it through specialist agents (planner, dev, verifier, …) to a deliverable.

## Quick start

```bash
npm install -g @helix/cli
cd your-project
helix init --preset typescript
export OPENROUTER_API_KEY=...   # or ~/.helix/secrets.json
helix run --title "Fix login" --body "Empty password returns 500"
```

## Server & web UI

```bash
helix serve
# → http://127.0.0.1:8319/
```

The server exposes a lightweight web UI (title + body form, live log, result) and a JSON/SSE API (`POST /runs`, `GET /runs/:id`, `GET /runs/:id/events`).

### Default port: 8319

Helix uses port **8319** by default — a phone-keypad mnemonic for the name:

| Digit | Key | Letter(s) |
|-------|-----|-----------|
| 8 | TUV | **H** |
| 3 | DEF | **E** |
| 1 | — | **L** |
| 9 | WXYZ | **I** + **X** |

Override with `--port` or the `PORT` environment variable.

## Config

Project-local `.helix/` (created by `helix init`):

```
.helix/
  config.json      # provider, orchestrator, triggers, merge gate
  agents/*.md      # specialist definitions
  skills/*/SKILL.md
  runs/            # persisted run state (gitignored)
```

See [`AGENTS.md`](./AGENTS.md) and [`docs/plan.md`](./docs/plan.md) for architecture and milestones.

## License

See repository license.
