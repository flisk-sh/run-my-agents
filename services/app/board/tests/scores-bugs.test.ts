// Scores bugs: each test failed on main before its fix (issue number in its name).
import { describe, expect, it } from "bun:test";
import { crewKey, flow, scoreboard } from "../src/kitchen/scores";
import type { Task } from "../src/kitchen/pipeline";

const task = (n: number, o: Partial<Task> = {}) =>
	({ id: `t${n}`, n, title: `order ${n}`, kind: "task", stage: "done", created: 0, servedAt: 3_600_000, startedAt: 0, rounds: 0, failures: [], skills: [], crew: {}, ...o }) as unknown as Task;

describe("scores", () => {
	it("#191: the Flisk agent gets one row per stage, not one per order", () => {
		const a = crewKey({ id: "flisk:order-26-build", role: "Build", name: "Build · Flisk agent" });
		const b = crewKey({ id: "flisk:order-27-build", role: "Build", name: "Build · Flisk agent" });
		expect(a.key).toBe(b.key);
		expect(crewKey({ id: "flisk:order-27-test", role: "Test", name: "Test · Flisk agent" }).key).not.toBe(a.key);
	});

	it("#191: questions are not served orders in the flow numbers", () => {
		const q = (n: number) => task(n, { kind: "question", created: 1_000_000, servedAt: 1_000_005 });
		const f = flow([task(1), q(2), q(3)]);
		expect(f.served).toBe(1);
		expect(f.leadMedian).toBe(3_600_000);
	});

	it("#191: a failed order is not a served one on the scoreboard", () => {
		const crew = { build: { id: "b1", role: "Build", name: 'You are a Build agent in the "Build · app" agent container' } };
		const b = scoreboard([task(1, { crew }), task(2, { crew, failed: true, stuck: true })]);
		expect(b.agents.find((x) => x.label === "Build · app")?.served).toBe(1);
	});
});
