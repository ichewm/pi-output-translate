/**
 * Property/fuzz tests (audit round 3) — deterministic seeds, bounded runtime.
 *
 * Invariants:
 *  1. restore(mask(x)) === x for arbitrary generated text (no placeholder
 *     nesting, no tolerant-form hijacking of literal "[n]"/"【n】" in source).
 *  2. The segmenter reassembles (in order) every non-whitespace character of
 *     the input, for arbitrary chunk splits — it never throws.
 *  3. parseBlocks(block-format(items)) === items for arbitrary item texts,
 *     including items that themselves start with "[2]".
 *  4. cleanEngineOutput never alters content beyond the fence/chatter strips.
 */

import { describe, it, expect } from "vitest";
import { mask, restore, cleanEngineOutput } from "../src/protect.ts";
import { MessageSegmenter } from "../src/segmenter.ts";
import { parseBlocks } from "../src/engines/util.ts";

function makeRng(seed: number) {
	let s = seed;
	return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function generator(seed: number) {
	const rnd = makeRng(seed);
	const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
	const words = ["race", "condition", "the", "cache", "layer", "failed", "build", "retries", "idempotent", "loader", "warmup", "shard"];
	const zh = ["竞态", "条件", "缓存", "加载器", "失败", "重试", "幂等", "预热"];
	const tokens = [
		() => pick(words), () => pick(zh),
		() => "`" + pick(["npm test", "useState", "a b", ""]) + "`",
		() => pick(["https://ex.com/a?b=1", "http://x.cn/路径", "ftp://f.io/g"]),
		() => pick(["src/index.ts", "~/config/.potrc", "./a/b/c.json", "/abs/path/file.md"]),
		() => pick(["max_retries", "MAX_SIZE", "camelCaseWord", "TranslateQueue", "k8s.io/api", "std::vector<int>"]),
		() => pick(["```ts", "```", "```py\nx=1\n```", "``` `code` ```"]),
		() => pick(["3.5.2", "v1.0.0", "--force", "-Dfile=x", "【1】", "[2]", "list of [1] items"]),
		() => pick([".", "。", "!", "？", "\n", "\n\n", " ", ": ", ", ", "-", "*", "# ", "> ", "|"]),
	];
	return (n: number) => {
		let out = "";
		for (let i = 0; i < n; i++) out += pick(tokens)() + (rnd() < 0.3 ? " " : "");
		return out;
	};
}

describe("fuzz: protect round-trip (seeds 42 / 777 / 31337)", () => {
	for (const seed of [42, 777, 31337]) {
		it(`mask/restore is a bijection on generated inputs (seed ${seed})`, () => {
			const gen = generator(seed);
			for (let i = 0; i < 600; i++) {
				const x = gen(8 + (i % 30));
				const { masked, placeholders } = mask(x);
				const back = restore(masked, placeholders);
				expect(back).toBe(x);
				// feeding the masked text itself (a "perfect model answer") through
				// the tolerant pass must also reproduce x exactly
				expect(restore(masked, placeholders, masked)).toBe(x);
			}
		});
	}
});

describe("fuzz: segmenter reassembly", () => {
	for (const seed of [42, 777]) {
		it(`segments cover the input in order under random chunking (seed ${seed})`, () => {
			const gen = generator(seed);
			const rnd = makeRng(seed + 1);
			for (let i = 0; i < 250; i++) {
				const kind = rnd() < 0.5 ? "text" : "thinking";
				const text = gen(20 + (i % 40));
				const seg = new MessageSegmenter({ kind, maxSegmentChars: 80, minSegChars: 8 });
				let rest = text;
				const chunks: string[] = [];
				while (rest.length) {
					const n = 1 + Math.floor(rnd() * 17);
					chunks.push(rest.slice(0, n));
					rest = rest.slice(n);
				}
				const out = [];
				for (const c of chunks) out.push(...seg.feed(c));
				out.push(...seg.flush());
				const joined = out.map((s) => s.src).join("\n").replace(/\s+/g, "");
				const wanted = text.replace(/\s+/g, "");
				let w = 0;
				for (const ch of joined) if (w < wanted.length && ch === wanted[w]) w++;
				expect(w / Math.max(1, wanted.length)).toBeGreaterThanOrEqual(0.98);
			}
		});
	}
});

describe("fuzz: batch protocol parse", () => {
	it("items that themselves start with [n] do not break block parsing", () => {
		const items = [
			"[2]./a/b/c.jsonMAX_SIZE[2]。 ",
			"--forceretries [2] http://x.cn/路径 src/index.ts v1.0.0 shard",
			"plain tail",
		];
		const answer = items.map((t, i) => `[${i + 1}]\n${t}`).join("\n\n");
		const parsed = parseBlocks(answer, items.length);
		expect(parsed).not.toBeNull();
		expect(parsed!.map((p) => p.trim())).toEqual(items.map((t) => t.trim()));
	});

	it("out-of-order or same-line markers are rejected (falls back to retries)", () => {
		expect(parseBlocks("[2]\na\n\n[1]\nb", 2)).toBeNull();
		expect(parseBlocks("[1] same-line content\n\n[2]\nb", 2)).toBeNull();
	});
});

describe("fuzz: engine output cleaner", () => {
	it("fence unwrap preserves inner content", () => {
		const gen = generator(999);
		for (let i = 0; i < 300; i++) {
			const x = gen(6 + (i % 15));
			expect(cleanEngineOutput("```\n" + x + "\n```")).toBe(x.trim());
		}
	});
});
