// What moves between kitchen stages. Chat text is not a message bus: a step's agent ends its reply with one fenced
// `kitchen` JSON block (its record), and the orchestrator reads that block, not phrases it hopes to find in prose.
//
// ```kitchen
// {"ask": {"to": "spec", "question": "Does the range include b?"}}
// ```
// ```kitchen
// {"verdict": "FAIL", "evidence": "bun test: 2 failed (range.test.ts)"}
// ```

export type AskStage = "spec" | "build" | "test" | "review";
/** The belt's order: a stage can only ask a stage that ran before it on this order. */
export const ASK_ORDER: AskStage[] = ["spec", "build", "test", "review"];

/** One step's structured result. Every field is optional; anything else in the block is ignored. */
export type StageRecord = {
	ask?: { to: AskStage; question: string };
	verdict?: "PASS" | "FAIL";
	evidence?: string;
	handoff?: string;
	/** The step cannot go on: a missing decision, a disagreement with the spec, a limit. The order stops with this. */
	blocked?: string;
};

const BLOCK = /```kitchen[^\S\n]*\n([\s\S]*?)\n?```/g;

/** The last well-formed `kitchen` block in a reply, or undefined when there is none. Ignores blocks with none of ask, verdict, handoff or blocked. */
export function recordIn(text: string): StageRecord | undefined {
	for (const m of [...String(text ?? "").matchAll(BLOCK)].reverse()) {
		let raw: unknown;
		try {
			raw = JSON.parse(m[1]);
		} catch {
			continue;
		}
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const o = raw as Record<string, unknown>;
		const r: StageRecord = {};
		const a = o.ask as Record<string, unknown> | undefined;
		const to = typeof a?.to === "string" ? a.to.toLowerCase() : "";
		if (a && ASK_ORDER.includes(to as AskStage) && typeof a.question === "string" && a.question.trim()) r.ask = { to: to as AskStage, question: a.question.trim().slice(0, 1000) };
		const v = typeof o.verdict === "string" ? o.verdict.toUpperCase() : typeof o.pass === "boolean" ? (o.pass ? "PASS" : "FAIL") : "";
		if ((v === "PASS" || v === "FAIL") && !r.ask) r.verdict = v;
		if (typeof o.evidence === "string" && o.evidence.trim()) r.evidence = o.evidence.trim().slice(0, 2000);
		if (typeof o.handoff === "string" && o.handoff.trim()) r.handoff = o.handoff.trim();
		if (typeof o.blocked === "string" && o.blocked.trim()) r.blocked = o.blocked.trim().slice(0, 500);
		// Ignore blocks that have none of ask, verdict, handoff or blocked
		if (r.ask || r.verdict || r.handoff || r.blocked) return r;
	}
	return undefined;
}

/** The reply with its `kitchen` blocks removed: what a person or the next stage reads. */
export const withoutRecord = (text: string) => String(text ?? "").replace(BLOCK, "").trim();

/**
 * The verdict a test or review agent gave. Its record decides; with no record, only a last line that starts with PASS
 * or FAIL counts. A monologue that says both ("FAIL … corrected verdict: PASS") is no verdict, so the agent is asked
 * to give one instead of the last word winning.
 */
export function verdictIn(text: string): boolean | undefined {
	const r = recordIn(text);
	if (r?.verdict) return r.verdict === "PASS";
	const lines = withoutRecord(text)
		.split("\n")
		.map((l) => l.replace(/[*_`>#]/g, "").trim())
		.filter(Boolean);
	// A verdict is a line that starts with PASS or FAIL ("Verdict: PASS" too). The word inside a sentence, such as a
	// quoted acceptance check ("FAIL if b is missing"), is not one: it turned clear PASSes into FAILs (#186).
	const lead = (l: string) => /^(?:(?:verdict|result)\s*:\s*)?(PASS|FAIL)\b/i.exec(l)?.[1]?.toUpperCase();
	const last = lines.at(-1) ?? "";
	const m = lead(last);
	if (!m || (/\bPASS\b/.test(last) && /\bFAIL\b/.test(last))) return undefined;
	const said = new Set(lines.map(lead).filter(Boolean));
	return said.size > 1 ? undefined : m === "PASS";
}

/** What every shortened text says, so a stored note can be told from a whole one. */
export const CUT_MARK = "characters cut";
/**
 * True when this text is a shortened copy of what the agent said, so the board can warn about it. It looks for the
 * whole marker a cut leaves ("[… 1234 characters cut"), not the words alone: a reply may talk about cut characters.
 */
export const wasShortened = (text: string) => new RegExp(`\\[… \\d+ ${CUT_MARK}`).test(String(text ?? ""));

/** A long text cut in the middle, so the start (a spec's goal and checks) and the end (its result) both survive. */
export function clip(text: string, max = 6000): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.7);
	return `${text.slice(0, head)}\n\n[… ${text.length - max} ${CUT_MARK} …]\n\n${text.slice(-(max - head))}`;
}

/**
 * Where a hand-off too long for its limit is kept whole: it is given the whole text and returns the path it wrote,
 * or undefined when it could not write one.
 */
export type Spill = (full: string) => string | undefined;

/**
 * What a step hands the next stages: its reply without the record, head kept. A record's "handoff" is a summary, not
 * the spec: when the reply holds more than the summary, the reply is handed on with the summary on top. Handing on
 * only the summary gave Build one paragraph instead of the Spec agent's 80-line spec (order #88).
 *
 * Too long for `max` and `spill` can keep it: the whole text goes to that file and the hand-off is its start (the
 * summary, Goal, Steps and Acceptance checks) plus the path to the rest. The start is never dropped: order #133's
 * spec was handed on from the middle of a test file, with no Goal, Steps or Acceptance checks.
 */
export function handOffOf(text: string, max = 6000, spill?: Spill): string {
	const r = recordIn(text);
	const prose = withoutRecord(text);
	const sum = r?.handoff ?? "";
	const body = !sum ? prose : prose.length <= sum.length ? sum : prose.includes(sum) ? prose : `Summary: ${sum}\n\n${prose}`;
	const verdict = r?.verdict ? `\n\nVerdict: ${r.verdict}${r.evidence ? `: ${r.evidence}` : ""}` : "";
	if (body.length <= max) return body + verdict;
	const path = spill?.(body + verdict);
	if (!path) return clip(body, max) + verdict;
	const note = (n: number) => `\n\n[… ${n} ${CUT_MARK}. The whole text of this step is in ${path}: read that file before you start …]`;
	const head = Math.max(0, max - note(body.length).length);
	return body.slice(0, head) + note(body.length - head) + verdict;
}

/**
 * Can a step at `from` ask the agent of stage `to` on this order? Only a stage that already ran and left a record:
 * Test has not run the checks while Build is still building, so its answer would be a guess.
 */
export function canAsk(from: string, to: AskStage, notes: Partial<Record<string, string>> | undefined): boolean {
	const i = ASK_ORDER.indexOf(from as AskStage);
	return i > 0 && ASK_ORDER.indexOf(to) < i && Boolean(notes?.[to]);
}

/** The only input of an asked stage's answer turn: its own record, not the asker's chat or its own session. */
export function askInput(n: number, title: string, asker: string, to: string, record: string, question: string): string {
	return `Order #${n}: ${title}\n\nYou answer for the ${to} stage of this order. Its record:\n${record}\n\nQuestion from the ${asker} agent: ${question}\n\nAnswer only from this record, in a few lines. If the record does not answer it, say so in one line starting with "Not in the record". Do not change any files.`;
}

/** What a kitchen message is, so the agent reading it does not have to guess from the prose. */
export type MessageType = "order" | "question" | "answer" | "policy" | "nudge";
export type Envelope = {
	/** Who is speaking: "Orchestrator", or a stage's agent ("Spec") when it relays that stage's answer. */
	from: string;
	/** The stage agent it is for. */
	to: string;
	type: MessageType;
	/** The order it is about; null for a message to an agent that holds no order. */
	order: number | null;
	stage: string;
	/** The reply shape the orchestrator reads: a stage record, a verdict record, or nothing. */
	expects: "record" | "verdict" | "answer" | "pr" | "none";
	/** How the content was made, when not by `from` itself (an answer from a fresh turn on a stage's record). */
	via?: string;
	/** Where the work is, as data: the worktree, the commit it started from, the round, and which stage records the message carries. */
	context?: { worktree?: string; base?: string; round?: number; records?: string[] };
};

/**
 * Every kitchen message ends with one `kitchen-message` block: who sends it, to whom, what it is and what reply it
 * wants. The prose above it is for the model; the block is the part a program (the board, the next agent) can trust.
 */
export const envelope = (body: string, e: Envelope) => `${body}\n\n\`\`\`kitchen-message\n${JSON.stringify({ v: 1, ...e })}\n\`\`\``;

/** The envelope at the end of a kitchen message, or undefined for a message a person wrote. */
export function envelopeIn(text: string): (Envelope & { v: number }) | undefined {
	const m = [...String(text ?? "").matchAll(/```kitchen-message\n([\s\S]*?)\n```/g)].at(-1);
	try {
		const e = m ? JSON.parse(m[1]) : undefined;
		return e && typeof e === "object" && typeof e.type === "string" && typeof e.from === "string" ? e : undefined;
	} catch {
		return undefined;
	}
}
