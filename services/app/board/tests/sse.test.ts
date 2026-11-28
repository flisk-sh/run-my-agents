import { describe, expect, it } from "bun:test";
import { createApp } from "../src/index";
import { PAGE } from "../src/page";

describe("board SSE (/api/events)", () => {
	it("streams initial sessions payload as text/event-stream", async () => {
		const app = createApp(() => []);
		const ac = new AbortController();
		const res = await app.request("/api/events", { signal: ac.signal });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(res.headers.get("cache-control")).toBe("no-cache");

		const reader = res.body!.getReader();
		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);
		expect(text).toStartWith("data: ");
		const json = JSON.parse(text.slice(6).trim());
		expect(Array.isArray(json.sessions)).toBe(true);
		expect(Array.isArray(json.clashes)).toBe(true);
		expect(Array.isArray(json.order)).toBe(true);
		expect(typeof json.build).toBe("string");

		ac.abort();
		await reader.cancel().catch(() => {});
	});

	it("page connects to EventSource with 5s polling fallback", () => {
		expect(PAGE).toContain('new EventSource("api/events")');
		expect(PAGE).toContain("setInterval(load,5000)");
		expect(PAGE).not.toContain("setInterval(load,3000)");
	});
});
