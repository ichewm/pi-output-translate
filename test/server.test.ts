import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
// Isolate ALL config/token/journal paths away from the real ~/.pi/agent
// (an earlier version of this file wrote a test model into the user's
// real config via POST /api/config — never again).
process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "pot-srv-agent-"));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServer } from "../src/server.ts";
import { Hub } from "../src/hub.ts";
import { defaultConfig, resetConfigCache } from "../src/config.ts";
import type { TranslateEngine } from "../src/types.ts";
import type { AddressInfo } from "node:net";

const TOKEN = "test-token-0123456789abcdef";

class NullEngine implements TranslateEngine {
	readonly id = "mock";
	async complete(): Promise<string> {
		return "[1]\n模拟译文";
	}
	async healthCheck(): Promise<boolean> {
		return true;
	}
}

let dir: string;
let hub: Hub;
let server: AppServer;
let base: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pot-srv-"));
	resetConfigCache();
	const cfg = defaultConfig();
	hub = new Hub({ getConfig: () => cfg, engineFactory: () => new NullEngine() });
	hub.start();
	server = new AppServer({ hub, token: TOKEN });
	await server.listen(0);
	const port = (server.server.address() as AddressInfo).port;
	base = `http://127.0.0.1:${port}`;
	hub.registerSession({ id: "sx", name: "proj", cwd: "/tmp/proj" }, true);
});

afterAll(async () => {
	await hub.dispose();
	await server.close();
	rmSync(dir, { recursive: true, force: true });
	rmSync(process.env.PI_AGENT_DIR!, { recursive: true, force: true });
});

describe("AppServer auth & routing", () => {
	it("healthz responds without token with the app fingerprint", async () => {
		const r = await fetch(`${base}/healthz`);
		expect(r.status).toBe(200);
		const j = (await r.json()) as { app: string; host: boolean };
		expect(j.app).toBe("pi-output-translate");
		expect(j.host).toBe(true);
	});

	it("rejects missing/incorrect tokens on API; bare / shows the landing page", async () => {
		expect((await fetch(`${base}/api/config`)).status).toBe(401);
		expect((await fetch(`${base}/api/config?token=wrong`)).status).toBe(401);
		const landing = await fetch(`${base}/`);
		expect(landing.status).toBe(200);
		expect(await landing.text()).toContain("/pot");
		const ok = await fetch(`${base}/?token=${TOKEN}`);
		expect(ok.status).toBe(200);
		// first authenticated visit plants a session cookie…
		const setCookie = ok.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("pot_token=");
		expect(setCookie).toContain("HttpOnly");
		// …which then authorizes a bare asset request
		const viaCookie = await fetch(`${base}/app.js`, { headers: { Cookie: setCookie.split(";")[0] } });
		expect(viaCookie.status).toBe(200);
	});

	it("rejects non-loopback Host headers (DNS rebinding)", async () => {
		const { request } = await import("node:http");
		const url = new URL(`${base}/healthz`);
		const status = await new Promise<number>((resolve) => {
			const req = request(
				{ host: url.hostname, port: Number(url.port), path: url.pathname, method: "GET", headers: { Host: "evil.example.com" } },
				(res) => {
					resolve(res.statusCode ?? 0);
					res.resume();
				},
			);
			req.on("error", () => resolve(-1));
			req.end();
		});
		expect(status).toBe(403);
	});

	it("serves the page with token substitution", async () => {
		const r = await fetch(`${base}/?token=${TOKEN}`);
		const html = await r.text();
		expect(html).toContain("pi 译读");
		expect(html).toContain(TOKEN);
		expect(html).not.toContain("__TOKEN__");
	});

	it("GET /api/config returns the config; POST merges and broadcasts cfg", async () => {
		const g = await (await fetch(`${base}/api/config?token=${TOKEN}`)).json();
		expect(g.config.translate.engine).toBe("ollama");
		const before = hub.currentSeq();
		const p = await (
			await fetch(`${base}/api/config?token=${TOKEN}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ config: { translate: { model: "test-model-x" } } }),
			})
		).json();
		expect(p.ok).toBe(true);
		expect(p.config.translate.model).toBe("test-model-x");
		const events = hub.since(before).map((e) => e.ev);
		expect(events.some((e) => e.t === "cfg")).toBe(true);
	});

	it("ingest accepts whitelisted events and registers the session", async () => {
		const before = hub.currentSeq();
		const r = await fetch(`${base}/api/ingest?token=${TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				session: { id: "cl1", name: "cl", cwd: "/tmp/cl" },
				events: [{ t: "msg_start", s: "cl1", m: "1", role: "user" }],
			}),
		});
		expect(r.status).toBe(200);
		const events = hub.since(before).map((e) => e.ev);
		expect(events.some((e) => e.t === "session_up")).toBe(true);
		expect(events.some((e) => e.t === "msg_start")).toBe(true);
		// non-whitelisted events are dropped
		const r2 = await fetch(`${base}/api/ingest?token=${TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session: { id: "cl1", name: "cl", cwd: "" }, events: [{ t: "status", q: 0, eng: true, drop: 0, clients: 0 }] }),
		});
		expect(r2.status).toBe(200);
		const after = hub.since((await r2.json()).seq - 1).map((e) => e.ev);
		expect(after.every((e) => e.t !== "status")).toBe(true);
	});

	it("rejects oversized event arrays", async () => {
		const r = await fetch(`${base}/api/ingest?token=${TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session: { id: "x", name: "x", cwd: "" }, events: new Array(2500).fill({ t: "msg_end", s: "x", m: "1" }) }),
		});
		expect(r.status).toBe(400);
	});

	it("mute endpoint toggles session mute", async () => {
		const r = await fetch(`${base}/api/sessions/sx/mute?token=${TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ muted: true }),
		});
		expect(r.status).toBe(200);
		expect(hub.listSessions().find((s) => s.id === "sx")?.muted).toBe(true);
		await fetch(`${base}/api/sessions/sx/mute?token=${TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ muted: false }),
		});
		expect(hub.listSessions().find((s) => s.id === "sx")?.muted).toBe(false);
	});

	it("sessions remove endpoint removes the session", async () => {
		await fetch(`${base}/api/sessions?token=${TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session: { id: "tmp1", name: "t", cwd: "" } }),
		});
		expect(hub.listSessions().some((s) => s.id === "tmp1")).toBe(true);
		await fetch(`${base}/api/sessions?token=${TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ session: { id: "tmp1", name: "t", cwd: "" }, remove: true }),
		});
		expect(hub.listSessions().some((s) => s.id === "tmp1")).toBe(false);
	});

	it("SSE: hello + replay after a cursor, then live events", async () => {
		const markerBefore = hub.currentSeq();
		hub.publish({ t: "msg_end", s: "sx", m: "marker" });
		const ac = new AbortController();
		const res = await fetch(`${base}/events?token=${TOKEN}&since=${markerBefore}`, { signal: ac.signal });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let buf = "";
		const seen: string[] = [];
		const readUntil = async (pred: (s: string) => boolean) => {
			for (;;) {
				const chunk = await reader.read();
				buf += dec.decode(chunk.value ?? new Uint8Array(), { stream: true });
				for (;;) {
					const idx = buf.indexOf("\n\n");
					if (idx === -1) break;
					const frame = buf.slice(0, idx);
					buf = buf.slice(idx + 2);
					if (frame.startsWith("data: ")) {
						const payload = frame.slice(6);
						seen.push(payload);
						if (pred(payload)) return;
					}
				}
				if (chunk.done) throw new Error("stream ended early");
			}
		};
		// hello first
		await readUntil((p) => p.includes('"hello"'));
		// replay of the marker event
		await readUntil((p) => p.includes("marker"));
		// live event arrives after subscription
		hub.publish({ t: "msg_end", s: "sx", m: "live" });
		await readUntil((p) => p.includes("live"));
		ac.abort();
	}, 20000);

	it("engine endpoints: models, test, retry, cache", async () => {
		const m = await (await fetch(`${base}/api/engine/models?token=${TOKEN}`)).json();
		expect(m).toEqual({ models: [] });
		const t = await (
			await fetch(`${base}/api/engine/test?token=${TOKEN}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			})
		).json();
		expect(t.ok).toBe(true);
		const retry = await fetch(`${base}/api/retry?token=${TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ segId: "nope" }),
		});
		expect(retry.status).toBe(404);
		const stats = await (await fetch(`${base}/api/cache/stats?token=${TOKEN}`)).json();
		expect(typeof stats.size).toBe("number");
	});

	it("history endpoints serve journal list and records", async () => {
		const list = await (await fetch(`${base}/api/history?token=${TOKEN}`)).json();
		expect(Array.isArray(list.sessions)).toBe(true);
	});

	it("history groups by cwd, names by last path segment, sorts by mtime (round 10)", async () => {
		const { writeFileSync, mkdirSync, utimesSync } = await import("node:fs");
		const { journalDir } = await import("../src/config.ts");
		const dir = journalDir();
		mkdirSync(dir, { recursive: true });
		const rec = (ts: number, s: string, cwd?: string) =>
			JSON.stringify({ ts, s, cwd, m: "1", k: "text", id: "x", src: "hello world.", tgt: "你好，世界。" });
		writeFileSync(join(dir, "sess-old.jsonl"), rec(1000, "sess-old", "/Users/x/projectA") + "\n");
		writeFileSync(join(dir, "sess-new.jsonl"), rec(2000, "sess-new", "/Users/x/projectA") + "\n");
		writeFileSync(join(dir, "sess-nocwd.jsonl"), rec(1500, "sess-nocwd") + "\n");
		// deterministic mtimes — filesystem timestamp resolution is not
		const t = (ms: number) => new Date(ms);
		utimesSync(join(dir, "sess-old.jsonl"), t(1000), t(1000));
		utimesSync(join(dir, "sess-new.jsonl"), t(2000), t(2000));
		utimesSync(join(dir, "sess-nocwd.jsonl"), t(1500), t(1500));

		const list = (await (await fetch(`${base}/api/history?token=${TOKEN}`)).json()) as {
			sessions: { sessionId: string }[];
			groups: { cwd: string; name: string; sessions: { sessionId: string }[] }[];
		};
		// global order: mtime desc among the fixtures (other tests' entries may interleave)
		const ids = list.sessions.map((s) => s.sessionId);
		expect(ids.indexOf("sess-new")).toBeGreaterThan(-1);
		expect(ids.indexOf("sess-new")).toBeLessThan(ids.indexOf("sess-nocwd"));
		expect(ids.indexOf("sess-nocwd")).toBeLessThan(ids.indexOf("sess-old"));
		// grouping + naming: last path segment, cwd-desc inside the group
		const gA = list.groups.find((g) => g.cwd === "/Users/x/projectA");
		expect(gA?.name).toBe("projectA");
		expect(gA?.sessions.map((s) => s.sessionId)).toEqual(["sess-new", "sess-old"]);
		// records without cwd land in the unknown group
		const gUnknown = list.groups.find((g) => g.cwd === "");
		expect(gUnknown?.sessions.some((s) => s.sessionId === "sess-nocwd")).toBe(true);
		expect(gUnknown?.name).toContain("未知");
		// per-session detail round-trips the records
		const detail = (await (await fetch(`${base}/api/history/sess-new?token=${TOKEN}`)).json()) as {
			records: { src: string; tgt?: string }[];
		};
		expect(detail.records[0]?.src).toBe("hello world.");
		expect(detail.records[0]?.tgt).toBe("你好，世界。");
	});
});
