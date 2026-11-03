// UI bugs found by driving the board in a browser: each test failed on main before its fix (issue number in its name).
import { describe, expect, it } from "bun:test";
import { KITCHEN_CSS, KITCHEN_JS } from "../src/kitchen/view";
import { PAGE } from "../src/page";

const JS = PAGE.split("<script>")[1].split("</script>")[0];
const STYLE = PAGE.split("<style>")[1].split("</style>")[0];
const PAGE_CSS = STYLE.replace(KITCHEN_CSS, "");
/** One `document.addEventListener(type, handler)` call, by a prefix of its handler; returns the handler's source. */
const handler = (src: string, type: string, starts: string, tail = ");") => {
	const head = `document.addEventListener("${type}",`;
	const at = src.indexOf(head + starts);
	if (at < 0) throw new Error(`no ${type} handler starting ${starts}`);
	/* a one-line handler ends at its line's end; a longer one at the first `tail` after it */
	const multi = tail !== ");";
	const end = multi ? src.indexOf(tail, at) + tail.length : src.indexOf("\n", at);
	const text = src.slice(at + head.length, end).trimEnd();
	return text.slice(0, text.length - tail.length);
};
const selectors = (css: string) =>
	css
		.replace(/@keyframes[^{]*\{([^{}]*\{[^}]*\})*\}/g, "")
		.replace(/@media[^{]*\{/g, "")
		.split("}")
		.map((r) => r.split("{")[0])
		.flatMap((s) => s.split(","))
		.map((s) => s.trim())
		.filter(Boolean);
const unscoped = (css: string) => new Set(selectors(css).map((s) => /^\.([\w-]+)$/.exec(s)?.[1]).filter(Boolean) as string[]);
const styles = (css: string, c: string) => selectors(css).some((s) => new RegExp(`\\.${c}(?![\\w-])`).test(s));

describe("board UI bugs", () => {
	it("#265: Cmd+Enter in the kitchen order box (or any other input) does not answer the agent's question", () => {
		const src = handler(JS, "keydown", 'e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter"');
		const answered: string[] = [];
		const run = new Function("$", "document", "answer", `return (${src})`)(
			() => ({ value: "" }),
			{ querySelector: () => ({ dataset: { opt: "Yes, ship it" } }) },
			(l: string) => answered.push(l),
		);
		const ev = (target: object) => ({ metaKey: true, ctrlKey: false, key: "Enter", target, preventDefault() {} });
		const input = (id: string) => ({ id, tagName: "INPUT", matches: (s: string) => /\binput\b/.test(s), closest: () => null });
		run(ev(input("ktitle")));
		run(ev(input("rnmIn")));
		run(ev(input("palIn")));
		expect(answered).toEqual([]);
	});

	it("#265: Cmd+Enter in the empty message box, or with no text field focused, still answers", () => {
		const src = handler(JS, "keydown", 'e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter"');
		const answered: string[] = [];
		const run = new Function("$", "document", "answer", `return (${src})`)(
			() => ({ value: "" }),
			{ querySelector: () => ({ dataset: { opt: "Yes, ship it" } }) },
			(l: string) => answered.push(l),
		);
		const ev = (target: object) => ({ metaKey: true, ctrlKey: false, key: "Enter", target, preventDefault() {} });
		run(ev({ id: "msg", tagName: "TEXTAREA", matches: () => true }));
		run(ev({ id: "", tagName: "BODY", matches: () => false }));
		expect(answered).toEqual(["Yes, ship it", "Yes, ship it"]);
	});
	it("#267: no #kview child that clips or scrolls can be squeezed to nothing (ratings table, kitchen canvas)", () => {
		/* #kview is a flex column; a child with overflow other than visible has min-height 0, so the Scores ratings
		   table collapsed to 0 px and the Kitchen canvas lost its bottom (HUD, Served hatch) on a wide, short window */
		const all = /#kview>\*\{[^}]*flex(-shrink)?:(none|0)/.test(KITCHEN_CSS);
		const kgame = /\.kgame\{[^}]*flex(-shrink)?:(none|0)/.test(KITCHEN_CSS);
		const ratings = /H\("div",\{style:"([^"]*)"\},H\("div",\{class:"rates"\}/.exec(KITCHEN_JS)?.[1] ?? "";
		expect(all || (kgame && /flex(-shrink)?:(none|0)/.test(ratings))).toBe(true);
	});
	it("#272: hides the chat's own message queue on the kitchen tabs", () => {
		/* #queue sits in .main next to #feed; on Queue/Kitchen/... it still showed the agent's queued messages with Send now */
		expect(/\.main\.kmode>#queue[,{]/.test(KITCHEN_CSS)).toBe(true);
	});
	it("#268: a click on the chip leaves the popover open", () => {
		/* the chip's branch calls showUmux then stopPropagation(), but the outside-click closer is another listener on
		   document, so it still runs for the same click and removes the popover it just opened */
		const branch = /if\(k==="umux"\)\{([^}]*)\}/.exec(JS)?.[1] ?? "";
		const closer = handler(JS, "click", "e=>{if(apEl&&!e.target.closest(\".apop\")");
		let hid = false;
		const run = new Function("apEl", "hideAct", `return (${closer})`)({ className: "prpop apop umpop" }, () => {
			hid = true;
		});
		const chip = { closest: (s: string) => (s.includes(".umux") || s.includes('data-act="umux"') || s === "[data-act]" ? chip : null) };
		run({ target: chip });
		expect(branch.includes("stopImmediatePropagation") || !hid).toBe(true);
	});
	it("#268: picking a score keeps the options you picked up to visible and clickable", () => {
		/* the composer's .fill{position:absolute;width:0;pointer-events:none} is unscoped, and UmuxScale marks the
		   options up to the pick with class "fill": they shrink to 0 px wide and stack in a corner */
		const fillIsGlobal = unscoped(PAGE_CSS).has("fill");
		const umuxUsesFill = JS.includes('(i<=v?" fill":"")');
		expect(fillIsGlobal && umuxUsesFill).toBe(false);
	});
});

// keep helpers used
void KITCHEN_JS;
void PAGE_CSS;
void unscoped;
void styles;
void handler;
