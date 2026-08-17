import vscode from 'vscode';
import { CONFIG_SECTION } from './consts';

export type DebugMode = 'minimal' | 'metadata' | 'verbose';

/**
 * Resolve the API model ID to send to the endpoint.
 *
 * Users can override model IDs via the `modelIdOverrides` setting object
 * (e.g. for third-party API proxies). Falls back to the VS Code model ID
 * when no override is configured.
 */
export function getApiModelId(vscodeModelId: string): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const overrides = config.get<Record<string, string>>('modelIdOverrides');
	const override = overrides?.[vscodeModelId]?.trim();
	return override || vscodeModelId;
}

/**
 * Get the configured max output tokens limit.
 * Returns `undefined` when set to 0 (API default — no limit).
 */
export function getMaxTokens(): number | undefined {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<number>('maxTokens', 0);
	return value > 0 ? value : undefined;
}

/**
 * Diagnostic mode. `verbose` also enables metadata logs.
 *
 * The legacy boolean `debug` setting is still read as a fallback so old
 * settings keep working even if migration cannot update every scope.
 */
export function getDebugMode(): DebugMode {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const mode = getConfiguredDebugMode(config);
	if (mode) return mode;

	return config.get<boolean>('debug', false) ? 'metadata' : 'minimal';
}

/**
 * Whether to log privacy-preserving diagnostic debug information.
 */
export function getDebugLoggingEnabled(): boolean {
	return getDebugMode() !== 'minimal';
}

/**
 * Whether to write full API request payloads to disk.
 */
export function getRequestDumpEnabled(): boolean {
	return getDebugMode() === 'verbose';
}

export function getStabilizeToolListEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('experimental.stabilizeToolList', false);
}

/**
 * Whether to report per-request token usage to the local Copilot Chat UI
 * (process-internal `LanguageModelDataPart`, used to display token counts).
 *
 * Defaults to `false` (privacy-first): usage is still recorded locally for
 * the built-in statistics and token-count calibration, but no usage data is
 * handed to the VS Code Copilot Chat process.
 */
export function getReportUsageToChatEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('privacy.reportUsageToChat', false);
}

/**
 * Migrate the legacy boolean `byok-copilot.debug` setting to `debugMode`.
 *
 * `debug: true` maps to `debugMode: metadata`; `debug: false` maps to the
 * default `minimal`, so it only needs cleanup.
 */
export async function migrateLegacyDebugSetting(): Promise<void> {
	await migrateLegacyDebugSettingAtScope(vscode.ConfigurationTarget.Global);
	if (vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length) {
		await migrateLegacyDebugSettingAtScope(vscode.ConfigurationTarget.Workspace);
	}
}

function getConfiguredDebugMode(config: vscode.WorkspaceConfiguration): DebugMode | undefined {
	const mode = config.inspect<unknown>('debugMode');
	return normalizeDebugMode(mode?.workspaceValue) ?? normalizeDebugMode(mode?.globalValue);
}

function normalizeDebugMode(value: unknown): DebugMode | undefined {
	if (value === 'minimal' || value === 'metadata' || value === 'verbose') {
		return value;
	}
	return undefined;
}

async function migrateLegacyDebugSettingAtScope(
	target: vscode.ConfigurationTarget,
	resource?: vscode.Uri,
): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
	const legacy = config.inspect<boolean>('debug');
	const mode = config.inspect<DebugMode>('debugMode');
	const legacyValue = getScopedValue(legacy, target);

	if (legacyValue === undefined) {
		return;
	}

	if (legacyValue === true && getScopedValue(mode, target) === undefined) {
		await config.update('debugMode', 'metadata', target);
	}
	await config.update('debug', undefined, target);
}

function getScopedValue<T>(
	inspection:
		| {
				globalValue?: T;
				workspaceValue?: T;
				workspaceFolderValue?: T;
		  }
		| undefined,
	target: vscode.ConfigurationTarget,
): T | undefined {
	if (!inspection) {
		return undefined;
	}

	if (target === vscode.ConfigurationTarget.Global) {
		return inspection.globalValue;
	}
	if (target === vscode.ConfigurationTarget.Workspace) {
		return inspection.workspaceValue;
	}
	return undefined;
}

// ---- Endpoint management ----

export interface EndpointModelEntry {
	id: string;
	baseUrl?: string;
	authType?: 'bearer' | 'x-api-key';
	protocol?: 'openai-completions' | 'anthropic-messages';
	anthropicVersion?: string;
	displayName?: string;
	family?: string;
	version?: string;
	detail?: string;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	capabilities?: {
		toolCalling: boolean | number;
		imageInput: boolean;
		thinking: boolean;
	};
	requiresThinkingParam?: boolean;
	pricing?: Record<string, unknown>;
	priceCategory?: string;
}

export interface EndpointConfig {
	name: string;
	baseUrl: string;
	models: (string | EndpointModelEntry)[];
	protocol?: 'openai-completions' | 'anthropic-messages';
	anthropicVersion?: string;
}

/**
 * Get all configured endpoint profiles from settings.
 */
export function getEndpoints(): EndpointConfig[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const endpoints = config.get<unknown[]>('endpoints', []);
	if (!Array.isArray(endpoints)) return [];
	return endpoints.filter(
		(e): e is EndpointConfig =>
			typeof e === 'object' && e !== null &&
			typeof (e as Record<string, unknown>).name === 'string' &&
			typeof (e as Record<string, unknown>).baseUrl === 'string' &&
			Array.isArray((e as Record<string, unknown>).models),
	);
}

/**
 * Find the endpoint config for a given model ID.
 * Searches user endpoints first.
 * Returns the endpoint object or undefined.
 */
export function getEndpointForModel(modelId: string): EndpointConfig | undefined {
	const userEndpoints = getEndpoints();
	return userEndpoints.find((e) =>
		e.models.some((m) => (typeof m === 'string' ? m : m.id) === modelId),
	);
}

/**
 * Find the endpoint config by its name.
 */
export function getEndpointByName(name: string): EndpointConfig | undefined {
	const endpoints = getEndpoints();
	return endpoints.find((e) => e.name === name);
}

/**
 * Find the per-model baseUrl override for a model within an endpoint.
 * Returns undefined if the model doesn't have its own baseUrl.
 */
export function getModelBaseUrl(endpointName: string, modelId: string): string | undefined {
	const entry = getEndpointModelDef(endpointName, modelId);
	return entry?.baseUrl ? entry.baseUrl.replace(/\/+$/, '') : undefined;
}

/**
 * Find the full model entry object from an endpoint config by model ID.
 */
export function getEndpointModelDef(
	endpointName: string,
	modelId: string,
): EndpointModelEntry | undefined {
	const ep = getEndpointByName(endpointName);
	if (!ep) return undefined;
	for (const m of ep.models) {
		if (typeof m === 'object' && m.id === modelId) {
			return m;
		}
	}
	return undefined;
}
