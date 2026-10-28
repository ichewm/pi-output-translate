/**
 * Field-report round 6 regressions — the "kitchen sink" render test.
 *
 * R1: ````-fenced blocks containing ``` fences (think blocks with embedded
 *     code) must stay ONE code segment (the inner fence used to close the
 *     outer block and spill its body into prose).
 * R2: "A4. Footnotes"-style letter-prefixed ordinals must not split headings
 *     ("\b\d" found no word boundary between "A" and "4", so every "Xn."
 *     heading wrapped onto a second line on the page).
 * R3: the overlong-prose hard cut must never slice a $$ block / table row /
 *     heading mid-line (it used to cut at any space, halving formulas).
 * R4: $/$$ math is masked before translation (engines rewrote "\frac{1}{5}"
 *     into "1/5"); currency "$99" pairs are NOT math; escaped "\$" never is.
 * R5: display-math pairing skips orphaned closers instead of pairing them
 *     with the next real opener (which rendered empty formulas and fed raw
 *     LaTeX to marked, where underscores died as <em> emphasis).
 * R6: diff fences get +/- colors; the math-marker residue strip must not
 *     eat real tokens like "GLM-4.5" or "M4".
 */

import { describe, it, expect } from "vitest";
import { MessageSegmenter, type Segment } from "../src/segmenter.ts";
import { mask, restore, lostPlaceholders } from "../src/protect.ts";
import { renderMd, highlight, extractDisplayMath } from "../src/web/md.js";

const OPTS = { kind: "text" as const, maxSegmentChars: 1200, minSegChars: 20 };

describe("R1: nested fences", () => {
	it("a ```` block containing ``` fences stays one code segment", () => {
		const s = new MessageSegmenter(OPTS);
		const doc = [
			"Intro sentence before the block. ",
			"````thinking",
			"Outer text with `inline code`.",
			"```js",
			"const x = 1; // inner fence",
			"```",
			"Still inside the outer block.",
			"````",
			"Trailing prose after the block. ",
		].join("\n");
		const out = [...s.feed(doc), ...s.flush()];
		const code = out.filter((x) => x.kind === "code");
		expect(code).toHaveLength(1);
		expect(code[0].lang).toBe("thinking");
		expect(code[0].src).toContain("```js");
		expect(code[0].src).toContain("const x = 1;");
		expect(code[0].src).toContain("Still inside the outer block.");
		// the code body must NOT leak into prose segments
		const prose = out.filter((x) => x.kind !== "code").map((x) => x.src).join("\n");
		expect(prose).not.toContain("const x = 1;");
		expect(prose).toContain("Intro sentence before the block.");
		expect(prose).toContain("Trailing prose after the block.");
	});

	it("an inner ```js line is not a close fence (no 'js' prose fragment)", () => {
		const s = new MessageSegmenter(OPTS);
		const out = [...s.feed("```\nouter\n```js\nconst x = 1;\n```\ndone. "), ...s.flush()];
		const prose = out.filter((x) => x.kind !== "code").map((x) => x.src).join("|");
		expect(prose).not.toMatch(/^\s*js\s*$/m);
		const code = out.filter((x) => x.kind === "code");
		expect(code).toHaveLength(1);
		expect(code[0].src).toContain("```js");
	});
});

describe("R2: letter-prefixed ordinals keep headings whole", () => {
	it("'## A4. Footnotes' is never cut after the label", () => {
		const s = new MessageSegmenter(OPTS);
		const doc = [
			"An introductory paragraph with enough words to cross the minimum threshold. ",
			"\n## A4. Footnotes are supported\n",
			"Streaming translation buffers chunks until a boundary is found. ",
		].join("\n");
		const out = [...s.feed(doc), ...s.flush()];
		const joined = out.map((x) => x.src).join("\n<<SEG>>\n");
		// the heading text must live intact inside one segment
		const headingHome = out.find((x) => x.src.includes("## A4. Footnotes"));
		expect(headingHome).toBeDefined();
		expect(headingHome!.src).not.toMatch(/##\s*$/);
		expect(joined).not.toContain("## A4.\n");
	});

	it("'# PART B — G2. Display' heading labels survive too", () => {
		const s = new MessageSegmenter({ ...OPTS, minSegChars: 10 });
		const out = [...s.feed("Some preamble sentence. \n\n### G12. Environments and matrices\n\nBody text follows here. "), ...s.flush()];
		expect(out.some((x) => x.src.includes("### G12. Environments and matrices"))).toBe(true);
	});
});

describe("R3: hard cut respects structure", () => {
	it("never slices a multi-line $$ block in half", () => {
		const s = new MessageSegmenter({ ...OPTS, maxSegmentChars: 90 });
		const doc = [
			"First paragraph with plenty of words so the buffer overflows the cap quickly. ",
			"More words to push past the limit again and again. ",
			"\n$$\n\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}\n$$\n",
			"\nTail sentence after the formula. ",
		].join("\n");
		const out = [...s.feed(doc), ...s.flush()];
		const home = out.find((x) => x.src.includes("\\begin{aligned}"));
		expect(home).toBeDefined();
		expect(home!.src).toContain("\\end{aligned}");
		// no segment may END inside the block (raw half-formula leak)
		for (const seg of out) {
			if (seg.src.includes("$$")) {
				const count = (seg.src.match(/\$\$/g) ?? []).length;
				expect(count % 2).toBe(0);
			}
		}
	});

	it("never cuts mid-line in multi-line prose (cuts land on line boundaries)", () => {
		const s = new MessageSegmenter({ ...OPTS, maxSegmentChars: 80 });
		const lines = ["alpha beta gamma delta epsilon zeta eta theta one.", "iota kappa lambda mu nu xi omicron pi two.", "rho sigma tau upsilon phi chi psi omega three."];
		const out = [...s.feed(lines.join("\n") + "\n"), ...s.flush()];
		for (const seg of out) {
			for (const line of lines) {
				// any fragment of a line inside a segment must be the WHOLE line
				if (seg.src.includes(line.slice(0, 10))) expect(seg.src).toContain(line);
			}
		}
	});
});

describe("R4: math is masked before translation", () => {
	it("inline latex becomes a ⟦Mn⟧ placeholder and restores", () => {
		const { masked, placeholders } = mask("The loss $L(\\theta) = -\\frac{1}{N}$ is small.");
		expect(masked).toContain("⟦M0⟧");
		expect(masked).not.toContain("\\frac");
		const back = restore("损失 ⟦M0⟧ 很小。", placeholders, masked);
		expect(back).toContain("$L(\\theta) = -\\frac{1}{N}$");
		expect(back).not.toContain("⟦");
	});

	it("display math is masked whole", () => {
		const { masked, placeholders } = mask("Before.\n\n$$\n\\mathcal{L}(\\theta) = \\lambda \\lVert \\theta \\rVert_2^2\n$$\n\nAfter.");
		expect(masked.match(/⟦M\d+⟧/g)).toHaveLength(1);
		expect([...placeholders.values()][0]).toContain("$$");
	});

	it("currency pairs are never math", () => {
		const { masked } = mask("The plan costs $99 per month and $79 yearly, total.");
		expect(masked).not.toContain("⟦M");
	});

	it("escaped \\$ is not a delimiter", () => {
		const { masked } = mask("It costs \\$5 today, not $x^2$ dollars.");
		expect(masked).toContain("\\$5");
		expect(masked).toContain("⟦M0⟧");
	});

	it("an orphaned $$ does not swallow prose up to the next opener", () => {
		const src = "leftover text $$\n\nbetween the two markers\n\n$$W \\in \\mathbb{R}^{m}$$";
		const { masked, placeholders } = mask(src);
		// only the real block is masked; the prose stays visible
		expect(masked).toContain("between the two markers");
		expect([...placeholders.values()].join("")).toContain("$$W");
	});

	it("lostPlaceholders tracks math tokens too", () => {
		const { masked } = mask("value $a_1^2$ here");
		expect(lostPlaceholders(masked, "数值丢失了")).toEqual(["⟦M0⟧"]);
		expect(lostPlaceholders(masked, "数值 ⟦M0⟧")).toEqual([]);
	});
});

describe("R5: display pairing in the reader", () => {
	it("an orphaned closer does not eat the next opener (underscores survive)", () => {
		const html = renderMd("\\binom{n}{k} = \\frac{n!}{k!(n-k)!}$$\n\n$$\\mathbb{E}_{(x,y)}\\left[\\ell(f_\\theta(x))\\right]$$");
		expect(html).not.toContain("$$"); // delimiters fully consumed
		expect((html.match(/class="katex-display"/g) ?? []).length).toBeGreaterThanOrEqual(1);
		expect(html).not.toContain("<em>"); // underscores not eaten as emphasis
	});

	it("extractDisplayMath skips prose bodies, keeps real formulas", () => {
		const stashed: string[] = [];
		const out = extractDisplayMath("orphan $$ prose between $$ then $$x^2$$", (b) => {
			stashed.push(b);
			return `[M${stashed.length - 1}]`;
		});
		expect(stashed).toEqual(["x^2"]);
		expect(out).toContain("prose between");
	});

	it("both formulas in one segment render (G2 regression shape)", () => {
		const html = renderMd("$$\\prod_{i=1}^{n} i = n!$$\n\n$$\\lim_{n \\to \\infty} \\left(1 + \\frac{1}{n}\\right)^n = e$$");
		expect((html.match(/class="katex-display"/g) ?? []).length).toBe(2);
		expect(html).not.toContain("katex-error");
	});
});

describe("R7: fences inside blockquotes / list items", () => {
	it("a '> ```' fence stays in the quote and never swallows the rest", () => {
		const doc = "> Quote containing code:\n> ```\n> npm test\n> ```\n\n---\n\n# PART I — After\n\nProse follows here. ";
		const s = new MessageSegmenter(OPTS);
		const out: Segment[] = [];
		for (const c of doc.match(/.{1,17}/gs) ?? []) out.push(...s.feed(c));
		out.push(...s.flush());
		// no code segment at all — the fence lives inside the quote prose
		expect(out.every((x) => x.kind !== "code")).toBe(true);
		const quote = out.find((x) => x.src.includes("> npm test"));
		expect(quote).toBeDefined();
		expect(quote!.src.startsWith(">")).toBe(true);
		// the document AFTER the quote survives as its own text segment
		expect(out.some((x) => x.src.includes("# PART I — After"))).toBe(true);
		expect(out.some((x) => x.src.includes("Prose follows here"))).toBe(true);
	});

	it("list-embedded fences stay inline or close cleanly (never swallow)", () => {
		// marker-adjacent fence on the SAME line as the list marker: stays
		// inside the item (no code segment), and its BARE closer line must
		// not re-open a code block that swallows the tail
		const a = new MessageSegmenter(OPTS);
		const outA: Segment[] = [...a.feed("- ```js\nconst x = 1;\n```\n\nAfter the list. "), ...a.flush()];
		expect(outA.every((x) => x.kind !== "code")).toBe(true);
		expect(outA.some((x) => x.src.includes("const x = 1;") && x.kind !== "code")).toBe(true);
		expect(outA.some((x) => x.src.includes("After the list."))).toBe(true);
		// indented fence under the item: lifts as its OWN closed code segment,
		// but must never swallow the prose after the closer
		const b = new MessageSegmenter(OPTS);
		const outB: Segment[] = [...b.feed("- item with code:\n  ```\n  ls -la\n  ```\n\nAfter the list. "), ...b.flush()];
		const code = outB.filter((x) => x.kind === "code");
		expect(code).toHaveLength(1);
		expect(code[0].src).not.toContain("After the list.");
		expect(outB.some((x) => x.kind !== "code" && x.src.includes("After the list."))).toBe(true);
	});

	it("the '> ' / '```' delta boundary cannot split the inline context", () => {
		const s = new MessageSegmenter(OPTS);
		const out: Segment[] = [];
		out.push(...s.feed("> Quote containing code:\n> ")); // marker committed alone? must NOT be
		out.push(...s.feed("```\n> npm test\n"));
		out.push(...s.feed("> ```\n\n---\n\n# PART I — After\n\nProse follows here. "));
		out.push(...s.flush());
		expect(out.every((x) => x.kind !== "code")).toBe(true);
		expect(out.some((x) => x.src.includes("> npm test") && x.src.startsWith(">"))).toBe(true);
		expect(out.some((x) => x.src.includes("# PART I — After"))).toBe(true);
	});

	it("the quote segment renders as a blockquote with embedded code", () => {
		const html = renderMd("> Quote containing code:\n> ```\n> npm test\n> ```");
		expect(html).toContain("<blockquote>");
		expect(html).toContain("<code>");
		expect(html).toContain("npm test");
	});
});

describe("R6: highlighting + residue", () => {
	it("diff blocks get +/- colors", () => {
		const html = highlight("- const buffer = \"\";\n+ let buffer = \"\";\n@@ -1 +1 @@\n context line", "diff");
		expect(html).toContain("tk-del");
		expect(html).toContain("tk-add");
		expect(html).toContain("tk-meta");
		expect(html).not.toContain("tk-kw");
	});

	it("mermaid keywords and arrows are tinted, html stays valid", () => {
		const html = highlight("graph LR\n  A[Assistant delta] --> B{Sentence complete?}", "mermaid");
		expect(html).toContain("tk-kw");
		expect(html).toMatch(/graph/);
		expect(html).not.toContain("<span class=\"tk-kw\"><span"); // no nesting
	});

	it("marker residue strip leaves GLM-4.5 and M4 intact", () => {
		const html = renderMd("GLM-4.5 and M4 score well. Stray marker M0 too.");
		expect(html).toContain("GLM-4.5");
		// bare M\d+ in ENGLISH text is real content (Mac "M4" etc.) — the
		// residue strip only fires on control-byte forms and CJK-adjacent ones
		expect(html).toContain("M4");
		expect(html).toContain("M0");
	});

	it("CJK-adjacent and bracketed marker residue IS stripped", () => {
		expect(renderMd("数值M0很小。")).not.toContain("M0");
		expect(renderMd("（M3）被丢弃")).not.toContain("M3");
		expect(renderMd("leftover ⟦M7⟧ token")).not.toContain("⟦M7⟧");
		expect(renderMd("control \u0001M9\u0001 bytes")).not.toContain("M9");
	});
});
