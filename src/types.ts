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
	/** OpenAI Responses reasoning replay token (encrypted_content), carried for re-injection. */
	reasoning_encrypted_content?: string;
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
	/** Reasoning replay: server returned an `encrypted_content` token for a `reasoning` item. */
	onReasoningToken?: (info: { itemId?: string; encryptedContent?: string }) => void;
	/** Reasoning replay (stateful): server returned a `response.id` to chain via `previous_response_id`. */
	onResponseId?: (responseId: string) => void;
}

// ---- Model definitions ----

export type PricingCurrency = 'USD' | 'CNY';

export type PriceCategory = 'low' | 'medium' | 'high' | 'very_high';

export interface ModelPricing {
	cacheHitInput: number;
	cacheMissInput: number;
	output: number;
}

/**
 * 二维价格表:每百万 token 单价(输入/输出/缓存读/缓存写)+ 工具调用按次单价。
 * 所有字段可选,未配置的项不计价。
 */
export interface PriceTable {
	/** 输入 token 单价(每百万)。 */
	input?: number;
	/** 输出 token 单价(每百万)。 */
	output?: number;
	/** 缓存读取 token 单价(每百万)。 */
	cacheRead?: number;
	/** 缓存写入 token 单价(每百万)。 */
	cacheWrite?: number;
	/** 工具调用单价(每次)。 */
	toolCall?: number;
}

/**
 * 价格阶梯:按时间/条件区分的单价档位(如闲时/忙时)。
 * `name` 为阶梯显示名;`table` 为该阶梯的价格表;`condition` 为可选的
 * 自定义条件表达式(预留,当前仅作展示,不参与自动选择)。
 */
export interface PriceTier {
	name: string;
	table: PriceTable;
	condition?: string;
}

/** 模型的完整价格配置：阶梯列表。时段留空的阶梯即为全时段默认表。 */
export interface TieredPricing {
	/** 可选的兜底价格表（所有阶梯都未命中时段时使用）。 */
	default?: PriceTable;
	/** 阶梯列表（如闲时/忙时），condition 留空 = 全时段。 */
	tiers?: PriceTier[];
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
	/** Thinking effort levels offered to the VS Code model picker for this model.
	 * Undefined/empty = the full default list (none/high/max). */
	thinkingEfforts?: string[];
	pricing?: Readonly<Record<PricingCurrency, ModelPricing>>;
	priceCategory?: PriceCategory;
	/** 阶梯价格配置(每百万 token 单价 + 工具按次),用于用量计费估算。 */
	tieredPricing?: TieredPricing;
}
