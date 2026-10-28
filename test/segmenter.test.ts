import { describe, it, expect } from "vitest";
import { MessageSegmenter, extractComments } from "../src/segmenter.ts";

const OPTS = { kind: "text" as const, maxSegmentChars: 1200 };

describe("MessageSegmenter (text)", () => {
	it("cuts at the earliest sentence boundary once min chars accumulate", () => {
		const s = new MessageSegmenter({ ...OPTS, minSegChars: 10 });
		const a = s.feed("The build failed. ");
		expect(a.map((x) => x.src)).toEqual(["The build failed."]);
		const b = s.feed("A race condition was detected in the loader module. ");
		expect(b.map((x) => x.src)).toEqual(["A race condition was detected in the loader module."]);
		expect(s.flush()).toHaveLength(0);
	});

	it("keeps short fragments buffered until min chars (no tiny segments)", () => {
		const s = new MessageSegmenter({ ...OPTS, minSegChars: 40 });
		const out = s.feed("OK. Done. ");
		expect(out).toHaveLength(0);
		expect(s.flush().map((x) => x.src)).toEqual(["OK. Done."]);
	});

	it("cuts on CJK sentence terminators without trailing space", () => {
		const s = new MessageSegmenter({ ...OPTS, minSegChars: 10 });
		const out = s.feed("配置文件解析失败，回退到默认值。下一步是重试。");
		expect(out.map((x) => x.src)).toEqual(["配置文件解析失败，回退到默认值。"]);
		expect(s.flush().map((x) => x.src)).toEqual(["下一步是重试。"]);
	});

	it("does not cut inside decimals or domains without a space after the dot", () => {
		const s = new MessageSegmenter({ ...OPTS, minSegChars: 10 });
		const out = s.feed("Version 3.5.2 of the parser at example.com handles it. ");
		// one segment, with decimals/domain intact (no mid-token cuts)
		expect(out.map((x) => x.src)).toEqual(["Version 3.5.2 of the parser at example.com handles it."]);
		expect(s.flush()).toHaveLength(0);
	});

	it("hard-cuts overlong segments at whitespace", () => {
		const s = new MessageSegmenter({ ...OPTS, maxSegmentChars: 60 });
		const out = s.feed("word ".repeat(30));
		expect(out.length).toBeGreaterThan(0);
		for (const seg of out) expect(seg.src.length).toBeLessThanOrEqual(65);
		s.flush();
	});

	it("lifts fenced code blocks out as code segments", () => {
		const s = new MessageSegmenter(OPTS);
		const out = s.feed("Here is the fix. ```ts\nconst x = 1;\nconst y = 2;\n``` Now apply it. ");
		const kinds = out.map((x) => x.kind);
		expect(kinds).toContain("code");
		const code = out.find((x) => x.kind === "code")!;
		expect(code.src).toContain("const x = 1;");
		expect(code.src.startsWith("```ts")).toBe(true);
		expect(code.lang).toBe("ts");
		expect(out.some((x) => x.kind === "text" && /Here is the fix/.test(x.src))).toBe(true);
	});

	it("detects fences split across deltas", () => {
		const s = new MessageSegmenter(OPTS);
		expect(s.feed("text before\n``")).toHaveLength(0);
		const prose = s.feed("`py\n");
		expect(prose.map((x) => x.kind)).toEqual(["text"]);
		const inCode = s.feed("print(1)\n");
		expect(inCode).toHaveLength(0);
		const done = s.feed("```\nafter code. ");
		const code = done.find((x) => x.kind === "code");
		expect(code?.src).toContain("print(1)");
		expect(code?.lang).toBe("py");
	});

	it("flush emits unclosed fence as a code segment after the prose", () => {
		const s = new MessageSegmenter(OPTS);
		const during = s.feed("intro\n```js\nlet a = 1;\n");
		expect(during.map((x) => x.kind)).toEqual(["text"]);
		const out = s.flush();
		expect(out.map((x) => x.kind)).toEqual(["code"]);
		expect(out[0].src).toContain("```js");
		expect(out[0].src).toContain("let a = 1;");
	});

	it("thinking kind cuts on blank lines only", () => {
		const s = new MessageSegmenter({ kind: "thinking", maxSegmentChars: 1200, minSegChars: 10 });
		s.feed("First I need to check the config. Then the loader. ");
		const out = s.feed("\n\nSecond paragraph now. ");
		expect(out).toHaveLength(1);
		expect(out[0].kind).toBe("thinking");
		expect(out[0].src).toContain("First I need to check");
		const tail = s.flush();
		expect(tail.map((x) => x.src)).toEqual(["Second paragraph now."]);
	});
});

describe("extractComments", () => {
	it("extracts // # and /* */ comments, skips urls and shebangs", () => {
		const code = [
			"#!/usr/bin/env node",
			"// line comment one",
			'const url = "https://example.com"; // trailing note',
			"# hash comment",
			"/* block",
			"   spanning */",
			"const x = 1;",
		].join("\n");
		const comments = extractComments(code);
		expect(comments).toContain("line comment one");
		expect(comments).toContain("trailing note");
		expect(comments).toContain("hash comment");
		expect(comments).toContain("block");
		expect(comments).toContain("spanning");
		expect(comments.some((c) => c.startsWith("!"))).toBe(false);
	});
});
