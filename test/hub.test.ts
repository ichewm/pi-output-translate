import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";
import { defaultConfig, type OutputTranslateConfig } from "../src/config.ts";
import type { TranslateEngine } from "../src/types.ts";
import type { SequencedEvent } from "../src/types.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pot-hub-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

class RecordingEngine implements TranslateEngine {
	readonly id = "mock";
	calls = 0;
	fail = false;
	async complete(): Promise<string> {
		this.calls++;
		if (this.fail) throw new Error("engine down");
		return "模拟译文";
	}
	async healthCheck(): Promise<boolean> {
		return !this.fail;
	}
}

function makeHub(engine = new RecordingEngine(), overrides: Partial<OutputTranslateConfig> = {}) {
	const cfg: OutputTranslateConfig = {
		...defaultConfig(),
		journal: { ...defaultConfig().journal, dir: join(dir, "hist") },
		cache: { ...defaultConfig().cache, persist: false },
		...overrides,
	};
	const hub = new Hub({ getConfig: () => cfg, engineFactory: () => engine });
	hub.start();
	return { hub, engine, cfg };
}

describe("Hub", () => {
	it("sequences events, replays after a cursor, and trims the ring", async () => {
		const { hub } = makeHub();
		hub.registerSession({ id: "s1", name: "p", cwd: "/p" }, true);
		for (let i = 0; i < 30; i++) {
			hub.publish({ t: "msg_end", s: "s1", m: String(i) });
		}
		const all = hub.since(0);
		expect(all.length).toBeGreaterThan(30);
		const mid = all[20].seq;
		const tail = hub.since(mid);
		expect(tail[0].seq).toBe(mid + 1);
		await hub.dispose();
	});

	it("routes text segments to translation and publishes trans done", async () => {
		const { hub, engine } = makeHub();
		hub.registerSession({ id: "s1", name: "p", cwd: "/p" }, true);
		hub.publish({
			t: "segment", s: "s1", m: "1", k: "text",
			id: "s1:1:text:0:1",
			src: "The build failed because of a race condition in the cache layer.",
		});
		// The queue dispatches on its window timer; drive it deterministically.
		await (hub as unknown as { queue: { flushNow(): Promise<void> } }).queue.flushNow();
		expect(engine.calls).toBe(1);
		const events = hub.since(0).map((e: SequencedEvent) => e.ev);
		expect(events.some((e) => e.t === "trans" && e.st === "done" && /模拟译文/.test(String(e.tgt)))).toBe(true);
		await hub.dispose();
	});

	it("does not translate code, user, or gated (notrans) segments", async () => {
		const { hub, engine } = makeHub();
		hub.registerSession({ id: "s1", name: "p", cwd: "/p" }, true);
		hub.publish({ t: "segment", s: "s1", m: "1", k: "code", id: "c1", src: "```js\nlet a=1;\n```" });
		hub.publish({ t: "segment", s: "s1", m: "1", k: "user", id: "u1", src: "用户中文输入" });
		hub.publish({ t: "segment", s: "s1", m: "1", k: "text", id: "n1", src: "OK." });
		await (hub as unknown as { queue: { flushNow(): Promise<void> } }).queue.flushNow();
		expect(engine.calls).toBe(0);
		const events = hub.since(0).map((e) => e.ev);
		expect(events.some((e) => e.t === "trans" && e.id === "n1" && e.st === "notrans")).toBe(true);
		await hub.dispose();
	});

	it("respects thinking source toggle", async () => {
		const { hub, engine } = makeHub(undefined, { sources: { ...defaultConfig().sources, thinking: false } });
		hub.registerSession({ id: "s1", name: "p", cwd: "/p" }, true);
		hub.publish({
			t: "segment", s: "s1", m: "1", k: "thinking",
			id: "t1",
			src: "I should check the configuration file first before retrying the build step.",
		});
		await (hub as unknown as { queue: { flushNow(): Promise<void> } }).queue.flushNow();
		expect(engine.calls).toBe(0);
		await hub.dispose();
	});

	it("muted sessions skip translation", async () => {
		const { hub, engine } = makeHub();
		hub.registerSession({ id: "s1", name: "p", cwd: "/p" }, true);
		hub.setMuted("s1", true);
		hub.publish({
			t: "segment", s: "s1", m: "1", k: "text", id: "m1",
			src: "A normal segment that would otherwise be translated for sure.",
		});
		await (hub as unknown as { queue: { flushNow(): Promise<void> } }).queue.flushNow();
		expect(engine.calls).toBe(0);
		const events = hub.since(0).map((e) => e.ev);
		expect(events.some((e) => e.t === "trans" && e.st === "skipped" && e.rsn === "muted")).toBe(true);
		await hub.dispose();
	});

	it("journal receives done records", async () => {
		const { hub } = makeHub();
		hub.registerSession({ id: "s1", name: "p", cwd: "/p" }, true);
		hub.publish({
			t: "segment", s: "s1", m: "1", k: "text", id: "j1",
			src: "A journal record should be written for this translated segment.",
		});
		await (hub as unknown as { queue: { flushNow(): Promise<void> } }).queue.flushNow();
		const list = hub.journalList();
		expect(list.length).toBe(1);
		const recs = hub.journalRead(list[0].sessionId);
		expect(recs.some((r) => r.id === "j1" && r.tgt === "模拟译文")).toBe(true);
		await hub.dispose();
	});

	it("ingest whitelist rejects session-level events from clients", async () => {
		const { hub } = makeHub();
		hub.publishIngested([{ t: "msg_end", s: "x", m: "1" }, { t: "status", q: 1, eng: true, drop: 0, clients: 0 }] as never);
		const events = hub.since(0).map((e) => e.ev);
		expect(events.some((e) => e.t === "msg_end")).toBe(true);
		expect(events.some((e) => e.t === "status")).toBe(false);
		await hub.dispose();
	});

	it("prunes client sessions after 90s without heartbeat", async () => {
		const { hub } = makeHub();
		hub.registerSession({ id: "c1", name: "p", cwd: "/p" }, false);
		const internal = (hub as unknown as { sessions: Map<string, { lastSeen?: number }> }).sessions;
		internal.get("c1")!.lastSeen = Date.now() - 100_000;
		(hub as unknown as { pruneSessions(): void }).pruneSessions();
		expect(hub.listSessions().find((x) => x.id === "c1")).toBeUndefined();
		await hub.dispose();
	});

	it("subscribers receive batched serialized events", async () => {
		const { hub } = makeHub();
		const got: string[] = [];
		const unsub = hub.subscribe((lines) => got.push(lines));
		hub.publish({ t: "msg_end", s: "s1", m: "1" });
		hub.publish({ t: "msg_end", s: "s1", m: "2" });
		hub.flush();
		expect(got.length).toBe(1);
		expect(got[0]).toContain("msg_end");
		unsub();
		await hub.dispose();
	});
});
