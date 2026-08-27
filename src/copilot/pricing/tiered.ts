import type { BYOKUsage, PriceTable, TieredPricing } from '../../types';
import type { EndpointStyle } from '../../domain/profile-config';

export type { PriceTable, TieredPricing };
import { normalizeUsage } from '../stats/usage';

/**
 * 一次请求的费用估算结果(单位:配置价格表所用的货币)。
 */
export interface CostEstimate {
	/** 预估总费用。 */
	total: number;
	/** 平均单次请求费用(total / 请求数,这里按 1 次请求计)。 */
	average: number;
	/** 分项费用。 */
	breakdown: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		toolCalls: number;
	};
	/** 是否有足够的价格信息完成估算(false = 价格表缺失或全为空)。 */
	priced: boolean;
}

const PER_MILLION = 1_000_000;

function toNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 解析用户填写的价格表(JSON-ish),容忍缺字段与非法值。 */
export function parsePriceTable(raw: unknown): PriceTable | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	const table: PriceTable = {};
	const input = toNumber(r.input);
	const output = toNumber(r.output);
	const cacheRead = toNumber(r.cacheRead);
	const cacheWrite = toNumber(r.cacheWrite);
	const toolCall = toNumber(r.toolCall);
	if (input !== undefined) table.input = input;
	if (output !== undefined) table.output = output;
	if (cacheRead !== undefined) table.cacheRead = cacheRead;
	if (cacheWrite !== undefined) table.cacheWrite = cacheWrite;
	if (toolCall !== undefined) table.toolCall = toolCall;
	return Object.keys(table).length > 0 ? table : undefined;
}

/** 解析完整的阶梯价格配置。 */
export function parseTieredPricing(raw: unknown): TieredPricing | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	const def = parsePriceTable(r.default);
	const pricing: TieredPricing = def ? { default: def } : {};
	if (Array.isArray(r.tiers)) {
		const tiers = r.tiers
			.map((t) => {
				if (typeof t !== 'object' || t === null) {
					return undefined;
				}
				const tier = t as Record<string, unknown>;
				const table = parsePriceTable(tier.table);
				if (!table || typeof tier.name !== 'string' || !tier.name.trim()) {
					return undefined;
				}
				return {
					name: tier.name.trim(),
					table,
					...(typeof tier.condition === 'string' && tier.condition.trim()
						? { condition: tier.condition.trim() }
						: {}),
				};
			})
			.filter((t): t is NonNullable<typeof t> => t !== undefined);
		if (tiers.length > 0) {
			pricing.tiers = tiers;
		}
	}
	return pricing;
}

/**
 * 按指定价格表估算一次请求的费用。
 *
 * 计价口径:
 * - 输入 = prompt_tokens − 缓存命中 − 缓存写入(避免重复计费)
 * - 缓存读取/写入分别按各自单价
 * - 工具调用按次
 * 所有 token 单价均为"每百万"。
 */
export function estimateCost(
	usage: BYOKUsage,
	table: PriceTable,
	toolCallCount = 0,
	style?: EndpointStyle,
): CostEstimate {
	const normalized = normalizeUsage(usage, style);

	const cacheRead = Math.max(0, normalized.cache.hit);
	const cacheWrite = Math.max(0, normalized.cacheWriteTokens);
	const input = Math.max(0, normalized.promptTokens - cacheRead - cacheWrite);
	const output = normalized.completionTokens;

	const perMillion = (tokens: number, unitPrice?: number): number =>
		unitPrice !== undefined ? (tokens / PER_MILLION) * unitPrice : 0;

	const breakdown = {
		input: perMillion(input, table.input),
		output: perMillion(output, table.output),
		cacheRead: perMillion(cacheRead, table.cacheRead),
		cacheWrite: perMillion(cacheWrite, table.cacheWrite),
		toolCalls:
			table.toolCall !== undefined && toolCallCount > 0 ? toolCallCount * table.toolCall : 0,
	};
	const total =
		breakdown.input +
		breakdown.output +
		breakdown.cacheRead +
		breakdown.cacheWrite +
		breakdown.toolCalls;

	const priced =
		table.input !== undefined ||
		table.output !== undefined ||
		table.cacheRead !== undefined ||
		table.cacheWrite !== undefined ||
		table.toolCall !== undefined;

	return {
		total,
		average: total,
		breakdown,
		priced,
	};
}

/** 解析单个时间点为当天秒数。支持 "H"、"HH:mm"、"HH:mm:ss"(如 8 / 21:30 / 09:00:00)。 */
function parseTimePoint(text: string): number | undefined {
	const parts = text.trim().split(':').map((p) => p.trim());
	if (parts.length < 1 || parts.length > 3 || parts.some((p) => p === '' || !/^\d+$/.test(p))) {
		return undefined;
	}
	const h = Number(parts[0]);
	const m = parts.length > 1 ? Number(parts[1]) : 0;
	const s = parts.length > 2 ? Number(parts[2]) : 0;
	if (h > 24 || m > 59 || s > 59) {
		return undefined;
	}
	return h * 3600 + m * 60 + s;
}

/**
 * 解析阶梯的时段条件表达式,返回 [startSeconds, endSeconds)。
 * 兼容两种写法(两侧可混用):
 *   - 小时:      "0-8"、"21-6"
 *   - HH:mm[:ss]: "00:00-08:00"、"21:30-06:00:00"
 * 无法解析时返回 undefined(表示不限时段)。
 */
export function parseTimeCondition(condition: string | undefined): [number, number] | undefined {
	if (!condition) {
		return undefined;
	}
	const m = condition.trim().match(/^(.+?)\s*-\s*(.+)$/);
	if (!m) {
		return undefined;
	}
	const start = parseTimePoint(m[1]);
	const end = parseTimePoint(m[2]);
	if (start === undefined || end === undefined || start === end) {
		return undefined;
	}
	return [start, end];
}

/** 判断给定时刻是否落在时段内(支持跨零点,如 21:30-06:00)。无条件恒匹配。
 * `time` 为当天秒数;也接受小数小时以兼容旧调用。 */
export function isTimeInCondition(time: number, condition: string | undefined): boolean {
	const range = parseTimeCondition(condition);
	if (!range) {
		return true;
	}
	const [start, end] = range;
	if (start < end) {
		return time >= start && time < end;
	}
	// 跨零点:如 21:30-06:00 → time >= start || time < end
	return time >= start || time < end;
}

/** 兼容旧接口:按小时(0-24,可含小数)判断。 */
export function isHourInCondition(hour: number, condition: string | undefined): boolean {
	return isTimeInCondition(hour * 3600, condition);
}

/** 当天已过秒数(本地时区)。 */
export function secondsOfDay(date: Date = new Date()): number {
	return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

/**
 * 根据当前时刻选择适用的价格表:优先命中带时段条件的阶梯(按配置顺序取第一个),
 * 其次无条件阶梯(全时段),最后回落 default。全部缺失时返回 undefined(不计价)。
 */
export function pickTierTable(
	pricing: TieredPricing,
	timeOfDaySeconds: number = secondsOfDay(),
): PriceTable | undefined {
	let unconditional: PriceTable | undefined;
	for (const tier of pricing.tiers ?? []) {
		if (!tier.condition) {
			unconditional ??= tier.table;
			continue;
		}
		if (isTimeInCondition(timeOfDaySeconds, tier.condition)) {
			return tier.table;
		}
	}
	return unconditional ?? pricing.default;
}

/** 格式化费用显示(保留合理精度)。 */
export function formatCost(value: number): string {
	if (!Number.isFinite(value)) {
		return '—';
	}
	if (value === 0) {
		return '0';
	}
	if (value < 0.01) {
		return value.toFixed(4);
	}
	if (value < 1) {
		return value.toFixed(3);
	}
	return value.toFixed(2);
}
