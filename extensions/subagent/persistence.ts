/**
 * Run records in the session file.
 *
 * A direct subagent call puts its full result, with the transcript, into
 * the session transcript. The runs view rebuilds such runs from the
 * session branch, so no extra data is needed.
 *
 * A nested call, for example from a codemode script, does not enter the
 * transcript: the session file keeps a bounded record only. For such
 * runs the extension stores a summary entry. The transcript is not
 * kept; only the final output is stored, capped in size.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { getResultOutput } from "./render.ts";
import type { RunRecord } from "./runs-store.ts";
import type { ChildStatus, SingleResult, SubagentDetails, UsageStats } from "./types.ts";

export const RUN_ENTRY_TYPE = "subagent-run";

const FINAL_OUTPUT_MAX_CHARS = 4000;
const STDERR_MAX_CHARS = 2000;
const TRANSCRIPT_DIR_NAME = "subagent-transcripts";
const TRANSCRIPT_MAX_AGE_DAYS = 14;

/** Shape of a session branch entry, as far as this module reads it. */
export interface BranchEntry {
	type: string;
	message?: {
		role?: string;
		toolName?: string;
		toolCallId?: string;
		timestamp?: number;
		details?: unknown;
	};
	customType?: string;
	data?: unknown;
}

/** Data of one nested run, as stored in the session file. */
export interface PersistedRun {
	number: number;
	toolCallId?: string;
	agent: string;
	agentSource: SingleResult["agentSource"];
	task: string;
	status: ChildStatus;
	exitCode: number | null;
	stopReason?: string;
	errorMessage?: string;
	terminationSignal?: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinking?: string;
	cwd?: string;
	recordedAt: number;
	finishedAt?: number;
	finalOutput: string;
	/** Cache file with the full transcript, for nested runs. */
	transcriptFile?: string;
}

/** One run taken from a subagent tool result of the session branch. */
export interface ReconstructedRun {
	toolCallId: string;
	finishedAt: number;
	result: SingleResult;
}

function cap(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}...[truncated]` : text;
}

function transcriptDir(): string {
	return path.join(getAgentDir(), TRANSCRIPT_DIR_NAME);
}

function transcriptFileName(toolCallId: string): string {
	const safe = toolCallId.replace(/[^A-Za-z0-9_-]+/g, "_");
	return `${safe}.json`;
}

/**
 * Save the full run record, transcript included, as one cache file.
 * Return the file path. The cache is extension-owned storage: it does
 * not touch the session file or the LLM context.
 */
export function writeTranscript(record: RunRecord): string {
	const filePath = path.join(transcriptDir(), transcriptFileName(record.toolCallId));
	fs.mkdirSync(transcriptDir(), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify({ number: record.number, result: record.result }));
	return filePath;
}

/** Load the transcript of a cached run. Return null when the file is missing or not valid. */
export function readTranscript(filePath: string): Message[] | null {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { result?: { messages?: unknown } };
		const messages = parsed.result?.messages;
		return Array.isArray(messages) ? (messages as Message[]) : null;
	} catch {
		return null;
	}
}

/** Delete transcript cache files older than the maximum age. */
export function pruneTranscripts(): void {
	const dir = transcriptDir();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const cutoff = Date.now() - TRANSCRIPT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const filePath = path.join(dir, entry.name);
		try {
			if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
		} catch {
			/* ignore */
		}
	}
}

/**
 * Runs from the subagent tool results of a session branch, in branch
 * order. The transcript is part of the stored result.
 */
export function runsFromToolResults(entries: BranchEntry[]): ReconstructedRun[] {
	const runs: ReconstructedRun[] = [];
	for (const entry of entries) {
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "toolResult") continue;
		if (message.toolName !== "subagent") continue;
		const details = message.details as SubagentDetails | undefined;
		if (!details || details.mode !== "single" || !Array.isArray(details.results)) continue;
		const finishedAt = message.timestamp ?? Date.now();
		for (const result of details.results) {
			runs.push({ toolCallId: message.toolCallId ?? `unknown-${runs.length + 1}`, finishedAt, result });
		}
	}
	return runs;
}

/** Build the session-file data of one nested run. */
export function persistRun(record: RunRecord, transcriptFile?: string): PersistedRun {
	const r = record.result;
	return {
		transcriptFile,
		number: record.number,
		toolCallId: record.toolCallId,
		agent: r.agent,
		agentSource: r.agentSource,
		task: r.task,
		status: r.status,
		exitCode: r.exitCode,
		stopReason: r.stopReason,
		errorMessage: r.errorMessage,
		terminationSignal: r.terminationSignal,
		stderr: cap(r.stderr, STDERR_MAX_CHARS),
		usage: r.usage,
		model: r.model,
		thinking: r.thinking,
		cwd: r.cwd,
		recordedAt: record.recordedAt,
		finishedAt: record.finishedAt,
		finalOutput: cap(getResultOutput(r), FINAL_OUTPUT_MAX_CHARS),
	};
}

/** Rebuild a nested run record from session-file data. The transcript is empty. */
export function restoreRun(data: PersistedRun): RunRecord {
	const result: SingleResult = {
		agent: data.agent,
		agentSource: data.agentSource,
		task: data.task,
		status: data.status,
		exitCode: data.exitCode,
		messages: [],
		stderr: data.stderr,
		usage: data.usage,
		model: data.model,
		thinking: data.thinking as SingleResult["thinking"],
		stopReason: data.stopReason,
		errorMessage: data.errorMessage,
		terminationSignal: data.terminationSignal as NodeJS.Signals | undefined,
		cwd: data.cwd,
	};
	return {
		number: data.number,
		toolCallId: data.toolCallId ?? `restored-${data.number}`,
		recordedAt: data.recordedAt,
		finishedAt: data.finishedAt,
		result,
		restoredOutput: data.finalOutput,
		transcriptFile: data.transcriptFile,
	};
}

/** Check that session-file data has the required fields. */
export function isPersistedRun(value: unknown): value is PersistedRun {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	return (
		typeof data.number === "number" &&
		typeof data.agent === "string" &&
		typeof data.task === "string" &&
		typeof data.status === "string" &&
		typeof data.usage === "object" &&
		data.usage !== null
	);
}
