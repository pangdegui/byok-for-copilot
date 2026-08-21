import vscode from 'vscode';
import { getDebugMode, getEndpoints } from '../../config';
import { getStatsPanelHtml, type StatsPanelState } from './html';
import { parseStatsImportJson } from './store';
import type { UsageTracker } from './tracker';

let currentPanel: vscode.WebviewPanel | undefined;

export function openStatsPanel(tracker: UsageTracker): void {
	if (currentPanel) {
		currentPanel.reveal();
		postState(currentPanel, tracker);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'byokStats',
		'BYOK 用量统计',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
		},
	);
	currentPanel = panel;

	panel.onDidDispose(() => {
		currentPanel = undefined;
	});

	panel.webview.onDidReceiveMessage((message: unknown) => {
		void handleMessage(panel, tracker, message);
	});

	// Live updates while the panel is open.
	const changeSubscription = tracker.onDidChange(() => postState(panel, tracker));
	panel.onDidDispose(() => changeSubscription.dispose());

	renderPanel(panel, tracker);
}

async function renderPanel(
	panel: vscode.WebviewPanel,
	tracker: UsageTracker,
): Promise<void> {
	panel.webview.html = getStatsPanelHtml(panel.webview, getPanelState(tracker));
}

function getPanelState(tracker: UsageTracker): StatsPanelState {
	return {
		snapshot: tracker.getSnapshot(),
		debugMode: getDebugMode(),
		endpointCount: getEndpoints().length,
	};
}

async function postState(
	panel: vscode.WebviewPanel,
	tracker: UsageTracker,
): Promise<void> {
	await panel.webview.postMessage({ type: 'state', value: getPanelState(tracker) });
}

async function handleMessage(
	panel: vscode.WebviewPanel,
	tracker: UsageTracker,
	message: unknown,
): Promise<void> {
	if (!isPanelMessage(message)) {
		return;
	}

	switch (message.type) {
		case 'refresh':
			await postState(panel, tracker);
			return;

		case 'export': {
			const state = getPanelState(tracker);
			await vscode.env.clipboard.writeText(JSON.stringify(state.snapshot, null, 2));
			void vscode.window.showInformationMessage('用量统计 JSON 已复制到剪贴板');
			return;
		}

		case 'import': {
			const text = await vscode.env.clipboard.readText();
			if (!text.trim()) {
				void vscode.window.showWarningMessage('剪贴板为空，请先复制导出的统计 JSON');
				return;
			}
			const { aggregates, error } = parseStatsImportJson(text);
			const count = Object.keys(aggregates).length;
			if (count === 0) {
				void vscode.window.showErrorMessage(
					error ?? '未能从剪贴板解析出有效的统计数据（请使用导出格式）',
				);
				return;
			}
			const selected = await vscode.window.showQuickPick(
				[
					{
						label: '合并到现有统计',
						description: '将导入的数据与当前数据相加',
						detail: `共 ${count} 个模型`,
					},
					{
						label: '替换现有统计',
						description: '清空当前数据后导入',
						detail: `共 ${count} 个模型`,
					},
				],
				{ placeHolder: '选择导入方式' },
			);
			if (!selected) {
				return;
			}
			const mode = selected.label.startsWith('替换') ? 'replace' : 'merge';
			const imported = tracker.importStats(aggregates, mode);
			await postState(panel, tracker);
			void vscode.window.showInformationMessage(
				`已${mode === 'merge' ? '合并导入' : '导入并替换'} ${imported} 个模型的统计`,
			);
			return;
		}

		case 'resetModel':
			if (message.modelId) {
				tracker.resetModel(message.modelId);
			}
			await postState(panel, tracker);
			return;

		case 'resetAll':
			tracker.resetAll();
			await postState(panel, tracker);
			return;

		case 'showLogs':
			await vscode.commands.executeCommand('byok-copilot.showLogs');
			return;

		case 'openSettings':
			await vscode.commands.executeCommand('byok-copilot.openSettings');
			return;

		case 'setApiKey':
			await vscode.commands.executeCommand('byok-copilot.setEndpointApiKey');
			return;

		default:
			return;
	}
}

interface PanelMessage {
	type: string;
	modelId?: string;
}

function isPanelMessage(value: unknown): value is PanelMessage {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as PanelMessage).type === 'string'
	);
}
