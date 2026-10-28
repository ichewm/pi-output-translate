import { describe, it, expect, vi } from "vitest";
import { TranslateQueue, type QResult } from "../src/queue.ts";
import { TranslateCache } from "../src/cache.ts";
import { defaultConfig, type OutputTranslateConfig } from "../src/config.ts";
import type { TranslateEngine } from "../src/types.ts";
import { mask } from "../src/protect.ts";

/** Engine mock: configurable per-call behavior via a queue of responses. */
class MockEngine implements TranslateEngine {
	readonly id = "mock";
	calls: { system: string; user: string }[] = [];
	handlers: Array<(user: string) => string | Promise<string>> = [];
	failNextBatches = 0;

	onComplete(fn: (user: string) => string | Promise<string>): void {
		this.handlers.push(fn);
	}

	/** Answer in the protocol the queue expects for this user prompt:
	 * plain text for single-segment prompts, numbered blocks otherwise. */
	static answerFor(user: string, translate: (src: string) => string): string {
		const blocks = [...user.matchAll(/^\[(\d+)\][ \t]*\n?([\s\S]*?)(?=^\[\d+\][ \t]*$|$)/gm)]
			.filter((m) => !m[0].startsWith("[前文"));
		if (blocks.length === 0) {
			// plain mode: extract the source after the last blank-line separator
			const tail = user.split("\n\n").pop() ?? user;
			return translate(tail.trim());
		}
		return blocks.map((m, i) => `[${i + 1}]\n${translate(m[2].trim())}`).join("\n\n");
	}

	async complete(system: string, user: string): Promise<string> {
		this.calls.push({ system, user });
		if (this.failNextBatches > 0) {
			this.failNextBatches--;
			throw new Error("engine boom");
		}
		const h = this.handlers[Math.min(this.calls.length - 1, this.handlers.length - 1)];
		return h ? await h(user) : MockEngine.answerFor(user, (src) => `【译】${src.slice(0, 12)}`);
	}

	async healthCheck(): Promise<boolean> {
		return true;
	}
}

function setup(overrides?: Partial<OutputTranslateConfig>, engine: TranslateEngine = new MockEngine()) {
	const cfg: OutputTranslateConfig = { ...defaultConfig(), ...overrides };
	const results: QResult[] = [];
	const cache = new TranslateCache(100, null);
	const queue = new TranslateQueue({
		getEngine: () => engine,
		glossaryVersion: () => "test",
		cache,
		getConfig: () => cfg,
		glossaryText: () => "race condition → 竞态条件",
		getSessionCtx: () => ({ recent: [], termLockLines: "" }),
		recordTranslation: () => {},
		viewerCount: () => 1,
		isMuted: () => false,
		onResult: (r) => results.push(r),
	});
	return { queue, engine, results, cfg, cache };
}

function item(segId: string, src: string, kind: "text" | "thinking" | "comment" = "text") {
	const { masked, placeholders } = mask(src);
	return { segId, sessionId: "s1", messageKey: "1", kind, source: src, masked, placeholders };
}

describe("TranslateQueue", () => {
	it("batches multiple segments into one numbered-block engine call", async () => {
		const e = new MockEngine();
		e.onComplete((user) => MockEngine.answerFor(user, (src) => `译文:${src.slice(0, 8)}`));
		const { queue, results } = setup({}, e);
		queue.enqueue(item("a", "first sentence to translate. here.", "text"));
		queue.enqueue(item("b", "second sentence also long enough. yes.", "text"));
		await queue.flushNow();
		expect(e.calls.length).toBe(1); // one batch
		const done = results.filter((r) => r.st === "done");
		expect(done.map((r) => r.segId).sort()).toEqual(["a", "b"]);
		expect(done[0].tgt).toContain("译文");
	});

	it("batch failure falls back to per-item retry once, then failed", async () => {
		const e = new MockEngine();
		e.onComplete((user) => MockEngine.answerFor(user, () => "好"));
		const { queue, results } = setup({}, e);
		e.failNextBatches = 1; // first (batch) call fails; single retries succeed
		queue.enqueue(item("a", "first sentence to translate here.", "text"));
		await queue.flushNow();
		expect(e.calls.length).toBe(2); // batch + single retry
		expect(results.find((r) => r.segId === "a")?.st).toBe("done");
	});

	it("persistent failure marks failed and allows manual retry", async () => {
		const e = new MockEngine();
		const { queue, results } = setup({}, e);
		// Both the batch and its single-item retry answer with pure chatter,
		// which now cleans to empty -> malformed -> failed.
		e.onComplete(() => "以下是翻译\n\n");
		queue.enqueue(item("x", "a sentence that will fail to translate.", "text"));
		await queue.flushNow();
		expect(results[0].st).toBe("failed");
		// manual retry after the operator fixes the engine (replace handler 0)
		e.handlers[0] = (user: string) => MockEngine.answerFor(user, () => "修好了");
		expect(queue.retry("x")).toBe(true);
		await queue.flushNow();
		const final = results.filter((r) => r.segId === "x");
		expect(final[final.length - 1].st).toBe("done");
	});

	it("cache hit short-circuits to cached without engine call", async () => {
		const e = new MockEngine();
		e.onComplete((user) => MockEngine.answerFor(user, () => "缓存译文"));
		const { queue, results, cache } = setup({}, e);
		const it1 = item("c1", "identical sentence appears twice in stream. yes.", "text");
		queue.enqueue(it1);
		await queue.flushNow();
		expect(e.calls.length).toBe(1);
		// same masked source -> same key
		const it2 = item("c2", "identical sentence appears twice in stream. yes.", "text");
		expect(cache.get(cacheKey(it2.masked))).toBe("缓存译文");
		queue.enqueue(it2);
		await queue.flushNow();
		expect(e.calls.length).toBe(1); // no new call
		const cached = results.find((r) => r.segId === "c2");
		expect(cached?.st).toBe("cached");
		expect(cached?.tgt).toBe("缓存译文");
	});

	it("placeholder loss triggers repair, then degrade", async () => {
		const e = new MockEngine();
		let call = 0;
		e.onComplete((user) => {
			call++;
			if (call === 1) return MockEngine.answerFor(user, () => "译文丢失了占位符");
			if (call === 2) return MockEngine.answerFor(user, () => "修复后仍然没有占位符");
			return "修复成功 ⟦0⟧";
		});
		const { queue, results } = setup({}, e);
		queue.enqueue(item("p", "keep `the_code` inside this sentence please ok.", "text"));
		await queue.flushNow();
		// batch lost it, repair lost it again -> degraded with source fallback
		const r = results.find((x) => x.st === "degraded");
		expect(r).toBeTruthy();
		expect(r!.tgt).toBe("keep `the_code` inside this sentence please ok.");
	});

	it("placeholder repair can succeed on the second pass", async () => {
		const e = new MockEngine();
		let call = 0;
		e.onComplete((user) => {
			call++;
			return call === 1 ? MockEngine.answerFor(user, () => "丢失") : "修复后 ⟦0⟧ 出现了";
		});
		const { queue, results } = setup({}, e);
		queue.enqueue(item("q", "keep `mycode` inside this sentence please ok.", "text"));
		await queue.flushNow();
		const r = results.find((x) => x.segId === "q");
		expect(r?.st).toBe("done");
		expect(r?.tgt).toContain("`mycode`");
	});

	it("idle text-only skips thinking but translates text", async () => {
		const e = new MockEngine();
		e.onComplete(() => "[1]\n译文");
		const cfg = { idle: { noViewerBehavior: "text-only" as const } };
		const { queue, results } = setup(cfg, e);
		const deps = { viewerCount: () => 0 };
		void deps;
		// force zero viewers
		(queue as unknown as { d: { viewerCount: () => number } }).d.viewerCount = () => 0;
		queue.enqueue(item("t1", "a normal text segment long enough ok.", "text"));
		queue.enqueue(item("t2", "thinking content long enough to pass gate.", "thinking"));
		await queue.flushNow();
		expect(results.find((r) => r.segId === "t1")?.st).toBe("done");
		expect(results.find((r) => r.segId === "t2")?.st).toBe("skipped");
		expect(results.find((r) => r.segId === "t2")?.rsn).toBe("idle");
	});

	it("idle none skips everything", async () => {
		const { queue, results } = setup({ idle: { noViewerBehavior: "none" as const } });
		(queue as unknown as { d: { viewerCount: () => number } }).d.viewerCount = () => 0;
		queue.enqueue(item("n1", "a normal text segment long enough ok.", "text"));
		await queue.flushNow();
		expect(results[0].st).toBe("skipped");
		expect(results[0].rsn).toBe("idle");
	});

	it("muted session is skipped with reason", async () => {
		const { queue, results } = setup();
		(queue as unknown as { d: { isMuted: () => boolean } }).d.isMuted = () => true;
		queue.enqueue(item("m1", "a normal text segment long enough ok.", "text"));
		await queue.flushNow();
		expect(results[0].rsn).toBe("muted");
	});

	it("backpressure drops thinking first", async () => {
		const e = new MockEngine();
		e.onComplete(() => "[1]\n慢");
		const { queue, results } = setup({ queue: { maxPending: 3 } }, e);
		// Fill the queue without dispatching: stub scheduleDispatch via stopping? Use
		// batchWindow large so the timer never fires during the test.
		const cfgQueue = { ...defaultConfig(), queue: { maxPending: 3 }, translate: { ...defaultConfig().translate, batchWindowMs: 60000 } };
		void cfgQueue;
		(queue as unknown as { d: { getConfig: () => OutputTranslateConfig } }).d.getConfig = () => cfgQueue;
		queue.enqueue(item("b1", "text one long enough for the gate here.", "text"));
		queue.enqueue(item("b2", "thinking two long enough for gate here.", "thinking"));
		queue.enqueue(item("b3", "text three long enough for the gate ok.", "text"));
		queue.enqueue(item("b4", "overflow segment long enough gate yes.", "text"));
		const dropped = results.find((r) => r.st === "skipped");
		expect(dropped?.segId).toBe("b2"); // thinking dropped, text kept
		expect(dropped?.rsn).toBe("backpressure");
		await queue.stop();
	});

	it("stop() fail-closes pending items", async () => {
		const { queue, results } = setup();
		(queue as unknown as { d: { getConfig: () => OutputTranslateConfig } }).d.getConfig = () => ({
			...defaultConfig(),
			translate: { ...defaultConfig().translate, batchWindowMs: 60000 },
		});
		queue.enqueue(item("z1", "pending segment long enough gate ok.", "text"));
		await queue.stop();
		expect(results[0].st).toBe("skipped");
	});
});

function cacheKey(masked: string): string {
	// mirrors queue's key construction (engine id "mock", glossary "test")
	return TranslateCache.key("mock", "test", defaultConfig().translate.model, defaultConfig().translate.targetLang, masked);
}

describe("queue timing policy", () => {
	it("dispatches automatically after the batch window", async () => {
		vi.useFakeTimers();
		try {
			const e = new MockEngine();
			e.onComplete((user) => MockEngine.answerFor(user, () => "自动"));
			const { queue, results } = setup({ translate: { ...defaultConfig().translate, batchWindowMs: 20 } }, e);
			queue.enqueue(item("w1", "auto dispatch segment long enough ok.", "text"));
			await vi.advanceTimersByTimeAsync(40);
			expect(results[0]?.st).toBe("done");
		} finally {
			vi.useRealTimers();
		}
	});

	it("queue depth returns to zero after bursts and mid-flight enqueues (round 11)", async () => {
		vi.useFakeTimers();
		try {
			// slow engine: each call takes 30ms of fake time so batches overlap
			// new enqueues from the streaming collector
			const e = new MockEngine();
			e.onComplete(
				(user) =>
					new Promise((resolve) => {
						setTimeout(() => resolve(MockEngine.answerFor(user, (src) => `【译】${src.slice(0, 8)}`)), 30);
					}),
			);
			const { queue, results } = setup(
				{ translate: { ...defaultConfig().translate, batchWindowMs: 5, batchSize: 2, concurrency: 1, timeoutSeconds: 5 } },
				e,
			);
			// burst of 12, then a second wave while the first batches fly
			for (let i = 0; i < 12; i++) queue.enqueue(item(`q${i}`, `Burst number ${i} with some real sentence text. `, "text"));
			await vi.advanceTimersByTimeAsync(10);
			expect(queue.pendingCount()).toBeGreaterThan(0);
			for (let i = 100; i < 106; i++) queue.enqueue(item(`q${i}`, `Second wave number ${i} with sentence text. `, "text"));
			await vi.advanceTimersByTimeAsync(10_000);
			// everything drained: no stuck items, no leaked active batch slots
			expect(queue.pendingCount()).toBe(0);
			expect(queue.inFlight()).toBe(0);
			expect(queue.pendingItems()).toBe(0);
			expect(queue.oldestPendingMs()).toBe(0);
			expect(results.filter((r) => r.st === "done")).toHaveLength(18);
			expect(queue.dropped()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

/** Engine honoring the timeout contract: records granted deadlines and
 * simulates fixed generation time, failing when the deadline is too short. */
class SlowEngine implements TranslateEngine {
	readonly id = "slow";
	deadlines: number[] = [];
	constructor(
		private genMs = 1200,
		private defaultCapMs = 1000,
	) {}
	async complete(_sys: string, user: string, _signal: AbortSignal, timeoutMs?: number): Promise<string> {
		const cap = timeoutMs ?? this.defaultCapMs;
		this.deadlines.push(cap);
		if (this.genMs > cap) throw new Error(`engine timeout after ${cap}ms`);
		await new Promise((r) => setTimeout(r, this.genMs));
		return MockEngine.answerFor(user, (src) => `译:${src.slice(0, 8)}`);
	}
	async healthCheck(): Promise<boolean> {
		return true;
	}
}

describe("r13b: adaptive batch sizing + proportional batch timeout", () => {
	it("a batch gets up to 2x the per-segment budget — a slow-but-fine batch survives", async () => {
		// 1.2 s generation with timeoutSeconds=1: the OLD fixed engine cap
		// (1 s per call, regardless of batch size) killed every batch, which
		// then burned singles — throughput collapsed while the queue looked
		// stuck. The queue now grants 1s x min(len,2) + 5s to the batch.
		const e = new SlowEngine(1200, 1000);
		const { queue, results } = setup(
			{ translate: { ...defaultConfig().translate, batchWindowMs: 5, batchSize: 4, timeoutSeconds: 1 } },
			e,
		);
		queue.enqueue(item("s1", "first slow batch sentence here. truly.", "text"));
		queue.enqueue(item("s2", "second slow batch sentence goes right here.", "text"));
		await queue.flushNow();
		expect(e.deadlines).toEqual([7000]); // one call, scaled deadline
		expect(results.filter((r) => r.st === "done").map((r) => r.segId).sort()).toEqual(["s1", "s2"]);
	});

	it("always-failing batches shrink 4 -> 2 -> singles without wedging", async () => {
		const e = new MockEngine();
		e.onComplete((user) => {
			if (/^\[2\]/m.test(user)) throw new Error("batch too slow");
			return MockEngine.answerFor(user, (src) => `译:${src.slice(0, 8)}`);
		});
		const { queue, results } = setup(
			{ translate: { ...defaultConfig().translate, batchWindowMs: 5, batchSize: 4, timeoutSeconds: 5 } },
			e,
		);
		for (const id of ["a", "b", "c", "d"]) {
			queue.enqueue(item(id, `Sentence for ${id} with enough english words to pass the gate.`, "text"));
		}
		await queue.flushNow();
		expect(results.filter((r) => r.st === "done")).toHaveLength(4);
		expect(results.some((r) => r.st === "failed")).toBe(false);
		expect(queue.effectiveBatchSize()).toBe(1);
		// exactly one 4-block attempt and one 2-block attempt, then singles
		expect(e.calls.filter((c) => /^\[2\]/m.test(c.user))).toHaveLength(2);
	});

	it("adaptive ceiling climbs back toward the configured size after successes", async () => {
		const e = new MockEngine();
		e.onComplete((user) => MockEngine.answerFor(user, (src) => `译:${src.slice(0, 8)}`));
		const { queue, results } = setup(
			{ translate: { ...defaultConfig().translate, batchWindowMs: 5, batchSize: 4, timeoutSeconds: 5 } },
			e,
		);
		e.failNextBatches = 1; // first 4-batch fails -> ceiling drops to 2
		for (let i = 0; i < 9; i++) {
			queue.enqueue(item(`r${i}`, `Recovery sentence number ${i} with enough english text.`, "text"));
		}
		await queue.flushNow();
		expect(results.filter((r) => r.st === "done")).toHaveLength(9);
		// 2-batch succeeded (+1), then 3-batch (+1): back at the config size
		expect(queue.effectiveBatchSize()).toBe(4);
	});
});

describe("r14: batch character budget", () => {
	it("slices batches by source length so prompts fit small context windows", async () => {
		const e = new MockEngine();
		e.onComplete((user) => MockEngine.answerFor(user, (src) => `译:${src.slice(0, 8)}`));
		const { queue, results } = setup(
			{
				translate: {
					...defaultConfig().translate,
					batchWindowMs: 5,
					batchSize: 4,
					timeoutSeconds: 5,
					maxBatchChars: 1000,
				},
			},
			e,
		);
		// three ~600-char segments: budget forces at most one long segment
		// per batch (600 + 600 > 1000), even though batchSize allows 4
		const long = (id: string) =>
			item(id, `Segment ${id} with plenty of english prose. `.repeat(18).slice(0, 600), "text");
		for (const id of ["x1", "x2", "x3"]) queue.enqueue(long(id));
		await queue.flushNow();
		expect(results.filter((r) => r.st === "done")).toHaveLength(3);
		// every engine call carried ONE source (budget-bound singles use the
		// plain protocol — no numbered blocks at all)
		for (const c of e.calls) {
			expect(/^\[\d+\]/m.test(c.user)).toBe(false);
		}
		expect(e.calls.length).toBe(3);
	});

	it("short segments still pack up to batchSize within the budget", async () => {
		const e = new MockEngine();
		e.onComplete((user) => MockEngine.answerFor(user, (src) => `译:${src.slice(0, 8)}`));
		const { queue, results } = setup(
			{ translate: { ...defaultConfig().translate, batchWindowMs: 5, batchSize: 4, timeoutSeconds: 5 } },
			e,
		);
		for (let i = 0; i < 6; i++) queue.enqueue(item(`y${i}`, `Short sentence ${i} just long enough to translate.`, "text"));
		await queue.flushNow();
		expect(results.filter((r) => r.st === "done")).toHaveLength(6);
		// 6 short segments with the default 2400 budget: 4-pack then 2-pack
		const sizes = e.calls.map((c) => c.user.match(/^\[\d+\]$/gm)?.length ?? 0).sort((a, b) => b - a);
		expect(sizes[0]).toBe(4);
	});
});
