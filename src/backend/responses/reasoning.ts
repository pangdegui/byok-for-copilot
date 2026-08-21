import {
	getStoreReasoningEnabled,
	isReasoningReplaySupported,
	type EndpointStyle,
} from '../../config';
import type { ReasoningReplayConfig } from '../shared/contract';
import { reasoningStateCache } from './reasoning-cache';

/**
 * Reasoning replay decision (OpenAI Responses style only).
 *
 * Encapsulates everything the main request pipeline used to know about
 * reasoning replay: whether it applies to this model/endpoint, which mode
 * (stateful vs encrypted) to use, and which previous `response.id` to chain
 * onto. Chat / Anthropic styles simply get `{ enabled: false }`.
 */
export function resolveReasoningReplay({
	style,
	endpointName,
	baseModelId,
	segmentId,
	isThinkingModel,
}: {
	style: EndpointStyle;
	endpointName: string;
	baseModelId: string;
	/** Conversation segment id, used as the reasoning-state cache key. */
	segmentId: string;
	isThinkingModel: boolean;
}): ReasoningReplayConfig {
	const enabled =
		style === 'openai-responses' &&
		isThinkingModel &&
		isReasoningReplaySupported(endpointName, baseModelId);
	const config: ReasoningReplayConfig = {
		enabled,
		mode: getStoreReasoningEnabled() ? 'stateful' : 'encrypted',
		previousResponseId: undefined,
	};
	if (enabled && config.mode === 'stateful') {
		config.previousResponseId = reasoningStateCache.get(segmentId);
	}
	return config;
}
