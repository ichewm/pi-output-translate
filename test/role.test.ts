import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoleManager } from "../src/role.ts";
import { defaultConfig, resetConfigCache, type OutputTranslateConfig } from "../src/config.ts";
import { ensureToken, readToken } from "../src/role.ts";
import { OllamaEngine } from "../src/engines/ollama.ts";
import type { AddressInfo } from "node:net";

let dir: string;
const realFetch = globalThis.fetch;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pot-role-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	globalThis.fetch = realFetch;
});

/** Engine that never answers (worst case for isolation). */
class DeadEngine extends OllamaEngine {
	constructor() {
		super({ baseUrl: "http://127.0.0.1:1", model: "x", temperature: 0, timeoutMs: 60_000 });
	}
}

function configWith(port: number): OutputTranslateConfig {
	const cfg = defaultConfig();
	cfg.server.port = port;
	cfg.journal.dir = join(dir, "hist");
	cfg.cache.persist = false;
	return cfg;
}

function makeRole(port: number, id: string, tokenPath: string) {
	const hostActive: string[] = [];
	const role = new RoleManager({
		getConfig: () => {
			const cfg = configWith(port);
			cfg.server.tokenFile = tokenPath;
			return cfg;
		},
		engineFactory: () => new DeadEngine() as never,
		sessionInfo: () => ({ id, name: id, cwd: `/w/${id}` }),
		onHostActive: () => hostActive.push("host"),
		onHostInactive: () => hostActive.push("client"),
		notify: () => {},
	});
	return { role, hostActive };
}

function randomPort(): number {
	return 20000 + Math.floor(Math.random() * 20000);
}

describe("token files", () => {
	it("ensureToken creates once and reads back", () => {
		const p = join(dir, "t.token");
		const t1 = ensureToken(p);
		expect(t1.length).toBeGreaterThanOrEqual(16);
		const t2 = ensureToken(p);
		expect(t2).toBe(t1);
		expect(readToken(p)).toBe(t1);
	});

	it("readToken returns null for missing files", () => {
		expect(readToken(join(dir, "nope.token"))).toBeNull();
	});
});

describe("RoleManager host/client election", () => {
	it("first starter becomes host and registers its session", async () => {
		const port = randomPort();
		const { role, hostActive } = makeRole(port, "host-a", join(dir, `a-${port}.token`));
		await role.start();
		expect(role.state).toBe("host");
		expect(hostActive).toContain("host");
		expect(role.hub!.listSessions().some((s) => s.id === "host-a" && s.local)).toBe(true);
		await role.stop();
		expect(role.state).toBe("none");
	});

	it("second starter becomes client and ingests into the host hub", async () => {
		const port = randomPort();
		const tokenPath = join(dir, `b-${port}.token`);
		const host = makeRole(port, "host-b", tokenPath);
		await host.role.start();
		resetConfigCache();
		const client = makeRole(port, "client-b", tokenPath);
		await client.role.start();
		expect(client.role.state).toBe("client");
		// push an event through the client uplink
		client.role.publishClient({ t: "msg_start", s: "client-b", m: "1", role: "user" });
		await new Promise((r) => setTimeout(r, 300));
		const sessions = host.role.hub!.listSessions();
		expect(sessions.some((s) => s.id === "client-b")).toBe(true);
		const events = host.role.hub!.since(0).map((e) => e.ev);
		expect(events.some((e) => e.t === "msg_start" && e.s === "client-b")).toBe(true);
		await client.role.stop();
		await host.role.stop();
	});

	it("client takes over when the host dies", async () => {
		const port = randomPort();
		const tokenPath = join(dir, `c-${port}.token`);
		const host = makeRole(port, "host-c", tokenPath);
		await host.role.start();
		resetConfigCache();
		const client = makeRole(port, "client-c", tokenPath);
		await client.role.start();
		expect(client.role.state).toBe("client");
		// kill the host without a clean stop (simulates crash)
		await host.role.hub!.dispose();
		host.role.closeServerForTest();
		// force the client to notice: push an event, uplink fails, reconnect runs
		client.role.publishClient({ t: "msg_start", s: "client-c", m: "9", role: "user" });
		// reconnect loop: initial delay 2s
		await new Promise((r) => setTimeout(r, 3500));
		expect(client.role.state).toBe("host");
		expect(client.role.hub!.listSessions().some((s) => s.id === "client-c")).toBe(true);
		await client.role.stop();
	}, 12000);

	it("foreign port occupier is skipped: next port becomes host", async () => {
		resetConfigCache();
		const port = randomPort();
		// occupy with a plain http server that is NOT our app
		const { createServer } = await import("node:http");
		const foreign = createServer((req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ app: "something-else" }));
		});
		await new Promise<void>((r) => foreign.listen(port, "127.0.0.1", r));
		const { role } = makeRole(port, "host-d", join(dir, `d-${port}.token`));
		await role.start();
		expect(role.state).toBe("host");
		expect(role.port).toBe(port + 1); // moved to the next port
		await role.stop();
		await new Promise<void>((r) => foreign.close(() => r()));
	});
});

describe("RoleManager disabled paths", () => {
	it("disabled config short-circuits", async () => {
		const cfg = configWith(randomPort());
		cfg.enabled = false;
		cfg.server.tokenFile = join(dir, "e.token");
		const role = new RoleManager({
			getConfig: () => cfg,
			engineFactory: () => new DeadEngine() as never,
			sessionInfo: () => ({ id: "x", name: "x", cwd: "/x" }),
			onHostActive: () => {},
			onHostInactive: () => {},
			notify: () => {},
		});
		expect(await role.start()).toBe("disabled");
		await role.stop();
	});
});
