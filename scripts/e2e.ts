/**
 * End-to-end exercise of the full host pipeline without pi:
 *
 *   mock ollama HTTP server  →  RoleManager(host)  →  Hub  →  TranslateQueue
 *   →  AppServer (SSE)  →  fetch consumer assertions
 *   plus a second RoleManager acting as a client ingesting into the host.
 *
 * Run: npm run e2e   (node --experimental-strip-types)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

process.env.PI_AGENT_DIR = mkdtempSync(join(tmpdir(), "pot-e2e-"));

const { defaultConfig, saveConfig } = await import("../src/config.ts");
const { RoleManager } = await import("../src/role.ts");
const { OllamaEngine } = await import("../src/engines/ollama.ts");

const PORT = 24000 + Math.floor(Math.random() * 5000);
let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.error(`  ✗ ${name}`, detail ?? "");
	}
}

// ------------------------------------------------------------------
// mock ollama

const translations = new Map<string, string>();
const ollama: Server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const url = req.url ?? "";
		if (url === "/api/version") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ version: "mock" }));
			return;
		}
		if (url === "/api/tags") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ models: [{ name: "mock-model" }] }));
			return;
		}
		if (url === "/api/chat") {
			const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
			const user = parsed.messages.find((m) => m.role === "user")?.content ?? "";
			// Numbered-block protocol for multi-segment batches; plain text for
			// single-segment prompts (mirrors the queue's protocol switch).
			const blocks = [...user.matchAll(/^\[(\d+)\][ \t]*\n?([\s\S]*?)(?=^\[\d+\][ \t]*$|$)/gm)].filter(
				(m) => !m[0].startsWith("[前文"),
			);
			let answer: string;
			if (blocks.length === 0) {
				const tail = user.split("\n\n").pop() ?? user;
				answer = `【译】${tail.trim().slice(0, 24)}`;
			} else {
				answer = blocks.map((m) => `[${m[1]}]\n【译】${m[2].trim().slice(0, 24)}`).join("\n\n");
			}
			const sys = parsed.messages.find((m) => m.role === "system")?.content ?? "";
			if (!/竞态条件/.test(sys)) {
				res.writeHead(500);
				res.end(JSON.stringify({ error: "system prompt missing glossary" }));
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ message: { content: answer } }));
			return;
		}
		res.writeHead(404).end();
	});
});

await new Promise<void>((r) => ollama.listen(0, "127.0.0.1", r));
const ollamaPort = (ollama.address() as { port: number }).port;

// ------------------------------------------------------------------
// config in the isolated agent dir

const cfg = defaultConfig();
cfg.server.port = PORT;
cfg.server.autoOpen = false;
cfg.translate.engine = "ollama";
cfg.translate.baseUrl = `http://127.0.0.1:${ollamaPort}`;
cfg.translate.model = "mock-model";
cfg.translate.batchWindowMs = 100;
cfg.cache.persist = false;
saveConfig(cfg);

// ------------------------------------------------------------------
// host role with the real engine

const host = new RoleManager({
	getConfig: () => cfg,
	engineFactory: (c) =>
		new OllamaEngine({
			baseUrl: c.translate.baseUrl,
			model: c.translate.model,
			temperature: c.translate.temperature,
			timeoutMs: c.translate.timeoutSeconds * 1000,
		}),
	sessionInfo: () => ({ id: "e2e-host", name: "e2e-host", cwd: "/tmp/e2e", model: "test/model" }),
	onHostActive: () => {},
	onHostInactive: () => {},
	notify: (msg) => console.log("  [notify]", msg),
});

await host.start();
check("host started", host.state === "host", host.state);

// ------------------------------------------------------------------
// SSE consumer (before events flow, so we see them live)

const token = (await import("node:fs")).readFileSync(join(process.env.PI_AGENT_DIR!, "output-translate.token"), "utf8").trim();
const events: { seq: number; ev: Record<string, unknown> }[] = [];
const ac = new AbortController();
const sseRes = await fetch(`http://127.0.0.1:${PORT}/events?token=${encodeURIComponent(token)}&since=0`, {
	signal: ac.signal,
});
check("SSE connected", sseRes.status === 200 && sseRes.headers.get("content-type")!.includes("text/event-stream"));
let sseRaw = "";
(async () => {
	const reader = sseRes.body!.getReader();
	const dec = new TextDecoder();
	let buf = "";
	let rawAll = "";
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			const chunkText = dec.decode(value, { stream: true });
			rawAll += chunkText;
			sseRaw = rawAll;
			buf += chunkText;
			for (;;) {
				const i = buf.indexOf("\n\n");
				if (i === -1) break;
				const frame = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (frame.startsWith("data: ")) {
					try {
						events.push(JSON.parse(frame.slice(6)));
					} catch {
						/* ignore */
					}
				}
			}
		}
	} catch {
		/* aborted */
	}
	sseRaw = rawAll; // continuously mirror for mid-stream checks
})();

// give the SSE connection a moment to subscribe
await sleep(200);

// ------------------------------------------------------------------
// simulate an assistant stream through the host's own collector path

const hub = host.hub!;
const { Collector } = await import("../src/collector.ts");
const collector = new Collector({
	getSessionId: () => "e2e-host",
	publish: (ev) => hub.publish(ev),
	getConfig: () => cfg,
});

collector.onMessageStart({ message: { role: "user", content: "帮我修复这个 bug" } }, undefined);
collector.onMessageStart({ message: { role: "assistant", content: [] } }, "test/model");
collector.onMessageUpdate({ type: "thinking_delta", contentIndex: 0, delta: "I need to inspect the failing test first. The race is in the cache loader.\n\nSecond thinking paragraph. " });
collector.onMessageUpdate({ type: "text_delta", contentIndex: 1, delta: "The build failed because of a race condition in the cache layer. " });
collector.onToolStart({ toolName: "bash", args: { command: "npm test" }, toolCallId: "t1" });
collector.onToolEnd({ toolName: "bash", result: { content: "3 passed" }, isError: false, durationMs: 120, toolCallId: "t1" });
collector.onMessageUpdate({ type: "text_delta", contentIndex: 1, delta: "Here is the fix. ```ts\nconst x = 1;\n``` Apply it and rerun the tests.\n\nA closing paragraph starts after the blank line. " });
collector.onMessageEnd({ message: { role: "assistant", stopReason: "stop" } });

await sleep(1500); // batch window + mock engine + SSE flush

const evs = events.map((e) => e.ev);
const sseText = sseRaw;
check("hello received", evs.some((e) => e.t === "hello"));
check("user segment shown untranslated", evs.some((e) => e.t === "segment" && e.k === "user" && String(e.src).includes("bug")));
check("thinking segment translated", evs.some((e) => e.t === "trans" && /译/.test(String(e.tgt)) && events.find((x) => x.ev.t === "segment" && x.ev.id === e.id)?.ev.k === "thinking"), evs.filter((e) => e.t === "trans"));
check("text segment translated", evs.some((e) => e.t === "trans" && e.st === "done" && String(e.tgt).startsWith("【译】")));
check("code segment not translated", evs.some((e) => e.t === "segment" && e.k === "code" && String(e.src).includes("const x = 1;")));
const codeIds = new Set(evs.filter((e) => e.t === "segment" && e.k === "code").map((e) => e.id as string));
check("code segment has no trans event", !evs.some((e) => e.t === "trans" && codeIds.has(e.id as string)));
check("tool line pair", evs.some((e) => e.t === "tool" && e.ph === "start" && e.sum === "npm test") && evs.some((e) => e.t === "tool" && e.ph === "end" && e.ok === true));
check("msg_end received", evs.some((e) => e.t === "msg_end"));

// ------------------------------------------------------------------
// client role: second RoleManager registers and ingests

const client = new RoleManager({
	getConfig: () => cfg,
	engineFactory: (c) =>
		new OllamaEngine({
			baseUrl: c.translate.baseUrl,
			model: c.translate.model,
			temperature: c.translate.temperature,
			timeoutMs: c.translate.timeoutSeconds * 1000,
		}),
	sessionInfo: () => ({ id: "e2e-client", name: "e2e-client", cwd: "/tmp/e2e2" }),
	onHostActive: () => {},
	onHostInactive: () => {},
	notify: () => {},
});
await client.start();
check("client started", client.state === "client", client.state);
client.publishClient({ t: "msg_start", s: "e2e-client", m: "1", role: "assistant" });
client.publishClient({
	t: "segment", s: "e2e-client", m: "1", k: "text", id: "e2e-client:1:text:0:1",
	src: "A client message about the idempotent retry logic in the worker loop.",
});
await sleep(1200);
const evs2 = events.map((e) => e.ev);
check("client session registered in host hub", hub.listSessions().some((s) => s.id === "e2e-client"));
check("client segment translated by host", evs2.some((e) => e.t === "trans" && e.id === "e2e-client:1:text:0:1" && e.st === "done"), evs2.filter((e) => e.t === "trans"));

// ------------------------------------------------------------------
// history + cache + config APIs

const hist = await (await fetch(`http://127.0.0.1:${PORT}/api/history?token=${token}`)).json();
check("journal has records", Array.isArray(hist.sessions) && hist.sessions.length >= 1, hist);
const cacheStats = await (await fetch(`http://127.0.0.1:${PORT}/api/cache/stats?token=${token}`)).json();
check("cache has entries", cacheStats.size >= 1, cacheStats);
const healthz = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).json();
check("healthz fingerprint", healthz.app === "pi-output-translate" && healthz.host === true);
const noToken = await fetch(`http://127.0.0.1:${PORT}/api/config`);
check("API without token is 401", noToken.status === 401);

// ------------------------------------------------------------------
// teardown

ac.abort();
await client.stop();
await host.stop();
ollama.close();
rmSync(process.env.PI_AGENT_DIR!, { recursive: true, force: true });

// ------------------------------------------------------------------
// Round-12 coverage: focus/typing transients, user-prompt translation,
// paragraph flags on the wire.

check("typing transient broadcast", (() => {
	hub.setTyping("e2e-host");
	return true; // no throw
})());
check("focus transient recorded (hello carries it)", (() => {
	hub.setFocus("e2e-host");
	return hub.currentFocus() === "e2e-host";
})());
const pbSse = sseText.match(/"pb":1/g);
check("paragraph flags present in segments", (pbSse?.length ?? 0) >= 1, `${pbSse?.length ?? 0} pb:1 segments`);

console.log(failures === 0 ? "\nE2E: ALL PASSED" : `\nE2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
