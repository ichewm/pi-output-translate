/**
 * Hub — the host-side core. One instance exists in whichever pi process won
 * the port race. It owns:
 *
 * - the session registry (host session + ingested client sessions),
 * - a bounded ring buffer of all events (SSE replay source),
 * - batched fan-out to SSE subscribers,
 * - the translation stack (engine + cache + queue + journal + per-session
 *   context/term-lock),
 * - periodic status and engine-health events.
 *
 * publish() is synchronous and cheap (array push + dirty flag); all I/O
 * happens on internal timers/loops. It must never throw.
 */

import type { HubEvent, SequencedEvent, SessionInfo, SegmentKind, TranslateEngine, EngineInfo } from "./types.ts";
import { TranslateCache } from "./cache.ts";
import { createHash } from "node:crypto";
import { Journal } from "./journal.ts";
import type { JournalRecord } from "./journal.ts";
import { TranslateQueue } from "./queue.ts";
import type { QResult } from "./queue.ts";
import { shouldTranslate } from "./langgate.ts";
import { mask } from "./protect.ts";
import { TermLock, glossaryToPromptText, mergedGlossary } from "./glossary.ts";
import { journalDir } from "./config.ts";
import type { OutputTranslateConfig } from "./config.ts";
import { join } from "node:path";

export type EngineFactory = (cfg: OutputTranslateConfig) => TranslateEngine;

export interface HubOptions {
	getConfig: () => OutputTranslateConfig;
	engineFactory: EngineFactory;
	/** Ring-buffer cap (global across sessions). */
	maxEvents?: number;
}

interface SessionCtx {
	recent: { source: string; target: string }[];
	termLock: TermLock;
}

const RING_DEFAULT = 4000;

export class Hub {
	private readonly getConfig: () => OutputTranslateConfig;
	private readonly engineFactory: EngineFactory;
	private readonly maxEvents: number;

	private ring: SequencedEvent[] = [];
	private seq = 0;
	private outbox: SequencedEvent[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly subscribers = new Set<(lines: string) => void>();

	private readonly sessions = new Map<string, SessionInfo>();
	private readonly sessionCtx = new Map<string, SessionCtx>();
	private pruneTimer: ReturnType<typeof setInterval> | null = null;
	private statusTimer: ReturnType<typeof setInterval> | null = null;
	private healthTimer: ReturnType<typeof setInterval> | null = null;

	private focusSession: string | null = null;
	private lastFocusPush = 0;
	private engine: TranslateEngine | null = null;
	private engineOk = false;
	private engineSig = "";
	private cache: TranslateCache | null = null;
	private queue: TranslateQueue | null = null;
	private journal: Journal | null = null;
	private disposed = false;

	constructor(opts: HubOptions) {
		this.getConfig = opts.getConfig;
		this.engineFactory = opts.engineFactory;
		this.maxEvents = opts.maxEvents ?? RING_DEFAULT;
	}

	// ------------------------------------------------------------------
	// Lifecycle

	start(): void {
		this.ensureEngine();
		const cfg = this.getConfig();
		this.cache =
			this.cache ??
			new TranslateCache(
				cfg.cache.maxEntries,
				cfg.cache.persist ? join(journalDir(cfg), "..", "cache.json") : null,
			);
		this.journal =
			this.journal ??
			new Journal(journalDir(cfg), cfg.journal.maxFileMb, cfg.journal.maxFiles);
		if (!this.queue) {
			this.queue = new TranslateQueue({
				getEngine: () => this.engine as TranslateEngine,
				glossaryVersion: () => {
					const cfg = this.getConfig();
					return createHash("sha1").update(JSON.stringify(mergedGlossary(cfg.glossary))).digest("hex").slice(0, 12);
				},
				cache: this.cache,
				getConfig: this.getConfig,
				glossaryText: () => glossaryToPromptText(mergedGlossary(this.getConfig().glossary)),
				getSessionCtx: (sid) => {
					const ctx = this.sessionCtx.get(sid);
					return {
						recent: ctx?.recent ?? [],
						termLockLines: ctx?.termLock.promptLines() ?? "",
					};
				},
				recordTranslation: (sid, source, target) => this.recordTranslation(sid, source, target),
				viewerCount: () => this.subscribers.size,
				isMuted: (sid) => this.sessions.get(sid)?.muted === true,
				onResult: (r) => this.handleResult(r),
			});
		}
		this.pruneTimer = setInterval(() => this.pruneSessions(), 30_000);
		this.statusTimer = setInterval(() => this.publishStatus(), 5_000);
		this.healthTimer = setInterval(() => void this.checkEngine(), 60_000);
		for (const t of [this.pruneTimer, this.statusTimer, this.healthTimer]) t.unref?.();
		void this.checkEngine();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		for (const t of [this.pruneTimer, this.statusTimer, this.healthTimer]) {
			if (t) clearInterval(t);
		}
		this.pruneTimer = this.statusTimer = this.healthTimer = null;
		if (this.queue) await this.queue.stop();
		this.queue = null;
		this.engine?.dispose?.();
		this.engine = null;
		this.cache?.dispose();
		this.cache = null;
		this.journal?.dispose();
		this.journal = null;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = null;
		for (const send of this.subscribers) {
			try {
				send("");
			} catch {
				/* ignore */
			}
		}
		this.subscribers.clear();
	}

	/** Rebuild the engine when its identity changed (config hot-reload). */
	applyConfig(cfg: OutputTranslateConfig): void {
		const sig = `${cfg.translate.engine}|${cfg.translate.baseUrl}|${cfg.translate.model}|${cfg.translate.apiKey}|${cfg.translate.piModelId}|${cfg.translate.temperature}|${cfg.translate.timeoutSeconds}`;
		if (sig !== this.engineSig) {
			this.engineSig = sig;
			this.engine?.dispose?.();
			this.engine = this.engineFactory(cfg);
			void this.checkEngine();
		}
	}

	private ensureEngine(): void {
		const cfg = this.getConfig();
		const sig = `${cfg.translate.engine}|${cfg.translate.baseUrl}|${cfg.translate.model}|${cfg.translate.apiKey}|${cfg.translate.piModelId}|${cfg.translate.temperature}|${cfg.translate.timeoutSeconds}`;
		if (!this.engine || sig !== this.engineSig) {
			this.engineSig = sig;
			this.engine = this.engineFactory(cfg);
		}
	}

	async checkEngine(): Promise<boolean> {
		if (!this.engine) return false;
		const ok = await this.engine.healthCheck().catch(() => false);
		if (ok !== this.engineOk) {
			this.engineOk = ok;
			this.publishStatus();
		}
		return ok;
	}

	engineInfo(): EngineInfo {
		return {
			id: this.engine?.id ?? "none",
			model: this.getConfig().translate.model,
			ok: this.engineOk,
		};
	}

	// ------------------------------------------------------------------
	// Sessions

	registerSession(info: SessionInfo, local: boolean): void {
		const existing = this.sessions.get(info.id);
		// R3 (audit round 2): a remote registration for an id the host itself
		// owns would silently flip it to remote (and make it prunable). Refuse.
		if (existing?.local && !local) return;
		this.sessions.set(info.id, {
			...info,
			local,
			lastSeen: Date.now(),
			muted: existing?.muted ?? info.muted,
		});
		if (!this.sessionCtx.has(info.id)) {
			this.sessionCtx.set(info.id, { recent: [], termLock: new TermLock() });
		}
		this.publish({ t: "session_up", s: this.sessionView(info.id) });
	}

	heartbeat(sessionId: string, model?: string): void {
		const s = this.sessions.get(sessionId);
		if (!s) return;
		s.lastSeen = Date.now();
		if (model) s.model = model;
	}

	removeSession(sessionId: string, reason: "shutdown" | "timeout"): void {
		if (!this.sessions.has(sessionId)) return;
		this.sessions.delete(sessionId);
		this.sessionCtx.delete(sessionId);
		this.publish({ t: "session_down", s: sessionId, reason });
	}

	setMuted(sessionId: string, muted: boolean): void {
		const s = this.sessions.get(sessionId);
		if (!s) return;
		s.muted = muted;
		this.publish({ t: "session_mute", s: sessionId, muted });
	}

	private pruneSessions(): void {
		const now = Date.now();
		for (const [id, s] of this.sessions) {
			if (s.local) continue;
			if (s.lastSeen !== undefined && now - s.lastSeen > 90_000) {
				this.removeSession(id, "timeout");
			}
		}
	}

	sessionView(id: string): SessionInfo {
		const s = this.sessions.get(id);
		return s ? { ...s } : { id, name: id, cwd: "" };
	}

	listSessions(): SessionInfo[] {
		return [...this.sessions.values()].map((s) => ({ ...s }));
	}

	// ------------------------------------------------------------------
	// Event flow

	/** Append an event to the ring buffer and schedule fan-out. Sync, no throw. */
	publish(ev: HubEvent): void {
		if (this.disposed) return;
		const se: SequencedEvent = { seq: ++this.seq, ev };
		this.ring.push(se);
		if (this.ring.length > this.maxEvents) {
			this.ring.splice(0, this.ring.length - this.maxEvents);
		}
		this.outbox.push(se);
		this.scheduleFlush();
		this.route(ev);
	}

	/** Events a client may ingest (whitelist). */
	static ingestible(ev: HubEvent): boolean {
		return (
			ev.t === "msg_start" || ev.t === "delta" || ev.t === "segment" ||
			ev.t === "tool" || ev.t === "msg_end"
		);
	}

	publishIngested(evs: HubEvent[]): void {
		for (const ev of evs) {
			if (Hub.ingestible(ev)) this.publish(ev);
		}
	}

	/**
	 * Record which terminal has input focus (key activity reaching that pi
	 * window). Pushed to viewers as a TRANSIENT event (never replayed) so
	 * reconnects don't yank the page back in time. Throttled per session.
	 */
	setFocus(sessionId: string): void {
		const now = Date.now();
		const changed = sessionId !== this.focusSession;
		this.focusSession = sessionId;
		// Throttle repeated reports for the SAME session (typing bursts);
		// a focus CHANGE always goes out immediately.
		if (!changed && this.lastFocusPush > 0 && now - this.lastFocusPush < 2_000) return;
		this.lastFocusPush = now;
		this.publishTransient({ t: "focus", s: sessionId, ts: now });
	}

	currentFocus(): string | null {
		return this.focusSession;
	}

	private lastTypingPush = 0;

	/** The focused terminal is actively receiving keypresses. Transient. */
	setTyping(sessionId: string): void {
		const now = Date.now();
		if (now - this.lastTypingPush < 1_000) return;
		this.lastTypingPush = now;
		this.publishTransient({ t: "typing", s: sessionId, ts: now });
	}

	/** Broadcast without entering the ring buffer (not part of history). */
	private publishTransient(ev: HubEvent): void {
		if (this.disposed) return;
		this.outbox.push({ seq: ++this.seq, ev });
		this.scheduleFlush();
	}

	/** Replay events after `since`; empty array means "send hello live-only". */
	since(seq: number): SequencedEvent[] {
		if (this.ring.length === 0 || seq >= this.ring[this.ring.length - 1].seq) return [];
		const first = this.ring[0].seq;
		if (seq < first - 1) seq = first - 1;
		return this.ring.filter((e) => e.seq > seq);
	}

	currentSeq(): number {
		return this.seq;
	}

	/** Subscribe to serialized event batches; returns unsubscribe. */
	subscribe(send: (lines: string) => void): () => void {
		this.subscribers.add(send);
		return () => {
			this.subscribers.delete(send);
		};
	}

	viewerCount(): number {
		return this.subscribers.size;
	}

	private scheduleFlush(): void {
		if (this.flushTimer || this.subscribers.size === 0) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, 50);
		this.flushTimer.unref?.();
	}

	flush(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.outbox.length === 0 || this.subscribers.size === 0) {
			if (this.outbox.length > 500) this.outbox = [];
			return;
		}
		const lines = this.outbox.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
		this.outbox = [];
		for (const send of [...this.subscribers]) {
			try {
				send(lines);
			} catch {
				this.subscribers.delete(send);
			}
		}
	}

	// ------------------------------------------------------------------
	// Translation routing

	private route(ev: HubEvent): void {
		if (ev.t !== "segment") return;
		if (!this.queue || !this.getConfig().enabled) return;
		const kind: SegmentKind = ev.k;
		if (kind === "code") return;
		// user prompts translate too (English prompts read in Chinese; the
		// language gate passes Chinese input through untouched)
		if (kind === "user") {
			if (!this.getConfig().sources.userMessage) return;
		} else if (kind === "thinking") {
			if (!this.getConfig().sources.thinking) return;
		} else if (kind === "text") {
			if (!this.getConfig().sources.assistantText) return;
		}
		const { masked, placeholders } = mask(ev.src);
		const cfg = this.getConfig();
		if (!shouldTranslate(masked, cfg.translate.minEnglishChars)) {
			this.publish({ t: "trans", id: ev.id, st: "notrans" });
			// Chinese user prompts never translate, but journaling them keeps
			// the session topic (first user prompt) and history replay complete.
			if (kind === "user" && this.journal) {
				this.journal.append({
					ts: Date.now(),
					s: ev.s,
				cwd: this.sessions.get(ev.s)?.cwd,
					m: ev.m,
					k: kind,
					id: ev.id,
					src: ev.src,
					st: "notrans",
				});
			}
			return;
		}
		this.queue.enqueue({
			segId: ev.id,
			sessionId: ev.s,
			messageKey: ev.m,
			kind,
			source: ev.src,
			masked,
			placeholders,
		});
	}

	private handleResult(r: QResult): void {
		this.publish({
			t: "trans",
			id: r.segId,
			st: r.st,
			tgt: r.tgt,
			rsn: r.rsn,
			dg: r.dg,
			ms: r.ms,
		});
		if (r.st !== "skipped" && this.journal) {
			const rec: JournalRecord = {
				ts: Date.now(),
				s: r.sessionId,
				cwd: this.sessions.get(r.sessionId)?.cwd,
				m: r.messageKey,
				k: r.kind,
				id: r.segId,
				src: r.source,
				tgt: r.tgt,
				st: r.st,
			};
			this.journal.append(rec);
		}
	}

	private recordTranslation(sessionId: string, source: string, target: string): void {
		let ctx = this.sessionCtx.get(sessionId);
		if (!ctx) {
			ctx = { recent: [], termLock: new TermLock() };
			this.sessionCtx.set(sessionId, ctx);
		}
		ctx.recent.push({ source, target });
		if (ctx.recent.length > 12) ctx.recent.shift();
		ctx.termLock.record(source, target);
	}

	private publishStatus(): void {
		if (this.disposed) return;
		this.publish({
			t: "status",
			q: this.queue?.pendingCount() ?? 0,
			eng: this.engineOk,
			drop: this.queue?.dropped() ?? 0,
			clients: this.subscribers.size,
			// backlog-vs-deadlock breakdown: waiting items, in-flight engine
			// calls, and the oldest waiting item's age (ms)
			p: this.queue?.pendingItems() ?? 0,
			a: this.queue?.inFlight() ?? 0,
			old: this.queue?.oldestPendingMs() ?? 0,
			// current adaptive batch ceiling (equals config until a batch fails)
			bs: this.queue?.effectiveBatchSize() ?? 0,
			// per-session pending breakdown (multi-CLI visibility)
			pq: this.queue?.pendingBySession() ?? {},
		});
	}

	// ------------------------------------------------------------------
	// Pass-through operations (server API)

	retry(segId: string): boolean {
		return this.queue?.retry(segId) ?? false;
	}

	queueDepth(): number {
		return this.queue?.pendingCount() ?? 0;
	}

	queuePending(): number {
		return this.queue?.pendingItems() ?? 0;
	}

	queueInFlight(): number {
		return this.queue?.inFlight() ?? 0;
	}

	/** Dispatch pending translations now (deterministic tests). */
	async flushQueueForTests(): Promise<void> {
		await this.queue?.flushNow();
	}

	retryFailed(sessionId: string): number {
		return this.queue?.retryFailed(sessionId) ?? 0;
	}

	cacheStats(): { size: number; hits: number; misses: number; hitRate: number } {
		return this.cache?.stats() ?? { size: 0, hits: 0, misses: 0, hitRate: 0 };
	}

	clearCache(): void {
		this.cache?.clear();
	}

	journalList(): { sessionId: string; mtime: number; bytes: number }[] {
		return this.journal?.list() ?? [];
	}

	journalRead(sessionId: string): JournalRecord[] {
		return this.journal?.read(sessionId) ?? [];
	}

	journalFileFor(sessionId: string): string {
		return this.journal?.filePathFor(sessionId) ?? "";
	}

	listModels(): Promise<string[]> {
		return this.engine?.listModels?.() ?? Promise.resolve([]);
	}

	async testTranslate(text: string): Promise<{ ok: boolean; output?: string; error?: string }> {
		this.ensureEngine();
		if (!this.engine) return { ok: false, error: "no engine" };
		const cfg = this.getConfig();
		try {
			const sys = "你是翻译引擎，只输出译文。把英文翻译成简体中文，保留代码与占位符原样。";
			const out = await this.engine.complete(sys, `请翻译：\n${text}`, AbortSignal.timeout(cfg.translate.timeoutSeconds * 1000));
			return { ok: true, output: clean(out) };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}
}

function clean(s: string): string {
	return s
		.replace(/\r\n/g, "\n")
		.replace(/^```[a-zA-Z]*\n?|```$/g, "")
		.trim();
}
