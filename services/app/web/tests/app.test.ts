import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { RateLimiter, TtlCache } from "../src/guard";

const app = createApp({ publicUrl: "https://tool.test/" });
const rpc = (a: ReturnType<typeof createApp>, body: unknown) =>
	a.request("/mcp", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

describe("pages", () => {
	it("serves the home page with a policy that allows one script, by hash, and nothing inline", async () => {
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const csp = res.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp.match(/script-src ([^;]*)/)?.[1]).toMatch(
			/^'sha256-[A-Za-z0-9+/=]+' https:\/\/flisk\.si$/,
		);
		// every other page keeps the strict default: only the Flisk bar script may run
		const about = await app.request("/about");
		expect(about.headers.get("content-security-policy")).toContain(
			"script-src https://flisk.si;",
		);
	});

	it("shows the install commands on the home page", async () => {
		const html = await (await app.request("/")).text();
		expect(html).toContain("/plugin marketplace add flisk-sh/run-my-agents");
		expect(html).toContain("/plugin install run-my-agents@run-my-agents");
	});

	it("keeps links and canonical addresses under the prefix a proxy stripped", async () => {
		const local = createApp();
		const headers = { "x-forwarded-prefix": "/api/web" };
		const html = await (
			await local.request("http://api.tool.localhost/", { headers })
		).text();
		expect(html).toContain('href="/api/web/about"');
		expect(html).toContain(
			'<link rel="canonical" href="http://api.tool.localhost/api/web/">',
		);
		const evil = await (
			await local.request("http://api.tool.localhost/", {
				headers: { "x-forwarded-prefix": "//evil.example" },
			})
		).text();
		expect(evil).not.toContain("evil.example");
	});
});

describe("API and MCP", () => {
	it("answers the install steps as JSON, and 400 for an unknown client", async () => {
		const res = await app.request("/api/install");
		expect(res.status).toBe(200);
		expect((await res.json()).commands).toHaveLength(2);
		expect((await app.request("/api/install?client=vim")).status).toBe(400);
	});

	it("initializes, lists how_to_install and runs it", async () => {
		const init = await (
			await rpc(app, {
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-06-18" },
			})
		).json();
		expect(init.result.serverInfo.title).toBe("Run My Agents");
		const list = await (
			await rpc(app, { jsonrpc: "2.0", id: 2, method: "tools/list" })
		).json();
		expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
			"how_to_install",
		]);
		const call = await (
			await rpc(app, {
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "how_to_install", arguments: {} },
			})
		).json();
		expect(call.result.isError).toBe(false);
		expect(call.result.content[0].text).toContain(
			"/plugin install run-my-agents@run-my-agents",
		);
	});

	it("answers errors as JSON-RPC, and limits calls per client", async () => {
		const bad = (await (
			await rpc(app, { jsonrpc: "2.0", id: 4, method: "nope" })
		).json()) as {
			error: { code: number };
		};
		expect(bad.error.code).toBe(-32601);
		const tight = createApp({ callsPerMinute: 1 });
		expect((await tight.request("/api/install")).status).toBe(200);
		expect((await tight.request("/api/install")).status).toBe(429);
	});
});

describe("guards", () => {
	it("counts hits per window", () => {
		let t = 0;
		const limiter = new RateLimiter(2, 1000, () => t);
		expect([
			limiter.hit("a"),
			limiter.hit("a"),
			limiter.hit("a") > 0,
			limiter.hit("b"),
		]).toEqual([0, 0, true, 0]);
		t = 1000;
		expect(limiter.hit("a")).toBe(0);
	});

	it("forgets cached entries after their time and beyond the size", () => {
		let t = 0;
		const cache = new TtlCache<number>(100, 2, () => t);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.set("c", 3);
		expect(cache.get("a")).toBeUndefined();
		t = 100;
		expect(cache.get("c")).toBeUndefined();
	});
});

describe("live board demo", () => {
	it("serves the real board page with its own script policy, framed only by this site", async () => {
		const res = await app.request("/demo/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toContain(
			"script-src 'unsafe-inline'",
		);
		expect(res.headers.get("content-security-policy")).toContain(
			"frame-ancestors 'self'",
		);
		const html = await res.text();
		expect(html).toContain("Add dark mode to settings");
		expect(html).toContain("This is a demo.");
		expect(
			(await app.request("/demo/fonts/geist.woff2")).headers.get(
				"content-type",
			),
		).toBe("font/woff2");
		// the home page frames the demo and runs one script only, the Download button's (named by its hash)
		const home = await app.request("/");
		const csp = home.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("script-src 'sha256-");
		expect(csp).not.toContain("unsafe-inline'; style");
		expect(csp.match(/script-src ([^;]*)/)?.[1]).not.toContain("unsafe");
		expect(await home.text()).toContain('src="/demo/"');
	});
	it("is built from the current board page, so the site never shows stale CSS", async () => {
		// run `bun run demo` after changing the board page. The board sits outside this package's rootDir, so read it
		// in a child process rather than importing it.
		const PAGE = Bun.spawnSync([
			process.execPath,
			"-e",
			'process.stdout.write(require("../board/src/page").PAGE)',
		]).stdout.toString();
		const css = PAGE.slice(PAGE.indexOf("<style>"), PAGE.indexOf("</style>"));
		expect(await (await app.request("/demo/")).text()).toContain(css);
	});
});

describe("Mac install", () => {
	it("copies the install command from the Download button, and shows what to do next", async () => {
		const res = await app.request("/");
		const html = await res.text();
		// the button carries the command; with no JavaScript it links to the steps, which :target shows
		expect(html).toMatch(
			/<a class="dlb" id="dlb" href="#mac-steps" data-cmd="curl -fsSL https:\/\/run-my-agents\.flisk\.si\/install\.sh \| sh"/,
		);
		expect(html).toContain('id="mac-steps"');
		// no JavaScript: the link's own #mac-steps target is what shows the steps
		expect(html).toContain(".dl .steps:target,.dl .steps.open{display:block}");
		expect(html).toContain("Open <b>Terminal</b>");
		// exactly one script, and the policy allows exactly that one by hash
		const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
			(m) => m[1],
		);
		expect(scripts).toHaveLength(1);
		const { createHash } = await import("node:crypto");
		const hash = `'sha256-${createHash("sha256").update(scripts[0]).digest("base64")}'`;
		expect(res.headers.get("content-security-policy")).toContain(
			`script-src ${hash}`,
		);
		expect(scripts[0]).toContain("navigator.clipboard.writeText");
		expect(scripts[0]).toContain("data-cmd");
	});
	it("keeps the command and the zip as other ways in", async () => {
		const html = await (await app.request("/")).text();
		expect(html).toContain(
			"curl -fsSL https://run-my-agents.flisk.si/install.sh | sh",
		);
		expect(html).toContain(
			'href="https://github.com/flisk-sh/run-my-agents/releases/latest/download/Run-My-Agents-macOS.zip"',
		);
		expect(html).toContain("xattr -cr");
	});
	it("serves an install script that fetches only the GitHub release and clears nothing else", async () => {
		const res = await app.request("/install.sh");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/plain");
		const sh = await res.text();
		expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
		expect(sh).toContain("set -eu");
		// curl saves with no quarantine flag, so macOS does not block the not-yet-notarized app
		expect(sh).toContain(
			'curl -fsSL "https://github.com/flisk-sh/run-my-agents/releases/latest/download/Run-My-Agents-macOS.zip"',
		);
		expect(sh).toContain('ditto -x -k "$tmp/app.zip" "$dir"');
		expect(sh).toContain('xattr -cr "$app"');
		const urls = [...sh.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0]);
		expect(
			urls.filter(
				(u) => !u.startsWith("https://github.com/flisk-sh/run-my-agents"),
			),
		).toEqual([]);
	});
});

describe("Kitchen Rush game", () => {
	it("serves the game with a script-only policy and links it from the nav", async () => {
		const res = await app.request("/play");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toContain(
			"script-src 'unsafe-inline'",
		);
		expect(res.headers.get("content-security-policy")).toContain(
			"script-src 'unsafe-inline' https://flisk.si;",
		);
		const html = await res.text();
		expect(html).toContain(
			'<script src="https://flisk.si/assets/bar.js" defer></script>',
		);
		expect(html).toContain("KITCHEN RUSH");
		// shipping is not binary: flaky tests let slip away are counted on the ship screen
		expect(html).toContain("Waved through: flaky test marked done");
		expect(html).toContain("Receipts round: show your work");
		expect(html).toContain("CLEAN SHIP");
		expect(html).toContain('<canvas id="g"');
		expect(html).toContain('name="twitter:card" content="player"');
		expect(html).toContain('"@type":"VideoGame"');
		// a fixed flaky test comes back once, as "marked done?"
		expect(html).toContain("Marked done?");
		// the HUD and end screens show how many returning flaky tests were really fixed
		expect(html).toContain("Catch rate ");
		expect(html).toContain('waved through "+waved');
		expect(html).toContain('content="https://tool.test/play/card.png"');
		expect(res.headers.get("content-security-policy")).toContain(
			"https://x.com",
		);
		const card = await app.request("/play/card.png");
		expect(card.headers.get("content-type")).toBe("image/png");
		expect(await (await app.request("/")).text()).toContain('/play">Play</a>');
		expect(await (await app.request("/sitemap.xml")).text()).toContain("/play");
	});
});

describe("Kitchen Rush receipts round (#338)", () => {
	// The page's script, with the receipts helpers pulled out so their logic runs without a canvas.
	const helpers = async () => {
		const html = await (await app.request("/play")).text();
		const from = html.indexOf("const RECEIPTS=");
		const to = html.indexOf("function spawn()");
		expect(from).toBeGreaterThan(0);
		return new Function(
			`${html.slice(from, to)}; return { RECEIPTS, receiptName, receiptBosses, afterClock };`,
		)() as {
			receiptName: (i: number) => string;
			receiptBosses: (
				rec: string[],
				x: number,
				y: number,
				lvl: number,
			) => { k: string; lb: string; hp: number }[];
			afterClock: (rec: string[], round: number) => string;
		};
	};

	it("a clean run ships straight away: no receipts round", async () => {
		const g = await helpers();
		expect(g.afterClock([], 0)).toBe("won");
	});

	it("anything waved through starts a receipts round at 5:00, with one boss per waved-through test, labelled with what it was", async () => {
		const g = await helpers();
		const rec = [g.receiptName(0), g.receiptName(1), g.receiptName(2)];
		expect(g.afterClock(rec, 0)).toBe("receipts");
		const bosses = g.receiptBosses(rec, 0, 0, 4);
		expect(bosses).toHaveLength(3);
		expect(bosses.map((b) => b.lb)).toEqual(rec);
		expect(new Set(bosses.map((b) => b.lb)).size).toBe(3);
		expect(bosses.every((b) => b.k === "receipt" && b.hp > 0)).toBe(true);
		// While the round runs the clock does not end the order again.
		expect(g.afterClock(rec, 1)).toBe("play");
	});

	it("many waved-through tests still get distinct names, and the ship screens name the receipt that ended the run", async () => {
		const g = await helpers();
		expect(
			new Set(Array.from({ length: 14 }, (_, i) => g.receiptName(i))).size,
		).toBe(14);
		const html = await (await app.request("/play")).text();
		expect(html).toContain('"The receipt that got you: "+lostTo');
		expect(html).toContain('panel("CLEAN SHIP"');
		expect(html).toContain("if(e.lb)lostTo=e.lb");
	});
});
