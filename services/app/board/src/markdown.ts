// Turns an agent's reply (Markdown) into safe HTML, so the board shows what the Claude app shows: bold, inline code,
// code blocks with a Copy button, lists, tables, headings, quotes and links.
//
// This one function is embedded in the page as it is (renderMarkdown.toString()), so it must not use anything outside
// itself. Everything is HTML-escaped first and only tags written here are added; links are only http(s).

export function renderMarkdown(src: string): string {
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const BT = String.fromCharCode(96);
	const NUL = String.fromCharCode(0);

	const inline = (raw: string): string => {
		const codes: string[] = [];
		let t = esc(raw).replace(new RegExp(BT + "([^" + BT + "\\n]+)" + BT, "g"), (_m: string, c: string) => {
			codes.push(c);
			return NUL + (codes.length - 1) + NUL;
		});
		t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
		t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
		t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
		t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
		t = t.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
		return t.replace(new RegExp(NUL + "(\\d+)" + NUL, "g"), (_m: string, i: string) => "<code>" + codes[Number(i)] + "</code>");
	};

	const lines = String(src).slice(0, 20000).replace(/\r\n?/g, "\n").split("\n");
	const isBullet = (l: string) => /^\s*[-*+]\s+/.test(l);
	const isNumber = (l: string) => /^\s*\d+[.)]\s+/.test(l);
	const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
	const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
	const fence = (l: string) => /^\x60{3,}/.exec(l.trim())?.[0];
	const isHead = (l: string) => /^#{1,4}\s+\S/.test(l);
	const isQuote = (l: string) => /^\s*>/.test(l);
	const startsTable = (k: number) => isRow(lines[k]) && k + 1 < lines.length && isSep(lines[k + 1]);
	const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const openingFence = fence(line);
		if (openingFence) {
			const body: string[] = [];
			i++;
			while (i < lines.length) {
				const trimmed = lines[i].trim();
				if (trimmed.length >= openingFence.length && /^\x60+$/.test(trimmed)) break;
				body.push(lines[i++]);
			}
			i++;
			out.push('<pre><span class="cpb" data-copycode="1">Copy</span><code>' + esc(body.join("\n")) + "</code></pre>");
			continue;
		}
		if (/^\s*$/.test(line)) {
			i++;
			continue;
		}
		if (isHead(line)) {
			const m = /^(#{1,4})\s+(.*)$/.exec(line) as RegExpExecArray;
			out.push('<div class="mh' + m[1].length + '">' + inline(m[2]) + "</div>");
			i++;
			continue;
		}
		if (startsTable(i)) {
			const head = cells(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
			out.push(
				"<table><thead><tr>" + head.map((c) => "<th>" + inline(c) + "</th>").join("") + "</tr></thead><tbody>" +
					rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table>",
			);
			continue;
		}
		if (isBullet(line) || isNumber(line)) {
			const ordered = isNumber(line);
			const items: string[] = [];
			while (i < lines.length && (ordered ? isNumber(lines[i]) : isBullet(lines[i]))) items.push(lines[i++].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ""));
			const tag = ordered ? "ol" : "ul";
			out.push("<" + tag + ">" + items.map((x) => "<li>" + inline(x) + "</li>").join("") + "</" + tag + ">");
			continue;
		}
		if (isQuote(line)) {
			const q: string[] = [];
			while (i < lines.length && isQuote(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
			out.push("<blockquote>" + q.map(inline).join("<br>") + "</blockquote>");
			continue;
		}
		const para: string[] = [];
		while (
			i < lines.length &&
			!/^\s*$/.test(lines[i]) &&
			!fence(lines[i]) &&
			!isHead(lines[i]) &&
			!isBullet(lines[i]) &&
			!isNumber(lines[i]) &&
			!isQuote(lines[i]) &&
			!startsTable(i)
		)
			para.push(lines[i++]);
		if (!para.length) para.push(lines[i++]);
		out.push("<p>" + para.map(inline).join("<br>") + "</p>");
	}
	return out.join("");
}
