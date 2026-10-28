import { describe, it, expect } from "vitest";
import { mask, restore, lostPlaceholders, cleanEngineOutput } from "../src/protect.ts";
import { shouldTranslate, hasCjk } from "../src/langgate.ts";
import { parseBlocks } from "../src/engines/util.ts";

describe("protect: mask/restore round-trip", () => {
	it("masks inline code, urls, paths, identifiers and restores them", () => {
		const src = "Run `npm test` after fixing the bug in src/index.ts, see https://example.com/docs and TranslateQueue.retryFailed.";
		const { masked, placeholders } = mask(src);
		expect(masked).toMatch(/⟦\d+⟧/);
		expect(masked).not.toContain("npm test");
		expect(masked).not.toContain("https://example.com/docs");
		expect(masked).not.toContain("src/index.ts");
		const restored = restore(masked, placeholders);
		expect(restored).toBe(src);
	});

	it("masks snake_case and SCREAMING_SNAKE but leaves plain English prose", () => {
		const { masked } = mask("the max_retries flag uses MAX_RETRIES as its limit here");
		expect(masked).not.toContain("max_retries");
		expect(masked).not.toContain("MAX_RETRIES");
		expect(masked).toMatch(/\bthe\b/);
		expect(masked).toContain("flag uses");
		expect(masked).toContain("as its limit here");
	});

	it("restore tolerates spacing the model added (with masked source)", () => {
		const { masked, placeholders } = mask("keep `code` here");
		const token = [...placeholders.keys()][0];
		const n = token.match(/\d+/)![0];
		expect(restore(`前置 ⟦ ${n} ⟧ 后置`, placeholders, masked)).toBe("前置 `code` 后置");
		// tolerant forms never fire without the masked source (exact pass only)
		expect(restore(`前置 ⟦ ${n} ⟧ 后置`, placeholders)).toBe(`前置 ⟦ ${n} ⟧ 后置`);
	});

	it("plain [n] text in the source is never hijacked by restore", () => {
		const { masked, placeholders } = mask("list items [1] and [2] plus `code` token");
		// model echoed the text but dropped the code placeholder
		const target = masked.replace(/⟦\d+⟧/, "").replace(/\s+/, " ");
		const back = restore(target, placeholders, masked);
		// [1]/[2] stay literal; only the truly lost placeholder is gone
		expect(back).toContain("[1]");
		expect(back).toContain("[2]");
	});

	it("detects lost placeholders", () => {
		const { masked } = mask("keep `one` and `two` here");
		expect(lostPlaceholders(masked, "keep ⟦0⟧ and ⟦1⟧ here")).toEqual([]);
		expect(lostPlaceholders(masked, "keep ⟦0⟧ here")).toHaveLength(1);
	});

	it("cleanEngineOutput strips fences and chatter", () => {
		expect(cleanEngineOutput("```\n译文内容\n```")).toBe("译文内容");
		expect(cleanEngineOutput("Here is the translation:\n译文")).toBe("译文");
		expect(cleanEngineOutput("以下是翻译\n\n真正的译文\n")).toBe("真正的译文");
	});
});

describe("langgate", () => {
	it("passes English prose above the threshold", () => {
		expect(shouldTranslate("The build failed because of a race condition in the cache layer.", 40)).toBe(true);
	});

	it("rejects short acknowledgements", () => {
		expect(shouldTranslate("OK.", 40)).toBe(false);
		expect(shouldTranslate("Done. Thanks!", 40)).toBe(false);
	});

	it("rejects pure Chinese and symbol-only text", () => {
		expect(shouldTranslate("这是纯中文内容，无需翻译。", 40)).toBe(false);
		expect(shouldTranslate("``` ⟦0⟧ ...", 40)).toBe(false);
	});

	it("rejects mostly-Chinese mixed text", () => {
		expect(shouldTranslate("当 build 失败时请检查配置文件路径是否正确后再重试一次", 40)).toBe(false);
	});

	it("accepts mixed text dominated by English prose", () => {
		expect(shouldTranslate("这个 fix 解决了 the race condition in the shared state updater module.", 40)).toBe(true);
	});

	it("hasCjk detects CJK", () => {
		expect(hasCjk("中文")).toBe(true);
		expect(hasCjk("english")).toBe(false);
	});
});

describe("parseBlocks (batch protocol)", () => {
	it("parses well-formed numbered blocks", () => {
		const answer = "[1]\n第一段译文\n\n[2]\n第二段译文";
		expect(parseBlocks(answer, 2)).toEqual(["第一段译文", "第二段译文"]);
	});

	it("parses a single block", () => {
		expect(parseBlocks("[1]\nonly one", 1)).toEqual(["only one"]);
	});

	it("returns null when a block is missing", () => {
		expect(parseBlocks("[1]\nabc", 2)).toBeNull();
	});

	it("returns null when extra blocks appear", () => {
		expect(parseBlocks("[1]\nabc\n\n[2]\ndef\n\n[3]\nextra", 2)).toBeNull();
	});

	it("keeps multi-line blocks intact", () => {
		const answer = "[1]\nline one\nline two\n\n[2]\nb";
		expect(parseBlocks(answer, 2)).toEqual(["line one\nline two", "b"]);
	});
});
