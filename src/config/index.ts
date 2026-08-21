import vscode from 'vscode';
import { CONFIG_SECTION } from './consts';
import { parseTieredPricing, type TieredPricing } from '../copilot/pricing/tiered';
import {
	ENDPOINT_STYLES,
	normalizeBaseUrl,
	normalizeEndpointConfig,
	normalizeProxy,
	normalizeStyle,
	getStylesForModel,
	getAllEndpointModels,
	getEndpointModelIds,
	endpointHasModel,
	resolveStyleModel,
	type EndpointStyle,
	type ProxyMode,
	type ProxyConfig,
	type EndpointModelEntry,
	type EndpointStyleConfig,
	type EndpointConfig,
	type ResolvedStyleModel,
} from '../domain/profile-config';

export type DebugMode = 'minimal' | 'metadata' | 'verbose';

/**
 * Resolve which configuration scope an `endpoints` write should target.
 *
 * All endpoint/style/model panels edit the `byok-copilot.endpoints` array.
 * We must write back to the **same scope the value currently lives in** —
 * otherwise (with a hard-coded `ConfigurationTarget.Global`) a value stored
 * in the Workspace settings would be shadowed by the untouched Workspace copy
 * and the edit would appear to do nothing.
 *
 * Precedence: Workspace value > Global value > Global (fallback for new keys).
 */
export function resolveEndpointsTarget(
	config: vscode.WorkspaceConfiguration,
): vscode.ConfigurationTarget {
	const inspector = config.inspect<unknown[]>('endpoints');
	if (inspector?.workspaceValue !== undefined) {
		return vscode.ConfigurationTarget.Workspace;
	}
	return vscode.ConfigurationTarget.Global;
}

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
 * Whether reasoning replay (stateful `previous_response_id` or `encrypted_content`)
 * is enabled globally. Default `true` (stateful mode). When disabled, the
 * Responses API request is built without any reasoning-replay fields and
 * reasoning text falls back to plain `output_text`.
 *
 * Only takes effect for endpoints that also declare `supportsReasoningReplay`.
 */
export function getStoreReasoningEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('storeReasoning', true);
}

/**
 * Whether the resolved style/model supports Responses reasoning replay.
 * Based purely on the per-style `supportsReasoningReplay` flag from the
 * endpoint config. Callers decide the concrete mode via
 * `getStoreReasoningEnabled()`.
 */
export function isReasoningReplaySupported(
	endpointName: string,
	modelId: string,
): boolean {
	const resolved = getResolvedStyleModel(endpointName, modelId);
	return resolved?.styleConfig?.supportsReasoningReplay === true;
}

/**
 * Whether to report per-request token usage to the local Copilot Chat UI
 * (process-internal `LanguageModelDataPart`, used to display token counts).
 *
 * Defaults to `true` (shows token counts in the chat). Usage is always
 * recorded locally for the built-in statistics and token-count calibration;
 * this only controls whether the data is also handed to the local Copilot
 * Chat process for display. Disable it to keep usage entirely local.
 */
export function getReportUsageToChatEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('privacy.reportUsageToChat', true);
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
//
// Phase 1 (docs/ARCHITECTURE.md): the pure three-tier types + normalize/resolve
// logic now live in `domain/profile-config` (zero VS Code dependency).
// `config.ts` keeps only the VS Code-backed getters and re-exports the pure
// module so existing callers of `from '../config'` keep working unchanged.

// Re-export the pure profile-config contract (values + types) used by callers.
export {
	ENDPOINT_STYLES,
	normalizeStyle,
	normalizeProxy,
	normalizeBaseUrl,
	normalizeEndpointConfig,
	getStylesForModel,
	getAllEndpointModels,
	getEndpointModelIds,
	endpointHasModel,
	resolveStyleModel,
};
export type {
	EndpointStyle,
	ProxyMode,
	ProxyConfig,
	EndpointModelEntry,
	EndpointStyleConfig,
	EndpointConfig,
	ResolvedStyleModel,
};

/**
 * Get all configured endpoint profiles from settings.
 * Legacy flat configs are normalized into the new three-tier `styles` shape by
 * the pure `normalizeEndpointConfig` in `domain/profile-config`.
 */
export function getEndpoints(): EndpointConfig[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const endpoints = config.get<unknown[]>('endpoints', []);
	if (!Array.isArray(endpoints)) return [];
	const result: EndpointConfig[] = [];
	for (const raw of endpoints) {
		const normalized = normalizeEndpointConfig(raw);
		if (normalized) {
			result.push(normalized);
		}
	}
	return result;
}

/**
 * Find the endpoint config for a given model ID.
 * Searches user endpoints first (across all styles).
 * Returns the endpoint object or undefined.
 */
export function getEndpointForModel(modelId: string): EndpointConfig | undefined {
	const userEndpoints = getEndpoints();
	return userEndpoints.find((e) => endpointHasModel(e, modelId));
}

/**
 * Find the endpoint config by its name.
 */
export function getEndpointByName(name: string): EndpointConfig | undefined {
	const endpoints = getEndpoints();
	return endpoints.find((e) => e.name === name);
}

/**
 * Resolve a model id within an endpoint to its owning style, style config and
 * optional per-model entry. (Pure resolution lives in `resolveStyleModel`.)
 */
export function getResolvedStyleModel(
	endpointName: string,
	modelId: string,
): ResolvedStyleModel | undefined {
	const ep = getEndpointByName(endpointName);
	return ep ? resolveStyleModel(ep, modelId) : undefined;
}

/**
 * Find which style a model belongs to within an endpoint.
 * Returns undefined if the model isn't attached to the endpoint.
 */
export function getStyleForModel(endpointName: string, modelId: string): EndpointStyle | undefined {
	return getResolvedStyleModel(endpointName, modelId)?.style;
}

/**
 * Find the per-model / per-style baseUrl override for a model within an endpoint.
 * Precedence: per-model baseUrl > per-style baseUrl.
 */
export function getModelBaseUrl(endpointName: string, modelId: string): string | undefined {
	const resolved = getResolvedStyleModel(endpointName, modelId);
	if (!resolved) {
		return undefined;
	}
	const modelBaseUrl = resolved.modelEntry?.baseUrl;
	return modelBaseUrl ? normalizeBaseUrl(modelBaseUrl) : resolved.styleConfig.baseUrl;
}

/**
 * Resolve the effective proxy config for a model within an endpoint.
 * Precedence: per-model proxy > per-style proxy > endpoint proxy.
 * Falls back to `{ mode: 'system' }` when nothing is configured.
 */
export function getProxyConfig(endpointName: string, modelId: string): ProxyConfig {
	const resolved = getResolvedStyleModel(endpointName, modelId);
	const modelProxy = resolved?.modelEntry?.proxy;
	const styleProxy = resolved?.styleConfig?.proxy;
	const endpointProxy = getEndpointByName(endpointName)?.proxy;
	return modelProxy ?? styleProxy ?? endpointProxy ?? { mode: 'system' };
}

/**
 * Find the full model entry object from an endpoint config by model ID
 * (searching across all styles).
 */
export function getEndpointModelDef(
	endpointName: string,
	modelId: string,
): EndpointModelEntry | undefined {
	return getResolvedStyleModel(endpointName, modelId)?.modelEntry;
}

/**
 * Resolve the tiered pricing table for a model (per-million token unit prices
 * plus per-call tool price). Reads the live `endpoints` configuration.
 */
export function getModelTieredPricing(
	endpointName: string,
	modelId: string,
): TieredPricing | undefined {
	const entry = getEndpointModelDef(endpointName, modelId);
	if (!entry?.tieredPricing) {
		return undefined;
	}
	return parseTieredPricing(entry.tieredPricing);
}
