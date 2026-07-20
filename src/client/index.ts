export { BYOKClient } from './core';
import { OpenAIClient } from './openai/core';
import { AnthropicClient } from './anthropic/core';
export { OpenAIClient, AnthropicClient };
export {
	createHttpError,
	createUserFacingError,
	BYOKRequestError,
	normalizeRequestError,
	setErrorActionUrl,
} from './error';
export type { BYOKRequestErrorKind, ErrorActionUrls } from './types';

/**
 * Create a protocol-appropriate API client based on the endpoint's protocol field.
 */
export function createClient(
	protocol: string,
	baseUrl: string,
	apiKey: string,
	options?: { authType?: string; anthropicVersion?: string },
): OpenAIClient | AnthropicClient {
	if (protocol === 'anthropic-messages') {
		return new AnthropicClient(baseUrl, apiKey, options?.anthropicVersion);
	}
	return new OpenAIClient(baseUrl, apiKey, options?.authType);
}
