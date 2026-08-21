import vscode from 'vscode';
import { formatCacheRate } from './usage';
import { formatCost } from '../pricing/tiered';
import { getModelTieredPricing } from '../../config';
import type { ModelStats, StatsSnapshot } from './store';
import type { UsageTracker } from './tracker';

const VIEW_ID = 'byok-copilot.statsSidebar';

enum StatsItemKind {
	SUMMARY = 1,
	MODEL = 2,
	MODEL_DETAIL = 3,
}

class StatsTreeItem extends vscode.TreeItem {
	kind: StatsItemKind;
	modelId: string | undefined;

	constructor(
		label: string,
		kind: StatsItemKind,
		collapsibleState: vscode.TreeItemCollapsibleState,
	) {
		super(label, collapsibleState);
		this.kind = kind;
		this.modelId = undefined;
	}
}

function formatCount(value: number): string {
	if (value >= 1_000_000_000) {
		return `${(value / 1_000_000_000).toFixed(1)}B`;
	}
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}M`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return String(Math.round(value));
}

function formatModelLabel(modelId: string): string {
	// e.g. `deepseek-v4-flash@opencode` → `deepseek-v4-flash (opencode)`
	const at = modelId.lastIndexOf('@');
	return at >= 0 ? `${modelId.slice(0, at)} (${modelId.slice(at + 1)})` : modelId;
}

export class UsageStatsTreeDataProvider implements vscode.TreeDataProvider<StatsTreeItem> {
	private readonly tracker: UsageTracker;
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<StatsTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(tracker: UsageTracker) {
		this.tracker = tracker;
		this.tracker.onDidChange(() => this.refresh());
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: StatsTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: StatsTreeItem): StatsTreeItem[] {
		const snapshot = this.tracker.getSnapshot();
		if (!element) {
			return [this.buildSummaryItem(snapshot), ...this.buildModelItems(snapshot)];
		}
		if (element.kind === StatsItemKind.MODEL && element.modelId) {
			const model = snapshot.models.find((m) => m.modelId === element.modelId);
			return model ? this.buildModelDetailItems(model) : [];
		}
		return [];
	}

	private buildSummaryItem(snapshot: StatsSnapshot): StatsTreeItem {
		const item = new StatsTreeItem(
			`总计: ${snapshot.requests} 请求`,
			StatsItemKind.SUMMARY,
			vscode.TreeItemCollapsibleState.None,
		);
		item.iconPath = new vscode.ThemeIcon('dashboard');
		item.description = `${formatCount(snapshot.totalTokens)} tok`;
		item.tooltip = [
			`请求数: ${snapshot.requests}`,
			`输入 tokens: ${formatCount(snapshot.promptTokens)}`,
			`输出 tokens: ${formatCount(snapshot.completionTokens)}`,
			`总计 tokens: ${formatCount(snapshot.totalTokens)}`,
			`缓存命中: ${formatCount(snapshot.cacheHitTokens)}`,
			`缓存未命中: ${formatCount(snapshot.cacheMissTokens)}`,
		].join('\n');
		item.contextValue = 'statsSummary';
		return item;
	}

	private buildModelItems(snapshot: StatsSnapshot): StatsTreeItem[] {
		return snapshot.models.map((model) => {
			const item = new StatsTreeItem(
				formatModelLabel(model.modelId),
				StatsItemKind.MODEL,
				vscode.TreeItemCollapsibleState.Collapsed,
			);
			item.iconPath = new vscode.ThemeIcon('symbol-method');
			item.description = `${model.requests} req · ${formatCount(model.totalTokens)} tok`;
			item.modelId = model.modelId;
			item.contextValue = 'statsModel';
			item.tooltip = `模型: ${model.modelId}\n点击查看详细统计`;
			return item;
		});
	}

	private buildModelDetailItems(model: ModelStats): StatsTreeItem[] {
		const cacheRate = formatCacheRate(model.cacheRate);
		const cacheLabel = model.cacheReported ? `${cacheRate}` : `${cacheRate} (未报告)`;
		// Distinguish "no price table configured" from "configured but no priced
		// request yet" — the latter is expected right after saving a price table.
		const hasPricing = modelHasPricing(model.modelId);
		const costTotal =
			model.costTotal !== undefined
				? formatCost(model.costTotal)
				: hasPricing
					? '0 (尚无计价请求)'
					: '未配置价格';
		const costAvg = model.costAverage !== undefined ? formatCost(model.costAverage) : '—';
		const rows: Array<[string, string, string]> = [
			['request-count', '请求数', String(model.requests)],
			['type-number', '输入 tokens (总和)', formatCount(model.promptTokens)],
			['type-number', '输出 tokens (总和)', formatCount(model.completionTokens)],
			['type-number', '总计 tokens (总和)', formatCount(model.totalTokens)],
			['type-number', '输入 tokens (均值)', formatCount(model.avgPromptTokens)],
			['type-number', '输出 tokens (均值)', formatCount(model.avgCompletionTokens)],
			['type-number', '总计 tokens (均值)', formatCount(model.avgTotalTokens)],
			['pulse', '缓存命中 tokens', formatCount(model.cacheHitTokens)],
			['pulse', '缓存未命中 tokens', formatCount(model.cacheMissTokens)],
			['pulse', '缓存写入 tokens', formatCount(model.cacheWriteTokens)],
			['dashboard', '缓存命中率', cacheLabel],
			['ruler', 'chars/token (均值)', model.avgCharsPerToken.toFixed(2)],
			['coin', '预估费用 (总和)', costTotal],
			['coin', '预估费用 (均值/次)', costAvg],
		];

		return rows.map(([icon, label, value]) => {
			const item = new StatsTreeItem(
				`${label}: ${value}`,
				StatsItemKind.MODEL_DETAIL,
				vscode.TreeItemCollapsibleState.None,
			);
			item.iconPath = new vscode.ThemeIcon(icon);
			return item;
		});
	}
}

/** Check whether a model (by its `base@endpoint` id) has a tiered price table. */
function modelHasPricing(vscodeModelId: string): boolean {
	const at = vscodeModelId.lastIndexOf('@');
	if (at <= 0) {
		return false;
	}
	const baseModelId = vscodeModelId.slice(0, at);
	const endpointName = vscodeModelId.slice(at + 1);
	try {
		return getModelTieredPricing(endpointName, baseModelId) !== undefined;
	} catch {
		return false;
	}
}

export function registerUsageStatsSidebar(
	context: vscode.ExtensionContext,
	tracker: UsageTracker,
): UsageStatsTreeDataProvider {
	const treeDataProvider = new UsageStatsTreeDataProvider(tracker);

	const treeView = vscode.window.createTreeView(VIEW_ID, {
		treeDataProvider,
		showCollapseAll: true,
	});
	context.subscriptions.push(treeView);

	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.refreshUsageStats', () => {
			treeDataProvider.refresh();
		}),
	);

	return treeDataProvider;
}
