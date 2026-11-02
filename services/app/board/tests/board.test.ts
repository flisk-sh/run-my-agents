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
});

describe("page", () => {
	it("ships a script that parses", async () => {
		const { PAGE } = await import("../src/page");
		const js = PAGE.split("<script>")[1].split("</script>")[0];
		expect(() => new Function(js)).not.toThrow();
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
		expect(meta.get("cli-a")).toEqual({ title: "Flisk 5-second YouTube Short", pinned: true, archived: false, effort: "", at: 0, prs: [], branches: [] });
		expect(meta.get("cli-b")).toEqual({ title: "Ghostfolio", pinned: false, archived: true, effort: "", at: 0, prs: [], branches: [] });
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
		const app = createApp(() => [], undefined, { which: () => ({ claude: true, codex: true }) });
		expect(await (await app.request("/api/detect?text=" + encodeURIComponent("cut the demo video"))).json()).toEqual({ role: "Video", agent: null });
		expect((await (await app.request("/api/detect?text=" + encodeURIComponent("ask codex to fix sitemap"))).json()).agent).toBe("codex");
		const noCodex = createApp(() => [], undefined, { which: () => ({ claude: true, codex: false }) });
		expect((await (await noCodex.request("/api/detect?text=use+codex")).json()).agent).toBeNull();
	});

	it("offers installed agents, recent folders and every type with its face", async () => {
		const s = parseSession("a", [ask("hi"), edit("/repo/x.ts")], now);
		const app = createApp(() => (s ? [s] : []), undefined, { which: () => ({ claude: true, codex: false }) });
		const o = await (await app.request("/api/options")).json();
		expect(o.defaultAgent).toBe("claude");
		expect(o.agents).toEqual({ claude: true, codex: false });
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
		const app = createApp(() => [], undefined, { which: () => ({ claude: true, codex: true }), start: async (n) => { seen = n; } });
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
		const none = createApp(() => [], undefined, { which: () => ({ claude: false, codex: false }) });
		expect((await post(none, "/api/new", { agent: "claude", cwd: dir, text: "x" })).status).toBe(400);
		expect((await app.request("/api/new", { method: "POST", body: "text=x" })).status).toBe(403);
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
		for (const part of ["function hb(", 'class="mchips"', 'data-ctext="', ".hb span:hover", ".mc:hover", ".hd::after", ".proj span{", ".cnt i{", ".btn:active", "const IC="]) expect(PAGE).toContain(part);
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

	it("has Close and Delete in the right-click panel, a Closed group, and a smaller panel", async () => {
		const { PAGE } = await import("../src/page");
		for (const part of ['data-close="1"', 'data-del="1"', 'class="dz2"', '["Closed",s=>s.hidden]', "fold={Closed:true}", ".tl2.red.arm", "width:min(288px,94vw)"]) expect(PAGE).toContain(part);
	});
});

describe("chat layout, bigger text and avatar motion", () => {
	it("puts your messages on the left and the agent's on the right, with small author names", async () => {
		const { PAGE } = await import("../src/page");
		for (const part of ['"from-me":"from-ag"', 'class="bub"', 'class="who"', ".msg.from-me{justify-content:flex-end}", ".msg.from-ag{justify-content:flex-start}", ".who{display:flex", ".rich{font-size:14px}", "font:14px/20px var(--body)"]) expect(PAGE).toContain(part);
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
			which: () => ({ claude: true, codex: false }),
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

	it("lists pull requests when you hover the branch", async () => {
		const { PAGE } = await import("../src/page");
		for (const part of ["data-prs=", "function showPrs(", 'fetch("api/prs?id="', ".prpop{", ".prr:hover", ".prsk{", 'class="prn"']) expect(PAGE).toContain(part);
	});

	it("shows more chat text: tighter spacing, wider bubbles, smaller tool labels that group repeats, no early cut-off", async () => {
		const { PAGE } = await import("../src/page");
		for (const part of [".bub{max-width:94%", ".rich p{margin:0 0 4px}", ".tool{font-size:9px", "function toolRuns(", "m.text.length>9000"]) expect(PAGE).toContain(part);
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
