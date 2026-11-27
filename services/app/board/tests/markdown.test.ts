import { describe, expect, it } from "bun:test";
import { renderMarkdown as md } from "../src/markdown";

describe("markdown", () => {
	it("renders what the Claude app renders: bold, italic, inline code, headings", () => {
		expect(md("**The YouTube Short is back.** It is `pins.json`.")).toBe("<p><strong>The YouTube Short is back.</strong> It is <code>pins.json</code>.</p>");
		expect(md("a *b* and _c_")).toBe("<p>a <em>b</em> and <em>c</em></p>");
		expect(md("## Checked")).toBe('<div class="mh2">Checked</div>');
	});

	it("renders lists, quotes and tables", () => {
		expect(md("- one\n- **two**")).toBe("<ul><li>one</li><li><strong>two</strong></li></ul>");
		expect(md("1. a\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
		expect(md("> quoted")).toBe("<blockquote>quoted</blockquote>");
		expect(md("| A | B |\n|---|---|\n| 1 | `x` |")).toBe("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><code>x</code></td></tr></tbody></table>");
	});

	it("renders fenced code untouched, with a Copy button", () => {
		const html = md("```bash\nbun test **not bold**\n```");
		expect(html).toContain('<span class="cpb" data-copycode="1">Copy</span>');
		expect(html).toContain("<code>bun test **not bold**</code>");
	});

	it("keeps shorter fences and backtick-prefixed code inside a four-backtick fence", () => {
		const source = "````markdown\n```sh\necho sample\n```\n````suffix\n`````  \nAfter the example";
		expect(md(source)).toBe('<pre><span class="cpb" data-copycode="1">Copy</span><code>```sh\necho sample\n```\n````suffix</code></pre><p>After the example</p>');
	});

	it("keeps single line breaks and splits paragraphs on blank lines", () => {
		expect(md("one\ntwo\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
	});

	it("links only http(s), and never lets markup through", () => {
		expect(md("[docs](https://flisk.sh/a?b=1&c=2)")).toBe('<p><a href="https://flisk.sh/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
		expect(md("see https://flisk.sh/x.")).toContain('<a href="https://flisk.sh/x" ');
		expect(md("[x](javascript:alert(1))")).not.toContain("<a ");
		const evil = md('<script>alert(1)</script> <img src=x onerror=alert(1)> "quote"');
		expect(evil).not.toContain("<script");
		expect(evil).not.toContain("<img");
		expect(evil).toContain("&lt;script&gt;");
	});

	it("does not loop or throw on odd input", () => {
		for (const odd of ["", "|", "| a |", "```", "```\nunclosed", "- ", "#", "> ", "**", "`", "\u0000"]) expect(() => md(odd)).not.toThrow();
	});
});
