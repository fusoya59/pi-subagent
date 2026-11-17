/**
 * Shared formatting for subagent output.
 *
 * The subagent tool renderer and the /subagent-runs view both use this code.
 * Keep one formatting path only; do not copy it.
 */

import * as os from "node:os";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatReadLineRange,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { ChildStatus, SingleResult, UsageStats } from "./types.ts";

export const COLLAPSED_ITEM_COUNT = 10;
const TRUNCATION_NOTICE_RESERVE = 256;

export type ThemeFg = (color: any, text: string) => string;
export interface ThemeLike {
	fg: ThemeFg;
	bold: (text: string) => string;
}

/** Shorten a home-anchored path for display. */
export function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/** Three-character label per thinking level, for narrow columns. */
const THINKING_LABELS: Record<ThinkingLevel, string> = {
	off: "off",
	minimal: "min",
	low: "low",
	medium: "med",
	high: "hi",
	xhigh: "xhi",
	max: "max",
};

/** Trailing tags of a model id that the summary lines do not show. */
const MODEL_TAG_PATTERN = /-(latest|preview|free)$/;

/** Three-character thinking level. "" when the level is unknown. */
export function shortThinkingLevel(level: ThinkingLevel | undefined): string {
	return level ? THINKING_LABELS[level] : "";
}

/** Model id without the provider prefix and without a trailing tag. "" when unknown. */
export function shortModelName(model: string | undefined): string {
	if (!model) return "";
	const slash = model.indexOf("/");
	return (slash === -1 ? model : model.slice(slash + 1)).replace(MODEL_TAG_PATTERN, "");
}

/** "model · level" without color, with the full model id. "" when both parts are unknown. */
export function modelThinkingLabel(model: string | undefined, level: ThinkingLevel | undefined): string {
	return [model, shortThinkingLevel(level)].filter(Boolean).join(" · ");
}

/** "model · level" in theme colors, with a short model name. Use it where the width is tight. */
export function formatModelThinking(
	model: string | undefined,
	level: ThinkingLevel | undefined,
	themeFg: ThemeFg,
): string {
	const parts: string[] = [];
	const name = shortModelName(model);
	const thinking = shortThinkingLevel(level);
	if (name) parts.push(themeFg("dim", name));
	if (thinking) parts.push(themeFg("dim", thinking));
	return parts.join(" " + themeFg("muted", "·") + " ");
}

export function formatUsageStats(usage: UsageStats, model?: string, thinking?: ThinkingLevel): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	const meta = modelThinkingLabel(model, thinking);
	if (meta) parts.push(meta);
	return parts.join(" ");
}

export function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: ThemeFg): string {
	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const lineRange = formatReadLineRange(args.offset, args.limit);
			let text = themeFg("accent", filePath);
			if (lineRange) {
				text += themeFg("warning", lineRange);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.status === "failed" || result.status === "aborted";
}

export function getFailureEvidence(result: SingleResult): string {
	const evidence: string[] = [];
	const seen = new Set<string>();
	const add = (label: string, value: string | undefined) => {
		const text = value?.trim();
		if (!text || seen.has(text)) return;
		seen.add(text);
		evidence.push(`${label}: ${text}`);
	};

	add("Error", result.errorMessage);
	add("Signal", result.terminationSignal);
	add("stderr", result.stderr);
	add("Assistant output", getFinalOutput(result.messages));
	return evidence.join("\n\n") || "(no output)";
}

export function getResultOutput(result: SingleResult): string {
	return isFailedResult(result) ? getFailureEvidence(result) : getFinalOutput(result.messages) || "(no output)";
}

export function truncateModelOutput(output: string): string {
	const initial = truncateHead(output);
	if (!initial.truncated) return output;

	const body = truncateHead(output, {
		maxLines: DEFAULT_MAX_LINES - 2,
		maxBytes: DEFAULT_MAX_BYTES - TRUNCATION_NOTICE_RESERVE,
	});
	const omittedBytes = initial.totalBytes - body.outputBytes;
	const notice = `[Output truncated: ${omittedBytes} bytes omitted. Full output preserved in tool details.]`;
	return body.content ? `${body.content}\n\n${notice}` : notice;
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

/** Icon for a run status, in theme colors. */
export function statusIcon(status: ChildStatus, themeFg: ThemeFg): string {
	if (status === "pending" || status === "running") return themeFg("warning", "⏳");
	if (status === "completed") return themeFg("success", "✓");
	return themeFg("error", "✗");
}

/** Icon for a run status, without color. Use where the theme does not apply. */
export function plainStatusIcon(status: ChildStatus): string {
	if (status === "pending" || status === "running") return "⏳";
	if (status === "completed") return "✓";
	return "✗";
}
