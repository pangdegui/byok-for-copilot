import type { BYOKUsage } from '../../types';
import type { EndpointStyle } from '../../domain/profile-config';

/**
 * Normalized usage — every field is guaranteed to be a finite, non-negative
 * number when `valid` is true. Rows with NaN/Infinity are rejected by the
 * statistics tracker (they still get logged for debugging).
 */
export interface NormalizedUsage {
	/** False when any core token count is NaN/Infinity/negative — skip stats. */
	valid: boolean;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cache: {
		/** True when the API reported any cache info (flat, official or Anthropic). */
		reported: boolean;
		hit: number;
		miss: number;
	};
	/** Cache-write tokens (Anthropic cache_creation_input_tokens). 0 when unreported.
	 * Distinct from `miss`: writes are billed at the (usually higher) write price. */
	cacheWriteTokens: number;
	/** Cache hit rate in percent (0–100). Undefined when cache was not reported. */
	cacheRate: number | undefined;
	/** Which format supplied the cache numbers (for debugging). */
	cacheSource: 'flat' | 'openai-official' | 'anthropic' | 'none';
}

function toFinite(value: unknown): number | undefined {
	if (typeof value !== 'number') {
		return undefined;
	}
	if (Number.isNaN(value) || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return value;
}

function firstFinite(values: readonly unknown[]): number | undefined {
	for (const value of values) {
		const n = toFinite(value);
		if (n !== undefined) {
			return n;
		}
	}
	return undefined;
}

/**
 * Normalize a raw BYOKUsage from any supported API format into a clean shape.
 *
 * Supported cache formats:
 *  - flat:            prompt_cache_hit_tokens / prompt_cache_miss_tokens (DeepSeek, OpenAI-compatible)
 *  - openai-official: prompt_tokens_details.cached_tokens (hit = cached, miss = prompt - cached)
 *  - anthropic:       cache_read_input_tokens (hit) / cache_creation_input_tokens (miss)
 *
 * The cache format is decided by the **configured endpoint style**, not by
 * sniffing the response fields. Aggregation gateways (e.g. commandcode.ai)
 * echo Anthropic-style cache fields as 0-valued placeholders even for
 * openai-chat traffic — auto-detection would pick the wrong format.
 *
 *   - style === 'anthropic-messages' → only read Anthropic cache fields
 *   - style === 'openai-chat' | 'openai-responses' → read flat / official fields
 *   - style === undefined → legacy auto-detect fallback (used where the style
 *     is not available, e.g. some debug paths)
 */
export function normalizeUsage(
	usage: BYOKUsage,
	style?: EndpointStyle,
): NormalizedUsage {
	const promptTokens = firstFinite([usage.prompt_tokens]) ?? 0;
	const completionTokens = firstFinite([usage.completion_tokens]) ?? 0;
	const totalTokens = firstFinite([usage.total_tokens]) ?? promptTokens + completionTokens;

	// Reject rows where a core count is NaN/negative so statistics stay meaningful.
	const coreValid =
		toFinite(usage.prompt_tokens) !== undefined &&
		toFinite(usage.completion_tokens) !== undefined;
	if (!coreValid) {
		return {
			valid: false,
			promptTokens,
			completionTokens,
			totalTokens,
			cache: { reported: false, hit: 0, miss: 0 },
			cacheWriteTokens: 0,
			cacheRate: undefined,
			cacheSource: 'none',
		};
	}

	// ---- Read the raw cache fields (all formats) ----
	const flatHit = firstFinite([usage.prompt_cache_hit_tokens]);
	const flatMiss = firstFinite([usage.prompt_cache_miss_tokens]);

	const officialCached = firstFinite([usage.prompt_tokens_details?.cached_tokens]);

	const anthropicHit = firstFinite([usage.cache_read_input_tokens]);
	const anthropicMiss = firstFinite([usage.cache_creation_input_tokens]);

	let hit = 0;
	let miss = 0;
	let reported = false;
	let source: NormalizedUsage['cacheSource'] = 'none';

	// ---- Decide the cache source by configured style ----
	if (style === 'anthropic-messages') {
		// Claude Messages format: read/write cache tokens are the only signals.
		if (anthropicHit !== undefined || anthropicMiss !== undefined) {
			hit = anthropicHit ?? 0;
			miss = anthropicMiss ?? 0;
			reported = true;
			source = 'anthropic';
		}
	} else if (style === 'openai-chat' || style === 'openai-responses') {
		// OpenAI-compatible: flat (DeepSeek) first, then official cached_tokens.
		if (flatHit !== undefined || flatMiss !== undefined) {
			hit = flatHit ?? 0;
			miss = flatMiss ?? 0;
			reported = true;
			source = 'flat';
		} else if (officialCached !== undefined) {
			hit = officialCached;
			miss = Math.max(0, promptTokens - officialCached);
			reported = true;
			source = 'openai-official';
		}
	} else {
		// No style context (legacy auto-detect): flat > anthropic > official.
		// Only treat Anthropic fields as a valid signal when non-zero, so
		// 0-valued placeholders from OpenAI gateways do not shadow the real
		// numbers in `prompt_tokens_details.cached_tokens`.
		const anthropicHitValid = anthropicHit !== undefined && anthropicHit > 0;
		const anthropicMissValid = anthropicMiss !== undefined && anthropicMiss > 0;
		if (flatHit !== undefined || flatMiss !== undefined) {
			hit = flatHit ?? 0;
			miss = flatMiss ?? 0;
			reported = true;
			source = 'flat';
		} else if (anthropicHitValid || anthropicMissValid) {
			hit = anthropicHit ?? 0;
			miss = anthropicMiss ?? 0;
			reported = true;
			source = 'anthropic';
		} else if (officialCached !== undefined) {
			hit = officialCached;
			miss = Math.max(0, promptTokens - officialCached);
			reported = true;
			source = 'openai-official';
		}
	}

	const cacheTotal = hit + miss;
	const cacheRate =
		reported && cacheTotal > 0 ? (hit / cacheTotal) * 100 : reported ? 0 : undefined;

	return {
		valid: true,
		promptTokens,
		completionTokens,
		totalTokens,
		cache: { reported, hit, miss },
		cacheWriteTokens: source === 'anthropic' ? (anthropicMiss ?? 0) : 0,
		cacheRate,
		cacheSource: source,
	};
}

/** True when any core token count is NaN/Infinity (a row that should be skipped). */
export function isUsageInvalid(usage: BYOKUsage): boolean {
	return (
		toFinite(usage.prompt_tokens) === undefined ||
		toFinite(usage.completion_tokens) === undefined
	);
}

/** Format a cache hit rate for display. Falls back to a meaningful 'n/a' marker. */
export function formatCacheRate(rate: number | undefined): string {
	return rate === undefined ? 'n/a' : `${rate.toFixed(1)}%`;
}

/** Compact cache summary used in the per-request log line. */
export function formatCacheLog(cache: NormalizedUsage['cache'], rate: number | undefined): string {
	const sourceLabel = !cache.reported ? 'notReported' : '';
	const rateText = formatCacheRate(rate);
	return (
		`hit=${cache.hit} miss=${cache.miss} rate=${rateText}` +
		(sourceLabel ? ` (${sourceLabel})` : '')
	);
}
