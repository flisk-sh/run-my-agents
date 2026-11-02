// Draws src/play-card.png, the 1200x630 picture X and other sites show for /play. Run: bun scripts/play-card.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const r = (x: number, y: number, w: number, h: number, c: string) =>
	`<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" fill="${c}"/>`;
const chef = (x: number, y: number, c: string, s: number) =>
	r(x, y + 6 * s, 18 * s, 16 * s, c) +
	r(x, y - 8 * s, 16 * s, 14 * s, "#f5d0a9") +
	r(x - 3 * s, y - 9 * s, 2 * s, 3 * s, "#111") +
	r(x + 3 * s, y - 9 * s, 2 * s, 3 * s, "#111") +
	r(x, y - 20 * s, 18 * s, 10 * s, "#fafafa") +
	r(x, y - 15 * s, 20 * s, 3 * s, "#e5e5e5");
const bug = (x: number, y: number, s: number) =>
	r(x, y, 16 * s, 12 * s, "#ef4444") +
	[-1, 1]
		.flatMap((a) =>
			[-3, 3].map((b) => r(x + a * 9 * s, y + b * s, 4 * s, 2 * s, "#ef4444")),
		)
		.join("") +
	r(x - 3 * s, y - 3 * s, 3 * s, 3 * s, "#111") +
	r(x + 3 * s, y - 3 * s, 3 * s, 3 * s, "#111");
let tiles = "";
for (let i = 0; i < 25; i++)
	for (let j = 0; j < 14; j++)
		if ((i + j) % 2) tiles += r(i * 48 + 24, j * 48 + 24, 48, 48, "#1b1b24");
const bugs = [
	[140, 120],
	[260, 520],
	[1040, 110],
	[1090, 470],
	[180, 330],
	[980, 300],
	[420, 560],
	[820, 560],
	[640, 90],
]
	.map(([x, y]) => bug(x, y, 3))
	.join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#15151c"/>${tiles}${bugs}
${r(1000, 190, 90, 78, "#fb7185")}<text x="1000" y="186" font-family="Menlo,monospace" font-weight="700" font-size="28" text-anchor="middle" fill="#111">&lt;&lt;&lt;</text><text x="1000" y="216" font-family="Menlo,monospace" font-weight="700" font-size="28" text-anchor="middle" fill="#111">&gt;&gt;&gt;</text>
<rect x="250" y="200" width="700" height="250" rx="18" fill="#000" fill-opacity=".72"/>
<text x="600" y="290" font-family="Menlo,monospace" font-weight="700" font-size="88" text-anchor="middle" fill="#22c55e">KITCHEN RUSH</text>
<text x="600" y="345" font-family="Menlo,monospace" font-size="28" text-anchor="middle" fill="#ddd">Hold out 5:00 against bugs and red CI</text>
<text x="600" y="400" font-family="Menlo,monospace" font-size="24" text-anchor="middle" fill="#9ca3af">a free game from Run My Agents</text>
${chef(600, 530, "#22c55e", 4)}${chef(470, 550, "#38bdf8", 3)}${chef(730, 550, "#f59e0b", 3)}${chef(850, 540, "#a78bfa", 3)}
</svg>`;
const png = new Resvg(svg, { font: { loadSystemFonts: true } })
	.render()
	.asPng();
writeFileSync(join(import.meta.dir, "../src/play-card.png"), png);
