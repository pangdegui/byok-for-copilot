import vscode from 'vscode';
import { AuthManager } from '../config/auth';
import {
	createClient,
	getRequestBodyBuilder,
	resolveReasoningReplay,
	type ReasoningReplayConfig,
} from '../backend';
import { getApiModelId, getMaxTokens, getEndpointForModel, getEndpointByName, getModelBaseUrl, getModelTieredPricing, getProxyConfig, getResolvedStyleModel, type EndpointStyle } from '../config';
import { getDispatcher } from '../capability/proxy';
import { MODEL_TEMPLATES } from '../config/consts';
import { t } from '../i18n';
import type { BYOKMessage, BYOKTool } from '../types';
import { convertMessages, countMessageChars } from '../capability/tools/convert';
import {
	dumpApiRequest,
	type CacheDiagnosticsRecorder,
	type CacheDiagnosticsRun,
} from '../copilot/debug';
import { getConfiguredThinkingEffort, type ModelConfigurationOptions } from '../domain/model/models';
import { classifyApiRequest, type RequestKind } from '../capability/routing';
import type { ReplayMarkerMetadata } from '../capability/replay';
import type { ConversationSegment } from '../capability/segment';
import { collectTrailingToolResultIds, prepareRequestTools } from '../capability/tools/request';
import { resolveImageMessages, type VisionDescriber } from '../capability/vision';
import { pickTierTable, type PriceTable } from '../copilot/pricing/tiered';

export interface PreparedChatRequest {
	client: ReturnType<typeof createClient>;
	request: Record<string, unknown>;
	/** Configured API style (openai-chat / openai-responses / anthropic-messages).
	 * Drives cache-format interpretation for the reported usage. */
	style: EndpointStyle;
	/** Extension globalStorageUri, used to locate the request-dumps directory. */
	globalStorageUri: vscode.Uri;
	/** VS Code model id, e.g. `deepseek-v4-flash@opencode`. */
	vscodeModelId: string;
	/** Upstream API model id actually sent to the endpoint. */
	apiModelId: string;
	isThinkingModel: boolean;
	totalRequestChars: number;
	trailingToolResultIds: string[];
	cacheDiagnostics: CacheDiagnosticsRun;
	requestKind: RequestKind;
	segment: ConversationSegment;
	replayMarkerMetadata: ReplayMarkerMetadata;
	visionMarkerTextChars?: number;
	initialResponseNotice?: string;
	/** Per-million-token price table for cost estimation (undefined = unpriced). */
	pricingTable?: PriceTable;
}

export interface PrepareChatRequestOptions {
	authManager: AuthManager;
	globalStorageUri: vscode.Uri;
	modelInfo: vscode.LanguageModelChatInformation;
	segment: ConversationSegment;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	token: vscode.CancellationToken;
	cacheDiagnostics: CacheDiagnosticsRecorder;
	getVisionDescriber: () => Promise<VisionDescriber | undefined>;
}

export async function prepareChatRequest({
	authManager,
	globalStorageUri,
	modelInfo,
	segment,
	messages,
	options,
	token,
	cacheDiagnostics,
	getVisionDescriber,
}: PrepareChatRequestOptions): Promise<PreparedChatRequest> {
	// 解析模型 ID：支持 "api-v4-flash@端点名" 格式
	const atIndex = modelInfo.id.indexOf('@');
	const baseModelId = atIndex >= 0 ? modelInfo.id.slice(0, atIndex) : modelInfo.id;
	const endpointNameFromId = atIndex >= 0 ? modelInfo.id.slice(atIndex + 1) : undefined;

	// 按端点名查找或按模型 ID 查找
	const endpoint = endpointNameFromId
		? getEndpointByName(endpointNameFromId)
		: getEndpointForModel(modelInfo.id);
	const endpointName = endpoint?.name;
	if (!endpointName) {
		throw new Error(t('auth.notConfigured'));
	}

	const apiKey = await authManager.getApiKeyForEndpoint(endpointName);
	if (!apiKey) {
		throw new Error(t('auth.notConfigured'));
	}

	// Resolve which style (openai-chat / openai-responses / anthropic-messages)
	// this model belongs to within the endpoint — the three-tier
	// endpoint -> style -> model structure.
	const resolved = endpointName ? getResolvedStyleModel(endpointName, baseModelId) : undefined;
	const style: EndpointStyle = resolved?.style ?? 'openai-chat';
	const styleConfig = resolved?.styleConfig;
	const endpointModelDef = resolved?.modelEntry;

	// baseUrl precedence: per-model override > per-style override > endpoint baseUrl
	const modelBaseUrl = getModelBaseUrl(endpointName, baseModelId);
	const baseUrl = modelBaseUrl || endpoint.baseUrl.replace(/\/+$/, '');
	const authType = endpointModelDef?.authType || styleConfig?.authType || 'bearer';
	const anthropicVersion = endpointModelDef?.anthropicVersion || styleConfig?.anthropicVersion;
	const proxyConfig = getProxyConfig(endpointName, baseModelId);
	const dispatcher = getDispatcher(proxyConfig);

	const client = createClient(style, baseUrl, apiKey, {
		authType,
		anthropicVersion,
		dispatcher,
	});

	const modelDef = MODEL_TEMPLATES.find((m) => m.id === baseModelId) || endpointModelDef || MODEL_TEMPLATES[0];
	const isThinkingModel = modelDef?.capabilities?.thinking ?? false;
	const maxTokens = getMaxTokens();

	// Reasoning replay (OpenAI Responses style only). The whole decision —
	// whether it applies, which mode, and the previous `response.id` to chain
	// onto — lives inside the backend style module; Chat/Claude styles are
	// unaffected.
	const reasoningConfig: ReasoningReplayConfig = resolveReasoningReplay({
		style,
		endpointName,
		baseModelId,
		segmentId: segment.segmentId,
		isThinkingModel,
	});

	const visionResolution = await resolveImageMessages(
		messages,
		token,
		getVisionDescriber,
		endpointModelDef?.visionPrompt,
	);
	const resolvedMessages = visionResolution.messages;
	const apiMessages = convertMessages(resolvedMessages, isThinkingModel);
	// Every model accepts the tool set — pass it through unconditionally. If the
	// tool list grows too large, the experimental `stabilizeToolList` switch
	// handles compressing the `activate_*` virtual tools (tools/flow.ts).
	const tools = prepareRequestTools(options);
	const totalRequestChars = countMessageChars(apiMessages);

	// Build the wire request body via the style-specific builder. Each style
	// implements `RequestBodyBuilder` (backend/<style>/request.ts) and
	// owns both the base shape and the thinking/reasoning finalize step, so the
	// classification below runs against the final request.
	const configuredThinkingEffort = getConfiguredThinkingEffort(
		options as ModelConfigurationOptions,
	);
	const thinkingEffort = configuredThinkingEffort;

	const request: Record<string, unknown> = getRequestBodyBuilder(style).buildRequest({
		baseModelId,
		messages: apiMessages,
		tools,
		maxTokens,
		isThinkingModel,
		thinkingEffort,
		reasoning: reasoningConfig,
	});

	// Classify using the canonical `BYOKTool[]` shape. `request.tools` has
	// already been flattened to the wire format ({ type, name, ... }) by the
	// Responses builder, so reading `tool.function.name` off it would throw.
	// Use the still-canonical `tools` value for classification instead.
	const requestKind = classifyApiRequest({
		request: { ...request, tools } as unknown as import('../types').BYOKRequest,
		inputMessages: messages,
	} as { request: import('../types').BYOKRequest; inputMessages: readonly vscode.LanguageModelChatRequestMessage[] | undefined });

	dumpApiRequest(request as unknown as import('../types').BYOKRequest, {
		globalStorageUri,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort,
		maxTokens,
		inputMessages: messages,
		resolvedMessages,
		requestOptions: options,
		visionModelId: visionResolution.visionModelId,
		visionProxySource: visionResolution.visionProxySource,
		visionStats: visionResolution.stats,
	});

	const diagnosticsRun = cacheDiagnostics.beginRequest({
		request: request as unknown as import('../types').BYOKRequest,
		segment,
		requestKind,
		vscodeModelId: modelInfo.id,
		isThinkingModel,
		thinkingEffort,
		maxTokens,
		inputMessages: messages,
		resolvedMessages,
		style,
		visionModelId: visionResolution.visionModelId,
		visionProxySource: visionResolution.visionProxySource,
		visionStats: visionResolution.stats,
	});

	return {
		client,
		request,
		style,
		globalStorageUri,
		vscodeModelId: modelInfo.id,
		apiModelId: getApiModelId(baseModelId),
		isThinkingModel,
		totalRequestChars,
		trailingToolResultIds: collectTrailingToolResultIds(apiMessages),
		cacheDiagnostics: diagnosticsRun,
		requestKind,
		segment,
		replayMarkerMetadata: visionResolution.replayMarkerMetadata,
		visionMarkerTextChars: visionResolution.stats.markerVisionTextChars || undefined,
		initialResponseNotice: visionResolution.initialResponseNotice,
		pricingTable: (() => {
			const pricing = getModelTieredPricing(endpointName, baseModelId);
			return pricing ? pickTierTable(pricing) : undefined;
		})(),
	};
}
