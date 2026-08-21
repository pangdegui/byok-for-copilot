import vscode from 'vscode';
import { CONFIG_SECTION } from '../../../config/consts';
import {
	getEndpointByName,
	resolveEndpointsTarget,
	type EndpointConfig,
	type EndpointStyle,
	type EndpointStyleConfig,
} from '../../../config';
import { getStylePanelHtml, type StyleConfigEntry, type StylePanelState } from './styleHtml';

/** Single shared panel keyed by `${endpointName}@${style}`. */
let currentPanel: vscode.WebviewPanel | undefined;
let currentKey: string | undefined;

let configChangeSubscription: vscode.Disposable | undefined;

/**
 * Open (or reveal) the per-style configuration panel for the given
 * endpoint + style. Style-level configuration overrides the endpoint level
 * but is overridden by the per-model level.
 */
export function openStyleConfigPanel(endpointName: string, style: EndpointStyle): void {
	void openPanelFor(endpointName, style);
}

async function openPanelFor(endpointName: string, style: EndpointStyle): Promise<void> {
	const key = `${endpointName}@${style}`;
	if (currentPanel) {
		if (currentKey !== key) {
			await renderFor(currentPanel, endpointName, style);
		}
		currentPanel.reveal();
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'byokStyleConfig',
		'BYOK 风格配置',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
		},
	);
	currentPanel = panel;
	configChangeSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration(`${CONFIG_SECTION}.endpoints`) && currentPanel && currentKey) {
			const [ep, s] = currentKey.split('@');
			void renderFor(currentPanel, ep, s as EndpointStyle);
		}
	});

	panel.onDidDispose(() => {
		currentPanel = undefined;
		currentKey = undefined;
		configChangeSubscription?.dispose();
		configChangeSubscription = undefined;
	});

	panel.webview.onDidReceiveMessage((message: unknown) => {
		void handleMessage(panel, message);
	});

	await renderFor(panel, endpointName, style);
}

async function buildState(
	endpointName: string,
	style: EndpointStyle,
): Promise<StylePanelState | undefined> {
	const ep = getEndpointByName(endpointName);
	if (!ep) {
		return undefined;
	}
	const styleConfig = ep.styles[style];
	if (!styleConfig) {
		return undefined;
	}
	const entry: StyleConfigEntry = {
		baseUrl: styleConfig.baseUrl,
		authType: styleConfig.authType,
		anthropicVersion: styleConfig.anthropicVersion,
		supportsReasoningReplay: styleConfig.supportsReasoningReplay,
		proxy: styleConfig.proxy,
	};
	return {
		endpointName,
		style,
		modelCount: (styleConfig.models || []).length,
		entry,
		isNew: false,
	};
}

async function renderFor(
	panel: vscode.WebviewPanel,
	endpointName: string,
	style: EndpointStyle,
): Promise<void> {
	const state = await buildState(endpointName, style);
	if (!state) {
		await panel.webview.postMessage({ type: 'notFound' });
		return;
	}
	currentKey = `${endpointName}@${style}`;
	panel.title = `BYOK 风格配置 — ${style} @ ${endpointName}`;
	panel.webview.html = getStylePanelHtml(panel.webview, state);
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

async function handleMessage(panel: vscode.WebviewPanel, message: unknown): Promise<void> {
	if (!isPanelMessage(message) || !currentKey) {
		return;
	}
	const [endpointName, style] = currentKey.split('@');

	switch (message.type) {
		case 'save':
			await saveStyleEntry(endpointName, style as EndpointStyle, message.value);
			break;
		case 'close':
			panel.dispose();
			break;
	}
}

async function saveStyleEntry(
	endpointName: string,
	style: EndpointStyle,
	value: unknown,
): Promise<void> {
	const entry = value as Partial<EndpointStyleConfig>;
	if (typeof entry !== 'object' || entry === null) {
		void showSaveError('保存数据无效');
		return;
	}

	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<unknown[]>('endpoints', []);
	if (!Array.isArray(raw)) {
		void showSaveError('读取端点配置失败');
		return;
	}

	const idx = raw.findIndex(
		(e: unknown) =>
			typeof e === 'object' && e !== null && (e as Record<string, unknown>).name === endpointName,
	);
	if (idx === -1) {
		void showSaveError('端点不存在，可能已被删除');
		return;
	}

	const normalized = getEndpointByName(endpointName);
	if (!normalized || !normalized.styles[style]) {
		void showSaveError('风格配置缺失');
		return;
	}

	// Deterministic order: keep `models` first, then explicit style fields.
	const current = normalized.styles[style];
	const newEntry: EndpointStyleConfig = {
		models: current?.models || [],
		...(entry.baseUrl ? { baseUrl: entry.baseUrl.replace(/\/+$/, '') } : {}),
		...(entry.authType && entry.authType !== 'bearer' ? { authType: entry.authType } : {}),
		...(entry.anthropicVersion ? { anthropicVersion: entry.anthropicVersion } : {}),
		...(entry.supportsReasoningReplay !== undefined
			? { supportsReasoningReplay: entry.supportsReasoningReplay }
			: {}),
		...(entry.proxy ? { proxy: entry.proxy } : {}),
	};

	const updatedEndpoint: EndpointConfig = {
		...normalized,
		styles: {
			...normalized.styles,
			[style]: newEntry,
		},
	};

	raw[idx] = updatedEndpoint;
	try {
		await config.update('endpoints', raw, resolveEndpointsTarget(config));
		await refreshTree();
		void showSaveSuccess();
	} catch (error) {
		void showSaveError(String(error));
	}
}

async function refreshTree(): Promise<void> {
	await vscode.commands.executeCommand('byok-copilot.refreshEndpoints');
	try {
		await vscode.commands.executeCommand('byok-copilot.refreshModelPicker');
	} catch {
		// Command may not be registered — that's fine.
	}
}

function showSaveError(message: string): void {
	vscode.window.showErrorMessage(`保存风格配置失败: ${message}`);
	if (currentPanel) {
		void currentPanel.webview.postMessage({ type: 'saveError', message });
	}
}

function showSaveSuccess(): void {
	vscode.window.showInformationMessage('风格配置已保存');
	if (currentPanel) {
		void currentPanel.webview.postMessage({ type: 'saveSuccess' });
	}
}
