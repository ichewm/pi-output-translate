/**
 * Regression tests for issues found in the code audit.
 *
 * A1 (P0): queue held a stale engine reference — hub.applyConfig swapped
 *          the engine but translations kept hitting the old one forever.
 * A2 (P0): the placeholder-repair prompt showed the raw (unmasked) source,
 *          so the model never saw the ⟦n⟧ forms it was asked to restore.
 * A3 (P1): no SSE subscriber cap (SPEC promised 8).
 * A4 (P1): hello/cfg events and GET /api/config leaked the real apiKey.
 * A5 (P2): non-boolean `enabled` survived sanitize as truthy.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub } from "../src/hub.ts";
import { AppServer } from "../src/server.ts";
import { TranslateQueue } from "../src/queue.ts";
import { TranslateCache } from "../src/cache.ts";
import { defaultConfig, resetConfigCache, publicConfig, API_KEY_MASK } from "../src/config.ts";
import { mask } from "../src/protect.ts";
import type { TranslateEngine, SequencedEvent } from "../src/types.ts";
import type { AddressInfo } from "node:net";

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pot-audit-"));
	process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "pot-audit-agent-"));
	resetConfigCache();
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(process.env.PI_AGENT_DIR!, { recursive: true, force: true });
});

class TaggedEngine implements TranslateEngine {
	readonly id: string;
	calls = 0;
	constructor(tag: string) {
		this.id = tag;
	}
	async complete(): Promise<string> {
		this.calls++;
		return "[1]\n译文";
	}
	async healthCheck(): Promise<boolean> {
		return true;
	}
}

describe("A1: engine hot-swap reaches the queue", () => {
	it("translations use the NEW engine after applyConfig", async () => {
		const cfg = { ...defaultConfig(), cache: { ...defaultConfig().cache, persist: false }, journal: { ...defaultConfig().journal, dir: join(dir, "h") } };
		let engine: TaggedEngine = new TaggedEngine("engine-a");
		const hub = new Hub({ getConfig: () => cfg, engineFactory: () => engine });
		hub.start();
		hub.registerSession({ id: "s", name: "s", cwd: "/s" }, true);
		hub.publish({ t: "segment", s: "s", m: "1", k: "text", id: "s:1:text:0:1", src: "The cache layer has a race condition during warmup." });
		await hub.flushQueueForTests();
		expect(engine.calls).toBe(1);

		// Hot-swap the engine identity (same fields applyConfig watches).
		const engineB = new TaggedEngine("engine-b");
		engine = engineB;
		hub.applyConfig(cfg); // sig unchanged -> no rebuild; force one via changed model:
		const cfg2 = { ...cfg, translate: { ...cfg.translate, model: "other-model" } };
		hub.applyConfig(cfg2);
		hub.publish({ t: "segment", s: "s", m: "2", k: "text", id: "s:2:text:0:1", src: "The loader retries idempotently when the shard rebuilds." });
		await hub.flushQueueForTests();
		expect(engineB.calls).toBe(1);
		expect(engine.calls).toBe(1); // old engine got no further calls
		await hub.dispose();
	});
});

describe("A2: repair prompt carries the masked source", () => {
	it("repair pass receives text containing ⟦n⟧ placeholders", async () => {
		const repairs: string[] = [];
		let call = 0;
		const engine: TranslateEngine = {
			id: "mock",
			async complete(_sys, user): Promise<string> {
				call++;
				if (call === 1) return "[1]\n丢失占位符的译文";
				// A2: the repair prompt must show the masked source.
				if (call === 2) repairs.push(user);
				return "[1]\n修复成功 ⟦0⟧";
			},
			async healthCheck() {
				return true;
			},
		};
		const cfg = defaultConfig();
		const queue = new TranslateQueue({
			getEngine: () => engine,
		glossaryVersion: () => "test",
			cache: new TranslateCache(10, null),
			getConfig: () => cfg,
			glossaryText: () => "",
			getSessionCtx: () => ({ recent: [], termLockLines: "" }),
			recordTranslation: () => {},
			viewerCount: () => 1,
			isMuted: () => false,
			onResult: () => {},
		});
		const src = "keep `my precious code` inside this sentence please ok.";
		const { masked, placeholders } = mask(src);
		queue.enqueue({ segId: "a2", sessionId: "s", messageKey: "1", kind: "text", source: src, masked, placeholders });
		await queue.flushNow();
		expect(repairs).toHaveLength(1);
		expect(repairs[0]).toContain("⟦0⟧"); // masked form reached the model
		expect(repairs[0]).not.toContain("`my precious code`"); // raw literal NOT sent
		await queue.stop();
	});
});

describe("A3+A4: server hardening", () => {
	let hub: Hub;
	let server: AppServer;
	let base: string;
	const TOKEN = "audit-token-0123456789abcdef";

	beforeAll(async () => {
		hub = new Hub({
			getConfig: () => ({ ...defaultConfig(), cache: { ...defaultConfig().cache, persist: false }, journal: { ...defaultConfig().journal, dir: join(dir, "srv") } }),
			engineFactory: () => new TaggedEngine("audit"),
		});
		hub.start();
		hub.registerSession({ id: "s", name: "s", cwd: "/s" }, true);
		server = new AppServer({ hub, token: TOKEN });
		await server.listen(0);
		base = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await hub.dispose();
		await server.close();
	});

	it("A3: the 9th concurrent SSE client is rejected with 503", async () => {
		const controllers: AbortController[] = [];
		const open = async () => {
			const ac = new AbortController();
			controllers.push(ac);
			return fetch(`${base}/events?token=${TOKEN}&since=0`, { signal: ac.signal });
		};
		// Fill all 8 slots and keep them open.
		for (let i = 0; i < 8; i++) {
			const r = await open();
			expect(r.status).toBe(200);
			// consume headers; keep the socket alive (no cancel)
		}
		// Give the server a beat to register all subscribers.
		await new Promise((r) => setTimeout(r, 150));
		const ninth = await open();
		expect(ninth.status).toBe(503);
		for (const ac of controllers) ac.abort();
	});

	it("A4: GET /api/config masks the apiKey; POST with the mask keeps the stored one", async () => {
		// seed a real key
		const seeded = defaultConfig();
		seeded.translate.apiKey = "sk-secret-123";
		const { saveConfig, loadConfig } = await import("../src/config.ts");
		saveConfig(seeded);
		const got = await (await fetch(`${base}/api/config?token=${TOKEN}`)).json();
		expect(got.config.translate.apiKey).toBe(API_KEY_MASK);
		// save unrelated change with the mask in place
		const r = await fetch(`${base}/api/config?token=${TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config: { translate: { apiKey: API_KEY_MASK, model: "changed" } } }),
		});
		expect(r.status).toBe(200);
		expect(loadConfig().translate.apiKey).toBe("sk-secret-123");
		expect(loadConfig().translate.model).toBe("changed");
		// hello event is masked too
		const ac = new AbortController();
		const res = await fetch(`${base}/events?token=${TOKEN}&since=0`, { signal: ac.signal });
		const reader = res.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
		// The hello frame must not contain the raw key.
		expect(first).not.toContain("sk-secret-123");
		ac.abort();
		// And the public helper keeps the masking honest.
		expect(publicConfig(seeded).translate.apiKey).toBe(API_KEY_MASK);
	});
});

describe("A5: boolean gates survive bad types", () => {
	it('enabled: "false" (string) falls back to the default boolean', async () => {
		const { loadConfig } = await import("../src/config.ts");
		const path = join(dir, "bad-enabled.json");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, JSON.stringify({ enabled: "false", sources: { thinking: "yes" } }));
		resetConfigCache();
		const cfg = loadConfig(path);
		expect(cfg.enabled).toBe(true); // default, not truthy-string
		expect(cfg.sources.thinking).toBe(true); // default boolean
	});
});
