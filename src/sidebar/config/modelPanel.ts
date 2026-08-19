import vscode from 'vscode';
import { CONFIG_SECTION, MODEL_TEMPLATES } from '../../consts';
import {
	getEndpointByName,
	getResolvedStyleModel,
	type EndpointConfig,
	type EndpointModelEntry,
	type EndpointStyle,
} from '../../config';
import { getModelPanelHtml, type ModelConfigEntry, type ModelPanelState } from './modelHtml';

/** Single shared panel keyed by `${endpointName}@${modelId}`. */
let currentPanel: vscode.WebviewPanel | undefined;
let currentKey: string | undefined;

let configChangeSubscription: vscode.Disposable | undefined;

/**
 * Open (or reveal) the per-model configuration panel for the given
 * endpoint + model id. Per-model configuration takes priority over the
 * endpoint / style level defaults when it is present.
 */
export function openModelConfigPanel(endpointName: string, modelId: string): void {
	void openPanelFor(endpointName, modelId);
}

async function openPanelFor(endpointName: string, modelId: string): Promise<void> {
	const key = `${endpointName}@${modelId}`;
	if (currentPanel) {
		if (currentKey !== key) {
			await renderFor(currentPanel, endpointName, modelId);
		}
		currentPanel.reveal();
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'byokModelConfig',
		'BYOK 模型配置',
		vscode.ViewColumn.Active,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
		},
	);
	currentPanel = panel;
	configChangeSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration(`${CONFIG_SECTION}.endpoints`) && currentPanel && currentKey) {
			const [ep, m] = currentKey.split('@');
			void renderFor(currentPanel, ep, m);
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

	await renderFor(panel, endpointName, modelId);
}

async function buildState(endpointName: string, modelId: string): Promise<ModelPanelState | undefined> {
	const ep = getEndpointByName(endpointName);
	if (!ep) {
		return undefined;
	}
	const resolved = getResolvedStyleModel(endpointName, modelId);
	if (!resolved) {
		return undefined;
	}
	const style: EndpointStyle = resolved.style;
	const template = MODEL_TEMPLATES.find((m) => m.id === modelId);
	const isTemplateDefault = !!template && !resolved.modelEntry;

	const base: ModelConfigEntry = {
		id: modelId,
		family: template?.family ?? 'byok',
		version: template?.version ?? 'v4',
		detail: template?.detail,
		maxInputTokens: template?.maxInputTokens,
		maxOutputTokens: template?.maxOutputTokens,
		capabilities: template
			? {
					toolCalling: !!template.capabilities.toolCalling,
					imageInput: !!template.capabilities.imageInput,
					thinking: !!template.capabilities.thinking,
				}
			: { toolCalling: false, imageInput: false, thinking: false },
		requiresThinkingParam: template?.requiresThinkingParam,
		isTemplateDefault,
		priceCategory: template?.priceCategory,
	};

	// Per-model entry always wins when present (单独配置优先生效).
	const entry: ModelConfigEntry = resolved.modelEntry
		? { ...base, ...(resolved.modelEntry as EndpointModelEntry), id: modelId, isTemplateDefault: false }
		: base;

	return { endpointName, modelId, style, entry };
}

async function renderFor(
	panel: vscode.WebviewPanel,
	endpointName: string,
	modelId: string,
): Promise<void> {
	const state = await buildState(endpointName, modelId);
	if (!state) {
		await panel.webview.postMessage({ type: 'notFound' });
		return;
	}
	currentKey = `${endpointName}@${modelId}`;
	panel.title = `BYOK 模型配置 — ${modelId} @ ${endpointName}`;
	panel.webview.html = getModelPanelHtml(panel.webview, state);
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
	const [endpointName, modelId] = currentKey.split('@');

	switch (message.type) {
		case 'save':
			await saveModelEntry(endpointName, modelId, message.value);
			break;
		case 'close':
			panel.dispose();
			break;
	}
}

async function saveModelEntry(
	endpointName: string,
	modelId: string,
	value: unknown,
): Promise<void> {
	const entry = value as Partial<EndpointModelEntry> & { id: string };
	if (!entry || entry.id !== modelId) {
		void showSaveError('模型 ID 不匹配');
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
	if (!normalized) {
		void showSaveError('端点不存在，可能已被删除');
		return;
	}
	const resolved = getResolvedStyleModel(endpointName, modelId);
	if (!resolved) {
		void showSaveError('模型不存在，可能已被删除');
		return;
	}

	const style = resolved.style;
	const styleConfig = normalized.styles[style];
	if (!styleConfig) {
		void showSaveError('风格配置缺失');
		return;
	}

	const newEntry: EndpointModelEntry = {
		id: modelId,
		...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
		...(entry.baseUrl ? { baseUrl: entry.baseUrl.replace(/\/+$/, '') } : {}),
		...(entry.authType ? { authType: entry.authType } : {}),
		...(entry.anthropicVersion ? { anthropicVersion: entry.anthropicVersion } : {}),
		...(entry.family ? { family: entry.family } : {}),
		...(entry.version ? { version: entry.version } : {}),
		...(entry.detail ? { detail: entry.detail } : {}),
		...(entry.maxInputTokens !== undefined ? { maxInputTokens: entry.maxInputTokens } : {}),
		...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
		...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
		...(entry.requiresThinkingParam !== undefined ? { requiresThinkingParam: entry.requiresThinkingParam } : {}),
		...(entry.priceCategory ? { priceCategory: entry.priceCategory } : {}),
	};

	const updatedModels = styleConfig.models.map((m) =>
		(typeof m === 'string' ? m : m.id) === modelId ? newEntry : m,
	);

	const updatedEndpoint: EndpointConfig = {
		...normalized,
		styles: {
			...normalized.styles,
			[style]: { ...styleConfig, models: updatedModels },
		},
	};

	raw[idx] = updatedEndpoint;
	try {
		await config.update('endpoints', raw, vscode.ConfigurationTarget.Global);
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
	vscode.window.showErrorMessage(`保存模型配置失败: ${message}`);
	if (currentPanel) {
		void currentPanel.webview.postMessage({ type: 'saveError', message });
	}
}

function showSaveSuccess(): void {
	vscode.window.showInformationMessage('模型配置已保存');
	if (currentPanel) {
		void currentPanel.webview.postMessage({ type: 'saveSuccess' });
	}
}
