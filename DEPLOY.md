# Deploy

## run-my-agents.flisk.si: a Cloudflare Worker

The live site is the Cloudflare Worker `run-my-agents`, running the same Hono app (`services/app/web/src/worker.ts`):

```bash
cd services/app/web && bunx wrangler@4 deploy
```

`services/app/web/wrangler.toml` holds the settings (`PUBLIC_URL`, `TRUST_PROXY=cloudflare`) and attaches the custom
domain; Cloudflare creates its DNS record. The three images are bundled as binary modules (its `Data` rule).

It moved off Render on 2026-11-10: Render's edge put `run-my-agents.onrender.com` behind a bot challenge (HTTP 429,
`cf-mitigated: challenge`) that browsers could not pass, and the old proxy Worker in front of it could not either.

## Or on Render (free)

One Render web service on the free plan, from [`render.yaml`](render.yaml) and the root [`Dockerfile`](Dockerfile).
Nothing to sign up for besides Render: no database, no keys.

## 1. Create the service

1. https://dashboard.render.com → **New → Blueprint** → `flisk-sh/flisk-template-launch`, branch `main`.
2. Render lists one service on the **Free** plan. Apply.
3. Set `PUBLIC_URL` to the address it got (`https://<name>.onrender.com/`) or to your own domain.

The free plan sleeps after 15 minutes without traffic and takes about a minute to wake. On launch day, upgrade to
Starter for the day, or keep it awake.

## 2. Your own domain (optional)

`bun run rename --domain …` uncomments `domains` in `render.yaml` and sets `PUBLIC_URL`. Then:

1. Render → the service → **Settings → Custom Domains** shows the CNAME target (`<service>.onrender.com`).
2. Your DNS (Cloudflare: **DNS → Add record**): `CNAME`, the subdomain, that target, proxy **DNS only**.
3. Wait for Render to issue the certificate.

Without a payment method on file, Render allows two custom domains per workspace; the Blueprint sync fails on a
third. If you put Cloudflare's proxy in front instead, set `TRUST_PROXY=cloudflare` and accept traffic from
Cloudflare only.

## 3. Check it

```bash
curl -s https://your-tool.example.com/ready
curl -s https://your-tool.example.com/robots.txt
curl -s 'https://your-tool.example.com/api/contrast?fg=767676&bg=ffffff'
curl -s -X POST https://your-tool.example.com/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 4. Tell search engines

- Google Search Console and Bing Webmaster Tools: add the domain, submit `/sitemap.xml`.
- Paste a result address into https://www.opengraph.xyz and the Rich Results Test to see the card and the JSON-LD.
