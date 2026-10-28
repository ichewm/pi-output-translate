/* Markdown + math renderer for the reader page.
 *
 * Stack (all vendored, zero network):
 *   marked      — markdown structure (tables with alignment, lists, etc.)
 *   katex       — real math typesetting for $$...$$ and $...$
 *   DOMPurify   — optional sanitize step supplied by the caller (browser);
 *                 node tests run without it (pure functions).
 * Own logic kept: code highlighting, math extraction with currency
 * protection ("$99" never pairs), and placeholder-slot restoration order.
 */
"use strict";

import { marked } from "./vendor/marked.esm.js";
import katex from "./vendor/katex.mjs";

export function esc(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const KW = {
	common: "function return if else for while break continue new class extends import from export default async await try catch finally throw typeof instanceof let const var this super static get set yield delete in of switch case do",
	js: "null undefined true false void",
	py: "def lambda None True False elif pass with as global nonlocal raise assert yield from not and or is",
	go: "func package type struct interface map chan go defer select range nil",
	rs: "fn let mut impl trait pub use mod match move ref Self crate as dyn",
	sh: "echo exit local readonly shift source then fi es dc done",
};
const kwSet = (lang) => {
	const l = (lang || "").toLowerCase();
	let base = KW.common.split(" ");
	if (/^(js|ts|jsx|tsx|javascript|typescript|mjs|cjs|json5)$/.test(l)) base = base.concat(KW.js.split(" "));
	if (/^(py|python)$/.test(l)) base = base.concat(KW.py.split(" "));
	if (/^go(lang)?$/.test(l)) base = base.concat(KW.go.split(" "));
	if (/^(rs|rust)$/.test(l)) base = base.concat(KW.rs.split(" "));
	if (/^(sh|bash|zsh|shell|console)$/.test(l)) base = base.concat(KW.sh.split(" "));
	return new Set(base);
};

const MERMAID_KW = new Set([
	"graph", "flowchart", "sequenceDiagram", "classDiagram", "stateDiagram", "erDiagram", "pie",
	"gantt", "mindmap", "timeline", "quadrantChart", "end", "subgraph", "direction", "style",
	"classDef", "class", "click", "linkStyle", "theme", "LR", "TB", "TD", "BT", "RL",
]);

/** diff blocks: +/- lines tinted green/red, hunk headers and file lines
 * dimmed. (Field report round 6: diff fences rendered wrong because the
 * generic tokenizer has no concept of +/- lines at all.) */
function highlightDiff(code) {
	return code
		.split("\n")
		.map((line) => {
			const t = esc(line);
			if (/^@@/.test(line)) return `<span class="tk-meta">${t}</span>`;
			if (/^\+/.test(line)) return `<span class="tk-add">${t}</span>`;
			if (/^-/.test(line)) return `<span class="tk-del">${t}</span>`;
			if (/^(diff --git|index |--- |\+\+\+ )/.test(line)) return `<span class="tk-meta">${t}</span>`;
			return t;
		})
		.join("\n");
}

/** Mermaid stays a plain code block (no diagram engine is vendored), but
 * the grammar's keywords and arrows get token colors so the block reads as
 * structure instead of undifferentiated text. Keyword pass runs BEFORE the
 * arrow pass so neither can wrap markup the other inserted. */
function highlightMermaid(code) {
	return code
		.split("\n")
		.map((line) => {
			let t = esc(line);
			t = t.replace(/(^|\s)([A-Za-z][\w-]*)(?=\s|$)/g, (m, sp, w) =>
				MERMAID_KW.has(w) ? `${sp}<span class="tk-kw">${w}</span>` : m);
			t = t.replace(/(-{2}&gt;|={2}&gt;|-{2}\|&gt;|-{2}o|-{2}x|-\.-&gt;)/g, (m) => `<span class="tk-kw">${m}</span>`);
			return t;
		})
		.join("\n");
}

export function highlight(code, lang) {
	const l = (lang || "").toLowerCase();
	if (l === "diff" || l === "patch") return highlightDiff(code);
	if (l === "mermaid") return highlightMermaid(code);
	const kws = kwSet(lang);
	let out = "";
	let i = 0;
	const n = code.length;
	const push = (cls, text) => {
		out += cls ? `<span class="tk-${cls}">${esc(text)}</span>` : esc(text);
	};
	while (i < n) {
		const ch = code[i];
		const isHash = ch === "#" && !/^#!/.test(code.slice(i));
		if (
			(ch === "/" && code[i + 1] === "/") ||
			(isHash && !["js", "ts", "jsx", "tsx", "c", "cpp", "java", "go", "rs", "rust"].includes((lang || "").toLowerCase())) ||
			(ch === "-" && code[i + 1] === "-")
		) {
			let j = code.indexOf("\n", i);
			if (j === -1) j = n;
			push("com", code.slice(i, j));
			i = j;
			continue;
		}
		if (ch === "/" && code[i + 1] === "*") {
			let j = code.indexOf("*/", i + 2);
			j = j === -1 ? n : j + 2;
			push("com", code.slice(i, j));
			i = j;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			let j = i + 1;
			while (j < n && code[j] !== ch) {
				if (code[j] === "\\") j++;
				j++;
			}
			j = Math.min(j + 1, n);
			push("str", code.slice(i, j));
			i = j;
			continue;
		}
		if (/[0-9]/.test(ch) && !/[\w.]/.test(code[i - 1] || "")) {
			let j = i;
			while (j < n && /[0-9a-fxXbBeE._]/.test(code[j])) j++;
			push("num", code.slice(i, j));
			i = j;
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			let j = i;
			while (j < n && /[\w$]/.test(code[j])) j++;
			const w = code.slice(i, j);
			if (kws.has(w)) push("kw", w);
			else if (code[j] === "(") push("fn", w);
			else push(null, w);
			i = j;
			continue;
		}
		push(null, ch);
		i++;
	}
	return out;
}

/** LaTeX heuristics: a $-pair is math only when its body carries LaTeX
 * syntax — "$99" prices never match, so mixed currency/LaTeX lines stay
 * prices. */
const looksLikeLatex = (body) => /[\\^_{}]|\\begin|\\frac/.test(body);

/** Pair up `$` positions manually: when a pair's body is NOT LaTeX (e.g.
 * "$99 ... $" spanning a price and a real opening delimiter), the FIRST `$`
 * is skipped WITHOUT consuming the second — a single global replace would
 * eat the real math's opening `$` and the formula would never pair again.
 * Escaped `\$` dollars are never delimiters. */
export function extractInlineMath(src, stash) {
	const dollars = [];
	for (let k = 0; k < src.length; k++) if (src[k] === "$" && src[k - 1] !== "\\") dollars.push(k);
	let out = "";
	let cursor = 0;
	let d = 0;
	while (d + 1 < dollars.length) {
		const a = dollars[d];
		const b = dollars[d + 1];
		const body = src.slice(a + 1, b);
		if (body.length > 0 && !body.includes("\n") && body.length <= 200 && looksLikeLatex(body)) {
			out += src.slice(cursor, a) + stash(body);
			cursor = b + 1;
			d += 2;
		} else {
			d += 1;
		}
	}
	return out + src.slice(cursor);
}

/** A loose formula body must look like a formula: markdown headers, rules,
 * horizontal rules or heavy CJK mean the "math" is really prose that the
 * unterminated-$$ heuristic swallowed (round 6 finding: "## 6. Edge-Case"
 * chapters were being painted red by KaTeX parse errors). */
/** Display bodies must carry real math syntax (backslashes, scripts,
 * alignment operators) — prose between a stray $$ and the next real $$
 * never counts. Mirrors protect.ts. */
const looksLikeLatexBlock = (body) => /[\\^_{}&=<>]|\\begin|\\frac/.test(body);

const looksLikeFormulaBody = (body) => {
	if (/\n#{1,6}\s/.test(body)) return false; // markdown headers inside
	if (/\n(-{3,}|\*{3,})\s*$/.test(body)) return false; // trailing rule
	if (/^\s*(-{3,})\s*$/m.test(body)) return false;
	const cjk = (body.match(/[\u4e00-\u9fff]/g) ?? []).length;
	if (cjk > 2) return false; // prose, not math
	return true;
};

const renderMath = (body, displayMode, loose = false) => {
	if (loose && !looksLikeFormulaBody(body)) {
		return `<span class="math-raw">${esc(body)}</span>`;
	}
	try {
		return katex.renderToString(body, { displayMode, throwOnError: true, output: "html" });
	} catch {
		return `<span class="math-raw">${esc(body)}</span>`;
	}
};

const isPipeRow = (line) => {
	const t = line.trim();
	if (!t.includes("|")) return false;
	const bars = (t.match(/\|/g) ?? []).length;
	return bars >= 2 || (bars >= 1 && (t.startsWith("|") || t.endsWith("|")));
};
const isSeparatorRow = (line) => /^[\s|:-]+$/.test(line) && line.includes("-");
const colCount = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length;

/** GFM tables require a separator row, but translation models drop it
 * often; any run of >=2 pipe rows without one gets a synthetic separator
 * injected so marked still tabulates them. */
function ensureTableSeparators(src) {
	const lines = src.split("\n");
	const out = [];
	let i = 0;
	while (i < lines.length) {
		if (isPipeRow(lines[i])) {
			let j = i;
			while (j < lines.length && isPipeRow(lines[j]) && lines[j].trim() !== "") j++;
			const run = lines.slice(i, j);
			const hasSep = run.length >= 2 && isSeparatorRow(run[1]);
			if (run.length >= 2 && !hasSep) {
				const cols = Math.max(...run.map(colCount));
				out.push(run[0]);
				out.push("|" + Array(cols).fill("---").join("|") + "|");
				out.push(...run.slice(1));
			} else {
				out.push(...run);
			}
			i = j;
		} else {
			out.push(lines[i]);
			i++;
		}
	}
	return out.join("\n");
}

/** Display math with the same skip-not-consume discipline as inline math:
 * a candidate pair whose body is empty / prose (an orphaned closer meeting
 * the next real opener — happens when a translation splits a $$ block) is
 * skipped without consuming the second $$. A blind pairing regex used to
 * match stray closers with real openers, rendering empty formulas and
 * dumping whole blocks of LaTeX through marked (which then ate underscores
 * as emphasis: \mathbb{E}_{..} -> \mathbb{E}{..}). */
export function extractDisplayMath(src, stash) {
	const dd = [];
	for (let k = 0; k < src.length; k++) {
		if (src[k] === "$" && src[k + 1] === "$" && src[k - 1] !== "\\") {
			dd.push(k);
			k++;
		}
	}
	let out = "";
	let cursor = 0;
	let d = 0;
	while (d + 1 < dd.length) {
		const a = dd[d];
		const b = dd[d + 1];
		const body = src.slice(a + 2, b);
		if (body.trim() !== "" && looksLikeFormulaBody(body) && looksLikeLatexBlock(body)) {
			out += src.slice(cursor, a) + stash(body.trim());
			cursor = b + 2;
			d += 2;
		} else {
			d += 1;
		}
	}
	return out + src.slice(cursor);
}

// marked: custom code renderer keeps our highlighter + block chrome.
marked.use({
	renderer: {
		code({ text, lang }) {
			const language = (lang || "").split(/\s+/)[0] || "";
			return `<div class="codeblock"><pre><code>${highlight(text, language)}</code></pre></div>`;
		},
	},
});

/** Conservative fallback for environments without DOMPurify: defang the
 * common XSS vectors (script/iframe/embeds, on* handlers, js: URLs). The
 * browser always layers DOMPurify on top of this. */
export function fallbackSanitize(html) {
	return html
		.replace(/<(script|iframe|object|embed|link|meta|style|base|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<(script|iframe|object|embed|link|meta|base|form)\b[^>]*\/?>/gi, "")
		.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/(href|src)\s*=\s*("|')?\s*(javascript|data:text\/html)[^\s"'>]*/gi, '$1="#"');
}

export function renderMd(text, opts = {}) {
	const sanitize = typeof opts.sanitize === "function" ? opts.sanitize : null;
	// Pass 0: lift math out of the markdown pipeline.
	const slots = [];
	const stash = (html) => {
		slots.push(html);
		return `\u0001M${slots.length - 1}\u0001`;
	};
	let src = String(text || "");
	// Models occasionally copy the math-slot control markers (M0)
	// into their output — strip the residue so it never reaches the page.
	// Two shapes exist: the full marker with control bytes, and the bare
	// "M0" left after a model strips the bytes itself. The bare form is
	// guarded so real text like "GLM-4.5" or "M4" is never eaten.
	src = src.replace(/M\d+/g, "");
	src = src.replace(/(?<=[\u4e00-\u9fff（）【])M\d+(?![\w.$-])/g, "");
	src = extractDisplayMath(src, (body) => stash(renderMath(body, true)));
	src = extractInlineMath(src, (body) => stash(renderMath(body, false)));
	// Unterminated display math ("$$..." with no closing $$ — models split it
	// across lines): render from the lone opener to the end of the text
	// instead of dumping raw LaTeX into the page.
	if (src.includes("$$")) {
		const openers = [...src.matchAll(/\$\$/g)].map((m) => m.index);
		const unmatched = openers.length % 2 === 1 ? openers[openers.length - 1] : -1;
		if (unmatched >= 0) {
			const head = src.slice(0, unmatched);
			const body = src.slice(unmatched + 2);
			// A lone $$ trailed only by whitespace / slot markers is a stray
			// closer from a block split elsewhere — drop it instead of
			// rendering an empty formula that swallows the slot markers
			// (the real formulas already rendered via their own slots).
			const meaningful = body.replace(/M\d+/g, "").trim();
			// Unclosed-$$ recovery ONLY when the tail is one plausible
			// formula (LaTeX syntax, no markdown structure). A stray
			// closer in a list bullet used to loose-render EVERYTHING
			// after it as one giant literal blob, destroying the lists/
			// tables/sections that followed (field report round 9).
			if (meaningful !== "" && looksLikeFormulaBody(meaningful) && looksLikeLatexBlock(meaningful)) {
				src = head + stash(renderMath(body.trim(), true, true));
			} else {
				src = head + body; // drop the stray $$, keep the markdown intact
			}
		}
	}

	src = ensureTableSeparators(src);
	let html = marked.parse(src, { async: false, gfm: true, breaks: false });
	if (sanitize) {
		try {
			html = sanitize(html, { ADD_TAGS: ["foreignobject"] });
		} catch {
			html = fallbackSanitize(html);
		}
	} else {
		// No DOMPurify in this environment (node): strip the obvious vectors.
		html = fallbackSanitize(html);
	}
	let out = html;
	for (let i = 0; i < slots.length; i++) {
		out = out.split(`\u0001M${i}\u0001`).join(slots[i]);
	}
	// Any control marker that survived (model-copied with a wrong index, or
	// a bare \u0001) is residue, never content.
	out = out
		.replace(/\u0001M\d+\u0001?/g, "")
		.replace(/⟦\s*M\d+\s*⟧/gu, "") // ⟦M n⟧ leftovers
		.replace(/\u0001/g, "");
	return out;
}
