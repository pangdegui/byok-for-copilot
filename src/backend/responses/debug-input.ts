import type { BYOKMessage, BYOKToolCall } from '../../types';

/**
 * Shared normalization for OpenAI Responses API `input` items.
 *
 * Debug/diagnostics pipelines assume the canonical `BYOKMessage` shape in which
 * `content` is a flat string. The Responses API, however, models each input
 * item with a `content` array of typed parts (e.g.
 * `[{ type: 'output_text', text: '...' }]`), and function results arrive as
 * `{ type: 'function_call_output', output }` items. These helpers bridge the
 * gap so message summarizers never receive a non-string `content`.
 */
export function normalizeResponsesInput(
	input: unknown[] | undefined | null,
): BYOKMessage[] {
	if (!Array.isArray(input)) {
		return [];
	}
	return input
		.map((item) => normalizeResponsesInputItem(item))
		.filter((msg): msg is BYOKMessage => msg !== undefined);
}

function normalizeResponsesInputItem(item: unknown): BYOKMessage | undefined {
	if (!item || typeof item !== 'object') {
		return undefined;
	}
	const record = item as Record<string, unknown>;

	// function_call_output → tool result message
	if (record.type === 'function_call_output') {
		return {
			role: 'tool',
			content:
				typeof record.output === 'string'
					? record.output
					: record.output === undefined
						? ''
						: JSON.stringify(record.output),
			tool_call_id: typeof record.call_id === 'string' ? record.call_id : undefined,
		};
	}

	// reasoning / function_call items have no user-visible text content
	if (record.type === 'reasoning' || record.type === 'function_call') {
		return undefined;
	}

	const role = record.role;
	if (role !== 'user' && role !== 'assistant' && role !== 'system') {
		return undefined;
	}

	const content = extractResponsesContentTexts(record.content);
	const msg: BYOKMessage = {
		role,
		content,
	};
	if (role === 'assistant') {
		const rawToolCalls = record.tool_calls;
		if (Array.isArray(rawToolCalls)) {
			const toolCalls = rawToolCalls
				.map((tc) => normalizeResponsesToolCall(tc))
				.filter((tc): tc is BYOKToolCall => tc !== undefined);
			if (toolCalls.length > 0) {
				msg.tool_calls = toolCalls;
			}
		}
	}
	return msg;
}

/** Flatten a Responses `content` array (or plain string) into a joined string. */
function extractResponsesContentTexts(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	const texts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== 'object') {
			continue;
		}
		const text = (part as Record<string, unknown>).text;
		if (typeof text === 'string') {
			texts.push(text);
		}
	}
	return texts.join('');
}

function normalizeResponsesToolCall(toolCall: unknown): BYOKToolCall | undefined {
	if (!toolCall || typeof toolCall !== 'object') {
		return undefined;
	}
	const record = toolCall as Record<string, unknown>;
	const name = typeof record.name === 'string' ? record.name : '';
	const args =
		typeof record.arguments === 'string'
			? record.arguments
			: record.arguments === undefined
				? '{}'
				: JSON.stringify(record.arguments);
	return {
		id: typeof record.id === 'string' ? record.id : `fc_${name}`,
		type: 'function',
		function: { name, arguments: args },
	};
}
