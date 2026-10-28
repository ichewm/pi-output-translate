/**
 * r12 smoke: boot the NEW code against a COPY of the real journals and dump
 * /api/history — verifies topic extraction, empty filtering and group
 * disambiguation on real-world data. Never touches the live agent dir.
 */
import { mkdtempSync, cpSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = mkdtempSync(join(tmpdir(), "pot-r12-smoke-"));
process.env.PI_AGENT_DIR = agentDir;

const { AppServer } = await import("../src/server.ts");
const { Hub } = await import("../src/hub.ts");
const { defaultConfig } = await import("../src/config.ts");

// copy the REAL journals in (read-only usage; originals untouched)
cpSync(
	join(process.env.HOME!, ".pi/agent/output-translate/history"),
	join(agentDir, "output-translate", "history"),
	{ recursive: true },
);
// copy pi's own session store too — r12c topic/cwd recovery reads it
cpSync(join(process.env.HOME!, ".pi/agent/sessions"), join(agentDir, "sessions"), { recursive: true });
// fake one live session to verify the `live` array
mkdirSync(join(agentDir, "sessions"), { recursive: true });

class NullEngine {
	id = "mock";
	async complete() {
		return "ok";
	}
	async healthCheck() {
		return true;
	}
}

const cfg = defaultConfig();
const hub = new Hub({ getConfig: () => cfg, engineFactory: () => new NullEngine() });
hub.start();
hub.registerSession({ id: "01a180a3-b0c4-7051-a794-72aa88d88741", name: "live", cwd: "/nowhere" }, false);
const server = new AppServer({ hub, token: "smoke" });
await server.listen(0);
const addr = server.server.address();
if (addr === null || typeof addr === "string") throw new Error("no port");
const port = addr.port;

const r = await fetch(`http://127.0.0.1:${port}/api/history?token=smoke`);
const data = (await r.json()) as {
	sessions: { sessionId: string; bytes: number }[];
	groups: { cwd: string; name: string; sessions: { sessionId: string; bytes: number; topic: string | null }[] }[];
	live: string[];
};
console.log("HTTP", r.status, "| sessions:", data.sessions.length, "| live:", JSON.stringify(data.live));
for (const g of data.groups) {
	console.log(`\n📁 ${g.name}  (${g.sessions.length} 条)  cwd=${g.cwd}`);
	for (const s of g.sessions.slice(0, 4)) {
		console.log(`   ${(s.sessionId + "        ").slice(0, 9)} topic=${JSON.stringify(s.topic)}`);
	}
	if (g.sessions.length > 4) console.log(`   … +${g.sessions.length - 4} more`);
}
const empty = data.sessions.filter((s) => s.bytes === 0);
console.log("\n空 journal 出现数(应为0):", empty.length);
const unknown = data.groups.filter((g) => g.cwd === "");
console.log("未知项目组(应为0):", unknown.length, unknown.length ? "→" + unknown[0].sessions.length + "条" : "");
const withTopic = data.groups.flatMap((g) => g.sessions).filter((s) => s.topic);
console.log(`topic 覆盖: ${withTopic.length}/${data.sessions.length}`);

// topic extraction sanity on the real busy session
const busy = data.groups.flatMap((g) => g.sessions).find((s) => s.bytes > 500000);
console.log("最大会话 topic:", JSON.stringify(busy?.topic ?? null), "| in live set:", data.live.includes(busy?.sessionId ?? ""));

await server.close();
await hub.dispose();
rmSync(agentDir, { recursive: true, force: true });
process.exit(0);
