import { getApiModelId } from '../../config';
import type { RequestBodyBuilder, ReasoningReplayConfig } from '../shared/contract';

/**
 * OpenAI Responses request-body builder.
 *
 * Implements the shared `RequestBodyBuilder` contract (backend/shared/contract.ts).
 * `app/request.ts` imports this and dispatches by style.
 */
export const openAIResponsesRequestBodyBuilder: RequestBodyBuilder = {
	buildRequest({ baseModelId, messages, tools, maxTokens, isThinkingModel, thinkingEffort, reasoning }) {
		const base = buildResponsesRequest(baseModelId, messages, tools, maxTokens, reasoning);
		return finalizeResponsesRequest(base, isThinkingModel, thinkingEffort);
	},
};

function buildResponsesRequest(
	baseModelId: string,
	messages: Parameters<RequestBodyBuilder['buildRequest']>[0]['messages'],
	tools: Parameters<RequestBodyBuilder['buildRequest']>[0]['tools'],
	maxTokens: number | undefined,
	reasoning: ReasoningReplayConfig,
): Record<string, unknown> {
	// Responses API: system prompt is passed via top-level `instructions`
	let instructions: string | undefined;
	let filteredMessages = messages;
	if (messages.length > 0 && messages[0].role === 'system') {
		instructions = messages[0].content;
		filteredMessages = messages.slice(1);
	}

	const input = convertMessagesToResponsesInput(filteredMessages, reasoning);
	const responsesTools = tools
		? tools.map((t) => ({
				type: 'function',
				name: t.function.name,
				description: t.function.description,
				// The Responses API requires `parameters` on every function tool.
				// Tools without an input schema (e.g. zero-arg tools) must still
				// carry an empty object schema, otherwise the upstream rejects the
				// whole request with "did not match any supported type".
				parameters: t.function.parameters ?? { type: 'object', properties: {} },
			}))
		: undefined;

	const request: Record<string, unknown> = {
		model: getApiModelId(baseModelId),
		input,
		stream: true,
	};
	if (instructions) {
		request.instructions = instructions;
	}
	if (responsesTools && responsesTools.length > 0) {
		request.tools = responsesTools;
	}
	if (maxTokens) {
		request.max_output_tokens = maxTokens;
	}

	// Reasoning replay (OpenAI Responses only). When enabled, wire up the
	// stateful (`store` + `previous_response_id`) or encrypted (`encrypted_content`)
	// mechanism. When disabled, the request stays plain and reasoning text is
	// serialized as `output_text` by `convertMessagesToResponsesInput`.
	if (reasoning.enabled) {
		if (reasoning.mode === 'stateful') {
			request.store = true;
			if (reasoning.previousResponseId) {
				request.previous_response_id = reasoning.previousResponseId;
			}
		} else {
			request.include = ['reasoning.encrypted_content'];
			request.store = false;
		}
	}

	return request;
}

function finalizeResponsesRequest(
	baseRequest: Record<string, unknown>,
	isThinkingModel: boolean,
	thinkingEffort: Parameters<RequestBodyBuilder['buildRequest']>[0]['thinkingEffort'],
): Record<string, unknown> {
	if (!isThinkingModel || thinkingEffort === 'none') {
		return baseRequest;
	}
	return {
		...baseRequest,
		reasoning: { effort: thinkingEffort },
	};
}

/**
 * Convert OpenAI-style messages (system/user/assistant/tool with tool_calls)
 * into OpenAI Responses API `input` items.
 */
function convertMessagesToResponsesInput(
	messages: Parameters<RequestBodyBuilder['buildRequest']>[0]['messages'],
	reasoning: ReasoningReplayConfig,
): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];
	for (const msg of messages) {
		if (msg.role === 'system') {
			result.push({
				role: 'system',
				content: [{ type: 'input_text', text: msg.content }],
			});
		} else if (msg.role === 'tool') {
			result.push({
				type: 'function_call_output',
				call_id: msg.tool_call_id || '',
				output: msg.content || '',
			});
		} else if (msg.role === 'assistant') {
			// Reasoning replay (OpenAI Responses only): re-inject the reasoning
			// item so the model can continue its chain. The `encrypted_content`
			// token is a self-contained ciphertext returned by the server.
			if (reasoning.enabled && reasoning.mode === 'encrypted' && msg.reasoning_encrypted_content) {
				result.push({
					type: 'reasoning',
					encrypted_content: msg.reasoning_encrypted_content,
				});
			}

			const content: Record<string, unknown>[] = [];
			// Only emit reasoning text as `output_text` when reasoning replay is
			// NOT active. Otherwise the server restores it via
			// `previous_response_id` (stateful) or the `encrypted_content` item
			// above (encrypted); re-sending the text would duplicate context.
			if (!reasoning.enabled && msg.reasoning_content) {
				content.push({ type: 'output_text', text: msg.reasoning_content });
			}
			if (msg.content) {
				content.push({ type: 'output_text', text: msg.content });
			}
			const item: Record<string, unknown> = { role: 'assistant', content };
			result.push(item);

			// Each historical tool call must be its own `function_call` item —
			// the Responses API has no `tool_calls` field on assistant messages.
			// Without these, the matching `function_call_output` items below are
			// rejected with "No function call found for function call output".
			if (msg.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
				for (const tc of msg.tool_calls) {
					result.push({
						type: 'function_call',
						call_id: tc.id,
						name: tc.function.name,
						arguments: tc.function.arguments || '{}',
					});
				}
			}
		} else {
			// user
			result.push({
				role: 'user',
				content: [{ type: 'input_text', text: msg.content }],
			});
		}
	}
	return result;
}
