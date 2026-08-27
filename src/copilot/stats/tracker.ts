import vscode from 'vscode';
import type { BYOKUsage } from '../../types';
import type { EndpointStyle } from '../../domain/profile-config';
import { normalizeUsage } from './usage';
import { UsageStatsStore, type ModelAggregate, type StatsSnapshot } from './store';

/**
 * Global usage tracker — the single sink for every per-request usage event.
 *
 * It updates the persistent store, fires change events for the sidebar tree
 * and the main stats webview, and stays a no-op until initialized.
 */
export class UsageTracker {
	private readonly store: UsageStatsStore;
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(context: vscode.ExtensionContext) {
		this.store = new UsageStatsStore(context);
	}

	/**
	 * Record one request's usage. Rows with NaN/Infinity (invalid) are skipped
	 * so they never pollute the long-term statistics.
	 *
	 * `cost` is the per-request estimated total, computed by the caller using
	 * the tier price table effective at the request's timestamp.
	 */
	record(
		vscodeModelId: string,
		apiModelId: string,
		usage: BYOKUsage,
		charsPerToken: number,
		extra?: { toolCallCount?: number; cost?: number; style?: EndpointStyle },
	): void {
		const normalized = normalizeUsage(usage, extra?.style);
		if (!normalized.valid) {
			// Skip invalid rows entirely (still surfaced in per-request logs).
			return;
		}
		this.store.record(vscodeModelId, apiModelId, normalized, charsPerToken, extra);
		this._onDidChange.fire();
	}

	getSnapshot(): StatsSnapshot {
		return this.store.getSnapshot();
	}

	resetModel(modelId: string): void {
		this.store.resetModel(modelId);
		this._onDidChange.fire();
	}

	resetAll(): void {
		this.store.resetAll();
		this._onDidChange.fire();
	}

	/**
	 * Import parsed aggregates into the store.
	 *
	 * @param mode 'merge' adds to existing data, 'replace' overwrites everything
	 * @returns number of models imported
	 */
	importStats(
		aggregates: Record<string, ModelAggregate>,
		mode: 'merge' | 'replace',
	): number {
		const count = this.store.importStats(aggregates, mode);
		if (count > 0) {
			this._onDidChange.fire();
		}
		return count;
	}
}

let instance: UsageTracker | undefined;

export function initializeUsageTracker(context: vscode.ExtensionContext): UsageTracker {
	instance = new UsageTracker(context);
	return instance;
}

export function getUsageTracker(): UsageTracker | undefined {
	return instance;
}

/**
 * Convenience entry point used from the stream layer. No-ops until the
 * tracker has been initialized during activation.
 */
export function recordUsageEvent(
	vscodeModelId: string,
	apiModelId: string,
	usage: BYOKUsage,
	charsPerToken: number,
	extra?: { toolCallCount?: number; cost?: number; style?: EndpointStyle },
): void {
	instance?.record(vscodeModelId, apiModelId, usage, charsPerToken, extra);
}
