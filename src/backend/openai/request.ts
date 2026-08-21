import { getApiModelId } from '../../config';
import type { RequestBodyBuilder } from '../shared/contract';

/**
 * OpenAI Chat / Completions request-body builder.
 *
 * Implements the shared `RequestBodyBuilder` contract (backend/shared/contract.ts).
 * `app/request.ts` imports this and dispatches by style, so the request-shape
 * knowledge for the OpenAI Chat style lives entirely under this directory.
 */
export const openAIRequestBodyBuilder: RequestBodyBuilder = {
	buildRequest({ baseModelId, messages, tools, maxTokens, isThinkingModel, thinkingEffort }) {
		const request: Record<string, unknown> = {
			model: getApiModelId(baseModelId),
			messages,
			stream: true,
			tools,
			tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
			max_tokens: maxTokens,
		};
		if (!isThinkingModel) {
			return request;
		}
		return {
			...request,
			thinking: { type: thinkingEffort === 'none' ? 'disabled' : 'enabled' },
			...(thinkingEffort === 'none' ? {} : { reasoning_effort: thinkingEffort }),
		};
	},
};
