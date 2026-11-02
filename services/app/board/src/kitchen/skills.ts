// Skill sets and the model policy. Skills come from the DevEx Roadmap catalog (roadmap.flisk.si/skills, built into
// ../skills.json). Each stage of an order has a hand-picked set; the ones marked haiku are short, step-by-step skills
// that a small model follows well, so workers run on Haiku at low effort and only the orchestrator thinks harder.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
};

/** Up to `n` catalog skills for an agent type, Flisk's own first. */
export function skillsFor(role: string, n = 8): CatalogSkill[] {
	const cats = ROLE_CATS[role] ?? ROLE_CATS.Code;
	return SKILLS.filter((s) => cats.includes(s.cat))
		.sort((a, b) => Number(b.source.startsWith("flisk-sh/")) - Number(a.source.startsWith("flisk-sh/")))
		.slice(0, n);
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

/** Model policy: the orchestrator (the spec step that plans the order) on Opus/medium, every worker on Haiku/low. */
export const POLICY = {
	orchestrator: { model: "opus", effort: "medium" },
	worker: { model: "haiku", effort: "low" },
} as const;
export const policyFor = (stage: Stage, override?: { model?: string; effort?: string }) => {
	const base = stage === "spec" || stage === "inbox" ? POLICY.orchestrator : POLICY.worker;
	return { model: override?.model || base.model, effort: override?.effort || base.effort };
};

// ---------- the pantry: installing skills ----------
const skillsDir = () => process.env.RUN_MY_AGENTS_SKILLS_DIR || join(homedir(), ".claude", "skills");
export const skillInstalled = (name: string) => existsSync(join(skillsDir(), name, "SKILL.md"));
const installing = new Set<string>();
export const skillState = (name: string) => (skillInstalled(name) ? "ok" : installing.has(name) ? "get" : "miss");

/**
 * Installs a catalog skill's SKILL.md from its GitHub repo into ~/.claude/skills/<name>. Only names from the
 * catalog reach here, and the name is checked again before it becomes a folder.
 */
export async function installSkill(s: Pick<CatalogSkill, "name" | "source" | "path">, get: typeof fetch = fetch): Promise<boolean> {
	if (!/^[\w.-]+$/.test(s.name) || !/^[\w.-]+\/[\w.-]+$/.test(s.source)) return false;
	if (skillInstalled(s.name) || installing.has(s.name)) return true;
	installing.add(s.name);
	try {
		const r = await get(`https://raw.githubusercontent.com/${s.source}/HEAD/${s.path}`);
		if (!r.ok) return false;
		const dir = join(skillsDir(), s.name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), await r.text());
		return true;
	} catch {
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
		.map((l) => `- ${new Date(l.at).toISOString().slice(0, 10)} · ${l.order}: ${l.reason.replace(/\s+/g, " ").slice(0, 300)}`)
		.join("\n");
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Lessons the ${container} agents learned the hard way. Read before every order so you do not repeat a mistake that got an agent replaced.\n---\n\n# ${container}: lessons\n\nEach line is an order an agent in this container failed or missed, and why. Avoid these.\n\n${body || "- No lessons yet."}\n`,
	);
	return name;
}
