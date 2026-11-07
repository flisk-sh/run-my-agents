// "Blocked on" column (#340): what each kind of wait shows, and when an order leaves the column.
import { describe, expect, it } from "bun:test";
import { blockedOn } from "../src/kitchen/blocked";
import type { Task } from "../src/kitchen/pipeline";
import { KITCHEN_JS } from "../src/kitchen/view";

const t = (o: Partial<Task> = {}) => ({ id: "t1", n: 1, title: "x", stage: "build", created: 1000, updated: 2000, stageAt: 3000, assignee: "", sentAt: 0, skills: [], ...o }) as unknown as Task;

describe("blocked on", () => {
	it("an order waiting on another agent names the agent, the question, the chat and how long", () => {
		const b = blockedOn(t({ assignee: "p1", waitingOn: { id: "a", stage: "spec", question: "which file?", at: 5000, session: "s-spec" } }));
		expect(b).toMatchObject({ kind: "agent", since: 5000, session: "s-spec" });
		expect(b?.on).toContain("Spec agent");
		expect(b?.on).toContain("which file?");
	});

	it("a stuck order and a spec at the pass wait on you", () => {
		expect(blockedOn(t({ stuck: true }))).toMatchObject({ kind: "you", since: 3000 });
		expect(blockedOn(t({ stage: "spec", atPass: true }))).toMatchObject({ kind: "you" });
	});

	it("a shipping order waits on Ship or CI", () => {
		expect(blockedOn(t({ shipping: true, assignee: "ship-1", sentAt: 7000 }))).toMatchObject({ kind: "ship", since: 7000, session: "ship-1" });
	});

	it("an order that is cooking, queued, served or failed is not blocked, and leaves the column once unblocked", () => {
		expect(blockedOn(t({ assignee: "p1" }))).toBeUndefined();
		expect(blockedOn(t())).toBeUndefined();
		expect(blockedOn(t({ stage: "done", stuck: true }))).toBeUndefined();
		expect(blockedOn(t({ failed: true, stuck: true }))).toBeUndefined();
		expect(blockedOn(t({ stuck: true }))).toBeDefined();
		expect(blockedOn(t({ stuck: false }))).toBeUndefined();
	});

	it("the Lanes tab draws the column and a click opens the chat it waits on", () => {
		expect(KITCHEN_JS).toContain("function kBlocked()");
		expect(KITCHEN_JS).toContain("Blocked on");
		expect(KITCHEN_JS).toContain("[data-kblk]");
	});
});
