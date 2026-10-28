/**
 * Local HTTP server: SSE fan-out, ingest API, config/engine/history APIs and
 * the static reader page. Loopback-only; Host-header checked (DNS-rebinding
 * hardening); every API route requires the shared token (query or Bearer).
 *
 * The server is intentionally dumb: routing + auth + serialization. All state
 * lives in the Hub; all policy lives in the queue.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { Hub } from "./hub.ts";
import { APP_ID, APP_VERSION, PIPELINE_VER } from "./types.ts";
import type { HubEvent } from "./types.ts";
import { deepMerge, loadConfig, saveConfig, publicConfig } from "./config.ts";
import type { OutputTranslateConfig } from "./config.ts";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");
const BODY_LIMIT = 1024 * 1024;
const MAX_SSE_BUFFER = 4 * 1024 * 1024;
const MAX_SSE_CLIENTS = 8;
const API_KEY_MASK = "••••";

export class AppServer {
	readonly server: Server;
	private readonly hub: Hub;
	private readonly token: string;
	private readonly onConfigSaved: (cfg: OutputTranslateConfig) => void;
	private started = false;
	/** Live SSE responses, ended gracefully on close (no truncated chunks). */
	private readonly sseResponses = new Set<ServerResponse>();
	/**
	 * History metadata cache (C2): cwd+topic per session, invalidated when
	 * the journal's mtime changes. The pi-session-store recovery scan is the
	 * expensive path (hundreds of files) — its positive results are memoized
	 * permanently because a session's cwd never changes.
	 */
	private readonly histMeta = new Map<string, { mtime: number; cwd: string; topic: string | null }>();
	private readonly recoveredCwds = new Map<string, string>();
	/** pi-store topic fallback per session (memoized permanently — the pi
	 * session file never changes once written). */
	private readonly piTopics = new Map<string, string | null>();

	constructor(opts: {
		hub: Hub;
		token: string;
		onConfigSaved?: (cfg: OutputTranslateConfig) => void;
	}) {
		this.hub = opts.hub;
		this.token = opts.token;
		this.onConfigSaved = opts.onConfigSaved ?? (() => {});
		this.server = createServer((req, res) => {
			// Errors on an individual socket must never bubble into pi.
			res.on("error", () => res.destroy());
			req.on("error", () => req.destroy());
			void this.handle(req, res).catch((err) => {
				try {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: String((err as Error)?.message ?? err) }));
				} catch {
					/* already gone */
				}
			});
		});
		// Long-lived SSE sockets should not keep the process alive artificially.
		this.server.headersTimeout = 0;
		this.server.requestTimeout = 0;
		this.server.keepAliveTimeout = 0;
	}

	listen(port: number, host = "127.0.0.1"): Promise<void> {
		return new Promise((resolve, reject) => {
			const onErr = (err: Error) => reject(err);
			this.server.once("error", onErr);
			this.server.listen(port, host, () => {
				this.server.off("error", onErr);
				this.started = true;
				this.server.on("error", (err) => {
					console.warn(`[pi-output-translate] server error: ${(err as Error).message}`);
				});
				resolve();
			});
		});
	}

	close(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.started) {
				resolve();
				return;
			}
			// End SSE streams cleanly first: a hard destroy leaves browsers
			// with net::ERR_INCOMPLETE_CHUNKED_ENCODING noise.
			for (const res of this.sseResponses) {
				try {
					res.end();
				} catch {
					/* ignore */
				}
			}
			this.sseResponses.clear();
			// Destroy idle keep-alive sockets so close() settles promptly.
			this.server.close(() => resolve());
			this.server.closeAllConnections?.();
			setTimeout(() => resolve(), 500).unref?.();
		});
	}

	// ------------------------------------------------------------------

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;
		const method = req.method ?? "GET";

		if (!this.hostHeaderOk(req)) {
			res.writeHead(403).end();
			return;
		}

		if (path === "/healthz") {
			json(res, 200, {
				app: APP_ID,
				ver: APP_VERSION,
				pipeline: PIPELINE_VER,
				host: true,
				sessions: this.hub.listSessions().length,
				queue: this.hub.queueDepth(),
				queueWait: this.hub.queuePending(),
				queueFly: this.hub.queueInFlight(),
				engine: this.hub.engineInfo(),
			});
			return;
		}

		// Vendored libraries (katex css/js/fonts, marked, dompurify) — public
		// by design: static assets with no session data. MIME-typed.
		if (method === "GET" && path.startsWith("/vendor/")) {
			const rel = path.slice("/vendor/".length);
			if (!/^(fonts\/)?[\w.-]+$/.test(rel) || rel.includes("..")) {
				res.writeHead(404).end();
				return;
			}
			const file = join(WEB_DIR, "vendor", rel);
			try {
				const data = readFileSync(file);
				const mime = file.endsWith(".woff2")
					? "font/woff2"
					: file.endsWith(".css")
						? "text/css; charset=utf-8"
						: file.endsWith(".mjs") || file.endsWith(".js")
							? "text/javascript; charset=utf-8"
							: "application/octet-stream";
				res.writeHead(200, { "Content-Type": mime, "Cache-Control": "max-age=86400" });
				res.end(data);
			} catch {
				res.writeHead(404).end();
			}
			return;
		}

		// Static page assets: token checked for page + assets (token in query).
		if (method === "GET" && (path === "/" || path === "/index.html")) {
			if (!this.authed(req, url)) {
				// Friendly landing page instead of a bare 401: explains how to
				// get in (the token lives in the agent dir, /pot opens directly).
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				res.end(landingPage());
				return;
			}
			if (url.searchParams.get("token") === this.token) {
				res.setHeader(
					"Set-Cookie",
					`pot_token=${encodeURIComponent(this.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
				);
			}
			html(res, this.asset("index.html").replaceAll("__TOKEN__", this.token));
			return;
		}
		if (method === "GET" && (path === "/app.js" || path === "/style.css" || path === "/md.js")) {
			if (!this.authed(req, url)) {
				res.writeHead(401).end();
				return;
			}
			if (path === "/app.js" || path === "/md.js") {
				res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
				res.end(this.asset(path === "/app.js" ? "app.js" : "md.js"));
			} else {
				res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" });
				res.end(this.asset("style.css"));
			}
			return;
		}

		// SSE (token via query — EventSource cannot set headers).
		if (method === "GET" && path === "/events") {
			if (!this.authed(req, url)) {
				res.writeHead(401).end();
				return;
			}
			if (this.hub.viewerCount() >= MAX_SSE_CLIENTS) {
				json(res, 503, { error: "too many SSE clients" });
				return;
			}
			void this.sse(req, res, url).catch(() => undefined);
			return;
		}

		// JSON APIs.
		if (path.startsWith("/api/")) {
			if (!this.authed(req, url)) {
				json(res, 401, { error: "unauthorized" });
				return;
			}
			await this.api(req, res, method, path);
			return;
		}

		res.writeHead(404).end();
	}

	private hostHeaderOk(req: IncomingMessage): boolean {
		const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
		return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
	}

	private authed(req: IncomingMessage, url: URL): boolean {
		const q = url.searchParams.get("token") ?? "";
		const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
		if (q === this.token || bearer === this.token) return true;
		// Cookie fallback: the first authenticated visit sets pot_token, so a
		// bare http://127.0.0.1:7330/ bookmark keeps working afterwards.
		const m = (req.headers.cookie ?? "").match(/(?:^|;\s*)pot_token=([^;]+)/);
		return m !== null && decodeURIComponent(m[1]) === this.token;
	}

	private asset(name: string): string {
		return readFileSync(join(WEB_DIR, name), "utf8");
	}

	// ------------------------------------------------------------------

	/**
	 * Write a chunk, respecting backpressure: when the client stops reading
	 * (writableLength over the cap), wait for drain up to 10s, then give up
	 * and drop the connection. R1 (audit round 2): the replay loop used to
	 * write the whole ring buffer synchronously — a stalled tab buffered
	 * tens of MB inside the host process.
	 */
	private sseWrite(res: ServerResponse, chunk: string): Promise<void> {
		if (res.destroyed) return Promise.reject(new Error("client gone"));
		if (res.writableLength + chunk.length <= MAX_SSE_BUFFER) {
			res.write(chunk);
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				res.destroy();
				reject(new Error("sse replay backpressure timeout"));
			}, 10_000);
			const onDrain = () => {
				cleanup();
				res.write(chunk);
				resolve();
			};
			const onClose = () => {
				cleanup();
				reject(new Error("client gone"));
			};
			const cleanup = () => {
				clearTimeout(timer);
				res.off("drain", onDrain);
				res.off("close", onClose);
			};
			res.once("drain", onDrain);
			res.once("close", onClose);
		});
	}

	private async sse(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
		this.sseResponses.add(res);
		req.on("close", () => this.sseResponses.delete(res));
		const since = Number(url.searchParams.get("since") ?? "0") || 0;
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write(": hello\n\n");
		// Snapshot hello + replay.
		const hello: HubEvent = {
			t: "hello",
			sessions: this.hub.listSessions(),
			engine: this.hub.engineInfo(),
			cfg: publicConfig(loadConfig()),
			focus: this.hub.currentFocus() ?? undefined,
			ver: PIPELINE_VER,
		};
		res.write(`data: ${JSON.stringify({ seq: 0, ev: hello })}\n\n`);
		try {
			for (const e of this.hub.since(since)) {
				await this.sseWrite(res, `data: ${JSON.stringify(e)}\n\n`);
			}
		} catch {
			return; // client stalled or vanished during replay
		}
		const unsub = this.hub.subscribe((lines) => {
			if (res.destroyed || res.writableLength > MAX_SSE_BUFFER) {
				unsub();
				try {
					res.destroy();
				} catch {
					/* ignore */
				}
				return;
			}
			res.write(lines);
		});
		const ping = setInterval(() => {
			if (res.destroyed) return;
			res.write(": ping\n\n");
		}, 20_000);
		ping.unref?.();
		req.on("close", () => {
			clearInterval(ping);
			unsub();
		});
	}

	private async api(
		req: IncomingMessage,
		res: ServerResponse,
		method: string,
		path: string,
	): Promise<void> {
		// ingest: client -> host event push
		if (method === "POST" && path === "/api/ingest") {
			const body = await readJson(req);
			const events = (body?.events ?? []) as HubEvent[];
			if (!Array.isArray(events) || events.length > 2000) {
				json(res, 400, { error: "events must be an array (<=2000)" });
				return;
			}
			// Side-channel session registration piggybacked on ingest.
			if (body?.session && typeof body.session.id === "string") {
				this.hub.registerSession(body.session as never, false);
			}
			this.hub.publishIngested(events);
			json(res, 200, { ok: true, seq: this.hub.currentSeq() });
			return;
		}

		// focus/typing: a pi terminal reports key activity (focus proxy)
		if (method === "POST" && (path === "/api/focus" || path === "/api/typing")) {
			const body = await readJson(req);
			if (typeof body?.sessionId === "string" && body.sessionId !== "") {
				if (path === "/api/focus") {
					this.hub.setFocus(body.sessionId);
					this.hub.setTyping(body.sessionId); // focus implies typing activity
				} else {
					this.hub.setTyping(body.sessionId);
				}
			}
			json(res, 200, { ok: true });
			return;
		}

		// sessions: register / heartbeat / remove
		if (method === "POST" && path === "/api/sessions") {
			const body = await readJson(req);
			if (body?.remove === true && typeof body?.session?.id === "string") {
				this.hub.removeSession(body.session.id, "shutdown");
				json(res, 200, { ok: true });
				return;
			}
			const s = body?.session;
			if (!s || typeof s.id !== "string") {
				json(res, 400, { error: "session required" });
				return;
			}
			this.hub.registerSession(s as never, false);
			json(res, 200, { ok: true });
			return;
		}

		const muteMatch = path.match(/^\/api\/sessions\/([^/]+)\/mute$/);
		if (method === "POST" && muteMatch) {
			const body = await readJson(req);
			this.hub.setMuted(decodeURIComponent(muteMatch[1]), body?.muted !== false);
			json(res, 200, { ok: true });
			return;
		}

		// config
		if (method === "GET" && path === "/api/config") {
			json(res, 200, { config: publicConfig(loadConfig()) });
			return;
		}
		if (method === "POST" && path === "/api/config") {
			const body = await readJson(req);
			if (!body || typeof body.config !== "object") {
				json(res, 400, { error: "config object required" });
				return;
			}
			// A masked apiKey in the payload means "keep the stored one".
			const patch = JSON.parse(JSON.stringify(body.config)) as Record<string, unknown>;
			const t = patch.translate as Record<string, unknown> | undefined;
			if (t && (t.apiKey === undefined || t.apiKey === API_KEY_MASK)) delete t.apiKey;
			const merged = deepMerge(loadConfig(), patch);
			saveConfig(merged);
			this.hub.applyConfig(merged);
			this.onConfigSaved(merged);
			this.hub.publish({ t: "cfg", cfg: publicConfig(merged) });
			json(res, 200, { ok: true, config: publicConfig(merged) });
			return;
		}

		// engine
		if (method === "GET" && path === "/api/engine/models") {
			json(res, 200, { models: await this.hub.listModels() });
			return;
		}
		if (method === "POST" && path === "/api/engine/test") {
			const body = await readJson(req);
			json(res, 200, await this.hub.testTranslate(String(body?.text ?? "The build failed due to a race condition in the cache layer.")));
			return;
		}

		// retry
		if (method === "POST" && path === "/api/retry") {
			const body = await readJson(req);
			const ok = this.hub.retry(String(body?.segId ?? ""));
			json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "not a failed segment" });
			return;
		}
		if (method === "POST" && path === "/api/retry-failed") {
			const body = await readJson(req);
			const n = this.hub.retryFailed(String(body?.sessionId ?? ""));
			json(res, 200, { retried: n });
			return;
		}

		// cache
		if (method === "POST" && path === "/api/cache/clear") {
			this.hub.clearCache();
			json(res, 200, { ok: true });
			return;
		}
		if (method === "GET" && path === "/api/cache/stats") {
			json(res, 200, this.hub.cacheStats());
			return;
		}

		// history
		if (method === "GET" && path === "/api/history") {
			// Group sessions by project directory (cwd stored in journal
			// records); pre-cwd files land in the unknown group after the
			// tail-scan + pi-store recovery fallbacks. Empty journals (sessions
			// that never produced a translation) are not listed at all (B2).
			const { Journal, readPiSessionTopic } = await import("./journal.ts");
			const flat = this.hub.journalList().filter((h) => h.bytes > 0);
			const groups = new Map<
				string,
				{ cwd: string; name: string; sessions: { sessionId: string; mtime: number; bytes: number; topic: string | null }[] }
			>();
			const peek = new Journal("", 1, 1);
			const { agentDir } = await import("./config.ts");
			const sessionsRoot = join(agentDir(), "sessions");
			const liveSessions = new Set(this.hub.listSessions().map((s) => s.id));
			for (const h of flat) {
				// cwd priority: cache -> journal records (head, then tail) -> pi's
				// own session files (memoized) -> unknown group
				let meta = this.histMeta.get(h.sessionId);
				if (!meta || meta.mtime !== h.mtime) {
					const file = this.hub.journalFileFor(h.sessionId);
					let cwd = peek.peekCwd(file);
					if (cwd === null) {
						const recovered = this.recoveredCwds.get(h.sessionId) ?? peek.recoverCwdFromPiSessions(h.sessionId, sessionsRoot);
						if (recovered) this.recoveredCwds.set(h.sessionId, recovered);
						cwd = recovered;
					}
					// topic chain: journal user records -> pi session store's first
					// user prompt (covers pre-r12b journals & Chinese prompts)
					let topic = peek.peekTopic(file);
					if (topic === null && !this.piTopics.has(h.sessionId)) {
						const piFile = peek.findPiSessionFile(h.sessionId, sessionsRoot);
						this.piTopics.set(h.sessionId, piFile ? readPiSessionTopic(piFile) : null);
					}
					if (topic === null) topic = this.piTopics.get(h.sessionId) ?? null;
					meta = { mtime: h.mtime, cwd: cwd ?? "", topic };
					this.histMeta.set(h.sessionId, meta);
				}
				const cwd = meta.cwd;
				let g = groups.get(cwd);
				if (!g) {
					const base = cwd ? cwd.split("/").filter(Boolean).pop() ?? cwd : "";
					g = { cwd, name: base || "（未知项目）", sessions: [] };
					groups.set(cwd, g);
				}
				g.sessions.push({ ...h, topic: meta.topic });
			}
			// Same-basename projects (e.g. two "api" dirs) would render as two
			// identically-named folders — disambiguate with the parent segment.
			const nameCounts = new Map<string, number>();
			for (const g of groups.values()) nameCounts.set(g.name, (nameCounts.get(g.name) ?? 0) + 1);
			for (const g of groups.values()) {
				if ((nameCounts.get(g.name) ?? 0) > 1 && g.cwd) {
					const segs = g.cwd.split("/").filter(Boolean);
					const parent = segs.length >= 2 ? segs[segs.length - 2] : "";
					if (parent) g.name = `${parent}/${g.name}`;
				}
			}
			json(res, 200, { sessions: flat, groups: [...groups.values()], live: [...liveSessions] });
			return;
		}
		const histMatch = path.match(/^\/api\/history\/([^/]+)$/);
		if (method === "GET" && histMatch) {
			json(res, 200, { records: this.hub.journalRead(decodeURIComponent(histMatch[1])) });
			return;
		}

		res.writeHead(404, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "not found" }));
	}
}

// --------------------------------------------------------------------

function landingPage(): string {
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<title>pi-output-translate</title>
<style>
body{background:#0f1115;color:#d7dae0;font:15px/1.7 -apple-system,"PingFang SC",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{max-width:560px;background:#1a1e26;border:1px solid #262b34;border-radius:10px;padding:28px 32px}
h1{font-size:18px;color:#4f9cf9;margin:0 0 10px}
code{background:#12151b;border:1px solid #262b34;border-radius:4px;padding:1px 7px;font-size:13px;color:#cfe3b8}
p{margin:8px 0;color:#8b93a1}
a{color:#4f9cf9}
</style></head><body><div class="box">
<h1>⇄ pi-output-translate</h1>
<p>这是 pi 的翻译阅读页服务，需要 token 才能进入。</p>
<p><b>方式一</b>：在 pi 里执行 <code>/pot</code>，会自动用浏览器打开带 token 的地址。</p>
<p><b>方式二</b>：读取 <code>~/.pi/agent/output-translate.token</code> 的内容，拼到本地址后面：<code>/?token=那个值</code></p>
<p>首次带 token 打开后会记住（cookie），之后直接访问本页即可。</p>
</div></body></html>`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
}

function html(res: ServerResponse, body: string): void {
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
	res.end(body);
}

async function readJson(req: IncomingMessage): Promise<any> {
	const text = await readBody(req);
	if (text === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
