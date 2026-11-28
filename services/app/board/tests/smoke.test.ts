import { describe, expect, it } from "bun:test";
import { chromium } from "playwright";
import { createApp } from "../src/index";
import { parseSession } from "../src/sessions";

const line = (o: object) => JSON.stringify(o);
const now = Date.parse("2026-11-01T12:00:00Z");
const ask = (text: string) => line({ type: "user", cwd: "/repo", message: { content: text } });
const edit = (file: string, ts = "2026-11-01T11:58:00Z") =>
	line({
		type: "assistant",
		cwd: "/repo",
		gitBranch: "main",
		timestamp: ts,
		message: { content: [{ type: "text", text: "Fixing it." }, { type: "tool_use", name: "Edit", input: { file_path: file } }] },
	});

describe("board smoke", () => {
	it("opens the board on fixture transcripts, clicks a session, sends, queues, and clicks Send now", async () => {
		const s1 = parseSession("s1", [ask("first fixture"), edit("/repo/a.ts")], now);
		const s2 = parseSession("s2", [ask("second fixture"), edit("/repo/b.ts")], now);
		const sessions = [s1, s2].filter((s): s is NonNullable<typeof s> => s !== undefined);
		const sent: Array<{ id: string; text: string }> = [];

		const app = createApp(
			() => sessions,
			async (s, text) => {
				sent.push({ id: s.id, text });
				await new Promise(() => {});
			},
		);

		const server = Bun.serve({ port: 0, fetch: app.fetch });
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}/`);

			// Click the second fixture session
			const target = page.locator('[data-sel="s2"]');
			await target.waitFor();
			await target.click();
			await page.waitForSelector('[data-sel="s2"].sel');

			// Send first message
			const msg = page.locator("#msg");
			const sendBtn = page.locator(".send");
			await msg.fill("first message");
			await sendBtn.click();
			await page.waitForFunction(() => document.querySelector(".send")?.textContent === "Queue");
			expect(sent).toEqual([{ id: "s2", text: "first message" }]);

			// Queue second message while first is in flight
			await msg.fill("queued message");
			await sendBtn.click();
			const sendNowBtn = page.locator("[data-qnow]");
			await sendNowBtn.waitFor();
			expect(await page.locator("#queue").textContent()).toContain("queued message");

			// Click Send now
			await sendNowBtn.click();
			await page.waitForFunction(() => !document.querySelector("[data-qnow]"));
			expect(sent).toEqual([
				{ id: "s2", text: "first message" },
				{ id: "s2", text: "queued message" },
			]);
		} finally {
			await browser.close();
			server.stop(true);
		}
	});
});
