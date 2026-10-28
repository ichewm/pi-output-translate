import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultConfig,
	deepMerge,
	loadConfig,
	saveConfig,
	ensureConfigFile,
	resetConfigCache,
} from "../src/config.ts";
import { mergedGlossary, glossaryToPromptText, TermLock, BUILT_IN_GLOSSARY } from "../src/glossary.ts";

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pot-cfg-"));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("config", () => {
	it("defaults load without a file", () => {
		resetConfigCache();
		const cfg = loadConfig(join(dir, "missing.json"));
		expect(cfg.enabled).toBe(true);
		expect(cfg.translate.engine).toBe("ollama");
		expect(cfg.server.port).toBe(7330);
	});

	it("deep-merges partial files and clamps insane values", () => {
		const path = join(dir, "partial.json");
		writeFileSync(
			path,
			JSON.stringify({
				translate: { model: "qwen3:4b", temperature: 99, concurrency: 50, engine: "bogus" },
				sources: { thinking: false },
			}),
		);
		resetConfigCache();
		const cfg = loadConfig(path);
		expect(cfg.translate.model).toBe("qwen3:4b");
		expect(cfg.translate.temperature).toBe(2); // clamped
		expect(cfg.translate.concurrency).toBe(2); // clamped
		expect(cfg.translate.engine).toBe("ollama"); // invalid rejected
		expect(cfg.sources.thinking).toBe(false);
		expect(cfg.sources.assistantText).toBe(true); // default kept
	});

	it("corrupt file falls back to defaults without throwing", () => {
		const path = join(dir, "corrupt.json");
		writeFileSync(path, "{ not json !!");
		resetConfigCache();
		const cfg = loadConfig(path);
		expect(cfg.enabled).toBe(true);
	});

	it("save is atomic-ish and hot-reloads via mtime", () => {
		const path = join(dir, "hot.json");
		resetConfigCache();
		const cfg = loadConfig(path);
		cfg.translate.model = "changed-model";
		saveConfig(cfg, path);
		resetConfigCache();
		expect(loadConfig(path).translate.model).toBe("changed-model");
	});

	it("ensureConfigFile creates once only", () => {
		const path = join(dir, "ensure.json");
		expect(ensureConfigFile(path)).toBe(true);
		expect(ensureConfigFile(path)).toBe(false);
	});

	it("deepMerge merges nested objects and lets scalars win", () => {
		const base = { a: { b: 1, c: 2 }, d: [1, 2] };
		const out = deepMerge(base, { a: { b: 9 }, d: [3] });
		expect(out).toEqual({ a: { b: 9, c: 2 }, d: [3] });
	});
});

describe("glossary", () => {
	it("user entries override built-ins", () => {
		const merged = mergedGlossary({ "race condition": "用户译法" });
		expect(merged["race condition"]).toBe("用户译法");
		expect(merged.idempotent).toBe(BUILT_IN_GLOSSARY.idempotent);
	});

	it("prompt text renders one arrow per line", () => {
		const text = glossaryToPromptText({ a: "甲", b: "乙" });
		expect(text).toBe("a → 甲\nb → 乙");
	});

	it("TermLock pins first-use translations", () => {
		const tl = new TermLock();
		tl.record("source text", "这里出现了竞态条件（race condition），需要修复。");
		const lines = tl.promptLines();
		expect(lines).toMatch(/race condition → .+竞态条件（race condition）/);
	});
});

describe("agent dir isolation (release blocker r15c)", () => {
	it("respects PI_CODING_AGENT_DIR (pi's documented instance override)", async () => {
		const { agentDir, configPath } = await import("../src/config.ts");
		const prev = process.env.PI_CODING_AGENT_DIR;
		const prevLegacy = process.env.PI_AGENT_DIR;
		try {
			delete process.env.PI_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = "/tmp/pot-iso-agent";
			expect(agentDir()).toBe("/tmp/pot-iso-agent");
			expect(configPath()).toBe("/tmp/pot-iso-agent/output-translate.json");
			delete process.env.PI_CODING_AGENT_DIR;
			// legacy alias still works as fallback
			process.env.PI_AGENT_DIR = "/tmp/pot-iso-legacy";
			expect(agentDir()).toBe("/tmp/pot-iso-legacy");
		} finally {
			process.env.PI_CODING_AGENT_DIR = prev;
			process.env.PI_AGENT_DIR = prevLegacy;
		}
	});
});
