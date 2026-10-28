/**
 * Translation cache: in-memory LRU keyed by
 * sha1(engine|model|targetLang|source). Optional disk persistence with
 * debounced atomic writes; corrupt files are ignored on load.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class TranslateCache {
	private readonly map = new Map<string, string>();
	private readonly maxEntries: number;
	private readonly file: string | null;
	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	private dirty = false;
	private hits = 0;
	private misses = 0;

	constructor(maxEntries: number, persistFile: string | null) {
		this.maxEntries = Math.max(1, maxEntries);
		this.file = persistFile;
		this.load();
	}

	static key(engine: string, glossaryVersion: string, model: string, targetLang: string, source: string): string {
		return createHash("sha1")
			.update(`${engine}\u0000${glossaryVersion}\u0000${model}\u0000${targetLang}\u0000${source}`)
			.digest("hex");
	}

	private load(): void {
		if (!this.file || !existsSync(this.file)) return;
		try {
			const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, string>;
			for (const [k, v] of Object.entries(raw)) {
				if (typeof v === "string") this.map.set(k, v);
			}
		} catch {
			/* corrupt cache file: start empty */
		}
	}

	get(key: string): string | undefined {
		const v = this.map.get(key);
		if (v === undefined) {
			this.misses++;
			return undefined;
		}
		this.hits++;
		// LRU touch
		this.map.delete(key);
		this.map.set(key, v);
		return v;
	}

	set(key: string, value: string): void {
		this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.maxEntries) {
			// Evict oldest (first key).
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) this.map.delete(oldest);
		}
		if (this.file) {
			this.dirty = true;
			this.schedulePersist();
		}
	}

	size(): number {
		return this.map.size;
	}

	stats(): { size: number; hits: number; misses: number; hitRate: number } {
		const total = this.hits + this.misses;
		return {
			size: this.map.size,
			hits: this.hits,
			misses: this.misses,
			hitRate: total === 0 ? 0 : this.hits / total,
		};
	}

	clear(): void {
		this.map.clear();
		this.hits = 0;
		this.misses = 0;
		this.dirty = true;
		if (this.file) {
			// Immediate persist of the empty state.
			this.persistNow();
		}
	}

	dispose(): void {
		if (this.persistTimer) clearTimeout(this.persistTimer);
		if (this.dirty) this.persistNow();
	}

	private schedulePersist(): void {
		if (this.persistTimer) return;
		this.persistTimer = setTimeout(
			() => {
				this.persistTimer = null;
				this.persistNow();
			},
			10_000,
		);
		// Do not hold the event loop open for cache persistence.
		this.persistTimer.unref?.();
	}

	private persistNow(): void {
		if (!this.file) return;
		this.dirty = false;
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			const tmp = join(dirname(this.file), `.pot-cache.${process.pid}.tmp`);
			writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)), "utf8");
			renameSync(tmp, this.file);
		} catch {
			/* best effort */
		}
	}
}
