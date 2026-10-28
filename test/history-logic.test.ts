/**
 * r12 — 会话/历史/按项目分组 logic fixes.
 *
 * A1  ghost sessions (frontend-only; covered by code review)
 * A2  topic labels (journal.peekTopic + topicFrom)
 * B1  live-session badge in history rows (frontend-only)
 * B2  empty journals are not listed
 * B3  stale empty journals never consume maxFiles slots
 * B4  history replay restores roles (frontend-only)
 * B5  truncation notes (frontend-only)
 * C1  peekCwd falls back to a tail scan
 * C2  cwd/topic metadata cached per mtime; recovery scan memoized
 * C3  group-name disambiguation for same-basename projects
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync, readdirSync } from "node:fs";
// Isolate ALL config/token/journal paths away from the real ~/.pi/agent.
process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "pot-hist-agent-"));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, topicFrom } from "../src/journal.ts";
import { AppServer } from "../src/server.ts";
import { Hub } from "../src/hub.ts";
import { defaultConfig, resetConfigCache, journalDir } from "../src/config.ts";
import type { TranslateEngine } from "../src/types.ts";
import type { AddressInfo } from "node:net";

const TOKEN = "test-token-hist-0123456789";

class NullEngine implements TranslateEngine {
	readonly id = "mock";
	async complete(): Promise<string> {
		return "[1]\n模拟译文";
	}
	async healthCheck(): Promise<boolean> {
		return true;
	}
}

let hub: Hub;
let server: AppServer;
let base: string;
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pot-hist-"));
	resetConfigCache();
	const cfg = defaultConfig();
	hub = new Hub({ getConfig: () => cfg, engineFactory: () => new NullEngine() });
	hub.start();
	server = new AppServer({ hub, token: TOKEN });
	await server.listen(0);
	base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await hub.dispose();
	await server.close();
	rmSync(dir, { recursive: true, force: true });
	rmSync(process.env.PI_AGENT_DIR!, { recursive: true, force: true });
});

const rec = (over: Record<string, unknown>) =>
	JSON.stringify({ ts: 1000, s: "sx", m: "1", k: "text", id: "x", src: "hello world.", st: "done", ...over });

describe("A2: topicFrom / Journal.peekTopic", () => {
	it("topicFrom collapses whitespace, strips list markers, truncates to 32 chars", () => {
		expect(topicFrom("## Fix the login bug")).toBe("Fix the login bug");
		expect(topicFrom("- [ ]   fix\nthe   auth flow")).toBe("fix the auth flow");
		expect(topicFrom("1. hello")).toBe("hello");
		const long = "a".repeat(50);
		expect(topicFrom(long)).toBe("a".repeat(32) + "…");
	});

	it("peekTopic returns the first user record's topic, ignoring text records", () => {
		const file = join(dir, "topic.jsonl");
		writeFileSync(
			file,
			[
				rec({ k: "text", src: "Some assistant prose that comes first." }),
				rec({ m: "2", k: "user", src: "## Fix the login bug please" }),
				rec({ m: "3", k: "user", src: "later user prompt must not win" }),
			].join("\n") + "\n",
		);
		const j = new Journal(dir, 2, 20);
		expect(j.peekTopic(file)).toBe("Fix the login bug please");
	});

	it("peekTopic returns null when the journal has no user records", () => {
		const file = join(dir, "notopic.jsonl");
		writeFileSync(file, rec({ k: "text" }) + "\n");
		const j = new Journal(dir, 2, 20);
		expect(j.peekTopic(file)).toBeNull();
	});
});

describe("C1: peekCwd head-then-tail fallback", () => {
	it("finds cwd in the head", () => {
		const file = join(dir, "head.jsonl");
		writeFileSync(file, rec({ cwd: "/Users/x/proj" }) + "\n");
		const j = new Journal(dir, 2, 20);
		expect(j.peekCwd(file)).toBe("/Users/x/proj");
	});

	it("falls back to the tail when the head predates cwd recording", () => {
		const file = join(dir, "tail.jsonl");
		// >8KB of pre-cwd records, then modern records carrying cwd.
		const lines: string[] = [];
		for (let i = 0; i < 60; i++) lines.push(rec({ m: String(i), src: "y".repeat(200) }));
		writeFileSync(file, lines.join("\n") + "\n" + rec({ m: "end", cwd: "/Users/x/legacy" }) + "\n");
		const j = new Journal(dir, 2, 20);
		expect(j.peekCwd(file)).toBe("/Users/x/legacy");
	});

	it("returns null when no record anywhere carries cwd", () => {
		const file = join(dir, "nocwd.jsonl");
		writeFileSync(file, rec({ src: "short" }) + "\n");
		const j = new Journal(dir, 2, 20);
		expect(j.peekCwd(file)).toBeNull();
	});
});

describe("B3: capFiles — stale empty journals never evict real ones", () => {
	it("deletes stale empty files first, keeps fresh empty, caps the rest", () => {
		const capDir = join(dir, "cap");
		mkdirSync(capDir, { recursive: true });
		const t = (ms: number) => new Date(ms);
		const hourAgo = Date.now() - 7_200_000;
		// three non-empty journals, oldest first
		for (const [name, ms] of [
			["a-old", 1000],
			["b-mid", 2000],
			["c-new", 3000],
		] as const) {
			const f = join(capDir, `${name}.jsonl`);
			writeFileSync(f, rec({ s: name }) + "\n");
			utimesSync(f, t(ms), t(ms));
		}
		// stale empty (would previously steal a slot forever)
		const staleEmpty = join(capDir, "stale-empty.jsonl");
		writeFileSync(staleEmpty, "");
		utimesSync(staleEmpty, t(hourAgo), t(hourAgo));
		// fresh empty (possibly a just-started session — must survive)
		const freshEmpty = join(capDir, "fresh-empty.jsonl");
		writeFileSync(freshEmpty, "");

		const j = new Journal(capDir, 2, 2); // maxFiles = 2
		// one real flush triggers capFiles over the whole directory
		j.append({ ts: Date.now(), s: "d-live", m: "1", k: "text", id: "x1", src: "hello world.", st: "done" });
		j.flush();

		const left = readdirSync(capDir).sort();
		expect(left).toContain("d-live.jsonl");
		expect(left).toContain("fresh-empty.jsonl");
		expect(left).toContain("c-new.jsonl");
		expect(left).not.toContain("stale-empty.jsonl");
		expect(left).not.toContain("b-mid.jsonl");
		expect(left).not.toContain("a-old.jsonl");
	});
});

describe("/api/history r12 behavior (B2/C2/C3 + topic)", () => {
	it("lists topic, filters empty journals, disambiguates same-basename groups", async () => {
		const hd = journalDir();
		mkdirSync(hd, { recursive: true });
		const t = (ms: number) => new Date(ms);
		// two DIFFERENT projects sharing the basename "app"
		writeFileSync(
			join(hd, "h-alpha.jsonl"),
			rec({ s: "h-alpha", cwd: "/Users/x/alpha/app", m: "2", k: "user", src: "## Fix the login bug please" }) + "\n",
		);
		writeFileSync(join(hd, "h-beta.jsonl"), rec({ s: "h-beta", cwd: "/Users/x/beta/app" }) + "\n");
		// unique project
		writeFileSync(join(hd, "h-gamma.jsonl"), rec({ s: "h-gamma", cwd: "/Users/x/gamma" }) + "\n");
		// empty journal — must NOT be listed (B2)
		writeFileSync(join(hd, "h-empty.jsonl"), "");
		utimesSync(join(hd, "h-alpha.jsonl"), t(4000), t(4000));
		utimesSync(join(hd, "h-beta.jsonl"), t(3000), t(3000));
		utimesSync(join(hd, "h-gamma.jsonl"), t(2000), t(2000));
		utimesSync(join(hd, "h-empty.jsonl"), t(5000), t(5000));

		const list = (await (await fetch(`${base}/api/history?token=${TOKEN}`)).json()) as {
			sessions: { sessionId: string; topic: string | null }[];
			groups: { cwd: string; name: string; sessions: { sessionId: string; topic: string | null }[] }[];
			live: string[];
		};
		expect(list.sessions.some((s) => s.sessionId === "h-empty")).toBe(false);
		const alpha = list.groups.find((g) => g.cwd === "/Users/x/alpha/app");
		const beta = list.groups.find((g) => g.cwd === "/Users/x/beta/app");
		const gamma = list.groups.find((g) => g.cwd === "/Users/x/gamma");
		expect(alpha?.name).toBe("alpha/app");
		expect(beta?.name).toBe("beta/app");
		expect(gamma?.name).toBe("gamma"); // unique basename stays short
		expect(alpha?.sessions[0]?.topic).toBe("Fix the login bug please");
		expect(beta?.sessions[0]?.topic).toBeNull(); // no user record
		expect(Array.isArray(list.live)).toBe(true);
	});

	it("caches metadata across calls (mtime-keyed) — second call stays consistent", async () => {
		for (let i = 0; i < 2; i++) {
			const r = await fetch(`${base}/api/history?token=${TOKEN}`);
			expect(r.status).toBe(200);
		}
		const list = (await (await fetch(`${base}/api/history?token=${TOKEN}`)).json()) as {
			groups: { cwd: string; sessions: { sessionId: string }[] }[];
		};
		const alpha = list.groups.find((g) => g.cwd === "/Users/x/alpha/app");
		expect(alpha?.sessions.map((s) => s.sessionId)).toContain("h-alpha");
	});
});

describe("r12c: pi session store fallback (topic + cwd)", () => {
	it("readPiSessionCwd parses the first line", async () => {
		const f = join(dir, "pi-cwd.jsonl");
		writeFileSync(f, JSON.stringify({ type: "session", cwd: "/Users/x/pi-proj" }) + "\n" + JSON.stringify({ type: "message" }) + "\n");
		const { readPiSessionCwd } = await import("../src/journal.ts");
		expect(readPiSessionCwd(f)).toBe("/Users/x/pi-proj");
	});

	it("readPiSessionTopic handles string & array content, skips commands", async () => {
		const { readPiSessionTopic } = await import("../src/journal.ts");
		const msg = (content: unknown) => JSON.stringify({ type: "message", message: { role: "user", content } });
		const a = join(dir, "pi-t1.jsonl");
		writeFileSync(
			a,
			[
				JSON.stringify({ type: "session", cwd: "/p" }),
				JSON.stringify({ type: "message", message: { role: "assistant", content: "hi" } }),
				msg([{ type: "text", text: "帮我把这个项目\n的部署流程整理一下" }]),
			].join("\n") + "\n",
		);
		expect(readPiSessionTopic(a)).toContain("部署流程");
		const b = join(dir, "pi-t2.jsonl");
		writeFileSync(b, [msg("/reload"), msg("- [ ] real task after a command")].join("\n") + "\n");
		expect(readPiSessionTopic(b)).toBe("real task after a command");
	});

	it("/api/history recovers topic AND cwd from the pi store when the journal has neither", async () => {
		const hd = journalDir();
		mkdirSync(hd, { recursive: true });
		// journal without cwd and without user records (pre-r12b Chinese session)
		writeFileSync(join(hd, "h-pifallback.jsonl"), rec({ s: "h-pifallback", k: "text", src: "assistant prose only" }) + "\n");
		// fake pi session store under the ISOLATED agent dir
		const projDir = join(process.env.PI_AGENT_DIR!, "sessions", "--Users-x-web--");
		mkdirSync(projDir, { recursive: true });
		const piFile = join(projDir, "2026-10-28T00-00-00-000Z_h-pifallback.jsonl");
		writeFileSync(
			piFile,
			[
				JSON.stringify({ type: "session", cwd: "/Users/x/web" }),
				JSON.stringify({ type: "message", message: { role: "user", content: "修复登录页面的样式错位问题，顺便看看构建警告" } }),
			].join("\n") + "\n",
		);
		const list = (await (await fetch(`${base}/api/history?token=${TOKEN}`)).json()) as {
			groups: { cwd: string; name: string; sessions: { sessionId: string; topic: string | null }[] }[];
		};
		const g = list.groups.find((x) => x.cwd === "/Users/x/web");
		expect(g).toBeTruthy();
		expect(g!.name).toBe("web");
		expect(g!.sessions[0].topic).toContain("登录页面");
	});
});

describe("r12b: Chinese user prompts feed the topic source (hub.route)", () => {
	it("notrans user segments are journaled (history replay + topic)", async () => {
		hub.publish({
			t: "segment",
			s: "topic-sess",
			m: "m1",
			k: "user",
			id: "seg-topic-1",
			src: "帮我把这个项目的部署流程整理一下，谢谢。",
		});
		// journal writes are batched; journalRead flushes first
		const recs = hub.journalRead("topic-sess");
		const rec = recs.find((r) => r.id === "seg-topic-1");
		expect(rec?.st).toBe("notrans");
		expect(rec?.src).toContain("部署流程");
		expect(rec?.k).toBe("user");
		// and peekTopic turns it into a topic label
		const { Journal } = await import("../src/journal.ts");
		const j = new Journal(journalDir(), 2, 20);
		expect(j.peekTopic(j.filePathFor("topic-sess"))).toContain("部署流程");
	});

	it("notrans non-user segments are still NOT journaled", () => {
		hub.publish({ t: "segment", s: "topic-sess2", m: "m1", k: "text", id: "seg-nt-1", src: "短中文段落不应入库" });
		const recs = hub.journalRead("topic-sess2");
		expect(recs.some((r) => r.id === "seg-nt-1")).toBe(false);
	});
});
