/**
 * Configuration for pi-output-translate.
 *
 * File: ~/.pi/agent/output-translate.json
 *
 * - Reads with defaults deep-merged so a missing/partial file never crashes.
 * - Caches by mtime: every get() re-reads only when the file changed, so the
 *   web settings page and /pot commands hot-apply without /reload.
 * - save() writes atomically (tmp file + rename) because both the host
 *   process and (via POST /api/config) only the host write it, but readers
 *   in client processes may stat it concurrently.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface OutputTranslateConfig {
	enabled: boolean;
	server: {
		port: number;
		host: string;
		autoOpen: boolean;
		tokenFile: string;
	};
	sources: {
		assistantText: boolean;
		thinking: boolean;
		userMessage: boolean;
		toolLines: boolean;
	};
	translate: {
		engine: "ollama" | "openai-compat" | "pi-model";
		baseUrl: string;
		apiKey: string;
		model: string;
		/** pi-model engine: "provider/model-id"; empty = follow session model. */
		piModelId: string;
		targetLang: string;
		temperature: number;
		concurrency: number;
		timeoutSeconds: number;
		maxSegmentChars: number;
		minEnglishChars: number;
		contextSegments: number;
		batchWindowMs: number;
		batchSize: number;
		/** Character budget per batch request (source text only): keeps the
		 * full prompt inside small local-model context windows (ollama's
		 * default num_ctx is 4096 — a 4×1200-char batch plus glossary used to
		 * overflow it silently). */
		maxBatchChars: number;
		codeComments: "off" | "below";
	};
	glossary: Record<string, string>;
	queue: {
		maxPending: number;
	};
	cache: {
		persist: boolean;
		maxEntries: number;
	};
	journal: {
		dir: string;
		maxFileMb: number;
		maxFiles: number;
	};
	display: {
		defaultShowOriginal: boolean;
		autoScroll: boolean;
		thinkingCollapsed: boolean;
	};
	idle: {
		/** When no viewer is connected: "none" = stop translating, "text-only" = keep translating text. */
		noViewerBehavior: "none" | "text-only" | "full";
	};
}

export function agentDir(): string {
	return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export function configPath(): string {
	return join(agentDir(), "output-translate.json");
}

export function tokenPath(cfg?: OutputTranslateConfig): string {
	const raw = cfg?.server.tokenFile ?? "";
	return raw ? expandTilde(raw) : join(agentDir(), "output-translate.token");
}

export function journalDir(cfg?: OutputTranslateConfig): string {
	const raw = cfg?.journal.dir ?? "";
	return raw ? expandTilde(raw) : join(agentDir(), "output-translate", "history");
}

export function defaultConfig(): OutputTranslateConfig {
	return {
		enabled: true,
		server: {
			port: 7330,
			host: "127.0.0.1",
			autoOpen: false,
			tokenFile: "",
		},
		sources: {
			assistantText: true,
			thinking: true,
			userMessage: true,
			toolLines: true,
		},
		translate: {
			engine: "ollama",
			baseUrl: "http://127.0.0.1:11434",
			apiKey: "",
			model: "qwen3:8b",
			piModelId: "",
			targetLang: "zh-Hans",
			temperature: 0.1,
			concurrency: 1,
			timeoutSeconds: 45,
			maxSegmentChars: 1200,
			minEnglishChars: 40,
			contextSegments: 2,
			batchWindowMs: 300,
			batchSize: 4,
			maxBatchChars: 2400,
			codeComments: "off",
		},
		glossary: {},
		queue: {
			maxPending: 300,
		},
		cache: {
			persist: true,
			maxEntries: 2000,
		},
		journal: {
			dir: "",
			maxFileMb: 2,
			maxFiles: 20,
		},
		display: {
			defaultShowOriginal: false,
			autoScroll: true,
			thinkingCollapsed: true,
		},
		idle: {
			noViewerBehavior: "text-only",
		},
	};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` onto `base`; arrays and scalars from patch win. */
export function deepMerge<T>(base: T, patch: unknown): T {
	if (!isPlainObject(patch)) return base;
	if (!isPlainObject(base)) return patch as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(patch)) {
		if (v === undefined) continue;
		out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
	}
	return out as T;
}

/** Sanitize a config after merge: clamp numbers into sane ranges. */
function sanitize(cfg: OutputTranslateConfig): OutputTranslateConfig {
	const dflt = defaultConfig();
	if (typeof cfg.enabled !== "boolean") cfg.enabled = dflt.enabled;
	for (const k of Object.keys(cfg.sources) as (keyof OutputTranslateConfig["sources"])[]) {
		if (typeof cfg.sources[k] !== "boolean") cfg.sources[k] = dflt.sources[k];
	}
	const t = cfg.translate;
	t.temperature = clampNum(t.temperature, 0, 2, 0.1);
	t.concurrency = Math.round(clampNum(t.concurrency, 1, 2, 1));
	t.timeoutSeconds = Math.round(clampNum(t.timeoutSeconds, 5, 600, 45));
	t.maxSegmentChars = Math.round(clampNum(t.maxSegmentChars, 200, 8000, 1200));
	t.minEnglishChars = Math.round(clampNum(t.minEnglishChars, 0, 5000, 40));
	t.contextSegments = Math.round(clampNum(t.contextSegments, 0, 6, 2));
	t.batchWindowMs = Math.round(clampNum(t.batchWindowMs, 50, 5000, 300));
	t.batchSize = Math.round(clampNum(t.batchSize, 1, 16, 4));
	t.maxBatchChars = Math.round(clampNum(t.maxBatchChars, 400, 32000, 2400));
	cfg.queue.maxPending = Math.round(clampNum(cfg.queue.maxPending, 10, 5000, 300));
	cfg.cache.maxEntries = Math.round(clampNum(cfg.cache.maxEntries, 100, 20000, 2000));
	cfg.journal.maxFileMb = Math.round(clampNum(cfg.journal.maxFileMb, 1, 50, 2));
	cfg.journal.maxFiles = Math.round(clampNum(cfg.journal.maxFiles, 1, 100, 20));
	cfg.server.port = Math.round(clampNum(cfg.server.port, 1024, 65535, 7330));
	if (!["ollama", "openai-compat", "pi-model"].includes(t.engine)) t.engine = "ollama";
	if (!["off", "below"].includes(t.codeComments)) t.codeComments = "off";
	if (!["none", "text-only", "full"].includes(cfg.idle.noViewerBehavior)) cfg.idle.noViewerBehavior = "text-only";
	if (cfg.server.host !== "127.0.0.1" && cfg.server.host !== "localhost") cfg.server.host = "127.0.0.1";
	return cfg;
}

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
	const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
	return Math.min(max, Math.max(min, n));
}

let cached: OutputTranslateConfig | null = null;
let cachedMtime = 0;
let cachedPath = "";

/** Load config with defaults merged; re-reads only when the file mtime changed. */
export function loadConfig(path = configPath()): OutputTranslateConfig {
	if (cached && cachedPath === path) return cached;
	let mtime = 0;
	try {
		mtime = statSync(path).mtimeMs;
	} catch {
		mtime = 0;
	}
	if (cached && cachedMtime === mtime && cachedPath === path) return cached;
	let cfg = defaultConfig();
	if (mtime > 0) {
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
			cfg = sanitize(deepMerge(defaultConfig(), raw));
		} catch (err) {
			// A corrupt file must never take down the extension: keep defaults.
			console.warn(`[pi-output-translate] config parse failed, using defaults: ${(err as Error).message}`);
		}
	}
	cached = cfg;
	cachedMtime = mtime;
	cachedPath = path;
	return cfg;
}

/** Test hook: drop the mtime cache. */
export function resetConfigCache(): void {
	cached = null;
	cachedMtime = 0;
	cachedPath = "";
}

/** Atomically persist the full config and refresh the cache. */
export function saveConfig(cfg: OutputTranslateConfig, path = configPath()): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.output-translate.json.${process.pid}.tmp`);
	writeFileSync(tmp, JSON.stringify(cfg, null, "\t") + "\n", "utf8");
	renameSync(tmp, path);
	cached = cfg;
	try {
		cachedMtime = statSync(path).mtimeMs;
	} catch {
		cachedMtime = 0;
	}
	cachedPath = path;
}

/** The apiKey sentinel shown to the browser instead of the real key. */
export const API_KEY_MASK = "••••";

/** Copy of the config safe to expose to the reader page (apiKey masked). */
export function publicConfig(cfg: OutputTranslateConfig): OutputTranslateConfig {
	const out = JSON.parse(JSON.stringify(cfg)) as OutputTranslateConfig;
	if (out.translate.apiKey) out.translate.apiKey = API_KEY_MASK;
	return out;
}

/** Write the default config file if none exists (first run). Returns true when created. */
export function ensureConfigFile(path = configPath()): boolean {
	if (existsSync(path)) return false;
	saveConfig(defaultConfig(), path);
	return true;
}
