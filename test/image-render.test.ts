/**
 * r15b: markdown image rendering through the FULL pipeline.
 *
 * An image in assistant text must survive: segmentation → mask (URL →
 * placeholder) → translation (placeholder + structure intact) → restore →
 * renderMd (+ sanitize). Alt text MAY translate; the URL must not.
 */

import { describe, it, expect } from "vitest";
import { MessageSegmenter, type Segment } from "../src/segmenter.ts";
import { mask, restore, lostPlaceholders } from "../src/protect.ts";
import { renderMd } from "../src/web/md.js";

const OPTS = { kind: "text" as const, maxSegmentChars: 1200, minSegChars: 20 };

function pipeline(doc: string, translate: (s: string) => string): string {
	const seg = new MessageSegmenter(OPTS);
	const segments: Segment[] = [...seg.feed(doc), ...seg.flush()];
	const out = segments.map((s) => {
		const { masked, placeholders } = mask(s.src);
		let tgt = translate(masked);
		// placeholder repair mirrors the queue's one-pass fallback
		if (lostPlaceholders(masked, tgt).length > 0) tgt = masked;
		return restore(tgt, placeholders);
	});
	return renderMd(out.join("\n\n"));
}

describe("markdown images through the pipeline", () => {
	it("remote image: tag survives with original URL, alt may translate", () => {
		const html = pipeline(
			"Here is a screenshot of the failing build. Look at the error banner. \n![build error screenshot](https://example.com/img/build-error.png)",
			(s) => s.replace("Here is a screenshot of the failing build.", "这是失败构建的截图。"),
		);
		expect(html).toContain("<img");
		expect(html).toContain('src="https://example.com/img/build-error.png"');
		expect(html).toContain("这是失败构建的截图");
	});

	it("alt text with special characters stays quoted-safe", () => {
		const html = pipeline(
			"Diagram of the <b>queue</b> flow. It has stages. \n![queue flow: batch & retry](https://example.com/q.png)",
			(s) => s,
		);
		expect(html).toContain("<img");
		expect(html).toContain('src="https://example.com/q.png"');
	});

	it("data-URI image survives the sanitizer fallback (node env)", () => {
		const html = pipeline(
			"Tiny inline picture follows here for the test. \n![dot](data:image/png;base64,iVBORw0KGgo=)",
			(s) => s,
		);
		expect(html).toContain("<img");
		expect(html).toContain("data:image/png;base64,iVBORw0KGgo=");
	});

	it("a mangled placeholder (model swallowed the URL) falls back to source", () => {
		const html = pipeline(
			"Check this architecture diagram for the review. It shows the layers. \n![architecture](https://example.com/arch.png)",
			(s) => s.replace(/⟦\d+⟧/g, ""), // hostile translation drops placeholders
		);
		// repair path keeps the original image rather than losing it
		expect(html).toContain('src="https://example.com/arch.png"');
	});
});
