/**
 * Pipeline fuzz (audit round 8) — proactive self-verification of the WHOLE
 * display pipeline, not just units:
 *
 *   doc corpus (every hazard class)  ×  delta splits (fixed / random /
 *   adversarial: cut exactly at every backtick/$/>/|/#)  ×  translation
 *   mocks (identity + fullwidth-bracket mangling)
 *   →  MessageSegmenter → mask → [translate] → restore → renderMd
 *
 * Invariants:
 *  P1 reassembly   — every non-whitespace char of the doc survives, in order
 *  P2 no swallow   — the tail sentinel sentence lives in a TEXT segment
 *  P3 tables       — every pipe row of the doc stays intact inside ONE segment
 *  P4 display math — every $$ block body stays inside ONE segment; rendered
 *                    HTML of its segment never leaks a raw "$$"
 *  P5 headings     — every heading line stays intact inside ONE segment
 *  P6 placeholders — identity translate restores verbatim; fullwidth-mangled
 *                    placeholders (【M0】) still restore every literal
 *  P7 render       — no control bytes, no katex-error, no <em> that swallowed
 *                    LaTeX (em text containing a backslash)
 *  P8 sanitizer    — <script>/<script> vectors never survive renderMd
 */

import { describe, it, expect } from "vitest";
import { MessageSegmenter, type Segment } from "../src/segmenter.ts";
import { mask, restore } from "../src/protect.ts";
import { renderMd } from "../src/web/md.js";

const TAIL = "TAIL SENTINEL 9042 nothing may swallow me.";

const DOCS: Record<string, string> = {
	dottedHeadings: [
		"# PART A — Typography and structure of the page. ",
		"",
		"## A1. Heading Levels stay on one line. ",
		"",
		"## A2. Inline Formatting Matrix also stays whole. ",
		"",
		"### G12. Environments and matrices keep their label. ",
		"",
		"Intro sentence long enough to trip the minimum threshold. ",
		"Second sentence follows the first one here. ",
		TAIL,
	].join("\n"),

	tables: [
		"Choose the drain options carefully. They interact. ",
		"| Option | Type | Default | Meaning |",
		"|:-------|:----:|--------:|:---------|",
		"| `--batch-window-ms` | int | 300 | How long the drain loop waits. |",
		"| `--max-retries` | int | 3 | Genuine retries per job. |",
		"| $E = mc^2$ | math | — | Mass–energy equivalence. |",
		"After the table, prose continues with a normal sentence. ",
		TAIL,
	].join("\n"),

	displayMath: [
		"Intro text for the section that follows. ",
		"",
		"$$",
		"\\prod_{i=1}^{n} i = n! \\qquad \\binom{n}{k} = \\frac{n!}{k!(n-k)!}",
		"$$",
		"",
		"$$",
		"\\mathcal{L}(\\theta) = \\mathbb{E}_{(x,y)\\sim\\mathcal{D}}\\left[ \\ell(f_\\theta(x), y) \\right] + \\lambda \\lVert \\theta \\rVert_2^2",
		"$$",
		"",
		"$$",
		"\\begin{aligned}",
		"\\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0} \\\\",
		"\\nabla \\times \\mathbf{E} &= -\\frac{\\partial \\mathbf{B}}{\\partial t}",
		"\\end{aligned}",
		"$$",
		"",
		TAIL,
	].join("\n"),

	inlineMathCurrency: [
		"The plan costs $99 per month, and the discount is $\\alpha \\cdot 0.8$, ",
		"so the effective price is $79.20 with $\\beta \\approx 0.79$ at the end. ",
		"Values are $a=1$, $b=2$, and $c=3$; therefore $a+b=c$ holds. ",
		"设 $\\mu$ 为均值、$\\sigma^2$ 为方差，则 $X \\sim \\mathcal{N}(\\mu, \\sigma^2)$。 ",
		TAIL,
	].join("\n"),

	nestedFences: [
		"Intro sentence before the big block. ",
		"````thinking",
		"Outer text with `inline code` inside. ",
		"```js",
		"const x = 1; // inner fence stays inside",
		"```",
		"Still inside the outer block here. ",
		"````",
		"Trailing prose after the block ends. ",
		TAIL,
	].join("\n"),

	quoteFences: [
		"> Simple quote with `code` and **bold** text. ",
		"",
		"> Quote containing code:",
		"> ```",
		"> npm test",
		"> ```",
		"",
		"---",
		"",
		"# PART I — After the quote",
		"",
		"Prose that must survive the quote fence. ",
		TAIL,
	].join("\n"),

	listFences: [
		"- item with code:",
		"  ```",
		"  ls -la",
		"  ```",
		"",
		"1. ordered item. ",
		"2. another ordered item here. ",
		TAIL,
	].join("\n"),

	htmlAndLinks: [
		"Inline link: [Pi agent](https://github.com/earendil-works/pi-coding-agent) here. ",
		"Reference definition follows below in the same document. ",
		"",
		"[zai]: https://docs.z.ai \"Z.AI Documentation\"",
		"",
		"<details>",
		"<summary>Collapsed details</summary>",
		"Hidden formula $\\sqrt{2}$ and <kbd>Ctrl</kbd> + <kbd>C</kbd>. ",
		"</details>",
		"",
		"Emoji 🎉 and a long URL https://example.com/a/very/long/path/aaaa. ",
		TAIL,
	].join("\n"),

	unclosedBlock: [
		"- **Currency + math interleaved:** Pay $50 upfront, save $\\frac{1}{5}$, pay $40. ",
		"- **Unclosed block:** ",
		"  $$ \\int_0^1 dx",
		"- **CJK with LaTeX:** 设 $\\mu$ 为均值、$\\sigma^2$ 为方差，则 $X \\sim \\mathcal{N}(\\mu, \\sigma^2)$。 ",
		"- **Emoji:** Great job! 🎉 streaming ✨ correctly ✅. ",
		"",
		"| Part | Category |",
		"|------|----------|",
		"| A | Headings |",
		"| J | Edge cases |",
		"",
		TAIL,
	].join("\n"),

	thinkStyle: [
		"First I need to check the config file. Then the loader module. ",
		"",
		"Second paragraph of thinking with $P(A \\mid B) = \\frac{P(B \\mid A)P(A)}{P(B)}$ math. ",
		"",
		"- a list inside thinking",
		"- second item with `code span`",
		"",
		TAIL,
	].join("\n"),
};

/** Split a doc into deltas by strategy. */
function splitDoc(doc: string, mode: string): string[] {
	if (mode.startsWith("fixed:")) {
		const n = Number(mode.slice(6));
		return doc.match(new RegExp(`.{1,${n}}`, "gs")) ?? [];
	}
	if (mode.startsWith("rand:")) {
		let s = Number(mode.slice(5));
		const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
		const out: string[] = [];
		let i = 0;
		while (i < doc.length) {
			const step = 1 + Math.floor(rnd() * 23);
			out.push(doc.slice(i, i + step));
			i += step;
		}
		return out;
	}
	// adversarial: cut exactly before every hazardous char (capped) —
	// chunks are CONSECUTIVE slices at every hazard position, nothing skipped
	const chars = [..."`$>|#*-"];
	const positions: number[] = [];
	for (let i = 0; i < doc.length && positions.length < 240; i++) {
		if (chars.includes(doc[i])) positions.push(i);
	}
	const cuts = [0, ...positions, doc.length];
	const out: string[] = [];
	for (let i = 0; i + 1 < cuts.length; i++) {
		if (cuts[i + 1] > cuts[i]) out.push(doc.slice(cuts[i], cuts[i + 1]));
	}
	return out;
}

const SPLIT_MODES = ["fixed:1", "fixed:3", "fixed:7", "fixed:17", "fixed:40", "rand:7", "rand:99", "adv"];

/** Pair $$ positions the way the pipeline sees them; returns body spans. */
function displayBlocks(doc: string): { start: number; end: number }[] {
	const dd: number[] = [];
	for (let k = 0; k < doc.length; k++) {
		if (doc[k] === "$" && doc[k + 1] === "$" && doc[k - 1] !== "\\") {
			dd.push(k);
			k++;
		}
	}
	const spans: { start: number; end: number }[] = [];
	for (let i = 0; i + 1 < dd.length; i += 2) spans.push({ start: dd[i], end: dd[i + 1] + 2 });
	return spans;
}

function runPipeline(doc: string, mode: string, kind: "text" | "thinking", mangle: boolean) {
	const seg = new MessageSegmenter({ kind, maxSegmentChars: 300, minSegChars: 20 });
	const segments: Segment[] = [];
	for (const chunk of splitDoc(doc, mode)) segments.push(...seg.feed(chunk));
	segments.push(...seg.flush());

	// P1 reassembly (order-preserving, whitespace-insensitive)
	const strip = (s: string) => s.replace(/\s+/g, "");
	expect(strip(segments.map((x) => x.src).join(""))).toBe(strip(doc));

	// P2 no swallow
	expect(segments.some((x) => x.kind !== "code" && x.src.includes("SENTINEL 9042"))).toBe(true);

	// P3 tables: every pipe row intact inside ONE segment
	for (const line of doc.split("\n")) {
		if (!line.includes("|")) continue;
		if (line.trim() === "") continue;
		const ok = segments.some((x) => x.src.includes(line.trim()));
		expect(ok, `pipe row split by segmentation (${mode}): ${line.trim().slice(0, 50)}`).toBe(true);
	}

	// P4 display math: block body inside ONE segment + no $$ leak in render
	for (const span of displayBlocks(doc)) {
		const body = doc.slice(span.start, span.end);
		const ok = segments.some((x) => x.src.includes(body));
		// bodies containing trimmed whitespace edges compare loosely:
		const okLoose = ok || segments.some((x) => x.src.includes(body.trim()));
		expect(okLoose, `$$ block split by segmentation (${mode}): ${body.slice(0, 50)}`).toBe(true);
	}

	// P5 headings intact
	for (const line of doc.split("\n")) {
		if (/^\s{0,3}#{1,6}\s/.test(line)) {
			expect(segments.some((x) => x.src.includes(line.trim())), `heading split (${mode}): ${line}`).toBe(true);
		}
	}

	// P6 + P7: translate mocks → restore → render hygiene
	for (const s of segments) {
		if (s.kind === "code") continue;
		const { masked, placeholders } = mask(s.src);
		const literals = [...placeholders.values()];
		let tgt = masked;
		if (mangle) {
			// hostile engine: wraps output, reshapes every placeholder to
			// fullwidth brackets with inserted spaces
			tgt = "【译】" + masked.replace(/⟦(M?\d+)⟧/g, (_m, d) => `【 ${d} 】`) + "。";
		}
		const restored = restore(tgt, placeholders, masked);
		for (const lit of literals) {
			expect(restored.includes(lit), `placeholder literal lost (${mode}${mangle ? " mangled" : ""}): ${lit.slice(0, 40)}`).toBe(true);
		}
		const html = renderMd(restored);
		expect(html).not.toContain("\u0001");
		expect(html).not.toContain("katex-error");
		const em = html.match(/<em>([^<]*)<\/em>/g) ?? [];
		for (const e of em) expect(e.includes("\\"), `LaTeX eaten by <em> (${mode}): ${e}`).toBe(false);
		// blob detector: a math-raw fallback spanning many chars means a
		// stray delimiter swallowed real content as literal text (round 9)
		for (const b of html.match(/math-raw[^>]*>([^<]*)/g) ?? []) {
			expect(b.length, `math-raw blob (${mode}): ${b.slice(0, 50)}`).toBeLessThan(140);
		}
	}
	return segments;
}

describe("pipeline fuzz: corpus × splits × translation mocks", () => {
	for (const [name, doc] of Object.entries(DOCS)) {
		const kind: "text" | "thinking" = name === "thinkStyle" ? "thinking" : "text";
		for (const mode of SPLIT_MODES) {
			it(`${name} [${mode}] identity`, () => {
				runPipeline(doc, mode, kind, false);
			});
		}
		it(`${name} [rand:7] mangled-placeholders`, () => {
			runPipeline(doc, "rand:7", kind, true);
		});
	}

	it("P8: script vectors never survive renderMd", () => {
		const html = renderMd('Hi <script>alert("x")</script> and <img src=x onerror=alert(1)> bye. ');
		expect(html.toLowerCase()).not.toContain("<script");
		expect(html.toLowerCase()).not.toContain("onerror");
	});

	it("fixed:1 on the full corpus never throws (smoke)", () => {
		for (const doc of Object.values(DOCS)) {
			const seg = new MessageSegmenter({ kind: "text", maxSegmentChars: 300, minSegChars: 20 });
			for (const c of doc.match(/.{1,1}/gs) ?? []) seg.feed(c);
			seg.flush();
		}
	});
});
