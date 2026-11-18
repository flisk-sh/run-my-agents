import { describe, expect, it, spyOn } from "bun:test";
import { createApp } from "../src/index";
import * as sessions from "../src/sessions";
import { parseSession } from "../src/sessions";

const line = (o: object) => JSON.stringify(o);
const ask = (text: string) => line({ type: "user", cwd: "/repo", message: { content: text } });

describe("diffStat is computed once per distinct cwd per poll (#418)", () => {
	it("calls diffStat at most once for sessions sharing a cwd", async () => {
		const a = parseSession("a", [ask("one")], Date.now());
		const b = parseSession("b", [ask("two")], Date.now());
		const sessionsList = [a, b].filter((s) => s !== undefined);
		for (const s of sessionsList) s.edits = [];
		const spy = spyOn(sessions, "diffStat").mockResolvedValue({ add: 1, del: 0 });
		const app = createApp(() => sessionsList);
		await app.request("/api/sessions");
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});
});