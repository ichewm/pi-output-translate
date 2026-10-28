/**
 * Isolation gates — the core promise of this extension (SPEC §3, §14).
 *
 * 1. Collector handlers are synchronous and fast even when the translation
 *    engine is permanently stuck, and always return undefined.
 * 2. Hub.publish is synchronous (no awaiting engine/IO).
 * 3. The full pipeline produces the expected event shapes for a simulated
 *    assistant message with thinking + text + code + tool calls.
 */

import { describe, it, expect } from "vitest";
import { Collector } from "../src/collector.ts";
import { Hub } from "../src/hub.ts";
import { defaultConfig, type OutputTranslateConfig } from "../src/config.ts";
import type { HubEvent, TranslateEngine } from "../src/types.ts";

/** Engine that never resolves: worst case for blocking. */
class StuckEngine implements TranslateEngine {
	readonly id = "stuck";
	complete(): Promise<string> {
		return new Promise(() => {});
	}
	healthCheck(): Promise<boolean> {
		return new Promise(() => {});
	}
}

function testConfig(): OutputTranslateConfig {
	return {
		...defaultConfig(),
		cache: { ...defaultConfig().cache, persist: false },
		journal: { ...defaultConfig().journal, dir: "/tmp/pot-isolation-hist" },
		translate: { ...defaultConfig().translate, batchWindowMs: 60_000 }, // never auto-dispatch
	};
}

describe("isolation: collector handlers never block", () => {
	it("handlers return synchronously (<1ms) and undefined, with a stuck engine downstream", async () => {
		const cfg = testConfig();
		const hub = new Hub({ getConfig: () => cfg, engineFactory: () => new StuckEngine() });
		hub.start();
		const events: HubEvent[] = [];
		const collector = new Collector({
			getSessionId: () => "iso",
			publish: (ev) => {
				events.push(ev);
				hub.publish(ev);
			},
			getConfig: () => cfg,
		});

		const longText = "The build system failed because of a race condition. ".repeat(20);
		const timings: number[] = [];
		const time = async (fn: () => unknown) => {
			const t0 = performance.now();
			const r = fn();
			timings.push(performance.now() - t0);
			return r;
		};

		const r1 = await time(() =>
			collector.onMessageStart({ message: { role: "assistant", content: [] } }, "p/m"),
		);
		const r2 = await time(() => collector.onMessageUpdate({ type: "thinking_delta", contentIndex: 0, delta: longText }));
		const r3 = await time(() => collector.onMessageUpdate({ type: "text_delta", contentIndex: 1, delta: longText }));
		const r4 = await time(() =>
			collector.onToolStart({ toolName: "read", args: { file_path: "/src/index.ts" }, toolCallId: "tc1" }),
		);
		const r5 = await time(() =>
			collector.onToolEnd({ toolName: "read", result: { content: "ok" }, isError: false, durationMs: 5, toolCallId: "tc1" }),
		);
		const r6 = await time(() => collector.onMessageEnd({ message: { role: "assistant", stopReason: "stop" } }));

		// All handlers returned undefined (they are void, no event mutation).
		for (const r of [r1, r2, r3, r4, r5, r6]) expect(r).toBeUndefined();
		// All completed synchronously: each well under 5ms even under GC jitter,
		// and the median under 1ms — orders of magnitude below any engine call.
		for (const t of timings) expect(t).toBeLessThan(5);
		const sorted = [...timings].sort((a, b) => a - b);
		expect(sorted[Math.floor(sorted.length / 2)]).toBeLessThan(1);
		// Events actually flowed (nothing dropped despite the stuck engine).
		expect(events.some((e) => e.t === "msg_start")).toBe(true);
		expect(events.some((e) => e.t === "segment")).toBe(true);
		expect(events.some((e) => e.t === "tool")).toBe(true);
		expect(events.some((e) => e.t === "msg_end")).toBe(true);
		// The stuck engine was invoked (queued) but nothing blocked.
		await hub.dispose();
	});

	it("event-loop heartbeat stays responsive while publishing a flood", async () => {
		const cfg = testConfig();
		const hub = new Hub({ getConfig: () => cfg, engineFactory: () => new StuckEngine() });
		hub.start();
		const collector = new Collector({
			getSessionId: () => "flood",
			publish: (ev) => hub.publish(ev),
			getConfig: () => cfg,
		});
		const delta = "Some moderately long sentence to keep the pipeline busy. ";
		const t0 = performance.now();
		for (let i = 0; i < 500; i++) {
			collector.onMessageUpdate({ type: "text_delta", contentIndex: 0, delta });
		}
		const elapsed = performance.now() - t0;
		// 500 deltas through collector + hub must stay well under 500ms total.
		expect(elapsed).toBeLessThan(500);
		await hub.dispose();
	});
});

describe("isolation: full pipeline event shapes", () => {
	it("produces ordered events for user, thinking, text, code and tool lines", () => {
		const cfg = testConfig();
		const events: HubEvent[] = [];
		const collector = new Collector({
			getSessionId: () => "pipe",
			publish: (ev) => events.push(ev),
			getConfig: () => cfg,
		});

		// user message
		collector.onMessageStart({ message: { role: "user", content: "帮我修复这个 bug" } }, undefined);
		// assistant with thinking + text + code
		collector.onMessageStart({ message: { role: "assistant", content: [] } }, "anthropic/claude");
		collector.onMessageUpdate({ type: "thinking_start", contentIndex: 0 });
		collector.onMessageUpdate({ type: "thinking_delta", contentIndex: 0, delta: "Let me examine the failing test. " });
		collector.onMessageUpdate({ type: "thinking_delta", contentIndex: 0, delta: "The race is in the cache loader.\n\nSecond paragraph here. " });
		collector.onMessageUpdate({ type: "thinking_end", contentIndex: 0, partial: { content: [{ type: "thinking" }] } });
		collector.onMessageUpdate({ type: "text_delta", contentIndex: 1, delta: "Here is the fix. ```ts\nconst x = 1;\n``` " });
		collector.onMessageUpdate({ type: "text_delta", contentIndex: 1, delta: "Apply it and rerun the tests. " });
		collector.onMessageEnd({ message: { role: "assistant", stopReason: "stop" } });

		const kinds = events.map((e) => e.t);
		expect(kinds[0]).toBe("msg_start");
		const userSeg = events.find((e) => e.t === "segment" && e.k === "user") as Extract<HubEvent, { t: "segment" }>;
		expect(userSeg?.src).toContain("帮我修复");

		const textSegs = events.filter((e) => e.t === "segment" && e.k === "text") as Extract<HubEvent, { t: "segment" }>[];
		expect(textSegs.some((s) => /Here is the fix/.test(s.src))).toBe(true);
		const codeSegs = events.filter((e) => e.t === "segment" && e.k === "code") as Extract<HubEvent, { t: "segment" }>[];
		expect(codeSegs).toHaveLength(1);
		expect(codeSegs[0].src).toContain("const x = 1;");
		expect(codeSegs[0].lang).toBe("ts");

		const thinkSegs = events.filter((e) => e.t === "segment" && e.k === "thinking");
		expect(thinkSegs.length).toBeGreaterThanOrEqual(1);

		// segment ids unique
		const ids = new Set(events.filter((e) => e.t === "segment").map((e) => (e as { id: string }).id));
		expect(ids.size).toBe(events.filter((e) => e.t === "segment").length);

		// message keys: user=1, assistant=2
		expect(events.filter((e) => e.t === "msg_start").map((e) => (e as { m: string }).m)).toEqual(["1", "2"]);
	});

	it("tool lines pair start/end via toolCallId and summarize args", () => {
		const cfg = testConfig();
		const events: HubEvent[] = [];
		const collector = new Collector({
			getSessionId: () => "tools",
			publish: (ev) => events.push(ev),
			getConfig: () => cfg,
		});
		collector.onMessageStart({ message: { role: "assistant", content: [] } }, "p/m");
		collector.onToolStart({ toolName: "bash", args: { command: "npm test -- --watch=false" }, toolCallId: "t1" });
		collector.onToolEnd({
			toolName: "bash",
			result: { content: "3 passed\n1 failed" },
			isError: false,
			durationMs: 213,
			toolCallId: "t1",
		});
		const tools = events.filter((e) => e.t === "tool") as Extract<HubEvent, { t: "tool" }>[];
		expect(tools).toHaveLength(2);
		expect(tools[0].ph).toBe("start");
		expect(tools[0].sum).toContain("npm test");
		expect(tools[0].tc).toBe("t1");
		expect(tools[1].ph).toBe("end");
		expect(tools[1].ok).toBe(true);
		expect(tools[1].ms).toBe(213);
		expect(tools[1].sum).toContain("3 passed");
	});

	it("redacted thinking produces a notice segment, not a translation", () => {
		const cfg = testConfig();
		const events: HubEvent[] = [];
		const collector = new Collector({
			getSessionId: () => "red",
			publish: (ev) => events.push(ev),
			getConfig: () => cfg,
		});
		collector.onMessageStart({ message: { role: "assistant", content: [] } }, "p/m");
		collector.onMessageUpdate({ type: "thinking_delta", contentIndex: 0, delta: "shh" });
		collector.onThinkingEnd({ type: "thinking_end", contentIndex: 0, partial: { content: [{ type: "thinking", redacted: true }] } });
		const seg = events.find((e) => e.t === "segment") as Extract<HubEvent, { t: "segment" }>;
		expect(seg?.k).toBe("code");
		expect(seg?.src).toContain("安全过滤");
	});

	it("source toggles are respected live", () => {
		const cfg = testConfig();
		cfg.sources.thinking = false;
		cfg.sources.userMessage = false;
		const events: HubEvent[] = [];
		const collector = new Collector({
			getSessionId: () => "toggle",
			publish: (ev) => events.push(ev),
			getConfig: () => cfg,
		});
		collector.onMessageStart({ message: { role: "user", content: "hi there friend" } }, undefined);
		collector.onMessageStart({ message: { role: "assistant", content: [] } }, "p/m");
		collector.onMessageUpdate({ type: "thinking_delta", contentIndex: 0, delta: "thinking content that should be dropped entirely here." });
		expect(events.some((e) => e.t === "segment" && e.k === "user")).toBe(false);
		expect(events.some((e) => e.t === "delta" && e.k === "thinking")).toBe(false);
	});
});
