import { test } from "node:test";
import { strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const swiftFile = readFileSync(join(__dirname, "../mac/RunMyAgents.swift"), "utf8");

test("detects a missing package", () => {
	strictEqual(swiftFile.includes("Cannot find package"), true);
});

test("runs bun install and retries once", () => {
	strictEqual(swiftFile.includes('["bun", "install"]'), true);
	strictEqual(swiftFile.includes("ensureServer(repaired: true)"), true);
});

test("shows the log on the error page", () => {
	strictEqual(swiftFile.includes("func logTail("), true);
	strictEqual(swiftFile.includes('tell("Board server not running"'), true);
});
