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
type Look = "left" | "right" | "up" | "down" | "center";

export interface Agent {
	role: string;
	color: string;
	shape: Shape;
	eyes: Eyes;
	look: Look;
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
	return `<svg class="ava" width="${size}" height="${size}" viewBox="0 0 64 64" role="img" aria-label="${a.role} agent">${body(a.shape, a.color)}${eyes(a.eyes, a.look)}</svg>`;
}
