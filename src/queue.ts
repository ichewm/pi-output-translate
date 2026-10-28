/**
 * Translation queue — owns all engine-call policy:
 *
 * - Batching: accumulate up to batchSize segments or batchWindowMs, one chat
 *   completion per batch (numbered-block protocol).
 * - Failure: a failed batch is retried per item once; a still-failing item is
 *   reported as "failed" and kept for manual retry.
 * - Repair: when the model drops placeholders, one repair pass runs before
 *   degrading to "degraded" (target falls back to the source text).
 * - Backpressure: bounded queue; overflow drops thinking items first.
 *
 * The queue never throws: every failure becomes a result callback.
 */

import { cleanEngineOutput, lostPlaceholders, restore } from "./protect.ts";
import { batchUserPrompt, repairUserPrompt, systemPrompt } from "./prompt.ts";
import type { PromptContext } from "./prompt.ts";
import { parseBlocks } from "./engines/util.ts";
import type { TranslateEngine, SegmentKind, TransStatus, SkipReason } from "./types.ts";
import { TranslateCache } from "./cache.ts";
import type { OutputTranslateConfig } from "./config.ts";

export interface QItem {
	segId: string;
	sessionId: string;
	messageKey: string;
	kind: SegmentKind;
	/** Unmasked source (journal + degraded fallback). */
	source: string;
	placeholders: Map<string, string>;
	/** Masked source actually sent to the engine. */
	masked: string;
	/** Enqueue time (epoch ms) for the oldest-pending diagnostic. */
	enqueuedAt?: number;
}

export interface QResult {
	segId: string;
	sessionId: string;
	messageKey: string;
	kind: SegmentKind;
	st: TransStatus;
	tgt?: string;
	rsn?: SkipReason;
	dg?: boolean;
	ms?: number;
	source: string;
}

export interface QueueDeps {
	/** Engine resolved per call so config hot-reload (hub.applyConfig) swaps it live. */
	getEngine: () => TranslateEngine;
	/** Hash of the effective glossary — part of the cache key so editing the
	 * glossary invalidates stale cached translations. */
	glossaryVersion: () => string;
	cache: TranslateCache;
	/** Effective config, read per decision (hot-reloaded). */
	getConfig: () => OutputTranslateConfig;
	/** Glossary prompt text (merged table). */
	glossaryText: () => string;
	/** Per-session prompt context (recent translations + locked terms). */
	getSessionCtx: (sessionId: string) => { recent: { source: string; target: string }[]; termLockLines: string };
	/** Record a finished translation into the session context. */
	recordTranslation: (sessionId: string, source: string, target: string) => void;
	/** Number of connected SSE viewers. */
	viewerCount: () => number;
	/** Whether translation is muted for a session. */
	isMuted: (sessionId: string) => boolean;
	onResult: (r: QResult) => void;
}

export class TranslateQueue {
	private readonly d: QueueDeps;
	private items: QItem[] = [];
	private failed = new Map<string, QItem>();
	private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
	private activeBatches = 0;
	private stopping = false;
	private wakeResolve: (() => void) | null = null;
	private droppedCount = 0;
	/**
	 * Adaptive batch ceiling (0 = use config value). A multi-item batch
	 * failure halves it; successful multi-batches climb it back toward the
	 * configured size. A fixed per-call timeout used to guarantee that
	 * 4-segment batches fail on slower engines — every batch then burned a
	 * full timeout before degrading to singles (throughput collapsed to
	 * ~4 segments per 90 s while the queue looked "stuck").
	 */
	private adaptiveMax = 0;

	constructor(deps: QueueDeps) {
		this.d = deps;
	}

	/** Enqueue a segment for translation. Synchronous, never throws. */
	enqueue(item: QItem): void {
		if (this.stopping) return;
		const full: QItem = item;
		try {
			const cfg = this.d.getConfig();
			const translatable = full.kind === "text" || full.kind === "comment" || full.kind === "user";
			if (this.d.isMuted(full.sessionId)) {
				this.emit({ ...base(full), st: "skipped", rsn: "muted" });
				return;
			}
			// Idle policy: no viewer connected.
			if (this.d.viewerCount() === 0) {
				const behavior = cfg.idle.noViewerBehavior;
				if (behavior === "none" || (!translatable && behavior === "text-only")) {
					this.emit({ ...base(full), st: "skipped", rsn: "idle" });
					return;
				}
			}
			// Cache hit?
			const key = TranslateCache.key(
				this.d.getEngine().id,
				this.d.glossaryVersion(),
				this.engineModel(),
				cfg.translate.targetLang,
				full.masked,
			);
			const hit = this.d.cache.get(key);
			if (hit !== undefined) {
				this.d.recordTranslation(full.sessionId, full.source, hit);
				this.emit({ ...base(full), st: "cached", tgt: hit });
				return;
			}
			this.items.push(full);
		full.enqueuedAt = Date.now();
			if (this.items.length > cfg.queue.maxPending) {
				this.dropForBackpressure();
			}
			this.scheduleDispatch();
		} catch (err) {
			// A queue bug must never surface into pi: fail this segment closed.
			this.emit({ ...base(full), st: "failed", tgt: undefined });
			console.warn("[pi-output-translate] enqueue error", err);
		}
	}

	/** Manual retry of one failed segment. */
	retry(segId: string): boolean {
		const item = this.failed.get(segId);
		if (!item) return false;
		this.failed.delete(segId);
		this.enqueue(item);
		return true;
	}

	/** Retry every failed segment of a session. Returns retried count. */
	retryFailed(sessionId: string): number {
		let n = 0;
		for (const [id, item] of [...this.failed.entries()]) {
			if (item.sessionId === sessionId) {
				this.failed.delete(id);
				this.enqueue(item);
				n++;
			}
		}
		return n;
	}

	pendingCount(): number {
		return this.items.length + this.activeBatches;
	}

	/** Waiting items only (excludes in-flight engine calls). A non-zero
	 * pendingCount with zero inFlight and zero items means a wedged batch —
	 * with all engines honoring the abort signal this is unreachable, but
	 * the breakdown makes "backlog vs deadlock" visible at a glance. */
	pendingItems(): number {
		return this.items.length;
	}

	/** In-flight engine calls (batch slots currently held). */
	/** Pending count broken down by session (multi-CLI visibility). */
	pendingBySession(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const it of this.items) out[it.sessionId] = (out[it.sessionId] ?? 0) + 1;
		return out;
	}

	/** Current adaptive batch ceiling (config size when never degraded). */
	effectiveBatchSize(): number {
		const cfgSize = Math.max(1, this.d.getConfig().translate.batchSize);
		return Math.max(1, Math.min(cfgSize, this.adaptiveMax > 0 ? this.adaptiveMax : cfgSize));
	}

	inFlight(): number {
		return this.activeBatches;
	}

	/** How long the OLDEST waiting item has been queued (ms); 0 when empty. */
	oldestPendingMs(): number {
		const first = this.items[0];
		return first?.enqueuedAt ? Date.now() - first.enqueuedAt : 0;
	}

	dropped(): number {
		return this.droppedCount;
	}

	failedCount(): number {
		return this.failed.size;
	}

	/** Test hook / shutdown helper: dispatch everything pending right now. */
	async flushNow(): Promise<void> {
		if (this.dispatchTimer) {
			clearTimeout(this.dispatchTimer);
			this.dispatchTimer = null;
		}
		// runBatchLoop fires concurrently and returns immediately (r14a);
		// wait for the full drain — batches always settle within their
		// deadlines, so this terminates.
		void this.runBatchLoop();
		while (this.pendingCount() > 0) {
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	async stop(): Promise<void> {
		this.stopping = true;
		if (this.dispatchTimer) {
			clearTimeout(this.dispatchTimer);
			this.dispatchTimer = null;
		}
		// Fail-close queued items so the page shows their final state.
		for (const item of this.items) {
			this.emit({ ...base(item), st: "skipped", rsn: "disabled" });
		}
		this.items = [];
		while (this.activeBatches > 0) {
			await new Promise((r) => setTimeout(r, 10));
		}
	}

	// ------------------------------------------------------------------

	private engineModel(): string {
		return this.d.getConfig().translate.model;
	}

	private scheduleDispatch(): void {
		if (this.dispatchTimer || this.stopping) return;
		const windowMs = Math.max(1, this.d.getConfig().translate.batchWindowMs);
		this.dispatchTimer = setTimeout(() => {
			this.dispatchTimer = null;
			void this.runBatchLoop();
		}, windowMs);
		this.dispatchTimer.unref?.();
	}

	private async runBatchLoop(): Promise<void> {
		const maxActive = Math.max(1, this.d.getConfig().translate.concurrency);
		while (this.items.length > 0 && this.activeBatches < maxActive && !this.stopping) {
			this.activeBatches++;
			// Fire WITHOUT awaiting: concurrency > 1 means overlapping engine
			// calls. The loop used to await each batch inline, which made the
			// concurrency=2 setting silently sequential (settings-controls
			// suite, r14a).
			void this.runOneBatch()
				.catch(() => undefined)
				.finally(() => {
					this.activeBatches--;
					if (this.items.length > 0 && !this.stopping) this.scheduleDispatch();
				});
		}
	}

	private async runOneBatch(): Promise<void> {
		const cfg = this.d.getConfig();
		const cfgSize = Math.max(1, cfg.translate.batchSize);
		const size = Math.max(1, Math.min(cfgSize, this.adaptiveMax > 0 ? this.adaptiveMax : cfgSize));
		// Character budget: slice by source length so batch prompts stay inside
		// small local-model context windows (ollama num_ctx 4096 default). At
		// least one item per batch, whatever its length.
		const budget = Math.max(400, cfg.translate.maxBatchChars ?? 2400);
		const batch: QItem[] = [];
		let used = 0;
		while (batch.length < size && this.items.length > 0) {
			const next = this.items[0];
			if (batch.length > 0 && used + next.masked.length > budget) break;
			batch.push(this.items.shift()!);
			used += next.masked.length;
		}
		if (batch.length === 0) return;
		const started = Date.now();
		// A batch of N generates ~N× a single's output — grant up to 2× the
		// per-segment budget (bounded so a dead engine still fails fast).
		const perMs = cfg.translate.timeoutSeconds * 1000;
		const deadline = perMs * Math.min(batch.length, 2) + 5000;
		try {
			const pctx = this.promptCtx(batch);
			const sys = systemPrompt(pctx, batch.length);
			const user = batchUserPrompt(batch, pctx);
			const raw = await this.d.getEngine().complete(sys, user, AbortSignal.timeout(deadline), deadline);
			const answer = cleanEngineOutput(raw);
			if (batch.length === 1) {
				// Plain single-segment protocol: the whole answer is the translation.
				if (answer.trim() === "") throw new Error("empty single answer");
				await this.finishItem(batch[0], answer, started);
				return;
			}
			const blocks = parseBlocks(answer, batch.length);
			if (blocks === null) throw new Error("batch answer malformed");
			for (let i = 0; i < batch.length; i++) {
				await this.finishItem(batch[i], blocks[i], started);
			}
			// success: relax the ceiling back toward the configured size
			if (this.adaptiveMax > 0) this.adaptiveMax = Math.min(cfgSize, this.adaptiveMax + 1);
		} catch (err) {
			if (batch.length > 1) {
				// Adaptive degradation: requeue at HALF the size instead of
				// burning a full timeout per single retry. Size strictly
				// decreases toward 1, so this terminates without a loop guard.
				this.adaptiveMax = Math.max(1, Math.floor(batch.length / 2));
				this.items.unshift(...batch);
				return;
			}
			// Single-item failure: one plain retry, then report as failed.
			await this.retryAlone(batch[0], started, err);
		}
	}

	private async retryAlone(item: QItem, started: number, cause: unknown): Promise<void> {
		const cfg = this.d.getConfig();
		try {
			const pctx = this.promptCtx([item]);
			const sys = systemPrompt(pctx, 1);
			const user = batchUserPrompt([item], pctx);
			const raw = await this.d.getEngine().complete(sys, user, AbortSignal.timeout(cfg.translate.timeoutSeconds * 1000 + 5000));
			const answer = cleanEngineOutput(raw);
			if (answer.trim() === "") throw new Error("retry answer malformed");
			await this.finishItem(item, answer, started);
		} catch (err2) {
			this.rememberFailed(item);
			this.emit({
				...base(item),
				st: "failed",
				ms: Date.now() - started,
			});
			void cause;
			void err2;
		}
	}

	/** Restore placeholders; run repair when tokens were lost. */
	private async finishItem(item: QItem, maskedTarget: string, started: number): Promise<void> {
		const cfg = this.d.getConfig();
		let target = maskedTarget;
		let lost = lostPlaceholders(item.masked, target);
		let degraded = false;
		if (lost.length > 0) {
			// One repair pass.
			try {
				const sys = systemPrompt(this.promptCtx([item]), 1);
				const rep = repairUserPrompt(item, target, lost);
				const raw = await this.d.getEngine().complete(sys, rep, AbortSignal.timeout(cfg.translate.timeoutSeconds * 1000));
				target = cleanEngineOutput(raw);
				lost = lostPlaceholders(item.masked, target);
			} catch {
				/* fall through to degrade */
			}
			if (lost.length > 0) {
				degraded = true;
				target = item.masked; // non-empty guard below; the emitted tgt is item.source
			}
		}
		if (target.trim() === "") {
			this.rememberFailed(item);
			this.emit({ ...base(item), st: "failed", ms: Date.now() - started });
			return;
		}
		const restored = degraded ? item.source : restore(target, item.placeholders, item.masked);
		// Cache stores the masked pair so restore happens per display? No — cache
		// the restored text: sources repeat verbatim and placeholders repeat too.
		const key = TranslateCache.key(
			this.d.getEngine().id,
			this.d.glossaryVersion(),
			this.engineModel(),
			cfg.translate.targetLang,
			item.masked,
		);
		if (!degraded) this.d.cache.set(key, restored);
		if (!degraded) this.d.recordTranslation(item.sessionId, item.source, restored);
		this.emit({
			...base(item),
			st: degraded ? "degraded" : "done",
			tgt: restored,
			dg: degraded || undefined,
			ms: Date.now() - started,
		});
	}

	private promptCtx(batch: QItem[]): PromptContext {
		const cfg = this.d.getConfig();
		// Context from the first item's session (batches are near-time, mixed
		// sessions are rare; context is a nicety, not a correctness need).
		const sctx = this.d.getSessionCtx(batch[0].sessionId);
		return {
			targetLang: cfg.translate.targetLang,
			glossaryText: this.d.glossaryText(),
			termLockLines: sctx.termLockLines,
			recent: sctx.recent.slice(-cfg.translate.contextSegments * 2),
		};
	}

	private dropForBackpressure(): void {
		// Drop the newest thinking item first (keep text).
		for (let i = this.items.length - 1; i >= 0; i--) {
			if (this.items[i].kind === "thinking") {
				const [dropped] = this.items.splice(i, 1);
				this.droppedCount++;
				this.rememberFailed(dropped); // dropped segments stay retryable
				this.emit({ ...base(dropped), st: "skipped", rsn: "backpressure" });
				return;
			}
		}
		// No thinking available: drop the newest item.
		const dropped = this.items.pop();
		if (dropped) {
			this.droppedCount++;
			this.rememberFailed(dropped);
			this.emit({ ...base(dropped), st: "skipped", rsn: "backpressure" });
		}
	}

	private rememberFailed(item: QItem): void {
		if (this.failed.size >= 200) {
			// Bound the map.
			const first = this.failed.keys().next().value;
			if (first !== undefined) this.failed.delete(first);
		}
		this.failed.set(item.segId, item);
	}

	private emit(r: QResult): void {
		try {
			this.d.onResult(r);
		} catch (err) {
			console.warn("[pi-output-translate] result callback error", err);
		}
	}
}

function base(item: QItem): Omit<QResult, "st" | "tgt" | "rsn" | "dg" | "ms"> {
	return {
		segId: item.segId,
		sessionId: item.sessionId,
		messageKey: item.messageKey,
		kind: item.kind,
		source: item.source,
	};
}
