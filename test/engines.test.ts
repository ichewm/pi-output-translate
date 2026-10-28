import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OllamaEngine } from "../src/engines/ollama.ts";
import { OpenAiCompatEngine } from "../src/engines/openai-compat.ts";
import { PiModelEngine } from "../src/engines/pi-model.ts";

const realFetch = globalThis.fetch;
let calls: { url: string; init: RequestInit }[] = [];
let responder: ((url: string, init: RequestInit) => { status: number; body: unknown }) | null = null;

function mockFetch() {
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, init: init ?? {} });
		const r = responder!(url, init ?? {});
		return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
			status: r.status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

beforeEach(() => {
	calls = [];
	responder = null;
	mockFetch();
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("OllamaEngine", () => {
	it("posts /api/chat with think:false and unwraps message.content", async () => {
		responder = () => ({ status: 200, body: { message: { content: "译文" } } });
		const e = new OllamaEngine({ baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", temperature: 0.1, timeoutMs: 5000 });
		const out = await e.complete("sys", "usr", AbortSignal.timeout(4000));
		expect(out).toBe("译文");
		const body = JSON.parse(String(calls[0].init.body));
		expect(body.think).toBe(false);
		expect(body.stream).toBe(false);
		expect(body.messages).toHaveLength(2);
		expect(calls[0].url).toBe("http://127.0.0.1:11434/api/chat");
	});

	it("empty content throws", async () => {
		responder = () => ({ status: 200, body: { message: { content: "" } } });
		const e = new OllamaEngine({ baseUrl: "http://x", model: "m", temperature: 0, timeoutMs: 1000 });
		await expect(e.complete("s", "u", AbortSignal.timeout(500))).rejects.toThrow(/empty/);
	});

	it("healthCheck hits /api/version", async () => {
		responder = (url) => (url.includes("/api/version") ? { status: 200, body: { version: "1" } } : { status: 500, body: {} });
		const e = new OllamaEngine({ baseUrl: "http://x", model: "m", temperature: 0, timeoutMs: 1000 });
		expect(await e.healthCheck()).toBe(true);
	});

	it("listModels returns tag names", async () => {
		responder = () => ({ status: 200, body: { models: [{ name: "qwen3:8b" }, { name: "llama3:70b" }] } });
		const e = new OllamaEngine({ baseUrl: "http://x", model: "m", temperature: 0, timeoutMs: 1000 });
		expect(await e.listModels()).toEqual(["qwen3:8b", "llama3:70b"]);
	});
});

describe("OpenAiCompatEngine", () => {
	it("posts /v1/chat/completions with bearer auth", async () => {
		responder = () => ({ status: 200, body: { choices: [{ message: { content: "你好" } }] } });
		const e = new OpenAiCompatEngine({ baseUrl: "http://127.0.0.1:8081", model: "qwen", temperature: 0.1, timeoutMs: 5000, apiKey: "sk-x" });
		const out = await e.complete("s", "u", AbortSignal.timeout(4000));
		expect(out).toBe("你好");
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
		expect(calls[0].url).toBe("http://127.0.0.1:8081/v1/chat/completions");
	});

	it("resolves versioned baseUrls (智谱 /api/paas/v4) and full endpoints (round 12)", async () => {
		responder = () => ({ status: 200, body: { choices: [{ message: { content: "你好" } }] } });
		// 智谱 bigmodel: versioned path -> append chat/completions directly
		const zhipu = new OpenAiCompatEngine({ baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4-flash", temperature: 0.1, timeoutMs: 5000, apiKey: "k" });
		await zhipu.complete("s", "u", AbortSignal.timeout(4000));
		expect(calls[0].url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
		// explicit /v1 suffix: no double /v1
		const v1 = new OpenAiCompatEngine({ baseUrl: "http://127.0.0.1:8081/v1", model: "m", temperature: 0, timeoutMs: 1000 });
		await v1.complete("s", "u", AbortSignal.timeout(900));
		expect(calls[1].url).toBe("http://127.0.0.1:8081/v1/chat/completions");
		// full endpoint passthrough
		const full = new OpenAiCompatEngine({ baseUrl: "http://127.0.0.1:8081/custom/chat/completions", model: "m", temperature: 0, timeoutMs: 1000 });
		await full.complete("s", "u", AbortSignal.timeout(900));
		expect(calls[2].url).toBe("http://127.0.0.1:8081/custom/chat/completions");
	});

	it("surfaces HTTP errors with body detail", async () => {
		responder = () => ({ status: 500, body: { error: "boom" } });
		const e = new OpenAiCompatEngine({ baseUrl: "http://x", model: "m", temperature: 0, timeoutMs: 1000 });
		await expect(e.complete("s", "u", AbortSignal.timeout(500))).rejects.toThrow(/500/);
	});
});

describe("PiModelEngine", () => {
	function registry(model = "p/m1") {
		return {
			find: (provider: string, id: string) => (provider + "/" + id === model ? { provider, id } : undefined),
			complete: async () => ({
				content: [
					{ type: "thinking", thinking: "..." },
					{ type: "text", text: "registry 译文" },
				],
			}),
		};
	}

	it("resolves provider/id via registry.find and calls complete with reasoning low", async () => {
		const reg = registry();
		const e = new PiModelEngine({ baseUrl: "", model: "p/m1", temperature: 0.1, timeoutMs: 1000 }, reg, () => "p/m1");
		const out = await e.complete("s", "u", AbortSignal.timeout(500));
		expect(out).toBe("registry 译文");
	});

	it("follow-model resolution reads the dynamic getter", async () => {
		let current = "p/a";
		const reg = {
			find: (provider: string, id: string) => (provider === "p" ? { provider, id } : undefined),
			complete: async () => ({ content: [{ type: "text", text: "ok" }] }),
		};
		const e = new PiModelEngine({ baseUrl: "", model: "", temperature: 0, timeoutMs: 1000 }, reg, () => current);
		await e.complete("s", "u", AbortSignal.timeout(500));
		current = "p/b";
		await e.complete("s", "u", AbortSignal.timeout(500));
	});

	it("a hung registry call is cancelled by the abort signal (round 11: stuck 翻译中)", async () => {
		// registry.complete never settles and (like the real registry API)
		// takes no signal — the engine MUST still let the queue's timeout
		// abort win, or the queue's active batch slot wedges forever
		const reg = {
			find: (provider: string, id: string) => ({ provider, id }),
			complete: () => new Promise<never>(() => {}),
		};
		const e = new PiModelEngine({ baseUrl: "", model: "p/hung", temperature: 0, timeoutMs: 60_000 }, reg, () => "p/hung");
		const t0 = Date.now();
		await expect(e.complete("s", "u", AbortSignal.timeout(40))).rejects.toThrow("cancelled");
		expect(Date.now() - t0).toBeLessThan(2_000);
	});

	it("unknown model fails healthCheck and complete", async () => {
		const reg = {
			find: () => undefined,
			complete: async () => ({ content: [] }),
		};
		const e = new PiModelEngine({ baseUrl: "", model: "nope/none", temperature: 0, timeoutMs: 1000 }, reg, () => undefined);
		expect(await e.healthCheck()).toBe(false);
		await expect(e.complete("s", "u", AbortSignal.timeout(500))).rejects.toThrow(/not found/);
	});
});

describe("withTimeout (via engine)", () => {
	it("aborts long calls with a timeout error", async () => {
		globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal) {
					signal.addEventListener(
					"abort",
					() => {
						const reason = (signal as AbortSignal).reason;
						reject(reason instanceof Error ? reason : new Error(String(reason ?? "aborted")));
					},
					{ once: true },
				);
				}
			})) as typeof fetch;
		const e = new OllamaEngine({ baseUrl: "http://x", model: "m", temperature: 0, timeoutMs: 50 });
		await expect(e.complete("s", "u", AbortSignal.timeout(5000))).rejects.toThrow(/timeout/);
	});
});
