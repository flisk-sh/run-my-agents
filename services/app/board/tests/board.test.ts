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
		const s = parseSession("abc", [ask("fix the login bug"), "not json", edit("/repo/src/api.ts")], now);
		expect(s?.title).toBe("fix the login bug");
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
		expect((await post({ id: "a", text: "again" })).status).toBe(409);
		finish();
		await Bun.sleep(1);
		expect((await post({ id: "a", text: "again" })).status).toBe(202);
		expect(sent).toEqual(["add tests", "again"]);
		expect((await post({ id: "nope", text: "x" })).status).toBe(404);
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

describe("faces", () => {
	it("gives every session of a role the same face and color, Code blue and Design purple", async () => {
		const { faceOf } = await import("../src/index");
		const code = [parseSession("a", [ask("fix the bug")], now), parseSession("b", [ask("add a test")], now)].filter((s) => s !== undefined);
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
		expect(meta.get("cli-a")).toEqual({ title: "Flisk 5-second YouTube Short", pinned: true, archived: false });
		expect(meta.get("cli-b")).toEqual({ title: "Ghostfolio", pinned: false, archived: true });
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
		const fresh = () => [parseSession("s1", [ask("fix the bug")], now)].filter((s) => s !== undefined);
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
		for (const part of ['data-act="newopen"', 'id="dlg"', 'data-act="roles"', "function startNew(", "function drawNew("]) expect(PAGE).toContain(part);
	});
});

describe("sessions the Claude app does not list", () => {
	it("goes in its own group, so the others match the app", async () => {
		const { PAGE } = await import("../src/page");
		expect(PAGE).toContain('["Not in the Claude app",s=>!s.pinned&&s.viaApp===false]');
		expect(PAGE).toContain('["Working",s=>!s.pinned&&s.viaApp!==false');
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
