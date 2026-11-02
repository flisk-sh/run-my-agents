import { describe, expect, it } from "bun:test";
import { createApp } from "../src/index";
import { findClashes, guessRole, parseSession } from "../src/sessions";

const line = (o: object) => JSON.stringify(o);
const now = Date.parse("2026-11-01T12:00:00Z");
const edit = (file: string, ts = "2026-11-01T11:58:00Z") =>
	line({
		type: "assistant",
		cwd: "/repo",
		gitBranch: "main",
		timestamp: ts,
		message: { content: [{ type: "text", text: "Fixing it." }, { type: "tool_use", name: "Edit", input: { file_path: file } }] },
	});
const ask = (text: string) => line({ type: "user", cwd: "/repo", message: { content: text } });

describe("sessions", () => {
	it("reads the title, last words, last tool and edited files", () => {
		const s = parseSession("abc", [ask("tune the login query"), "not json", edit("/repo/src/api.ts")], now);
		expect(s?.title).toBe("tune the login query");
		expect(s?.said).toBe("Fixing it.");
		expect(s?.doing).toBe("Edit api.ts");
		expect(s?.edits.map((e) => e.file)).toEqual(["/repo/src/api.ts"]);
		expect(s?.role).toBe("Code");
	});

	it("skips transcripts with no conversation", () => {
		expect(parseSession("x", [line({ type: "summary" })], now)).toBeUndefined();
	});

	it("guesses roles from the title and files", () => {
		expect(guessRole("redesign the pricing page", [])).toBe("Design");
		expect(guessRole("x", ["/repo/public/sitemap.xml"])).toBe("SEO");
		expect(guessRole("cut the demo video", [])).toBe("Video");
	});

	it("reports a file edited by two sessions within 10 minutes, not older edits", () => {
		const a = parseSession("a", [ask("one"), edit("/repo/api.ts")], now);
		const b = parseSession("b", [ask("two"), edit("/repo/api.ts")], now);
		const old = parseSession("c", [ask("three"), edit("/repo/api.ts", "2026-11-01T10:00:00Z")], now);
		const clashes = findClashes([a, b, old].filter((s) => s !== undefined), now);
		expect(clashes).toEqual([{ file: "/repo/api.ts", sessions: ["a", "b"] }]);
	});
});

describe("board", () => {
	it("serves the page and the sessions with a face and the clash", async () => {
		const a = parseSession("a", [ask("fix <b>one</b>"), edit("/repo/api.ts")], Date.now());
		const b = parseSession("b", [ask("two"), edit("/repo/api.ts")], Date.now());
		const sessions = [a, b].filter((s) => s !== undefined);
		for (const s of sessions) s.edits = s.edits.map((e) => ({ ...e, at: Date.now() }));
		const app = createApp(() => sessions);
		expect(await (await app.request("/")).text()).toContain('<nav class="side" id="side">');
		const json = await (await app.request("/api/sessions")).json();
		expect(json.sessions).toHaveLength(2);
		expect(json.sessions[0].face.shape).toBeString();
		expect(json.sessions[0].feed.map((f: { who: string }) => f.who)).toEqual(["you", "agent"]);
		expect(json.clashes).toEqual([{ file: "/repo/api.ts", sessions: ["a", "b"] }]);
	});

	it("escapes text in the page script, not the server", async () => {
		const html = await (await createApp(() => []).request("/")).text();
		expect(html).toContain("const esc=");
		expect(html).toContain("No Claude Code sessions in the last hour");
	});
});

describe("codex, limits and skills", () => {
	it("reads a Codex rollout: id, model, tokens without cache reads, and the turns", async () => {
		const { parseCodexSession } = await import("../src/sessions");
		const s = parseCodexSession(
			[
				line({ type: "session_meta", payload: { id: "cx1", cwd: "/repo" } }),
				line({ type: "turn_context", payload: { model: "gpt-6" } }),
				line({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "add a sitemap" }] } }),
				line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ text: "Done." }] } }),
				line({ type: "response_item", payload: { type: "custom_tool_call", name: "exec" } }),
				line({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } } } }),
			],
			now,
		);
		expect(s).toMatchObject({ id: "cx1", agent: "codex", model: "gpt-6", role: "SEO", tokens: { used: 250, cached: 800 } });
		expect(s?.feed.map((f) => f.who)).toEqual(["you", "agent"]);
		expect(s?.feed[1].tools).toEqual(["exec"]);
	});

	it("only ever moves a model down the ladder", async () => {
		const { lowerModel } = await import("../../../../hooks/limits.mjs");
		expect(lowerModel("claude-opus-5-5")).toBe("sonnet");
		expect(lowerModel("claude-sonnet-5-5")).toBe("haiku");
		expect(lowerModel("claude-haiku-5-5")).toBeNull();
		expect(lowerModel("gpt-6")).toBeNull();
	});

	it("refuses writes that are not JSON or come from another site", async () => {
		const app = createApp(() => []);
		expect((await app.request("/api/limits", { method: "POST", body: "sessionTokens=1" })).status).toBe(403);
		const evil = await app.request("/api/limits", {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://evil.example" },
			body: "{}",
		});
		expect(evil.status).toBe(403);
	});

	it("will not downgrade a session that is already on the cheapest model", async () => {
		const s = parseSession("h", [ask("x"), line({ type: "assistant", message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "hi" }] } })], now);
		const app = createApp(() => (s ? [s] : []));
		const res = await app.request("/api/downgrade", { method: "POST", headers: { "content-type": "application/json" }, body: '{"id":"h"}' });
		expect(res.status).toBe(400);
	});

	it("moves the session itself to the cheaper model, so the button steps down again", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { applyTune } = await import("../src/prefs");
		const dir = mkdtempSync(`${tmpdir()}/rma-down-`);
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(`${tmpdir()}/rma-prefs-`);
		const s = parseSession("d1", [ask("x"), line({ type: "assistant", cwd: dir, message: { model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }] } })], now);
		const app = createApp(() => applyTune(s ? [s] : []));
		const res = await app.request("/api/downgrade", { method: "POST", headers: { "content-type": "application/json" }, body: '{"id":"d1"}' });
		expect(await res.json()).toMatchObject({ model: "sonnet", next: "haiku" });
		const after = (await (await app.request("/api/sessions")).json()).sessions[0];
		expect([after.tune?.model, after.lower]).toEqual(["sonnet", "haiku"]);
	});

	it("will not write settings into a folder that does not exist", async () => {
		const s = parseSession("o", [ask("x"), line({ type: "assistant", cwd: "/no/such/folder", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }] } })], now);
		const app = createApp(() => (s ? [s] : []));
		const res = await app.request("/api/downgrade", { method: "POST", headers: { "content-type": "application/json" }, body: '{"id":"o"}' });
		expect(res.status).toBe(400);
		const { setProjectModel } = await import("../../../../hooks/limits.mjs");
		expect(setProjectModel("relative/dir", "sonnet")).toBeNull();
		expect(setProjectModel("/tmp", "../../etc")).toBeNull();
	});

	it("suggests skills for each role from the roadmap catalog", async () => {
		const { skillsFor } = await import("../src/index");
		expect(skillsFor("Design").every((k) => k.cat === "frontend")).toBe(true);
		expect(skillsFor("Code").length).toBe(8);
	});
});

describe("grok", () => {
	const grokLine = (o: object) => JSON.stringify(o);
	const userQuery = (text: string) =>
		grokLine({ type: "user", content: [{ type: "text", text: `<user_query>\n${text}\n</user_query>` }] });
	const askGrok = (question: string, options: string[]) =>
		grokLine({
			type: "assistant",
			content: "Picking a direction.",
			model_id: "grok-4.5-build",
			tool_calls: [{ id: "call-1", name: "ask_user_question", arguments: JSON.stringify({ questions: [{ question, options: options.map((label) => ({ label, description: "" })) }] }) }],
		});

	it("reads a chat_history.jsonl: title, model, tokens from usage, a file edit and a background command", async () => {
		const { parseGrokSession } = await import("../src/sessions");
		const s = parseGrokSession(
			"01a0d502-8233-7121-a6fd-d65bab536c67",
			"/repo",
			[
				grokLine({ type: "system", content: "You are Grok." }),
				userQuery("fix the sitemap"),
				grokLine({
					type: "assistant",
					content: "Reading it first.",
					model_id: "grok-4.5-build",
					tool_calls: [
						{ id: "call-a", name: "read_file", arguments: JSON.stringify({ target_file: "/repo/sitemap.xml" }) },
						{ id: "call-b", name: "search_replace", arguments: JSON.stringify({ file_path: "/repo/sitemap.xml", old_string: "a\nb", new_string: "a\nb\nc" }) },
						{ id: "call-c", name: "run_terminal_command", arguments: JSON.stringify({ command: "bun dev", description: "Start the dev server", background: true }) },
						{ id: "call-d", name: "todo_write", arguments: JSON.stringify({ todos: [{ content: "Fix the sitemap", status: "in_progress" }] }) },
					],
				}),
			],
			{ inputTokens: 1000, outputTokens: 50, cachedReadTokens: 800, cacheCreationTokens: 0 },
			now,
		);
		expect(s).toMatchObject({ id: "01a0d502-8233-7121-a6fd-d65bab536c67", agent: "grok", model: "grok-4.5-build", cwd: "/repo", title: "fix the sitemap", tokens: { used: 1050, cached: 800 } });
		expect(s?.edits).toEqual([{ file: "/repo/sitemap.xml", at: now, add: 3, del: 2 }]);
		expect(s?.feed[1].tools).toEqual(["Read sitemap.xml", "Edit sitemap.xml", "Bash", "Plan"]);
		expect(s?.feed[1].calls?.[0]).toMatchObject({ label: "Read sitemap.xml", detail: "/repo/sitemap.xml" });
		expect(s?.bg).toEqual([{ what: "Start the dev server", at: now }]);
		expect(s?.plan).toEqual([{ text: "Fix the sitemap", status: "in_progress" }]);
	});

	it("waits for a question, then clears it once Grok's own tool_result reports the answer", async () => {
		const { parseGrokSession } = await import("../src/sessions");
		const asked = parseGrokSession("01a0d5ac-2686-7830-b28d-4b563bf98280", "/repo", [userQuery("go"), askGrok("Which fix?", ["Fast", "Thorough"])], undefined, now);
		expect(asked?.awaiting).toBe(true);
		expect(asked?.feed.at(-1)?.options).toEqual({ ask: "Which fix?", labels: ["Fast", "Thorough"] });
		const answered = parseGrokSession(
			"01a0d5ac-2686-7830-b28d-4b563bf98280",
			"/repo",
			[userQuery("go"), askGrok("Which fix?", ["Fast", "Thorough"]), grokLine({ type: "tool_result", tool_call_id: "call-1", content: 'User has answered your questions: "Which fix?"="Fast"' })],
			undefined,
			now,
		);
		expect(answered?.awaiting).toBe(false);
	});

	it("finds Grok Build sessions on disk: one folder per cwd, one per session id", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const root = mkdtempSync(join(tmpdir(), "rma-grok-"));
		const enc = encodeURIComponent("/repo");
		const id = "01a0d530-4c9a-7782-b980-1dc79bc04e29";
		const dir = join(root, enc, id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "chat_history.jsonl"), [userQuery("add tests"), grokLine({ type: "assistant", content: "On it.", model_id: "grok-4.5" })].join("\n"));
		writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id, cwd: "/repo" } }));
		writeFileSync(join(dir, "usage.json"), JSON.stringify({ session: { inputTokens: 10, outputTokens: 5, cachedReadTokens: 0, cacheCreationTokens: 0 } }));
		const { readGrokSessions } = await import("../src/sessions");
		const sessions = readGrokSessions(root, 60 * 60_000, Date.now());
		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ id, agent: "grok", cwd: "/repo", title: "add tests", tokens: { used: 15, cached: 0 } });
	});

	it("shows why a Grok turn failed instead of thinking forever", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const root = mkdtempSync(join(tmpdir(), "rma-grok-err-"));
		const id = "3d5e4e6b-9d17-4eda-a033-9413c94a3b51";
		const dir = join(root, encodeURIComponent("/repo"), id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "chat_history.jsonl"), userQuery("hello"));
		const done = (stop: string, result: string) => JSON.stringify({ method: "_x.ai/session/update", params: { sessionId: id, update: { sessionUpdate: "turn_completed", stop_reason: stop, agent_result: result }, _meta: { agentTimestampMs: Date.now() } } });
		writeFileSync(join(dir, "updates.jsonl"), [done("end_turn", "ok"), done("error", "API error (status 402 Payment Required): Grok Build usage balance exhausted")].join("\n"));
		const { readGrokSessions, grokTurnError } = await import("../src/sessions");
		const [s] = readGrokSessions(root, 60 * 60_000, Date.now());
		expect(s.doing).toBe("Error");
		expect(s.feed.at(-1)).toMatchObject({ who: "agent", text: expect.stringContaining("usage balance exhausted") });
		writeFileSync(join(dir, "updates.jsonl"), [done("error", "x"), done("end_turn", "ok")].join("\n"));
		expect(grokTurnError(dir)).toBeUndefined();
	});
});

describe("hover pop-ups", () => {
	it("opens no pop-up when it has nothing to show, like a tool row", async () => {
		const { PAGE } = await import("../src/page");
		expect(PAGE).toContain('const html=popHtml(chip.dataset.pop,s,chip);if(!html)return;');
	});
});

describe("send", () => {
	it("sends a message to the session and refuses empty text or a second send while one is on its way", async () => {
		const s = parseSession("a", [ask("hi"), edit("/repo/x.ts")], now);
		const sent: string[] = [];
		let finish = () => {};
		const app = createApp(
			() => (s ? [s] : []),
			async (_, text) => {
				sent.push(text);
				await new Promise<void>((r) => {
					finish = r;
				});
			},
		);
		const post = (body: object) =>
			app.request("/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		expect((await post({ id: "a", text: "  " })).status).toBe(400);
		expect((await post({ id: "a", text: "add tests" })).status).toBe(202);
		// a busy session queues the message and sends it when the reply ends
		const queued = await post({ id: "a", text: "again" });
		expect(queued.status).toBe(202);
		expect(await queued.json()).toMatchObject({ queued: true });
		expect(sent).toEqual(["add tests"]);
		finish();
		await Bun.sleep(5);
		expect(sent).toEqual(["add tests", "again"]);
		expect((await post({ id: "nope", text: "x" })).status).toBe(404);
	});

	it("sends a queued message now, or drops it", async () => {
		const s = parseSession("q", [ask("hi"), edit("/repo/x.ts")], now);
		const sent: string[] = [];
		const app = createApp(() => (s ? [s] : []), async (_, text) => {
			sent.push(text);
			await new Promise(() => {});
		});
		const post = async (path: string, body: object) => (await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
		await post("/api/send", { id: "q", text: "first" });
		const a = await post("/api/send", { id: "q", text: "second" });
		const b = await post("/api/send", { id: "q", text: "third" });
		expect((await (await app.request("/api/sessions")).json()).sessions[0].queue.map((x: { text: string }) => x.text)).toEqual(["second", "third"]);
		expect(await post("/api/queue/now", { id: "q", qid: b.qid })).toMatchObject({ sent: true });
		expect(sent).toEqual(["first", "third"]);
		await post("/api/queue/drop", { id: "q", qid: a.qid });
		expect((await (await app.request("/api/sessions")).json()).sessions[0].queue).toEqual([]);
	});

	it("lets a resumed copy into the other repos the session worked in", async () => {
		const { workDirs } = await import("../src/index");
		const { mkdtempSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const own = mkdtempSync(`${tmpdir()}/rma-own-`);
		const other = mkdtempSync(`${tmpdir()}/rma-other-`);
		mkdirSync(`${other}/.git`);
		mkdirSync(`${other}/src`);
		const cd = line({ type: "assistant", cwd: own, message: { content: [{ type: "tool_use", id: "b", name: "Bash", input: { command: `cd ${other}/src && ls` } }] } });
		const s = parseSession("w", [ask("x"), edit(`${own}/a.ts`), cd], now);
		expect(s && workDirs(s)).toEqual([other]);
	});

	it("sums up a PR's checks as pass, fail or pending", async () => {
		const { checksOf } = await import("../src/index");
		expect(checksOf([])).toBe("");
		expect(checksOf([{ conclusion: "SUCCESS" }, { state: "SUCCESS" }])).toBe("pass");
		expect(checksOf([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("pending");
		expect(checksOf([{ conclusion: "FAILURE" }, { status: "IN_PROGRESS" }])).toBe("fail");
	});

	it("names tools the way a person would", async () => {
		const { toolLabel } = await import("../src/sessions");
		expect(toolLabel("mcp__Claude_Browser__browser_batch")).toBe("Browser actions");
		expect(toolLabel("mcp__Claude_Browser__computer", { action: "screenshot" })).toBe("Browser screenshot");
		expect(toolLabel("mcp__claude-in-chrome__navigate")).toBe("Chrome open page");
		expect(toolLabel("mcp__ccd_turn__wrap_up")).toBe("Wrap-up");
		expect(toolLabel("mcp__toolradar__search_tools")).toBe("Toolradar search tools");
		expect(toolLabel("Grep")).toBe("Search");
		expect(toolLabel("Bash")).toBe("Bash");
	});

	it("follows the agent's plan, subagents, background commands, hooks and permission mode", () => {
		const tool = (name: string, input: object, id = "t") => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
		const s = parseSession("act", [
			line({ type: "user", permissionMode: "auto", message: { content: "go" } }),
			tool("mcp__ccd_turn__update_plan", { items: [{ content: "a", status: "in_progress" }, { content: "b", status: "pending" }, { content: "c", status: "pending" }] }),
			tool("mcp__ccd_turn__update_plan", { advance: true }),
			tool("Agent", { description: "Look around", subagent_type: "Explore" }, "ag1"),
			tool("Agent", { description: "Write tests" }, "ag2"),
			line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ag1", content: "ok" }] } }),
			tool("Bash", { command: "bun dev", description: "Start dev server", run_in_background: true }),
			line({ type: "system", subtype: "stop_hook_summary", hookCount: 1, hookErrors: ["x"], hookInfos: [{ command: "'/a b/notify.sh' stop" }] }),
		], now);
		expect(s?.mode).toBe("auto");
		expect(s?.plan?.map((x) => x.status)).toEqual(["completed", "in_progress", "pending"]);
		expect(s?.agents?.map((a) => [a.what, a.done])).toEqual([["Look around", true], ["Write tests", false]]);
		expect(s?.bg?.[0].what).toBe("Start dev server");
		expect(s?.hooks).toEqual({ runs: 1, errors: 1, last: "notify.sh" });
	});

	it("counts edit sizes, the context window and when you last wrote", async () => {
		const { editSize } = await import("../src/sessions");
		expect(editSize("Edit", { old_string: "a\nb", new_string: "a\nb\nc" })).toEqual({ add: 3, del: 2 });
		expect(editSize("Write", { content: "x\ny" })).toEqual({ add: 2, del: 0 });
		expect(editSize("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d\ne" }] })).toEqual({ add: 3, del: 2 });
		const s = parseSession("ctx", [
			line({ type: "user", timestamp: "2026-11-01T12:00:00Z", message: { content: "go" } }),
			line({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 5_000, output_tokens: 7 }, content: [{ type: "text", text: "ok" }] } }),
			line({ type: "system", subtype: "compact_boundary" }),
		], now);
		expect([s?.context, s?.compacts, s?.asked]).toEqual([95_010, 1, Date.parse("2026-11-01T12:00:00Z")]);
	});

	it("keeps UMUX-Lite ratings on this computer and refuses bad ones", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(`${tmpdir()}/rma-umux-`);
		const app = createApp(() => []);
		const post = (b: object) => app.request("/api/umux", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
		expect((await post({ q1: 0, q2: 5 })).status).toBe(400);
		expect((await post({ q1: 6, q2: 7 })).status).toBe(200);
		expect((await (await app.request("/api/umux")).json()).ratings.map((r: { q1: number; q2: number }) => [r.q1, r.q2])).toEqual([[6, 7]]);
	});

	it("keeps what each tool call actually ran", async () => {
		const { callDetail } = await import("../src/sessions");
		expect(callDetail("Bash", { command: "bun test", description: "Run the tests" })).toEqual({ what: "Run the tests", detail: "bun test" });
		expect(callDetail("Read", { file_path: "/repo/a.ts" })).toEqual({ detail: "/repo/a.ts" });
		expect(callDetail("Grep", { pattern: "TODO", path: "src" })).toEqual({ detail: "TODO  in src" });
		expect(callDetail("WebFetch", { url: "https://x.dev", prompt: "read it" })).toEqual({ what: "read it", detail: "https://x.dev" });
		const tool = (command: string) => line({ type: "assistant", message: { content: [{ type: "tool_use", id: command, name: "Bash", input: { command } }] } });
		const s = parseSession("calls", [ask("go"), tool("ls"), tool("git status"), tool("bun test")], now);
		expect(s?.feed.at(-1)?.calls?.map((c) => c.detail)).toEqual(["ls", "git status", "bun test"]);
	});

	it("runs a board message in the session's own permission mode unless you picked one", async () => {
		const { boardMode } = await import("../src/index");
		expect(boardMode({ mode: "bypassPermissions" })).toBe("bypassPermissions");
		expect(boardMode({ mode: "auto" })).toBe("auto");
		expect(boardMode({ mode: "plan" })).toBe("acceptEdits");
		expect(boardMode({})).toBe("acceptEdits");
		expect(boardMode({ mode: "bypassPermissions", tune: { mode: "default" } })).toBe("default");
	});

	it("puts the prompt on stdin, not in the command line", async () => {
		const { sendToSession } = await import("../src/index");
		const s = parseSession("a", [ask("hi"), edit("/repo/x.ts")], now);
		let seen: { cmd: string; args: string[]; stdin: string } | undefined;
		const fake = ((cmd: string, args: string[]) => {
			const child = new (require("node:events").EventEmitter)();
			child.stdin = { end: (t: string) => { seen = { cmd, args, stdin: t }; setTimeout(() => child.emit("close"), 0); } };
			return child;
		}) as never;
		if (s) await sendToSession(s, "-rf everything", fake);
		expect(seen?.cmd).toBe("claude");
		expect(seen?.args).toEqual(["-p", "--resume", "a", "--permission-mode", "acceptEdits"]);
		expect(seen?.stdin).toBe("-rf everything");
	});

	it("writes Grok's prompt to a --prompt-file, since it has no stdin prompt mode, and cleans it up", async () => {
		const { sendToSession } = await import("../src/index");
		const { readFileSync, existsSync } = await import("node:fs");
		const s = { id: "01a0d530-4c9a-7782-b980-1dc79bc04e29", agent: "grok", cwd: "/repo", tune: {}, mode: "acceptEdits", edits: [] } as never;
		let seen: { cmd: string; args: string[] } | undefined;
		let promptFile = "";
		let promptSeenByGrok = "";
		const fake = ((cmd: string, args: string[]) => {
			seen = { cmd, args };
			promptFile = args[args.indexOf("--prompt-file") + 1];
			promptSeenByGrok = readFileSync(promptFile, "utf8");
			const child = new (require("node:events").EventEmitter)();
			setTimeout(() => child.emit("close"), 0);
			return child;
		}) as never;
		await sendToSession(s, "-rf everything", fake);
		expect(seen?.cmd).toBe("grok");
		expect(seen?.args).toEqual(["--cwd", "/repo", "--resume", "01a0d530-4c9a-7782-b980-1dc79bc04e29", "--output-format", "json", "--permission-mode", "acceptEdits", "--prompt-file", promptFile]);
		expect(seen?.args.join(" ")).not.toContain("-rf everything");
		expect(promptSeenByGrok).toBe("-rf everything");
		expect(existsSync(promptFile)).toBe(false);
	});
});

describe("page", () => {
	it("ships a script that parses", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
	});

	it("keeps the plan popover open while its bowling lane is rolling, so a pin gets the chance to fall", async () => {
		const { PAGE } = await import("../src/page");
		// The roll takes a couple of seconds; a stray mouseout used to close the popover (and tear down the WebGL
		// canvas) long before any pin could fall. The hover-away and click-away closers must both check for a
		// live ".bowl canvas" and skip closing while it is there; a click on the chip, elsewhere, or Escape still
		// closes it (those paths are unchanged and still covered by the click/mouseover listeners below).
		expect(PAGE).toContain('if(p.querySelector(".bowl canvas"))return;apT=setTimeout(hideAct,250)');
		expect(PAGE).toContain('!apEl.querySelector(".bowl canvas")');
		expect(PAGE).toContain('document.addEventListener("click",e=>{if(apEl&&!e.target.closest(".apop")&&!e.target.closest("[data-pop]"))hideAct()});');
	});
});

describe("roles", () => {
	it("guesses Bug, Refactor and Feature from the title", () => {
		expect(guessRole("fix the login crash", [])).toBe("Bug");
		expect(guessRole("refactor the payments module", [])).toBe("Refactor");
		expect(guessRole("add dark mode", [])).toBe("Feature");
		expect(guessRole("tune the parser", ["/repo/src/a.ts"])).toBe("Code");
	});
});

describe("faces", () => {
	it("gives every session of a role the same face and color, Code blue and Design purple", async () => {
		const { faceOf } = await import("../src/index");
		const code = [parseSession("a", [ask("tune the parser")], now), parseSession("b", [ask("write a test")], now)].filter((s) => s !== undefined);
		expect(faceOf(code[0])).toEqual(faceOf(code[1]));
		expect(faceOf(code[0]).color).toBe("#38bdf8");
		const design = parseSession("c", [ask("redesign the pricing page")], now);
		expect(design && faceOf(design).color).toBe("#a78bfa");
	});
});

describe("typing box", () => {
	it("never shares a class name with the feed's typing dots, which would restyle the whole box", async () => {
		const { PAGE } = await import("../src/page");
		expect(PAGE).not.toMatch(/\.compose\.typing/);
		expect(PAGE).not.toContain('classList.add("typing")');
		// the dots keep their own .typing rule
		expect(PAGE).toContain(".typing{display:flex");
	});
	it("makes the plain design a light theme with no mascots, and gives its new-session dialog button rows", async () => {
		const { PAGE } = await import("../src/page");
		expect(PAGE).toMatch(/body\.plain\{--text:#1f2328[^}]*color-scheme:light/);
		expect(PAGE).toMatch(/body\.plain \.av,[^{]*\{display:none!important/);
		// the header wraps, so the action buttons cannot squeeze the session title
		expect(PAGE).toMatch(/body\.plain \.hd\{[^}]*flex-wrap:wrap/);
		expect(PAGE).toContain('design==="plain"?\'<div class="pp" style="flex:1">\'+plainTune("","")');
	});
	it("draws a plain agent panel with text controls and a tooltip on each", async () => {
		const { PAGE } = await import("../src/page");
		const panel = PAGE.split("function plainPanel(s){")[1].split("function tune(")[0];
		for (const hook of ['data-model="', 'data-effort="', 'data-sw="pin"', 'data-sw="mute"', 'data-mrole="', 'data-tile="', 'data-copy="name"', 'data-copy="id"', 'data-copy="resume"', 'data-close="1"', 'data-del="1"']) {
			expect(panel.split(hook)[1].slice(0, 200)).toContain("data-tip=");
		}
		expect(panel).not.toContain("<svg");
		expect(PAGE).toContain('design==="plain"?plainPanel(s):gaugePanel(s)');
	});
	it("offers a plain design that drops glow and animation, and remembers the choice", async () => {
		const { PAGE } = await import("../src/page");
		expect(PAGE).toContain('"data-design":k');
		expect(PAGE).toContain('localStorage.setItem("rma-design",design)');
		expect(PAGE).toMatch(/body\.plain \*,[^{]*\{animation:none!important/);
		expect(PAGE).toContain('P("Resume cmd","Resume command")');
	});
	it("gives every control in the agent panel a hover tooltip", async () => {
		const { PAGE } = await import("../src/page");
		const panel = PAGE.split("function gaugePanel(s){")[1].split("function tune(")[0];
		for (const hook of ['data-sw="pin"', 'data-sw="mute"', 'data-tile="', 'data-copy="name"', 'data-copy="id"', 'data-copy="resume"', 'data-close="1"', 'data-del="1"', 'data-mrole=""']) {
			expect(panel).toContain(hook);
			expect(panel.split(hook)[1].slice(0, 200)).toContain("data-tip=");
		}
		expect(PAGE).toContain('id="tip"');
		expect(PAGE).toMatch(/class="mdot" data-tip=/);
		expect(PAGE).toMatch(/data-effort="'\+e\+'" data-tip=/);
	});
});

describe("motion and model tags", () => {
	it("ships a script that still parses, with a mini model tag and a shake that speeds up under token pressure", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
		expect(PAGE).toContain("@keyframes shake");
		expect(PAGE).toContain("function mtag(");
		expect(PAGE).toContain("function motion(");
	});
});

describe("claude desktop pins and names", () => {
	it("shows a session the app lists before its transcript exists, like a new sub-session", async () => {
		const { waitingSessions } = await import("../src/sessions");
		const now = 1_000_000_000;
		const m = (o: Record<string, unknown>) => ({ title: "", pinned: false, archived: false, effort: "", at: now - 1000, prs: [], branches: [], cwd: "/w", ...o });
		const meta = new Map([
			["cli-new", m({ title: "Run-my-agents card: smaller badges" })],
			["cli-has", m({ title: "Has a transcript" })],
			["cli-arch", m({ archived: true })],
			["cli-old", m({ at: now - 2 * 60 * 60_000 })],
		]);
		const out = waitingSessions(meta, new Set(["cli-has"]), now);
		expect(out.map((s) => s.id)).toEqual(["cli-new"]);
		expect(out[0]).toMatchObject({ title: "Run-my-agents card: smaller badges", cwd: "/w", doing: "Starting", viaApp: true, updatedAt: now - 1000 });
	});

	it("reads the app's names and pins, keyed by the CLI session id", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { readDesktopMeta } = await import("../src/desktop");
		const root = mkdtempSync(join(tmpdir(), "rma-desk-"));
		const dir = join(root, "claude-code-sessions", "acct", "org");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(root, "claude_desktop_config.json"), JSON.stringify({ preferences: { epitaxyPrefs: { "starred-local-code-sessions": ["local_a"] } } }));
		writeFileSync(join(dir, "local_a.json"), JSON.stringify({ sessionId: "local_a", cliSessionId: "cli-a", title: "Flisk 5-second YouTube Short" }));
		writeFileSync(join(dir, "local_b.json"), JSON.stringify({ sessionId: "local_b", cliSessionId: "cli-b", title: "Ghostfolio", isArchived: true }));
		writeFileSync(join(dir, "local_c.json"), "not json");
		const meta = readDesktopMeta(root);
		expect(meta.get("cli-a")).toEqual({ title: "Flisk 5-second YouTube Short", pinned: true, archived: false, effort: "", at: 0, prs: [], branches: [], cwd: "" });
		expect(meta.get("cli-b")).toEqual({ title: "Ghostfolio", pinned: false, archived: true, effort: "", at: 0, prs: [], branches: [], cwd: "" });
		expect(meta.size).toBe(2);
	});

	it("reads a missing app folder as no pins, and guesses Video for a YouTube Short", async () => {
		const { readDesktopMeta } = await import("../src/desktop");
		expect(readDesktopMeta("/nonexistent/claude").size).toBe(0);
		expect(guessRole("Flisk 5-second YouTube Short", [])).toBe("Video");
	});
});

describe("new sessions and agent types", () => {
	const J = { "content-type": "application/json" };
	const post = (app: ReturnType<typeof createApp>, path: string, body: object) =>
		app.request(path, { method: "POST", headers: J, body: JSON.stringify(body) });

	it("detects the agent type from the text, and the AI when it is named", async () => {
		const app = createApp(() => [], undefined, { which: () => ({ claude: true, codex: true, grok: false }) });
		expect(await (await app.request("/api/detect?text=" + encodeURIComponent("cut the demo video"))).json()).toEqual({ role: "Video", agent: null });
		expect((await (await app.request("/api/detect?text=" + encodeURIComponent("ask codex to fix sitemap"))).json()).agent).toBe("codex");
		const noCodex = createApp(() => [], undefined, { which: () => ({ claude: true, codex: false, grok: false }) });
		expect((await (await noCodex.request("/api/detect?text=use+codex")).json()).agent).toBeNull();
		const withGrok = createApp(() => [], undefined, { which: () => ({ claude: true, codex: false, grok: true }) });
		expect((await (await withGrok.request("/api/detect?text=" + encodeURIComponent("ask grok to fix it"))).json()).agent).toBe("grok");
		expect((await (await noCodex.request("/api/detect?text=ask+grok")).json()).agent).toBeNull();
	});

	it("offers installed agents, recent folders and every type with its face", async () => {
		const s = parseSession("a", [ask("hi"), edit("/repo/x.ts")], now);
		const app = createApp(() => (s ? [s] : []), undefined, { which: () => ({ claude: true, codex: false, grok: false }) });
		const o = await (await app.request("/api/options")).json();
		expect(o.defaultAgent).toBe("claude");
		expect(o.agents).toEqual({ claude: true, codex: false, grok: false });
		expect(o.folders).toEqual(["/repo"]);
		expect(o.roles.map((r: { role: string }) => r.role)).toContain("Video");
	});

	it("starts a Claude session in an existing folder with a chosen id, model and type", async () => {
		const { mkdtempSync, readFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "rma-new-"));
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-prefs-"));
		let seen: { agent: string; cwd: string; text: string; model?: string; id?: string } | undefined;
		const app = createApp(() => [], undefined, { which: () => ({ claude: true, codex: true, grok: false }), start: async (n) => { seen = n; } });
		const res = await post(app, "/api/new", { agent: "claude", cwd: dir, text: "cut the demo", role: "Video", model: "haiku" });
		expect(res.status).toBe(202);
		const { id } = await res.json();
		expect(seen).toMatchObject({ agent: "claude", cwd: dir, text: "cut the demo", model: "haiku", id });
		expect(JSON.parse(readFileSync(join(process.env.RUN_MY_AGENTS_DIR, "roles.json"), "utf8"))[id]).toBe("Video");
		for (const bad of [
			{ agent: "claude", cwd: dir, text: " " },
			{ agent: "vim", cwd: dir, text: "x" },
			{ agent: "claude", cwd: "/nonexistent/folder", text: "x" },
			{ agent: "claude", cwd: dir, text: "x", role: "Wizard" },
		])
			expect((await post(app, "/api/new", bad)).status).toBe(400);
		const none = createApp(() => [], undefined, { which: () => ({ claude: false, codex: false, grok: false }) });
		expect((await post(none, "/api/new", { agent: "claude", cwd: dir, text: "x" })).status).toBe(400);
		expect((await app.request("/api/new", { method: "POST", body: "text=x" })).status).toBe(403);
	});

	it("starts a Grok session with a board-chosen id, like Claude", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "rma-new-grok-"));
		let seen: { agent: string; cwd: string; text: string; id?: string } | undefined;
		const app = createApp(() => [], undefined, { which: () => ({ claude: true, codex: true, grok: true }), start: async (n) => { seen = n; }, grokAuth: () => true });
		const res = await post(app, "/api/new", { agent: "grok", cwd: dir, text: "scaffold a widget" });
		expect(res.status).toBe(202);
		const { id } = await res.json();
		expect(id).toMatch(/^[\w-]{10,}$/);
		expect(seen).toMatchObject({ agent: "grok", cwd: dir, text: "scaffold a widget", id });
		const notInstalled = createApp(() => [], undefined, { which: () => ({ claude: true, codex: true, grok: false }) });
		const res2 = await post(notInstalled, "/api/new", { agent: "grok", cwd: dir, text: "x" });
		expect(res2.status).toBe(400);
		expect((await res2.json()).error).toBe("Grok Build is not installed on this computer.");
		expect((await post(app, "/api/new", { agent: "gemini", cwd: dir, text: "x" })).status).toBe(400);
	});

	it("says Grok is not signed in instead of starting a session that never shows up", async () => {
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { grokSignedIn } = await import("../src/index");
		const dir = mkdtempSync(join(tmpdir(), "rma-grok-auth-"));
		let started = false;
		const app = createApp(() => [], undefined, { which: () => ({ claude: true, codex: true, grok: true }), start: async () => { started = true; }, grokAuth: () => false });
		const res = await post(app, "/api/new", { agent: "grok", cwd: dir, text: "x" });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain("not signed in");
		expect(started).toBe(false);
		const g = { id: "01a0d530-4c9a-7782-b980-1dc79bc04e29", agent: "grok", cwd: dir, edits: [], feed: [] } as never;
		const sent = await post(createApp(() => [g], async () => {}, { grokAuth: () => false }), "/api/send", { id: "01a0d530-4c9a-7782-b980-1dc79bc04e29", text: "hi" });
		expect(sent.status).toBe(400);
		expect(grokSignedIn({ GROK_HOME: dir })).toBe(false);
		expect(grokSignedIn({ GROK_HOME: dir, XAI_API_KEY: "k" })).toBe(true);
		writeFileSync(join(dir, "auth.json"), "{}");
		expect(grokSignedIn({ GROK_HOME: dir })).toBe(true);
	});

	it("puts the prompt on stdin and never in the command line, for both AIs", async () => {
		const { startNewSession } = await import("../src/index");
		const run = (out: { cmd?: string; args?: string[]; stdin?: string }) =>
			((cmd: string, args: string[]) => {
				const child = new (require("node:events").EventEmitter)();
				child.stdin = { end: (t: string) => { Object.assign(out, { cmd, args, stdin: t }); setTimeout(() => child.emit("close"), 0); } };
				return child;
			}) as never;
		const c: { cmd?: string; args?: string[]; stdin?: string } = {};
		await startNewSession({ agent: "claude", cwd: "/tmp", text: "-rf x", id: "i1", model: "opus" }, run(c));
		expect(c.args).toEqual(["-p", "--session-id", "i1", "--permission-mode", "acceptEdits", "--model", "opus"]);
		expect(c.stdin).toBe("-rf x");
		const x: { cmd?: string; args?: string[]; stdin?: string } = {};
		await startNewSession({ agent: "codex", cwd: "/tmp", text: "do it" }, run(x));
		expect(x.cmd).toBe("codex");
		expect(x.args).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "workspace-write"]);
		expect(x.stdin).toBe("do it");
	});

	it("starts a new Grok session with a chosen id, its prompt in a file", async () => {
		const { startNewSession } = await import("../src/index");
		const { readFileSync, existsSync } = await import("node:fs");
		let seen: { cmd: string; args: string[] } | undefined;
		let promptFile = "";
		let promptSeenByGrok = "";
		const fake = ((cmd: string, args: string[]) => {
			seen = { cmd, args };
			promptFile = args[args.indexOf("--prompt-file") + 1];
			promptSeenByGrok = readFileSync(promptFile, "utf8");
			const child = new (require("node:events").EventEmitter)();
			setTimeout(() => child.emit("close"), 0);
			return child;
		}) as never;
		await startNewSession({ agent: "grok", cwd: "/tmp", text: "scaffold the project", id: "01a0d892-323a-78c2-b0c6-7f654f5657af" }, fake);
		expect(seen?.cmd).toBe("grok");
		expect(seen?.args).toEqual(["--cwd", "/tmp", "--session-id", "01a0d892-323a-78c2-b0c6-7f654f5657af", "--output-format", "json", "--permission-mode", "acceptEdits", "--prompt-file", promptFile]);
		expect(promptSeenByGrok).toBe("scaffold the project");
		expect(existsSync(promptFile)).toBe(false);
	});

	it("lets you retype an existing session, and go back to the board's guess", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-prefs-"));
		const { applyRoles } = await import("../src/prefs");
		const fresh = () => [parseSession("s1", [ask("tune the parser")], now)].filter((s) => s !== undefined);
		const app = createApp(() => applyRoles(fresh()));
		expect((await post(app, "/api/role", { id: "s1", role: "Design" })).status).toBe(200);
		let s = (await (await app.request("/api/sessions")).json()).sessions[0];
		expect([s.role, s.roleSet, s.face.color]).toEqual(["Design", true, "#a78bfa"]);
		await post(app, "/api/role", { id: "s1", role: "" });
		s = (await (await app.request("/api/sessions")).json()).sessions[0];
		expect([s.role, s.roleSet]).toEqual(["Code", undefined]);
		expect((await post(app, "/api/role", { id: "s1", role: "Wizard" })).status).toBe(400);
	});

	it("lets you rename a session, and go back to its own title", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-names-"));
		const { applyNames } = await import("../src/prefs");
		const fresh = () => [parseSession("s1", [ask("tune the parser")], now)].filter((s) => s !== undefined);
		const app = createApp(() => applyNames(fresh()));
		expect((await post(app, "/api/name", { id: "s1", name: "  Payments cleanup  " })).status).toBe(200);
		let s = (await (await app.request("/api/sessions")).json()).sessions[0];
		expect([s.title, s.titleSet]).toEqual(["Payments cleanup", true]);
		await post(app, "/api/name", { id: "s1", name: "" });
		s = (await (await app.request("/api/sessions")).json()).sessions[0];
		expect([s.title, s.titleSet]).toEqual(["tune the parser", undefined]);
		expect((await post(app, "/api/name", { id: "nope", name: "x" })).status).toBe(404);
		expect((await post(app, "/api/name", { id: "s1", name: "x".repeat(121) })).status).toBe(400);
	});

	it("gives a just-started Codex session the type chosen for it once it appears", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-prefs-"));
		const { addPending, applyRoles } = await import("../src/prefs");
		addPending({ agent: "codex", cwd: "/repo", prefix: "cut the demo", role: "Video" });
		const cx = { id: "cx9", agent: "codex", title: "cut the demo reel", cwd: "/repo", updatedAt: Date.now(), role: "Code" } as never;
		expect(applyRoles([cx])[0].role).toBe("Video");
	});
});

describe("new session page", () => {
	it("still parses, and has the button, the dialog and the type picker", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
		for (const part of ['data-act="newopen"', 'id="dlg"', 'hb("roles"', "function startNew(", "function drawNew("]) expect(PAGE).toContain(part);
	});
});

describe("sessions the Claude app does not list", () => {
	it("goes in its own group, so the others match the app", async () => {
		const { PAGE } = await import("../src/page");
		expect(PAGE).toContain('["Not in the Claude app",s=>!s.hidden&&!s.pinned&&s.viaApp===false]');
		expect(PAGE).toContain('["Working",s=>!s.hidden&&!s.pinned&&s.viaApp!==false');
	});
});

describe("local only", () => {
	it("refuses a request whose Host is not localhost (DNS rebinding)", async () => {
		const app = createApp(() => []);
		const res = await app.request("/api/sessions", { headers: { host: "evil.example:4100" } });
		expect(res.status).toBe(403);
		expect((await app.request("/api/sessions", { headers: { host: "127.0.0.1:4100" } })).status).toBe(200);
	});

	it("drops sessions whose id is not a plain id", () => {
		expect(parseSession('x" onmouseover="alert(1)', [ask("hi")], now)).toBeUndefined();
		expect(parseSession("--dangerously-skip-permissions", [ask("hi")], now)).toBeUndefined();
		expect(parseSession("0b7f-ok_1", [ask("hi")], now)?.id).toBe("0b7f-ok_1");
	});
});

describe("typing box: fairies, drafts and hot reload", () => {
	it("keeps the fairies in their own strip above the text row, flying at a steady pace", async () => {
		const { PAGE } = await import("../src/page");
		expect(PAGE).toContain('<div class="sky"><div class="fairy">');
		expect(PAGE).toContain('</div></div><div class="atray" id="atray"></div><div class="row">');
		expect(PAGE).not.toMatch(/\.compose:focus-within \.fairy/);
		expect(PAGE).not.toMatch(/\.fairy[^{]*\{[^}]*animation-duration:4s/);
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
	});

	it("saves what you type per agent and restores it, and tells an open page when the build changes", async () => {
		const { PAGE } = await import("../src/page");
		for (const part of ["function saveDraft(", "function restoreDraft(", "rma-draft-", "location.reload()", "BUILD0"]) expect(PAGE).toContain(part);
		const a = await (await createApp(() => []).request("/api/sessions")).json();
		const b = await (await createApp(() => []).request("/api/sessions")).json();
		expect(a.build).toBeString();
		expect(a.build).toBe(b.build);
	});
});

describe("pins and open-in", () => {
	const J = { "content-type": "application/json" };
	const post = (app: ReturnType<typeof createApp>, path: string, body: object) =>
		app.request(path, { method: "POST", headers: J, body: JSON.stringify(body) });

	it("pins and unpins in the board, and unpinning hides a pin the Claude app has", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-pins-"));
		const { isPinned, readPins } = await import("../src/prefs");
		const app = createApp(() => []);
		expect(isPinned("s1", false)).toBe(false);
		expect((await post(app, "/api/pin", { id: "s1", pinned: true })).status).toBe(200);
		expect(isPinned("s1", false)).toBe(true);
		expect(isPinned("s2", true)).toBe(true); // pinned in the Claude app
		await post(app, "/api/pin", { id: "s2", pinned: false });
		expect(isPinned("s2", true)).toBe(false); // hidden here, the Claude app is untouched
		await post(app, "/api/pin", { id: "s1", pinned: false });
		expect(readPins()).toEqual({ pinned: [], unpinned: ["s2", "s1"] });
		for (const bad of [{ id: "../x", pinned: true }, { id: "s1" }, { id: "s1", pinned: "yes" }]) expect((await post(app, "/api/pin", bad)).status).toBe(400);
		expect((await app.request("/api/pin", { method: "POST", body: "id=s1" })).status).toBe(403);
	});

	it("opens a session's folder in the chosen app, and says so when it cannot", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "rma-open-"));
		const s = parseSession("a", [line({ type: "user", cwd: dir, message: { content: "hi" } })], now);
		const calls: string[][] = [];
		const app = createApp(() => (s ? [s] : []), undefined, { open: async (t, cwd) => { calls.push([t, cwd]); return t !== "vscode"; } });
		expect((await post(app, "/api/open", { id: "a", target: "finder" })).status).toBe(200);
		expect(calls).toEqual([["finder", dir]]);
		expect((await post(app, "/api/open", { id: "a", target: "vscode" })).status).toBe(400);
		expect((await post(app, "/api/open", { id: "nope", target: "finder" })).status).toBe(404);
	});

	it("builds the right command for each app, and refuses an unknown one", async () => {
		const { openIn } = await import("../src/index");
		const seen: string[][] = [];
		const fake = ((cmd: string, args: string[]) => {
			seen.push([cmd, ...args]);
			const child = new (require("node:events").EventEmitter)();
			setTimeout(() => child.emit("close", 0), 0);
			return child;
		}) as never;
		expect(await openIn("finder", "/repo", fake)).toBe(true);
		expect(await openIn("rm -rf", "/repo", fake)).toBe(false);
		expect(seen.length).toBe(1);
		expect(seen[0].at(-1)).toBe("/repo");
	});

	it("opens Linux terminals in turn, skipping any that is not installed", async () => {
		const { openIn } = await import("../src/index");
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const term = process.env.TERMINAL;
		Object.defineProperty(process, "platform", { value: "linux" });
		delete process.env.TERMINAL;
		try {
			const seen: string[] = [];
			const fake = ((cmd: string) => {
				seen.push(cmd);
				const child = new (require("node:events").EventEmitter)();
				setTimeout(() => child.emit(cmd === "gnome-terminal" ? "spawn" : "error", new Error("ENOENT")), 0);
				return child;
			}) as never;
			expect(await openIn("terminal", "/repo", fake)).toBe(true);
			expect(seen).toEqual(["x-terminal-emulator", "gnome-terminal"]);
		} finally {
			Object.defineProperty(process, "platform", platform);
			if (term === undefined) delete process.env.TERMINAL;
			else process.env.TERMINAL = term;
		}
	});
});

describe("right-click gauges panel and animated controls", () => {
	it("replaces the browser's menu on agents with a gauges panel, and keeps native menus in text fields", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
		for (const part of ['addEventListener("contextmenu"', "e.preventDefault()", "function gaugePanel(", "function dialHtml(", "function ledsHtml(", 'data-sw="pin"', 'data-tile="', ".cmenu.gp{", "function showPanel(", 'tg==="TEXTAREA"']) expect(PAGE).toContain(part);
	});

	it("uses no native dropdowns, checkboxes, number boxes or datalists anywhere", async () => {
		const { PAGE } = await import("../src/page");
		expect(PAGE).not.toMatch(/<select|type="number"|type="checkbox"|<datalist|<option/);
	});

	it("has an animated, hoverable style for every control it draws", async () => {
		const { PAGE } = await import("../src/page");
		for (const hover of [".ml:hover", ".led:hover", ".swr:hover", ".tl:hover", ".cb:hover", ".fc:hover", ".lbtn:hover", ".mdot:hover", ".gc:hover", ".sg:hover", ".rc:hover", ".btn:hover"]) expect(PAGE).toContain(hover);
		for (const motion of ["@keyframes gpop", "@keyframes dpop", "@keyframes sway", "@keyframes ledp", "@keyframes glowg", "@keyframes tflow"]) expect(PAGE).toContain(motion);
	});
});

describe("model and effort", () => {
	const J = { "content-type": "application/json" };
	const post = (app: ReturnType<typeof createApp>, path: string, body: object) =>
		app.request(path, { method: "POST", headers: J, body: JSON.stringify(body) });

	it("sets a model and an effort for an agent, and uses them when the board sends a message", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-tune-"));
		const { applyTune, readTune } = await import("../src/prefs");
		const fresh = () => [parseSession("t1", [ask("hi")], now)].filter((s) => s !== undefined);
		const app = createApp(() => applyTune(fresh()));
		expect((await post(app, "/api/tune", { id: "t1", model: "haiku" })).status).toBe(200);
		await post(app, "/api/tune", { id: "t1", effort: "low" });
		const s = (await (await app.request("/api/sessions")).json()).sessions[0];
		expect(s.tune).toEqual({ model: "haiku", effort: "low" });
		const { sendToSession } = await import("../src/index");
		let args: string[] = [];
		const fake = ((_: string, a: string[]) => {
			args = a;
			const child = new (require("node:events").EventEmitter)();
			child.stdin = { end: () => setTimeout(() => child.emit("close"), 0) };
			return child;
		}) as never;
		const live = applyTune(fresh())[0];
		await sendToSession(live, "go", fake);
		expect(args).toEqual(["-p", "--resume", "t1", "--permission-mode", "acceptEdits", "--model", "haiku", "--effort", "low"]);
		// jumping up and down the ladder is allowed here; "" clears
		await post(app, "/api/tune", { id: "t1", model: "opus" });
		expect(readTune().t1.model).toBe("opus");
		await post(app, "/api/tune", { id: "t1", model: "", effort: "" });
		expect(readTune()).toEqual({});
	});

	it("refuses unknown models, unknown levels, Codex agents and other sites", async () => {
		const cx = { id: "c1", agent: "codex", title: "x", cwd: "/", updatedAt: Date.now(), role: "Code" } as never;
		const s = parseSession("t2", [ask("hi")], now);
		const app = createApp(() => (s ? [s, cx] : [cx]));
		expect((await post(app, "/api/tune", { id: "t2", model: "gpt-9" })).status).toBe(400);
		expect((await post(app, "/api/tune", { id: "t2", effort: "ludicrous" })).status).toBe(400);
		expect((await post(app, "/api/tune", { id: "t2" })).status).toBe(400);
		expect((await post(app, "/api/tune", { id: "c1", model: "opus" })).status).toBe(400);
		expect((await post(app, "/api/tune", { id: "nope", model: "opus" })).status).toBe(404);
		expect((await app.request("/api/tune", { method: "POST", body: "id=t2" })).status).toBe(403);
	});

	it("starts a Claude session with the chosen effort", async () => {
		const { startNewSession } = await import("../src/index");
		let args: string[] = [];
		const fake = ((_: string, a: string[]) => {
			args = a;
			const child = new (require("node:events").EventEmitter)();
			child.stdin = { end: () => setTimeout(() => child.emit("close"), 0) };
			return child;
		}) as never;
		await startNewSession({ agent: "claude", cwd: "/tmp", text: "x", id: "i", model: "sonnet", effort: "high" }, fake);
		expect(args).toEqual(["-p", "--session-id", "i", "--permission-mode", "acceptEdits", "--model", "sonnet", "--effort", "high"]);
	});
});

describe("old sessions stay visible", () => {
	it("keeps a session of any age when asked to, and gives callers a copy of the cached one", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { readSessions } = await import("../src/sessions");
		const root = mkdtempSync(join(tmpdir(), "rma-old-"));
		mkdirSync(join(root, "proj"));
		const file = join(root, "proj", "old-1.jsonl");
		writeFileSync(file, `${JSON.stringify({ type: "user", cwd: "/repo", message: { content: "make the short" } })}\n`);
		const days = 3 * 86_400;
		utimesSync(file, Date.now() / 1000 - days, Date.now() / 1000 - days);
		expect(readSessions(root, 3_600_000, Date.now(), new Set())).toHaveLength(0);
		const kept = readSessions(root, 3_600_000, Date.now(), new Set(["old-1"]));
		expect(kept.map((s) => s.title)).toEqual(["make the short"]);
		kept[0].title = "changed by a caller";
		expect(readSessions(root, 3_600_000, Date.now(), new Set(["old-1"]))[0].title).toBe("make the short");
	});
});

describe("header", () => {
	it("has a 3D, animated, hoverable header: icon buttons, copy chips, shimmering title", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
		for (const part of ["function hb(", 'class:"mchips"', 'data-ctext="', ".hb span:hover", ".mc:hover", ".hd::after", ".proj span{", ".cnt i{", ".btn:active", "const IC="]) expect(PAGE).toContain(part);
	});
});

describe("file upload", () => {
	const J = { "content-type": "application/json" };
	const upload = (app: ReturnType<typeof createApp>, q: string, body: BodyInit, headers: Record<string, string> = { "x-run-my-agents": "1" }) =>
		app.request(`/api/upload?${q}`, { method: "POST", headers, body });

	it("saves an attached file under the session's own folder with a safe name, and refuses other sites", async () => {
		const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-up-"));
		const s = parseSession("u1", [ask("hi")], now);
		const app = createApp(() => (s ? [s] : []));
		const res = await upload(app, "id=u1&name=" + encodeURIComponent("../../etc/pass wd?.png"), new Uint8Array([1, 2, 3]));
		expect(res.status).toBe(200);
		const out = await res.json();
		expect(out.path.startsWith(join(process.env.RUN_MY_AGENTS_DIR, "uploads", "u1"))).toBe(true);
		expect(out.name).toBe("pass wd_.png");
		expect([...readFileSync(out.path)]).toEqual([1, 2, 3]);
		expect(existsSync(join(process.env.RUN_MY_AGENTS_DIR, "etc"))).toBe(false);
		expect((await upload(app, "id=u1&name=a", new Uint8Array([1]), {})).status).toBe(403);
		expect((await upload(app, "id=u1&name=a", new Uint8Array([1]), { "x-run-my-agents": "1", origin: "https://evil.example" })).status).toBe(403);
		expect((await upload(app, "id=nope&name=a", new Uint8Array([1]))).status).toBe(404);
		expect((await upload(app, "id=../x&name=a", new Uint8Array([1]))).status).toBe(400);
		expect((await upload(app, "id=u1&name=a", new Uint8Array([]))).status).toBe(400);
		expect((await upload(app, "id=u1&name=a", new Uint8Array([1]), { "x-run-my-agents": "1", "content-length": String(30 * 1024 * 1024) })).status).toBe(413);
	});

	it("sends only files this board saved for the session, and lets the agent read that folder", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-up2-"));
		const dir = join(process.env.RUN_MY_AGENTS_DIR, "uploads", "u2");
		mkdirSync(dir, { recursive: true });
		const ok = join(dir, "a-shot.png");
		writeFileSync(ok, "x");
		const outside = join(process.env.RUN_MY_AGENTS_DIR, "secret.txt");
		writeFileSync(outside, "x");
		const s = parseSession("u2", [ask("hi")], now);
		let got: { text: string; dirs: string[] } | undefined;
		const app = createApp(() => (s ? [s] : []), async (_s, text, _run, dirs) => { got = { text, dirs: dirs ?? [] }; });
		const res = await app.request("/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "u2", text: "look", files: [ok, outside, "/etc/hosts"] }) });
		expect(res.status).toBe(202);
		expect(got?.dirs).toEqual([dir]);
		expect(got?.text).toContain(`- ${ok}`);
		expect(got?.text).not.toContain("secret.txt");
		expect(got?.text).not.toContain("/etc/hosts");
		const { sendToSession } = await import("../src/index");
		let args: string[] = [];
		const fake = ((_: string, a: string[]) => {
			args = a;
			const child = new (require("node:events").EventEmitter)();
			child.stdin = { end: () => setTimeout(() => child.emit("close"), 0) };
			return child;
		}) as never;
		if (s) await sendToSession(s, "go", fake, [dir]);
		expect(args.slice(-2)).toEqual(["--add-dir", dir]);
	});

	it("has the attach button, tray and drop zone, and the right-click panel fits the window", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
		for (const part of ['data-act="attach"', "function attachFiles(", 'id="drop"', "x-run-my-agents", ".clip:hover", ".att:hover", "--fit"]) expect(PAGE).toContain(part);
	});
});

describe("close and delete", () => {
	const J = { "content-type": "application/json" };
	const post = (app: ReturnType<typeof createApp>, path: string, body: object) =>
		app.request(path, { method: "POST", headers: J, body: JSON.stringify(body) });
	const setup = async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const root = mkdtempSync(join(tmpdir(), "rma-del-"));
		process.env.CLAUDE_PROJECTS_DIR = join(root, "projects");
		process.env.RUN_MY_AGENTS_DIR = join(root, "data");
		mkdirSync(join(root, "projects", "p"), { recursive: true });
		const file = join(root, "projects", "p", "d1.jsonl");
		writeFileSync(file, "x");
		return { root, file };
	};
	const old = (extra: object) => {
		const s = parseSession("d1", [ask("hi")], Date.now() - 600_000);
		return s ? [{ ...s, ...extra }] : [];
	};

	it("closes a session without deleting anything, and reopens it", async () => {
		const { existsSync } = await import("node:fs");
		const { file } = await setup();
		const { applyHidden } = await import("../src/prefs");
		const app = createApp(() => applyHidden(old({ file, viaApp: false })));
		expect((await post(app, "/api/hide", { id: "d1", hidden: true })).status).toBe(200);
		expect((await (await app.request("/api/sessions")).json()).sessions[0].hidden).toBe(true);
		expect(existsSync(file)).toBe(true);
		await post(app, "/api/hide", { id: "d1", hidden: false });
		expect((await (await app.request("/api/sessions")).json()).sessions[0].hidden).toBeUndefined();
		expect((await post(app, "/api/hide", { id: "../x", hidden: true })).status).toBe(400);
		expect((await post(app, "/api/hide", { id: "d1" })).status).toBe(400);
	});

	it("deletes a board or terminal session's transcript and everything the board kept about it", async () => {
		const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { file, root } = await setup();
		mkdirSync(join(root, "data", "uploads", "d1"), { recursive: true });
		writeFileSync(join(root, "data", "uploads", "d1", "a.png"), "x");
		const { setRole, setPin, readPins } = await import("../src/prefs");
		setRole("d1", "Video");
		setPin("d1", true);
		const app = createApp(() => old({ file, viaApp: false }));
		expect(JSON.stringify(await (await app.request("/api/sessions")).json())).not.toContain(file);
		const res = await post(app, "/api/delete", { id: "d1" });
		expect(res.status).toBe(200);
		expect(existsSync(file)).toBe(false);
		expect(existsSync(join(root, "data", "uploads", "d1"))).toBe(false);
		expect(readPins().pinned).toEqual([]);
	});

	it("deletes a Grok session's whole folder, not only its chat_history.jsonl", async () => {
		const { existsSync, mkdirSync, writeFileSync, mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const root = mkdtempSync(join(tmpdir(), "rma-del-grok-"));
		process.env.GROK_SESSIONS_DIR = join(root, "sessions");
		process.env.RUN_MY_AGENTS_DIR = join(root, "data");
		const dir = join(root, "sessions", "%2Frepo", "01a0d5a0-5850-7fe3-973d-58bdd00f3236");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "chat_history.jsonl");
		writeFileSync(file, "x");
		writeFileSync(join(dir, "summary.json"), "{}");
		const session = { id: "01a0d5a0-5850-7fe3-973d-58bdd00f3236", agent: "grok", cwd: "/repo", branch: "", title: "t", said: "", doing: "", edits: [], updatedAt: Date.now() - 600_000, role: "Code", pinned: false, feed: [], file, viaApp: false };
		const app = createApp(() => [session as never]);
		const res = await post(app, "/api/delete", { id: session.id });
		expect(res.status).toBe(200);
		expect(existsSync(dir)).toBe(false);
	});

	it("refuses to delete a Claude app session, a working one, a file outside the agent's folder, or from another site", async () => {
		const { existsSync } = await import("node:fs");
		const { file, root } = await setup();
		expect((await post(createApp(() => old({ file, viaApp: true })), "/api/delete", { id: "d1" })).status).toBe(400);
		const busy = parseSession("d1", [ask("hi")], Date.now());
		expect((await post(createApp(() => (busy ? [{ ...busy, file, viaApp: false }] : [])), "/api/delete", { id: "d1" })).status).toBe(409);
		expect((await post(createApp(() => old({ file: "/etc/hosts", viaApp: false })), "/api/delete", { id: "d1" })).status).toBe(400);
		expect((await post(createApp(() => old({ file: `${root}/projects/../outside.jsonl`, viaApp: false })), "/api/delete", { id: "d1" })).status).toBe(400);
		expect((await post(createApp(() => []), "/api/delete", { id: "nope" })).status).toBe(404);
		expect((await createApp(() => old({ file, viaApp: false })).request("/api/delete", { method: "POST", body: "id=d1" })).status).toBe(403);
		expect(existsSync(file)).toBe(true);
	});
});

describe("formatted replies, close and delete in the panel, smaller gauges", () => {
	it("shows replies as the Claude app does, using the tested renderer, and never cuts them off at three lines", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
		// the embedded renderer is the real one
		const run = new Function(`${js.slice(0, js.indexOf("const SH="))}; return renderMarkdown("**bold** and \`code\`");`);
		expect(run()).toBe("<p><strong>bold</strong> and <code>code</code></p>");
		for (const part of ['class="rich', ".rich pre", ".rich table", ".cpb", 'data-copycode', ".msg .rich.long"]) expect(PAGE).toContain(part);
		expect(PAGE).not.toContain('(m.text?"<p>"+esc(m.text)+"</p>":"")');
	});

	it("collapses a long reply to its first and last 2 lines, with a show-more bar between them", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		const src = js.slice(js.indexOf("function richHtml("), js.indexOf("function toolRuns("));
		const richHtml = new Function("renderMarkdown", `${src}; return richHtml;`)(
			(t: string) => `<p>${t}</p>`,
		) as (m: { text: string }) => string;
		const short = richHtml({ text: "one\ntwo\nthree\nfour" });
		expect(short).toBe('<div class="rich"><p>one\ntwo\nthree\nfour</p></div>');
		expect(short).not.toContain("rich-prev");
		const nine = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join("\n");
		const long = richHtml({ text: nine });
		expect(long).toContain('<div class="rich-prev">');
		expect(long).toContain("<p>line 1\nline 2</p>");
		expect(long).toContain("<p>line 8\nline 9</p>");
		expect(long).toContain("rp-more");
		expect(long).toContain("5 more line");
		expect(long).toContain('<div class="rich full">');
	});

	it("keeps the collapse CSS in place for the fold (chevron) and open states", async () => {
		const { PAGE } = await import("../src/page");
		for (const part of [
			".rich-prev",
			".rp-more",
			".msg .rich.full{display:none}",
			".msg.open .rich.full{display:block",
			".msg.open .rich-prev{display:none}",
			".msg.col .rich-prev .rp-more,.msg.col .rich-prev .rich:last-child{display:none}",
		])
			expect(PAGE).toContain(part);
	});

	it("has Close and Delete in the right-click panel, a Closed group, and a smaller panel", async () => {
		const { PAGE } = await import("../src/page");
		for (const part of ['data-close="1"', 'data-del="1"', 'class="dz2"', '["Closed",s=>s.hidden]', "fold={Closed:true}", ".tl2.red.arm", "width:min(288px,94vw)"]) expect(PAGE).toContain(part);
	});
});

describe("chat layout, bigger text and avatar motion", () => {
	it("puts your messages on the left and the agent's on the right, with small author names", async () => {
		const { PAGE } = await import("../src/page");
		for (const part of ['"from-me":"from-ag"', 'class:"bub"', 'class:"who"', ".msg.from-me{justify-content:flex-end}", ".msg.from-ag{justify-content:flex-start}", ".who{display:flex", ".rich{font-size:14px}", "font:14px/20px var(--body)"]) expect(PAGE).toContain(part);
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
	});

	it("wiggles an agent that has spent many tokens and shakes it faster the more it spends, with or without a limit", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		const src = js.slice(js.indexOf("function motion("), js.indexOf("const hm="));
		const motion = new Function("L", `${src}; return motion;`) as (L: object) => (s: object) => { low: boolean; wig: boolean; style: string };
		const at = (used: number, limit = 0) => motion({ sessionTokens: limit })({ id: "abc", updatedAt: Date.now(), tokens: { used, cached: 0 } });
		expect(at(100_000)).toMatchObject({ low: false, wig: false });
		expect(at(800_000)).toMatchObject({ low: false, wig: true });
		expect(at(1_500_000)).toMatchObject({ low: true, wig: false });
		const shake = (r: { style: string }) => Number(/--shake:([\d.]+)s/.exec(r.style)?.[1]);
		expect(shake(at(1_500_000))).toBeGreaterThan(shake(at(2_400_000)));
		expect(shake(at(40_000_000))).toBe(0.4);
		// with a limit set, the same tokens count against that limit instead
		expect(at(800_000, 1_000_000)).toMatchObject({ low: true });
		expect(at(800_000, 10_000_000)).toMatchObject({ low: false, wig: false });
	});

	it("does not start a second copy of a session the Claude app is working in, or one the board is still running", async () => {
		const J = { "content-type": "application/json" };
		const post = (app: ReturnType<typeof createApp>, path: string, body: object) => app.request(path, { method: "POST", headers: J, body: JSON.stringify(body) });
		const fresh = parseSession("x1", [ask("hi")], Date.now() - 2_000);
		const stale = parseSession("x2", [ask("hi")], Date.now() - 600_000);
		const app = createApp(() => [fresh && { ...fresh, viaApp: true }, stale && { ...stale, viaApp: true }, fresh && { ...fresh, id: "x3", viaApp: false }].filter((x) => x !== undefined) as never, async () => {});
		expect(await (await post(app, "/api/send", { id: "x1", text: "go" })).json()).toMatchObject({ queued: true });
		expect(await (await post(app, "/api/send", { id: "x1", text: "go", now: true })).json()).toMatchObject({ error: expect.stringContaining("Claude app") });
		expect((await post(app, "/api/send", { id: "x2", text: "go" })).status).toBe(202);
		expect((await post(app, "/api/send", { id: "x3", text: "go" })).status).toBe(202);
		// a session the board has just started is busy until its first turn ends
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const dir = mkdtempSync(`${tmpdir()}/rma-busy-`);
		let finish = () => {};
		let started = "";
		const list: object[] = [];
		const app2 = createApp(() => list as never, async () => {}, {
			which: () => ({ claude: true, codex: false, grok: false }),
			start: async (n) => {
				started = n.id ?? "";
				await new Promise<void>((r) => {
					finish = r;
				});
			},
		});
		expect((await post(app2, "/api/new", { agent: "claude", cwd: dir, text: "go" })).status).toBe(202);
		const s = parseSession(started, [ask("go")], Date.now() - 600_000);
		if (s) list.push(s);
		expect(await (await post(app2, "/api/send", { id: started, text: "more" })).json()).toMatchObject({ queued: true });
		finish();
		await Bun.sleep(5);
		expect(await (await post(app2, "/api/send", { id: started, text: "more" })).json()).toMatchObject({ sent: true });
	});
});

describe("class names", () => {
	it("does not use the model tag's class (md) for the formatted reply text", async () => {
		const { PAGE } = await import("../src/page");
		expect(PAGE).toContain("function mtag(");
		expect(PAGE).toContain('<span class="md" data-mpick=');
		expect(PAGE).not.toMatch(/\.md (p|code|pre|table|a|ul|li)\b/);
		expect(PAGE).not.toContain('class="md\'+(m.text.length');
	});
});

describe("Geist font, order and drag and drop", () => {
	it("serves Geist and Geist Mono from the app, cached for a year, and nothing else under /fonts", async () => {
		const app = createApp(() => []);
		for (const f of ["geist.woff2", "geist-mono.woff2"]) {
			const res = await app.request(`/fonts/${f}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("font/woff2");
			expect(res.headers.get("cache-control")).toContain("immutable");
			const bytes = new Uint8Array(await res.arrayBuffer());
			expect([...bytes.slice(0, 4)]).toEqual([0x77, 0x4f, 0x46, 0x32]); // "wOF2"
		}
		expect((await app.request("/fonts/../index.ts")).status).toBe(404);
		expect((await app.request("/fonts/evil.woff2")).status).toBe(404);
		const { PAGE } = await import("../src/page");
		expect(PAGE).toContain('font-family:"Geist"');
		expect(PAGE).toContain('--body:"Geist"');
		expect(PAGE).toContain('--mono:"Geist Mono"');
		expect(PAGE).not.toContain("Satoshi");
	});

	it("saves the order you dragged your agents into, and hands it back with the sessions", async () => {
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		process.env.RUN_MY_AGENTS_DIR = mkdtempSync(join(tmpdir(), "rma-order-"));
		const app = createApp(() => []);
		const post = (body: unknown) => app.request("/api/order", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		expect((await post({ ids: ["b", "a", "b", "../x", "c"] })).status).toBe(200);
		expect((await (await app.request("/api/sessions")).json()).order).toEqual(["b", "a", "c"]);
		expect((await post({ ids: "nope" })).status).toBe(400);
		expect((await app.request("/api/order", { method: "POST", body: "ids=a" })).status).toBe(403);
	});

	it("can drag an agent: rows are draggable, drops pin, unpin, close and reopen, and every move slides", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
		for (const part of ['draggable="true"', 'addEventListener("dragstart"', 'addEventListener("drop"', "function dropAgent(", "function flip(", "function ordSort(", ".it.drop-before::before", ".it.dragging", ".it.moved", "phold"]) expect(PAGE).toContain(part);
		expect(PAGE).toContain("if(dragId||");
	});
});

describe("class names, again", () => {
	it("keeps the chat row classes apart from the small CLAUDE and model tags (ag, md)", async () => {
		const { PAGE } = await import("../src/page");
		expect(PAGE).not.toMatch(/\.msg\.(me|ag)\b/);
		expect(PAGE).toContain('<span class="ag \'+s.agent');
	});
});

describe("pull requests on the branch chip", () => {
	it("reads the pull requests and branches the Claude app keeps for a session", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { readDesktopMeta } = await import("../src/desktop");
		const root = mkdtempSync(join(tmpdir(), "rma-prs-"));
		const dir = join(root, "claude-code-sessions", "a", "b");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "local_p.json"),
			JSON.stringify({
				sessionId: "local_p",
				cliSessionId: "cli-p",
				title: "x",
				prs: [
					{ prNumber: 3047, repo: "flisk-sh/flisk", url: "https://github.com/flisk-sh/flisk/pull/3047", branch: "feat/x", state: "merged" },
					{ prNumber: 9, url: "javascript:alert(1)" },
					{ prNumber: "x", url: "https://github.com/a/b/pull/1" },
				],
				writtenBranches: ["/repo\u0000fix/a", "/repo\u0000fix/a", "/repo\u0000main"],
			}),
		);
		const m = readDesktopMeta(root).get("cli-p");
		expect(m?.prs).toEqual([{ number: 3047, title: "", state: "MERGED", url: "https://github.com/flisk-sh/flisk/pull/3047", repo: "flisk-sh/flisk", branch: "feat/x", draft: false }]);
		expect(m?.branches).toEqual(["fix/a", "main"]);
	});

	it("merges the app's pull requests with GitHub's for the branch, newest first, without duplicates", async () => {
		const s = parseSession("pr1", [line({ type: "user", cwd: "/repo", gitBranch: "feat/x", message: { content: "hi" } })], now);
		const withPrs = s && { ...s, prs: [{ number: 5, title: "", state: "OPEN", url: "https://github.com/o/r/pull/5", repo: "o/r", branch: "feat/x", draft: false }] };
		const gh = async () => [
			{ number: 5, title: "Add the thing", state: "MERGED", url: "https://github.com/o/r/pull/5", repo: "o/r", branch: "feat/x", draft: false },
			{ number: 7, title: "Follow-up", state: "OPEN", url: "https://github.com/o/r/pull/7", repo: "o/r", branch: "feat/x", draft: true },
		];
		const app = createApp(() => (withPrs ? [withPrs] : []), undefined, { prs: gh });
		const out = await (await app.request("/api/prs?id=pr1")).json();
		expect(out.branch).toBe("feat/x");
		expect(out.prs.map((p: { number: number }) => p.number)).toEqual([7, 5]);
		expect(out.prs[1]).toMatchObject({ title: "Add the thing", state: "MERGED" });
		expect((await app.request("/api/prs?id=nope")).status).toBe(404);
		// without gh, the app's list still shows
		const quiet = createApp(() => (withPrs ? [withPrs] : []), undefined, { prs: async () => [] });
		expect((await (await quiet.request("/api/prs?id=pr1")).json()).prs).toHaveLength(1);
	});

	it("only asks gh about a real feature branch, and builds the repo from the URL", async () => {
		const { ghPrs } = await import("../src/index");
		const calls: string[][] = [];
		const fake = ((_: string, a: string[]) => {
			calls.push(a);
			const child = new (require("node:events").EventEmitter)();
			child.stdout = new (require("node:events").EventEmitter)();
			child.kill = () => {};
			setTimeout(() => {
				child.stdout.emit("data", JSON.stringify([{ number: 3, title: "T", state: "open", url: "https://github.com/flisk-sh/x/pull/3", isDraft: true }]));
				child.emit("close", 0);
			}, 0);
			return child;
		}) as never;
		const base = { id: "g", cwd: "/repo", agent: "claude" } as never;
		for (const branch of ["main", "master", "", "-rf", "a b", "../x"]) expect(await ghPrs({ ...(base as object), branch } as never, fake)).toEqual([]);
		expect(calls).toHaveLength(0);
		const prs = await ghPrs({ ...(base as object), branch: "fix/ok-1" } as never, fake);
		expect(prs).toEqual([{ number: 3, title: "T", state: "OPEN", url: "https://github.com/flisk-sh/x/pull/3", repo: "flisk-sh/x", branch: "fix/ok-1", draft: true, checks: "", review: "", merge: "" }]);
		expect(calls[0]).toContain("fix/ok-1");
	});
});

describe("model tag switcher, PR hover, chat spacing", () => {
	it("makes the model tag clickable and shows the model the next board message will use", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
		const src = js.slice(js.indexOf("const esc="), js.indexOf("const ago=")) + js.slice(js.indexOf("const TIER="), js.indexOf("function motion("));
		const mtag = new Function(`${src}; return mtag;`)() as (s: object) => string;
		const plain = mtag({ id: "a", model: "claude-opus-5-5" });
		expect(plain).toContain('data-mpick="a"');
		expect(plain).toContain("OPUS");
		expect(plain).not.toContain("md nx");
		const pending = mtag({ id: "a", model: "claude-opus-5-5", tune: { model: "haiku" } });
		expect(pending).toContain("OPUS");
		expect(pending).toContain("md nx");
		expect(pending).toContain("HAIKU");
		expect(mtag({ id: "a", model: "claude-haiku-5-5", tune: { model: "haiku" } })).not.toContain("md nx");
		expect(PAGE).toContain("function showModelPick(");
		expect(PAGE).toContain("e.stopImmediatePropagation()");
	});

	it("lists the links said in a chat and previews each one", async () => {
		const { chatLinks, linkPreview } = await import("../src/index");
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const dir = mkdtempSync(join(tmpdir(), "links-"));
		const file = join(dir, "t.jsonl");
		const line = (o: object) => JSON.stringify(o);
		writeFileSync(
			file,
			[
				line({ type: "user", message: { role: "user", content: "see https://github.com/flisk-sh/run-my-agents." } }),
				line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Opened (https://flisk.sh/docs) and https://github.com/flisk-sh/run-my-agents" }, { type: "tool_use", input: { url: "https://tool.example" } }] } }),
				line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "https://output.example" }] } }),
			].join("\n"),
		);
		const links = chatLinks(file);
		expect(links.map((l) => l.url)).toEqual(["https://github.com/flisk-sh/run-my-agents", "https://flisk.sh/docs"]);
		expect(links[0]).toMatchObject({ host: "github.com", who: "agent" });
		expect(chatLinks(join(dir, "missing.jsonl"))).toEqual([]);
		const html = '<html><head><title>Fallback</title><meta property="og:title" content="Run my agents &amp; more"><meta name="description" content="A board"><meta property="og:image" content="/card.png"></head></html>';
		const fake = (async () => new Response(html, { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
		expect(await linkPreview("https://preview.example/a", fake)).toMatchObject({ title: "Run my agents & more", description: "A board", image: "https://preview.example/card.png", site: "preview.example" });
		const broken = (async () => {
			throw new Error("down");
		}) as unknown as typeof fetch;
		expect((await linkPreview("https://down.example/", broken)).error).toBeTruthy();
		const app = createApp(() => [{ id: "ln1", cwd: "/repo", agent: "claude", file } as never], undefined, { fetch: fake });
		expect((await (await app.request("/api/links?id=ln1")).json()).links).toHaveLength(2);
		expect((await app.request("/api/links?id=nope")).status).toBe(404);
		const { linkCount } = await import("../src/index");
		expect(linkCount(file)).toBe(2);
		expect(linkCount(join(dir, "missing.jsonl"))).toBe(0);
		expect((await app.request("/api/preview?url=file:///etc/passwd")).status).toBe(400);
		const { PAGE } = await import("../src/page");
		for (const part of ['"data-links":s.id', "function showLinks(", "function showPv(", 'fetch("api/links?id="', 'fetch("api/preview?url="', ".lnpv{", 'class:"prc lnc","data-links":s.id']) expect(PAGE).toContain(part);
	});

	it("lists pull requests when you hover the branch", async () => {
		const { PAGE } = await import("../src/page");
		for (const part of ["data-prs=", "function showPrs(", 'fetch("api/prs?id="', ".prpop{", ".prr:hover", ".prsk{", 'class:"prn"']) expect(PAGE).toContain(part);
	});

	it("shows more chat text: tighter spacing, wider bubbles, smaller tool labels that group repeats, no early cut-off", async () => {
		const { PAGE } = await import("../src/page");
		for (const part of [".bub{max-width:80%", ".rich p{margin:0 0 4px}", ".tool{font-size:9px", "function toolRuns(", "m.text.length>9000"]) expect(PAGE).toContain(part);
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		const runs = new Function("esc", `${js.slice(js.indexOf("function toolRuns("), js.indexOf("function pinSession("))}; return toolRuns;`)((x: string) => x) as (t: string[]) => string;
		const html = runs(["Bash", "Bash", "Bash", "Edit page.ts", "Bash"]);
		expect(html.match(/class="tool"/g)).toHaveLength(3);
		expect(html).toContain("\u00d73");
	});
});

describe("choices an agent offers", () => {
	const wrap = (extra: object = {}) =>
		line({ type: "assistant", timestamp: "2026-11-01T12:00:00Z", message: { content: [{ type: "text", text: "Done." }, { type: "tool_use", id: "w1", name: "mcp__ccd_turn__wrap_up", input: { recap: "r", ask: "Release it?", actions: [{ label: "Yes, release" }, { label: "Not now" }], ...extra } }] } });
	const result = (id: string) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

	it("reads the buttons from the next-step box, and keeps them after the closing message", () => {
		const closing = line({ type: "assistant", message: { content: [{ type: "text", text: "Here is the summary." }] } });
		const s = parseSession("o1", [ask("go"), wrap(), result("w1"), closing], now);
		expect(s?.awaiting).toBe(true);
		const last = s?.feed.at(-1);
		expect(last?.text).toBe("Done.\n\nHere is the summary.");
		expect(last?.options).toEqual({ recap: "r", ask: "Release it?", labels: ["Yes, release", "Not now"] });
	});

	it("reads an AskUserQuestion, and drops the buttons once it is answered", () => {
		const q = line({ type: "assistant", message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which name?", options: [{ label: "Dibs", description: "x" }, { label: "Lane" }] }] } }] } });
		const open = parseSession("o2", [ask("go"), q], now);
		expect(open?.feed.at(-1)?.options).toEqual({ ask: "Which name?", labels: ["Dibs", "Lane"] });
		const answered = parseSession("o2", [ask("go"), q, result("q1")], now);
		expect(answered?.awaiting).toBe(false);
		expect(answered?.feed.at(-1)?.options).toBeUndefined();
	});

	it("drops them when you type an answer, or the agent carries on working", () => {
		const typed = parseSession("o3", [ask("go"), wrap(), result("w1"), line({ type: "user", message: { content: "Yes, release" } })], now);
		expect(typed?.awaiting).toBe(false);
		expect(typed?.feed.some((f) => f.options)).toBe(false);
		const worked = line({ type: "assistant", message: { content: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }] } });
		expect(parseSession("o4", [ask("go"), wrap(), result("w1"), worked], now)?.awaiting).toBe(false);
	});

	it("lets you answer a waiting session at once, but still not interrupt one that is busy", async () => {
		const J = { "content-type": "application/json" };
		const waiting = parseSession("w1", [ask("go"), wrap(), result("w1")], Date.now() - 2_000);
		const busy = parseSession("w2", [ask("go")], Date.now() - 2_000);
		const app = createApp(() => [waiting && { ...waiting, viaApp: true }, busy && { ...busy, viaApp: true }].filter((x) => x !== undefined) as never, async () => {});
		const send = (id: string) => app.request("/api/send", { method: "POST", headers: J, body: JSON.stringify({ id, text: "Yes, release" }) });
		expect((await send("w1")).status).toBe(202);
		expect(await (await send("w2")).json()).toMatchObject({ queued: true });
	});

	it("shows the buttons in the page, answers with a click or Cmd+Enter, scrolls after 5 seconds without stealing your place, and drags the window", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
		for (const part of ["function optsHtml(", "function answer(", 'data-opt="', ".obtn.first", "function armScroll(", "feedHover", "setTimeout(function tick()", 'id="newpill"', ".newpill.on", "messageHandlers.drag", "separate copy"]) expect(PAGE).toContain(part);
	});
});

describe("a whole turn's text", () => {
	it("keeps every text block of an agent turn, not only the last one", () => {
		const a = line({ type: "assistant", message: { content: [{ type: "text", text: "First I looked." }, { type: "tool_use", id: "x", name: "Bash", input: {} }] } });
		const b = line({ type: "assistant", message: { content: [{ type: "text", text: "Then I fixed it." }] } });
		const s = parseSession("t9", [ask("go"), a, line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "" }] } }), b], now);
		expect(s?.feed.at(-1)?.text).toBe("First I looked.\n\nThen I fixed it.");
	});
});

describe("tool chips", () => {
	// The page script is one string; lift toolRuns out of it and run it with a stub for OPEN and esc.
	const load = async (open: string[]) => {
		const html = await (await createApp(() => []).request("/")).text();
		const src = html.slice(html.indexOf("function toolRuns("));
		const fn = src.slice(0, src.indexOf("\nfunction pinSession"));
		const esc = (x: string) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
		return new Function("esc", "OPEN", `${fn}; return toolRuns;`)(esc, new Set(open)) as (
			ts: string[],
			sid: string,
			fi: number,
			calls?: { label: string; what?: string; detail: string }[],
		) => string;
	};
	const calls = [{ label: "Bash", what: "run", detail: "ls <dir>" }];

	it("a chip with kept calls toggles inline instead of opening a popup", async () => {
		const html = (await load([]))(["Bash"], "s1", 2, calls);
		expect(html).toContain('data-act="toolx"');
		expect(html).toContain('data-tk="s1:2:0"');
		expect(html).not.toContain("data-pop");
		expect(html).not.toContain("clist");
	});

	it("an open chip lists the commands, escaped", async () => {
		const html = (await load(["s1:2:0"]))(["Bash"], "s1", 2, calls);
		expect(html).toContain('class="tool on"');
		expect(html).toContain("<code>ls &lt;dir></code>");
	});

	it("a chip with no kept calls is inert", async () => {
		const html = (await load(["s1:2:0"]))(["Bash"], "s1", 2, []);
		expect(html).not.toContain("data-act");
		expect(html).not.toContain("clist");
	});
});

describe("page wiring", () => {
	const page = async () => await (await createApp(() => []).request("/")).text();
	const set = (h: string, re: RegExp) => new Set([...h.matchAll(re)].map((m) => m[1]));

	it("is never served from the browser cache", async () => {
		const r = await createApp(() => []).request("/");
		// The script is inline, so a cached document runs the old board against the new API.
		expect(r.headers.get("cache-control")).toBe("no-store");
	});

	// #193 removed the "calls" popup but left the chips emitting data-pop="calls", so clicking a
	// tool chip did nothing until #196. Every attribute the markup emits must have a branch.
	it("every data-act the markup emits has a branch in the click handler", async () => {
		const h = await page();
		const emitted = set(h, /data-act="([a-zA-Z]+)"/g);
		const handled = set(h, /k==="([a-zA-Z]+)"/g);
		expect(emitted.size).toBeGreaterThan(5);
		expect([...emitted].filter((k) => !handled.has(k))).toEqual([]);
	});

	it("every data-pop the markup emits has a branch in popHtml", async () => {
		const h = await page();
		const emitted = set(h, /data-pop="([a-zA-Z]+)"/g);
		const handled = set(h, /kind==="([a-zA-Z]+)"/g);
		expect(emitted.size).toBeGreaterThan(3);
		expect([...emitted].filter((k) => !handled.has(k))).toEqual([]);
	});
});
