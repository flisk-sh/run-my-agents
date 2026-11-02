// One JSON file per collection in the board's data folder. Writes go to a temp file and are renamed into place, so
// a crash or a second board never leaves half a file behind.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../prefs";

export class JsonStore<T> {
	constructor(private readonly name: string) {}
	private file() {
		return join(dataDir(), this.name);
	}
	read(): T[] {
		try {
			const a = JSON.parse(readFileSync(this.file(), "utf8"));
			return Array.isArray(a) ? a : [];
		} catch {
			return [];
		}
	}
	write(all: T[]): T[] {
		mkdirSync(dataDir(), { recursive: true });
		const tmp = `${this.file()}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(all, null, 2));
		renameSync(tmp, this.file());
		return all;
	}
	/** Reads, changes and writes in one step; returns what `fn` returns. */
	update<R>(fn: (all: T[]) => R): R {
		const all = this.read();
		const r = fn(all);
		this.write(all);
		return r;
	}
}
