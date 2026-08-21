// ============================================================================
// profile/ — 遥测聚合入口(⑤ profile 遥测层)
//
// Phase 3 (docs/ARCHITECTURE.md):收敛 logger / usage(stats) / cost(pricing) /
// diagnostics(debug) 到统一入口,并提供 health(连接/健康/延迟)。
// 统一使用:import { profile } from '../profile';
//
// 说明:stats 的持久化(globalState)与面板行为保持不变,此处仅聚合导出,
// 不改动各子模块的实现与调用路径。
// ============================================================================

import { logger } from './log';

// health(新增:连接/健康/延迟,只记录不决策)
import { healthStore } from './health';
export { healthStore };
export type { EndpointHealth, EndpointHealthStatus } from './health';
export { openHealthPanel } from './health/panel';

// log
export { logger };

// usage(用量统计,globalState 持久化 + 侧栏/面板)
export {
	normalizeUsage,
	formatCacheRate,
	formatCacheLog,
	isUsageInvalid,
	UsageStatsStore,
	toModelStats,
	createEmptyAggregate,
	UsageTracker,
	initializeUsageTracker,
	getUsageTracker,
	recordUsageEvent,
	registerUsageStatsSidebar,
	UsageStatsTreeDataProvider,
	openStatsPanel,
	getStatsPanelHtml,
} from '../copilot/stats';
export type {
	NormalizedUsage,
	ModelAggregate,
	ModelStats,
	StatsSnapshot,
	StatsPanelState,
} from '../copilot/stats';

// cost(费用/币种)
export { toModelCostInfo } from '../copilot/pricing/costs';
export type { ModelCostInformation } from '../copilot/pricing/costs';
export { BalanceCurrencyResolver } from '../copilot/pricing/currency';

// diagnostics(缓存/工具流诊断 + request dump)
export {
	createCacheDiagnosticsRecorder,
	logToolFlowDiagnostics,
	observeCancellationToken,
	dumpApiRequest,
	dumpProviderInput,
	ensureRequestDumpRoot,
} from '../copilot/debug';
export type {
	CacheDiagnosticsRecorder,
	CacheDiagnosticsRun,
	ReplayMarkerReportTrigger,
} from '../copilot/debug';

/** Aggregate facade for the four telemetry concerns. */
export const profile: {
	log: typeof logger;
	health: { recordAttempt(name: string): void; };
} = {
	log: logger,
	health: healthStore,
};

export type Profile = typeof profile;
