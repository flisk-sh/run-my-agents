// Builds the live board demo for the website: the real board page from services/app/board, with its API answered
// in the browser from made-up sessions, so the site shows exactly what the Mac app shows. Run `bun run demo` after
// changing the board page, then commit src/demo.generated.ts.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEIST, GEIST_MONO } from "../../board/src/fonts.generated";
import { PAGE } from "../../board/src/page";
import { AGENTS } from "../src/avatars";

const face = (role: string) => {
	const a = AGENTS.find((x) => x.role === role) ?? AGENTS[0];
	return { shape: a.shape, eyes: a.eyes, color: a.color, extra: a.extra };
};
const min = 60_000;
// [id, role, title, model, branch, tokens, minutes ago, state, doing, feed]
const S = [
	{ id: "d1", role: "Feature", title: "Add dark mode to settings", model: "claude-opus-5-5", branch: "feat/dark-mode", used: 412_000, ago: 0.1, sending: true, doing: "Edit theme.ts",
		prs: [{ number: 128, title: "Add dark mode", state: "OPEN", url: "https://github.com/acme/shop/pull/128", repo: "acme/shop", branch: "feat/dark-mode", draft: false, checks: "pending", review: "REVIEW_REQUIRED", merge: "BLOCKED" }],
		feed: [
			["you", "Add a dark mode toggle to the settings page, and remember the choice."],
			["agent", "On it. I'll add a **theme toggle** in `Settings.tsx`, store it in `localStorage`, and default to the system setting.\n\n- `src/theme.ts`: read and save the choice\n- `src/Settings.tsx`: the toggle\n- `src/index.css`: dark colours", ["Read Settings.tsx", "Edit theme.ts", "Edit Settings.tsx"]],
		] },
	{ id: "d2", role: "Bug", title: "Fix checkout crash on empty cart", model: "claude-sonnet-5", branch: "fix/empty-cart", used: 1_640_000, ago: 3, doing: "Bash bun test",
		prs: [{ number: 126, title: "Fix checkout crash on empty cart", state: "OPEN", url: "https://github.com/acme/shop/pull/126", repo: "acme/shop", branch: "fix/empty-cart", draft: false, checks: "pass", review: "APPROVED", merge: "CLEAN" }],
		feed: [
			["you", "Checkout crashes when the cart is empty. Find it and fix it."],
			["agent", "Found it: `total()` reads `items[0].currency` before checking the cart has items.\n\nI added a guard and a test for the empty cart. **All 214 tests pass.**", ["Read cart.ts", "Edit cart.ts", "Bash bun test"]],
			["you", "Nice, open a PR"],
			["agent", "Opened **#126**. Checks passed and it's approved, ready to merge.", ["Bash gh pr create"]],
		] },
	{ id: "d3", role: "Refactor", title: "Split the payments module", model: "claude-opus-5-5", branch: "refactor/payments", used: 980_000, ago: 6, doing: "Edit payments/stripe.ts", awaiting: true,
		prs: [],
		feed: [
			["you", "payments.ts is 1,800 lines. Split it up without changing behaviour."],
			["agent", "I split it into `payments/stripe.ts`, `payments/refunds.ts` and `payments/webhooks.ts`. Tests pass.\n\n**Heads up:** the Bug agent edited `cart.ts` 3 minutes ago, so I re-read it before touching the import.", ["Edit payments/stripe.ts", "Edit payments/refunds.ts"], { ask: "Open a PR for the split?", labels: ["Yes, open it", "Not yet"] }],
		] },
	{ id: "d4", role: "Design", title: "New pricing page", model: "claude-sonnet-5", branch: "design/pricing", used: 260_000, ago: 14, doing: "Edit pricing.css",
		prs: [{ number: 121, title: "New pricing page", state: "MERGED", url: "https://github.com/acme/shop/pull/121", repo: "acme/shop", branch: "design/pricing", draft: false, checks: "pass" }],
		feed: [
			["you", "Make the pricing page look premium. Three plans, the middle one highlighted."],
			["agent", "Done: three cards, the **Pro** plan raised and outlined, and a monthly/yearly switch. Merged as #121.", ["Edit pricing.css", "Edit Pricing.tsx"]],
		] },
	{ id: "d5", role: "Planner", title: "Plan the v2 launch", model: "claude-haiku-5", branch: "main", used: 120_000, ago: 42, doing: "Write PLAN.md", prs: [],
		feed: [["you", "Break the v2 launch into tasks for the other agents."], ["agent", "Wrote `PLAN.md` with 9 tasks across Feature, Bug and Design. The first three are already running.", ["Write PLAN.md"]]] },
];

const DATA = S.map((s) => ({
	id: s.id, agent: "claude", model: s.model, tokens: { used: s.used, cached: s.used * 9 }, cwd: "/Users/you/code/shop", branch: s.branch, branches: [s.branch],
	title: s.title, said: "", doing: s.doing, edits: [], role: s.role, roleSet: true, pinned: s.id === "d1", awaiting: !!s.awaiting, viaApp: false,
	face: face(s.role), lower: /opus/.test(s.model) ? "sonnet" : /sonnet/.test(s.model) ? "haiku" : null, skills: [], sending: !!s.sending, prs: s.prs, queue: [],
	ago: s.ago,
	feed: s.feed.map(([who, text, tools, options], i) => ({ who, text, tools: tools ?? [], ...(options ? { options } : {}), back: (s.feed.length - i) * 0.6 + s.ago })),
}));

// Answers the board's API calls in the browser. Times are made fresh on every load, so "2 min ago" stays true.
const shim = `
(()=>{const T=Date.now(),D=${JSON.stringify(DATA)};
for(const s of D){s.updatedAt=T-s.ago*${min};for(const f of s.feed){f.at=T-f.back*${min};f.t0=f.at;delete f.back}delete s.ago}
const REPLY=["Got it. Working on that now.","On it: reading the code first, then I'll make the change.","Done. Tests pass, and I left a note in the PR."];let n=0;
const ok=b=>Promise.resolve(new Response(JSON.stringify(b),{headers:{"content-type":"application/json"}}));
const no=()=>ok({error:"This is a demo. Install Run My Agents to run your own agents."});
window.fetch=(u,o)=>{u=String(u);const b=o&&o.body?JSON.parse(o.body):{},s=D.find(x=>x.id===b.id||u.includes("id="+x.id));
if(u.startsWith("api/sessions"))return ok({sessions:D,clashes:[{file:"/Users/you/code/shop/src/cart.ts",sessions:["d2","d3"]}],limits:{sessionTokens:2000000,autoDowngrade:true},order:[],build:"demo"});
if(u.startsWith("api/prs"))return ok({branch:s&&s.branch,prs:s?s.prs:[]});
if(u.startsWith("api/send")&&s){const now=Date.now();s.feed.push({at:now,t0:now,who:"you",text:b.text||"",tools:[]});s.sending=true;s.awaiting=false;s.feed.forEach(f=>delete f.options);s.updatedAt=now;
setTimeout(()=>{const t=Date.now();s.feed.push({at:t,t0:t,who:"agent",text:REPLY[n++%REPLY.length],tools:["Read src/app.ts"]});s.sending=false;s.updatedAt=t},2600);return ok({sent:true})}
if(u.startsWith("api/tune")&&s){s.tune=Object.assign({},s.tune,{model:b.model,effort:b.effort});return ok({})}
if(u.startsWith("api/downgrade")&&s){s.tune={model:s.lower};s.lower=s.lower==="sonnet"?"haiku":null;return ok({model:s.tune.model,next:s.lower})}
if(u.startsWith("api/pin")&&s){s.pinned=!!b.pinned;return ok({})}
if(u.startsWith("api/order"))return ok({});
return no()};})();
`;
const html = PAGE.replace("<script>", `<script>${shim}`);
writeFileSync(
	join(import.meta.dir, "..", "src", "demo.generated.ts"),
	`// Written by \`bun run demo\` from the board page. Do not edit.\nexport const DEMO_HTML = ${JSON.stringify(html)};\nexport const DEMO_FONTS: Record<string, string> = ${JSON.stringify({ "geist.woff2": GEIST, "geist-mono.woff2": GEIST_MONO })};\n`,
);
console.log("Wrote src/demo.generated.ts");
