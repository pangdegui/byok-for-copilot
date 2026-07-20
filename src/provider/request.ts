import vscode from 'vscode';
import { AuthManager } from '../auth';
import { createClient } from '../client';
import { getApiModelId, getMaxTokens, getEndpointForModel, getEndpointByName, getModelBaseUrl, getEndpointModelDef } from '../config';
import { MODEL_TEMPLATES } from '../consts';
import { t } from '../i18n';
import type { BYOKMessage, BYOKTool } from '../types';
import { convertMessages, countMessageChars } from './convert';
import {
	dumpApiRequest,
	type CacheDiagnosticsRecorder,
	type CacheDiagnosticsRun,
} from './debug';
import { getConfiguredThinkingEffort, type ModelConfigurationOptions } from './models';
import { classifyApiRequest, type RequestKind } from './routing';
import type { ReplayMarkerMetadata } from './replay';
import type { ConversationSegment } from './segment';
import { collectTrailingToolResultIds, prepareRequestTools } from './tools/request';
import { resolveImageMessages, type VisionDescriber } from './vision';

export interface PreparedChatRequest {
	client: ReturnType<typeof createClient>;
	request: Record<string, unknown>;
	isThinkingModel: boolean;
	totalRequestChars: number;
	trailingToolResultIds: string[];
	cacheDiagnostics: CacheDiagnosticsRun;
	requestKind: RequestKind;
	segment: ConversationSegment;
	replayMarkerMetadata: ReplayMarkerMetadata;
	visionMarkerTextChars?: number;
	initialResponseNotice?: string;
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

	// 优先使用 per-model baseUrl，其次端点 baseUrl
	const modelBaseUrl = endpointNameFromId
		? getModelBaseUrl(endpointNameFromId, baseModelId)
		: undefined;
	const baseUrl = modelBaseUrl || endpoint.baseUrl.replace(/\/+$/, '');
	const endpointModelDef = endpointNameFromId
		? getEndpointModelDef(endpointNameFromId, baseModelId)
		: undefined;
	const authType = endpointModelDef?.authType || 'bearer';
	const protocol = endpoint.protocol || endpointModelDef?.protocol || 'openai-completions';
	const anthropicVersion = endpoint.anthropicVersion || endpointModelDef?.anthropicVersion;

	const client = createClient(protocol, baseUrl, apiKey, {
		authType,
		anthropicVersion,
	});

	const modelDef = MODEL_TEMPLATES.find((m) => m.id === baseModelId) || endpointModelDef || MODEL_TEMPLATES[0];
	const isThinkingModel = modelDef?.capabilities?.thinking ?? false;
	const maxTokens = getMaxTokens();

	const visionResolution = await resolveImageMessages(messages, token, getVisionDescriber);
	const resolvedMessages = visionResolution.messages;
	const apiMessages = convertMessages(resolvedMessages, isThinkingModel);
	const tools = prepareRequestTools(modelDef?.capabilities?.toolCalling, options);
	const totalRequestChars = countMessageChars(apiMessages);

	const isAnthropic = protocol === 'anthropic-messages';

	const baseRequest: Record<string, unknown> = isAnthropic
		? buildAnthropicRequest(baseModelId, apiMessages, tools, maxTokens) as unknown as Record<string, unknown>
		: buildOpenAIRequest(baseModelId, apiMessages, tools, maxTokens) as unknown as Record<string, unknown>;

	const requestKind = classifyApiRequest({
		request: baseRequest as unknown as import('../types').BYOKRequest,
		inputMessages: messages,
	} as { request: import('../types').BYOKRequest; inputMessages: readonly vscode.LanguageModelChatRequestMessage[] | undefined });
	const configuredThinkingEffort = getConfiguredThinkingEffort(
		options as ModelConfigurationOptions,
	);
	const thinkingEffort = configuredThinkingEffort;

	const request: Record<string, unknown> = isAnthropic
		? finalizeAnthropicRequest(baseRequest, isThinkingModel, thinkingEffort, maxTokens) as unknown as Record<string, unknown>
		: finalizeOpenAIRequest(baseRequest as unknown as import('../types').BYOKRequest, isThinkingModel, thinkingEffort as import('./models').ThinkingEffort) as unknown as Record<string, unknown>;

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
		visionModelId: visionResolution.visionModelId,
		visionProxySource: visionResolution.visionProxySource,
		visionStats: visionResolution.stats,
	});

	return {
		client,
		request,
		isThinkingModel,
		totalRequestChars,
		trailingToolResultIds: collectTrailingToolResultIds(apiMessages),
		cacheDiagnostics: diagnosticsRun,
		requestKind,
		segment,
		replayMarkerMetadata: visionResolution.replayMarkerMetadata,
		visionMarkerTextChars: visionResolution.stats.markerVisionTextChars || undefined,
		initialResponseNotice: visionResolution.initialResponseNotice,
	};
}

// ---- Protocol-specific request builders ----

function buildOpenAIRequest(
	baseModelId: string,
	messages: BYOKMessage[],
	tools: BYOKTool[] | undefined,
	maxTokens: number | undefined,
): import('../types').BYOKRequest {
	return {
		model: getApiModelId(baseModelId),
		messages,
		stream: true,
		tools,
		tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
		max_tokens: maxTokens,
	};
}

function finalizeOpenAIRequest(
	baseRequest: import('../types').BYOKRequest,
	isThinkingModel: boolean,
	thinkingEffort: import('./models').ThinkingEffort,
): import('../types').BYOKRequest {
	if (!isThinkingModel) {
		return baseRequest;
	}
	return {
		...baseRequest,
		thinking: {
			type: thinkingEffort === 'none' ? 'disabled' : 'enabled',
		},
		...(thinkingEffort === 'none' ? {} : { reasoning_effort: thinkingEffort }),
	};
}

function buildAnthropicRequest(
	baseModelId: string,
	messages: BYOKMessage[],
	tools: BYOKTool[] | undefined,
	maxTokens: number | undefined,
): Record<string, unknown> {
	// Anthropic: extract system prompt from messages[0] if it's a system message
	let system: string | undefined;
	let filteredMessages = messages;
	if (messages.length > 0 && messages[0].role === 'system') {
		system = messages[0].content;
		filteredMessages = messages.slice(1);
	}

	// Convert OpenAI-format messages to Anthropic format
	const anthropicMessages = convertOpenAIMessagesToAnthropic(filteredMessages);

	// Anthropic: convert OpenAI-format tools to Anthropic format
	const anthropicTools = tools
		? tools.map((t) => ({
				name: t.function.name,
				description: t.function.description,
				input_schema: t.function.parameters,
			}))
		: undefined;

	// Anthropic: max_tokens is required, minimum 1
	const effectiveMaxTokens = maxTokens || 4096;

	const request: Record<string, unknown> = {
		model: getApiModelId(baseModelId),
		messages: anthropicMessages,
		stream: true,
		max_tokens: effectiveMaxTokens,
	};
	if (system) {
		request.system = system;
	}
	if (anthropicTools && anthropicTools.length > 0) {
		request.tools = anthropicTools;
	}
	return request;
}

/**
 * Convert OpenAI-format messages to Anthropic API format.
 * - role "tool" → role "user" with tool_result content blocks
 * - role "assistant" with tool_calls → content blocks with tool_use
 * - reasoning_content → thinking content block
 */
function convertOpenAIMessagesToAnthropic(messages: BYOKMessage[]): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];
	for (const msg of messages) {
		if (msg.role === 'tool') {
			// Tool results: merge into the last user message or create a new one
			const lastMsg = result.length > 0 ? result[result.length - 1] : undefined;
			const toolResultBlock = {
				type: 'tool_result',
				tool_use_id: msg.tool_call_id || '',
				content: msg.content || '',
			};
			if (lastMsg && lastMsg.role === 'user') {
				// Append to existing user message
				if (!Array.isArray(lastMsg.content)) {
					lastMsg.content = [{ type: 'text', text: lastMsg.content }];
				}
				(lastMsg.content as unknown[]).push(toolResultBlock);
			} else {
				result.push({
					role: 'user',
					content: [toolResultBlock],
				});
			}
		} else if (msg.role === 'assistant') {
			const contentBlocks: Record<string, unknown>[] = [];
			// Reasoning/thinking content
			if (msg.reasoning_content) {
				contentBlocks.push({
					type: 'thinking',
					thinking: msg.reasoning_content,
					signature: '', // No signature available for replay; API may reject
				});
			}
			// Text content
			if (msg.content) {
				contentBlocks.push({
					type: 'text',
					text: msg.content,
				});
			}
			// Tool calls
			if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
				for (const tc of msg.tool_calls) {
					let input: Record<string, unknown> = {};
					try {
						input = JSON.parse(tc.function?.arguments || '{}');
					} catch {
						input = {};
					}
					contentBlocks.push({
						type: 'tool_use',
						id: tc.id || '',
						name: tc.function?.name || '',
						input,
					});
				}
			}
			if (contentBlocks.length > 0) {
				result.push({
					role: 'assistant',
					content: contentBlocks,
				});
			}
		} else if (msg.role === 'system') {
			// System messages are handled separately (top-level system field)
			// Skip them here
		} else {
			// User messages: keep as text content
			result.push({
				role: msg.role || 'user',
				content: typeof msg.content === 'string'
					? [{ type: 'text', text: msg.content }]
					: msg.content,
			});
		}
	}
	return result;
}

function finalizeAnthropicRequest(
	baseRequest: Record<string, unknown>,
	isThinkingModel: boolean,
	thinkingEffort: string,
	maxTokens: number | undefined,
): Record<string, unknown> {
	if (!isThinkingModel) {
		return baseRequest;
	}
	// Anthropic: thinking is enabled by adding a thinking block with budget_tokens
	const thinkingBudget = maxTokens ? Math.min(maxTokens, 4096) : 4096;
	if (thinkingEffort === 'none') {
		return baseRequest; // no thinking
	}
	return {
		...baseRequest,
		thinking: {
			type: 'enabled',
			budget_tokens: thinkingBudget,
		},
	};
}
