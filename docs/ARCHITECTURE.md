# Architecture

Run My Agents is four local parts on your computer: the Claude Code hooks, the shared state files in `~/.run-my-agents`, the local board server, and the macOS app. Nothing leaves your machine.

## How the parts talk

```
  Claude Code sessions
  (Edit, Write, MultiEdit, NotebookEdit, SessionEnd)
          │
          ├──► PreToolUse / SessionEnd ──► hooks/check.mjs ──► claims.lock (mkdir)
          │                                                       │
          │                                                       ▼
          │                                            ~/.run-my-agents/claims.json
          │                                                       ▲
          └──► PreToolUse (*) ───────────► hooks/limit.mjs ───────┼──► ~/.run-my-agents/limits.json
                                                                  │
                                                                  │ reads & writes
                                                                  ▼
  ~/.claude/projects ──┐                                  services/app/board
  ~/.codex/sessions  ──┼──► (reads session logs) ──────►  Hono server (:4100)
                       │                                          ▲
                       │                                          │ HTTP / WebView
                       │                                          │ (starts if port 4100 is down)
                       │                                  mac/RunMyAgents.swift
                       └────────────────────────────────  macOS app + menu bar
```

## 1. Hooks (`hooks/`)

Configured in [`hooks/hooks.json`](../hooks/hooks.json) and run by Claude Code via `node`:

- **`hooks/check.mjs`** runs on `PreToolUse` (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) and `SessionEnd`:
  - On edit tools, it checks `~/.run-my-agents/claims.json` for another session's claim within `RUN_MY_AGENTS_TTL_MINUTES` (default `10`). If found, it blocks the edit once with a warning; a retry goes through and updates the claim.
  - On `SessionEnd`, it removes that session's claims so finished sessions never block active ones.
  - Ignored paths (lockfiles, `*.generated.*`, `dist/`, `node_modules/`, `.flisk/`, and `RUN_MY_AGENTS_IGNORE`) are skipped.
- **`hooks/limit.mjs`** runs on `PreToolUse` (`*`):
  - Reads `~/.run-my-agents/limits.json` and stops a session once when it passes its token limit, suggesting the next cheaper model (`Opus` -> `Sonnet` -> `Haiku`).
  - When configured, it also writes the cheaper model to `.claude/settings.local.json` for new sessions in that project.

## 2. Claims and state files (`~/.run-my-agents/`)

Override the directory with `RUN_MY_AGENTS_DIR`:

- **`claims.json`**: Maps each file path to the session ID, branch, repo path, and timestamp of the last edit.
- **`claims.lock`**: An atomic lock directory (`mkdir`) used by `hooks/check.mjs` so concurrent hooks do not overwrite each other's claims. Stale locks older than 5 seconds are taken over, and hooks proceed without the lock after 2 seconds so bookkeeping never blocks an edit.
- **`limits.json`**: Stores per-session token limits and model-downgrade settings written by the board and read by `hooks/limit.mjs`.
- **`debug.log`**: Written when `RUN_MY_AGENTS_DEBUG=1` is set.

## 3. Board (`services/app/board/`)

A local [Hono](https://hono.dev/) server (`services/app/board/src/index.ts`) listening on `http://127.0.0.1:4100`:

- Reads Claude Code session transcripts from `~/.claude/projects` and Codex sessions from `~/.codex/sessions`.
- Reads `claims.json` to highlight file clashes between active sessions.
- Reads and writes `limits.json` when you set or change token limits in the UI.
- Serves the single-page UI, bundled fonts, and skill suggestions (`services/app/board/src/skills.json`).
- Accepts state-changing requests only from localhost origins with `application/json`.

## 4. Mac app (`mac/`)

A native macOS window and menu bar item (`mac/RunMyAgents.swift`) around `http://127.0.0.1:4100/`:

- On launch, checks if port `4100` is already answering. If not, it starts `bun src/index.ts` in `services/app/board` (or the bundled board in release builds; override with `RUN_MY_AGENTS_BOARD`) and stops it on quit.
- Checks for updates on launch and every 6 hours from GitHub releases (or fast-forward pulls `main` in dev builds), unless `RUN_MY_AGENTS_NO_UPDATE=1` is set.
