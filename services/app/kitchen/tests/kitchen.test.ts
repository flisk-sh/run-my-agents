import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in for `claude`: it prints its folder, its arguments and the prompt it was given, so the test can see
// exactly what a real turn would run. It fails when the prompt says so.
const bin = mkdtempSync(join(tmpdir(), "kitchen-bin-"));
const fake = join(bin, "claude");
writeFileSync(fake, `#!/bin/sh\nprompt=$(cat)\ncase "$prompt" in *explode*) echo "boom" >&2; exit 3;; esac\necho "cwd=$(pwd -P)"\necho "args=$*"\necho "prompt=$prompt"\n`);
chmodSync(fake, 0o755);
process.env.KITCHEN_CLAUDE_BIN = fake;
process.env.AGENT_STATE_DIR = mkdtempSync(join(tmpdir(), "kitchen-state-"));

let base = "";
let server: import("node:http").Server;
beforeAll(async () => {
	({ server } = await import("../src/index"));
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const turn = (session: string, body: object) => fetch(`${base}/turn`, { method: "POST", headers: { "content-type": "application/json", "x-session-id": session }, body: JSON.stringify(body) });

describe("kitchen agent", () => {
	it("answers a turn with the reply of your own claude, run in the order's folder", async () => {
		const work = mkdtempSync(join(tmpdir(), "kitchen-work-"));
		const r = await turn("order-26-build", { input: "Order #26 (build): fix it", cwd: work, model: "haiku", effort: "low" });
		expect(r.status).toBe(200);
		const { reply } = await r.json();
		expect(reply).toContain(`cwd=${(await import("node:fs")).realpathSync(work)}`);
		expect(reply).toContain("prompt=Order #26 (build): fix it");
		expect(reply).toContain("--permission-mode acceptEdits");
		expect(reply).toContain("--model haiku");
		expect(reply).toContain("Bash(git:*)");
		expect(reply).toMatch(/--session-id [0-9a-f-]{36}/);
	});

	it("resumes the same Claude chat on the next turn of a session, and a new chat for another session", async () => {
		const first = (await (await turn("order-27-test", { input: "one" })).json()).reply as string;
		const id = /--session-id ([0-9a-f-]{36})/.exec(first)?.[1];
		const second = (await (await turn("order-27-test", { input: "two" })).json()).reply as string;
		expect(second).toContain(`--resume ${id}`);
		const other = (await (await turn("order-28-test", { input: "x" })).json()).reply as string;
		expect(other).not.toContain(id as string);
		const sessions = await (await fetch(`${base}/sessions`)).json();
		expect(sessions.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(expect.arrayContaining(["order-27-test", "order-28-test"]));
	});

	it("says when a turn fails instead of hanging, and refuses a turn with no session or no input", async () => {
		const bad = await turn("order-29-build", { input: "please explode" });
		expect(bad.status).toBe(502);
		expect((await bad.json()).error).toContain("claude exited with 3");
		expect((await turn("bad id!", { input: "x" })).status).toBe(400);
		expect((await turn("order-30-build", {})).status).toBe(400);
		expect((await fetch(`${base}/health`)).status).toBe(200);
		expect((await fetch(`${base}/ready`)).status).toBe(200);
	});
});
