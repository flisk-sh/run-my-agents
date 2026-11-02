// A face for each kind of agent: a body shape, a color, eyes and where they look. Drawn as inline SVG on the
// server, so the page still needs no JavaScript.

type Shape = "circle" | "square" | "pill" | "tall" | "blob";
type Eyes =
	| "dots"
	| "wide"
	| "sleepy"
	| "visor"
	| "ovals"
	| "cyclops"
	| "happy"
	| "bars"
	| "squint";
type Extra = "bug" | "refactor" | "feature";
const INK = "#0b0b10";
/** Props for some roles, drawn on top of the body and eyes in the same 64x64 box. */
export const EXTRAS: Record<Extra, string> = {
	// antenna feelers and a magnifier over the right eye
	bug: `<path d="M24 9q-3-6-9-6M40 9q3-6 9-6" fill="none" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/><circle cx="15" cy="3.5" r="2.5" fill="${INK}"/><circle cx="49" cy="3.5" r="2.5" fill="${INK}"/><circle cx="42" cy="30" r="10" fill="rgba(255,255,255,.18)" stroke="${INK}" stroke-width="3"/><path d="M49 37l8 8" stroke="${INK}" stroke-width="4.5" stroke-linecap="round"/><path d="M14 52l-5 4M20 56l-3 5M50 52l5 4M44 56l3 5" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>`,
	// two stacked blocks mid-swap, and a wrench for an antenna
	refactor: `<path d="M5 41h54v6a12 12 0 0 1-12 12H17A12 12 0 0 1 5 47z" fill="rgba(0,0,0,.22)"/><path d="M5 41h54" stroke="${INK}" stroke-width="2" stroke-dasharray="4 3"/><path d="M24 50h16m-4-3 4 3-4 3" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 6V1" stroke="${INK}" stroke-width="3" stroke-linecap="round"/><path d="M27.5 1.5a4.5 4.5 0 1 0 9 0" fill="none" stroke="${INK}" stroke-width="2.5" stroke-linecap="round"/>`,
	// a spark above the head and a plus on the chest
	feature: `<path d="M32 0l2 4.5 4.5 2-4.5 2-2 4.5-2-4.5-4.5-2 4.5-2z" fill="#fde68a" stroke="${INK}" stroke-width="1.2"/><path d="M32 40v8M28 44h8" stroke="#fff" stroke-width="3" stroke-linecap="round"/>`,
};

type Look = "left" | "right" | "up" | "down" | "center";

export interface Agent {
	role: string;
	color: string;
	shape: Shape;
	eyes: Eyes;
	look: Look;
	/** A prop drawn over the face: a bug hunter's magnifier, a refactorer's wrench, a feature's spark. */
	extra?: Extra;
	/** What the agent is doing, for the team board. */
	task: string;
	file: string;
	state: "editing" | "waiting" | "done";
}

export const AGENTS: Agent[] = [
	{
		role: "Planner",
		color: "#22c55e",
		shape: "square",
		eyes: "dots",
		look: "right",
		task: "Split the launch into tasks",
		file: "PLAN.md",
		state: "done",
	},
	{
		role: "Code",
		color: "#38bdf8",
		shape: "circle",
		eyes: "visor",
		look: "left",
		task: "Fix the login bug",
		file: "src/api.ts",
		state: "editing",
	},
	{
		role: "Design",
		color: "#a78bfa",
		shape: "blob",
		eyes: "ovals",
		look: "up",
		task: "New pricing page",
		file: "src/pages.ts",
		state: "editing",
	},
	{
		role: "Chores",
		color: "#a3a3a3",
		shape: "tall",
		eyes: "sleepy",
		look: "down",
		task: "Bump dependencies",
		file: "package.json",
		state: "editing",
	},
	{
		role: "Video",
		color: "#f43f5e",
		shape: "pill",
		eyes: "cyclops",
		look: "right",
		task: "Cut the 20s demo",
		file: "video/film.json",
		state: "waiting",
	},
	{
		role: "SEO",
		color: "#f59e0b",
		shape: "square",
		eyes: "wide",
		look: "center",
		task: "Fix titles and sitemap",
		file: "src/seo.ts",
		state: "editing",
	},
	{
		role: "Social",
		color: "#f472b6",
		shape: "circle",
		eyes: "happy",
		look: "center",
		task: "Draft the launch post",
		file: "LAUNCH.md",
		state: "done",
	},
	{
		role: "Calls",
		color: "#2dd4bf",
		shape: "pill",
		eyes: "bars",
		look: "left",
		task: "Summarize the user call",
		file: "notes/call.md",
		state: "editing",
	},
	{
		role: "Calendar",
		color: "#fb923c",
		shape: "tall",
		eyes: "squint",
		look: "up",
		task: "Plan launch week",
		file: "notes/week.md",
		state: "waiting",
	},
	{
		role: "Bug",
		color: "#f87171",
		shape: "blob",
		eyes: "squint",
		look: "down",
		extra: "bug",
		task: "Find why checkout crashes",
		file: "src/cart.ts",
		state: "editing",
	},
	{
		role: "Refactor",
		color: "#f59e0b",
		shape: "square",
		eyes: "sleepy",
		look: "left",
		extra: "refactor",
		task: "Split the payments module",
		file: "src/payments/",
		state: "waiting",
	},
	{
		role: "Feature",
		color: "#6ee7a0",
		shape: "pill",
		eyes: "wide",
		look: "up",
		extra: "feature",
		task: "Add dark mode",
		file: "src/theme.ts",
		state: "done",
	},
];

const OFFSET: Record<Look, [number, number]> = {
	left: [-4, 0],
	right: [4, 0],
	up: [0, -4],
	down: [0, 4],
	center: [0, 0],
};

function body(shape: Shape, color: string): string {
	switch (shape) {
		case "circle":
			return `<circle cx="32" cy="32" r="28" fill="${color}"/>`;
		case "square":
			return `<rect x="5" y="5" width="54" height="54" rx="12" fill="${color}"/>`;
		case "pill":
			return `<rect x="2" y="12" width="60" height="40" rx="20" fill="${color}"/>`;
		case "tall":
			return `<rect x="12" y="2" width="40" height="60" rx="10" fill="${color}"/>`;
		case "blob":
			return `<path d="M32 4c14 0 28 8 27 26s-9 30-27 30S4 50 5 30 18 4 32 4z" fill="${color}"/>`;
	}
}

function eyes(kind: Eyes, look: Look): string {
	const [dx, dy] = OFFSET[look];
	const ink = "#0b0b10";
	const white = "#fff";
	const pair = (draw: (x: number) => string) => draw(22) + draw(42);
	switch (kind) {
		case "dots":
			return pair(
				(x) =>
					`<circle cx="${x + dx / 2}" cy="${30 + dy / 2}" r="4" fill="${ink}"/>`,
			);
		case "wide":
			return pair(
				(x) =>
					`<circle cx="${x}" cy="30" r="8" fill="${white}"/><circle cx="${x + dx}" cy="${30 + dy}" r="3.5" fill="${ink}"/>`,
			);
		case "ovals":
			return pair(
				(x) =>
					`<ellipse cx="${x}" cy="30" rx="6" ry="9" fill="${white}"/><ellipse cx="${x + dx * 0.7}" cy="${30 + dy}" rx="3" ry="4.5" fill="${ink}"/>`,
			);
		case "sleepy":
			return pair(
				(x) =>
					`<path d="M${x - 7} 30h14v3a7 5 0 0 1-14 0z" fill="${white}"/><circle cx="${x + dx * 0.6}" cy="33" r="2.5" fill="${ink}"/><path d="M${x - 8} 30h16" stroke="${ink}" stroke-width="2.5" stroke-linecap="round"/>`,
			);
		case "visor":
			return `<rect x="12" y="22" width="40" height="16" rx="8" fill="${ink}"/>${pair(
				(x) =>
					`<rect x="${x - 4 + dx}" y="${27 + dy / 2}" width="8" height="6" rx="2" fill="#7dd3fc"/>`,
			)}`;
		case "cyclops":
			return `<circle cx="32" cy="30" r="12" fill="${white}"/><circle cx="${32 + dx * 1.3}" cy="${30 + dy * 1.3}" r="5.5" fill="${ink}"/><circle cx="${34 + dx * 1.3}" cy="${28 + dy * 1.3}" r="1.6" fill="${white}"/>`;
		case "happy":
			return pair(
				(x) =>
					`<path d="M${x - 6} 32q6-9 12 0" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/>`,
			);
		case "bars":
			return pair(
				(x) =>
					`<rect x="${x - 2 + dx / 2}" y="${23 + dy / 2}" width="4" height="13" rx="2" fill="${ink}"/>`,
			);
		case "squint":
			return pair(
				(x) =>
					`<rect x="${x - 7}" y="27" width="14" height="7" rx="3.5" fill="${white}"/><rect x="${x - 2 + dx}" y="28" width="4" height="5" rx="1.5" fill="${ink}"/>`,
			);
	}
}

/** One agent's face as an SVG, size in pixels. */
export function avatar(a: Agent, size = 48): string {
	return `<svg class="ava" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${a.role} agent">${body(a.shape, a.color)}${eyes(a.eyes, a.look)}${a.extra ? EXTRAS[a.extra] : ""}</svg>`;
}
