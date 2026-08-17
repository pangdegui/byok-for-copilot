import vscode from 'vscode';
import type { NormalizedUsage } from './usage';

/**
 * Persistent per-model usage statistics.
 *
 * Stored in `context.globalState` (Memento), so the aggregates survive
 * across window reloads and sessions. Each model key is the VS Code model id
 * (e.g. `deepseek-v4-flash@opencode`), which uniquely identifies a
 * model + endpoint combination.
 */
export interface ModelAggregate {
	/** Last observed upstream API model id (for display). */
	apiModelId: string;
	requests: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cacheHitTokens: number;
	cacheMissTokens: number;
	/** Sum of observed chars/token ratios (avg = sum / requests). */
	charsPerTokenSum: number;
	firstSeen: number;
	lastUpdated: number;
}

/** Immutable view of a model aggregate with derived averages. */
export interface ModelStats {
	modelId: string;
	apiModelId: string;
	requests: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cacheHitTokens: number;
	cacheMissTokens: number;
	avgPromptTokens: number;
	avgCompletionTokens: number;
	avgTotalTokens: number;
	avgCharsPerToken: number;
	/** Aggregate cache hit rate in percent (0–100). Undefined when no cache data. */
	cacheRate: number | undefined;
	/** True when any request reported cache fields. */
	cacheReported: boolean;
	firstSeen: number;
	lastUpdated: number;
}

export interface StatsSnapshot {
	models: ModelStats[];
	requests: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cacheHitTokens: number;
	cacheMissTokens: number;
}

const STORAGE_KEY = 'byok-copilot.usageStats.v1';

function readRaw(memento: vscode.Memento): Record<string, ModelAggregate> {
	const raw = memento.get<unknown>(STORAGE_KEY);
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		return raw as Record<string, ModelAggregate>;
	}
	return {};
}

export class UsageStatsStore {
	private readonly memento: vscode.Memento;

	constructor(context: vscode.ExtensionContext) {
		this.memento = context.globalState;
	}

	getAll(): Record<string, ModelAggregate> {
		return readRaw(this.memento);
	}

	get(modelId: string): ModelAggregate | undefined {
		return this.getAll()[modelId];
	}

	/**
	 * Record one normalized usage row. Rows with `valid === false` (NaN etc.)
	 * are skipped entirely and return the unchanged aggregate.
	 */
	record(
		modelId: string,
		apiModelId: string,
		normalized: NormalizedUsage,
		charsPerToken: number,
	): ModelAggregate {
		if (!normalized.valid) {
			return this.get(modelId) ?? createEmptyAggregate(modelId, apiModelId);
		}

		const all = this.getAll();
		const existing = all[modelId];
		const now = Date.now();
		const next: ModelAggregate = {
			apiModelId: apiModelId || existing?.apiModelId || modelId,
			requests: (existing?.requests ?? 0) + 1,
			promptTokens: (existing?.promptTokens ?? 0) + normalized.promptTokens,
			completionTokens: (existing?.completionTokens ?? 0) + normalized.completionTokens,
			totalTokens: (existing?.totalTokens ?? 0) + normalized.totalTokens,
			cacheHitTokens: (existing?.cacheHitTokens ?? 0) + normalized.cache.hit,
			cacheMissTokens: (existing?.cacheMissTokens ?? 0) + normalized.cache.miss,
			charsPerTokenSum:
				(existing?.charsPerTokenSum ?? 0) +
				(Number.isFinite(charsPerToken) ? Math.max(0, charsPerToken) : 0),
			firstSeen: existing?.firstSeen ?? now,
			lastUpdated: now,
		};

		const allNext = { ...all, [modelId]: next };
		void this.memento.update(STORAGE_KEY, allNext);
		return next;
	}

	resetModel(modelId: string): void {
		const all = this.getAll();
		if (!(modelId in all)) {
			return;
		}
		const { [modelId]: _removed, ...rest } = all;
		void this.memento.update(STORAGE_KEY, rest);
	}

	resetAll(): void {
		void this.memento.update(STORAGE_KEY, {});
	}

	/** Snapshot with derived averages, ready for tree/webview rendering. */
	getSnapshot(): StatsSnapshot {
		const all = this.getAll();
		const models: ModelStats[] = [];

		let requests = 0;
		let promptTokens = 0;
		let completionTokens = 0;
		let totalTokens = 0;
		let cacheHitTokens = 0;
		let cacheMissTokens = 0;

		for (const [modelId, agg] of Object.entries(all)) {
			const stats = toModelStats(modelId, agg);
			models.push(stats);
			requests += stats.requests;
			promptTokens += stats.promptTokens;
			completionTokens += stats.completionTokens;
			totalTokens += stats.totalTokens;
			cacheHitTokens += stats.cacheHitTokens;
			cacheMissTokens += stats.cacheMissTokens;
		}

		// Most recently used first.
		models.sort((a, b) => b.lastUpdated - a.lastUpdated);

		return {
			models,
			requests,
			promptTokens,
			completionTokens,
			totalTokens,
			cacheHitTokens,
			cacheMissTokens,
		};
	}
}

export function createEmptyAggregate(modelId: string, apiModelId: string): ModelAggregate {
	const now = Date.now();
	return {
		apiModelId: apiModelId || modelId,
		requests: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cacheHitTokens: 0,
		cacheMissTokens: 0,
		charsPerTokenSum: 0,
		firstSeen: now,
		lastUpdated: now,
	};
}

export function toModelStats(modelId: string, agg: ModelAggregate): ModelStats {
	const reqs = agg.requests || 1;
	const cacheTotal = agg.cacheHitTokens + agg.cacheMissTokens;
	const cacheReported = agg.cacheHitTokens > 0 || agg.cacheMissTokens > 0;
	return {
		modelId,
		apiModelId: agg.apiModelId,
		requests: agg.requests,
		promptTokens: agg.promptTokens,
		completionTokens: agg.completionTokens,
		totalTokens: agg.totalTokens,
		cacheHitTokens: agg.cacheHitTokens,
		cacheMissTokens: agg.cacheMissTokens,
		avgPromptTokens: agg.promptTokens / reqs,
		avgCompletionTokens: agg.completionTokens / reqs,
		avgTotalTokens: agg.totalTokens / reqs,
		avgCharsPerToken: agg.charsPerTokenSum / reqs,
		cacheRate:
			cacheReported && cacheTotal > 0 ? (agg.cacheHitTokens / cacheTotal) * 100 : cacheReported ? 0 : undefined,
		cacheReported,
		firstSeen: agg.firstSeen,
		lastUpdated: agg.lastUpdated,
	};
}
