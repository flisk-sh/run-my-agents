# Kitchen agent

The kitchen's stage agents (Spec, Build, Test, Review, Ship) as one Flisk `agent` resource. It runs as a **local
process** (`command` in `service.json`), so every turn is your own logged-in `claude` CLI on this Mac: your Claude
subscription, **no API key**.

- `POST /turn` with `x-session-id: order-26-build` and `{ "input", "cwd", "model", "effort" }` runs one turn of
  `claude -p` in `cwd` (the order's worktree) with `acceptEdits` and the kitchen's tool allow-list, and **returns the
  reply**. The same session resumes the same Claude chat, so rounds keep their context.
- `GET /sessions`, `GET /session`, `/health`, `/ready` as every Flisk agent; `flisk agent sessions kitchen` lists them.
- It listens on `127.0.0.1` only: each turn runs your `claude` with edit rights.

Start it with the board (`flisk up app`), or alone with `bun run src/index.ts` (port 4101). Then point the board at it:

```bash
curl -X POST http://localhost:4100/api/kitchen -H 'content-type: application/json' -d '{"agentUrl":"http://127.0.0.1:4101"}'
```

From then on autopilot sends each order step to this agent and moves the order on from its reply: no container agents,
no waiting for a chat to go quiet. `{"agentUrl":""}` goes back to container agents.

`KITCHEN_CLAUDE_BIN` (default `claude`) and `KITCHEN_TURN_TIMEOUT_MS` (default 30 min) can be set on the resource.
