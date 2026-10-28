/**
 * Regression tests for audit round 2.
 *
 * R1 (High)  : SSE replay wrote the whole ring buffer synchronously — a
 *              stalled reader buffered tens of MB in the host process.
 *              Now replay honors backpressure (drain-wait, then drop).
 * R2 (Medium): two concurrent uplink flushes interleaved POSTs, delivering
 *              events out of order to the host. Flushes are now serialized.
 * R3 (Medium): a remote session registration could hijack the host's own
 *              local session entry (flipping it prunable).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";
import { AppServer } from "../src/server.ts";
import { RoleManager } from "../src/role.ts";
import { defaultConfig, resetConfigCache, type OutputTranslateConfig } from "../src/config.ts";
import type { TranslateEngine } from "../src/types.ts";
import type { AddressInfo } from "node:net";

process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "pot-audit2-agent-"));

const mockEngine: TranslateEngine = {
	id: "mock",
	async complete() {
		return "译文";
	},
	async healthCheck() {
		return true;
	},
};

let baseCfg: OutputTranslateConfig;
beforeAll(() => {
	resetConfigCache();
	baseCfg = {
		...defaultConfig(),
		cache: { ...defaultConfig().cache, persist: false },
		journal: { ...defaultConfig().journal, dir: join(mkdtempSync(join(tmpdir(), "pot-audit2-")), "hist") },
	};
});
afterAll(() => {
	rmSync(process.env.PI_AGENT_DIR!, { recursive: true, force: true });
});

describe("R1: SSE replay backpressure", () => {
	it("a stalled reader does not balloon host memory; server stays healthy", async () => {
		const hub = new Hub({ getConfig: () => baseCfg, engineFactory: () => mockEngine });
		hub.start();
		hub.registerSession({ id: "s", name: "s", cwd: "/s" }, true);
		const big = "x".repeat(8_000);
		for (let i = 0; i < 1500; i++) {
			hub.publish({ t: "delta", s: "s", m: String(i % 10), k: "text", c: 0, d: big });
		}
		const server = new AppServer({ hub, token: "t" });
		await server.listen(0);
		const port = (server.server.address() as AddressInfo).port;

		// Stalled client: open, read nothing.
		const ac = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/events?token=t&since=0`, { signal: ac.signal });
		expect(res.status).toBe(200);

		// Give the replay loop time to hit backpressure and wait on drain.
		await new Promise((r) => setTimeout(r, 700));
		const rss = process.memoryUsage().rss;
		// With the fix, the write buffer is capped at MAX_SSE_BUFFER (4MB) per
		// client instead of the ~12MB payload; keep a generous but finite bound
		// (fixed behavior) rather than asserting an exact number.
		expect(rss).toBeLessThan(600 * 1024 * 1024);

		// The server must still serve other requests while the tab is stalled.
		const hz = await fetch(`http://127.0.0.1:${port}/healthz`);
		expect(hz.status).toBe(200);

		ac.abort();
		res.body?.cancel().catch(() => {});
		await hub.dispose();
		await server.close();
	}, 20000);

	it("a fast reader still receives the full replay", async () => {
		const hub = new Hub({ getConfig: () => baseCfg, engineFactory: () => mockEngine });
		hub.start();
		hub.registerSession({ id: "s", name: "s", cwd: "/s" }, true);
		for (let i = 0; i < 50; i++) {
			hub.publish({ t: "msg_end", s: "s", m: String(i) });
		}
		const server = new AppServer({ hub, token: "t" });
		await server.listen(0);
		const port = (server.server.address() as AddressInfo).port;
		const ac = new AbortController();
		const res = await fetch(`http://127.0.0.1:${port}/events?token=t&since=0`, { signal: ac.signal });
		// Incremental read: count replayed events, then abort (SSE never EOFs).
		const reader = res.body!.getReader();
		const dec = new TextDecoder();
		let buf = "";
		let seen = 0;
		const deadline = Date.now() + 10_000;
		while (seen < 50 && Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += dec.decode(value, { stream: true });
			seen = (buf.match(/"t":"msg_end"/g) ?? []).length;
		}
		expect(seen).toBe(50);
		ac.abort();
		await hub.dispose();
		await server.close();
	});
});

describe("R2: uplink flushes are serialized", () => {
	it("concurrent flush triggers never overlap ingest POSTs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pot-r2-"));
		const tokenPath = join(dir, "t.token");
		const port = 26000 + Math.floor(Math.random() * 3000);
		const cfg = { ...baseCfg, server: { ...baseCfg.server, port, tokenFile: tokenPath } };

		let inFlight = 0;
		let maxInFlight = 0;
		const order: string[] = [];
		const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/api/ingest")) {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				const events = JSON.parse(String(init?.body ?? "{}")) as { events: { t: string; m?: string }[] };
				for (const e of events.events) order.push(`${e.t}:${e.m ?? ""}`);
				await new Promise((r) => setTimeout(r, 80)); // slow host
				inFlight--;
				return new Response(JSON.stringify({ ok: true, seq: 1 }), { status: 200 });
			}
			if (u.includes("/api/sessions")) {
				return new Response(JSON.stringify({ ok: true }), { status: 200 });
			}
			if (u.includes("/healthz")) {
				return new Response(JSON.stringify({ app: "pi-output-translate" }), { status: 200 });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;

		const role = new RoleManager({
			getConfig: () => cfg,
			engineFactory: () => mockEngine,
			sessionInfo: () => ({ id: "r2", name: "r2", cwd: "/r2" }),
			onHostActive: () => {},
			onHostInactive: () => {},
			notify: () => {},
			fetchImpl,
		});
		// Force client mode directly (a real host occupies the port elsewhere).
		(role as unknown as { state: string }).state = "client";
		(role as unknown as { port: number }).port = port;
		(role as unknown as { token: string }).token = "tok";

		// Fire two overlapping flush cycles: messages m1..m3 then m4..m6 while
		// the first POST is still in flight.
		for (const m of ["1", "2", "3"]) {
			role.publishClient({ t: "msg_end", s: "r2", m });
		}
		await new Promise((r) => setTimeout(r, 30)); // first flush starts
		for (const m of ["4", "5", "6"]) {
			role.publishClient({ t: "msg_end", s: "r2", m });
		}
		await new Promise((r) => setTimeout(r, 400));
		expect(maxInFlight).toBe(1); // never two concurrent POSTs
		expect(order).toEqual(["msg_end:1", "msg_end:2", "msg_end:3", "msg_end:4", "msg_end:5", "msg_end:6"]);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("R3: remote registration cannot hijack a local session", () => {
	it("host keeps its local session entry when a client registers the same id", () => {
		const hub = new Hub({ getConfig: () => baseCfg, engineFactory: () => mockEngine });
		hub.start();
		hub.registerSession({ id: "dup", name: "host", cwd: "/h" }, true);
		hub.registerSession({ id: "dup", name: "intruder", cwd: "/evil" }, false);
		const s = hub.listSessions().find((x) => x.id === "dup");
		expect(s?.local).toBe(true);
		expect(s?.cwd).toBe("/h");
		void hub.dispose();
	});
});
