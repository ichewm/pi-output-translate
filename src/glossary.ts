/**
 * Built-in EN->ZH glossary for software-engineering prose.
 *
 * Goal: "工程师一眼懂" — use the established mainland Chinese engineering
 * community translation; words without a good translation stay in English.
 * User entries in config.glossary override these.
 */

export const BUILT_IN_GLOSSARY: Record<string, string> = {
	"race condition": "竞态条件",
	idempotent: "幂等",
	idempotency: "幂等性",
	backpressure: "背压",
	boilerplate: "样板代码",
	"side effect": "副作用",
	"side effects": "副作用",
	"dry run": "试运行",
	scaffold: "脚手架",
	scaffolding: "脚手架",
	gotcha: "坑",
	"edge case": "边界情况",
	"corner case": "极端情况",
	"code smell": "代码坏味道",
	"tech debt": "技术债",
	"technical debt": "技术债",
	"best practice": "最佳实践",
	"sanity check": "合理性检查",
	"happy path": "正常路径",
	"fall back": "回退",
	fallback: "回退方案",
	workaround: "临时绕过方案",
	"race through": "快速过一遍",
	"walk through": "走读一遍",
	"under the hood": "底层原理",
	"out of the box": "开箱即用",
	"batteries included": "功能齐全",
	"single source of truth": "唯一事实源",
	"source of truth": "事实源",
	"double-check": "复核",
	"pull request": "Pull Request",
	PR: "PR",
	"code review": "代码评审",
	"breaking change": "破坏性变更",
	"semantic versioning": "语义化版本",
	"cherry-pick": "拣选",
	rebase: "变基",
	"merge conflict": "合并冲突",
	"staging area": "暂存区",
	"dirty state": "未提交状态",
	"clean state": "干净状态",
	"shallow clone": "浅克隆",
	"deep clone": "深克隆",
	"garbage collection": "垃圾回收",
	"reference counting": "引用计数",
	"memory leak": "内存泄漏",
	"dangling pointer": "悬垂指针",
	"off-by-one": "差一错误",
	"null check": "空值检查",
	"defensive programming": "防御式编程",
	"dependency injection": "依赖注入",
	"inversion of control": "控制反转",
	"lazy initialization": "懒初始化",
	"eager loading": "预加载",
	"lazy loading": "懒加载",
	"connection pool": "连接池",
	"graceful shutdown": "优雅关停",
	"circuit breaker": "熔断器",
	"exponential backoff": "指数退避",
	"health check": "健康检查",
	"long polling": "长轮询",
	"server-sent events": "服务器推送事件",
	websocket: "WebSocket",
	"reverse proxy": "反向代理",
	"rate limiting": "限流",
	"load balancing": "负载均衡",
	"cache invalidation": "缓存失效",
	"cache hit": "缓存命中",
	"cache miss": "缓存未命中",
	"warm up": "预热",
	"cold start": "冷启动",
	"hot path": "热路径",
	"fast path": "快速路径",
	"slow path": "慢路径",
	"critical section": "临界区",
	deadlock: "死锁",
	livelock: "活锁",
	starvation: "饥饿",
	"mutex": "互斥锁",
	semaphore: "信号量",
	"spin lock": "自旋锁",
	"read-modify-write": "读取-修改-写入",
	"copy-on-write": "写时复制",
	"shadowing": "变量遮蔽",
	"closure": "闭包",
	"currying": "柯里化",
	"monadic": "单子式的",
	"promise chaining": "Promise 链式调用",
	"event loop": "事件循环",
	"macro task": "宏任务",
	"micro task": "微任务",
	"tail call": "尾调用",
	"stack trace": "调用栈",
	"flame graph": "火焰图",
	"profile": "性能剖析",
	"benchmark": "基准测试",
	"load test": "压力测试",
	"fuzz test": "模糊测试",
	"smoke test": "冒烟测试",
	"regression": "回归",
	"flaky test": "不稳定的测试",
	"test fixture": "测试夹具",
	"mock": "模拟",
	"stub": "桩",
	"snapshot test": "快照测试",
	"coverage": "覆盖率",
	"type narrowing": "类型收窄",
	"type guard": "类型守卫",
	"structural typing": "结构化类型",
	"duck typing": "鸭子类型",
	"shadow type": "影子类型",
	"algebraic data type": "代数数据类型",
	"pattern matching": "模式匹配",
	"option type": "Option 类型",
	"null safety": "空安全",
	"shadowing rule": "遮蔽规则",
	"escape hatch": "逃生通道",
	"feature flag": "功能开关",
	"kill switch": "紧急开关",
	"canary release": "金丝雀发布",
	"rolling update": "滚动更新",
	"blue-green deployment": "蓝绿部署",
	"infrastructure as code": "基础设施即代码",
	"infrastructure": "基础设施",
	"observability": "可观测性",
	"telemetry": "遥测",
	"tracing": "链路追踪",
	"structured logging": "结构化日志",
	"error budget": "错误预算",
	"SLO": "SLO",
	"SLA": "SLA",
	"false positive": "误报",
	"false negative": "漏报",
	"heuristic": "启发式",
	"deterministic": "确定性",
	"non-deterministic": "非确定性",
	"state machine": "状态机",
	"finite state machine": "有限状态机",
	"race-free": "无竞态",
	"thread-safe": "线程安全",
	"lock-free": "无锁",
	"wait-free": "无等待",
	"memory model": "内存模型",
	"happens-before": "先行发生",
	"volatile": "volatile",
	"atomic operation": "原子操作",
	"compare-and-swap": "比较并交换",
	"fetch-and-add": "取加操作",
};

/** Merge built-in glossary with user overrides (user wins on key collision). */
export function mergedGlossary(user: Record<string, string>): Record<string, string> {
	return { ...BUILT_IN_GLOSSARY, ...user };
}

/** Render the glossary as prompt text (sorted, one `key → value` per line). */
export function glossaryToPromptText(glossary: Record<string, string>, limit = 400): string {
	const entries = Object.entries(glossary).slice(0, limit);
	if (entries.length === 0) return "（无）";
	return entries.map(([k, v]) => `${k} → ${v}`).join("\n");
}

/**
 * Per-session term lock: terms the model itself introduced in earlier
 * translations of this session get pinned so later segments reuse the same
 * translation instead of drifting (竞态条件 vs 竞态状况).
 */
export class TermLock {
	private readonly locked = new Map<string, string>();
	private readonly recentSources: string[] = [];
	private static readonly MAX_REMEMBERED = 200;

	/** Record (source, target) pair; extract “中文” first-use patterns. */
	record(source: string, target: string): void {
		this.recentSources.push(source);
		if (this.recentSources.length > TermLock.MAX_REMEMBERED) this.recentSources.shift();
		// First-use convention emitted by our own prompt: 中文
		const re = /([\u4e00-\u9fff]{2,10})[（(]([A-Za-z][A-Za-z0-9 +#./-]{1,60})[)）]/g;
		for (const m of target.matchAll(re)) {
			const zh = m[1];
			const en = m[2].trim();
			if (!this.locked.has(en.toLowerCase())) {
				this.locked.set(en.toLowerCase(), `${zh}（${en}）`);
			}
		}
	}

	/** Extra prompt lines forcing locked terms, empty when none. */
	promptLines(): string {
		if (this.locked.size === 0) return "";
		const lines = [...this.locked.entries()].map(([en, zh]) => `${en} → ${zh}`);
		return `\n[会话已定译法] 以下术语必须沿用既定译法，不得换用其他译法：\n${lines.join("\n")}\n`;
	}
}
