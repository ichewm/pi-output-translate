/**
 * Audit round 5 regressions: markdown tables.
 *
 * T1: the segmenter must never cut a sentence boundary inside a table row
 *     (a table cell containing a period used to split the row in half, so
 *     the header, separator and body rows landed in different segments and
 *     the page rendered the table as loose pipes).
 * T2: the renderer tabulates any run of >=2 pipe lines — with OR without a
 *     `---` separator row (models drop it often).
 * T3: blockquote lines also stay intact through segmentation.
 */

import { describe, it, expect } from "vitest";
import { MessageSegmenter } from "../src/segmenter.ts";
import { renderMd } from "../src/web/md.js";

const TABLE_DOC = [
	"Choose the drain options carefully. They interact. ",
	"| Option | Type | Default | Meaning |",
	"|--------|------|---------|---------|",
	"| `--batch-window-ms` | int | 300 | How long the drain loop waits. |",
	"| `--max-retries` | int | 3 | Genuine retries per job. |",
	"After the table, prose continues with a normal sentence.",
].join("\n");

describe("T1: segmenter keeps table rows whole", () => {
	it("no segment ever contains a partial table row, and pipe lines stay intact", () => {
		const seg = new MessageSegmenter({ kind: "text", maxSegmentChars: 1200, minSegChars: 20 });
		// feed in awkward chunks to stream-realistic splits
		const out = [];
		for (const chunk of TABLE_DOC.match(/.{1,13}/gs) ?? []) out.push(...seg.feed(chunk));
		out.push(...seg.flush());

		const pipeLines = TABLE_DOC.split("\n").filter((l) => l.includes("|"));
		for (const seg2 of out) {
			for (const line of pipeLines) {
				const core = line.replace(/^\|/, "").replace(/\|$/, "").trim();
				if (seg2.src.includes(core.slice(0, 12)) && core.includes("|")) {
					// the line started here — it must be here COMPLETE
					expect(seg2.src).toContain(core);
				}
			}
		}
		// sanity: the table's header row and its separator land in one segment
		const headerSeg = out.find((x) => x.src.includes("| Option | Type | Default | Meaning |"));
		expect(headerSeg).toBeTruthy();
		expect(headerSeg!.src).toContain("|--------|------|---------|---------|");
		expect(headerSeg!.src).toContain("| `--batch-window-ms` | int | 300 |");
		// and the trailing prose is its own segment
		expect(out.some((x) => /After the table/.test(x.src))).toBe(true);
	});

	it("hard max-length cut still applies to runaway tables (safety valve)", () => {
		const giantRow = "| " + "x ".repeat(400) + "|";
		const seg = new MessageSegmenter({ kind: "text", maxSegmentChars: 100, minSegChars: 10 });
		const out = seg.feed("intro sentence here. " + giantRow + " tail. ");
		seg.flush();
		expect(out.length).toBeGreaterThan(0);
	});
});

describe("T2: renderer tabulates pipe runs leniently", () => {
	it("renders a standard table (with separator)", () => {
		const html = renderMd("| a | b |\n|---|---|\n| 1 | 2 |");
		expect(html).toContain("<table>");
		expect(html).toContain("<th>a</th>");
		expect(html).toContain("<td>2</td>");
		expect(html).not.toContain("|---");
	});

	it("renders a table WITHOUT a separator row", () => {
		const html = renderMd("| 选项 | 默认值 |\n| 批量窗口 | 300 ms |");
		expect(html).toContain("<table>");
		expect(html).toContain("<th>选项</th>");
		expect(html).toContain("<td>300 ms</td>");
	});

	it("cells containing periods and inline code stay in one row", () => {
		const html = renderMd(
			"| `--timeout` | duration | 45s | Per-request timeout. Retries excluded. |\n| `--max-retries` | int | 3 | Genuine retries only. |",
		);
		expect(html).toContain("<table>");
		expect((html.match(/<tr>/g) ?? []).length).toBe(2); // header row + one body row
		expect(html).toContain("Per-request timeout. Retries excluded.");
		expect(html).not.toContain("<br/>"); // no mid-row breaks
	});

	it("a single stray pipe line stays paragraph text", () => {
		const html = renderMd("just one line with a | pipe in prose");
		expect(html).not.toContain("<table>");
		expect(html).toContain("pipe in prose");
	});

	it("blockquote blocks render intact", () => {
		const html = renderMd("> **Note** — retries are eager.\n> **Warning** — be idempotent.");
		expect(html).toContain("<blockquote>");
		expect(html).toContain("<strong>Note</strong>");
	});

	it("headings, lists, fences and inline code still render", () => {
		const html = renderMd("## Part 2\n\n- item `one`\n- item two\n\n```ts\nconst x = 1;\n```");
		expect(html).toContain("<h2>Part 2</h2>");
		expect((html.match(/<li>/g) ?? []).length).toBe(2);
		expect(html).toContain('class="tk-kw"');
		expect(html).toContain("<code>one</code>");
	});

	it("defangs injection vectors (handlers stripped, js: URLs neutralized)", () => {
		const html = renderMd("evil <img src=x onerror=alert(1)> and <a href=\"javascript:evil()\">x</a> and `a<b`");
		expect(html).not.toContain("onerror");
		expect(html).not.toContain("javascript:");
		expect(html).toContain('href="#"');
		// inline code is still escaped
		expect(html).toContain("<code>a&lt;b</code>");
	});

	it("renders katex nodes for display and inline math", () => {
		const html = renderMd("inline $e^{i\\pi}$ and $$\\sum_{k=0}^{\\infty} \\frac{x^k}{k!}$$");
		expect((html.match(/class="katex"/g) ?? []).length).toBeGreaterThanOrEqual(2);
		expect(html).toContain("katex-display");
	});

	it("keeps table alignment attributes from marked", () => {
		const html = renderMd("| a | b |\n|:--|--:|\n| 1 | 2 |");
		expect(html).toContain('align="left"');
		expect(html).toContain('align="right"');
	});
});

describe("T3: blockquote lines survive segmentation", () => {
	it("consecutive > lines stay in one segment when short", () => {
		const seg = new MessageSegmenter({ kind: "text", maxSegmentChars: 1200, minSegChars: 20 });
		const out = seg.feed("> First quoted sentence.\n> Second quoted sentence. ");
		seg.flush();
		expect(out.length).toBe(0); // nothing hit a safe cut: whole block held
	});
});

describe("round 6: interleaving + math", () => {
	it("math lines are never cut mid-formula (decimal guard)", () => {
		const seg = new MessageSegmenter({ kind: "text", maxSegmentChars: 1200, minSegChars: 20 });
		const doc =
			"Costs settle first. The plan costs $99/month, and the discount is $\\alpha \\cdot 0.8$, " +
			"so effective price is $79.20 with $\\beta \\approx 0.79$. Then normal prose resumes here. ";
		const out = [];
		for (const c of doc.match(/.{1,9}/gs) ?? []) out.push(...seg.feed(c));
		out.push(...seg.flush());
		for (const part of out) {
			expect(part.src).not.toMatch(/\$\d+\.$/); // never end mid-number "$79."
			expect(part.src).not.toMatch(/^\d+\$/); // never start mid-number "20$"
			expect(part.src.includes("$\\alpha \\cdot 0.8$") ? true : !part.src.includes("\\alpha")).toBe(true);
		}
	});

	it("currency alone stays a price, LaTeX pairs become math nodes", async () => {
		const { renderMd } = await import("../src/web/md.js");
		const mixed = renderMd("price is $99 and $\\alpha \\cdot 0.8$ ok");
		expect(mixed.includes('class="katex"')).toBe(true);
		expect(mixed.includes("$99")).toBe(true);
		const block = renderMd("$$\n\\int e^{-x^2} dx = \\sqrt{\\pi}\n$$");
		expect(block.includes("katex-display")).toBe(true);
		const table = renderMd("| a | b |\n| 1 | 2 |");
		expect(table.includes("<table>")).toBe(true);
	});
});

describe("round 9: KaTeX fails closed (no red error spans)", () => {
	it("an unterminated $$ before markdown chapters keeps the CHAPTERS as markdown (round-9 contract)", async () => {
		const { renderMd } = await import("../src/web/md.js");
		const bad =
			"Sum: $$\\sum_{k=0}^{\\infty} \\frac{x^k}{k!\n\n---\n\n## 6. 边界情况压力测试部分\n\n货币与数学公式在同一行：该计划每月费用为 $99。";
		const out = renderMd(bad);
		expect(out).not.toContain("katex-error");
		expect(out).not.toContain("ParseError");
		// the stray $$ no longer paints everything after it as one literal
		// blob: the chapters survive as real markdown structure (round-9 fix;
		// the round-6 math-raw fallback was the old, weaker contract)
		expect(out).toContain("<h2>");
		expect(out).toContain("<hr>");
		expect(out).toContain("$99");
		expect(out).toContain("\\sum_{k=0}^{\\infty}"); // dangling formula text survives
		for (const b of out.match(/math-raw[^>]*>([^<]*)/g) ?? []) {
			expect(b.length).toBeLessThan(140); // no giant blob
		}
	});

	it("healthy display and inline math still typeset", async () => {
		const { renderMd } = await import("../src/web/md.js");
		const out = renderMd("$$E=mc^2$$ and inline $a^2+b^2$ end.");
		expect((out.match(/class="katex"/g) ?? []).length).toBeGreaterThanOrEqual(2);
		expect(out).toContain("katex-display");
		expect(out).not.toContain("katex-error");
	});

	it("a truly-broken formula body (bad LaTeX, no markdown) falls back to text too", async () => {
		const { renderMd } = await import("../src/web/md.js");
		const out = renderMd("$$\\frac{ unmatched$$ tail");
		expect(out).not.toContain("katex-error");
	});
});

describe("round 10: abbreviation guard", () => {
	it("e.g. / vs. / i.e. never end a segment", async () => {
		const { MessageSegmenter } = await import("../src/segmenter.ts");
		const seg = new MessageSegmenter({ kind: "text", maxSegmentChars: 1200, minSegChars: 8 });
		const out = seg.feed("Compare eager retries vs. patient backoff, e.g. with jitter, i.e. randomized delays. A real end. ");
		out.push(...seg.flush());
		for (const part of out) {
			expect(/\b(e\.g|vs|i\.e|etc)\.\s*$/i.test(part.src)).toBe(false);
		}
		// and the sentence eventually cuts at the REAL period
		expect(out.some((x) => /randomized delays\.$/.test(x.src))).toBe(true);
	});
});

describe("round 13: audit fixes", () => {
	it("math-slot control residue never reaches the page", async () => {
		const { renderMd } = await import("../src/web/md.js");
		const out = renderMd("译文 \u0001M0\u0001 加 $e^{i\\pi}$ 公式");
		expect(out).not.toMatch(/\u0001/);
		expect(out).toContain("katex");
	});
	it("glossary edit invalidates cache (key includes glossary version)", async () => {
		const { TranslateCache } = await import("../src/cache.ts");
		const k1 = TranslateCache.key("m", "v1", "model", "zh", "same source");
		const k2 = TranslateCache.key("m", "v2", "model", "zh", "same source");
		expect(k1).not.toBe(k2);
	});
	it("placeholder-dense prose passes the language gate", async () => {
		const { shouldTranslate } = await import("../src/langgate.ts");
		expect(shouldTranslate("The ⟦0⟧ flag controls ⟦1⟧ behavior in the loader.", 40)).toBe(true);
		expect(shouldTranslate("⟦0⟧ ⟦1⟧ ⟦2⟧ ok done", 40)).toBe(false);
	});
});
