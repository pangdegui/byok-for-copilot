import vscode from 'vscode';
import type { BYOKMessage, BYOKTool } from '../../types';
import { convertTools } from './convert';

/**
 * Pass through the chat tools Copilot's agent loop supplied. Every model
 * accepts a tool set — we never gate it on a per-model `toolCalling` capability
 * here. If the tool list is too large, that's the job of the experimental
 * `experimental.stabilizeToolList` switch (tools/flow.ts), which compresses the
 * first-round `activate_*` virtual tools only, never real ones.
 */
export function prepareRequestTools(
	options: vscode.ProvideLanguageModelChatResponseOptions,
): BYOKTool[] | undefined {
	return convertTools(options.tools);
}

export function collectTrailingToolResultIds(messages: readonly BYOKMessage[]): string[] {
	const trailingToolResultIds: string[] = [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== 'tool' || !message.tool_call_id) {
			break;
		}
		trailingToolResultIds.push(message.tool_call_id);
	}
	return trailingToolResultIds.reverse();
}
