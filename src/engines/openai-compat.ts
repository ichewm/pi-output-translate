/**
 * OpenAI-compatible engine — chat/completions (llama.cpp server, LM
 * Studio, vLLM, and any compatible local or remote endpoint, including
 * vendors whose OpenAI-compatible API lives under a versioned path such
 * as 智谱's /api/paas/v4).
 */

import { raceTimeout, withTimeout, httpError } from "./util.ts";
import type { TranslateEngine } from "../types.ts";
import type { EngineOptions } from "./ollama.ts";

export class OpenAiCompatEngine implements TranslateEngine {
	readonly id = "openai-compat";
	private readonly o: EngineOptions;

	constructor(opts: EngineOptions) {
		this.o = opts;
	}

	private headers(): Record<string, string> {
		const h: Record<string, string> = { "Content-Type": "application/json" };
		if (this.o.apiKey) h.Authorization = `Bearer ${this.o.apiKey}`;
		return h;
	}

	/** Resolve the request URL: a baseUrl that already ends with
	 * /chat/completions is used verbatim; one ending in a version segment
	 * (/v1, /v4, …) gets "chat/completions" appended (智谱 bigmodel
	 * /api/paas/v4); a bare host gets the conventional /v1 path. Built by
	 * string concat — relative URL resolution against a path without a
	 * trailing slash REPLACES the last segment (v4 vanished in tests). */
	private endpoint(path: "chat/completions" | "models"): URL {
		const u = new URL(this.o.baseUrl);
		if (path === "chat/completions" && /\/chat\/completions\/?$/.test(u.pathname)) return u;
		const base = this.o.baseUrl.replace(/\/+$/, "");
		if (/\/v\d+$/.test(u.pathname)) return new URL(`${base}/${path}`);
		return new URL(`${base}/v1/${path}`);
	}

	async complete(system: string, user: string, signal: AbortSignal, timeoutMs?: number): Promise<string> {
		// A batch caller may grant a longer deadline than the per-call default:
		// batch generation time scales with segment count, and a fixed cap used
		// to guarantee timeouts for multi-segment batches on slower engines.
		const cap = timeoutMs ?? this.o.timeoutMs;
		const ctrl = withTimeout(signal, cap);
		const res = await raceTimeout(fetch(this.endpoint("chat/completions"), {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify({
				model: this.o.model,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				temperature: this.o.temperature,
				stream: false,
			}),
			signal: ctrl.signal,
		}), cap);
		if (!res.ok) throw await httpError("openai-compat chat/completions", res);
		const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		const text = json.choices?.[0]?.message?.content ?? "";
		if (text.trim() === "") throw new Error("openai-compat returned empty content");
		return text;
	}

	async healthCheck(): Promise<boolean> {
		const ctrl = withTimeout(undefined, 5000);
		try {
			const res = await fetch(this.endpoint("models"), {
				headers: this.headers(),
				signal: ctrl.signal,
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	async listModels(): Promise<string[]> {
		const ctrl = withTimeout(undefined, 5000);
		try {
			const res = await fetch(this.endpoint("models"), {
				headers: this.headers(),
				signal: ctrl.signal,
			});
			if (!res.ok) return [];
			const json = (await res.json()) as { data?: { id: string }[] };
			return (json.data ?? []).map((m) => m.id);
		} catch {
			return [];
		}
	}
}
