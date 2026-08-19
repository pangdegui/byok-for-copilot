export { BYOKClient } from './core';
import type { EndpointStyle } from '../config';
import { OpenAIClient } from './openai/core';
import { AnthropicClient } from './anthropic/core';
import { OpenAIResponsesClient } from './responses/core';
export { OpenAIClient, AnthropicClient, OpenAIResponsesClient };
export {
	createHttpError,
	createUserFacingError,
	BYOKRequestError,
	normalizeRequestError,
	setErrorActionUrl,
} from './error';
export type { BYOKRequestErrorKind, ErrorActionUrls } from './types';

export type ChatClient = OpenAIClient | AnthropicClient | OpenAIResponsesClient;

/**
 * Create a protocol-appropriate API client based on the endpoint style.
 * The three styles are treated as equal peers:
 *   - 'openai-chat'        → OpenAI Chat / Completions
 *   - 'openai-responses'   → OpenAI Responses
 *   - 'anthropic-messages' → Anthropic Claude Messages
 */
export function createClient(
	style: EndpointStyle,
	baseUrl: string,
	apiKey: string,
	options?: { authType?: string; anthropicVersion?: string },
): ChatClient {
	if (style === 'anthropic-messages') {
		return new AnthropicClient(baseUrl, apiKey, options?.anthropicVersion);
	}
	if (style === 'openai-responses') {
		return new OpenAIResponsesClient(baseUrl, apiKey, options?.authType);
	}
	return new OpenAIClient(baseUrl, apiKey, options?.authType);
}
