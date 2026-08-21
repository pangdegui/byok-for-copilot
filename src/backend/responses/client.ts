import type { CancellationToken } from 'vscode';
import { fetch as undiciFetch } from 'undici';
import { safeStringify } from '../../json';
import { logger } from '../../logger';
import type { BYOKToolCall, BYOKUsage, StreamCallbacks } from '../../types';
import { createHttpError, formatRequestError, normalizeRequestError } from '../shared/errors';

/**
 * OpenAI Responses API streaming client.
 *
 * The Responses API streams typed SSE events (`data: {...}` with a `type`
 * field) inside a single JSON stream rather than per-choice chunks, for example:
 *   - response.output_text.delta            → content
 *   - response.reasoning_text.delta         → thinking
 *   - response.function_call_arguments.delta → tool call argument fragments
 *   - response.output_item.done             → completed tool call
 *   - response.completed                    → final usage + stream end
 */
export class OpenAIResponsesClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly authType: string = 'bearer',
		private readonly dispatcher?: import('undici').Dispatcher,
	) {}

	async streamChatCompletion(
		request: Record<string, unknown>,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const controller = new AbortController();
		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});
		if (cancellationToken?.isCancellationRequested) {
			controller.abort();
		}

		// Accumulate tool call args per item id so deltas can be reassembled
		// regardless of whether the provider sends the full args on output_item.done.
		const toolCallBuffers = new Map<string, { name: string; arguments: string }>();

		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
			};
			if (this.authType === 'x-api-key') {
				headers['x-api-key'] = this.apiKey;
			} else {
				headers.Authorization = `Bearer ${this.apiKey}`;
			}

			// 必须用 undici 的 fetch：VS Code 补丁过的全局 fetch 会忽略
			// dispatcher 选项，导致 direct/proxy 模式失效。
			const response = await undiciFetch(`${this.baseUrl}/responses`, {
				method: 'POST',
				headers,
				body: safeStringify(request),
				signal: controller.signal,
				dispatcher: this.dispatcher,
			});

			if (!response.ok) {
				throw await createHttpError(response, { baseUrl: this.baseUrl, request: request as any });
			}

			if (!response.body) {
				throw new Error('No response body received');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				if (cancellationToken?.isCancellationRequested) {
					controller.abort();
					return;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith(':')) {
						continue;
					}
					if (trimmed === 'data: [DONE]') {
						callbacks.onDone();
						return;
					}
					if (!trimmed.startsWith('data: ')) {
						continue;
					}

					const jsonStr = trimmed.slice(6);
					try {
						const event: Record<string, unknown> = JSON.parse(jsonStr);
						if (handleResponsesEvent(event, toolCallBuffers, callbacks)) {
							return;
						}
					} catch (e) {
						logger.error('Failed to parse Responses SSE chunk:', jsonStr.slice(0, 200), e);
					}
				}
			}

			// Stream ended without a terminal event
			callbacks.onDone();
		} catch (error) {
			if (isAbortError(error) && cancellationToken?.isCancellationRequested) {
				return;
			}
			const normalizedError = normalizeRequestError(error, { baseUrl: this.baseUrl, request: request as any });
			logger.error('OpenAI Responses request failed:', formatRequestError(normalizedError));
			callbacks.onError(normalizedError);
		} finally {
			cancelListener?.dispose();
		}
	}
}

/**
 * Handle a single Responses API SSE event.
 * Returns `true` when the stream has reached a terminal state.
 */
function handleResponsesEvent(
	event: Record<string, unknown>,
	toolCallBuffers: Map<string, { name: string; arguments: string }>,
	callbacks: StreamCallbacks,
): boolean {
	const type = event.type as string | undefined;

	switch (type) {
		case 'response.output_text.delta': {
			const delta = (event.delta as string) || '';
			if (delta) {
				callbacks.onContent(delta);
			}
			break;
		}

		case 'response.reasoning_text.delta':
		case 'response.reasoning_summary_text.delta': {
			const delta = (event.delta as string) || '';
			if (delta) {
				callbacks.onThinking(delta);
			}
			break;
		}

		case 'response.output_item.added': {
			// Streaming events carry the item under `item`; some gateways mirror
			// it under `output`. Fall back to `output[0]` for robustness.
			const item = extractOutputItem(event);
			if (item && item.type === 'function_call') {
				const itemId = (event.item_id as string) || '';
				toolCallBuffers.set(itemId, {
					name: (item.name as string) || '',
					arguments: (item.arguments as string) || '',
				});
			}
			break;
		}

		case 'response.function_call_arguments.delta': {
			const itemId = (event.item_id as string) || '';
			const delta = (event.delta as string) || '';
			let buf = toolCallBuffers.get(itemId);
			if (!buf) {
				buf = { name: '', arguments: '' };
				toolCallBuffers.set(itemId, buf);
			}
			buf.arguments += delta;
			break;
		}

		case 'response.function_call_arguments.done': {
			const itemId = (event.item_id as string) || '';
			const args = (event.arguments as string) || '';
			const buf = toolCallBuffers.get(itemId);
			if (buf) {
				buf.arguments = args;
			} else {
				toolCallBuffers.set(itemId, { name: '', arguments: args });
			}
			break;
		}

		case 'response.output_item.done': {
			const item = extractOutputItem(event);
			if (item && item.type === 'function_call') {
				const itemId = (event.item_id as string) || '';
				const buf = toolCallBuffers.get(itemId);
				const name = (item.name as string) || buf?.name || '';
				const args = (item.arguments as string) || buf?.arguments || '{}';
				toolCallBuffers.delete(itemId);
				callbacks.onToolCall({
					id: (item.call_id as string) || itemId || `fc_${itemId}`,
					type: 'function',
					function: { name, arguments: args },
				});
			}
			break;
		}

		case 'response.completed': {
			const response = event.response as Record<string, unknown> | undefined;

			// Stateful reasoning replay: capture the response id so the next turn
			// can chain via `previous_response_id`. The id may live on the
			// top-level `response` object or as `response_id` on the event.
			const responseId =
				(response?.id as string | undefined) ??
				(event.response_id as string | undefined);
			if (responseId) {
				callbacks.onResponseId?.(responseId);
			}

			// Encrypted reasoning replay: capture the reasoning item's
			// `encrypted_content` (and optional id) so it can be re-injected.
			const output = response?.output as Array<Record<string, unknown>> | undefined;
			const reasoningItem = output?.find((it) => it.type === 'reasoning');
			if (reasoningItem) {
				const itemId = reasoningItem.id as string | undefined;
				const encryptedContent = reasoningItem.encrypted_content as string | undefined;
				if (itemId || encryptedContent) {
					callbacks.onReasoningToken?.({ itemId, encryptedContent });
				}
			}

			const usage = extractUsage(response);
			if (usage && callbacks.onUsage) {
				callbacks.onUsage(usage);
			}
			callbacks.onDone();
			return true;
		}

		case 'response.failed': {
			const error = (event.error as Record<string, unknown>) || {};
			const message = (error.message as string) || 'Unknown OpenAI Responses error';
			const code = (error.code as string) || 'unknown_error';
			callbacks.onError(new Error(`OpenAI Responses API error (${code}): ${message}`));
			return true;
		}

		case 'response.incomplete': {
			callbacks.onDone();
			return true;
		}

		default:
			// Ignore lifecycle/other events (response.created, response.in_progress, ...)
			break;
	}

	return false;
}

function firstOutputItem(output: unknown): Record<string, unknown> | undefined {
	if (!Array.isArray(output)) {
		return undefined;
	}
	const item = output[0];
	return item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
}

/** Extract the output item from a streaming `output_item.*` event.
 * The official API puts it under `item`; tolerate `output[0]` as a fallback. */
function extractOutputItem(
	event: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const item = event.item;
	if (item && typeof item === 'object') {
		return item as Record<string, unknown>;
	}
	return firstOutputItem(event.output);
}

function extractUsage(response: unknown): BYOKUsage | undefined {
	if (!response || typeof response !== 'object') {
		return undefined;
	}
	const usage = (response as Record<string, unknown>).usage as Record<string, unknown> | undefined;
	if (!usage) {
		return undefined;
	}
	const input = (usage.input_tokens as number) ?? (usage.prompt_tokens as number) ?? 0;
	const output = (usage.output_tokens as number) ?? (usage.completion_tokens as number) ?? 0;

	// Cache hit reporting. The Responses API nests the cached token count under
	// `usage.input_tokens_details.cached_tokens`; some gateways also emit the
	// Chat-Completions shape `usage.prompt_tokens_details.cached_tokens` or the
	// flat `prompt_cache_hit_tokens`. Without this, every Responses turn is
	// counted as a full cache miss.
	const inputTokensDetails = usage.input_tokens_details as Record<string, unknown> | undefined;
	const promptTokensDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined;
	const cachedTokens =
		(inputTokensDetails?.cached_tokens as number | undefined) ??
		(promptTokensDetails?.cached_tokens as number | undefined) ??
		(usage.prompt_cache_hit_tokens as number | undefined);

	// Mark the response as having reported cache info whenever the provider
	// emitted the details object (even when cached_tokens is 0), so the stats
	// layer records an explicit 0 hit-rate instead of "no cache report".
	const cacheReported = inputTokensDetails !== undefined || promptTokensDetails !== undefined;

	const result: BYOKUsage = {
		prompt_tokens: input,
		completion_tokens: output,
		total_tokens: input + output,
	};
	if (cacheReported) {
		result.prompt_tokens_details = { cached_tokens: cachedTokens ?? 0 };
	} else if (cachedTokens !== undefined) {
		result.prompt_tokens_details = { cached_tokens: cachedTokens };
	}
	return result;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}
