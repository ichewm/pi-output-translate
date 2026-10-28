/**
 * Ollama engine — native /api/chat endpoint, think:false (a small local
 * qwen3 answers in ~3s vs ~17s with thinking), stream:false.
 */

import { raceTimeout, withTimeout, httpError, parseBlocks } from "./util.ts";
import type { TranslateEngine } from "../types.ts";

export { parseBlocks };

export interface EngineOptions {
	baseUrl: string;
	model: string;
	temperature: number;
	timeoutMs: number;
	apiKey?: string;
}

export class OllamaEngine implements TranslateEngine {
	readonly id = "ollama";
	private readonly o: EngineOptions;

	constructor(opts: EngineOptions) {
		this.o = opts;
	}

	async complete(system: string, user: string, signal: AbortSignal, timeoutMs?: number): Promise<string> {
		const cap = timeoutMs ?? this.o.timeoutMs;
		const ctrl = withTimeout(signal, cap);
		const res = await raceTimeout(fetch(new URL("/api/chat", this.o.baseUrl), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: this.o.model,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				stream: false,
				think: false,
				options: { temperature: this.o.temperature },
			}),
			signal: ctrl.signal,
		}), cap);
		if (!res.ok) throw await httpError("ollama /api/chat", res);
		const json = (await res.json()) as { message?: { content?: string } };
		const text = json.message?.content ?? "";
		if (text.trim() === "") throw new Error("ollama returned empty content");
		return text;
	}

	async healthCheck(): Promise<boolean> {
		const ctrl = withTimeout(undefined, 3000);
		try {
			const res = await fetch(new URL("/api/version", this.o.baseUrl), { signal: ctrl.signal });
			return res.ok;
		} catch {
			return false;
		}
	}

	async listModels(): Promise<string[]> {
		const ctrl = withTimeout(undefined, 5000);
		const res = await fetch(new URL("/api/tags", this.o.baseUrl), { signal: ctrl.signal });
		if (!res.ok) return [];
		const json = (await res.json()) as { models?: { name: string }[] };
		return (json.models ?? []).map((m) => m.name);
	}
}
