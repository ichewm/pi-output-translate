/**
 * Collector — the ONLY code that runs inside pi's event stream.
 *
 * Contract (SPEC §3): every handler is synchronous, O(1)-ish (string work on
 * bounded buffers only), wrapped in try/catch, and returns undefined. All
 * slow work happens downstream (hub queue / uplink buffer).
 *
 * Splits assistant streams into segments via MessageSegmenter, forwards
 * deltas for live display, and derives one-line tool summaries.
 */

import { MessageSegmenter, extractComments } from "./segmenter.ts";
import type { Segment } from "./segmenter.ts";
import type { HubEvent, SegmentKind } from "./types.ts";
import type { OutputTranslateConfig } from "./config.ts";

/** Structural types for pi events (keep the extension self-contained). */
interface PiMessage {
	role?: string;
	content?: unknown;
	stopReason?: string;
}

interface PiAssistantEvent {
	type: string;
	contentIndex?: number;
	delta?: string;
	partial?: { content?: { type?: string; redacted?: boolean }[] };
}

export interface CollectorDeps {
	getSessionId: () => string;
	publish: (ev: HubEvent) => void;
	getConfig: () => OutputTranslateConfig;
}

interface MsgState {
	key: string;
	role: "user" | "assistant" | "toolResult";
	model?: string;
	segmenters: Map<string, MessageSegmenter>;
	segCounters: Map<string, number>;
	/** thinking blocks we saw deltas for (contentIndex set). */
	thinkingSeen: Set<number>;
}

export class Collector {
	private readonly d: CollectorDeps;
	private msgSeq = 0;
	private current: MsgState | null = null;

	constructor(deps: CollectorDeps) {
		this.d = deps;
	}

	/** Reset per-session state. */
	reset(): void {
		this.msgSeq = 0;
		this.current = null;
	}

	// ------------------------------------------------------------------
	// pi handlers — sync, defensive, return undefined

	onMessageStart(event: { message: PiMessage }, model?: string): void {
		try {
			const role = normRole(event.message.role);
			if (role === "toolResult") return; // tool lines come from tool events
			const key = `${++this.msgSeq}`;
			this.current = {
				key,
				role,
				model,
				segmenters: new Map(),
				segCounters: new Map(),
				thinkingSeen: new Set(),
			};
			this.d.publish({ t: "msg_start", s: this.d.getSessionId(), m: key, role, model });
			if (role === "user" && this.d.getConfig().sources.userMessage) {
				const text = userText(event.message.content);
				if (text.trim() !== "") {
					const id = this.segId(key, "user", 0, 0);
					this.d.publish({ t: "segment", s: this.d.getSessionId(), m: key, k: "user", id, src: text.trim(), r: "user" });
				}
			}
		} catch {
			/* never surface */
		}
	}

	onMessageUpdate(assistantEvent: PiAssistantEvent): void {
		try {
			const cur = this.current;
			if (!cur || cur.role !== "assistant") return;
			const idx = finiteIndex(assistantEvent.contentIndex);
			const type = assistantEvent.type;
			if (type === "text_delta" || type === "thinking_delta") {
				const kind: "text" | "thinking" = type === "text_delta" ? "text" : "thinking";
				const delta = assistantEvent.delta ?? "";
				if (delta === "") return;
				if (kind === "thinking") {
					if (!this.d.getConfig().sources.thinking) return;
					cur.thinkingSeen.add(idx);
				} else if (!this.d.getConfig().sources.assistantText) {
					return;
				}
				this.d.publish({
					t: "delta",
					s: this.d.getSessionId(),
					m: cur.key,
					k: kind,
					c: idx,
					d: delta,
				});
				const segs = this.segmenter(cur, idx, kind).feed(delta);
				for (const seg of segs) this.emitSegment(cur, seg, idx);
			}
		} catch {
			/* never surface */
		}
	}

	onThinkingEnd(assistantEvent: PiAssistantEvent): void {
		try {
			const cur = this.current;
			if (!cur || cur.role !== "assistant") return;
			const idx = finiteIndex(assistantEvent.contentIndex);
			const block = assistantEvent.partial?.content?.[idx];
			if (block?.redacted && cur.thinkingSeen.has(idx) && !cur.segCounters.has(`t:${idx}`)) {
				// Redacted thinking we streamed but never segmented: tell the page.
				const id = this.segId(cur.key, "thinking", idx, 0);
				this.d.publish({
					t: "segment",
					s: this.d.getSessionId(),
					m: cur.key,
					k: "code",
					id,
					src: "[思考内容已被安全过滤，无法翻译]",
				});
				cur.segCounters.set(`t:${idx}`, 1);
			}
		} catch {
			/* never surface */
		}
	}

	onMessageEnd(event: { message: PiMessage }): void {
		try {
			const cur = this.current;
			if (!cur) return;
			if (cur.role === "assistant") {
				for (const [key, seg] of cur.segmenters) {
					const [, kind, idxStr] = key.split(":") as [string, "text" | "thinking", string];
					for (const s of seg.flush()) {
						this.emitSegment(cur, s, Number(idxStr));
					}
				}
			}
			this.d.publish({
				t: "msg_end",
				s: this.d.getSessionId(),
				m: cur.key,
				stop: event.message.stopReason,
			});
			this.current = null;
		} catch {
			/* never surface */
		}
	}

	onToolStart(event: { toolName: string; args: unknown; toolCallId?: string; parentToolCallId?: string }): void {
		try {
			if (!this.d.getConfig().sources.toolLines) return;
			if (event.parentToolCallId) return; // nested calls: noise
			const cur = this.current ?? this.nextImplicitMsg();
			this.d.publish({
				t: "tool",
				s: this.d.getSessionId(),
				m: cur.key,
				tc: event.toolCallId ?? `${event.toolName}:${Date.now()}`,
				name: event.toolName,
				ph: "start",
				sum: argSummary(event.args),
			});
		} catch {
			/* never surface */
		}
	}

	onToolEnd(event: { toolName: string; result: unknown; isError: boolean; durationMs?: number; toolCallId?: string; parentToolCallId?: string }): void {
		try {
			if (!this.d.getConfig().sources.toolLines) return;
			if (event.parentToolCallId) return;
			const cur = this.current ?? this.nextImplicitMsg();
			this.d.publish({
				t: "tool",
				s: this.d.getSessionId(),
				m: cur.key,
				tc: event.toolCallId ?? `${event.toolName}:${Date.now()}`,
				name: event.toolName,
				ph: "end",
				ok: !event.isError,
				ms: event.durationMs,
				sum: resultSummary(event.result, event.isError),
			});
		} catch {
			/* never surface */
		}
	}

	// ------------------------------------------------------------------

	/** Tool events can fire before any message_start (edge: resumed streams). */
	private nextImplicitMsg(): MsgState {
		this.msgSeq++;
		this.current = {
			key: `${this.msgSeq}`,
			role: "assistant",
			segmenters: new Map(),
			segCounters: new Map(),
			thinkingSeen: new Set(),
		};
		this.d.publish({ t: "msg_start", s: this.d.getSessionId(), m: this.current.key, role: "assistant" });
		return this.current;
	}

	private segmenter(msg: MsgState, contentIndex: number, kind: "text" | "thinking"): MessageSegmenter {
		const key = `${kind}:${contentIndex}`;
		let seg = msg.segmenters.get(key);
		if (!seg) {
			seg = new MessageSegmenter({
				kind,
				maxSegmentChars: this.d.getConfig().translate.maxSegmentChars,
			});
			msg.segmenters.set(key, seg);
		}
		return seg;
	}

	private emitSegment(msg: MsgState, seg: Segment, contentIndex: number): void {
		const cfg = this.d.getConfig();
		const sid = this.d.getSessionId();
		if (seg.kind === "code") {
			const n = this.bump(msg, "code", contentIndex);
			const codeId = this.segId(msg.key, "code", contentIndex, n);
			this.d.publish({
				t: "segment",
				s: sid,
				m: msg.key,
				k: "code",
				id: codeId,
				src: seg.src,
				lang: seg.lang,
			});
			if (cfg.translate.codeComments === "below") {
				for (const comment of extractComments(seg.src)) {
					const cn = this.bump(msg, "comment", contentIndex);
					this.d.publish({
						t: "segment",
						s: sid,
						m: msg.key,
						k: "comment",
						id: this.segId(msg.key, "comment", contentIndex, cn),
						src: comment,
						of: codeId,
					});
				}
			}
			return;
		}
		const n = this.bump(msg, seg.kind, contentIndex);
		this.d.publish({
			t: "segment",
			s: sid,
			m: msg.key,
			k: seg.kind,
			id: this.segId(msg.key, seg.kind, contentIndex, n),
			src: seg.src,
			pb: seg.paraStart === true ? 1 : undefined,
		});
	}

	private bump(msg: MsgState, kind: SegmentKind, contentIndex: number): number {
		const key = `${kind}:${contentIndex}`;
		const n = (msg.segCounters.get(key) ?? 0) + 1;
		msg.segCounters.set(key, n);
		return n;
	}

	private segId(msgKey: string, kind: string, contentIndex: number, n: number): string {
		return `${this.d.getSessionId()}:${msgKey}:${kind}:${contentIndex}:${n}`;
	}
}

function normRole(role: string | undefined): "user" | "assistant" | "toolResult" {
	if (role === "user") return "user";
	if (role === "toolResult") return "toolResult";
	return "assistant";
}

/** Defensive contentIndex: some providers emit undefined/NaN; both map to 0. */
function finiteIndex(i: number | undefined): number {
	return typeof i === "number" && Number.isFinite(i) ? i : 0;
}

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) => (c && typeof c === "object" && (c as { type?: string }).type === "text" ? String((c as { text?: string }).text ?? "") : ""))
			.join("");
	}
	return "";
}

const SUMMARY_KEYS = ["file_path", "path", "command", "pattern", "url", "query", "script", "content", "name", "cmd"];

export function argSummary(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const a = args as Record<string, unknown>;
	for (const key of SUMMARY_KEYS) {
		const v = a[key];
		if (typeof v === "string" && v.trim() !== "") {
			return truncate(firstLine(v), 90);
		}
		if (typeof v === "number" || typeof v === "boolean") continue;
	}
	try {
		return truncate(firstLine(JSON.stringify(args)), 90);
	} catch {
		return undefined;
	}
}

function resultSummary(result: unknown, isError: boolean): string | undefined {
	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		const content = r.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((c) =>
								c && typeof c === "object" && (c as { type?: string }).type === "text"
									? String((c as { text?: string }).text ?? "")
									: "",
							)
							.join("")
					: undefined;
		if (text !== undefined) return truncate(firstLine(text), 110);
		if (isError && typeof r.error === "string") return truncate(r.error, 110);
	}
	if (typeof result === "string") return truncate(firstLine(result), 110);
	return undefined;
}

function firstLine(s: string): string {
	const i = s.indexOf("\n");
	return i === -1 ? s : s.slice(0, i);
}

function truncate(s: string, n: number): string {
	s = s.trim();
	return s.length > n ? `${s.slice(0, n)}…` : s;
}
