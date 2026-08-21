import vscode from 'vscode';
import { CONFIG_SECTION, MODEL_TEMPLATES } from '../../../config/consts';
import {
	getEndpointByName,
	getResolvedStyleModel,
	resolveEndpointsTarget,
	type EndpointConfig,
	type EndpointModelEntry,
	type EndpointStyle,
} from '../../../config';
import { logger } from '../../../logger';
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
	logger.info(`[modelPanel] openModelConfigPanel called: endpoint=${endpointName} model=${modelId}`);
	void openPanelFor(endpointName, modelId);
}

async function openPanelFor(endpointName: string, modelId: string): Promise<void> {
	const key = `${endpointName}@${modelId}`;
	if (currentPanel) {
		if (currentKey !== key) {
			logger.info(`[modelPanel] reusing existing panel, switching key ${currentKey} -> ${key}`);
			await renderFor(currentPanel, endpointName, modelId);
		}
		logger.info(`[modelPanel] revealing existing panel for ${key}`);
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
	logger.info(`[modelPanel] webview panel created for ${key}`);
	configChangeSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration(`${CONFIG_SECTION}.endpoints`) && currentPanel && currentKey) {
			logger.debug(`[modelPanel] config change affects endpoints, re-rendering ${currentKey}`);
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
		try {
		logger.debug(`[modelPanel] webview -> extension message: ${JSON.stringify(message)}`);
		void handleMessage(panel, message);
		} catch (err) {
			logger.error(`[modelPanel] onDidReceiveMessage threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
		}
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
			: { toolCalling: true, imageInput: false, thinking: false },
		isTemplateDefault,
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
		logger.warn(`[modelPanel] buildState returned undefined for ${endpointName}@${modelId} (endpoint or model not found)`);
		await panel.webview.postMessage({ type: 'notFound' });
		return;
	}
	currentKey = `${endpointName}@${modelId}`;
	logger.info(`[modelPanel] renderFor OK: key=${currentKey} style=${state.style} entry=${JSON.stringify(state.entry)}`);
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
		logger.warn(`[modelPanel] handleMessage ignored: isPanelMessage=${isPanelMessage(message)} currentKey=${currentKey}`);
		return;
	}
	const [endpointName, modelId] = currentKey.split('@');
	logger.info(`[modelPanel] handleMessage type=${message.type} for ${currentKey}`);

	switch (message.type) {
		case 'log':
			logger.info(`[modelPanel][webview] ${String((message as { value?: unknown }).value ?? '')}`);
			break;
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
	logger.show();
	logger.info(`[modelPanel] saveModelEntry start: endpoint=${endpointName} model=${modelId} value=${JSON.stringify(value)}`);
	const entry = value as Partial<EndpointModelEntry> & { id: string };
	if (!entry || entry.id !== modelId) {
		logger.error(`[modelPanel] save aborted: entry empty or id mismatch (entry.id=${entry?.id}, expected=${modelId})`);
		void showSaveError('模型 ID 不匹配');
		return;
	}

	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<unknown[]>('endpoints', []);
	if (!Array.isArray(raw)) {
		logger.error(`[modelPanel] save aborted: 'endpoints' config is not an array`);
		void showSaveError('读取端点配置失败');
		return;
	}
	logger.debug(`[modelPanel] loaded ${raw.length} endpoint(s) from config`);

	const idx = raw.findIndex(
		(e: unknown) =>
			typeof e === 'object' && e !== null && (e as Record<string, unknown>).name === endpointName,
	);
	if (idx === -1) {
		logger.error(`[modelPanel] save aborted: endpoint "${endpointName}" not found in config`);
		void showSaveError('端点不存在，可能已被删除');
		return;
	}

	const normalized = getEndpointByName(endpointName);
	if (!normalized) {
		logger.error(`[modelPanel] save aborted: getEndpointByName("${endpointName}") returned undefined`);
		void showSaveError('端点不存在，可能已被删除');
		return;
	}
	const resolved = getResolvedStyleModel(endpointName, modelId);
	if (!resolved) {
		logger.error(`[modelPanel] save aborted: getResolvedStyleModel("${endpointName}","${modelId}") returned undefined`);
		void showSaveError('模型不存在，可能已被删除');
		return;
	}

	const style = resolved.style;
	const styleConfig = normalized.styles[style];
	if (!styleConfig) {
		logger.error(`[modelPanel] save aborted: style "${style}" config missing`);
		void showSaveError('风格配置缺失');
		return;
	}
	logger.debug(`[modelPanel] resolved style=${style}, current models=${JSON.stringify(styleConfig.models)}`);

	// Preserve any previously-saved fields (e.g. capabilities) the form no longer
	// edits, so removing the capability controls is non-destructive.
	const existingEntry =
		resolved.modelEntry && typeof resolved.modelEntry === 'object'
			? { ...(resolved.modelEntry as EndpointModelEntry) }
			: {};

	const newEntry: EndpointModelEntry = {
		id: modelId,
		...existingEntry,
		...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
		...(entry.baseUrl ? { baseUrl: entry.baseUrl.replace(/\/+$/, '') } : {}),
		...(entry.authType ? { authType: entry.authType } : {}),
		...(entry.proxy ? { proxy: entry.proxy } : {}),
		...(entry.anthropicVersion ? { anthropicVersion: entry.anthropicVersion } : {}),
		...(entry.family ? { family: entry.family } : {}),
		...(entry.version ? { version: entry.version } : {}),
		...(entry.detail ? { detail: entry.detail } : {}),
		...(entry.maxInputTokens !== undefined ? { maxInputTokens: entry.maxInputTokens } : {}),
		...(entry.maxOutputTokens !== undefined ? { maxOutputTokens: entry.maxOutputTokens } : {}),
		...(entry.thinkingEfforts !== undefined && entry.thinkingEfforts.length > 0
			? { thinkingEfforts: entry.thinkingEfforts }
			: {}),
		...(entry.tieredPricing !== undefined ? { tieredPricing: entry.tieredPricing } : {}),
		// visionPrompt: model-level override of the global setting. Empty string clears it.
		...(entry.visionPrompt !== undefined && entry.visionPrompt
			? { visionPrompt: entry.visionPrompt }
			: {}),
	};

	// Explicitly clear the override when the field is emptied.
	if (entry.visionPrompt !== undefined && !entry.visionPrompt) {
		delete (newEntry as unknown as Record<string, unknown>).visionPrompt;
	}
	// Empty thinkingEfforts array = fall back to the default full list.
	if (entry.thinkingEfforts !== undefined && entry.thinkingEfforts.length === 0) {
		delete (newEntry as unknown as Record<string, unknown>).thinkingEfforts;
	}
	// Empty/invalid tieredPricing = clear it entirely.
	if (
		entry.tieredPricing !== undefined &&
		(!entry.tieredPricing.tiers || entry.tieredPricing.tiers.length === 0)
	) {
		delete (newEntry as unknown as Record<string, unknown>).tieredPricing;
	}

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
		const target = resolveEndpointsTarget(config);
		logger.info(`[modelPanel] writing 'endpoints' to ConfigurationTarget=${target === vscode.ConfigurationTarget.Workspace ? 'Workspace' : 'Global'}`);
		await config.update('endpoints', raw, resolveEndpointsTarget(config));
		logger.info(`[modelPanel] config.update('endpoints') resolved OK`);
		await refreshTree();
		void showSaveSuccess();
	} catch (error) {
		logger.error(`[modelPanel] config.update threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		void showSaveError(String(error));
	}
}

async function refreshTree(): Promise<void> {
	logger.info(`[modelPanel] refreshTree: refreshing endpoints sidebar`);
	await vscode.commands.executeCommand('byok-copilot.refreshEndpoints');
	try {
		logger.debug(`[modelPanel] refreshTree: also refreshing model picker`);
		await vscode.commands.executeCommand('byok-copilot.refreshModelPicker');
	} catch {
		// Command may not be registered — that's fine.
		logger.debug(`[modelPanel] refreshTree: refreshModelPicker not registered (ignored)`);
	}
}

function showSaveError(message: string): void {
	logger.error(`[modelPanel] showSaveError: ${message}`);
	vscode.window.showErrorMessage(`保存模型配置失败: ${message}`);
	if (currentPanel) {
		void currentPanel.webview.postMessage({ type: 'saveError', message });
	}
}

function showSaveSuccess(): void {
	logger.info(`[modelPanel] showSaveSuccess: 模型配置已保存`);
	vscode.window.showInformationMessage('模型配置已保存');
	if (currentPanel) {
		void currentPanel.webview.postMessage({ type: 'saveSuccess' });
	}
}
