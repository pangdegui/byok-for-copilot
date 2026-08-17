import vscode from 'vscode';
import { getDebugMode, getEndpoints } from '../config';
import { getStatsPanelHtml, type StatsPanelState } from './html';
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
