import { getApiModelId } from '../../config';
import type { RequestBodyBuilder } from '../shared/contract';

/**
 * Anthropic Claude Messages request-body builder.
 *
 * Implements the shared `RequestBodyBuilder` contract (backend/shared/contract.ts).
 * `app/request.ts` imports this and dispatches by style.
 */
export const anthropicRequestBodyBuilder: RequestBodyBuilder = {
	buildRequest({ baseModelId, messages, tools, maxTokens, isThinkingModel, thinkingEffort }) {
		const base = buildAnthropicRequest(baseModelId, messages, tools, maxTokens);
		return finalizeAnthropicRequest(base, isThinkingModel, thinkingEffort, maxTokens);
	},
};

function buildAnthropicRequest(
	baseModelId: string,
	messages: Parameters<RequestBodyBuilder['buildRequest']>[0]['messages'],
	tools: Parameters<RequestBodyBuilder['buildRequest']>[0]['tools'],
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
				// Anthropic requires `input_schema` on every tool; tools without an
				// input schema get an empty object schema.
				input_schema: t.function.parameters ?? { type: 'object', properties: {} },
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
function convertOpenAIMessagesToAnthropic(
	messages: Parameters<RequestBodyBuilder['buildRequest']>[0]['messages'],
): Record<string, unknown>[] {
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
	thinkingEffort: Parameters<RequestBodyBuilder['buildRequest']>[0]['thinkingEffort'],
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
