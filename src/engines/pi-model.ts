/**
 * pi-model engine — reuse a model already configured in Pi's registry via
 * ctx.modelRegistry.completeSimple. Zero history / zero tools / reasoning
 * "low": an isolated request per call.
 *
 * Selected explicitly by config only: by default the host uses direct local
 * engines (ollama / openai-compat) so translation never competes with the
 * main model's provider rate limits.
 */

import type { TranslateEngine } from "../types.ts";
import type { EngineOptions } from "./ollama.ts";

/** Minimal structural types so tests can pass a plain object. */
export interface RegistryLike {
	find(provider: string, modelId: string): { provider: string; id: string } | undefined;
	complete(
		model: unknown,
		context: {
			systemPrompt?: string;
			messages: { role: "user"; content: string; timestamp: number }[];
		},
		options?: { reasoning?: string },
	): Promise<{ content: { type: string; text?: string }[]; errorMessage?: string }>;
}

export class PiModelEngine implements TranslateEngine {
	readonly id = "pi-model";
	private readonly o: EngineOptions;
	private readonly registry: RegistryLike;
	/** Returns the model to use ("provider/id"), resolved lazily per call. */
	private readonly resolveModel: () => string | undefined;

	constructor(
		opts: EngineOptions,
		registry: RegistryLike,
		resolveModel: () => string | undefined,
	) {
		this.o = opts;
		this.registry = registry;
		this.resolveModel = resolveModel;
	}

	private lookupModel(): { provider: string; id: string } {
		const pid = this.resolveModel() ?? this.o.model;
		if (!pid || !pid.includes("/")) throw new Error(`pi-model: invalid model id "${pid}"`);
		const [provider, id] = pid.split("/");
		const model = this.registry.find(provider, id);
		if (!model) throw new Error(`pi-model: model not found in registry: ${pid}`);
		return model;
	}

	async complete(system: string, user: string, signal: AbortSignal, _timeoutMs?: number): Promise<string> {
		// _timeoutMs: batch callers may grant a longer deadline; the registry
		// API exposes no timeout knob, so the queue-level signal governs.
		if (signal.aborted) throw new Error("cancelled");
		const model = this.lookupModel();
		const call = this.registry.complete(
			model,
			{
				systemPrompt: system,
				messages: [{ role: "user", content: user, timestamp: Date.now() }],
			},
			{ reasoning: "low" },
		);
		// The registry API takes no abort signal, so a hung provider stream
		// used to wedge the queue's active batch slot forever: the queue's
		// AbortSignal fired, this engine ignored it, pendingCount() never
		// returned to zero (topbar stuck at "N 篇翻译中") and concurrency-1
		// queues deadlocked behind the stuck call. Race the call against the
		// signal; the loser's (late) result is discarded — at worst one
		// orphaned request, never a wedged queue (field report round 11).
		call.catch(() => {}); // never surfaces as unhandled after losing the race
		const guard = new Promise<never>((_, reject) => {
			signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
		});
		const msg = await Promise.race([call, guard]);
		if (msg.errorMessage) throw new Error(`pi-model: ${msg.errorMessage}`);
		const text = (msg.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
		if (text.trim() === "") throw new Error("pi-model returned empty content");
		return text;
	}

	async healthCheck(): Promise<boolean> {
		try {
			this.lookupModel();
			return true;
		} catch {
			return false;
		}
	}
}
