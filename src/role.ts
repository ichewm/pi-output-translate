/**
 * Role management — host/client election for multi-window pi.
 *
 * - session_start: race to bind server.port..port+9. Winner = HOST (runs the
 *   hub + server + translation stack). Losers probe /healthz; a healthy
 *   pi-output-translate server makes them CLIENTs (ingest their events).
 * - client POST failure → backoff loop → healthz re-check → if dead, race
 *   again to become the new host (OS bind is atomic: election for free).
 * - session_shutdown: host tears the server down; last one out turns the
 *   lights off. No daemon process ever outlives pi.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Hub } from "./hub.ts";

/**
 * Raw node:http POST for control traffic (focus/typing/ingest/heartbeat).
 *
 * pi replaces globalThis.fetch with its own dispatcher-wrapped version
 * (core/http-dispatcher.js); inside a pi process that fetch reliably times
 * out on loopback POSTs. This helper goes straight to the socket, immune to
 * any global patching.
 */
export function loopbackPost(
	port: number,
	path: string,
	body: unknown,
	token: string,
	timeoutMs = 1500,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = httpRequest(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload),
					Authorization: `Bearer ${token}`,
				},
				timeout: timeoutMs,
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve(res.statusCode ?? 0));
			},
		);
		req.on("timeout", () => {
			req.destroy(new Error("loopback post timeout"));
		});
		req.on("error", reject);
		req.end(payload);
	});
}
import type { EngineFactory } from "./hub.ts";
import { AppServer } from "./server.ts";
import type { HubEvent, SessionInfo } from "./types.ts";
import { tokenPath } from "./config.ts";
import type { OutputTranslateConfig } from "./config.ts";

export type RoleState = "none" | "host" | "client" | "disabled";

export interface RoleDeps {
	getConfig: () => OutputTranslateConfig;
	engineFactory: EngineFactory;
	sessionInfo: () => SessionInfo;
	/** Host-side sink for collector events (wired when this process is host). */
	onHostActive: (hub: Hub) => void;
	onHostInactive: () => void;
	notify: (msg: string, level: "info" | "warning" | "error") => void;
	/** Test hook: override ingest/health endpoints. Production uses raw node:http. */
	fetchImpl?: typeof fetch;
}

export class RoleManager {
	private readonly d: RoleDeps;
	private readonly fetchImpl: typeof fetch | undefined;
	state: RoleState = "none";
	port = 0;
	hub: Hub | null = null;
	private server: AppServer | null = null;
	private token = "";
	// client state
	private uplinkBuf: HubEvent[] = [];
	private uplinkTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = true;
	private notifiedDown = false;

	constructor(deps: RoleDeps) {
		this.d = deps;
		this.fetchImpl = deps.fetchImpl;
	}

	// ------------------------------------------------------------------
	// start: race for host, fall back to client

	async start(): Promise<RoleState> {
		this.stopped = false;
		const cfg = this.d.getConfig();
		if (!cfg.enabled) {
			this.state = "disabled";
			return this.state;
		}
		const ports: number[] = [];
		for (let i = 0; i < 10; i++) ports.push(cfg.server.port + i);
		for (const port of ports) {
			if (this.stopped) return this.state;
			const ok = await this.tryHost(port);
			if (ok) return this.state;
			// Port busy: is it one of us?
			const probed = await this.probe(port);
			if (probed === "ours") {
				await this.becomeClient(port);
				return this.state;
			}
			// Foreign process or dead server: next port.
		}
		this.state = "disabled";
		this.d.notify("pi-output-translate: ports 7330-7339 all busy — disabled for this session", "warning");
		return this.state;
	}

	private async tryHost(port: number): Promise<boolean> {
		const cfg = this.d.getConfig();
		const hub = new Hub({ getConfig: this.d.getConfig, engineFactory: this.d.engineFactory });
		try {
			hub.start();
		} catch (err) {
			console.warn("[pi-output-translate] hub.start failed:", err);
			await hub.dispose().catch(() => undefined);
			return false;
		}
		const token = ensureToken(tokenPath(cfg));
		const server = new AppServer({
			hub,
			token,
			onConfigSaved: () => {
				/* config file is the source of truth; clients poll mtime */
			},
		});
		try {
			await server.listen(port, cfg.server.host);
		} catch {
			await hub.dispose();
			return false;
		}
		// N1 (audit round 4): session_shutdown may have completed while this
		// start() was still awaiting listen — nobody would ever stop these.
		if (this.stopped) {
			hub.removeSession(this.d.sessionInfo().id, "shutdown");
			await hub.dispose().catch(() => undefined);
			await server.close().catch(() => undefined);
			return false;
		}
		this.hub = hub;
		this.server = server;
		this.token = token;
		this.port = port;
		this.state = "host";
		hub.registerSession(this.d.sessionInfo(), true);
		this.d.onHostActive(hub);
		if (cfg.server.autoOpen) this.d.notify(`pi-output-translate: open http://127.0.0.1:${port}/?token=${token}`, "info");
		return true;
	}

	private async probe(port: number): Promise<"ours" | "foreign" | "dead"> {
		if (this.fetchImpl !== undefined) {
			const ctrl = new AbortController();
			const t = setTimeout(() => ctrl.abort(), 800);
			try {
				const res = await this.fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: ctrl.signal });
				if (!res.ok) return "foreign";
				const json = (await res.json()) as { app?: string };
				return json.app === "pi-output-translate" ? "ours" : "foreign";
			} catch {
				return "dead";
			} finally {
				clearTimeout(t);
			}
		}
		return new Promise((resolve) => {
			const req = httpRequest({ host: "127.0.0.1", port, path: "/healthz", method: "GET", timeout: 800 }, (res) => {
				let data = "";
				res.on("data", (c: Buffer) => (data += c.toString()));
				res.on("end", () => {
					try {
						resolve(JSON.parse(data)?.app === "pi-output-translate" ? "ours" : "foreign");
					} catch {
						resolve("foreign");
					}
				});
			});
			req.on("timeout", () => { req.destroy(); resolve("dead"); });
			req.on("error", () => resolve("dead"));
			req.end();
		});
	}

	private async becomeClient(port: number): Promise<void> {
		const cfg = this.d.getConfig();
		const token = readToken(tokenPath(cfg));
		if (!token) {
			this.state = "disabled";
			this.d.notify("pi-output-translate: cannot read token file — disabled", "warning");
			return;
		}
		this.port = port;
		this.token = token;
		this.state = "client";
		this.d.onHostInactive();
		await this.register();
		if (this.stopped) {
			// shutdown finished while register() was in flight
			this.state = "none";
			this.uplinkBuf = [];
			return;
		}
		this.heartbeatTimer = setInterval(() => {
			void this.register().catch(() => this.scheduleReconnect());
		}, 30_000);
		this.heartbeatTimer.unref?.();
	}

	// ------------------------------------------------------------------
	// client uplink

	/** Client-side publish: buffered, batched, reconnect-safe. */
	publishClient(ev: HubEvent): void {
		if (this.state !== "client") return;
		if (this.uplinkBuf.length >= 256) {
			// Backpressure: drop the oldest deltas first (segments survive).
			const deltaIdx = this.uplinkBuf.findIndex((e) => e.t === "delta");
			if (deltaIdx >= 0) this.uplinkBuf.splice(deltaIdx, 1);
			else this.uplinkBuf.shift();
		}
		this.uplinkBuf.push(ev);
		if (this.uplinkTimer) return;
		this.uplinkTimer = setTimeout(() => {
			this.uplinkTimer = null;
			void this.flushUplink();
		}, 50);
		this.uplinkTimer.unref?.();
	}

	private uplinkInFlight = false;
	private uplinkAgain = false;

	private async flushUplink(): Promise<void> {
		// R2 (audit round 2): two concurrent flushes could interleave POSTs and
		// deliver events to the host out of order. Serialize: while one flush
		// is in flight, later triggers just mark "run again".
		if (this.uplinkInFlight) {
			this.uplinkAgain = true;
			return;
		}
		this.uplinkInFlight = true;
		try {
			do {
				this.uplinkAgain = false;
				await this.flushUplinkOnce();
			} while (this.uplinkAgain && this.state === "client");
		} finally {
			this.uplinkInFlight = false;
		}
	}

	private async flushUplinkOnce(): Promise<void> {
		if (this.state !== "client" || this.uplinkBuf.length === 0) return;
		const events = this.uplinkBuf.splice(0, 2000);
		try {
			await this.ingest(events);
		} catch {
			// Host unreachable: put the events back, bounded. When the buffer
			// overflows, drop deltas first — segments (the translatable units)
			// survive; only raw typing display is lost.
			const room = Math.max(0, 256 - this.uplinkBuf.length);
			if (events.length <= room) {
				this.uplinkBuf.unshift(...events);
			} else {
				const keep: HubEvent[] = events.slice(-room).filter((e) => e.t !== "delta");
				let dropped = room - keep.length;
				for (let i = events.length - room - 1; i >= 0 && dropped > 0; i--) {
					if (events[i].t !== "delta") {
						keep.unshift(events[i]);
						dropped--;
					}
				}
				this.uplinkBuf.unshift(...keep);
			}
			this.scheduleReconnect();
		}
	}

	private async ingest(events: HubEvent[]): Promise<void> {
		if (this.fetchImpl !== undefined) {
			const res = await this.fetchImpl(`http://127.0.0.1:${this.port}/api/ingest`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
				body: JSON.stringify({ session: this.d.sessionInfo(), events }),
			});
			if (!res.ok) throw new Error(`ingest HTTP ${res.status}`);
			return;
		}
		const status = await loopbackPost(this.port, "/api/ingest", { session: this.d.sessionInfo(), events }, this.token, 5000);
		if (status >= 300) throw new Error(`ingest HTTP ${status}`);
	}

	private async register(): Promise<void> {
		if (this.fetchImpl !== undefined) {
			const res = await this.fetchImpl(`http://127.0.0.1:${this.port}/api/sessions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
				body: JSON.stringify({ session: this.d.sessionInfo() }),
			});
			if (!res.ok) throw new Error(`register HTTP ${res.status}`);
			return;
		}
		const status = await loopbackPost(this.port, "/api/sessions", { session: this.d.sessionInfo() }, this.token, 3000);
		if (status >= 300) throw new Error(`register HTTP ${status}`);
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer || this.stopped || this.state !== "client") return;
		if (!this.notifiedDown) {
			this.notifiedDown = true;
			this.d.notify("pi-output-translate: host unreachable — reconnecting / taking over", "warning");
		}
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			void this.reconnect();
		}, 2000);
		this.reconnectTimer.unref?.();
	}

	private async reconnect(): Promise<void> {
		if (this.stopped || this.state !== "client") return;
		const probed = await this.probe(this.port);
		if (probed === "ours") {
			try {
				await this.register();
				this.notifiedDown = false;
				void this.flushUplink();
				return;
			} catch {
				/* fall through */
			}
		}
		// Host is gone: race to take over.
		if (await this.tryHost(this.port)) {
			if (this.stopped) {
				const hub = this.hub;
				const server = this.server;
				this.hub = null;
				this.server = null;
				this.state = "none";
				await hub?.dispose().catch(() => undefined);
				await server?.close().catch(() => undefined);
				return;
			}
			this.clearClientTimers();
			const hub = this.hub;
			if (hub) {
				hub.registerSession(this.d.sessionInfo(), true);
				this.d.onHostActive(hub);
				// Replay buffered events into our own hub.
				const buffered = this.uplinkBuf.splice(0);
				hub.publishIngested(buffered);
			}
			this.state = "host";
			return;
		}
		const probed2 = await this.probe(this.port);
		if (probed2 === "ours") {
			try {
				await this.register();
				void this.flushUplink();
				return;
			} catch {
				/* retry later */
			}
		}
		this.scheduleReconnect();
	}

	private clearClientTimers(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		if (this.uplinkTimer) clearTimeout(this.uplinkTimer);
		this.uplinkTimer = null;
	}

	private lastFocusReport = 0;
	private lastFocusSid: string | null = null;

	/**
	 * A keypress reached THIS pi terminal — only the focused window receives
	 * terminal input, so this is a faithful focus signal. Throttled to one
	 * report per second; the hub throttles its SSE push independently.
	 */
	reportFocus(): void {
		const now = Date.now();
		const sid = this.d.sessionInfo().id;
		// CHANGE-triggered (first call always fires — pi's startup terminal
		// handshake also reaches onTerminalInput and used to swallow the only
		// focus slot, leaving steady typers unreported forever), then 1/s.
		if (sid === this.lastFocusSid && now - this.lastFocusReport < 1_000) return;
		const sent = this.postControl("/api/focus", sid); // host: setFocus+setTyping; client: one POST
		if (sent) {
			this.lastFocusSid = sid;
			this.lastFocusReport = now;
		}
	}

	/** Returns true when the control message was actually dispatched. */
	private postControl(path: string, sessionId: string): boolean {
		if (this.state === "host") {
			if (path === "/api/focus") {
				this.hub?.setFocus(sessionId);
				this.hub?.setTyping(sessionId); // focus implies typing activity
			}
			return true;
		}
		if (this.state !== "client") return false;
		if (this.fetchImpl !== undefined) {
			void this.fetchImpl(`http://127.0.0.1:${this.port}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
				body: JSON.stringify({ sessionId }),
				signal: AbortSignal.timeout(1500),
			}).catch(() => undefined);
			return true;
		}
		void loopbackPost(this.port, path, { sessionId }, this.token).catch(() => undefined);
		return true;
	}

	// ------------------------------------------------------------------

	async stop(): Promise<void> {
		this.stopped = true;
		this.clearClientTimers();
		if (this.state === "host" && this.hub) {
			const sid = this.d.sessionInfo().id;
			this.hub.removeSession(sid, "shutdown");
			await this.hub.dispose();
			await this.server?.close();
		} else if (this.state === "client") {
			// Best-effort deregister; host prunes us after 90s anyway.
			try {
				if (this.fetchImpl !== undefined) {
					await this.fetchImpl(`http://127.0.0.1:${this.port}/api/sessions`, {
						method: "POST",
						headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
						body: JSON.stringify({ session: this.d.sessionInfo(), remove: true }),
						signal: AbortSignal.timeout(1500),
					});
				} else {
					await loopbackPost(this.port, "/api/sessions", { session: this.d.sessionInfo(), remove: true }, this.token);
				}
			} catch {
				/* ignore */
			}
			void this.flushUplink();
		}
		this.hub = null;
		this.server = null;
		this.state = "none";
		this.uplinkBuf = [];
		this.d.onHostInactive();
	}

	/** Test hook: close the server without the full stop() path. */
	closeServerForTest(): void {
		void this.server?.close();
		this.server = null;
	}

	url(): string | null {
		if (this.state === "disabled" || this.state === "none" || this.port === 0) return null;
		return `http://127.0.0.1:${this.port}/?token=${encodeURIComponent(this.token)}`;
	}
}

// --------------------------------------------------------------------

export function ensureToken(path: string): string {
	const existing = readToken(path);
	if (existing) return existing;
	const token = randomBytes(24).toString("hex");
	try {
		writeFileSync(path, token, { encoding: "utf8", mode: 0o600 });
		chmodSync(path, 0o600);
	} catch {
		// Read-only home? The in-memory token still works for this process.
	}
	return token;
}

export function readToken(path: string): string | null {
	try {
		if (!existsSync(path)) return null;
		const t = readFileSync(path, "utf8").trim();
		return t.length >= 16 ? t : null;
	} catch {
		return null;
	}
}
