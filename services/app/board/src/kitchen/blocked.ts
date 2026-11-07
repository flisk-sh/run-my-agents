import type { Stage, Task } from "./pipeline";

/** Who an order is waiting on: an agent (an ask answered by an earlier stage), you (a stuck order, the pass), or Ship/CI. */
export type Blocked = { kind: "agent" | "you" | "ship"; on: string; since: number; session?: string };

const NAME: Record<string, string> = { spec: "Spec", build: "Build", test: "Test", review: "Review", ship: "Ship" };
const stageName = (s: Stage | string) => NAME[s] ?? String(s);

/**
 * What an open order waits for, or undefined when it is not blocked (cooking, queued, served or failed). `since` is
 * when the wait began, so the board can show how long it has lasted (#340).
 */
export function blockedOn(t: Task): Blocked | undefined {
	if (t.stage === "done" || t.failed) return undefined;
	if (t.waitingOn) return { kind: "agent", on: `${stageName(t.waitingOn.stage)} agent: "${t.waitingOn.question.slice(0, 80)}"`, since: t.waitingOn.at, ...(t.waitingOn.session ? { session: t.waitingOn.session } : {}) };
	if (t.stuck) return { kind: "you", on: "you: look at it, then serve it or send it back", since: t.stageAt ?? t.updated };
	if (t.atPass && !t.assignee) return { kind: "you", on: "you: approve the spec at the pass", since: t.stageAt ?? t.updated };
	if (t.shipping) return { kind: "ship", on: "Ship: opening the pull request, or CI", since: t.sentAt || t.updated, ...(t.assignee ? { session: t.assignee } : {}) };
	return undefined;
}
