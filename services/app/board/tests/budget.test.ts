// Every byte of a stage brief is read on every step of every order. Like T3 Code's agentContextBudget.json, the sizes
// are committed: a change that grows a brief fails here until budget.json is updated on purpose, in the same PR.
import { expect, it } from "bun:test";
import { ADDRESS, MAX_STEP_SKILLS, STAGE_BRIEF } from "../src/kitchen/routes";
import budget from "./budget.json";

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

it("stage briefs stay within the committed budget", () => {
	expect({
		address: bytes(ADDRESS),
		spec: bytes(STAGE_BRIEF.spec),
		build: bytes(STAGE_BRIEF.build),
		test: bytes(STAGE_BRIEF.test),
		review: bytes(STAGE_BRIEF.review),
		maxStepSkills: MAX_STEP_SKILLS,
	}).toEqual(budget);
});
