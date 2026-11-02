import { describe, expect, it } from "bun:test";
import { NO_CHANGES, STAGE_BRIEF } from "../src/kitchen/routes";

// #162: the nudge made a Build agent invent a version bump for a release order, which shipped as flisk#3148.
describe("a build with no changes", () => {
	it("is told never to invent a change and to FAIL when none is needed", () => {
		for (const text of [NO_CHANGES, STAGE_BRIEF.build]) {
			expect(text.toLowerCase()).toContain("never invent");
			expect(text).toContain("version bump");
			expect(text).toContain("FAIL");
		}
	});
});
