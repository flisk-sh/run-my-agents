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
	it("serves the home page with a policy that allows no scripts", async () => {
		const res = await app.request("/");
		expect(res.status).toBe(200);
		const csp = res.headers.get("content-security-policy");
		expect(csp).toContain("default-src 'none'");
		expect(csp).not.toContain("script-src");
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
		// the home page stays script-free and frames the demo
		const home = await app.request("/");
		expect(home.headers.get("content-security-policy")).not.toContain(
			"script-src",
		);
		expect(await home.text()).toContain('src="/demo/"');
	});
});

describe("Kitchen Rush game", () => {
	it("serves the game with a script-only policy and links it from the nav", async () => {
		const res = await app.request("/play");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-security-policy")).toContain(
			"script-src 'unsafe-inline'",
		);
		const html = await res.text();
		expect(html).toContain("KITCHEN RUSH");
		expect(html).toContain('<canvas id="g"');
		expect(html).toContain('name="twitter:card" content="player"');
		expect(html).toContain('"@type":"VideoGame"');
		// a fixed flaky test comes back once
		expect(html).toContain("Passed... then failed");
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
