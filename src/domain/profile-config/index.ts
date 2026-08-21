// ============================================================================
// domain/profile-config — 三级端点/风格/模型配置的【纯类型 + 纯归一化/解析逻辑】
//
// 本模块是 **纯 TypeScript**:不 import vscode。输入/输出均为普通数据结构,
// 可脱离 VS Code 独立单测。VS Code 侧的读取与 Getter 留在 src/config.ts,
// 并由其 re-export 本模块的类型与纯函数,避免波及既有调用方。
//
// 设计目标(见 docs/ARCHITECTURE.md §1.5 / §3.2 ③domain·profile-config):
//   - 端点 EndpointConfig → 风格 EndpointStyleConfig → 模型 EndpointModelEntry
//   - 覆盖优先级(模型优先):baseUrl 模型>风格>端点;proxy 模型>风格>端点>system
//   - 保留旧平铺格式的兼容归一化(normalizeEndpointConfig)
// ============================================================================

/** The three API styles that an endpoint can expose. */
export type EndpointStyle = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

/** Proxy behavior for a request. */
export type ProxyMode = 'system' | 'direct' | 'proxy';

/**
 * Per-endpoint / per-style / per-model proxy configuration.
 *
 *   - 'system'  → follow the system environment proxy (EnvHttpProxyAgent).
 *   - 'direct'  → bypass any proxy and connect directly.
 *   - 'proxy'   → always use the fixed `url` proxy (http:// or https:// only).
 *
 * Precedence when resolving a model: model > style > endpoint.
 */
export interface ProxyConfig {
	mode: ProxyMode;
	/** Required when mode === 'proxy' (http:// or https://). */
	url?: string;
	/** Optional domains to bypass (NO_PROXY style), passed to the proxy agent. */
	noProxy?: string[];
}

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
	/** Per-model proxy override (takes priority over style / endpoint). */
	proxy?: ProxyConfig;
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
	/** Thinking effort levels offered to the VS Code model picker.
	 * Undefined/empty = full default list (none/high/max). */
	thinkingEfforts?: string[];
	pricing?: Record<string, unknown>;
	priceCategory?: string;
	/** 阶梯价格配置(每百万 token 单价 + 工具按次),用于用量计费估算。 */
	tieredPricing?: {
		default?: Record<string, unknown>;
		tiers?: Array<{ name?: string; table?: Record<string, unknown>; condition?: string }>;
	};
	/**
	 * Per-model vision description prompt override.
	 * Takes priority over the global `byok-copilot.visionPrompt` for this model.
	 * Leave undefined to inherit the global setting.
	 */
	visionPrompt?: string;
}

/** Per-style configuration: the models exposed under a given style. */
export interface EndpointStyleConfig {
	models: (string | EndpointModelEntry)[];
	/** Optional per-style baseUrl override (falls back to the endpoint baseUrl). */
	baseUrl?: string;
	authType?: 'bearer' | 'x-api-key';
	/** Per-style proxy override (takes priority over the endpoint, below model). */
	proxy?: ProxyConfig;
	/** Anthropic API version header — only meaningful for 'anthropic-messages'. */
	anthropicVersion?: string;
	/**
	 * Whether this style supports OpenAI Responses reasoning replay
	 * (server-side `store` / `previous_response_id`, or `encrypted_content`).
	 * When false (default), reasoning is serialized back as plain `output_text`.
	 * Only relevant for the `openai-responses` style.
	 */
	supportsReasoningReplay?: boolean;
}

export interface EndpointConfig {
	name: string;
	baseUrl: string;
	/** Endpoint-level proxy (lowest priority in model → style → endpoint). */
	proxy?: ProxyConfig;
	/** Three-tier structure: this endpoint exposes zero or more styles. */
	styles: Partial<Record<EndpointStyle, EndpointStyleConfig>>;
}

/** Result of resolving a model id within an endpoint to its style + entry. */
export interface ResolvedStyleModel {
	style: EndpointStyle;
	styleConfig: EndpointStyleConfig;
	modelEntry?: EndpointModelEntry;
}

// ---------------------------------------------------------------------------
// 纯归一化(输入为任意 JSON-ish 的 unknown,输出为规范化后的结构)
// ---------------------------------------------------------------------------

/** Trim trailing slashes so URLs compare/storage consistently. */
export function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, '');
}

/** Parse a raw `proxy` config object. Returns undefined when absent/invalid. */
export function normalizeProxy(raw: unknown): ProxyConfig | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	const mode: ProxyMode = r.mode === 'direct' || r.mode === 'proxy' ? r.mode : 'system';
	const cfg: ProxyConfig = { mode };
	if (typeof r.url === 'string' && r.url.trim()) {
		cfg.url = r.url.trim();
	}
	if (Array.isArray(r.noProxy)) {
		const list = r.noProxy.filter((x): x is string => typeof x === 'string');
		if (list.length) {
			cfg.noProxy = list;
		}
	}
	return cfg;
}

/**
 * Normalize a raw endpoint config into the three-tier `styles` shape.
 * Accepts both the new `{ name, baseUrl, styles }` format and the legacy flat
 * `{ name, baseUrl, models, protocol, anthropicVersion, proxy }` format.
 * Returns undefined when the entry is not a usable endpoint.
 */
export function normalizeEndpointConfig(raw: unknown): EndpointConfig | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}
	const r = raw as Record<string, unknown>;
	if (typeof r.name !== 'string' || typeof r.baseUrl !== 'string') {
		return undefined;
	}
	const baseUrl = normalizeBaseUrl(r.baseUrl);
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
					typeof scObj.baseUrl === 'string' ? normalizeBaseUrl(scObj.baseUrl) : undefined,
				authType: scObj.authType === 'x-api-key' ? 'x-api-key' : undefined,
				anthropicVersion:
					typeof scObj.anthropicVersion === 'string' ? scObj.anthropicVersion : undefined,
				proxy: normalizeProxy(scObj.proxy),
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
			proxy: normalizeProxy(r.proxy),
		};
	}

	if (Object.keys(styles).length === 0) {
		styles['openai-chat'] = { models: [], proxy: normalizeProxy(r.proxy) };
	}

	return {
		name: r.name,
		baseUrl,
		proxy: normalizeProxy(r.proxy),
		styles,
	};
}

// ---------------------------------------------------------------------------
// 纯解析(基于已给定的 EndpointConfig 对象,不做任何配置读取)
// ---------------------------------------------------------------------------

/** Whether an endpoint mounts the given model on any of its styles. */
export function endpointHasModel(ep: EndpointConfig, modelId: string): boolean {
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
 * Resolve a model id within an **already-loaded** endpoint config to its owning
 * style and optional per-model entry. Pure: unlike `getResolvedStyleModel` in
 * `src/config.ts`, this does not read any VS Code settings.
 */
export function resolveStyleModel(
	ep: EndpointConfig,
	modelId: string,
): ResolvedStyleModel | undefined {
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
