import type { CancellationToken } from 'vscode';
import { safeStringify } from '../../json';
import { logger } from '../../logger';
import type { BYOKToolCall, BYOKUsage, StreamCallbacks } from '../../types';
import { createHttpError, formatRequestError, normalizeRequestError } from '../error';

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

			const response = await fetch(`${this.baseUrl}/responses`, {
				method: 'POST',
				headers,
				body: safeStringify(request),
				signal: controller.signal,
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
			const item = firstOutputItem(event.output);
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
			const item = firstOutputItem(event.output);
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
			const usage = extractUsage(event.response);
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
	return {
		prompt_tokens: input,
		completion_tokens: output,
		total_tokens: input + output,
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}
