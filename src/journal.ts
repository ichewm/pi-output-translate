/**
 * Journal: append-only jsonl history per session under
 * ~/.pi/agent/output-translate/history/<sessionId>.jsonl.
 *
 * - Batched writes (flush interval or size threshold) so a busy stream never
 *   syncs on every segment; failures are silent (history is best effort).
 * - Rolling cap: keep at most `maxFiles` most-recent files, each truncated to
 *   `maxFileMb` on load-check; corrupt lines are skipped on read.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync, unlinkSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface JournalRecord {
	/** Epoch ms. */
	ts: number;
	/** Session id. */
	s: string;
	/** Working directory of the session (for project-grouped history). */
	cwd?: string;
	/** Message key. */
	m: string;
	/** Segment kind. */
	k: string;
	/** Segment id. */
	id: string;
	/** Source text. */
	src: string;
	/** Translation, when st is done/cached. */
	tgt?: string;
	/** Terminal status. */
	st: string;
}

export class Journal {
	private readonly dir: string;
	private readonly maxBytes: number;
	private readonly maxFiles: number;
	private pending: JournalRecord[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly flushIntervalMs: number;
	private readonly flushThreshold: number;
	private droppedRecords = 0;

	constructor(dir: string, maxFileMb: number, maxFiles: number) {
		this.dir = dir;
		this.maxBytes = Math.max(1, maxFileMb) * 1024 * 1024;
		this.maxFiles = Math.max(1, maxFiles);
		this.flushIntervalMs = 1000;
		this.flushThreshold = 4 * 1024;
	}

	/** Queue a record; actual disk write is batched. */
	append(rec: JournalRecord): void {
		this.pending.push(rec);
		const size = this.pending.reduce((n, r) => n + JSON.stringify(r).length, 0);
		if (size >= this.flushThreshold) {
			this.flush();
			return;
		}
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, this.flushIntervalMs);
		this.timer.unref?.();
	}

	/** Force-write pending records now. */
	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.pending.length === 0) return;
		const byFile = new Map<string, JournalRecord[]>();
		for (const rec of this.pending) {
			const arr = byFile.get(rec.s) ?? [];
			arr.push(rec);
			byFile.set(rec.s, arr);
		}
		this.pending = [];
		try {
			mkdirSync(this.dir, { recursive: true });
			for (const [sid, recs] of byFile) {
				const file = this.fileFor(sid);
				const blob = recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
				writeFileSync(file, blob, { flag: "a" });
				this.capFile(file);
			}
			this.capFiles();
		} catch {
			this.droppedRecords += 1;
			/* journal is best effort */
		}
	}

	private fileFor(sessionId: string): string {
		// Session ids are uuid-ish; harden anyway.
		const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
		return join(this.dir, `${safe}.jsonl`);
	}

	/** Best-effort path of a session's journal file (for cwd peeking). */
	filePathFor(sessionId: string): string {
		return this.fileFor(sessionId);
	}

	/**
	 * Recover a session's cwd from pi's own session store (see
	 * findPiSessionFile) — wrapper kept for compatibility.
	 */
	recoverCwdFromPiSessions(sessionId: string, sessionsRoot: string): string | null {
		const file = this.findPiSessionFile(sessionId, sessionsRoot);
		return file ? readPiSessionCwd(file) : null;
	}

	/** Locate `<timestamp>_<sessionId>.jsonl` inside pi's session store. */
	findPiSessionFile(sessionId: string, sessionsRoot: string): string | null {
		try {
			for (const proj of readdirSync(sessionsRoot)) {
				const projDir = join(sessionsRoot, proj);
				let st;
				try {
					st = statSync(projDir);
				} catch {
					continue;
				}
				if (!st.isDirectory()) continue;
				for (const f of readdirSync(projDir)) {
					if (f.endsWith(`_${sessionId}.jsonl`)) return join(projDir, f);
				}
			}
			return null;
		} catch {
			return null;
		}
	}

	/** Peek the cwd recorded in the journal: head first, then tail. */
	peekCwd(file: string): string | null {
		const scan = (text: string): string | null => {
			for (const line of text.split("\n")) {
				const l = line.trim();
				if (l === "") continue;
				try {
					const rec = JSON.parse(l) as JournalRecord;
					if (typeof rec.cwd === "string" && rec.cwd !== "") return rec.cwd;
				} catch {
					/* skip */
				}
			}
			return null;
		};
		try {
			const got = scan(readFileSync(file, "utf8").slice(0, 8192));
			if (got) return got;
			// cwd recording shipped mid-project: older journals only carry it in
			// LATER records. Scan the tail before falling back to the expensive
			// pi-session-store recovery scan (C1).
			const st = statSync(file);
			if (st.size <= 8192) return null;
			const len = Math.min(64 * 1024, st.size);
			const buf = Buffer.alloc(len);
			const fh = openSync(file, "r");
			try {
				readSync(fh, buf, 0, len, st.size - len);
			} finally {
				closeSync(fh);
			}
			return scan(buf.toString("utf8"));
		} catch {
			return null;
		}
	}

	/**
	 * Short topic label for history rows: the first user-prompt record in
	 * the journal head ("what was this conversation about" at a glance
	 * instead of a raw uuid prefix).
	 */
	peekTopic(file: string): string | null {
		const scan = (text: string): string | null => {
			for (const line of text.split("\n")) {
				const l = line.trim();
				if (l === "") continue;
				try {
					const rec = JSON.parse(l) as JournalRecord;
					if (rec.k === "user" && typeof rec.src === "string" && rec.src.trim() !== "") {
						return topicFrom(rec.src);
					}
				} catch {
					/* skip */
				}
			}
			return null;
		};
		try {
			const got = scan(readFileSync(file, "utf8").slice(0, 64 * 1024));
			if (got) return got;
			// journals predating user-prompt journaling only carry them late —
			// scan the tail before giving up (mirrors peekCwd)
			const st = statSync(file);
			if (st.size <= 64 * 1024) return null;
			const len = Math.min(64 * 1024, st.size - 64 * 1024);
			const buf = Buffer.alloc(len);
			const fh = openSync(file, "r");
			try {
				readSync(fh, buf, 0, len, st.size - len);
			} finally {
				closeSync(fh);
			}
			return scan(buf.toString("utf8"));
		} catch {
			return null;
		}
	}

	/** Truncate a file to maxBytes on line boundaries when it grows over. */
	private capFile(file: string): void {
		try {
			const size = statSync(file).size;
			if (size <= this.maxBytes) return;
			const text = readFileSync(file, "utf8");
			const lines = text.split("\n");
			let total = 0;
			let keepFrom = 0;
			for (let i = lines.length - 1; i >= 0; i--) {
				total += lines[i].length + 1;
				if (total > this.maxBytes) {
					keepFrom = i + 1;
					break;
				}
			}
			const kept = lines.slice(keepFrom).join("\n");
			const tmp = `${file}.tmp`;
			writeFileSync(tmp, kept, "utf8");
			renameSync(tmp, file);
		} catch {
			/* best effort */
		}
	}

	/**
	 * Keep only the newest maxFiles journals. Stale EMPTY journals are
	 * deleted outright first — they hold no history but used to consume
	 * maxFiles slots, silently evicting real records (B3). A fresh empty
	 * file is spared AND never counts against the cap: it may be a
	 * just-started session mid-first-flush, and must not evict real history.
	 */
	private capFiles(): void {
		try {
			const entries = readdirSync(this.dir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => {
					const full = join(this.dir, f);
					const st = statSync(full);
					return { full, mtime: st.mtimeMs, size: st.size };
				});
			const hourAgo = Date.now() - 3_600_000;
			for (const e of entries) {
				if (e.size === 0 && e.mtime < hourAgo) {
					try {
						unlinkSync(e.full);
					} catch {
						/* ignore */
					}
				}
			}
			const real = entries
				.filter((e) => e.size > 0)
				.sort((a, b) => b.mtime - a.mtime);
			for (const e of real.slice(this.maxFiles)) {
					try {
						unlinkSync(e.full);
					} catch {
						/* ignore */
					}
			}
		} catch {
			/* ignore */
		}
	}

	/** List available history sessions: [{sessionId, records?, mtime, bytes}] */
	list(): { sessionId: string; mtime: number; bytes: number }[] {
		this.flush();
		try {
			if (!existsSync(this.dir)) return [];
			return readdirSync(this.dir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => {
					const full = join(this.dir, f);
					const st = statSync(full);
					return {
						sessionId: f.replace(/\.jsonl$/, ""),
						mtime: st.mtimeMs,
						bytes: st.size,
					};
				})
				.sort((a, b) => b.mtime - a.mtime);
		} catch {
			return [];
		}
	}

	/** Read and parse one session's journal; corrupt lines are skipped. */
	read(sessionId: string, limitBytes = 8 * 1024 * 1024): JournalRecord[] {
		this.flush();
		const file = this.fileFor(sessionId);
		if (!existsSync(file)) return [];
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return [];
		}
		if (text.length > limitBytes) text = text.slice(-limitBytes);
		const out: JournalRecord[] = [];
		for (const line of text.split("\n")) {
			const l = line.trim();
			if (l === "") continue;
			try {
				const rec = JSON.parse(l) as JournalRecord;
				if (typeof rec.id === "string" && typeof rec.src === "string") out.push(rec);
			} catch {
				/* skip corrupt line */
			}
		}
		return out;
	}

	dispose(): void {
		this.flush();
	}

	stats(): { droppedWrites: number } {
		return { droppedWrites: this.droppedRecords };
	}
}

/** Read the cwd from the first line of a pi session file. */
export function readPiSessionCwd(piFile: string): string | null {
	try {
		const head = readFileSync(piFile, "utf8").slice(0, 300);
		const rec = JSON.parse(head.split("\n")[0] ?? "") as { cwd?: string };
		if (typeof rec.cwd === "string" && rec.cwd !== "") return rec.cwd;
	} catch {
		/* keep null */
	}
	return null;
}

/**
 * First real user prompt from a pi session file — the topic fallback for
 * journals that never recorded one (Chinese prompts were gated out before
 * r12b). Skips slash commands and XML-ish scaffolding.
 */
export function readPiSessionTopic(piFile: string): string | null {
	try {
		const text = readFileSync(piFile, "utf8").slice(0, 256 * 1024);
		for (const line of text.split("\n")) {
			const l = line.trim();
			if (l === "") continue;
			let d: { type?: string; message?: { role?: string; content?: unknown } };
			try {
				d = JSON.parse(l);
			} catch {
				continue;
			}
			if (d.type !== "message" || d.message?.role !== "user") continue;
			let c = d.message.content;
			if (Array.isArray(c)) {
				c = c
					.filter((x): x is { text: string } => typeof x?.text === "string")
					.map((x) => x.text)
					.join(" ");
			}
			if (typeof c !== "string" || !c.trim()) continue;
			const t = topicFrom(c);
			if (t.startsWith("/") || t.startsWith("<")) continue;
			if (t !== "") return t;
		}
	} catch {
		/* keep null */
	}
	return null;
}

/** Collapse a source text into a one-line topic label (≤32 chars). */
export function topicFrom(src: string): string {
	const t = src
		.replace(/\s+/g, " ")
		// strip leading markdown decoration: `## `, `- `, `1. `, `- [ ] ` …
		// (looped alternatives so combined prefixes like "- [ ] " fully strip,
		// while plain numbers like "2026 was…" survive)
		.replace(/^(?:[#>*`\-]+\s*|\d+[.)]\s*|\[[ x]\]\s*)+/, "")
		.trim();
	return t.length > 32 ? t.slice(0, 32) + "…" : t;
}

/** Emergency truncate helper used by tests. */
export function resetJournalDir(dir: string): void {
	if (!existsSync(dir)) return;
	for (const f of readdirSync(dir)) {
		try {
			truncateSync(join(dir, f));
		} catch {
			/* ignore */
		}
	}
}
