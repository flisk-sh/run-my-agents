// A long reply used to lose most of its text before the next stage ever read it: the board kept only the last 8000
// characters of a reply, so order #133's 32,767-character spec was stored from the middle of a test file, with no
// Goal, Steps or Acceptance checks. The screen cap and the hand-off are two different things now (#136).
import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUT_MARK, handOffOf, wasShortened } from "../src/kitchen/protocol";
import { cutStages, SPEC_NOTE_MAX, spillNote, STAGE_BRIEF } from "../src/kitchen/routes";
import { KITCHEN_JS } from "../src/kitchen/view";
import { FEED_TEXT_MAX, feedText, fullReply, parseSession, readFullReply } from "../src/sessions";

let dir = "";
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rma-handoff-"));
	process.env.RUN_MY_AGENTS_DIR = dir;
});

const AT = "2026-11-09T10:00:00.000Z";
/** A Claude Code transcript: the orchestrator's order, then one assistant message per reply. */
const transcript = (replies: string[]) => [
	JSON.stringify({ type: "user", timestamp: AT, message: { content: "Order #133 spec: fix the off-by-one in range()" } }),
	...replies.map((text) => JSON.stringify({ type: "assistant", timestamp: AT, message: { model: "claude-opus-5", content: [{ type: "text", text }] } })),
];
const lastAgent = (lines: string[]) => {
	const s = parseSession("order-133-spec", lines, Date.parse(AT));
	if (!s) throw new Error("no session");
	const item = s.feed.filter((x) => x.who === "agent").at(-1);
	if (!item) throw new Error("no agent reply in the feed");
	return item.text;
};

describe("a long reply reaches the next stage whole (#136)", () => {
	it("a 32,000 character reply reaches the hand-off complete", () => {
		const spec = `## Goal\nInclude the end of the range.\n\n## Steps\n${"x".repeat(32_000)}\n\n## Assumptions\nNone.`;
		const lines = transcript([spec]);
		expect(spec.length).toBeGreaterThan(32_000);
		expect(fullReply(lines)).toBe(spec);
		const file = join(dir, "order-133-spec.jsonl");
		writeFileSync(file, lines.join("\n"));
		expect(readFullReply(file)).toBe(spec);
		expect(readFullReply(undefined)).toBe("");
		expect(readFullReply(join(dir, "gone.jsonl"))).toBe("");
	});

	it("two replies joined keep the start of the first", () => {
		const first = `## Goal\n${"a".repeat(6000)}`;
		const second = `## Steps\n1. edit src/math.ts\n${"b".repeat(6000)}`;
		const lines = transcript([first, second]);
		// On screen the two are one capped reply, but it still starts at the first one's Goal.
		const shown = lastAgent(lines);
		expect(shown.startsWith("## Goal")).toBe(true);
		expect(shown.length).toBeLessThan(first.length + second.length);
		expect(shown).toContain(CUT_MARK);
		// The hand-off is read from the transcript, so both replies arrive whole.
		expect(fullReply(lines)).toBe(`${first}\n\n${second}`);
		// feedText itself keeps the head, and said so.
		const joined = feedText("A".repeat(5000), "B".repeat(5000));
		expect(joined.cut).toBe(true);
		expect(joined.text.startsWith("A".repeat(100))).toBe(true);
	});

	it("a reply under the limit is unchanged", () => {
		expect(feedText("", "Spec complete.")).toEqual({ text: "Spec complete.", cut: false });
		expect(feedText("Goal: fix range.", "Spec complete.")).toEqual({ text: "Goal: fix range.\n\nSpec complete.", cut: false });
		const fits = "y".repeat(FEED_TEXT_MAX);
		expect(feedText("", fits)).toEqual({ text: fits, cut: false });
		const spec = "## Goal\nFix range.\n\n## Steps\n1. edit src/math.ts";
		expect(lastAgent(transcript([spec]))).toBe(spec);
		let spilled = false;
		expect(handOffOf(spec, SPEC_NOTE_MAX, () => { spilled = true; return "/nowhere"; })).toBe(spec);
		expect(spilled).toBe(false);
	});

	it("a spec over 16000 goes to a file and the note holds the summary and path", () => {
		const steps = Array.from({ length: 300 }, (_, i) => `${i + 1}. In src/math.ts, ${"s".repeat(60)}`).join("\n");
		const reply = `## Goal\nInclude the end of the range.\n\n## Acceptance checks\nAC-1: bun test tests/math.test.ts prints 0 fail.\n\n## Steps\n${steps}\n\n\`\`\`kitchen\n{"handoff": "Spec for #133: fix range in src/math.ts."}\n\`\`\``;
		let spilled = "";
		const note = handOffOf(reply, SPEC_NOTE_MAX, (full) => {
			spilled = full;
			return spillNote(133, "spec", full);
		});
		const file = join(dir, "notes", "order-133-spec.md");
		// The note starts at the start: the summary, the Goal and the Acceptance checks all survive.
		expect(note.startsWith("Summary: Spec for #133: fix range in src/math.ts.")).toBe(true);
		expect(note).toContain("## Goal");
		expect(note).toContain("## Acceptance checks");
		expect(note).toContain("## Steps");
		expect(note).toContain("1. In src/math.ts");
		expect(note.length).toBeLessThanOrEqual(SPEC_NOTE_MAX);
		// …and the rest is a file the next stage can read.
		expect(note).toContain(file);
		expect(existsSync(file)).toBe(true);
		expect(spilled.length).toBeGreaterThan(SPEC_NOTE_MAX);
		expect(readFileSync(file, "utf8")).toBe(spilled);
		expect(readFileSync(file, "utf8")).toContain("300. In src/math.ts");
		// With nowhere to put it, the note is cut in the middle, never from the start.
		const cut = handOffOf(reply, SPEC_NOTE_MAX);
		expect(cut.startsWith("Summary: Spec for #133")).toBe(true);
		expect(cut).toContain(CUT_MARK);
	});

	it("the on-screen text can stay short without shortening the hand-off", () => {
		const spec = `## Goal\n${"g".repeat(10_000)}\n\n## Steps\n1. edit src/math.ts`;
		const lines = transcript([spec]);
		const shown = lastAgent(lines);
		expect(shown.length).toBeLessThanOrEqual(FEED_TEXT_MAX + 120);
		expect(shown).toContain(CUT_MARK);
		// The same reply is handed on whole: it is well under the spec's own limit.
		expect(handOffOf(fullReply(lines), SPEC_NOTE_MAX)).toBe(spec);
		expect(wasShortened(handOffOf(fullReply(lines), SPEC_NOTE_MAX))).toBe(false);
	});

	it("the shortened warning appears only when text was really cut", () => {
		expect(wasShortened("## Goal\nFix range.\n\n## Steps\n1. edit src/math.ts")).toBe(false);
		expect(wasShortened(handOffOf("## Goal\nFix range.", 16_000))).toBe(false);
		expect(wasShortened(handOffOf(`## Goal\n${"g".repeat(20_000)}`, 16_000))).toBe(true);
		// The words alone are not a cut: a spec may talk about characters cut, and that note is whole.
		expect(wasShortened("## Goal\nStop the slice that left 24767 characters cut from order #133's spec.")).toBe(false);
		// The warning follows the note stored now: a stage whose next round fits whole loses it, and a requeue clears it.
		expect(cutStages(undefined, "spec", handOffOf(`## Goal\n${"g".repeat(20_000)}`, 16_000))).toEqual(["spec"]);
		expect(cutStages(["spec"], "build", "Changed src/math.ts.")).toEqual(["spec"]);
		expect(cutStages(["spec", "build"], "spec", "## Goal\nFix range.")).toEqual(["build"]);
		expect(cutStages(["build"], "build", "## Goal\nFix range.")).toEqual([]);
		// The order card's chip, from the board's own code: only a stage in `cut` gets a warning.
		const src = KITCHEN_JS.slice(KITCHEN_JS.indexOf("function kCut(t)"));
		const kCut = new Function("H", "t", `${src.slice(0, src.indexOf("\n"))}; return kCut(t)`) as (H: unknown, t: unknown) => unknown;
		const H = (_tag: string, _attrs: unknown, ...kids: string[]) => kids.join("");
		expect(kCut(H, { n: 133, cut: ["spec"] })).toContain("note shortened");
		expect(kCut(H, { n: 133, cut: [] })).toBe(null);
		expect(kCut(H, { n: 133 })).toBe(null);
	});

	it("the spec brief caps a spec at 150 lines and bans pasted test files", () => {
		expect(STAGE_BRIEF.spec).toContain("150 lines is the limit");
		expect(STAGE_BRIEF.spec).toContain("Describe each test case in one line");
		expect(STAGE_BRIEF.spec).toContain("never paste a complete test file");
		expect(STAGE_BRIEF.spec).not.toContain("New tests are written out in full");
	});
});
