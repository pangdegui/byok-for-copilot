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
// Endpoints are organized as a three-tier structure:
//   Endpoint -> Style -> Model
//
// Each endpoint may declare one or more "styles" (the three API protocols are
// treated as equal peers):
//   - 'openai-chat'        OpenAI Chat / Completions API
//   - 'openai-responses'   OpenAI Responses API
//   - 'anthropic-messages' Anthropic Claude Messages API
// Models are attached to the style they belong to.
//
// The legacy flat format ({ name, baseUrl, models, protocol, anthropicVersion })
// is still accepted and normalized into the new `styles` structure.

/** The three API styles that an endpoint can expose. */
export type EndpointStyle = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/** All supported styles, in a stable order. */
export const ENDPOINT_STYLES: readonly EndpointStyle[] = [
	'openai-chat',
	'openai-responses',
	'anthropic-messages',
];

/** Map a legacy protocol enum value to its new style identifier. */
export function normalizeStyle(style: unknown): EndpointStyle {
	if (style === 'openai-responses') return 'openai-responses';
	if (style === 'anthropic-messages') return 'anthropic-messages';
	return 'openai-chat';
}

export interface EndpointModelEntry {
	id: string;
	baseUrl?: string;
	authType?: 'bearer' | 'x-api-key';
	protocol?: EndpointStyle;
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

/** Per-style configuration: the models exposed under a given style. */
export interface EndpointStyleConfig {
	models: (string | EndpointModelEntry)[];
	/** Optional per-style baseUrl override (falls back to the endpoint baseUrl). */
	baseUrl?: string;
	authType?: 'bearer' | 'x-api-key';
	/** Anthropic API version header — only meaningful for 'anthropic-messages'. */
	anthropicVersion?: string;
}

export interface EndpointConfig {
	name: string;
	baseUrl: string;
	/** Three-tier structure: this endpoint exposes zero or more styles. */
	styles: Partial<Record<EndpointStyle, EndpointStyleConfig>>;
}

/** Result of resolving a model id within an endpoint to its style + entry. */
export interface ResolvedStyleModel {
	style: EndpointStyle;
	styleConfig: EndpointStyleConfig;
	modelEntry?: EndpointModelEntry;
}

/**
 * Get all configured endpoint profiles from settings.
 * Legacy flat configs are normalized into the new three-tier `styles` shape.
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

function normalizeEndpointConfig(raw: unknown): EndpointConfig | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	if (typeof r.name !== 'string' || typeof r.baseUrl !== 'string') {
		return undefined;
	}
	const baseUrl = r.baseUrl.trim().replace(/\/+$/, '');
	const styles: Partial<Record<EndpointStyle, EndpointStyleConfig>> = {};

	// 1) New format: endpoint.styles.<style>.models
	const rawStyles = r.styles;
	if (rawStyles && typeof rawStyles === 'object' && !Array.isArray(rawStyles)) {
		for (const style of ENDPOINT_STYLES) {
			const sc = (rawStyles as Record<string, unknown>)[style];
			if (!sc || typeof sc !== 'object') {
				continue;
			}
			const scObj = sc as Record<string, unknown>;
			if (!Array.isArray(scObj.models)) {
				continue;
			}
			styles[style] = {
				models: scObj.models,
				baseUrl:
					typeof scObj.baseUrl === 'string'
						? scObj.baseUrl.trim().replace(/\/+$/, '')
						: undefined,
				authType: scObj.authType === 'x-api-key' ? 'x-api-key' : undefined,
				anthropicVersion:
					typeof scObj.anthropicVersion === 'string' ? scObj.anthropicVersion : undefined,
			};
		}
	}

	// 2) Legacy flat format: top-level models + protocol + anthropicVersion
	if (Array.isArray(r.models) && r.models.length > 0) {
		const style = normalizeStyle(r.protocol);
		styles[style] = {
			models: r.models,
			anthropicVersion:
				typeof r.anthropicVersion === 'string' ? r.anthropicVersion : undefined,
		};
	}

	if (Object.keys(styles).length === 0) {
		styles['openai-chat'] = { models: [] };
	}

	return { name: r.name, baseUrl, styles };
}

function endpointHasModel(ep: EndpointConfig, modelId: string): boolean {
	return getStylesForModel(ep, modelId).length > 0;
}

/**
 * List the styles within an endpoint that mount the given model ID.
 *
 * A model is only allowed to mount on a single style, so this normally returns
 * at most one style. (Identical model *configuration* objects across different
 * styles are allowed, but each model ID belongs to exactly one style.)
 */
export function getStylesForModel(ep: EndpointConfig, modelId: string): EndpointStyle[] {
	return ENDPOINT_STYLES.filter((s) => {
		const cfg = ep.styles[s];
		return !!cfg && (cfg.models ?? []).some((m) => (typeof m === 'string' ? m : m.id) === modelId);
	});
}

/** Flatten all model entries (strings or objects) across every style of an endpoint. */
export function getAllEndpointModels(ep: EndpointConfig): (string | EndpointModelEntry)[] {
	const out: (string | EndpointModelEntry)[] = [];
	for (const style of ENDPOINT_STYLES) {
		const cfg = ep.styles[style];
		if (cfg) {
			out.push(...cfg.models);
		}
	}
	return out;
}

/** All model ids exposed by an endpoint (across all styles). */
export function getEndpointModelIds(ep: EndpointConfig): string[] {
	return getAllEndpointModels(ep).map((m) => (typeof m === 'string' ? m : m.id));
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
 * optional per-model entry.
 */
export function getResolvedStyleModel(
	endpointName: string,
	modelId: string,
): ResolvedStyleModel | undefined {
	const ep = getEndpointByName(endpointName);
	if (!ep) {
		return undefined;
	}
	for (const style of ENDPOINT_STYLES) {
		const cfg = ep.styles[style];
		if (!cfg) {
			continue;
		}
		const entry = (cfg.models ?? []).find(
			(m) => (typeof m === 'string' ? m : m.id) === modelId,
		);
		if (entry) {
			return {
				style,
				styleConfig: cfg,
				modelEntry: typeof entry === 'object' ? entry : undefined,
			};
		}
	}
	return undefined;
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
	return resolved.modelEntry?.baseUrl?.replace(/\/+$/, '') || resolved.styleConfig.baseUrl;
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
