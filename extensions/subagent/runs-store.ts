/**
 * In-memory record of subagent runs.
 *
 * The /subagent-runs command reads this store. The live widget reads the
 * running entries. The store does not persist across restarts.
 *
 * A run gets its number when it starts, not when it completes. Updates
 * for the same tool call replace the stored record in place.
 */

import type { SingleResult } from "./types.ts";

export interface RunRecord {
	/** Run number, given in start order. Starts at 1. */
	number: number;
	toolCallId: string;
	/** Time of the first update. */
	recordedAt: number;
	/** Time of the last update with a finished status. */
	finishedAt?: number;
	result: SingleResult;
	/** Final output of a run restored from the session file. */
	restoredOutput?: string;
	/** Cache file with the full transcript of a nested run. */
	transcriptFile?: string;
}

const ACTIVE_STATUSES = new Set(["pending", "running"]);

function isFinished(result: SingleResult): boolean {
	return !ACTIVE_STATUSES.has(result.status);
}

export class RunStore {
	private records: RunRecord[] = [];
	private byNumber = new Map<number, RunRecord>();
	private byToolCallId = new Map<string, RunRecord[]>();
	private nextNumber = 1;

	/**
	 * Add new results, or replace the stored copy of results that were
	 * recorded before. Live updates call this with the running state;
	 * the completion call replaces the record with the final state.
	 * Returns the records that the call created or updated.
	 */
	upsert(toolCallId: string, results: SingleResult[]): RunRecord[] {
		let group = this.byToolCallId.get(toolCallId);
		if (!group) {
			group = [];
			this.byToolCallId.set(toolCallId, group);
		}

		const updated: RunRecord[] = [];
		results.forEach((result, index) => {
			const existing = group[index];
			if (existing) {
				existing.result = result;
				if (isFinished(result) && !existing.finishedAt) existing.finishedAt = Date.now();
				updated.push(existing);
				return;
			}
			const entry: RunRecord = { number: this.nextNumber++, toolCallId, recordedAt: Date.now(), result };
			if (isFinished(result)) entry.finishedAt = entry.recordedAt;
			group.push(entry);
			this.records.push(entry);
			this.byNumber.set(entry.number, entry);
			updated.push(entry);
		});
		return updated;
	}

	/** Remove all records. Used when the session changes. */
	clear(): void {
		this.records = [];
		this.byNumber.clear();
		this.byToolCallId.clear();
		this.nextNumber = 1;
	}

	/** Insert a record restored from the session file, with its number. */
	restore(record: RunRecord): void {
		this.records.push(record);
		this.byNumber.set(record.number, record);
		this.byToolCallId.set(record.toolCallId, [record]);
		if (record.number >= this.nextNumber) this.nextNumber = record.number + 1;
	}

	/** Results of runs that are in flight. */
	running(): SingleResult[] {
		return this.records.filter((run) => !isFinished(run.result)).map((run) => run.result);
	}

	/** All records, newest first. */
	allNewestFirst(): RunRecord[] {
		return [...this.records].reverse();
	}

	get(number: number): RunRecord | undefined {
		return this.byNumber.get(number);
	}

	getByToolCallId(toolCallId: string): RunRecord | undefined {
		return this.byToolCallId.get(toolCallId)?.[0];
	}
}
