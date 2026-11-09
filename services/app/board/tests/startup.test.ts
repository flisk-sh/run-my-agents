import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("startup", () => {
	it("a board with no node_modules exits non-zero with the text the app looks for", () => {
		const base = mkdtempSync(join(tmpdir(), "rma-startup-"));
		try {
			const depDir = join(base, "dep");
			const appDir = join(base, "app");

			mkdirSync(depDir);
			mkdirSync(appDir);

			writeFileSync(
				join(depDir, "package.json"),
				JSON.stringify({
					name: "depx",
					version: "1.0.0",
					main: "index.js",
					type: "module",
				})
			);

			writeFileSync(
				join(depDir, "index.js"),
				'export const hi = "ok";'
			);

			writeFileSync(
				join(appDir, "package.json"),
				JSON.stringify({
					name: "appx",
					private: true,
					type: "module",
					dependencies: {
						depx: "file:../dep",
					},
				})
			);

			mkdirSync(join(appDir, "src"));
			writeFileSync(
				join(appDir, "src", "index.ts"),
				'import { hi } from "depx"; console.log(hi);'
			);

			const result = Bun.spawnSync(["bun", "--no-install", "src/index.ts"], {
				cwd: appDir,
				stderr: "pipe",
			});

			expect(result.exitCode).toBe(1);
			expect(new TextDecoder().decode(result.stderr)).toContain("Cannot find package");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("bun install repairs it and the next start works", () => {
		const base = mkdtempSync(join(tmpdir(), "rma-startup-"));
		try {
			const depDir = join(base, "dep");
			const appDir = join(base, "app");

			mkdirSync(depDir);
			mkdirSync(appDir);

			writeFileSync(
				join(depDir, "package.json"),
				JSON.stringify({
					name: "depx",
					version: "1.0.0",
					main: "index.js",
					type: "module",
				})
			);

			writeFileSync(
				join(depDir, "index.js"),
				'export const hi = "ok";'
			);

			writeFileSync(
				join(appDir, "package.json"),
				JSON.stringify({
					name: "appx",
					private: true,
					type: "module",
					dependencies: {
						depx: "file:../dep",
					},
				})
			);

			mkdirSync(join(appDir, "src"));
			writeFileSync(
				join(appDir, "src", "index.ts"),
				'import { hi } from "depx"; console.log(hi);'
			);

			const install = Bun.spawnSync(["bun", "install"], { cwd: appDir });
			expect(install.exitCode).toBe(0);

			const run = Bun.spawnSync(["bun", "src/index.ts"], {
				cwd: appDir,
				stdout: "pipe",
			});

			expect(run.exitCode).toBe(0);
			expect(new TextDecoder().decode(run.stdout).trim()).toBe("ok");
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});
