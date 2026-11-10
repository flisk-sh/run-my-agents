// Cloudflare Worker entry: the same Hono app as index.ts, served from the edge instead of a Render container.
// Settings come from [vars] in wrangler.toml (PUBLIC_URL, TRUST_PROXY, CALLS_PER_MINUTE). The images are bundled as
// binary modules (the Data rule in wrangler.toml), since a Worker has no disk to read them from.
import { createApp } from "./app";
import { parseProxyMode } from "./guard";
import heroKitchen from "./hero-kitchen.jpg";
import card from "./play-card.png";
import preview from "./preview.gif";

interface Env {
	PUBLIC_URL?: string;
	TRUST_PROXY?: string;
	CALLS_PER_MINUTE?: string;
}

let app: ReturnType<typeof createApp> | undefined;

export default {
	fetch(
		request: Request,
		env: Env,
		ctx: unknown,
	): Response | Promise<Response> {
		app ??= createApp({
			publicUrl: env.PUBLIC_URL || undefined,
			proxy: parseProxyMode(env.TRUST_PROXY),
			callsPerMinute: Number(env.CALLS_PER_MINUTE) || undefined,
			images: {
				preview: new Uint8Array(preview),
				heroKitchen: new Uint8Array(heroKitchen),
				card: new Uint8Array(card),
			},
		});
		return app.fetch(request, env, ctx as never);
	},
};
