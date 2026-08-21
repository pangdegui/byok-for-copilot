import type { CancellationToken } from 'vscode';
import { fetch as undiciFetch } from 'undici';
import { safeStringify } from '../../json';
import { logger } from '../../logger';
import type { StreamCallbacks } from '../../types';
import { createHttpError } from '../shared/errors';

/**
 * Anthropic Messages API streaming client.
 * Handles Anthropic-specific SSE format with event:/data: pairing.
 *
 * Key differences from OpenAI SSE:
 * - Uses `event:` + `data:` line pairs
 * - Has typed events: message_start, content_block_start, content_block_delta, etc.
 * - Tool calls are content_block type "tool_use" with input_json_delta
 * - Thinking is content_block type "thinking" with thinking_delta / signature_delta
 * - Ends with message_stop event (not [DONE])
 * - Auth uses x-api-key header + anthropic-version header
 */
export class AnthropicClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly anthropicVersion: string = '2023-06-01',
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

		try {
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'x-api-key': this.apiKey,
				'anthropic-version': this.anthropicVersion,
			};

			// 必须用 undici 的 fetch：VS Code 补丁过的全局 fetch 会忽略
			// dispatcher 选项，导致 direct/proxy 模式失效。
			const response = await undiciFetch(`${this.baseUrl}/v1/messages`, {
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
			let currentEvent = '';

			// Track content blocks by index
			const contentBlocks = new Map<number, AnthropicContentBlock>();

			// Accumulate usage from message_start + message_delta
			let inputTokens = 0;
			let outputTokens = 0;

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
					if (!trimmed) {
						continue;
					}

					if (trimmed.startsWith('event: ')) {
						currentEvent = trimmed.slice(7).trim();
						continue;
					}

					if (!trimmed.startsWith('data: ')) {
						continue;
					}

					const jsonStr = trimmed.slice(6);
					try {
						const data: Record<string, unknown> = JSON.parse(jsonStr);
						const eventType = currentEvent || (data.type as string);

						switch (eventType) {
							case 'message_start':
								if ((data.message as Record<string, unknown>)?.usage) {
									const usage = (data.message as Record<string, unknown>).usage as Record<string, unknown>;
									inputTokens = (usage.input_tokens as number) || 0;
								}
								break;

							case 'content_block_start': {
								const idx = data.index as number;
								const block = data.content_block as Record<string, unknown> | undefined;
								if (!block) break;
								contentBlocks.set(idx, {
									type: block.type as string,
									index: idx,
									id: block.id as string | undefined,
									name: block.name as string | undefined,
									text: '',
									thinking: '',
									signature: '',
									input: '',
								});
								break;
							}

							case 'content_block_delta': {
								const idx = data.index as number;
								const delta = data.delta as Record<string, unknown> | undefined;
								const block = contentBlocks.get(idx);
								if (!block || !delta) break;

								if (delta.type === 'text_delta') {
									const text = (delta.text as string) || '';
									block.text += text;
									callbacks.onContent(text);
								} else if (delta.type === 'thinking_delta') {
									const thinking = (delta.thinking as string) || '';
									block.thinking += thinking;
									callbacks.onThinking(thinking);
								} else if (delta.type === 'signature_delta') {
									block.signature += (delta.signature as string) || '';
								} else if (delta.type === 'input_json_delta') {
									block.input += (delta.partial_json as string) || '';
								}
								break;
							}

							case 'content_block_stop': {
								const idx = data.index as number;
								const block = contentBlocks.get(idx);
								if (!block) break;

								if (block.type === 'tool_use') {
									let parsedInput: Record<string, unknown> = {};
									try {
										if (block.input) {
											parsedInput = JSON.parse(block.input);
										}
									} catch {
										// Partial JSON — use as-is
									}
									callbacks.onToolCall({
										id: block.id || `toolu_${idx}`,
										type: 'function',
										function: {
											name: block.name || '',
											arguments:
												typeof parsedInput === 'object'
													? safeStringify(parsedInput)
													: block.input,
										},
									});
								}
								break;
							}

							case 'message_delta': {
								if ((data.usage as Record<string, unknown>)) {
									const usage = data.usage as Record<string, unknown>;
									outputTokens = (usage.output_tokens as number) || 0;
								}
								if ((data.delta as Record<string, unknown>)?.stop_reason && callbacks.onUsage) {
									callbacks.onUsage({
										prompt_tokens: inputTokens,
										completion_tokens: outputTokens,
										total_tokens: inputTokens + outputTokens,
									});
								}
								break;
							}

							case 'message_stop':
								callbacks.onDone();
								return;

							case 'ping':
								// Keep-alive, ignore
								break;

							case 'error':
								callbacks.onError(
									new Error(
										`Anthropic API error: ${((data.error as Record<string, unknown>)?.message as string) || 'Unknown error'}`,
									),
								);
								return;
						}
						currentEvent = '';
					} catch (e) {
						logger.error('Failed to parse Anthropic SSE chunk:', jsonStr.slice(0, 200), e);
						currentEvent = '';
					}
				}
			}

			// Stream ended without message_stop
			callbacks.onDone();
		} catch (error) {
			if (isAbortError(error) && cancellationToken?.isCancellationRequested) {
				return;
			}
			callbacks.onError(error instanceof Error ? error : new Error(String(error)));
		} finally {
			cancelListener?.dispose();
		}
	}
}

interface AnthropicContentBlock {
	type: string;
	index: number;
	id?: string;
	name?: string;
	text: string;
	thinking: string;
	signature: string;
	input: string;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}
