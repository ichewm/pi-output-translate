/**
 * pi-output-translate — display-only live Chinese translation companion.
 *
 * Wiring only: pi events -> Collector -> (host hub | client uplink). All
 * behavior lives in the modules; this file must stay glue-thin.
 *
 * Commands: /pot [open|on|off|thinking|tools|engine|model|lang|glossary|
 *                cache|retry-failed|status|stop]
 * Shortcut: ctrl+alt+p (and ctrl+super+p twin) toggles the extension.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";


import { spawn } from "node:child_process";
import { basename } from "node:path";
import {
	loadConfig,
	saveConfig,
	ensureConfigFile,
	configPath,
	tokenPath,
	type OutputTranslateConfig,
} from "./config.ts";
import { Collector } from "./collector.ts";
import { RoleManager } from "./role.ts";
import { Hub } from "./hub.ts";
import type { EngineFactory } from "./hub.ts";
import type { SessionInfo, TranslateEngine } from "./types.ts";
import { OllamaEngine } from "./engines/ollama.ts";
import { OpenAiCompatEngine } from "./engines/openai-compat.ts";
import { PiModelEngine } from "./engines/pi-model.ts";

export default function (pi: ExtensionAPI) {
	ensureConfigFile();

	let sessionId = "pending";
	let sessionModel: string | undefined;
	let collector: Collector | null = null;
	let starting = false;
	let startedOnce = false;

	function currentSessionInfo(): SessionInfo {
		const cwd = process.cwd();
		return {
			id: sessionId,
			name: basename(cwd) || cwd,
			cwd,
			model: sessionModel,
			local: true,
		};
	}

	const engineFactory: EngineFactory = (cfg): TranslateEngine => {
		if (cfg.translate.engine === "openai-compat") {
			return new OpenAiCompatEngine({
				baseUrl: cfg.translate.baseUrl,
				model: cfg.translate.model,
				temperature: cfg.translate.temperature,
				timeoutMs: cfg.translate.timeoutSeconds * 1000,
				apiKey: cfg.translate.apiKey || undefined,
			});
		}
		if (cfg.translate.engine === "pi-model") {
			return new PiModelEngine(
				{
					baseUrl: "",
					model: cfg.translate.piModelId,
					temperature: cfg.translate.temperature,
					timeoutMs: cfg.translate.timeoutSeconds * 1000,
				},
				piModelRegistry!,
				() => cfg.translate.piModelId || sessionModel,
			);
		}
		return new OllamaEngine({
			baseUrl: cfg.translate.baseUrl,
			model: cfg.translate.model,
			temperature: cfg.translate.temperature,
			timeoutMs: cfg.translate.timeoutSeconds * 1000,
		});
	};

	// pi-model registry captured on first session_start.
	let piModelRegistry: ExtensionContext["modelRegistry"] | null = null;

	const role = new RoleManager({
		getConfig: loadConfig,
		engineFactory,
		sessionInfo: currentSessionInfo,
		onHostActive: (hub: Hub) => {
			// Route collector events into our own hub.
			collector = new Collector({
				getSessionId: () => sessionId,
				publish: (ev) => hub.publish(ev),
				getConfig: loadConfig,
			});
			if (uiNotify) {
				uiStatus(`host :${role.port}`);
			}
		},
		onHostInactive: () => {
			collector = new Collector({
				getSessionId: () => sessionId,
				publish: (ev) => role.publishClient(ev),
				getConfig: loadConfig,
			});
		},
		notify: (msg, level) => uiNotify?.(msg, level),
	});

	// Lazily-created UI adapter (guards RPC/JSON/print modes).
	let uiNotify: ((msg: string, level: "info" | "warning" | "error") => void) | null = null;
	function uiStatus(text: string): void {
		try {
			currentCtx?.ui.setStatus("pot", text);
		} catch {
			/* ignore */
		}
	}
	let currentCtx: ExtensionContext | null = null;

	async function startRole(): Promise<void> {
		if (starting) return;
		starting = true;
		try {
			await role.start();
			startedOnce = true;
			if (role.state === "host") {
				uiStatus(`host :${role.port}`);
				if (currentCtx?.hasUI) {
					uiNotify?.(
						`pi-output-translate: host on http://127.0.0.1:${role.port} — /pot to open the reader page`,
						"info",
					);
				}
			} else if (role.state === "client") {
				uiStatus(`client→:${role.port}`);
			} else if (role.state === "disabled") {
				uiStatus("off");
			}
		} finally {
			starting = false;
		}
	}

	// ------------------------------------------------------------------
	// pi events

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		uiNotify = ctx.hasUI ? (msg, level) => {
			try {
				ctx.ui.notify(msg, level);
			} catch {
				/* ignore */
			}
		} : null;
		piModelRegistry = ctx.modelRegistry;
		sessionModel = ctx.model ? `${(ctx.model as { provider: string }).provider}/${(ctx.model as { id: string }).id}` : undefined;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			sessionId = `s-${Date.now().toString(36)}`;
		}
		// Fresh session: fresh collector (bound after role decides host/client).
		if (!collector) {
			collector = new Collector({
				getSessionId: () => sessionId,
				publish: (ev) => {
					// Before role start completes, buffer into client path (no-op
					// until client). Host path replaces the collector on activation.
					role.publishClient(ev);
				},
				getConfig: loadConfig,
			});
		} else {
			collector.reset();
		}
		if (!startedOnce) {
			void startRole().catch((err) => {
				console.warn("[pi-output-translate] role start failed:", err);
			});
		} else if (role.state === "host" || role.state === "client") {
			role.hub?.registerSession(currentSessionInfo(), true);
			role.hub?.heartbeat(sessionId, sessionModel);
		}
	});

	pi.on("model_select", async (event, _ctx) => {
		sessionModel = `${(event.model as { provider: string }).provider}/${(event.model as { id: string }).id}`;
		role.hub?.heartbeat(sessionId, sessionModel);
	});

	// Focus-follow: keypresses only reach the focused terminal window, so
	// terminal input is the focus signal. The web page switches to this
	// session while the user types here, and stays put (manually browsable)
	// while the user is elsewhere.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		try {
			ctx.ui.onTerminalInput((data) => {
				// pi forwards RAW terminal input here; startup handshakes (DA1,
				// DSR replies) and mouse tracking fire constantly and used to
				// burn the focus-report budget before the role was ready. Real
				// keystrokes carry NO control characters; escape sequences
				// always contain ESC (0x1b) — reject any chunk that has one.
				if (/[\x00-\x1f\x7f]/.test(String(data))) return undefined;
				role.reportFocus();
				return undefined;
			});
		} catch {
			/* not available in this mode */
		}
	});

	pi.on("message_start", async (event, _ctx) => {
		collector?.onMessageStart(event as { message: { role?: string; content?: unknown } }, sessionModel);
		return undefined;
	});

	pi.on("message_update", async (event, _ctx) => {
		try {
			const e = event as unknown as {
				assistantMessageEvent: { type: string; contentIndex?: number; delta?: string; partial?: { content?: { type?: string; redacted?: boolean }[] } };
			};
			if (e.assistantMessageEvent.type === "thinking_end") {
				collector?.onThinkingEnd(e.assistantMessageEvent);
			} else {
				collector?.onMessageUpdate(e.assistantMessageEvent);
			}
		} catch {
			/* never surface */
		}
		return undefined;
	});

	pi.on("message_end", async (event, _ctx) => {
		collector?.onMessageEnd(event as { message: { role?: string; stopReason?: string } });
		return undefined;
	});

	pi.on("tool_execution_start", async (event, _ctx) => {
		if (event.parentToolCallId) return undefined;
		collector?.onToolStart(event);
		return undefined;
	});

	pi.on("tool_execution_end", async (event, _ctx) => {
		if (event.parentToolCallId) return undefined;
		collector?.onToolEnd(event);
		return undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			await role.stop();
		} catch {
			/* idempotent cleanup */
		}
		collector = null;
		startedOnce = false;
		try {
			ctx.ui.setStatus("pot", undefined);
		} catch {
			/* ignore */
		}
		currentCtx = null;
		uiNotify = null;
	});

	// ------------------------------------------------------------------
	// shortcut: ctrl+alt+p / ctrl+super+p toggle

	function toggleExtension(): void {
		const cfg = loadConfig();
		cfg.enabled = !cfg.enabled;
		saveConfig(cfg);
		role.hub?.publish({ t: "cfg", cfg });
		uiNotify?.(`pi-output-translate: ${cfg.enabled ? "ON" : "OFF"}`, "info");
	}
	try {
		pi.registerShortcut("ctrl+alt+p" as never, {
			description: "pi-output-translate: toggle translation",
			handler: () => toggleExtension(),
		});
		pi.registerShortcut("ctrl+super+p" as never, {
			description: "pi-output-translate: toggle translation (super twin)",
			handler: () => toggleExtension(),
		});
	} catch {
		/* shortcut registration is best-effort */
	}

	// ------------------------------------------------------------------
	// command: /pot

	try {
	pi.registerCommand("pot", {
		description:
			"pi-output-translate: open the reader page / status / configure (open|on|off|thinking|tools|engine|model|lang|glossary|cache|retry-failed|stop)",
		handler: async (args: string, ctx) => {
			// filter(Boolean): "" .split(/\s+/) yields [""], which would defeat
			// the "open" default below — bare /pot must open the page.
			const [sub = "open", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const cfg = loadConfig();
			const say = (msg: string) => {
				if (ctx.hasUI) ctx.ui.notify(msg, "info");
			};

			switch (sub) {
				case "open": {
					if (role.state === "none" && !startedOnce) await startRole();
					const url = role.url();
					if (!url) {
						say("pi-output-translate: not running (disabled?). Check /pot status.");
						return;
					}
					openBrowser(url);
					say(url);
					return;
				}
				case "on":
				case "off": {
					cfg.enabled = sub === "on";
					saveConfig(cfg);
					role.hub?.publish({ t: "cfg", cfg });
					say(`pi-output-translate ${sub}`);
					if (sub === "on" && role.state === "none") await startRole();
					return;
				}
				case "thinking": {
					const v = rest[0];
					if (v !== "on" && v !== "off") {
						say(`thinking is ${cfg.sources.thinking ? "on" : "off"} — /pot thinking on|off`);
						return;
					}
					cfg.sources.thinking = v === "on";
					saveConfig(cfg);
					role.hub?.publish({ t: "cfg", cfg });
					say(`thinking translation ${v}`);
					return;
				}
				case "tools": {
					const v = rest[0];
					if (v !== "on" && v !== "off") {
						say(`tool lines are ${cfg.sources.toolLines ? "on" : "off"} — /pot tools on|off`);
						return;
					}
					cfg.sources.toolLines = v === "on";
					saveConfig(cfg);
					role.hub?.publish({ t: "cfg", cfg });
					say(`tool lines ${v}`);
					return;
				}
				case "engine": {
					const v = rest[0];
					if (!v || !["ollama", "openai-compat", "pi-model"].includes(v)) {
						say(`engine=${cfg.translate.engine} — /pot engine ollama|openai-compat|pi-model`);
						return;
					}
					cfg.translate.engine = v as OutputTranslateConfig["translate"]["engine"];
					saveConfig(cfg);
					role.hub?.applyConfig(cfg);
					say(`engine=${v}`);
					return;
				}
				case "model": {
					const v = rest[0];
					if (!v) {
						say(`model=${cfg.translate.model}`);
						return;
					}
					cfg.translate.model = v;
					saveConfig(cfg);
					role.hub?.applyConfig(cfg);
					say(`model=${v}`);
					return;
				}
				case "lang": {
					const v = rest[0];
					if (!v) {
						say(`targetLang=${cfg.translate.targetLang}`);
						return;
					}
					cfg.translate.targetLang = v;
					saveConfig(cfg);
					say(`targetLang=${v}`);
					return;
				}
				case "glossary": {
					const [action, ...kv] = rest;
					if (action === "list") {
						const entries = Object.entries(cfg.glossary);
						say(entries.length ? entries.map(([k, v]) => `${k} → ${v}`).join("\n") : "user glossary empty");
						return;
					}
					if (action === "add") {
						const pair = kv.join(" ").split("=");
						if (pair.length !== 2 || !pair[0].trim() || !pair[1].trim()) {
							say('usage: /pot glossary add "english=中文"');
							return;
						}
						cfg.glossary[pair[0].trim()] = pair[1].trim();
						saveConfig(cfg);
						say(`glossary: ${pair[0].trim()} → ${pair[1].trim()}`);
						return;
					}
					if (action === "del") {
						const key = kv.join(" ").trim();
						if (!(key in cfg.glossary)) {
							say(`no user entry for "${key}"`);
							return;
						}
						delete cfg.glossary[key];
						saveConfig(cfg);
						say(`removed ${key}`);
						return;
					}
					say("usage: /pot glossary list | add k=v | del k");
					return;
				}
				case "cache": {
					const action = rest[0];
					if (action === "clear") {
						role.hub?.clearCache();
						say("cache cleared");
						return;
					}
					if (action === "stats" || action === undefined) {
						say(JSON.stringify(role.hub?.cacheStats() ?? { size: 0 }));
						return;
					}
					say("usage: /pot cache clear|stats");
					return;
				}
				case "retry-failed": {
					const n = role.hub?.retryFailed(sessionId) ?? 0;
					say(`retried ${n} failed segment(s)`);
					return;
				}
				case "status": {
					const lines = [
						`state: ${role.state}${role.port ? ` (port ${role.port})` : ""}`,
						`role: ${role.state === "host" ? "host (translation runs here)" : role.state}`,
						`engine: ${cfg.translate.engine} · model=${cfg.translate.model} · ${cfg.translate.baseUrl}`,
						`sources: text=${cfg.sources.assistantText} thinking=${cfg.sources.thinking} tools=${cfg.sources.toolLines}`,
						`sessions: ${role.hub?.listSessions().length ?? 0}`,
						`queue: ${role.hub?.queueDepth() ?? 0} pending`,
						`config: ${configPath()}`,
						`token: ${tokenPath(cfg)}`,
					];
					const url = role.url();
					if (url) lines.push(`page: ${url}`);
					say(lines.join("\n"));
					return;
				}
				case "stop": {
					await role.stop();
					startedOnce = false;
					uiStatus("off");
					say("pi-output-translate stopped (/pot on to restart)");
					return;
				}
				case "test": {
					if (!role.hub) {
						say("not the host process — run /pot test on the host window");
						return;
					}
					const r = await role.hub.testTranslate(
						"The build failed due to a race condition between the cache loader and the config watcher.",
					);
					say(r.ok ? `✅ ${r.output}` : `❌ ${r.error}`);
					return;
				}
				default:
					say("usage: /pot open|on|off|thinking|tools|engine|model|lang|glossary|cache|retry-failed|test|status|stop");
			}
		},
	});
	} catch (err) {
		console.warn("[pi-output-translate] registerCommand failed:", err);
	}
}

function openBrowser(url: string): void {
	const cmd =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: ["xdg-open", url];
	try {
		const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: "ignore" });
		child.once("error", () => {});
		child.unref();
	} catch {
		/* ignore */
	}
}
