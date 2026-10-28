/**
 * Language gate: decide whether a masked segment is worth translating.
 *
 * Runs after code/literal masking, before the engine call. Catches:
 * - pure Chinese segments (nothing to translate),
 * - short acknowledgements ("OK.", "Done."),
 * - segments that are symbols/numbers only.
 */

/** Count English-prose characters (letters in words that look like prose). */
export function englishProseChars(masked: string): number {
	let n = 0;
	const wordRe = /[A-Za-z][A-Za-z'-]*/g;
	for (const m of masked.matchAll(wordRe)) n += m[0].length;
	return n;
}

/** True when the text contains CJK characters. */
export function hasCjk(text: string): boolean {
	return /[一-鿿㐀-䶿⺀-⿿぀-ヿꀀ-꓿]/.test(text);
}

/**
 * Decide whether to translate. `masked` is the segment after code/literal
 * masking (placeholders in place). Returns true when translation should run.
 */
export function shouldTranslate(masked: string, minEnglishChars: number): boolean {
	// Placeholders carry real content (code/paths) — count each as a word of
	// mass instead of erasing it, so "The ⟦0⟧ flag controls ⟦1⟧ behavior…"
	// is not falsely gated as too-short when the prose is sparse but real.
	const withoutPlaceholders = masked.replace(/⟦\d+⟧/g, " codeblock ");
	const words = withoutPlaceholders.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
	// Ignore single letters used as list markers (a), b), I.)
	const proseWords = words.filter((w) => w.length >= 2);
	const proseChars = proseWords.reduce((n, w) => n + w.length, 0);
	if (proseChars < minEnglishChars) return false;
	// If the segment is already mostly Chinese prose, nothing to do.
	if (hasCjk(withoutPlaceholders)) {
		const cjk = (withoutPlaceholders.match(/[一-鿿]/g) ?? []).length;
		if (cjk * 2 > proseChars) return false;
	}
	return true;
}
