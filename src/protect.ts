/**
 * Content protection: mask code-ish literals with ⟦n⟧ placeholders before
 * sending prose to the translation engine, restore afterwards.
 *
 * Principle: mask only what is *certainly* not
 * prose. Everything uncertain goes to the translator.
 *
 * Audit round 3 fuzz findings, fixed structurally here:
 * - Masking used to run rules sequentially, so a later rule could swallow an
 *   earlier placeholder's token into a new literal (nested placeholders) and
 *   single-pass restore could never untangle them. Masking now collects
 *   non-overlapping ranges first, then emits placeholders once — nesting is
 *   impossible by construction.
 * - Restore's tolerant forms ([n], 【n】) used to fire on any match, so an
 *   ordinary "[2]" or "【1】" *in the source text* could be swapped for an
 *   unrelated placeholder's literal. Tolerant forms now only backfill
 *   placeholders that are genuinely missing after the exact pass, and only
 *   for those specific numbers.
 */

export interface MaskResult {
	/** Text with placeholders in place of protected literals. */
	masked: string;
	/** Placeholder token ("⟦0⟧") -> original literal. */
	placeholders: Map<string, string>;
}

/** Patterns that certainly are not English prose (ordered strongest first). */
const MASK_RULES: RegExp[] = [
	// fenced code blocks (should have been stripped by the segmenter; safety net)
	/```[\s\S]*?```/g,
	// inline code
	/`[^`\n]+`/g,
	// urls
	/\b(?:https?:\/\/|ftp:\/\/)[^\s<>()"']+/g,
	// absolute / home / relative paths with a slash
	/(?:^|[\s(])((?:~\/|\.{0,2}\/)[^\s()"'`,;:]+|[A-Za-z]:\\[^\s()"'`,;:]+)/g,
	// option flags like --force, -Dfile.encoding
	/(?<![\w-])--?[A-Za-z][\w.-]*/g,
	// bare filenames like index.ts / Makefile.deps
	/\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|yaml|yml|toml|md|rs|go|py|rb|java|kt|c|h|cpp|hpp|cs|swift|m|mm|sh|bash|zsh|fish|sql|html|css|scss|vue|svelte|lua|pl|php|ex|exs|erl|hs|ml|nim|zig|d|v|lock|log|conf|ini|env|mod|sum)\b/g,
	// SCREAMING_SNAKE constants
	/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
	// snake_case identifiers
	/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,
	// Multi-hump CamelCase (TranslateQueue) and lowerCamelCase (useState)
	/\b[A-Za-z][a-z0-9]+(?:[A-Z][a-z0-9]+)+[A-Za-z]*\b/g,
	/\b[a-z]+(?:[A-Z][a-zA-Z0-9]*)+(?:\.[A-Za-z][\w.]*)?\b/g,
	// dotted api-ish tokens: fs.readFileSync, std::vector, k8s.io/api
	/\b[\w]+(?:::|\.)[\w:.]+\b/g,
	// hex shas (7-40 hex chars, standalone)
	/(?<![\w])[0-9a-f]{7,40}(?![\w])/g,
	// version tags v1.2.3
	/\bv?\d+\.\d+(?:\.\d+)?(?:[-.][\w.]+)*\b/g,
];

/** Collect non-overlapping protected ranges across all rules, then mask. */
export function mask(source: string): MaskResult {
	const placeholders = new Map<string, string>();
	// Math goes FIRST: translation engines rewrite LaTeX when they see it
	// ("\frac{1}{5}" becomes "1/5", subscripts vanish), so $…$ / $$…$$ spans
	// are lifted into ⟦M n⟧ placeholders before any other rule runs.
	const text = extractMath(source, placeholders);
	// Ranges of `text` to replace: [start, end) with the rule-relative text.
	const ranges: { start: number; end: number; text: string }[] = [];

	for (const rule of MASK_RULES) {
		rule.lastIndex = 0;
		for (const m of text.matchAll(rule)) {
			if (m[0].length === 0) continue;
			let start = m.index;
			let end = start + m[0].length;
			let text = m[0];
			// Rules with capture groups (paths): mask only the captured path,
			// keep the leading boundary character in place.
			const groups = m.slice(1);
			if (groups.length > 0 && typeof groups[0] === "string" && m[0].includes(groups[0]) && groups[0] !== m[0]) {
				const offset = m[0].indexOf(groups[0]);
				if (offset > 0) {
					start += offset;
					end = start + groups[0].length;
					text = groups[0];
				}
			}
			// Skip any match overlapping an already-taken range: placeholders
			// can never nest, so single-pass restore is always complete.
			if (ranges.some((r) => start < r.end && r.start < end)) continue;
			ranges.push({ start, end, text });
		}
	}

	if (ranges.length === 0) return { masked: text, placeholders };

	ranges.sort((a, b) => a.start - b.start);
	let masked = "";
	let cursor = 0;
	let counter = 0;
	for (const r of ranges) {
		masked += text.slice(cursor, r.start);
		const token = `⟦${counter++}⟧`;
		placeholders.set(token, r.text);
		masked += token;
		cursor = r.end;
	}
	masked += text.slice(cursor);
	return { masked, placeholders };
}

/**
 * Restore placeholders in a translation.
 *
 * Pass 1 replaces the exact `⟦n⟧` form. Pass 2 optionally backfills tolerant
 * forms (⟦ n ⟧, 【n】) — but ONLY for numbers whose exact placeholder did not
 * survive pass 1 (requires the masked source). This keeps ordinary "[2]" or
 * "【1】" text in the source from being hijacked (fuzz finding, round 3).
 */
export function restore(target: string, placeholders: Map<string, string>, maskedSource?: string): string {
	const replaced = new Set<string>();
	// Both placeholder families: ⟦n⟧ (generic literals) and ⟦Mn⟧ (math).
	let out = target.replace(/⟦(M?\d+)⟧/g, (m, d) => {
		const orig = placeholders.get(`⟦${d}⟧`);
		if (orig === undefined) return m;
		replaced.add(String(d));
		return orig;
	});
	if (!maskedSource) return out;
	// Missing = tokens this mask defines that neither got replaced by pass 1
	// nor still appear verbatim. (Checking against the post-pass-1 text would
	// misread every successful replacement as "lost" — audit round 3.)
	const missing: string[] = [];
	for (const m of maskedSource.matchAll(/⟦(M?\d+)⟧/g)) {
		const n = m[1];
		if (!replaced.has(n) && !out.includes(m[0])) missing.push(m[0]);
	}
	for (const token of missing) {
		const d = token.slice(1, -1);
		const orig = placeholders.get(token);
		if (orig === undefined) continue;
		const esc = d.replace(/[M\d]/g, (c) => (c === "M" ? "M\\s*" : c)).replace(/\d+/, (ds) => ds.split("").join("\\s*"));
		// FUNCTION replacements: a string replacement would interpret "$$",
		// "$&" etc. in the literal as replacement patterns — every $$…$$
		// formula restored via the tolerant path lost one "$" per side
		// (fuzz round 8).
		out = out
			.replace(new RegExp(`⟦\\s*${esc}\\s*⟧`, "g"), () => orig)
			.replace(new RegExp(`【\\s*${esc}\\s*】`, "g"), () => orig);
	}
	return out;
}

/**
 * Find placeholder tokens present in the source but absent from the target.
 *
 * A token counts as present in ANY tolerated form — ⟦n⟧, ⟦ n ⟧, 【n】, 【 n 】.
 * Translation models frequently reshape the exotic ⟦⟧ brackets into fullwidth
 * 【】 while keeping the content intact; treating those as "lost" triggered a
 * pointless repair pass and then a false DEGRADED (round-11 finding: the
 * restore pass already handles these forms, only the loss DETECTION didn't).
 */
export function lostPlaceholders(sourceMasked: string, target: string): string[] {
	const tokens = [...sourceMasked.matchAll(/⟦(M?\d+)⟧/g)].map((m) => m[0]);
	const lost: string[] = [];
	for (const token of tokens) {
		const n = token.slice(1, -1);
		const present =
			target.includes(token) ||
			target.includes(`⟦ ${n} ⟧`) ||
			target.includes(`【${n}】`) ||
			target.includes(`【 ${n} 】`);
		if (!present) lost.push(token);
	}
	return lost;
}

/** LaTeX heuristics (mirrors the reader's md.js): a $-pair is math only
 * when its body carries LaTeX syntax — "$99" prices never match, so mixed
 * currency/LaTeX lines stay prices. */
const looksLikeLatex = (body: string): boolean => /[\\^_{}]|\\begin|\\frac/.test(body);

/** A display-math body must look like a formula: markdown headers, rules or
 * heavy CJK mean the "$$…$$" span is really prose between an orphaned
 * closer and the next real opener (same discipline as md.js). */
const looksLikeFormulaBody = (body: string): boolean => {
	if (/\n#{1,6}\s/.test(body)) return false;
	if (/\n(-{3,}|\*{3,})\s*$/.test(body)) return false;
	if (/^\s*(-{3,})\s*$/m.test(body)) return false;
	const cjk = (body.match(/[\u4e00-\u9fff]/g) ?? []).length;
	if (cjk > 2) return false;
	return true;
};

/** True when a display body carries actual math syntax (backslashes,
 * sub/superscripts, alignment operators). Prose spans between a stray $$
 * and the next real $$ must not be masked as one giant formula. */
const looksLikeLatexBlock = (body: string): boolean => /[\\^_{}&=<>]|\\begin|\\frac/.test(body);

/** Pair $-delimiters with skip-not-consume discipline: when a candidate
 * pair's body is not a formula, the opener is skipped WITHOUT consuming the
 * second delimiter, so a stray closer can never eat the next real opener's
 * partner. Display math runs first (its $$ would otherwise read as two
 * inline dollars), then latex-looking single-$ pairs. */
function extractMath(source: string, placeholders: Map<string, string>): string {
	let mCount = 0;
	const mToken = (literal: string): string => {
		const token = `⟦M${mCount++}⟧`;
		placeholders.set(token, literal);
		return token;
	};

	// --- display math ($$…$$) ---
	const dd: number[] = [];
	for (let k = 0; k < source.length; k++) {
		if (source[k] === "$" && source[k + 1] === "$" && source[k - 1] !== "\\") {
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
		const body = source.slice(a + 2, b);
		if (body.trim() !== "" && looksLikeFormulaBody(body) && looksLikeLatexBlock(body)) {
			out += source.slice(cursor, a) + mToken(source.slice(a, b + 2));
			cursor = b + 2;
			d += 2;
		} else {
			d += 1;
		}
	}
	out += source.slice(cursor);

	// --- inline math ($…$, latex-looking bodies only) ---
	const src = out;
	const singles: number[] = [];
	for (let k = 0; k < src.length; k++) {
		if (src[k] === "$" && src[k - 1] !== "\\" && src[k + 1] !== "$" && src[k - 1] !== "$") singles.push(k);
	}
	out = "";
	cursor = 0;
	d = 0;
	while (d + 1 < singles.length) {
		const a = singles[d];
		const b = singles[d + 1];
		const body = src.slice(a + 1, b);
		if (body.length > 0 && !body.includes("\n") && body.length <= 200 && looksLikeLatex(body)) {
			out += src.slice(cursor, a) + mToken(src.slice(a, b + 1));
			cursor = b + 1;
			d += 2;
		} else {
			d += 1;
		}
	}
	return out + src.slice(cursor);
}

/**
 * Clean engine output: strip code fences the model may have wrapped the
 * answer in, common "here is the translation" prefixes, leading labels and
 * surrounding blank lines.
 */
export function cleanEngineOutput(text: string): string {
	let out = text.replace(/\r\n/g, "\n").trim();
	// ```...``` wrap (possibly with a language tag)
	const fence = out.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
	if (fence) out = fence[1].trim();
	// Leading chatter line ("以下是翻译：", "Here is the translation:" etc.).
	// Length > 0 (not > 1): an answer that is ONLY chatter must clean to ""
	// so the queue treats it as malformed instead of a "translation".
	const chatter = /^(?:以下是翻译|以下是译文|这是翻译|翻译如下|译文如下|好的[,，]?翻译如下|here(?:'s| is) (?:the )?translation|translation)\s*[:：]?\s*$/i;
	let lines = out.split("\n");
	while (lines.length > 0 && chatter.test(lines[0].trim())) lines = lines.slice(1);
	out = lines.join("\n").trim();
	return out;
}
