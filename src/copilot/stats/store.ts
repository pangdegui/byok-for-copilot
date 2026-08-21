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
	/** Cache-write tokens (Anthropic cache_creation), billed at the write price. */
	cacheWriteTokens: number;
	/** Total tool calls issued (for per-call pricing). */
	toolCalls: number;
	/** Sum of per-request estimated costs (currency = the model's price table). */
	costSum: number;
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
	cacheWriteTokens: number;
	toolCalls: number;
	avgPromptTokens: number;
	avgCompletionTokens: number;
	avgTotalTokens: number;
	avgCharsPerToken: number;
	/** Aggregate cache hit rate in percent (0–100). Undefined when no cache data. */
	cacheRate: number | undefined;
	/** True when any request reported cache fields. */
	cacheReported: boolean;
	/** Cumulative estimated cost (undefined when the model has no price table). */
	costTotal: number | undefined;
	/** Average cost per request (undefined when unpriced). */
	costAverage: number | undefined;
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
		extra?: { toolCallCount?: number; cost?: number },
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
			cacheWriteTokens:
				(existing?.cacheWriteTokens ?? 0) + normalized.cacheWriteTokens,
			toolCalls: (existing?.toolCalls ?? 0) + Math.max(0, extra?.toolCallCount ?? 0),
			costSum:
				(existing?.costSum ?? 0) +
				(extra?.cost !== undefined && Number.isFinite(extra.cost) ? extra.cost : 0),
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

	/**
	 * Import parsed aggregates into the store.
	 *
	 * @param aggregates map of modelId → aggregate
	 * @param mode 'merge' adds to existing aggregates, 'replace' overwrites all
	 * @returns number of models imported
	 */
	importStats(
		aggregates: Record<string, ModelAggregate>,
		mode: 'merge' | 'replace',
	): number {
		const current = mode === 'replace' ? {} : this.getAll();
		const merged = { ...current };

		for (const [modelId, agg] of Object.entries(aggregates)) {
			const existing = merged[modelId];
			merged[modelId] = existing ? mergeAggregates(existing, agg) : agg;
		}

		void this.memento.update(STORAGE_KEY, merged);
		return Object.keys(aggregates).length;
	}
}

/** Combine two aggregates by summing counters. */
function mergeAggregates(a: ModelAggregate, b: ModelAggregate): ModelAggregate {
	return {
		apiModelId: b.apiModelId || a.apiModelId,
		requests: a.requests + b.requests,
		promptTokens: a.promptTokens + b.promptTokens,
		completionTokens: a.completionTokens + b.completionTokens,
		totalTokens: a.totalTokens + b.totalTokens,
		cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
		cacheMissTokens: a.cacheMissTokens + b.cacheMissTokens,
		cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
		toolCalls: (a.toolCalls ?? 0) + (b.toolCalls ?? 0),
		costSum: (a.costSum ?? 0) + (b.costSum ?? 0),
		charsPerTokenSum: a.charsPerTokenSum + b.charsPerTokenSum,
		firstSeen: Math.min(a.firstSeen, b.firstSeen),
		lastUpdated: Math.max(a.lastUpdated, b.lastUpdated),
	};
}

export interface ParseStatsImportResult {
	aggregates: Record<string, ModelAggregate>;
	error?: string;
}

function toFiniteCount(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseTimestamp(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parse imported statistics JSON. Accepts two formats (both use the same
 * field names as the export):
 *
 *  1. StatsSnapshot (the export format):
 *     { models: [{ modelId, apiModelId, requests, promptTokens, ... }, ...] }
 *  2. Raw aggregate map:
 *     { "<modelId>": { apiModelId, requests, promptTokens, ... } }
 *
 * Invalid entries are skipped; the parsed result never contains NaN/Infinity.
 */
export function parseStatsImportJson(text: string): ParseStatsImportResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { aggregates: {}, error: '不是有效的 JSON 数据' };
	}

	const aggregates: Record<string, ModelAggregate> = {};

	if (Array.isArray((parsed as { models?: unknown } | null)?.models)) {
		// StatsSnapshot format.
		for (const item of (parsed as { models: unknown[] }).models) {
			if (!item || typeof item !== 'object') {
				continue;
			}
			const record = item as Record<string, unknown>;
			const modelId = typeof record.modelId === 'string' ? record.modelId : '';
			if (!modelId) {
				continue;
			}
			const now = Date.now();
			const aggregate = toAggregateFromStats(record, modelId, now);
			if (aggregate) {
				aggregates[modelId] = aggregate;
			}
		}
	} else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
		// Raw aggregate map format.
		for (const [modelId, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!value || typeof value !== 'object') {
				continue;
			}
			const aggregate = toAggregateFromStats(
				value as Record<string, unknown>,
				modelId,
				Date.now(),
			);
			if (aggregate) {
				aggregates[modelId] = aggregate;
			}
		}
	}

	return { aggregates };
}

function toAggregateFromStats(
	record: Record<string, unknown>,
	modelId: string,
	now: number,
): ModelAggregate | undefined {
	// A row is meaningful only if it reports at least one request with usable counts.
	const requests = toFiniteCount(record.requests);
	const promptTokens = toFiniteCount(record.promptTokens);
	const completionTokens = toFiniteCount(record.completionTokens);
	const totalTokens = toFiniteCount(record.totalTokens);
	const cacheHitTokens = toFiniteCount(record.cacheHitTokens);
	const cacheMissTokens = toFiniteCount(record.cacheMissTokens);

	if (requests <= 0) {
		return undefined;
	}

	// avgCharsPerToken is the exported average; charsPerTokenSum = avg * requests.
	const avgChars = toFiniteCount(record.avgCharsPerToken);

	return {
		apiModelId:
			typeof record.apiModelId === 'string' && record.apiModelId
				? record.apiModelId
				: modelId,
		requests,
		promptTokens,
		completionTokens,
		totalTokens,
		cacheHitTokens,
		cacheMissTokens,
		cacheWriteTokens: toFiniteCount(record.cacheWriteTokens),
		toolCalls: toFiniteCount(record.toolCalls),
		costSum: toFiniteCount(record.costSum),
		charsPerTokenSum: avgChars * requests,
		firstSeen: parseTimestamp(record.firstSeen, now),
		lastUpdated: parseTimestamp(record.lastUpdated, now),
	};
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
		cacheWriteTokens: 0,
		toolCalls: 0,
		costSum: 0,
		charsPerTokenSum: 0,
		firstSeen: now,
		lastUpdated: now,
	};
}

export function toModelStats(modelId: string, agg: ModelAggregate): ModelStats {
	const reqs = agg.requests || 1;
	const cacheTotal = agg.cacheHitTokens + agg.cacheMissTokens;
	const cacheReported = agg.cacheHitTokens > 0 || agg.cacheMissTokens > 0;
	const costTotal = agg.costSum ?? 0;
	const priced = costTotal > 0;
	return {
		modelId,
		apiModelId: agg.apiModelId,
		requests: agg.requests,
		promptTokens: agg.promptTokens,
		completionTokens: agg.completionTokens,
		totalTokens: agg.totalTokens,
		cacheHitTokens: agg.cacheHitTokens,
		cacheMissTokens: agg.cacheMissTokens,
		cacheWriteTokens: agg.cacheWriteTokens ?? 0,
		toolCalls: agg.toolCalls ?? 0,
		avgPromptTokens: agg.promptTokens / reqs,
		avgCompletionTokens: agg.completionTokens / reqs,
		avgTotalTokens: agg.totalTokens / reqs,
		avgCharsPerToken: agg.charsPerTokenSum / reqs,
		cacheRate:
			cacheReported && cacheTotal > 0 ? (agg.cacheHitTokens / cacheTotal) * 100 : cacheReported ? 0 : undefined,
		cacheReported,
		costTotal: priced ? costTotal : undefined,
		costAverage: priced ? costTotal / reqs : undefined,
		firstSeen: agg.firstSeen,
		lastUpdated: agg.lastUpdated,
	};
}
