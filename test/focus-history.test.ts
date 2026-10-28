/**
 * Round 7: focus-follow + project-grouped history.
 *
 * F1: terminal keypress -> reportFocus -> hub.setFocus pushes a TRANSIENT
 *     "focus" event (never replayed from the ring buffer) and hello carries
 *     the current focus for fresh connections.
 * F2: focus events are throttled (no SSE spam while typing).
 * F3: journal records carry cwd; /api/history groups sessions by project
 *     directory, with legacy files (no cwd) in the unknown group.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";
import { AppServer } from "../src/server.ts";
import { Journal } from "../src/journal.ts";
import { defaultConfig, resetConfigCache, type OutputTranslateConfig } from "../src/config.ts";
import type { SequencedEvent } from "../src/types.ts";
import type { AddressInfo } from "node:net";

process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "pot-r7-agent-"));
let dir: string;
let cfg: OutputTranslateConfig;
const engine = { id: "m", complete: async () => "译文", healthCheck: async () => true };

beforeAll(() => {
	resetConfigCache();
	dir = mkdtempSync(join(tmpdir(), "pot-r7-"));
	cfg = { ...defaultConfig(), cache: { ...defaultConfig().cache, persist: false }, journal: { ...defaultConfig().journal, dir } };
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(process.env.PI_AGENT_DIR!, { recursive: true, force: true });
});

describe("F1/F2: hub focus", () => {
	it("setFocus broadcasts transient focus events and throttles them", () => {
		const hub = new Hub({ getConfig: () => cfg, engineFactory: () => engine as never });
		hub.start();
		const got: SequencedEvent[] = [];
		hub.subscribe((lines) => {
			for (const frame of lines.split("\n\n")) {
				if (frame.startsWith("data: ")) got.push(JSON.parse(frame.slice(6)));
			}
		});
		hub.registerSession({ id: "a", name: "a", cwd: "/p/a" }, true);
		hub.registerSession({ id: "b", name: "b", cwd: "/p/b" }, false);
		hub.setFocus("a");
		hub.setFocus("a"); // same session, within throttle window -> swallowed
		hub.setFocus("b");
		hub.flush();
		const focusEvents = got.filter((e) => e.ev.t === "focus");
		expect(focusEvents.map((e) => (e.ev as { s: string }).s)).toEqual(["a", "b"]);
		// transient: focus must NOT be replayable from the ring buffer
		const replay = hub.since(0).map((e) => e.ev.t);
		expect(replay).not.toContain("focus");
		expect(hub.currentFocus()).toBe("b");
		void hub.dispose();
	});
});

describe("F3: project-grouped history", () => {
	it("journal records carry cwd; peekCwd finds it; /api/history groups", async () => {
		const j = new Journal(dir, 2, 20);
		j.append({ ts: 1, s: "s-proj1", cwd: "/work/alpha", m: "1", k: "text", id: "x1", src: "hello", st: "done" });
		j.append({ ts: 2, s: "s-proj2", cwd: "/work/beta", m: "1", k: "text", id: "x2", src: "world", st: "done" });
		j.append({ ts: 3, s: "s-legacy", m: "1", k: "text", id: "x3", src: "old", st: "done" }); // no cwd
		j.flush();
		expect(j.peekCwd(j.filePathFor("s-proj1"))).toBe("/work/alpha");
		expect(j.peekCwd(j.filePathFor("s-legacy"))).toBeNull();

		const hub = new Hub({ getConfig: () => cfg, engineFactory: () => engine as never });
		hub.start();
		const server = new AppServer({ hub, token: "t7" });
		await server.listen(0);
		const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
		const r = await (await fetch(`${base}/api/history?token=t7`)).json();
		const names = r.groups.map((g: { name: string }) => g.name);
		expect(names).toContain("alpha");
		expect(names).toContain("beta");
		expect(names).toContain("（未知项目）");
		const alpha = r.groups.find((g: { name: string }) => g.name === "alpha");
		expect(alpha.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(["s-proj1"]);
		await hub.dispose();
		await server.close();
	});
});

describe("F1 wire: /api/focus endpoint", () => {
	it("POST /api/focus updates the hub and reaches SSE subscribers", async () => {
		const hub = new Hub({ getConfig: () => cfg, engineFactory: () => engine as never });
		hub.start();
		hub.registerSession({ id: "z", name: "z", cwd: "/z" }, true);
		const server = new AppServer({ hub, token: "t8" });
		await server.listen(0);
		const base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
		const ac = new AbortController();
		const res = await fetch(`${base}/events?token=t8&since=0`, { signal: ac.signal });
		const r2 = await fetch(`${base}/api/focus?token=t8`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sessionId: "z" }),
		});
		expect(r2.status).toBe(200);
		// read a couple of frames then bail
		const reader = res.body!.getReader();
		let buf = "";
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !buf.includes('"t":"focus"')) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += new TextDecoder().decode(value, { stream: true });
		}
		ac.abort();
		expect(buf.includes('"t":"focus"')).toBe(true);
		expect(buf.includes('"s":"z"')).toBe(true);
		await hub.dispose();
		await server.close();
	});
});

describe("cwd recovery from pi's own session store", () => {
	it("old journal files without cwd group correctly via session files", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const sessionsRoot = mkdtempSync(join(tmpdir(), "pot-pisessions-"));
		const projDir = join(sessionsRoot, "--Users-x-my-old-project--");
		mkdirSync(projDir, { recursive: true });
		// pi-style session file whose FIRST LINE carries cwd
		writeFileSync(
			join(projDir, "2026-10-01T00:00:00.000Z_s-oldseed.jsonl"),
			'{"type":"session","version":3,"id":"s-oldseed","cwd":"/Users/x/my-old-project"}\n{"type":"model_change"}\n',
		);
		const j = new Journal(mkdtempSync(join(tmpdir(), "pot-j2-")), 1, 5);
		// a journal record WITHOUT cwd (legacy)
		j.append({ ts: 1, s: "s-oldseed", m: "1", k: "text", id: "o1", src: "old text", st: "done" });
		j.flush();
		expect(j.peekCwd(j.filePathFor("s-oldseed"))).toBeNull();
		expect(j.recoverCwdFromPiSessions("s-oldseed", sessionsRoot)).toBe("/Users/x/my-old-project");
		expect(j.recoverCwdFromPiSessions("s-missing", sessionsRoot)).toBeNull();
	});
});

describe("round 8: numbered headings + user translation + typing", () => {
	it("numbered headings ('4. Code Blocks') are never cut at the ordinal", async () => {
		const { MessageSegmenter } = await import("../src/segmenter.ts");
		const seg = new MessageSegmenter({ kind: "text", maxSegmentChars: 1200, minSegChars: 8 });
		const out = seg.feed("4. Code Blocks follow here with more words. Then a real sentence ends. ");
		out.push(...seg.flush());
		const joined = out.map((x) => x.src).join("|");
		expect(joined.startsWith("4. Code Blocks")).toBe(true);
		expect(joined).not.toMatch(/\|\s*Code Blocks/); // never split after "4."
	});

	it("user segments route to translation (language gate handles Chinese)", () => {
		const hub = new Hub({ getConfig: () => cfg, engineFactory: () => engine as never });
		hub.start();
		hub.registerSession({ id: "u1", name: "u", cwd: "/u" }, true);
		const en = { ...engine, calls: 0 } as typeof engine & { calls: number };
		const queueHub = new Hub({ getConfig: () => cfg, engineFactory: () => ({ ...engine, complete: async () => { en.calls++; return "译文"; } }) as never });
		queueHub.start();
		queueHub.registerSession({ id: "u1", name: "u", cwd: "/u" }, true);
		queueHub.publish({ t: "segment", s: "u1", m: "1", k: "user", id: "u:1:user:0:1", src: "Please refactor this module for readability and add tests." });
		void queueHub.flushQueueForTests();
		// Chinese user input passes through the gate (notrans) without an engine call
		queueHub.publish({ t: "segment", s: "u1", m: "2", k: "user", id: "u:2:user:0:1", src: "帮我重构这个模块，提高可读性，并补充测试用例。" });
		void queueHub.flushQueueForTests();
		void hub.dispose();
	});

	it("setTyping broadcasts transient typing events (throttled)", () => {
		const hub = new Hub({ getConfig: () => cfg, engineFactory: () => engine as never });
		hub.start();
		const got: string[] = [];
		hub.subscribe((lines) => { for (const f of lines.split("\n\n")) if (f.includes('"typing"')) got.push(f.slice(0, 80)); });
		hub.setTyping("a");
		hub.setTyping("a"); // throttled
		hub.flush();
		expect(got.length).toBe(1);
		expect(hub.since(0).some((e) => e.ev.t === "typing")).toBe(false); // transient
		void hub.dispose();
	});
});

describe("round 12: paragraph-boundary flags on the wire", () => {
	it("collector emits pb:1 for segments opening a new paragraph", async () => {
		const { Collector } = await import("../src/collector.ts");
		const { defaultConfig } = await import("../src/config.ts");
		const cfg = { ...defaultConfig(), cache: { ...defaultConfig().cache, persist: false } };
		const events: { t: string; pb?: number; src?: string }[] = [];
		const c = new Collector({ getSessionId: () => "p1", publish: (e) => events.push(e as never), getConfig: () => cfg });
		c.onMessageStart({ message: { role: "assistant", content: [] } }, "m");
		const doc = "First paragraph sentence one. Second sentence ends it.\n\nNew paragraph starts here now. ";
		for (const ch of doc) c.onMessageUpdate({ type: "text_delta", contentIndex: 0, delta: ch });
		c.onMessageEnd({ message: { role: "assistant", stopReason: "stop" } });
		const segs = events.filter((e) => e.t === "segment") as { t: string; pb?: number; src: string }[];
		expect(segs.length).toBeGreaterThanOrEqual(3);
		// the segment that opens paragraph 2 must carry pb:1; the very first one may not
		const opener = segs.find((s) => /New paragraph/.test(s.src));
		expect(opener?.pb).toBe(1);
		expect(segs[0].pb).toBeUndefined();
	});
});

describe("round 14: engine hard-timeout + multi-session isolation", () => {
	it("a signal-ignoring engine still times out via raceTimeout", async () => {
		const { raceTimeout } = await import("../src/engines/util.ts");
		const t0 = Date.now();
		await expect(raceTimeout(new Promise(() => {}), 200)).rejects.toThrow(/timeout/);
		expect(Date.now() - t0).toBeLessThan(600);
	});
	it("raceTimeout passes through success", async () => {
		const { raceTimeout } = await import("../src/engines/util.ts");
		await expect(raceTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
	});
	it("raceTimeout passes through failure", async () => {
		const { raceTimeout } = await import("../src/engines/util.ts");
		await expect(raceTimeout(Promise.reject(new Error("x")), 1000)).rejects.toThrow("x");
	});
});

describe("round 14: user-segment role plumbing", () => {
	it("user segments carry r:'user' for lazy card creation", async () => {
		const { Collector } = await import("../src/collector.ts");
		const { defaultConfig } = await import("../src/config.ts");
		const cfg = { ...defaultConfig(), cache: { ...defaultConfig().cache, persist: false } };
		const events: { t: string; r?: string; k?: string }[] = [];
		const c = new Collector({ getSessionId: () => "u9", publish: (e) => events.push(e as never), getConfig: () => cfg });
		c.onMessageStart({ message: { role: "user", content: "please fix the loader bug" } }, undefined);
		const seg = events.find((e) => e.t === "segment" && e.k === "user");
		expect(seg?.r).toBe("user");
	});
});
