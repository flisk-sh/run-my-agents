// Skill sets and the model policy. Skills come from the DevEx Roadmap catalog (roadmap.flisk.si/skills, built into
// ../skills.json). Each stage of an order has a hand-picked set; the ones marked haiku are short, step-by-step skills
// that a small model follows well, so workers run on Haiku at low effort and only the orchestrator thinks harder.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import CATALOG from "../skills.json";
import type { Stage } from "./pipeline";

export type CatalogSkill = (typeof CATALOG)[number];
export const SKILLS: CatalogSkill[] = CATALOG;

/** Which roadmap categories fit each agent type. */
export const ROLE_CATS: Record<string, string[]> = {
	Code: ["code", "debug", "test"],
	Design: ["frontend"],
	Planner: ["plan", "review"],
	Chores: ["git", "ops"],
	SEO: ["docs", "frontend"],
	Social: ["docs"],
	Video: ["frontend", "docs"],
	Calls: ["docs", "plan"],
	Calendar: ["plan"],
	Bug: ["debug", "test", "code"],
	Refactor: ["code", "test"],
	Feature: ["code", "frontend", "test"],
	Spec: ["plan"],
	Build: ["code", "debug"],
	Test: ["test"],
	Review: ["review", "security"],
};

/** Up to `n` catalog skills for an agent type, Flisk's own first. */
export function skillsFor(role: string, n = 8): CatalogSkill[] {
	const cats = ROLE_CATS[role] ?? ROLE_CATS.Code;
	return SKILLS.filter((s) => cats.includes(s.cat))
		.sort((a, b) => Number(b.source.startsWith("flisk-sh/")) - Number(a.source.startsWith("flisk-sh/")))
		.slice(0, n);
}

// "test" and "tests" are in most orders and in the name of every Terraform testing skill, so "add a mean() function
// with tests" was handed three Terraform skills. The test stage loads its own testing skills anyway.
const STOP = new Set("the and for with from that this into your have what when where which about make need want please some more them they then than just also only very like does should would could write fix add page change update create build guide style links link tasks task show seems really agents agent order orders work test tests testing function functions return returns empty list file files".split(" "));
/** Name parts that are ordinary English, not a topic: "ships" and "the gate" in order #133 pulled in ship-gate (13 points). */
const GENERIC = new Set("open close ship gate first last local live each next full auto".split(" "));
/** A browser skill fits only an order about a page or a browser: #133 got open-gstack-browser for "open", "each", "live". */
const BROWSER_PARTS = new Set(["browser", "chrome", "chromium", "puppeteer", "devtools", "playwright", "responsiveness"]);
const BROWSER_TOPIC = /\b(browser|chrome|chromium|puppeteer|playwright|page|pages|website|web site|web page|url|dom|screenshot|selector|e2e|front ?end|css|layout|click)\b/i;
/**
 * Catalog skills that fit an order's own words: a word in the skill's name counts 3, in its description 1. Only
 * words of four letters or more count, and a skill needs 3 points, so a passing mention never pulls one in.
 */
/** How many catalog skill names each name part appears in. */
const PART_USE = (() => {
	const m = new Map<string, number>();
	for (const s of SKILLS) for (const p of new Set(s.name.toLowerCase().split(/[-_.]/))) m.set(p, (m.get(p) ?? 0) + 1);
	return m;
})();
export function matchSkills(title: string, n = 3): CatalogSkill[] {
	const words = [...new Set(title.toLowerCase().match(/[a-z][a-z0-9+#.-]{3,}/g) ?? [])].filter((w) => !STOP.has(w));
	if (!words.length) return [];
	const low = title.toLowerCase();
	const every = low.match(/[a-z][a-z0-9+#.-]{3,}/g) ?? [];
	return SKILLS.map((s) => {
		// Whole words only: "work" must not match "workers", "agents" must not match "agents-md".
		const parts = s.name.toLowerCase().split(/[-_.]/);
		const what = s.what.toLowerCase();
		const same = (a: string, b: string) => a === b || a === `${b}s` || b === `${a}s`;
		const topical = parts.filter((p) => !GENERIC.has(p));
		if (parts.some((p) => BROWSER_PARTS.has(p)) && !BROWSER_TOPIC.test(low)) return { s, score: 0 };
		let hits = 0;
		const score = words.reduce((a, w) => {
			// A word many skill names share ("flisk", "test") says little about which one fits.
			const name = topical.some((p) => same(p, w)) ? ((PART_USE.get(w) ?? 0) >= 5 ? 1 : 3) : 0;
			// One long, rare name word is enough by itself ("playwright"); a short or common one ("loop", "flisk") is not.
			if (name === 3 && w.length >= 6 && (PART_USE.get(w) ?? 0) <= 4) hits += 1;
			const desc = new RegExp(`(^|[^a-z0-9])${w.replace(/[.+#]/g, "\\$&")}s?([^a-z0-9]|$)`).test(what) ? 1 : 0;
			if (name || desc) hits += 1;
			return a + name + desc;
		}, 0);
		// One word is a passing mention: "flisk" pulled in every flisk-* skill, "loop" a LangGraph one (#237). A skill
		// needs two of the title's words, or its whole name in the title.
		// The whole name as a word, and only a name of two parts or more: "pr" is inside "product", "review" is any review.
		// Two of the skill's own name parts in the title ("terraform" and "tests" for terraform-test) is a strong match
		// even when each part is common.
		const both = topical.filter((p) => every.some((w) => same(p, w))).length >= 2 && words.some((w) => topical.some((p) => same(p, w)));
		const named = (/[-_]/.test(s.name) || s.name.length >= 7) && new RegExp(`(^|[^a-z0-9-])${s.name.toLowerCase().replace(/[.+#]/g, "\\$&")}([^a-z0-9-]|$)`).test(low);
		return { s, score: named ? score + 10 : both ? score + 4 : hits >= 2 ? score : 0 };
	})
		.filter((x) => x.score >= 4)
		.sort((a, b) => b.score - a.score || Number(b.s.source.startsWith("flisk-sh/")) - Number(a.s.source.startsWith("flisk-sh/")))
		// The catalog lists some skills from more than one repo; an order needs each name once.
		.filter((x, i, all) => all.findIndex((y) => y.s.name === x.s.name) === i)
		.slice(0, n)
		.map((x) => x.s);
}

/** The process skill sets: what an agent loads for each stage of an order. */
export const STAGE_SKILLS: Record<Stage, string[]> = {
	inbox: [],
	spec: ["spec-driven-workflow", "search-first", "architecture-designer", "brainstorming"],
	build: ["focused-fix", "reproduce-bug", "code-simplifier", "commit"],
	test: ["verification-loop", "javascript-testing-patterns", "e2e-testing-patterns", "playwright"],
	review: ["find-bugs", "code-review", "sharp-edges", "security-review"],
	done: [],
};

/** Short, procedural skills a small model follows well. Everything else wants a bigger model. */
export const HAIKU_FIT = new Set([
	...STAGE_SKILLS.build,
	...STAGE_SKILLS.test,
	...STAGE_SKILLS.review,
	"debugging-strategies",
	"pr-writer",
	"dogfood",
]);
const HAIKU_CATS = new Set(["git", "docs", "test"]);
export const haikuFit = (name: string) => HAIKU_FIT.has(name) || HAIKU_CATS.has(SKILLS.find((s) => s.name === name)?.cat ?? "");

/** The skill set for one step: the stage's set, then the container's own, then its lessons. Unknown names drop out. */
export function skillset(stage: Stage, extra: string[] = []): string[] {
	return [...new Set([...STAGE_SKILLS[stage], ...extra])].filter((n) => SKILLS.some((s) => s.name === n) || n.startsWith(LESSONS_PREFIX));
}

/**
 * Model policy: the orchestrator (the spec step that plans the order) on Opus/medium, the checkers (Test and Review) on
 * Sonnet/medium, the builder on Haiku/low. Order #82's Test and Review on Haiku/low passed a doc that invented facts
 * and a garbled risk paragraph, because a checker that follows a checklist literally cannot tell when the work is wrong.
 */
export const POLICY = {
	orchestrator: { model: "opus", effort: "medium" },
	checker: { model: "sonnet", effort: "medium" },
	worker: { model: "haiku", effort: "low" },
} as const;
export const policyFor = (stage: Stage, override?: { model?: string; effort?: string }) => {
	const base = stage === "spec" || stage === "inbox" ? POLICY.orchestrator : stage === "test" || stage === "review" ? POLICY.checker : POLICY.worker;
	return { model: override?.model || base.model, effort: override?.effort || base.effort };
};

// ---------- the pantry: installing skills ----------
/** A lesson, shortened at a word, never mid-word ("…under concurr"). */
export const clip = (text: string, max = 300) => {
	const t = text.replace(/\s+/g, " ").trim();
	if (t.length <= max) return t;
	const cut = t.slice(0, max - 1);
	return `${cut.slice(0, cut.lastIndexOf(" ") > max / 2 ? cut.lastIndexOf(" ") : cut.length).replace(/[\s,;:.]+$/, "")}…`;
};

export const skillsDir = () => process.env.RUN_MY_AGENTS_SKILLS_DIR || join(homedir(), ".claude", "skills");
export const skillInstalled = (name: string) => existsSync(join(skillsDir(), name, "SKILL.md"));
/** An installed skill's text, for injecting it into a prompt; empty if it is not installed. */
export function readSkill(name: string): string {
	try {
		return readFileSync(join(skillsDir(), name, "SKILL.md"), "utf8");
	} catch {
		return "";
	}
}
const installing = new Set<string>();
/**
 * Downloads that failed, per skill: a 404 (the skill moved), no network or a rate limit left its order waiting for good
 * while every 3 s tick fetched again (#179). Each failure waits longer before the next try (30 s, 60 s, ...); after
 * GIVE_UP failures the skill is "failed" for FAILED_FOR, and orders go on without it.
 */
const fails = new Map<string, { n: number; at: number }>();
const GIVE_UP = 3;
const FAILED_FOR = 10 * 60_000;
const failed = (name: string, now = Date.now()) => {
	const f = fails.get(name);
	return !!f && f.n >= GIVE_UP && now - f.at < FAILED_FOR;
};
const waiting = (name: string, now = Date.now()) => {
	const f = fails.get(name);
	return !!f && now - f.at < 30_000 * 2 ** (f.n - 1);
};
/** For tests: forget the failed downloads. */
export const resetSkillFails = () => fails.clear();
export const skillState = (name: string) => (skillInstalled(name) ? "ok" : installing.has(name) ? "get" : failed(name) ? "failed" : "miss");

/**
 * Installs a catalog skill's SKILL.md from its GitHub repo into ~/.claude/skills/<name>. Only names from the
 * catalog reach here, and the name is checked again before it becomes a folder.
 */
export async function installSkill(s: Pick<CatalogSkill, "name" | "source" | "path">, get: typeof fetch = fetch): Promise<boolean> {
	if (!/^[\w.-]+$/.test(s.name) || !/^[\w.-]+\/[\w.-]+$/.test(s.source)) return false;
	if (skillInstalled(s.name) || installing.has(s.name)) return true;
	if (failed(s.name) || waiting(s.name)) return false;
	installing.add(s.name);
	const miss = () => fails.set(s.name, { n: (fails.get(s.name)?.n ?? 0) + 1, at: Date.now() });
	try {
		const r = await get(`https://raw.githubusercontent.com/${s.source}/HEAD/${s.path}`);
		if (!r.ok) {
			miss();
			return false;
		}
		fails.delete(s.name);
		const dir = join(skillsDir(), s.name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), await r.text());
		return true;
	} catch {
		miss();
		return false;
	} finally {
		installing.delete(s.name);
	}
}

/** Installs every catalog skill in `names` that is missing, in the background. */
export function stock(names: string[], get?: typeof fetch) {
	for (const n of names) {
		const k = SKILLS.find((s) => s.name === n);
		if (k) void installSkill(k, get);
	}
}

// ---------- lessons: a learning skill per agent container ----------
export const LESSONS_PREFIX = "rma-lessons-";
export const lessonsSkill = (slug: string) => `${LESSONS_PREFIX}${slug}`;

/** Writes the container's lessons as a skill every new agent in it reads before an order. */
export function writeLessons(slug: string, container: string, lessons: { at: number; order: string; reason: string }[]) {
	const name = lessonsSkill(slug);
	const dir = join(skillsDir(), name);
	mkdirSync(dir, { recursive: true });
	const body = lessons
		.slice(-40)
		.map((l) => `- ${new Date(l.at).toISOString().slice(0, 10)} · ${l.order}: ${clip(l.reason)}`)
		.join("\n");
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Lessons the ${container} agents learned the hard way. Read before every order so you do not repeat a mistake that got an agent replaced.\n---\n\n# ${container}: lessons\n\nEach line is an order an agent in this container failed or missed, and why. Avoid these.\n\n${body || "- No lessons yet."}\n`,
	);
	return name;
}
