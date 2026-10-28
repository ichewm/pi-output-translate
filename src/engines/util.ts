/**
 * Shared helpers for chat-completion engines (ollama / openai-compat).
 */

/**
 * Hard timeout that fires NO MATTER WHAT the underlying promise does with
 * the abort signal (a wrapped fetch that ignores signals would otherwise
 * hang forever — found in audit round 14).
 */
export function raceTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`engine timeout after ${timeoutMs}ms`)), timeoutMs);
		p.then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
		);
	});
}

/** Combine an external abort signal with a timeout into one controller. */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortController {
	const ctrl = new AbortController();
	const abort = (reason: string) => ctrl.abort(new Error(reason));
	if (signal?.aborted) {
		ctrl.abort(new Error("cancelled"));
		return ctrl;
	}
	signal?.addEventListener(
		"abort",
		() => ctrl.abort(new Error("cancelled")),
		{ once: true },
	);
	const timer = setTimeout(() => abort(`engine timeout after ${timeoutMs}ms`), timeoutMs);
	ctrl.signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
		},
		{ once: true },
	);
	return ctrl;
}

/** Parse a numbered-block batch answer into `count` blocks; null when
 * malformed (missing/empty/extra blocks).
 *
 * Markers must be "[n]" ALONE on their line AND appear in strict 1,2,3…
 * order (audit round 3: a block whose content starts with "[2]" used to be
 * mistaken for the next marker and the batch was discarded). Same-line
 * content after a marker is rejected on purpose — a multi-block answer that
 * breaks this shape falls back to per-item plain-mode retries. */
export function parseBlocks(answer: string, count: number): string[] | null {
	const markers = new Map<number, string[]>();
	let current: string[] | null = null;
	let expect = 1;
	for (const line of answer.split("\n")) {
		const m = line.match(/^\[(\d{1,3})\][ \t]*$/);
		if (m && Number(m[1]) === expect) {
			const n = Number(m[1]);
			markers.set(n, []);
			current = markers.get(n)!;
			expect = n + 1;
			continue;
		}
		if (current) current.push(line);
	}
	if (markers.size !== count) return null;
	const out: string[] = [];
	for (let i = 1; i <= count; i++) {
		const lines = markers.get(i);
		if (!lines) return null;
		const text = lines.join("\n").trim();
		if (text === "") return null; // empty translation -> malformed
		out.push(text);
	}
	return out;
}

/** Extract readable error text from a failed fetch response. */
export async function httpError(prefix: string, res: Response): Promise<Error> {
	let detail = "";
	try {
		const body = (await res.text()) as string;
		detail = body.slice(0, 300);
	} catch {
		/* ignore */
	}
	return new Error(`${prefix}: HTTP ${res.status} ${detail}`.trim());
}
