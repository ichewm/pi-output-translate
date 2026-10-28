/**
 * System/user prompt assembly for faithful + localized translation.
 *
 * Three-part contract (SPEC §6):
 *   [角色] translate engine only
 *   [忠实] no add / no drop / no rewrite / keep markdown + placeholders
 *   [本地化] mainland Chinese engineering conventions + glossary + term lock
 *
 * Batch protocol: sources are numbered blocks "[1]\n...\n[2]\n..."; the model
 * must answer with the same numbered blocks, one per input, same order.
 */

import type { TranslateItem } from "./types.ts";

export interface PromptContext {
	targetLang: string;
	glossaryText: string;
	termLockLines?: string;
	/** Recent (source, target) pairs for coherence, oldest first. */
	recent: { source: string; target: string }[];
}

export function systemPrompt(ctx: PromptContext, itemCount = 0): string {
	const lang =
		ctx.targetLang === "zh-Hans" || ctx.targetLang === "zh-CN" ? "简体中文" : ctx.targetLang;
	const lock = ctx.termLockLines?.trim();
	return [
		`[角色] 你是软件工程文档的翻译引擎，把英文翻译成${lang}。只输出译文，不输出任何解释、前言、后记或代码块包裹。`,
		`[忠实] 逐句忠实翻译：不增加、不删减、不改写、不总结、不润色夸大。保留原文的 Markdown 结构（标题层级、列表、粗体斜体）。表格行必须整行保留竖线 | 分隔结构：逐格翻译，不增删列、不合并行、不丢竖线；表格行的竖线数量必须与原文一致。⟦数字⟧ 与 ⟦M数字⟧ 形式的占位符代表代码、路径、命令、数学公式（$…$ / $$…$$）等原文内容：必须原样保留（字符与数字不变），位置可按${lang}语序自然调整，绝不要翻译、改写或丢弃占位符。`,
		`[本地化] 用中国大陆软件工程社区的通行表述，让工程师一眼就懂。例如：race condition→竞态条件；idempotent→幂等；backpressure→背压；boilerplate→样板代码；side effect→副作用；dry run→试运行；scaffold→脚手架；gotcha→坑；workaround→临时绕过方案。没有通行译法的英文技术词保留英文原文。口语化表达按${lang}习惯自然化，但不得改变原意。`,
		`[术语表] 以下术语必须严格按给定译法翻译：\n${ctx.glossaryText}`,
		lock ? `[会话一致性] 本会话中已出现的译法必须保持一致，不得换用其他译法：\n${lock}` : "",
		itemCount <= 1
			? `[输出] 直接输出译文本身，不要任何编号、标注、前后缀或代码块包裹。`
			: `[输出] 严格按输入的编号块格式输出：每个 "[n]" 一块，块内是该块译文的全部内容，块与块之间空一行。不要遗漏任何块，不要合并或拆分块。`, 
	]
		.filter(Boolean)
		.join("\n\n");
}

/** True when this batch uses the plain (non-numbered) protocol. */
export function singleMode(count: number): boolean {
	return count <= 1;
}

export function batchUserPrompt(items: TranslateItem[], ctx: PromptContext): string {
	const parts: string[] = [];
	if (ctx.recent.length > 0) {
		const recent = ctx.recent
			.slice(-ctx.recent.length)
			.map((r, i) => `[前文${i + 1}] ${clip(r.source, 200)}\n[前文${i + 1}译] ${clip(r.target, 200)}`)
			.join("\n");
		parts.push(`（以下是上文片段，仅供保持术语与人称连贯，不需要翻译）\n${recent}`);
	}
	const lang = ctx.targetLang === "zh-Hans" ? "简体中文" : ctx.targetLang;
	if (items.length === 1) {
		// Single-segment batches (the common case) skip the numbered protocol
		// entirely: audit found strong models drop the [1] marker under long
		// system prompts, and plain in -> plain out cannot be mis-parsed.
		parts.push(`请把下面的文本翻译成${lang}，只输出译文：\n\n${items[0].source}`);
		return parts.join("\n\n");
	}
	const blocks = items.map((it, i) => `[${i + 1}]\n${it.source}`).join("\n\n");
	parts.push(`请翻译以下 ${items.length} 个编号块为${lang}：\n\n${blocks}`);
	return parts.join("\n\n");
}

export function repairUserPrompt(
	item: { masked: string; source: string },
	brokenTarget: string,
	lostTokens: string[],
): string {
	return [
		`你上一次翻译丢失了占位符。带占位符的原文（⟦n⟧ 是必须原样保留的占位符）：`,
		item.masked,
		``,
		`你的译文（有缺陷）：`,
		clip(brokenTarget, 2000),
		``,
		`丢失的占位符：${lostTokens.join("、")}。`,
		`请重新输出这块的完整译文，把所有占位符按原样放回合适位置。只输出译文。`,
	].join("\n");
}

function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}
