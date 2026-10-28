/**
 * Settings-panel controls verification (unit + integration).
 *
 * Every control in the reader page's settings form must actually take
 * effect on the running pipeline. This suite walks each one:
 *
 *   Content sources — assistantText / thinking / userMessage / toolLines
 *                     (collector gates + host-side route gates)
 *   Code comments   — codeComments off | below
 *   Idle policy     — idle.noViewerBehavior none | text-only | full
 *   Performance     — timeoutSeconds / batchWindowMs / batchSize / concurrency
 *   Hot apply       — POST /api/config flips behavior live (integration)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "pot-ctl-agent-"));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collector } from "../src/collector.ts";
import { Hub } from "../src/hub.ts";
import { TranslateQueue, type QResult } from "../src/queue.ts";
import { TranslateCache } from "../src/cache.ts";
import { defaultConfig, resetConfigCache, saveConfig, loadConfig, type OutputTranslateConfig } from "../src/config.ts";
import type { TranslateEngine, HubEvent } from "../src/types.ts";
import { mask } from "../src/protect.ts";
import { AppServer } from "../src/server.ts";
import type { AddressInfo } from "node:net";

class NullEngine implements TranslateEngine {
	readonly id = "mock";
	async complete(): Promise<string> {
		return "模拟译文";
	}
	async healthCheck(): Promise<boolean> {
		return true;
	}
}

function cfgWith(over: {
	translate?: Partial<OutputTranslateConfig["translate"]>;
	sources?: Partial<OutputTranslateConfig["sources"]>;
	idle?: Partial<OutputTranslateConfig["idle"]>;
}): OutputTranslateConfig {
	const cfg = defaultConfig();
	return {
		...cfg,
		translate: { ...cfg.translate, ...(over.translate ?? {}) },
	sources: { ...cfg.sources, ...(over.sources ?? {}) },
		idle: { ...cfg.idle, ...(over.idle ?? {}) },
	};
}

// --------------------------------------------------------------------
// helpers

function driveCollector(cfg: OutputTranslateConfig, script: (c: Collector) => void): HubEvent[] {
	const events: HubEvent[] = [];
	const c = new Collector({
		getSessionId: () => "s-ctl",
		publish: (ev) => events.push(ev),
		getConfig: () => cfg,
	});
	script(c);
	return events;
}

const assistantTextFlow = (c: Collector) => {
	c.onMessageStart({ message: { role: "assistant", content: [] } }, "m");
	c.onMessageUpdate({ type: "text_delta", contentIndex: 0, delta: "A sufficiently long english sentence to cross the gate threshold." });
	c.onMessageEnd({ message: { role: "assistant", content: "" } });
};

const thinkingFlow = (c: Collector) => {
	c.onMessageStart({ message: { role: "assistant", content: [] } }, "m");
	c.onMessageUpdate({ type: "thinking_delta", contentIndex: 1, delta: "Let me think about this problem carefully and at length in english words." });
	c.onMessageEnd({ message: { role: "assistant", content: "" } });
};

const userFlow = (c: Collector) => {
	c.onMessageStart({ message: { role: "user", content: "Please check the login flow and fix the timeout bug today." } });
	c.onMessageEnd({ message: { role: "user", content: "Please check the login flow and fix the timeout bug today." } });
};

function qitem(segId: string, src: string, kind: "text" | "thinking" | "comment" | "user" = "text") {
	const { masked, placeholders } = mask(src);
	return { segId, sessionId: "s-ctl", messageKey: "1", kind, source: src, masked, placeholders };
}

function queueSetup(cfg: OutputTranslateConfig, viewerCount: () => number, engine = new NullEngine()) {
	const results: QResult[] = [];
	const queue = new TranslateQueue({
		getEngine: () => engine,
		glossaryVersion: () => "t",
		cache: new TranslateCache(100, null),
		getConfig: () => cfg,
		glossaryText: () => "",
		getSessionCtx: () => ({ recent: [], termLockLines: "" }),
		recordTranslation: () => {},
		viewerCount,
		isMuted: () => false,
		onResult: (r) => results.push(r),
	});
	return { queue, results };
}

// --------------------------------------------------------------------
// A. content sources — collector-side gates

describe("content sources (collector)", () => {
	it("assistantText=false suppresses assistant text segments", () => {
		const ev = driveCollector(cfgWith({ sources: { assistantText: false } }), assistantTextFlow);
		expect(ev.filter((e) => e.t === "segment" && e.k === "text")).toHaveLength(0);
	});
	it("assistantText=true produces them", () => {
		const ev = driveCollector(cfgWith({}), assistantTextFlow);
		expect(ev.some((e) => e.t === "segment" && e.k === "text")).toBe(true);
	});
	it("thinking=false suppresses thinking segments", () => {
		const ev = driveCollector(cfgWith({ sources: { thinking: false } }), thinkingFlow);
		expect(ev.filter((e) => e.t === "segment" && e.k === "thinking")).toHaveLength(0);
	});
	it("userMessage=false suppresses user segments (msg_start may pass: user cards render lazily from segments)", () => {
		const ev = driveCollector(cfgWith({ sources: { userMessage: false } }), userFlow);
		expect(ev.filter((e) => e.t === "segment" && e.k === "user")).toHaveLength(0);
	});
	it("toolLines=false suppresses tool lines; true emits start+end", () => {
		const off = driveCollector(cfgWith({ sources: { toolLines: false } }), (c) => {
			c.onToolStart({ toolName: "bash", args: {} });
			c.onToolEnd({ toolName: "bash", result: "", isError: false });
		});
		expect(off.filter((e) => e.t === "tool")).toHaveLength(0);
		const on = driveCollector(cfgWith({}), (c) => {
			c.onToolStart({ toolName: "bash", args: {} });
			c.onToolEnd({ toolName: "bash", result: "", isError: false });
		});
		expect(on.filter((e) => e.t === "tool")).toHaveLength(2);
	});
});

// --------------------------------------------------------------------
// B. code comments

describe("codeComments", () => {
	const codeFlow = (c: Collector) => {
		c.onMessageStart({ message: { role: "assistant", content: [] } }, "m");
		c.onMessageUpdate({ type: "text_delta", contentIndex: 0, delta: "```python\n# fix the race condition here\nx = 1\n```" });
		c.onMessageEnd({ message: { role: "assistant", content: "" } });
	};
	it('"off" extracts no comment segments', () => {
		const ev = driveCollector(cfgWith({ translate: { codeComments: "off" } }), codeFlow);
		expect(ev.filter((e) => e.t === "segment" && e.k === "comment")).toHaveLength(0);
	});
	it('"below" extracts the comment as a comment segment', () => {
		const ev = driveCollector(cfgWith({ translate: { codeComments: "below" } }), codeFlow);
		const comments = ev.filter((e) => e.t === "segment" && e.k === "comment") as Extract<HubEvent, { t: "segment" }>[];
		expect(comments).toHaveLength(1);
		expect(comments[0].src).toContain("race condition");
		expect(comments[0].of).toBeDefined(); // attached to its code block
	});
});

// --------------------------------------------------------------------
// C. host-side route gates (covers client-ingested events too)

describe("content sources (hub route)", () => {
	async function routed(cfg: OutputTranslateConfig, k: "text" | "thinking" | "user"): Promise<boolean> {
		const hub = new Hub({ getConfig: () => cfg, engineFactory: () => new NullEngine() });
		hub.start();
		const before = hub.currentSeq();
		hub.publish({ t: "segment", s: "sx", m: "1", k, id: `g-${k}-${before}`, src: "An english sentence long enough to clear the language gate easily." });
		await hub.flushQueueForTests();
		await new Promise((r) => setTimeout(r, 60));
		const ok = hub.since(before).some((x) => x.ev.t === "trans");
		void hub.dispose();
		return ok;
	}
	it("gates mirror the collector: each source toggle blocks its kind", async () => {
		expect(await routed(cfgWith({ sources: { assistantText: false } }), "text")).toBe(false);
		expect(await routed(cfgWith({ sources: { thinking: false } }), "thinking")).toBe(false);
		expect(await routed(cfgWith({ sources: { userMessage: false } }), "user")).toBe(false);
		expect(await routed(cfgWith({}), "text")).toBe(true);
		expect(await routed(cfgWith({}), "thinking")).toBe(true);
		expect(await routed(cfgWith({}), "user")).toBe(true);
	});
});

// --------------------------------------------------------------------
// D. idle policy

describe("idle.noViewerBehavior", () => {
	const base = { batchWindowMs: 5, timeoutSeconds: 5 };
	it("none: everything skipped when no viewer", async () => {
		const { queue, results } = queueSetup(cfgWith({ translate: { ...base }, idle: { noViewerBehavior: "none" } }), () => 0);
		queue.enqueue(qitem("i1", "Some english text worth translating here.", "text"));
		await queue.flushNow();
		expect(results[0]?.st).toBe("skipped");
		expect(results[0]?.rsn).toBe("idle");
	});
	it("text-only: thinking skipped, text still translates (into cache)", async () => {
		const { queue, results } = queueSetup(cfgWith({ translate: { ...base }, idle: { noViewerBehavior: "text-only" } }), () => 0);
		queue.enqueue(qitem("i2", "A thinking segment in english worth translating.", "thinking"));
		await queue.flushNow();
		expect(results[0]?.st).toBe("skipped");
		expect(results[0]?.rsn).toBe("idle");
		results.length = 0;
		queue.enqueue(qitem("i3", "An assistant text segment worth translating.", "text"));
		await queue.flushNow();
		expect(results.some((r) => r.segId === "i3" && r.st === "done")).toBe(true);
	});
	it("full: thinking also translates with no viewer", async () => {
		const { queue, results } = queueSetup(cfgWith({ translate: { ...base }, idle: { noViewerBehavior: "full" } }), () => 0);
		queue.enqueue(qitem("i4", "A thinking segment in english worth translating.", "thinking"));
		await queue.flushNow();
		expect(results.some((r) => r.st === "done")).toBe(true);
	});
	it("viewer present: text-only does not skip thinking", async () => {
		const { queue, results } = queueSetup(cfgWith({ translate: { ...base }, idle: { noViewerBehavior: "text-only" } }), () => 1);
		queue.enqueue(qitem("i5", "A thinking segment in english worth translating.", "thinking"));
		await queue.flushNow();
		expect(results.some((r) => r.st === "done")).toBe(true);
	});
});

// --------------------------------------------------------------------
// E. performance knobs

describe("performance knobs", () => {
	it("batchWindowMs: dispatch waits for the window, then fires once", async () => {
		vi.useFakeTimers();
		try {
			let calls = 0;
			const engine = new (class implements TranslateEngine {
				readonly id = "mock";
				async complete(): Promise<string> {
					calls++;
					return "译文内容";
				}
				async healthCheck(): Promise<boolean> {
					return true;
				}
			})();
			const { queue, results } = queueSetup(cfgWith({ translate: { batchWindowMs: 500, batchSize: 4, timeoutSeconds: 5 } }), () => 1, engine);
			queue.enqueue(qitem("w1", "Windowed dispatch test sentence number one here.", "text"));
			await vi.advanceTimersByTimeAsync(50);
			expect(calls).toBe(0); // inside the window: accumulating
			await vi.advanceTimersByTimeAsync(500);
			expect(calls).toBe(1); // window elapsed: one batched call
			expect(results.some((r) => r.st === "done")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("concurrency=2 runs two batches simultaneously", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const engine = new (class implements TranslateEngine {
			readonly id = "mock";
			async complete(): Promise<string> {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 120));
				inFlight--;
				return "译文内容";
			}
			async healthCheck(): Promise<boolean> {
				return true;
			}
		})();
		const { queue, results } = queueSetup(
			cfgWith({ translate: { batchWindowMs: 5, batchSize: 2, concurrency: 2, timeoutSeconds: 10 } }),
			() => 1,
			engine,
		);
		for (let i = 0; i < 4; i++) queue.enqueue(qitem(`c${i}`, `Concurrency probe sentence number ${i} with real words.`, "text"));
		await queue.flushNow();
		expect(results.filter((r) => r.st === "done")).toHaveLength(4);
		expect(maxInFlight).toBe(2); // two batches overlapped
	});

	it("a failing engine marks the item failed after exactly one retry", async () => {
		let calls = 0;
		const engine = new (class implements TranslateEngine {
			readonly id = "mock";
			async complete(): Promise<string> {
				calls++;
				throw new Error("engine timeout after budget");
			}
			async healthCheck(): Promise<boolean> {
				return true;
			}
		})();
		const { queue, results } = queueSetup(cfgWith({ translate: { batchWindowMs: 5, timeoutSeconds: 5 } }), () => 1, engine);
		queue.enqueue(qitem("t1", "A single segment that will exceed its time budget.", "text"));
		await queue.flushNow();
		expect(results[0]?.st).toBe("failed");
		expect(calls).toBe(2); // attempt + one retry, then give up
	});
});

// --------------------------------------------------------------------
// F. integration — settings saves hot-apply on the running host

describe("settings hot-apply over HTTP (integration)", () => {
	let hub: Hub;
	let server: AppServer;
	let base: string;
	const TOKEN = "ctl-token-0123456789abcdef";

	beforeAll(async () => {
		resetConfigCache();
		const cfg = loadConfig();
		hub = new Hub({ getConfig: () => loadConfig(), engineFactory: () => new NullEngine() });
		hub.start();
		hub.registerSession({ id: "sx", name: "proj", cwd: "/tmp/p" }, true);
		server = new AppServer({ hub, token: TOKEN });
		await server.listen(0);
		base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
		void cfg;
	});
	afterAll(async () => {
		await hub.dispose();
		await server.close();
		rmSync(process.env.PI_AGENT_DIR!, { recursive: true, force: true });
	});

	async function postSources(sources: Record<string, boolean>) {
		const r = await fetch(`${base}/api/config?token=${TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config: { sources } }),
		});
		return (await r.json()) as { ok: boolean; config: OutputTranslateConfig };
	}

	function translateArrives(): Promise<boolean> {
		const before = hub.currentSeq();
		hub.publish({ t: "segment", s: "sx", m: "1", k: "text", id: `hot-${before}`, src: "Hot apply probe sentence with sufficient english length." });
		void hub.flushQueueForTests();
		return new Promise<boolean>((resolve) => {
			setTimeout(() => resolve(hub.since(before).some((x) => x.ev.t === "trans")), 80);
		});
	}

	it("POST /api/config flips sources.assistantText live", async () => {
		expect(await translateArrives()).toBe(true); // default on
		const off = await postSources({ assistantText: false });
		expect(off.ok).toBe(true);
		expect(off.config.sources.assistantText).toBe(false);
		expect(await translateArrives()).toBe(false); // gated immediately, no restart
		const on = await postSources({ assistantText: true });
		expect(on.config.sources.assistantText).toBe(true);
		expect(await translateArrives()).toBe(true);
	});

	it("saveConfig+loadConfig stay in sync (file is the truth)", () => {
		const cfg = loadConfig();
		expect(cfg.sources.assistantText).toBe(true);
		saveConfig({ ...cfg, sources: { ...cfg.sources, thinking: false } });
		expect(loadConfig().sources.thinking).toBe(false);
		saveConfig({ ...loadConfig(), sources: { ...cfg.sources, thinking: true } });
	});
});
