// Routes: the home and about pages, the SEO files and icons, the install steps as JSON and over MCP.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { ASSETS } from "./assets.generated";
import { DEMO_FONTS, DEMO_HTML } from "./demo.generated";
import { gamePage } from "./game";
import {
	clientIp,
	type ProxyMode,
	RateLimiter,
	securityHeaders,
} from "./guard";
import { installSteps } from "./install";
import { DL_SCRIPT_HASH, INSTALL_SH } from "./install-mac";
import { handleMcp } from "./mcp";
import { aboutPage, homePage, notFoundPage } from "./pages";
import {
	ICONS,
	llmsTxt,
	robotsTxt,
	securityTxt,
	sitemapXml,
	webManifest,
} from "./seo";
import { SITE } from "./site";

export interface AppOptions {
	/** The address people use, ending in a slash. Without it, each request's own address (see baseOf). */
	publicUrl?: string;
	proxy?: ProxyMode;
	/** API and MCP calls per client per minute. */
	callsPerMinute?: number;
	/** The date sitemap.xml gives as lastmod: when this build started. */
	builtAt?: Date;
	/** The three images the pages show. Without them, read from next to this file (Bun); the Worker passes them in. */
	images?: Images;
}

export interface Images {
	preview: Uint8Array;
	heroKitchen: Uint8Array;
	card: Uint8Array;
}

function readImages(): Images {
	const read = (name: string) => readFileSync(join(import.meta.dir, name));
	return {
		preview: read("preview.gif"),
		heroKitchen: read("hero-kitchen.jpg"),
		card: read("play-card.png"),
	};
}

/** The icons and the social card from assets.generated.ts, decoded once. tests/seo.test.ts fails on a missing one. */
function loadAssets(): Map<string, { body: Uint8Array; type: string }> {
	const files = new Map<string, { body: Uint8Array; type: string }>();
	for (const name of Object.values(ICONS)) {
		const asset = ASSETS[name];
		if (asset)
			files.set(name, {
				body: Buffer.from(asset.base64, "base64"),
				type: asset.type,
			});
	}
	return files;
}

export function createApp(options: AppOptions = {}) {
	const proxy = options.proxy ?? "none";
	const limit = new RateLimiter(options.callsPerMinute ?? 120, 60 * 1000);
	const lastmod = (options.builtAt ?? new Date()).toISOString().slice(0, 10);
	const files = loadAssets();
	const images = options.images ?? readImages();
	const app = new Hono();

	/**
	 * The site address without the trailing slash: publicUrl when set (online), else this request's own origin and the
	 * prefix a proxy stripped (X-Forwarded-Prefix, /api/web behind Flisk's local proxy).
	 */
	const baseOf = (c: {
		req: { url: string; header: (name: string) => string | undefined };
	}) => {
		if (options.publicUrl) return options.publicUrl.replace(/\/$/, "");
		const prefix = c.req.header("x-forwarded-prefix") ?? "";
		const url = new URL(c.req.url);
		const proto =
			c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
		const host = c.req.header("x-forwarded-host") ?? url.host;
		return `${proto}://${host}${/^(\/[\w.-]+)+$/.test(prefix) ? prefix : ""}`;
	};
	const limited = (c: { req: { raw: Request }; env: unknown }) => {
		const env = c.env as
			| { requestIP?: (r: Request) => { address: string } | null }
			| undefined;
		return limit.hit(
			clientIp(c.req.raw.headers, env?.requestIP?.(c.req.raw)?.address, proxy),
		);
	};

	app.use("*", async (c, next) => {
		await next();
		for (const [k, v] of Object.entries(securityHeaders()))
			if (!c.res.headers.has(k)) c.res.headers.set(k, v);
	});

	app.get("/health", (c) =>
		c.json({ status: "ok", service: SITE.name.toLowerCase() }),
	);
	app.get("/ready", (c) => c.json({ ready: true }));

	// Pages
	// The home page runs one script, the Download button's copy (install-mac.ts), named by its hash: nothing else may run.
	app.get("/", (c) => {
		c.header(
			"content-security-policy",
			`default-src 'none'; script-src ${DL_SCRIPT_HASH} https://flisk.si https://flisk.sh; connect-src https://flisk.sh; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
		);
		return c.html(homePage(baseOf(c)));
	});
	app.get("/about", (c) => c.html(aboutPage(baseOf(c))));
	// For search engines and AI assistants
	app.get("/robots.txt", (c) => c.text(robotsTxt(baseOf(c))));
	// The Mac install command (see install-mac.ts). Plain text so `curl | sh` and a browser both show the script.
	app.get("/install.sh", (c) =>
		c.text(INSTALL_SH, 200, { "cache-control": "public, max-age=300" }),
	);
	app.get("/sitemap.xml", (c) => {
		const paths = ["", "about", "play"];
		return c.body(sitemapXml(baseOf(c), paths, lastmod), 200, {
			"content-type": "application/xml; charset=utf-8",
		});
	});
	app.get("/llms.txt", (c) =>
		c.text(
			llmsTxt(baseOf(c), [
				{
					name: "Install steps as JSON",
					path: "api/install",
					note: "the commands to run in Claude Code",
				},
				{
					name: "MCP server",
					path: "mcp",
					note: "Streamable HTTP, one read-only tool, how_to_install",
				},
				{
					name: "About and FAQ",
					path: "about",
					note: "what it does and stores",
				},
			]),
		),
	);
	app.get("/site.webmanifest", (c) =>
		c.body(webManifest(baseOf(c)), 200, {
			"content-type": "application/manifest+json",
		}),
	);
	// The board preview on the home page, read once from next to this file.
	const preview = images.preview;
	app.get("/preview.gif", (c) =>
		c.body(preview as unknown as Uint8Array<ArrayBuffer>, 200, {
			"content-type": "image/gif",
			"cache-control": "public, max-age=86400",
		}),
	);
	// The live board demo: the real board page, answering its own API from made-up sessions (see scripts/demo.ts).
	// It runs JavaScript, so it gets its own policy, and only this site may frame it.
	const demoCsp =
		"default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
	app.get("/demo", (c) => c.redirect("/demo/", 301));
	app.get("/demo/", (c) => {
		c.header("content-security-policy", demoCsp);
		c.header("x-robots-tag", "noindex");
		return c.html(DEMO_HTML);
	});
	const demoFonts = Object.fromEntries(
		Object.entries(DEMO_FONTS).map(([k, v]) => [k, Buffer.from(v, "base64")]),
	);
	app.get("/demo/fonts/:file", (c) => {
		const font = demoFonts[c.req.param("file")];
		if (!font) return c.notFound();
		return c.body(font as unknown as Uint8Array<ArrayBuffer>, 200, {
			"content-type": "font/woff2",
			"cache-control": "public, max-age=31536000, immutable",
		});
	});
	// The kitchen behind the home page's hero, a screenshot of the board's Kitchen tab.
	const heroKitchen = images.heroKitchen;
	app.get("/hero-kitchen.jpg", (c) =>
		c.body(heroKitchen as unknown as Uint8Array<ArrayBuffer>, 200, {
			"content-type": "image/jpeg",
			"cache-control": "public, max-age=3600",
		}),
	);
	// Kitchen Rush, the browser game (see game.ts). One inline script and nothing else; X may frame it, so the
	// game plays inside a post.
	const card = images.card;
	app.get("/play/card.png", (c) =>
		c.body(card as unknown as Uint8Array<ArrayBuffer>, 200, {
			"content-type": "image/png",
			"cache-control": "public, max-age=86400",
		}),
	);
	app.get("/play", (c) => {
		c.header(
			"content-security-policy",
			"default-src 'none'; script-src 'unsafe-inline' https://flisk.si https://flisk.sh; connect-src https://flisk.sh; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' https://x.com https://*.x.com https://twitter.com https://*.twitter.com",
		);
		return c.html(gamePage(baseOf(c)));
	});
	app.get("/.well-known/security.txt", (c) => c.text(securityTxt(baseOf(c))));
	for (const [name, file] of files)
		app.get(`/${name}`, (c) =>
			c.body(file.body as Uint8Array<ArrayBuffer>, 200, {
				"content-type": file.type,
				"cache-control": "public, max-age=604800",
			}),
		);

	// For code
	app.get("/api/install", (c) => {
		const wait = limited(c);
		if (wait > 0)
			return c.json({ error: "Too many requests." }, 429, {
				"retry-after": String(wait),
			});
		const steps = installSteps(c.req.query("client") ?? "claude-code");
		return steps
			? c.json(steps)
			: c.json({ error: "Only client=claude-code is supported for now." }, 400);
	});
	app.get("/mcp", (c) =>
		c.text("Send MCP requests with POST.", 405, { allow: "POST" }),
	);
	app.post("/mcp", async (c) => {
		const wait = limited(c);
		if (wait > 0)
			return c.json(
				{
					jsonrpc: "2.0",
					id: null,
					error: { code: -32000, message: "Too many requests." },
				},
				429,
			);
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json(
				{
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message: "Parse error" },
				},
				400,
			);
		}
		const answer = await handleMcp(body);
		return answer === undefined ? c.body(null, 202) : c.json(answer);
	});

	app.notFound((c) => c.html(notFoundPage(baseOf(c)), 404));
	return app;
}
