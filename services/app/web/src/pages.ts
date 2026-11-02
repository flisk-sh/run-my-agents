// The pages, rendered on the server with no JavaScript (the Content-Security-Policy allows none): home, about with
// the FAQ, and not found. Each one passes its own PageMeta to head(), which writes every SEO tag. The look is the
// roadmap.flisk.si one: dark first, Satoshi and JetBrains Mono when installed, one green accent.
import { type Agent, AGENTS, avatar } from "./avatars";
import { installSteps } from "./install";
import { esc, faqJsonLd, head, type PageMeta } from "./seo";
import { SITE } from "./site";

const STYLE = `
:root{color-scheme:dark;--bg:${SITE.themeColor.dark};--glow:rgba(34,197,94,.07);--surface:#111117;--text:#ececf1;--muted:rgba(236,236,241,.7);--faint:rgba(236,236,241,.48);--line:rgba(255,255,255,.08);--line-strong:rgba(255,255,255,.2);--accent:#22c55e;--accent-text:#6ee7a0;--accent-tint:rgba(34,197,94,.12);--warn:#f59e0b;--shadow:0 18px 50px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4);--body:"Satoshi","DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace}
*{box-sizing:border-box}
fieldset{border:0;margin:0;padding:0;min-width:0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
body{margin:0;background:radial-gradient(60rem 30rem at 85% -10%,var(--glow),transparent 70%),radial-gradient(40rem 24rem at -10% 20%,rgba(14,165,233,.05),transparent 70%),var(--bg);color:var(--text);font:16px/1.55 var(--body);-webkit-font-smoothing:antialiased}
a{color:var(--accent-text)}.wrap{max-width:56rem;margin:0 auto;padding:0 16px}
header.top{border-bottom:1px solid var(--line)}header.top .wrap{display:flex;align-items:center;gap:12px;height:56px}
header.top a{color:var(--muted);text-decoration:none;font-size:.9rem}header.top a:first-child{color:var(--text);font-weight:700;font-size:1rem;display:flex;gap:8px;align-items:center;margin-right:auto}
.hero{padding:72px 0 40px}
.pill{display:inline-block;font:500 .75rem var(--mono);color:var(--accent-text);background:var(--accent-tint);border-radius:999px;padding:4px 12px}
h1{font-size:clamp(2.4rem,7vw,4rem);line-height:1.05;letter-spacing:-.03em;margin:18px 0 16px;font-weight:900}h1 span{color:var(--accent)}
.lede{font-size:1.2rem;color:var(--muted);max-width:38rem;margin:0 0 28px}
.install{background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}
.install .bar{padding:10px 16px;border-bottom:1px solid var(--line);font-size:.8rem;color:var(--faint)}
pre{margin:0;padding:16px;font:.9rem/1.7 var(--mono);overflow-x:auto}.p{color:var(--faint);user-select:none}
.meta{margin-top:14px;color:var(--faint);font-size:.9rem}
.shot{display:block;width:100%;max-width:800px;height:auto;margin:28px auto 0;border-radius:14px;box-shadow:0 0 0 1px var(--line,rgba(127,127,127,.25)),0 20px 50px -20px rgba(0,0,0,.6)}
section{padding:40px 0}h2{font-size:1.6rem;letter-spacing:-.02em;margin:0 0 8px}.sub{color:var(--muted);margin:0 0 24px}
.term{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:18px;font:.85rem/1.7 var(--mono)}
.who{color:var(--faint)}.ok{color:var(--accent-text)}.warn{color:var(--warn)}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:20px}
.card .n{font:.8rem var(--mono);color:var(--accent-text)}.card h3{margin:6px 0;font-size:1.05rem}.card p{margin:0;color:var(--muted);font-size:.95rem}
ul.limits{margin:0;padding-left:20px;color:var(--muted)}
dt{font-weight:700;margin-top:20px;font-size:1.05rem}dd{margin:6px 0 0;color:var(--muted)}
.prose{padding:56px 0 0}
.ava{display:block;flex:none}
.faces{display:flex;gap:6px;margin:0 0 22px;flex-wrap:wrap}
footer{margin-top:48px;border-top:1px solid var(--line);padding:24px 0 40px;color:var(--faint);font-size:.85rem}
/* The clickable demo: plain radio buttons and labels, so it works with the page's no-JavaScript CSP. */
.demo{position:relative;display:grid;grid-template-columns:15rem minmax(0,1fr);background:var(--surface);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}
.demo .dr{position:absolute;width:1px;height:1px;opacity:0}
.demo .rows{border-right:1px solid var(--line);padding:6px;display:flex;flex-direction:column;gap:1px}
.drow{display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:10px;cursor:pointer;transition:background .15s}
.drow:hover{background:var(--line)}
.drow .ava{flex:none;animation:dbob 3.2s ease-in-out infinite}
.drow .dt{min-width:0}.drow .dt b{display:block;font-size:.86rem}.drow .dt span{display:block;color:var(--faint);font-size:.76rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:9rem}
.ddot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--line-strong)}
.ddot.editing{background:var(--accent);box-shadow:0 0 0 3px var(--accent-tint);animation:dpulse 1.7s ease-in-out infinite}
.ddot.waiting{background:var(--warn)}
.panes{position:relative;padding:18px 20px}
.pane{display:none;flex-direction:column;gap:9px;min-height:15rem}
.phd{display:flex;align-items:center;gap:8px;padding-bottom:11px;margin-bottom:3px;border-bottom:1px solid var(--line)}
.phd b{font-size:.92rem}.phd code{font:.74rem var(--mono);color:var(--faint)}
.pprc{margin-left:auto;display:inline-flex;align-items:center;gap:4px;font:600 .68rem var(--mono);padding:3px 9px;border-radius:999px;background:var(--accent-tint);color:var(--accent-text)}
.pck{width:6px;height:6px;border-radius:50%;background:var(--accent)}
.bub{max-width:78%;padding:8px 12px;border-radius:14px;font-size:.87rem;line-height:1.5;animation:dup .3s ease both}
.bub.you{align-self:flex-end;background:rgba(34,197,94,.13);border:1px solid rgba(34,197,94,.22);border-top-right-radius:4px}
.bub.ag{align-self:flex-start;background:rgba(14,165,233,.11);border:1px solid rgba(14,165,233,.2);border-top-left-radius:4px;animation-delay:.1s}
@keyframes dbob{50%{transform:translateY(-2px)}}
@keyframes dpulse{50%{box-shadow:0 0 0 6px transparent}}
@keyframes dup{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
#demo-0:checked~.rows .dr0,#demo-1:checked~.rows .dr1,#demo-2:checked~.rows .dr2,#demo-3:checked~.rows .dr3,#demo-4:checked~.rows .dr4{background:var(--line-strong)}
#demo-0:checked~.panes .pn0,#demo-1:checked~.panes .pn1,#demo-2:checked~.panes .pn2,#demo-3:checked~.panes .pn3,#demo-4:checked~.panes .pn4{display:flex}
#demo-0:focus-visible~.rows .dr0,#demo-1:focus-visible~.rows .dr1,#demo-2:focus-visible~.rows .dr2,#demo-3:focus-visible~.rows .dr3,#demo-4:focus-visible~.rows .dr4{outline:2px solid var(--accent-text);outline-offset:-2px}
@media (max-width:640px){.demo{grid-template-columns:1fr}.rows{flex-direction:row;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line)}.drow{flex:none}.drow .dt span{display:none}}

/* Motion, like the board: a living background, faces that bob and blink, a staggered entrance, sections that rise in. */
body{background-size:140% 140%,140% 140%,auto;animation:bgdrift 18s ease-in-out infinite alternate}
@keyframes bgdrift{to{background-position:30% 20%,70% 60%,0 0}}
.hero>*{animation:rise .7s cubic-bezier(.2,.8,.2,1) both}
.hero>*:nth-child(2){animation-delay:.08s}.hero>*:nth-child(3){animation-delay:.16s}.hero>*:nth-child(4){animation-delay:.24s}.hero>*:nth-child(5){animation-delay:.32s}.hero>*:nth-child(6){animation-delay:.4s}.hero>*:nth-child(7){animation-delay:.48s}
@keyframes rise{from{opacity:0;transform:translateY(18px);filter:blur(4px)}}
.faces .ava{animation:fbob 3s ease-in-out infinite,fin .6s cubic-bezier(.3,1.6,.5,1) both;filter:drop-shadow(0 6px 6px rgba(0,0,0,.35));transition:transform .25s}
.faces .ava:nth-child(2n){animation-delay:-1.1s,.05s}.faces .ava:nth-child(3n){animation-delay:-2s,.1s}.faces .ava:nth-child(4n){animation-delay:-.6s,.15s}.faces .ava:nth-child(5n){animation-delay:-1.6s,.2s}
.faces .ava:hover{transform:translateY(-6px) scale(1.15) rotate(-6deg)}
@keyframes fbob{50%{translate:0 -5px}}
@keyframes fin{from{opacity:0;scale:.3}}
.ava circle[fill="#0b0b10"],.ava rect[fill="#0b0b10"],.ava ellipse[fill="#0b0b10"]{transform-box:fill-box;transform-origin:center;animation:blink 5s infinite}
@keyframes blink{0%,94%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}
h1 span{background:linear-gradient(90deg,var(--accent),#6ee7a0,#38bdf8,var(--accent));background-size:300% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shine 6s linear infinite}
@keyframes shine{to{background-position:300% 0}}
.pill{animation:rise .7s both,glowp 2.6s ease-in-out infinite 1s}
@keyframes glowp{50%{box-shadow:0 0 0 6px var(--accent-tint)}}
.shot{animation:rise .9s .5s cubic-bezier(.2,.8,.2,1) both,float 6s ease-in-out 1.4s infinite;transition:transform .4s,box-shadow .4s}
.shot:hover{transform:translateY(-4px) scale(1.01);box-shadow:0 0 0 1px var(--accent),0 30px 70px -20px rgba(34,197,94,.45)}
@keyframes float{50%{translate:0 -8px}}
@supports (animation-timeline:view()){section{animation:rise linear both;animation-timeline:view();animation-range:entry 0% entry 40%}}
.steps>*,.limits li{transition:transform .25s,box-shadow .25s}.steps>*:hover{transform:translateY(-4px)}
.copy,button{transition:transform .15s,filter .2s}.copy:hover,button:hover{filter:brightness(1.15)}.copy:active,button:active{transform:scale(.95)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

function layout(base: string, meta: PageMeta, body: string): string {
	const root = new URL(`${base}/`).pathname.replace(/\/$/, "");
	return `<!doctype html><html lang="${SITE.lang}"><head>
${head(base, meta)}
<style>${STYLE}</style></head><body>
<header class="top"><nav class="wrap" aria-label="Site"><a href="${root}/"><img src="${root}/icon.svg" alt="" width="20" height="20">${esc(SITE.name)}</a><a href="${root}/about">About</a><a href="${SITE.repo}">GitHub</a></nav></header>
<main>${body}</main>
<footer><div class="wrap">MIT licensed. Made by <a href="${SITE.author.url}">${esc(SITE.author.name)}</a> and run locally with <a href="https://github.com/flisk-sh/flisk">Flisk</a>. <a href="${SITE.repo}">Source on GitHub</a>.</div></footer>
</body></html>`;
}

function installBox(): string {
	const steps = installSteps();
	if (!steps) return "";
	return `<div class="install"><div class="bar">In Claude Code</div><pre>${steps.commands
		.map((c) => `<span class="p">&gt; </span>${esc(c)}`)
		.join("\n")}</pre></div>`;
}

/** A short exchange for the clickable demo, keyed to an existing agent in AGENTS by role. */
interface DemoStep {
	role: string;
	you: string;
	agent: string;
	pr?: number;
}

const DEMO: DemoStep[] = [
	{
		role: "Code",
		you: "fix the 500 on checkout",
		agent: "Found it — `total` was undefined on an empty cart. Fixed, tests added, pushed.",
		pr: 41,
	},
	{
		role: "Bug",
		you: "why does the app crash on iOS only",
		agent: "The crash log points at a race in the auth refresh. Reproducing it now, back in a minute.",
	},
	{
		role: "Refactor",
		you: "split payments.ts, it's 900 lines",
		agent: "Split into charge, refund and webhooks, same tests, same behavior. Ready for a look.",
	},
	{
		role: "Feature",
		you: "add dark mode",
		agent: "Added a theme toggle and a prefers-color-scheme default. Screenshot in the PR.",
		pr: 52,
	},
	{
		role: "Design",
		you: "the pricing page feels cramped",
		agent: "Opened up the spacing and gave the button its own row. Diff is small, want to see it?",
	},
];

/**
 * A board you can click: plain radio inputs and labels pick which agent's chat shows, matched in the CSS above by
 * id. No JavaScript, so it works under the page's `default-src 'none'` CSP.
 */
function demoBoard(): string {
	const steps = DEMO.map((d) => ({ ...d, a: AGENTS.find((a) => a.role === d.role) as Agent }));
	const inputs = steps.map((_, i) => `<input type="radio" name="demo" id="demo-${i}" class="dr"${i === 0 ? " checked" : ""}>`).join("");
	const rows = steps
		.map(
			(d, i) =>
				`<label for="demo-${i}" class="drow dr${i}"><span class="ddot ${d.a.state}"></span>${avatar(d.a, 34)}<span class="dt"><b>${esc(d.a.role)}</b><span>${esc(d.a.task)}</span></span></label>`,
		)
		.join("");
	const panes = steps
		.map(
			(d, i) =>
				`<div class="pane pn${i}"><div class="phd">${avatar(d.a, 26)}<b>${esc(d.a.role)}</b><code>${esc(d.a.file)}</code>${d.pr ? `<span class="pprc"><span class="pck"></span>#${d.pr} merged</span>` : ""}</div><div class="bub you">${esc(d.you)}</div><div class="bub ag">${esc(d.agent)}</div></div>`,
		)
		.join("");
	return `<fieldset class="demo"><legend class="sr-only">Click an agent to see its chat</legend>${inputs}<div class="rows">${rows}</div><div class="panes">${panes}</div></fieldset>`;
}

export function homePage(base: string): string {
	return layout(
		base,
		{
			path: "",
			title: `${SITE.name}: ${SITE.tagline}`,
			description: SITE.description,
		},
		`<div class="wrap"><div class="hero"><div class="faces">${AGENTS.map((a) => avatar(a, 40)).join("")}</div><span class="pill">Free Claude Code plugin</span>
<h1>Run My <span>Agents</span></h1>
<p class="lede">Run many Claude Code sessions on one repo, and stop them overwriting each other's work.</p>
${installBox()}
<p class="meta">No server. No account. No keys. Everything stays on your computer.</p><img class="shot" src="/preview.gif" width="800" height="500" alt="The Run My Agents board: every Claude Code session, its model, tokens and pull requests on one screen"></div>
<section><h2>Your agent team, on one repo</h2><p class="sub">Every agent has its own job. Click one to see what it's working on.</p>${demoBoard()}<p class="meta">A preview of five agents' chats. Install it and this runs for real, on your own repo.</p></section>
<section><h2>What your agent sees</h2><p class="sub">Session 2 tries to edit a file session 1 changed two minutes ago.</p>
<div class="term"><div><span class="who">session 1 ·</span> Edit api.ts <span class="ok">✓</span></div>
<div><span class="who">session 2 ·</span> Edit api.ts</div>
<div class="warn">⚠ Another Claude session (9d5f2846 on branch fix-login) edited api.ts 2 min ago.</div>
<div class="warn">&nbsp;&nbsp;Read the file again first, or work on a different file.</div>
<div><span class="who">session 2 ·</span> Read api.ts, then Edit api.ts <span class="ok">✓ nothing lost</span></div></div></section>
<section><h2>How it works</h2><p class="sub">One small hook. A warning, not a lock.</p><div class="steps">
<div class="card"><div class="n">01</div><h3>Every edit is noted</h3><p>Before Claude edits a file, the hook writes down which session touched it.</p></div>
<div class="card"><div class="n">02</div><h3>Overlaps get a warning</h3><p>If another session edited that file in the last 10 minutes, the edit stops once, with a note.</p></div>
<div class="card"><div class="n">03</div><h3>The agent carries on</h3><p>It re-reads the file and edits again. A second try always goes through.</p></div></div></section>
<section><h2>What it doesn't do yet</h2><ul class="limits"><li>It only sees sessions on this computer.</li><li>It doesn't see edits made through shell commands like <code>sed</code>.</li><li>It matches whole files, not lines.</li></ul></section></div>`,
	);
}

export function aboutPage(base: string): string {
	return layout(
		base,
		{
			path: "about",
			title: "About and FAQ",
			description:
				`How ${SITE.name} works, what it stores and what it does not catch yet. ${SITE.tagline}.`.slice(
					0,
					160,
				),
			jsonLd: [faqJsonLd()],
			crumbs: [{ name: "About", path: "about" }],
		},
		`<div class="wrap prose"><h1>About ${esc(SITE.name)}</h1>
<p class="lede">${esc(SITE.description)}</p>
${installBox()}
<h2 style="margin-top:40px">Questions</h2>
<dl>${SITE.faq.map((f) => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join("")}</dl>
<h2 style="margin-top:40px">Ask an AI assistant how to install it</h2>
<div class="install"><pre>claude mcp add --transport http run-my-agents ${esc(base)}/mcp</pre></div></div>`,
	);
}

export function notFoundPage(base: string): string {
	const root = new URL(`${base}/`).pathname.replace(/\/$/, "");
	return layout(
		base,
		{
			path: "404",
			title: "Page not found",
			description: `This address is not a page on ${SITE.name}.`,
			noindex: true,
		},
		`<div class="wrap prose"><h1>Page not found</h1><p class="lede">Go to the <a href="${root}/">home page</a> to install ${esc(SITE.name)}.</p></div>`,
	);
}
