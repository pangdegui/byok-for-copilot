/**
 * Shared types for the BYOK Copilot extension.
 */

// ---- API request/response types ----

export interface BYOKMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_call_id?: string;
	tool_calls?: BYOKToolCall[];
	reasoning_content?: string;
}

export interface BYOKToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface BYOKTool {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface BYOKUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	/** DeepSeek / OpenAI-compatible flat cache fields. */
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
	/** OpenAI official format: usage.prompt_tokens_details.cached_tokens. */
	prompt_tokens_details?: {
		cached_tokens?: number;
	};
	/** Anthropic Messages format cache fields. */
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
}

export interface BYOKRequest {
	model: string;
	messages: BYOKMessage[];
	stream: boolean;
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	tools?: BYOKTool[];
	tool_choice?: 'none' | 'auto' | 'required';
	thinking?: { type: 'enabled' | 'disabled' };
	reasoning_effort?: 'high' | 'max';
	stream_options?: {
		include_usage: boolean;
	};
}

export interface BYOKStreamChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason: string | null;
	}>;
	usage?: BYOKUsage;
}

// ---- Stream callbacks ----

export interface StreamCallbacks {
	onContent: (content: string) => void;
	onThinking: (text: string) => void;
	onToolCall: (toolCall: BYOKToolCall) => void;
	onError: (error: Error) => void;
	onDone: () => void;
	onUsage?: (usage: BYOKUsage) => void;
}

// ---- Model definitions ----

export type PricingCurrency = 'USD' | 'CNY';

export type PriceCategory = 'low' | 'medium' | 'high' | 'very_high';

export interface ModelPricing {
	cacheHitInput: number;
	cacheMissInput: number;
	output: number;
}

export interface ModelDefinition {
	id: string;
	name: string;
	family: string;
	version: string;
	detail: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	capabilities: {
		toolCalling: boolean | number;
		imageInput: boolean;
		thinking: boolean;
	};
	requiresThinkingParam: boolean;
	pricing?: Readonly<Record<PricingCurrency, ModelPricing>>;
	priceCategory?: PriceCategory;
}
