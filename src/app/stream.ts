import vscode from 'vscode';
import type { CancellationToken } from 'vscode';
import { createUserFacingError, type StyleClient } from '../backend';
import { getReportUsageToChatEnabled } from '../config';
import type { StreamCallbacks } from '../types';
import { logger } from '../logger';
import type { BYOKToolCall, BYOKUsage } from '../types';
import {
	observeCancellationToken,
	dumpApiResponse,
	type CacheDiagnosticsRun,
	type ReplayMarkerReportTrigger,
} from '../copilot/debug';
import { recordUsageEvent } from '../copilot/stats/tracker';
import { normalizeUsage } from '../copilot/stats/usage';
import { formatRequestLogLine, type RequestKind } from '../capability/routing';
import {
	createReplayMarkerPart,
	hasReplayMarkerMetadata,
	type ReplayMarkerMetadata,
} from '../capability/replay';
import { reasoningStateCache } from '../backend/responses';
import { estimateCost, formatCost, type PriceTable } from '../copilot/pricing/tiered';
import type { EndpointStyle } from '../domain/profile-config';
import type { PreparedChatRequest } from './request';

interface ResponseStreamState {
	accumulatedContent: string;
	accumulatedReasoning: string;
	/** OpenAI Responses reasoning replay: the `response.id` from the last turn. */
	responseId?: string;
	/** OpenAI Responses reasoning replay: the reasoning item's `encrypted_content`. */
	encryptedReasoningContent?: string;
	toolCalls: BYOKToolCall[];
	usage?: BYOKUsage;
	streamError?: Error;
	emittedToolCallIds: string[];
	initialResponseNoticeReported: boolean;
	replayMarkerReported: boolean;
}

const COPILOT_USAGE_DATA_PART_MIME = 'usage';

export interface StreamChatCompletionOptions {
	prepared: PreparedChatRequest;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	token: vscode.CancellationToken;
	initialResponseNotice?: string;
	getCharsPerToken: () => number;
	setCharsPerToken: (charsPerToken: number) => void;
}

export function streamChatCompletion({
	prepared,
	progress,
	token,
	initialResponseNotice,
	getCharsPerToken,
	setCharsPerToken,
}: StreamChatCompletionOptions): Promise<void> {
	const state: ResponseStreamState = {
		accumulatedContent: '',
		accumulatedReasoning: '',
		responseId: undefined,
		encryptedReasoningContent: undefined,
		toolCalls: [],
		usage: undefined,
		streamError: undefined,
		emittedToolCallIds: [],
		initialResponseNoticeReported: false,
		replayMarkerReported: false,
	};
	const cancelListener = observeCancellationToken(token, prepared.cacheDiagnostics);
	const startedAt = Date.now();

	return (prepared.client as unknown as StyleClient)
		.streamChatCompletion(
			prepared.request,
			{
				onContent: (content: string) => {
					state.accumulatedContent += content;
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					progress.report(new vscode.LanguageModelTextPart(content));
				},

				onThinking: (text: string) => {
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					handleThinking(text, state, progress);
				},

				onToolCall: (toolCall: BYOKToolCall) => {
					reportInitialResponseNoticeOnce(progress, state, initialResponseNotice);
					state.toolCalls.push(toolCall);
					handleToolCall(toolCall, state, progress);
				},

				onError: (error: Error) => {
					state.streamError = error;
					dumpApiResponse({
						globalStorageUri: prepared.globalStorageUri,
						segment: prepared.segment,
						requestKind: prepared.requestKind,
						vscodeModelId: prepared.vscodeModelId,
						apiModelId: prepared.apiModelId,
						status: 'error',
						content: state.accumulatedContent,
						reasoning: state.accumulatedReasoning,
						toolCalls: state.toolCalls,
						usage: state.usage,
						responseId: state.responseId,
						error: {
							message: error.message,
							name: error.name,
						},
						durationMs: Date.now() - startedAt,
					});
					throw createUserFacingError(error);
				},

				onDone: () => {
					reportReplayMarkerOnce(prepared, progress, state, 'done');
					finalizeReplayDiagnostics(
						prepared.trailingToolResultIds,
						state,
						prepared.cacheDiagnostics,
					);
					dumpApiResponse({
						globalStorageUri: prepared.globalStorageUri,
						segment: prepared.segment,
						requestKind: prepared.requestKind,
						vscodeModelId: prepared.vscodeModelId,
						apiModelId: prepared.apiModelId,
						status: token.isCancellationRequested ? 'cancelled' : 'completed',
						content: state.accumulatedContent,
						reasoning: state.accumulatedReasoning,
						toolCalls: state.toolCalls,
						usage: state.usage,
						responseId: state.responseId,
						durationMs: Date.now() - startedAt,
					});
				},

				onUsage: (usage: BYOKUsage) => {
					const charsPerToken = updateCharsPerToken(
						prepared.totalRequestChars,
						usage,
						getCharsPerToken(),
					);
					state.usage = usage;
					setCharsPerToken(charsPerToken);
					prepared.cacheDiagnostics.onUsage(usage, charsPerToken);
					// Cost is computed from the tier table effective at request time
					// (resolved in prepareChatRequest via pickTierTable).
					const estimate =
						prepared.pricingTable !== undefined
							? estimateCost(usage, prepared.pricingTable, state.toolCalls.length, prepared.style)
							: undefined;
					recordUsageEvent(prepared.vscodeModelId, prepared.apiModelId, usage, charsPerToken, {
						toolCallCount: state.toolCalls.length,
						cost: estimate?.priced ? estimate.total : undefined,
						style: prepared.style,
					});
					logCostEstimate(prepared, estimate);
					if (getReportUsageToChatEnabled()) {
						reportCopilotContextUsage(progress, usage, prepared.requestKind, prepared.style);
					}
				},

				onResponseId: (responseId: string) => {
					state.responseId = responseId;
					reasoningStateCache.set(prepared.segment.segmentId, responseId);
				},

				onReasoningToken: ({
					encryptedContent,
				}: {
					encryptedContent?: string;
				}) => {
					if (encryptedContent) {
						state.encryptedReasoningContent = encryptedContent;
					}
				},
			},
			token,
		)
		.then(undefined, (error: unknown) => {
			reportSkippedReplayMarkerIfNeeded(
				prepared,
				state,
				token.isCancellationRequested ? 'cancelled' : 'stream-error',
				error,
			);
			throw error;
		})
		.then(() => {
			if (token.isCancellationRequested) {
				reportSkippedReplayMarkerIfNeeded(prepared, state, 'cancelled');
			}
		})
		.finally(() => {
			cancelListener.dispose();
		});
}

function reportInitialResponseNoticeOnce(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	initialResponseNotice: string | undefined,
): void {
	if (!initialResponseNotice || state.initialResponseNoticeReported) {
		return;
	}
	state.initialResponseNoticeReported = true;
	progress.report(new vscode.LanguageModelTextPart(initialResponseNotice));
}

/** Log the per-request cost estimate when the model has a pricing table. */
function logCostEstimate(
	prepared: PreparedChatRequest,
	estimate: ReturnType<typeof estimateCost> | undefined,
): void {
	if (!estimate || !estimate.priced) {
		return;
	}
	const b = estimate.breakdown;
	logger.info(
		formatRequestLogLine(
			prepared.requestKind,
			`cost estimate=${formatCost(estimate.total)} (input=${formatCost(b.input)}` +
				` output=${formatCost(b.output)} cacheRead=${formatCost(b.cacheRead)}` +
				` cacheWrite=${formatCost(b.cacheWrite)} toolCalls=${formatCost(b.toolCalls)})`,
		),
	);
}

function reportReplayMarkerOnce(
	prepared: PreparedChatRequest,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	trigger: ReplayMarkerReportTrigger,
): void {
	if (state.replayMarkerReported) {
		return;
	}
	state.replayMarkerReported = true;
	reportReplayMarker(prepared, progress, state, trigger);
}

function reportSkippedReplayMarkerIfNeeded(
	prepared: PreparedChatRequest,
	state: ResponseStreamState,
	reason: 'cancelled' | 'stream-error',
	error?: unknown,
): void {
	if (state.replayMarkerReported) {
		return;
	}
	state.replayMarkerReported = true;
	prepared.cacheDiagnostics.onReplayMarkerReport({
		status: 'skipped',
		reason,
		visionTextChars: prepared.visionMarkerTextChars,
		reasoningTextChars: state.accumulatedReasoning.length || undefined,
		error,
	});
}

function reportReplayMarker(
	prepared: PreparedChatRequest,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	state: ResponseStreamState,
	trigger: ReplayMarkerReportTrigger,
): void {
	const metadata = getReplayMarkerMetadata(prepared, state);
	if (!hasReplayMarkerMetadata(metadata)) {
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'skipped',
			trigger,
			reason: 'no-replay-data',
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
		});
		return;
	}

	try {
		const markerPart = createReplayMarkerPart(metadata);
		progress.report(markerPart);
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'reported',
			trigger,
			markerBytes: markerPart.data.byteLength,
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
		});
	} catch (error) {
		prepared.cacheDiagnostics.onReplayMarkerReport({
			status: 'failed',
			trigger,
			visionTextChars: prepared.visionMarkerTextChars,
			reasoningTextChars: state.accumulatedReasoning.length || undefined,
			error,
		});
		logger.warn(
			formatRequestLogLine(prepared.requestKind, 'Failed to report replay marker'),
			error,
		);
	}
}

function getReplayMarkerMetadata(
	prepared: PreparedChatRequest,
	state: ResponseStreamState,
): ReplayMarkerMetadata {
	return {
		...prepared.replayMarkerMetadata,
		reasoningText: state.accumulatedReasoning || undefined,
		reasoningEncryptedContent: state.encryptedReasoningContent,
	};
}

function handleThinking(
	text: string,
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	state.accumulatedReasoning += text;

	// LanguageModelThinkingPart is a proposed API; the project root augmentation provides types.
	const ThinkingPartCtor = (vscode as any).LanguageModelThinkingPart;
	if (typeof ThinkingPartCtor === 'function') {
		progress.report(new ThinkingPartCtor(text) as vscode.LanguageModelResponsePart);
	}
}

function handleToolCall(
	toolCall: BYOKToolCall,
	state: ResponseStreamState,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
): void {
	state.emittedToolCallIds.push(toolCall.id);

	try {
		const args = JSON.parse(toolCall.function.arguments);
		progress.report(
			new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, args),
		);
	} catch {
		progress.report(
			new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, {}),
		);
	}
}

function finalizeReplayDiagnostics(
	trailingToolResultIds: readonly string[],
	state: ResponseStreamState,
	cacheDiagnostics: CacheDiagnosticsRun,
): void {
	cacheDiagnostics.onDone({
		reasoningTextChars: state.accumulatedReasoning.length,
		emittedToolCalls: state.emittedToolCallIds.length,
		trailingToolResults: trailingToolResultIds.length,
	});
}

function updateCharsPerToken(
	totalRequestChars: number,
	usage: BYOKUsage,
	charsPerToken: number,
): number {
	if (totalRequestChars > 0 && usage.prompt_tokens > 0) {
		const observedRatio = totalRequestChars / usage.prompt_tokens;
		return charsPerToken * 0.7 + observedRatio * 0.3;
	}
	return charsPerToken;
}

function reportCopilotContextUsage(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	usage: BYOKUsage,
	requestKind: RequestKind,
	style?: EndpointStyle,
): void {
	const normalized = normalizeUsage(usage, style);
	const data = {
		prompt_tokens: usage.prompt_tokens,
		completion_tokens: usage.completion_tokens,
		total_tokens: usage.total_tokens,
		prompt_tokens_details: {
			cached_tokens: normalized.cache.hit,
			uncached_tokens: normalized.cache.miss,
		},
	};

	try {
		progress.report(
			new vscode.LanguageModelDataPart(
				new TextEncoder().encode(JSON.stringify(data)),
				COPILOT_USAGE_DATA_PART_MIME,
			),
		);
	} catch (error) {
		logger.warn(formatRequestLogLine(requestKind, 'Failed to report usage data'), error);
	}
}
