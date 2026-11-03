// Where attached files are kept, and how an agent is told about them. A chat's files go in uploads/<session>/.
// Before a session or an order exists there is no id yet, so the New session dialog uses the "new" bucket and the
// Kitchen's new-order box the "order" bucket. Order files live under kitchen-home, the folder every kitchen agent
// may already read (`--add-dir`, see kitchenFlags), so Spec, Build, Test and Review can all open them.
import { statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { dataDir } from "./prefs";

export const UPLOAD_BUCKETS = ["new", "order"] as const;
export const isBucket = (id: string) => (UPLOAD_BUCKETS as readonly string[]).includes(id);

export function uploadDir(id: string): string {
	if (id === "order") return join(dataDir(), "kitchen-home", "uploads");
	return join(dataDir(), "uploads", id === "new" ? "_new" : id);
}

/** The files in the list this board saved in `dir`, however the request names them; at most 10. */
export function ownFiles(files: unknown, dir: string): string[] {
	return (Array.isArray(files) ? files : [])
		.slice(0, 10)
		.map(String)
		.filter((f) => {
			const p = resolve(f);
			try {
				return p.startsWith(dir + sep) && statSync(p).isFile();
			} catch {
				return false;
			}
		});
}

export const attachedBlock = (files: string[]) =>
	files.length ? `\n\nAttached files (saved on this computer, read them with your tools):\n${files.map((f) => `- ${f}`).join("\n")}` : "";
