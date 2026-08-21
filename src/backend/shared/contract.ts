import type { BYOKMessage, BYOKRequest, BYOKTool, StreamCallbacks } from '../../types';
import type { ThinkingEffort } from '../../domain/model/models';
import type { CancellationToken } from 'vscode';

export interface ErrorActionUrls {
	configureApiKey?: string;
	showLogs?: string;
}

export interface RequestErrorContext {
	baseUrl: string;
	request: BYOKRequest;
}

export interface ErrorActionLink {
	labelKey: string;
	url: string;
}

export interface HttpErrorLinkDefinition {
	labelKey: string;
	url: string;
}

export type ApiProviderId = string;
export type HttpErrorLinkStatusKey = 401 | 402 | '5xx';

export type BYOKRequestErrorKind = 'http' | 'network' | 'unknown';

export type NetworkErrorCategory =
	| 'dns'
	| 'unreachable'
	| 'interrupted'
	| 'timeout'
	| 'tls'
	| 'aborted'
	| 'protocol'
	| 'configuration'
	| 'generic';

// ---- Request-body builder contract (per-style) ----

/** Reasoning replay configuration for the OpenAI Responses style. */
export interface ReasoningReplayConfig {
	/** Active only when the style declares support AND the model is a thinking model. */
	enabled: boolean;
	/** 'stateful' uses server-side store + `previous_response_id`; 'encrypted' uses `encrypted_content`. */
	mode: 'stateful' | 'encrypted';
	/** Cached previous `response.id` for stateful chaining (undefined on the first turn). */
	previousResponseId?: string;
}

/** Common inputs every style-specific request builder needs. */
export interface BuildRequestBodyContext {
	baseModelId: string;
	messages: BYOKMessage[];
	tools: BYOKTool[] | undefined;
	maxTokens: number | undefined;
	isThinkingModel: boolean;
	thinkingEffort: ThinkingEffort;
	reasoning: ReasoningReplayConfig;
}

/** Style contract: turn normalized BYOK inputs into the wire request body.
 * Each style implements this under `backend/<style>/request.ts`,
 * and `app/request.ts` dispatches by `EndpointStyle`. */
export interface RequestBodyBuilder {
	buildRequest(ctx: BuildRequestBodyContext): Record<string, unknown>;
}

/** Common streaming interface shared by every style client. The main code
 * (`app/stream.ts`) only depends on this shape, never on a concrete client. */
export interface StyleClient {
	streamChatCompletion(
		request: Record<string, unknown>,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void>;
}
