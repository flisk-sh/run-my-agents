import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// Contract with Flisk (see docs/agents/ai-agents.md):
//   AGENT_DURABILITY  files   (set by flisk from service.json agent.durability)
//   AGENT_STATE_DIR   where files-durability checkpoints live (a named volume that survives flisk down)
//   PORT              port to listen on
//
// The Run My Agents kitchen agent. It runs as a local process (service.json "command"), so each turn is your own
// logged-in `claude` CLI on this Mac: your Claude subscription, no API key. One Flisk session per order and stage
// (x-session-id "order-26-build") maps to one Claude chat, resumed turn after turn, run in the folder the board names
// (the order's worktree). The reply to POST /turn is the agent's answer, so the board never waits for silence.
// /health: the process is alive. /ready: the checkpoint store is reachable. Idle is healthy, so /health never checks the store.

const DURABILITY = 'files';
const STATE_DIR = process.env.AGENT_STATE_DIR || join(process.cwd(), '.agent-state');
const PORT = Number(process.env.PORT || 3000);
const DRAIN_TIMEOUT_MS = 10_000;

interface Checkpoint {
  sessionId: string;
  /** The Claude chat behind this session, resumed on the next turn. */
  claudeSession?: string;
  messages: Array<{ role: 'user' | 'agent'; content: string; at: string }>;
}

// One row of GET /sessions: what is stored, not what is in it, so listing never reads a whole conversation.
interface SessionSummary {
  sessionId: string;
  lastActivity: string;
  checkpointBytes: number;
}

// Session store. files: one JSON checkpoint per session, written atomically (temp file, then rename), so a kill
// mid-write leaves the previous checkpoint intact.
const store = {
  ready(): boolean {
    try {
      mkdirSync(STATE_DIR, { recursive: true });
      return true;
    } catch {
      return false;
    }
  },
  load(sessionId: string): Checkpoint {
    const file = join(STATE_DIR, sessionId + '.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { sessionId, messages: [] };
  },
  list(): SessionSummary[] {
    if (!existsSync(STATE_DIR)) return [];
    // Only finished checkpoints: an in-progress write is still a .tmp file.
    return readdirSync(STATE_DIR)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => {
        try {
          const stat = statSync(join(STATE_DIR, file));
          return [{ sessionId: file.slice(0, -'.json'.length), lastActivity: stat.mtime.toISOString(), checkpointBytes: stat.size }];
        } catch {
          return []; // removed between the directory read and the stat
        }
      });
  },
  save(checkpoint: Checkpoint): void {
    mkdirSync(STATE_DIR, { recursive: true });
    const file = join(STATE_DIR, checkpoint.sessionId + '.json');
    const tmp = file + '.' + process.pid + '.tmp';
    writeFileSync(tmp, JSON.stringify(checkpoint));
    renameSync(tmp, file);
  },
};

/** What a kitchen agent may run without asking (kept in step with the board's KITCHEN_TOOLS). */
const TOOLS = [
  'Bash(git:*)', 'Bash(gh:*)', 'Bash(bun:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)',
  'Bash(make:*)', 'Bash(python3:*)', 'Bash(pytest:*)', 'Bash(go:*)', 'Bash(cargo:*)', 'Bash(ls:*)', 'Bash(cat:*)',
  'Bash(grep:*)', 'Bash(rg:*)', 'Bash(find:*)', 'Bash(mkdir:*)', 'Bash(flisk:*)', 'WebFetch', 'WebSearch',
];
const MODELS = ['haiku', 'sonnet', 'opus'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const TURN_TIMEOUT_MS = Number(process.env.KITCHEN_TURN_TIMEOUT_MS || 30 * 60_000);
/** The command that runs a turn; tests point it at a stand-in. */
const CLAUDE = process.env.KITCHEN_CLAUDE_BIN || 'claude';

export interface TurnInput {
  input: string;
  cwd?: string;
  model?: string;
  effort?: string;
}

/** The claude arguments for one turn: a new chat on the first turn, the same chat resumed after that. */
export function claudeArgs(checkpoint: Checkpoint, t: TurnInput, first: boolean): string[] {
  return [
    '-p',
    ...(first ? ['--session-id', checkpoint.claudeSession as string] : ['--resume', checkpoint.claudeSession as string]),
    '--permission-mode', 'acceptEdits',
    ...(t.model && MODELS.includes(t.model) ? ['--model', t.model] : []),
    ...(t.effort && EFFORTS.includes(t.effort) ? ['--effort', t.effort] : []),
    '--allowedTools', ...TOOLS,
  ];
}

// One turn: the prompt goes in on stdin (never in argv), the reply is what claude prints.
async function runTurn(checkpoint: Checkpoint, t: TurnInput): Promise<string> {
  const first = !checkpoint.claudeSession;
  if (first) checkpoint.claudeSession = randomUUID();
  const cwd = t.cwd && existsSync(t.cwd) ? t.cwd : process.cwd();
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, claudeArgs(checkpoint, t, first), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TURN_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += String(d)));
    child.stderr.on('data', (d) => (err += String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`claude exited with ${code}: ${(err || out).trim().slice(-500)}`));
    });
    child.stdin.end(t.input);
  });
}

let draining = false;
let inFlight = 0;
// Turns in flight per session, so GET /sessions can tell an active session from an idle one.
const activeTurns = new Map<string, number>();
const SESSION_LIST_LIMIT = 500;

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  inFlight++;
  res.on('close', () => inFlight--);
  const url = new URL(req.url ?? '/', 'http://localhost');

  try {
    if (url.pathname === '/health') {
      return sendJson(res, 200, { status: 'ok', service: 'kitchen', draining });
    }

    if (url.pathname === '/ready') {
      const ok = !draining && (await store.ready());
      return sendJson(res, ok ? 200 : 503, { ready: ok, durability: DURABILITY });
    }

    // Session routing: the session id comes from the x-session-id header, so several instances of one agent can
    // share a Traefik route and each session still reaches its own checkpoint.
    if (url.pathname === '/turn' && req.method === 'POST') {
      if (draining) return sendJson(res, 503, { error: 'draining' });
      const sessionId = String(req.headers['x-session-id'] ?? '');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
        return sendJson(res, 400, { error: 'x-session-id header is required (1-128 letters, digits, - or _)' });
      }
      const body = await readJson(req);
      const input = String(body.input ?? '');
      if (!input) return sendJson(res, 400, { error: 'input is required' });
      activeTurns.set(sessionId, (activeTurns.get(sessionId) ?? 0) + 1);
      try {
        const checkpoint = await store.load(sessionId);
        checkpoint.messages.push({ role: 'user', content: input, at: new Date().toISOString() });
        let reply: string;
        try {
          reply = await runTurn(checkpoint, { input, cwd: body.cwd, model: body.model, effort: body.effort });
        } catch (e) {
          // The turn failed (claude exited, timed out): say so, and keep the chat id so a retry resumes it.
          await store.save(checkpoint);
          return sendJson(res, 502, { sessionId, error: String((e as Error).message ?? e) });
        }
        checkpoint.messages.push({ role: 'agent', content: reply, at: new Date().toISOString() });
        await store.save(checkpoint);
        return sendJson(res, 200, { sessionId, reply, turns: checkpoint.messages.length / 2 });
      } finally {
        const left = (activeTurns.get(sessionId) ?? 1) - 1;
        if (left > 0) activeTurns.set(sessionId, left);
        else activeTurns.delete(sessionId);
      }
    }

    if (url.pathname === '/session' && req.method === 'GET') {
      const sessionId = String(req.headers['x-session-id'] ?? '');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return sendJson(res, 400, { error: 'x-session-id header is required' });
      const checkpoint = await store.load(sessionId);
      return sendJson(res, 200, { sessionId, turns: checkpoint.messages.length / 2, messages: checkpoint.messages });
    }

    // Read-only list of the stored sessions, most recent first. status is 'active' while this instance runs a turn
    // for the session, otherwise 'idle'. total counts every stored session, also those past the limit.
    if (url.pathname === '/sessions' && req.method === 'GET') {
      const all = (await store.list()).sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
      const sessions = all.slice(0, SESSION_LIST_LIMIT).map((s) => ({
        ...s,
        status: activeTurns.has(s.sessionId) ? 'active' : 'idle',
      }));
      return sendJson(res, 200, { sessions, total: all.length });
    }

    return sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error('[agent] request failed:', error);
    return sendJson(res, 500, { error: 'internal_error' });
  }
});

// Loopback only: every turn runs your own claude with edit rights, so nothing off this Mac may reach it. It runs as a
// local process (service.json "command"), so no Docker network needs to reach it either.
if (import.meta.main) server.listen(PORT, '127.0.0.1', () => {
  console.log('\n🤖 kitchen agent on http://localhost:' + PORT + ' (durability: ' + DURABILITY + ', claude: ' + CLAUDE + ')');
});

// Drain on SIGTERM (flisk down, hot reload, docker stop): stop taking turns, let in-flight turns finish, then exit 0.
// Checkpoints are written before a turn is answered, so a drained exit loses no acknowledged turn.
function shutdown(signal: string) {
  if (draining) return;
  draining = true;
  console.log('[agent] ' + signal + ' received, draining ' + inFlight + ' in-flight request(s)');
  server.close();
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  const timer = setInterval(() => {
    if (inFlight === 0 || Date.now() > deadline) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 100);
}
if (import.meta.main) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

export { server };
