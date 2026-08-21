import vscode from 'vscode';
import { t } from '../../i18n';
import { logToolFlowDiagnostics } from '../../copilot/debug';
import type { RequestKind } from '../routing';
import { ACTIVATE_TOOL_PREFIX, MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST } from './consts';
import { createToolDriftNotice, filterProviderNotices } from './notices';
import {
	createPreflightToolCallId,
	filterPreflightControlFlow,
	inspectActivatePreflight,
} from './preflight';

interface ToolFlowOptions {
	stabilizeToolList: boolean;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	tools: readonly vscode.LanguageModelChatTool[] | undefined;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	requestKind: RequestKind;
}

interface ToolFlowResult {
	preflightHandled: boolean;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	initialResponseNotice?: string;
}

/**
 * Tool flow orchestration — Phase 4 "[正名]" (docs/ARCHITECTURE.md §2.4).
 *
 * ⚠️ 真实目的 = **压缩首轮 prompt 的 `activate_*` 虚拟工具集长度**,而非
 * "BYOK 替 Copilot 代答真实工具"。Copilot Chat 会把一批 `activate_<agent|skill>`
 * 前缀的虚拟激活工具注入 `options.tools`;本流程检查它们是否都已被调用过,若有
 * 未调用的,则短路返回并代发一次激活调用,让 Copilot 侧认为"激活已完成",
 * 从而下一轮不再重复注入全量 `activate_*`,压制首轮工具集长度、省上下文。
 *
 * 普通工具与 preflight 无关:它们只被 `prepareRequestTools`(tools/request.ts)
 * 作 `convertTools` 透传;调用/执行/回喂全部由 Copilot agent loop 负责。
 *
 * 维持"默认关闭 + experimental"(见 `getStabilizeToolListEnabled`,默认 false)。
 */
export function processToolFlow({
	stabilizeToolList,
	messages,
	tools,
	progress,
	requestKind,
}: ToolFlowOptions): ToolFlowResult {
	const filteredMessages = filterProviderNotices(filterPreflightControlFlow(messages));
	const messagesFiltered = filteredMessages !== messages;

	if (!stabilizeToolList) {
		logToolFlowDiagnostics({
			requestKind,
			tools,
			messagesFiltered,
			preflight: 'skipped',
		});
		return {
			preflightHandled: false,
			messages: filteredMessages,
		};
	}

	const activatePreflight = inspectActivatePreflight(messages, tools);
	if (activatePreflight.remainingActivatorNames.length > 0) {
		if (activatePreflight.rounds >= MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST) {
			logToolFlowDiagnostics({
				requestKind,
				tools,
				messagesFiltered,
				preflight: 'round-limit',
				activatePreflight,
			});
			throw new Error(
				t('request.preflightRoundLimitExceeded', MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST),
			);
		}

		const nextRound = activatePreflight.rounds + 1;
		logToolFlowDiagnostics({
			requestKind,
			tools,
			messagesFiltered,
			preflight: 'handled',
			activatePreflight,
			nextRound,
		});
		for (const toolName of activatePreflight.remainingActivatorNames) {
			progress.report(
				new vscode.LanguageModelToolCallPart(
					createPreflightToolCallId(nextRound, toolName),
					toolName,
					{},
				),
			);
		}

		return { preflightHandled: true, messages };
	}

	const hasUnexpandedActivateTools =
		activatePreflight.rounds > 0 &&
		tools?.some((tool) => tool.name.startsWith(ACTIVATE_TOOL_PREFIX));
	logToolFlowDiagnostics({
		requestKind,
		tools,
		messagesFiltered,
		preflight: 'ready',
		activatePreflight,
		initialResponseNotice: hasUnexpandedActivateTools,
	});

	return {
		preflightHandled: false,
		messages: filteredMessages,
		initialResponseNotice: hasUnexpandedActivateTools ? createToolDriftNotice() : undefined,
	};
}
