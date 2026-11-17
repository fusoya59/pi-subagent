/**
 * Shared data types for the subagent extension.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

export type ChildStatus = "pending" | "running" | "completed" | "failed" | "aborted";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "package" | "user" | "project" | "unknown";
	task: string;
	status: ChildStatus;
	exitCode: number | null;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: ThinkingLevel;
	stopReason?: string;
	errorMessage?: string;
	terminationSignal?: NodeJS.Signals;
	step?: number;
	cwd?: string;
}

export interface SubagentDetails {
	mode: "single";
	results: SingleResult[];
	isError: boolean;
}
