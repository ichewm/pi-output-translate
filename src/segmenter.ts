/**
 * Streaming segmenter: turns token deltas into immutable translation units.
 *
 * One instance per (message, contentIndex, kind). Feed deltas as they arrive
 * from message_update events; segments pop out as soon as they are certainly
 * complete. Pure in-memory string work — safe to call from O(1) collectors.
 *
 * Kinds:
 * - "text":     cut on sentence boundaries / blank lines; fenced code blocks
 *               are lifted out as their own "code" segments (never translated).
 * - "thinking": cut on blank lines only (coarser), same max-length clamp.
 *
 * Fence handling is tuned for LLM streams, not strict CommonMark:
 * - an opening fence may appear mid-line ("Here is the fix. ```ts"),
 * - a closing fence may carry trailing prose ("``` Now apply it."),
 * - fence markers may split across deltas ("``" + "`py\n").
 */

export interface SegmenterOptions {
	kind: "text" | "thinking";
	maxSegmentChars: number;
	/** Minimum chars before a sentence cut is taken (avoid tiny fragments). */
	minSegChars?: number;
}

export interface Segment {
	kind: "text" | "thinking" | "code";
	src: string;
	/** Fence language hint for code segments. */
	lang?: string;
	/** True when this segment STARTS a new paragraph (blank-line boundary) —
	 * the reader page breaks its inline prose run here so distinct paragraphs
	 * don't visually merge. */
	paraStart?: boolean;
}

const DEFAULT_MIN_SEG = 20;

/** Common abbreviations whose trailing period is NOT a sentence end. */
const ABBREV_BEFORE_DOT = /(?:[\s(](?:e\.g|i\.e|etc|vs|cf|al|approx|ca|Fig|Figs|Eq|Eqs|pp|vol|no|No|ch|sec|min|max|dept|univ|inc|ltd|corp|St|Dr|Prof|Mr|Mrs|Ms|Jr|Sr|Ed|eds|resp|resp\.|viz|et al))\.?$/i;

/** Western sentence cut: terminator + optional closing quote + whitespace/end.
 * CJK terminators cut immediately (no trailing space in Chinese). */
const SENTENCE_CUT_RE = /(?:[.!?…]["'”’)\]]*(?:\s|$)|[。！？][”」』】）)]*|[:：](?=\n))/g;

/** Opening fence anywhere on a line (LLMs often write "text. ```ts\n").
 * Group 1 = marker, group 2 = language hint. */
const FENCE_OPEN_LINE = /(```+|~~~+)([^\n`]*)\n/;
/** Tail of buf that may still grow into a fence-open line ("``", " ```ts"). */
const PARTIAL_FENCE_TAIL = /(?:^|\s)( {0,3}(?:`+|~+)[^\n]*)$/;
/** Same, but for fences inside blockquote / list lines ("> ``", "- ```"): the
 *  quote/list markers must be held back WITH the backticks or the streaming
 *  split loses the "> " context and the fence would read as bare. */
const PARTIAL_INLINE_FENCE_TAIL = /(?:^|\n)( {0,3}(?:>\s*|[-*+]\s|\d{1,9}\.\s)+[`~]+[^\n]*)$/;
/** A trailing markers-only line ("> ", "- ") may still grow into an inline
 *  fence line; holding it keeps the markers glued to their backticks when a
 *  delta boundary falls between "> " and "```" (that split used to commit
 *  the "> " to prose and open a REAL code block at the then-bare fence).
 *  Both patterns anchor at a LINE start of the (possibly multi-line) buf. */
const PARTIAL_INLINE_MARKER_TAIL = /(?:^|\n)( {0,3}(?:>\s*|[-*+]\s|\d{1,9}\.\s)+)$/;
/** Line prefixes that keep a fence INLINE (blockquote / list items): "> ",
 *  "- ", "1. " markers, possibly stacked (nested quotes / lists). */
const INLINE_FENCE_PREFIX = /^\s{0,3}(?:>\s*|[-*+]\s|\d{1,9}\.\s)+$/;
const CLOSE_FENCE_LINE = /^ {0,3}(```+|~~~+)[ \t]*([^\n]*)\n$/;

export class MessageSegmenter {
	private readonly opts: Required<SegmenterOptions>;
	private mode: "prose" | "code" = "prose";
	/** Unprocessed raw text (partial lines / pending code lines). */
	private buf = "";
	/** Prose accumulation; sentence cuts happen here. */
	private prose = "";
	private codeBuf = "";
	private codeLang = "";
	private fenceMarker = "";
	/** True while a marker-adjacent fence ("> ```" / "- ```") is open INSIDE
	 *  prose: the next fence line (bare or prefixed) closes it instead of
	 *  opening a real code block that would swallow the rest. */
	private inlineFenceOpen = false;
	private done = false;
	private atParagraphStart = false;

	constructor(opts: SegmenterOptions) {
		this.opts = { minSegChars: DEFAULT_MIN_SEG, ...opts };
	}

	/** Feed a delta; returns segments that became complete. */
	feed(delta: string): Segment[] {
		this.assertOpen();
		this.buf += delta;
		const out: Segment[] = [];
		let progressed = true;
		let guard = 0;
		while (progressed && guard++ < 10_000) {
			progressed = false;
			if (this.mode === "prose") {
				progressed = this.proseStep(out);
			} else {
				progressed = this.codeStep(out);
			}
		}
		// A partial line that starts like a closing fence with trailing prose
		// ("``` Now apply it." without newline yet) closes the block early.
		// The tail must be actual prose (contains whitespace): "```js" without
		// its newline yet is an inner OPENING fence of a longer block, not a
		// close — waiting for the newline lets codeStep classify it properly.
		if (this.mode === "code" && this.buf !== "") {
			const partial = this.buf.match(/^ {0,3}(```+|~~~+)[ \t]*(.+)$/s);
			if (
				partial &&
				partial[1].length >= this.fenceMarker.length &&
				partial[1][0] === this.fenceMarker[0] &&
				/\s/.test(partial[2]) &&
				!/^[`~\s]*$/.test(partial[2])
			) {
				this.codeBuf += partial[1] + "\n";
				out.push(this.takeCode());
				this.prose += partial[2] + "\n";
				this.buf = "";
				this.cutSentences(out);
			}
		}
		return out;
	}

	/** Final flush at message_end; returns the remaining segments. */
	flush(): Segment[] {
		this.assertOpen();
		const out: Segment[] = [];
		if (this.mode === "code") {
			this.codeBuf += this.buf;
			this.buf = "";
			out.push(this.takeCode());
		} else {
			// A leftover partial fence-open line ("```ts" without newline) is code —
			// but only AFTER any pending prose that precedes it in the stream
			// (audit round 3: flush used to emit code first, reversing the
			// document order of "prose```unclosed-code" endings).
			const partialOpen = this.buf.match(/^( {0,3})(```+|~~~+)([^\n]*)$/);
			if (partialOpen) {
				this.cutSentences(out, true);
				if (this.prose.trim() !== "") {
					out.push({ kind: this.opts.kind, src: this.prose.trim() });
					this.prose = "";
				}
				const src = this.codeFromPartial(partialOpen);
				this.buf = "";
				out.push({ kind: "code", src, lang: partialOpen[3].trim() || undefined });
			} else {
				this.prose += this.buf;
				this.buf = "";
			}
		}
		this.cutSentences(out, true);
		if (this.prose.trim() !== "") {
			const tailPara = this.atParagraphStart || /^\s*\n/.test(this.prose);
			out.push({ kind: this.opts.kind, src: this.prose.trim(), paraStart: tailPara || undefined });
			this.prose = "";
		}
		this.atParagraphStart = true; // a new message/content block starts fresh
		this.done = true;
		return out;
	}

	private codeFromPartial(m: RegExpMatchArray): string {
		return `${m[1] ?? ""}${m[2]}${m[3] ?? ""}\n`;
	}

	private assertOpen(): void {
		if (this.done) throw new Error("segmenter already flushed");
	}

	/** Returns true when something was consumed (caller re-loops). */
	private proseStep(out: Segment[]): boolean {
		const m = FENCE_OPEN_LINE.exec(this.buf);
		if (m && m.index !== undefined) {
			const lineStart = this.buf.lastIndexOf("\n", m.index - 1) + 1;
			const prefix = this.buf.slice(lineStart, m.index);
			// Fences inside blockquote / list lines ("> ```", "- ```") stay
			// prose: CommonMark renders them INSIDE the quote/item, and their
			// prefixed closers can never match the bare-line close shape —
			// lifting them out used to swallow everything after the quote into
			// one unterminated code segment (field report round 7).
			if (prefix.trim() !== "" && INLINE_FENCE_PREFIX.test(prefix)) {
				const lineEnd = m.index + m[0].length; // includes the "\n"
				this.prose += this.buf.slice(0, lineEnd);
				this.buf = this.buf.slice(lineEnd);
				this.inlineFenceOpen = !this.inlineFenceOpen; // open <-> close
				this.cutSentences(out); // "> "-lines are cut-guarded anyway
				return true;
			}
			// A BARE fence line right after a marker-adjacent opener is its
			// closer ("- ```js\ncode\n```"): without this it would re-open as
			// a real code block and swallow the document tail.
			if (this.inlineFenceOpen && prefix.trim() === "") {
				const lineEnd = m.index + m[0].length;
				this.prose += this.buf.slice(0, lineEnd);
				this.buf = this.buf.slice(lineEnd);
				this.inlineFenceOpen = false;
				this.cutSentences(out);
				return true;
			}
			// Prose up to the fence marker (may be mid-line).
			this.prose += this.buf.slice(0, m.index);
			// Hard emit all pending prose at the code boundary.
			if (this.prose.trim() !== "") out.push({ kind: this.opts.kind, src: this.prose.trim() });
			this.prose = "";
			const fenceLineEnd = m.index + m[0].length;
			this.mode = "code";
			// Keep the FULL marker: a ````-opened block only closes at a fence
			// of >= 4 backticks (CommonMark). Slicing to 3 made every inner ```
			// fence (think blocks that embed ```js snippets) close the outer
			// block early and spill its body into prose.
			this.fenceMarker = m[1];
			this.codeLang = m[2].trim();
			this.codeBuf = this.buf.slice(m.index, fenceLineEnd);
			this.buf = this.buf.slice(fenceLineEnd);
			return true;
		}
		// No complete fence line: commit everything except a possible partial
		// fence-open tail (so "``" + "`py\n" is detected on the next feed).
		// Quote/list-prefixed tails hold their markers back too.
		let commit = this.buf;
		const inlineFenceHold = commit.match(PARTIAL_INLINE_FENCE_TAIL);
		const inlineMarkerHold = commit.match(PARTIAL_INLINE_MARKER_TAIL);
		const hold = commit.match(PARTIAL_FENCE_TAIL);
		if (inlineFenceHold) commit = commit.slice(0, commit.length - inlineFenceHold[1].length);
		else if (inlineMarkerHold) commit = commit.slice(0, commit.length - inlineMarkerHold[1].length);
		else if (hold) commit = commit.slice(0, commit.length - hold[1].length);
		this.prose += commit;
		this.buf = this.buf.slice(commit.length);
		this.cutSentences(out);
		return false;
	}

	/** Consume complete code lines; detect the close fence. */
	private codeStep(out: Segment[]): boolean {
		const nl = this.buf.indexOf("\n");
		if (nl === -1) return false; // wait for the line to finish
		const line = this.buf.slice(0, nl + 1);
		const cm = line.match(CLOSE_FENCE_LINE);
		// Close rules (CommonMark-ish, streaming-tolerant): the marker must be
		// at least as long as the opening fence and the same character. A
		// single-token tail ("```js") is an inner OPENING fence, never a close;
		// a multi-word tail ("``` Now apply it.") is the known LLM close-with-
		// trailing-prose shape; bare backticks-only tails are plain closes.
		const tail = (cm?.[2] ?? "").trim();
		const closes =
			!!cm &&
			cm[1].length >= this.fenceMarker.length &&
			cm[1][0] === this.fenceMarker[0] &&
			(tail === "" || /^[`~]+$/.test(tail) || /\s/.test(tail));
		if (closes) {
			this.codeBuf += cm![1] + "\n";
			out.push(this.takeCode());
			const trailing = (cm![2] ?? "").trim();
			this.buf = this.buf.slice(nl + 1);
			this.mode = "prose";
			if (trailing !== "" && !/^[`~]+$/.test(trailing)) {
				this.prose += trailing + "\n";
			}
			return true;
		}
		this.codeBuf += line;
		this.buf = this.buf.slice(nl + 1);
		return true;
	}

	private takeCode(): Segment {
		const seg: Segment = {
			kind: "code",
			src: this.codeBuf.trimEnd() + "\n",
			lang: this.codeLang || undefined,
		};
		this.codeBuf = "";
		this.codeLang = "";
		this.mode = "prose";
		return seg;
	}

	/** Cut completed sentences off the front of prose. `hard` also flushes the remainder. */
	private cutSentences(out: Segment[], hard = false): void {
		const max = this.opts.maxSegmentChars;
		for (;;) {
			if (this.prose.length > max) {
				const idx = this.hardCutIndex(max);
				const head = this.prose.slice(0, idx);
				this.prose = this.prose.slice(idx).replace(/^\s+/, "");
				if (head.trim() !== "") {
					const pStart = this.atParagraphStart || /^\s*\n/.test(head);
					out.push({ kind: this.opts.kind, src: head.trim(), paraStart: pStart || undefined });
				}
				continue;
			}
			const cut = this.findSentenceCut();
			if (cut === -1) {
				if (hard && this.prose.trim() !== "") {
					const pStart = this.atParagraphStart || /^\s*\n/.test(this.prose);
					out.push({ kind: this.opts.kind, src: this.prose.trim(), paraStart: pStart || undefined });
					this.prose = "";
				}
				return;
			}
			const head = this.prose.slice(0, cut);
			const rest = this.prose.slice(cut);
			// Paragraph boundary state machine: a boundary at THIS cut point
			// means the NEXT emitted segment opens a new paragraph. The
			// terminator's match may swallow a space or the first newline of
			// the blank line, so accept either shape.
			const boundary = /\n\s*$/.test(head) || /^(\s*\n){2}|^\s*\n\s*$/.test(rest);
			// streaming window: the blank line may arrive AFTER the previous
			// cut emitted — this head itself starting with a blank line marks
			// the new paragraph.
			const paraStart = this.atParagraphStart || /^\s*\n/.test(head);
			this.atParagraphStart = boundary;
			this.prose = rest.replace(/^\s+/, "");
			if (head.trim() !== "") out.push({ kind: this.opts.kind, src: head.trim(), paraStart });
			if (!hard) return;
			if (!hard) return;
		}
	}

	/** Index just past the earliest safe sentence cut at or after minSegChars; -1 when none. */
	private findSentenceCut(): number {
		const min = this.opts.minSegChars;
		if (this.opts.kind === "text") {
			SENTENCE_CUT_RE.lastIndex = 0;
			for (const m of this.prose.matchAll(SENTENCE_CUT_RE)) {
				const idx = m.index + m[0].length;
				if (idx < min) continue;
				// Markdown-structure guard: a cut that lands INSIDE a table row
				// (a line containing pipes) or a blockquote line would split
				// the row across segments and destroy the table before the
				// translator ever sees it.
				if (this.insideStructuredLine(idx)) continue;
				// Numbering guard: "4. Code" / "1. item" / "A4. Footnotes" /
				// "G2. Display" — a period directly after a short (optionally
				// letter-prefixed) ordinal is a heading/list label, not a sentence
				// end. Cutting there shreds headings apart. (\b\d alone missed
				// "A4.": no word boundary exists between "A" and "4".)
				if (
					/(?:^|[\s(#])[A-Za-z]?\d{1,3}\.?$/.test(this.prose.slice(Math.max(0, m.index - 6), m.index + 1).trimEnd()) &&
					/\d\.\s*$/.test(this.prose.slice(0, m.index + 1))
				) continue;
				// Abbreviation guard: "e.g." / "vs." / "i.e." / "etc." are not
				// sentence ends — cutting mid-clause shreds the sentence.
				if (ABBREV_BEFORE_DOT.test(this.prose.slice(Math.max(0, m.index - 6), m.index))) continue;
				return idx;
			}
			return -1;
		}
		// thinking: blank-line cuts only
		for (let i = min; i < this.prose.length - 1; i++) {
			if (this.prose[i] === "\n" && this.prose[i + 1] === "\n") return i + 2;
		}
		return -1;
	}

	/** True when `pos` sits strictly inside a structured line: table rows,
	 * blockquotes, headings, or lines carrying LaTeX math delimiters ($ / $$)
	 * — a cut inside "$79.20" or an aligned block would shatter the formula.
	 * Multi-line $$ blocks have interior lines WITHOUT "$", so the parity of
	 * the $$ count before the line is checked as well. */
	private insideStructuredLine(pos: number): boolean {
		const lineStart = this.prose.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
		const nl = this.prose.indexOf("\n", pos);
		const lineEnd = nl === -1 ? this.prose.length : nl;
		const line = this.prose.slice(lineStart, lineEnd);
		if (line.includes("|")) return true;
		if (/^\s*>/.test(line)) return true;
		if (line.includes("$")) return true;
		if (/^\s{0,3}#{1,6}\s/.test(line)) return true;
		const dollars = (this.prose.slice(0, lineStart).match(/\$\$/g) ?? []).length;
		if (dollars % 2 === 1) return true;
		return false;
	}

	/** Structure-aware hard cut for overlong prose. Never slices mid-line:
	 * prefer a paragraph boundary, then any line start — both outside $$
	 * spans — and only fall back to a space cut for single-line pathological
	 * input. (Field report round 6: the old plain-space cut sliced $$ blocks
	 * and aligned environments in half, so the page showed half a formula
	 * plus a run of raw LaTeX.) Overshoot past the cap is bounded at 2x. */
	private hardCutIndex(max: number): number {
		const prose = this.prose;
		const evenDollars = (pos: number): boolean =>
			((prose.slice(0, pos).match(/\$\$/g) ?? []).length & 1) === 0;
		let bestAny = -1;
		let bestPara = -1;
		for (let i = prose.indexOf("\n"); i !== -1 && i + 1 <= max; i = prose.indexOf("\n", i + 1)) {
			const p = i + 1;
			if (!evenDollars(p)) continue;
			bestAny = p;
			if (i >= 1 && prose[i - 1] === "\n") bestPara = p;
		}
		if (bestPara > 0) return bestPara;
		if (bestAny > 0) return bestAny;
		for (let i = prose.indexOf("\n", max); i !== -1; i = prose.indexOf("\n", i + 1)) {
			if (i + 1 > max * 2) break;
			if (evenDollars(i + 1)) return i + 1;
		}
		for (let i = Math.min(max, prose.length) - 1; i > max / 2; i--) {
			if (/\s/.test(prose[i]) && evenDollars(i)) return i + 1;
		}
		return Math.min(max, prose.length);
	}
}

/**
 * Extract comment lines from a fenced code block (for codeComments:"below").
 * Returns the comment text without comment markers.
 */
export function extractComments(code: string): string[] {
	const comments: string[] = [];
	const lines = code.split("\n");
	let inBlock = false;
	for (const line of lines) {
		if (inBlock) {
			const end = line.indexOf("*/");
			if (end === -1) {
				comments.push(line.trim());
			} else {
				comments.push(line.slice(0, end).trim());
				inBlock = false;
			}
			continue;
		}
		const blockStart = line.match(/\/\*(.*)$/);
		if (blockStart) {
			const rest = blockStart[1];
			const end = rest.indexOf("*/");
			if (end >= 0) {
				const text = rest.slice(0, end).trim();
				if (text) comments.push(text);
			} else {
				if (rest.trim()) comments.push(rest.trim());
				inBlock = true;
			}
			continue;
		}
		const lineComment = line.match(/(?:^|\s)(?:\/\/|#|<!--|;;|--)\s?(.*)$/);
		if (lineComment && lineComment[1].trim() !== "") {
			const text = lineComment[1].replace(/-->$/, "").trim();
			if (text) comments.push(text);
		}
	}
	// Drop shebangs and url fragments (// inside strings is common; heuristics only).
	return comments.filter((c) => !c.startsWith("!") && !/^https?:/.test(c) && c.length > 2);
}
