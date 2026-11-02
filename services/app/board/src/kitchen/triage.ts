// Intake triage on the Zachman Framework's six questions. Every new order is sorted before it reaches the kitchen:
// a question gets one short answer and is served at once; a task gets a Zachman card (What, How, Where, Who, When,
// Why) that travels with it and goes into every agent's instructions. Rules only, no model call, so it is instant
// and the same order is always sorted the same way.

export type Kind = "question" | "task";
export type Lane = "fast" | "full";
export type Zachman = { what: string; how: string; where: string; who: string; when: string; why: string };

/** Words that ask for work on code or files. An order with one is a task even when it ends with "?". */
const WORK = /\b(add|build|fix|make|create|implement|write|refactor|remove|delete|rename|update|upgrade|migrate|deploy|test|review|debug|change|move|support|improve|optimi[sz]e|ship|merge|release|document|install|configure|set ?up|bump|port|convert|replace|split|clean)\b/i;
/** How questions open, in English. */
const ASKS = /^(what|why|how|who|when|where|which|is|are|can|could|does|do|did|should|will|would|was|were|explain|tell me)\b/i;
/** Plain arithmetic like "2+2 =?". */
const MATH = /^[\d\s+\-*/^().,=x×÷%?]+$/i;

export function kindOf(title: string): Kind {
	const t = title.trim();
	if (MATH.test(t)) return "question";
	if (WORK.test(t)) return "task";
	if (t.endsWith("?") || ASKS.test(t)) return "question";
	// Short greetings and chat with no work in them.
	if (t.split(/\s+/).length <= 4) return "question";
	return "task";
}

/** The "why" of an order: what follows "so that", "because" or "to", when the order says. */
function reason(title: string): string {
	const m = /\b(?:so that|so|because|in order to)\b\s+(.+)$/i.exec(title);
	return m ? m[1].trim().replace(/[.!]+$/, "") : "";
}

const PRIORITY_WHEN: Record<string, string> = { P0: "Now, before anything else", P1: "Next in line", P2: "When the belt is free" };

/** Fills the Zachman card for an order from its words and where it runs. */
export function zachman(o: { title: string; cwd: string; priority: string; route: string; skills: string[]; kind: Kind; lane?: Lane }): Zachman {
	const folder = o.cwd ? o.cwd.split("/").filter(Boolean).pop() ?? o.cwd : "any folder";
	const what = o.title.replace(/\b(?:so that|so|because|in order to)\b.+$/i, "").trim() || o.title;
	if (o.kind === "question")
		return { what: "An answer", how: "One short reply, no code", where: folder, who: "Front desk (any idle agent)", when: PRIORITY_WHEN[o.priority] ?? "Next in line", why: reason(o.title) || "You asked" };
	return {
		what,
		how: `${o.lane === "fast" ? "fast lane: build → test → pull request → review" : "spec → build → test → pull request → review"}${o.skills.length ? `, with /${o.skills.slice(0, 3).join(", /")}` : ""}`,
		where: folder,
		who: `${o.route} agent (orchestrator plans on Opus, workers build on Haiku)`,
		when: PRIORITY_WHEN[o.priority] ?? "Next in line",
		why: reason(o.title) || "Inferred by the Spec agent",
	};
}

/** The card as a few lines for an agent's instructions. */
export const zachmanLines = (z: Zachman) =>
	`Zachman card:\n- What: ${z.what}\n- How: ${z.how}\n- Where: ${z.where}\n- Who: ${z.who}\n- When: ${z.when}\n- Why: ${z.why}`;

// Dates and phone numbers are digits joined by "-" or "/", so the evaluator would read them as subtraction or
// division and answer "2026-11-02" with 2013. They are never arithmetic, so they never reach it.
const NOT_MATH = /^(?:\d{1,4}([-/])\d{1,2}\1\d{1,4}|\d{3}-\d{4}|1-\d{3}-\d{3}-\d{4})$/;

const mathCache = new Map<string, ((...args: unknown[]) => number) | null>();

/**
 * Answers plain arithmetic on the spot ("2+2 =?" is 4), so it never waits for an agent. Only digits, operators,
 * dots and brackets reach the evaluator, so nothing else can run.
 */
export function quickMath(title: string): string | undefined {
	const expr = title
		.trim()
		.replace(/\s*=\s*\??\s*$/, "")
		.replace(/\?+\s*$/, "")
		.replace(/[x×]/gi, "*")
		.replace(/÷/g, "/")
		.replace(/\^/g, "**")
		.replace(/,/g, ".")
		.trim();
	if (!expr || !/^[\d\s+\-*/().%]+$/.test(expr) || !/\d/.test(expr) || !/[+\-*/%]/.test(expr)) return undefined;
	if (NOT_MATH.test(expr)) return undefined;
	try {
		let fn = mathCache.get(expr);
		if (fn === undefined) {
			try {
				fn = Function(`"use strict"; return (${expr});`) as ((...args: unknown[]) => number);
				if (mathCache.size > 500) mathCache.clear();
				mathCache.set(expr, fn);
			} catch {
				mathCache.set(expr, null);
				return undefined;
			}
		}
		if (fn === null) return undefined;
		const v = fn() as unknown;
		if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
		return String(Number.isInteger(v) ? v : Number(v.toPrecision(12)));
	} catch {
		return undefined;
	}
}

/** Small, clear changes that need no plan and no separate review. */
const SMALL = /\b(typo|rename|bump|spelling|comment|wording|lint|format|copy ?edit|update the (?:readme|docs?|version)|fix the (?:link|import|path))\b/i;
const BIG = /\b(refactor|migrate|architecture|redesign|rewrite|new (?:service|feature|page|app)|integrate|auth|database|schema)\b/i;

/**
 * The fast lane: a short, clear task skips the spec step (and the pass), so it goes build → test → pull request →
 * review. Anything big or long keeps the full kitchen.
 */
export function laneOf(title: string): Lane {
	const words = title.trim().split(/\s+/).length;
	if (BIG.test(title)) return "full";
	if (SMALL.test(title) && words <= 14) return "fast";
	return words <= 6 ? "fast" : "full";
}

/** Questions that need live information, so the front desk gets web search for them. */
const LIVE = /\b(weather|forecast|temperature|news|today|tonight|tomorrow|yesterday|latest|current(?:ly)?|right now|this (?:week|month|year)|price|cost|stock|exchange rate|score|who won|release(?:d)? date|open now|traffic|time in)\b/i;
export const needsWeb = (title: string) => LIVE.test(title);
