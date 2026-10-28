import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranslateCache } from "../src/cache.ts";
import { Journal } from "../src/journal.ts";

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pot-store-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("TranslateCache", () => {
	it("get/set with LRU eviction", () => {
		const c = new TranslateCache(3, null);
		c.set("a", "1");
		c.set("b", "2");
		c.set("c", "3");
		c.get("a"); // touch a -> b is now oldest
		c.set("d", "4"); // evicts b
		expect(c.get("b")).toBeUndefined();
		expect(c.get("a")).toBe("1");
		expect(c.size()).toBe(3);
	});

	it("tracks hit rate", () => {
		const c = new TranslateCache(10, null);
		c.set("k", "v");
		c.get("k");
		c.get("missing");
		const s = c.stats();
		expect(s.hits).toBe(1);
		expect(s.misses).toBe(1);
		expect(s.hitRate).toBeCloseTo(0.5);
	});

	it("persists to disk and reloads", () => {
		const file = join(dir, "cache.json");
		const c1 = new TranslateCache(10, file);
		c1.set("key1", "value1");
		c1.dispose(); // flush now
		expect(existsSync(file)).toBe(true);
		const c2 = new TranslateCache(10, file);
		expect(c2.get("key1")).toBe("value1");
	});

	it("clear() persists the empty state", () => {
		const file = join(dir, "cache2.json");
		const c = new TranslateCache(10, file);
		c.set("x", "y");
		c.dispose();
		const c2 = new TranslateCache(10, file);
		expect(c2.get("x")).toBe("y");
		c2.clear();
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
		expect(Object.keys(raw)).toHaveLength(0);
	});
});

describe("Journal", () => {
	it("appends records in batches and reads them back", () => {
		const j = new Journal(dir, 2, 20);
		j.append({ ts: 1, s: "sess-a", m: "1", k: "text", id: "seg1", src: "hello", tgt: "你好", st: "done" });
		j.append({ ts: 2, s: "sess-a", m: "1", k: "text", id: "seg2", src: "world", tgt: "世界", st: "done" });
		j.flush();
		const recs = j.read("sess-a");
		expect(recs).toHaveLength(2);
		expect(recs[0].tgt).toBe("你好");
	});

	it("skips corrupt lines on read", () => {
		const j = new Journal(dir, 2, 20);
		j.flush();
		writeFileSync(join(dir, "sess-b.jsonl"), '{"ts":1,"s":"sess-b","m":"1","k":"text","id":"a","src":"x","st":"done"}\nCORRUPT{{{ \n{"ts":2}\n');
		const recs = j.read("sess-b");
		expect(recs).toHaveLength(1);
	});

	it("lists sessions sorted by mtime", () => {
		const j = new Journal(dir, 2, 20);
		const list = j.list();
		expect(list.length).toBeGreaterThanOrEqual(2);
		expect(list[0].sessionId).toBeTruthy();
	});

	it("caps files: keeps only the newest maxFiles", () => {
		const sub = join(dir, "caps");
		const j = new Journal(sub, 2, 3);
		for (let i = 0; i < 6; i++) {
			j.append({ ts: i, s: `cap-${i}`, m: "1", k: "text", id: `s${i}`, src: "x", st: "notrans" });
			j.flush();
		}
		const list = j.list();
		expect(list.length).toBe(3);
		expect(list.map((x) => x.sessionId)).toContain("cap-5");
		expect(list.map((x) => x.sessionId)).not.toContain("cap-0");
	});
});
