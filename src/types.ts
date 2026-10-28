/**
 * Shared types for pi-output-translate.
 *
 * Everything that crosses a boundary (hub -> SSE -> browser, client -> host
 * ingest, journal -> history page) uses the HubEvent union below, so one
 * shape serves live streaming, replay and persistence.
 */

export const APP_ID = "pi-output-translate";
export const APP_VERSION = "1.0.0";
/** Translation/render pipeline revision — bumped every behavioral fix so
 * the page can prove it talks to a fresh host (stale pi sessions used to
 * masquerade as rendering bugs). Format: r<fix-round>.<patch>. */
export const PIPELINE_VER = "r14";

/** A session registered with the hub. */
export interface SessionInfo {
	/** Stable id (pi sessionId). */
	id: string;
	/** Display name: cwd basename (+ optional session label). */
	name: string;
	/** Working directory of the pi process. */
	cwd: string;
	/** Current model string, e.g. "anthropic/claude-sonnet-4-6". */
	model?: string;
	/** true for the host process's own session (never times out). */
	local?: boolean;
	/** Translation muted for this session. */
	muted?: boolean;
	/** Last heartbeat epoch ms (host-managed). */
	lastSeen?: number;
}

export type SegmentKind = "text" | "thinking" | "user" | "code" | "comment";

export type TransStatus =
	| "done"
	| "cached"
	| "failed"
	| "skipped"
	| "notrans"
	| "degraded";

export type SkipReason = "idle" | "backpressure" | "muted" | "disabled";

/** Union of all events flowing through the hub. */
export type HubEvent =
	| { t: "hello"; sessions: SessionInfo[]; engine: EngineInfo; cfg: unknown; focus?: string; ver?: string }
	| { t: "focus"; s: string; ts: number }
	| { t: "typing"; s: string; ts: number }
	| { t: "session_up"; s: SessionInfo }
	| { t: "session_down"; s: string; reason: "shutdown" | "timeout" }
	| { t: "session_mute"; s: string; muted: boolean }
	| {
			t: "msg_start";
			s: string;
			m: string;
			role: "user" | "assistant" | "toolResult";
			model?: string;
	  }
	| {
			t: "delta";
			s: string;
			m: string;
			k: "text" | "thinking";
			c: number;
			d: string;
	  }
	| {
			t: "segment";
			s: string;
			m: string;
			k: SegmentKind;
			/** Globally-unique segment id. */
			id: string;
			/** Source text (or raw fenced code for k="code"). */
			src: string;
			/** 1 when this segment starts a new paragraph (breaks the inline run). */
			pb?: 1;
			/** Role hint for lazy message-card creation ("user" segments arrive
			 * without a prior msg_start card in some pi modes). */
			r?: "user";
			/** Fenced-code language hint, when known. */
			lang?: string;
			/** Owning segment id for k="comment" (the code block). */
			of?: string;
	  }
	| {
			t: "trans";
			/** Segment id being finalized. */
			id: string;
			st: TransStatus;
			tgt?: string;
			/** Skip reason when st="skipped". */
			rsn?: SkipReason;
			/** True when placeholder repair failed and tgt fell back to source. */
			dg?: boolean;
			/** Round-trip ms (informational). */
			ms?: number;
	  }
	| {
			t: "tool";
			s: string;
			m: string;
			/** toolCallId for start/end pairing. */
			tc: string;
			name: string;
			ph: "start" | "end";
			sum?: string;
			ms?: number;
			ok?: boolean;
	  }
	| { t: "msg_end"; s: string; m: string; stop?: string }
	| { t: "cfg"; cfg: unknown }
	| { t: "status"; q: number; eng: boolean; drop: number; clients: number; p?: number; a?: number; old?: number; bs?: number; pq?: Record<string, number> };

export interface EngineInfo {
	id: string;
	model: string;
	ok: boolean;
}

/** A ring-buffered event with its global sequence number. */
export interface SequencedEvent {
	seq: number;
	ev: HubEvent;
}

/** Batch item handed to a translation engine. */
export interface TranslateItem {
	segId: string;
	/** Masked source (placeholders in place, code already stripped). */
	source: string;
	/** Kind, for context assembly. */
	kind: SegmentKind;
	/** Session id (for per-session term locking). */
	sessionId: string;
}

export interface EngineInit {
	baseUrl: string;
	model: string;
	apiKey?: string;
	temperature: number;
	timeoutMs: number;
	/** Glossary rendered into the system prompt. */
	glossaryText: string;
	/** Called with (source) -> target for cache checks before engine calls. */
	lookupCache?: (source: string) => string | undefined;
}

export interface TranslateEngine {
	readonly id: string;
	/** One raw chat completion (no batch policy here — queue owns policy). */
	complete(system: string, user: string, signal: AbortSignal, timeoutMs?: number): Promise<string>;
	healthCheck(): Promise<boolean>;
	listModels?(): Promise<string[]>;
	dispose?(): void;
}

/** Collector-side segmenter output. */
export interface RawSegment {
	kind: SegmentKind;
	/** Index of the content block this segment came from. */
	contentIndex: number;
	/** Segment ordinal within (message, contentIndex, kind). */
	segIdx: number;
	src: string;
	lang?: string;
	/** For comment segments: owning code segment's id. */
	of?: string;
}
