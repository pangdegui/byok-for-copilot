import vscode from 'vscode';
import { CONFIG_SECTION } from '../../../config/consts';
import { getEndpointByName } from '../../../config';
import { resolveEndpointsTarget } from '../../../config';
import { getEndpointPanelHtml } from './html';

let currentPanel: vscode.WebviewPanel | undefined;
let currentEndpointName: string | undefined;

/** A subscription that refreshes when endpoints config changes (fires only while panel is open). */
let configChangeSubscription: vscode.Disposable | undefined;

/**
 * Open (or reveal) the endpoint configuration panel for the given endpoint name.
 */
export function openEndpointConfigPanel(endpointName: string): void {
	void openPanelFor(endpointName);
}

async function openPanelFor(endpointName: string): Promise<void> {
	if (currentPanel) {
		// Reuse the existing panel but switch to a different endpoint if needed.
		if (currentEndpointName !== endpointName) {
			await renderFor(currentPanel, endpointName);
		}
		currentPanel.reveal();
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'byokEndpointConfig',
		'BYOK 端点配置',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
		},
	);
	currentPanel = panel;
	configChangeSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration(`${CONFIG_SECTION}.endpoints`) && currentPanel) {
			void renderFor(currentPanel, currentEndpointName!);
		}
	});

	panel.onDidDispose(() => {
		currentPanel = undefined;
		currentEndpointName = undefined;
		configChangeSubscription?.dispose();
		configChangeSubscription = undefined;
	});

	panel.webview.onDidReceiveMessage((message: unknown) => {
		void handleMessage(panel, message);
	});

	await renderFor(panel, endpointName);
}

async function renderFor(panel: vscode.WebviewPanel, endpointName: string): Promise<void> {
	const ep = getEndpointByName(endpointName);
	if (!ep) {
		await panel.webview.postMessage({ type: 'notFound' });
		return;
	}
	currentEndpointName = endpointName;
	panel.title = `BYOK 端点配置 — ${endpointName}`;
	panel.webview.html = getEndpointPanelHtml(panel.webview, { endpoint: ep, canDelete: true });
}

async function handleMessage(panel: vscode.WebviewPanel, message: unknown): Promise<void> {
	if (!isPanelMessage(message) || !currentEndpointName) {
		return;
	}

	switch (message.type) {
		case 'save':
			await saveEndpoint(currentEndpointName, message.value);
			break;

		case 'close':
			panel.dispose();
			break;

		case 'delete':
			await deleteEndpoint(currentEndpointName, panel);
			break;
	}
}

async function saveEndpoint(endpointName: string, value: unknown): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<unknown[]>('endpoints', []);
	if (!Array.isArray(raw)) {
		void showSaveError('读取端点配置失败');
		return;
	}

	const data = value as {
		name: string;
		baseUrl: string;
		styles: Record<string, unknown>;
		proxy?: { mode: string; url?: string };
	};
	const idx = raw.findIndex(
		(e: unknown) =>
			typeof e === 'object' && e !== null && (e as Record<string, unknown>).name === endpointName,
	);
	if (idx === -1) {
		void showSaveError('端点不存在，可能已被删除');
		return;
	}

	const updated: Record<string, unknown> = {
		name: data.name,
		baseUrl: data.baseUrl.replace(/\/+$/, ''),
		styles: data.styles,
	};
	if (data.proxy) {
		updated.proxy = data.proxy;
	}
	const renamed = data.name !== endpointName;
	if (renamed && raw.some((e) => (e as Record<string, unknown>).name === data.name)) {
		void showSaveError('已存在同名端点');
		return;
	}

	raw[idx] = updated;
	try {
		await config.update('endpoints', raw, resolveEndpointsTarget(config));
		await refreshEndpointsTree();
		if (renamed) {
			currentEndpointName = data.name;
		}
		void showSaveSuccess();
	} catch (error) {
		void showSaveError(String(error));
	}
}

async function deleteEndpoint(
	endpointName: string,
	panel: vscode.WebviewPanel,
): Promise<void> {
	const confirm = await vscode.window.showWarningMessage(
		`确定要删除端点 "${endpointName}" 吗？`,
		{ modal: true },
		'删除',
	);
	if (confirm !== '删除') {
		return;
	}

	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<unknown[]>('endpoints', []);
	const filtered = (Array.isArray(raw) ? raw : []).filter(
		(e: unknown) =>
			!(typeof e === 'object' && e !== null && (e as Record<string, unknown>).name === endpointName),
	);
	await config.update('endpoints', filtered, resolveEndpointsTarget(config));
	await refreshEndpointsTree();
	panel.dispose();
	vscode.window.showInformationMessage(`端点 "${endpointName}" 已删除`);
}

async function refreshEndpointsTree(): Promise<void> {
	await vscode.commands.executeCommand('byok-copilot.refreshEndpoints');
	// Force the provider to re-query model info so the picker reflects changes.
	try {
		await vscode.commands.executeCommand('byok-copilot.refreshModelPicker');
	} catch {
		// Command may not be registered — that's fine.
	}
}

function showSaveError(message: string): void {
	vscode.window.showErrorMessage(`保存端点配置失败: ${message}`);
	if (currentPanel) {
		void currentPanel.webview.postMessage({ type: 'saveError', message });
	}
}

function showSaveSuccess(): void {
	vscode.window.showInformationMessage('端点配置已保存');
	if (currentPanel) {
		void currentPanel.webview.postMessage({ type: 'saveSuccess' });
	}
}

interface PanelMessage {
	type: string;
	value?: unknown;
}

function isPanelMessage(value: unknown): value is PanelMessage {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as PanelMessage).type === 'string'
	);
}
