import type { EndpointStyle } from '../config';
import type { VisionProxyConfig } from '../capability/vision/types';
import type { VisionProviderAdapter } from '../capability/vision/protocols/adapter';
import { AnthropicClient, anthropicMessagesAdapter, anthropicRequestBodyBuilder } from './anthropic';
import { OpenAIClient, openAIChatAdapter, openAIRequestBodyBuilder } from './openai';
import {
	OpenAIResponsesClient,
	openAIResponsesAdapter,
	openAIResponsesRequestBodyBuilder,
} from './responses';
export { resolveReasoningReplay } from './responses/reasoning';
import type { RequestBodyBuilder } from './shared/contract';
export type { StyleClient } from './shared/contract';
export type { RequestBodyBuilder, ReasoningReplayConfig } from './shared/contract';
export {
	createHttpError,
	createUserFacingError,
	BYOKRequestError,
	normalizeRequestError,
	setErrorActionUrl,
} from './shared/errors';
export type { BYOKRequestErrorKind, ErrorActionUrls } from './shared/contract';

export type ChatClient = OpenAIClient | AnthropicClient | OpenAIResponsesClient;

/**
 * Create a style-appropriate API client based on the endpoint style.
 * The three styles are treated as equal peers:
 *   - 'openai-chat'        → OpenAI Chat / Completions
 *   - 'openai-responses'   → OpenAI Responses
 *   - 'anthropic-messages' → Anthropic Claude Messages
 */
export function createClient(
	style: EndpointStyle,
	baseUrl: string,
	apiKey: string,
	options?: {
		authType?: string;
		anthropicVersion?: string;
		/** undici Dispatcher carrying the resolved proxy agent. */
		dispatcher?: import('undici').Dispatcher;
	},
): ChatClient {
	if (style === 'anthropic-messages') {
		return new AnthropicClient(baseUrl, apiKey, options?.anthropicVersion, options?.dispatcher);
	}
	if (style === 'openai-responses') {
		return new OpenAIResponsesClient(baseUrl, apiKey, options?.authType, options?.dispatcher);
	}
	return new OpenAIClient(baseUrl, apiKey, options?.authType, options?.dispatcher);
}

/** Style → request-body builder registry. Each builder lives under
 * `backend/<style>/request.ts` and implements `RequestBodyBuilder`, so the
 * main code only dispatches by style without owning wire shapes. */
const requestBodyBuilders: Record<EndpointStyle, RequestBodyBuilder> = {
	'openai-chat': openAIRequestBodyBuilder,
	'openai-responses': openAIResponsesRequestBodyBuilder,
	'anthropic-messages': anthropicRequestBodyBuilder,
};

export function getRequestBodyBuilder(style: EndpointStyle): RequestBodyBuilder {
	return requestBodyBuilders[style];
}

/** Style → vision adapter registry. Each adapter lives under
 * `backend/<style>/vision.ts` and owns the vision-proxy wire format for its
 * API family. */
export function getVisionProviderAdapter(config: VisionProxyConfig): VisionProviderAdapter {
	if (config.providerFamily === 'anthropic-compatible') {
		return anthropicMessagesAdapter;
	}
	return config.apiType === 'responses' ? openAIResponsesAdapter : openAIChatAdapter;
}
