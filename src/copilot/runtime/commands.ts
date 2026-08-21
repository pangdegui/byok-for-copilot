import vscode from 'vscode';
import { t } from '../../i18n';
import { logger } from '../../logger';
import { ensureRequestDumpRoot } from '../debug';
import { getEndpoints, getEndpointModelIds } from '../../config';
import type { BYOKChatProvider } from '../provider';

export function registerCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.showLogs', () => logger.show()),
		vscode.commands.registerCommand('byok-copilot.openRequestDumpsFolder', () =>
			openRequestDumpsFolder(context),
		),
		vscode.commands.registerCommand('byok-copilot.getApiKey', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'byok-copilot.endpoints'),
		),
		vscode.commands.registerCommand('byok-copilot.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'byok-copilot'),
		),
	);
}

/**
 * Register the provider-scoped commands (API key management + vision model).
 *
 * Phase 2 (docs/ARCHITECTURE.md): command handling is delegated here instead
 * of living on the `BYOKChatProvider` god class. The provider only keeps the
 * three `vscode.LanguageModelChatProvider` methods plus a thin aggregate of the
 * injected collaborators.
 */
export function registerProviderCommands(
	context: vscode.ExtensionContext,
	provider: BYOKChatProvider,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.setApiKey', () =>
			vscode.commands.executeCommand(
				'workbench.action.openSettings',
				'byok-copilot.endpoints',
			),
		),
		vscode.commands.registerCommand('byok-copilot.clearApiKey', () => clearApiKey()),
		vscode.commands.registerCommand('byok-copilot.deleteEndpointApiKey', (endpointName?: string) =>
			deleteEndpointApiKey(provider, endpointName),
		),
		vscode.commands.registerCommand('byok-copilot.setVisionModel', () =>
			provider.getVision().openConfiguration(),
		),
	);
}

/** Clear / refresh API keys via the sidebar UI. */
async function clearApiKey(): Promise<void> {
	await vscode.commands.executeCommand('byok-copilot.refreshEndpoints');
}

/** Delete an endpoint's stored API key. */
async function deleteEndpointApiKey(
	provider: BYOKChatProvider,
	endpointName?: string,
): Promise<void> {
	const auth = provider.getAuthManager();
	let selectedName: string | undefined;

	if (endpointName) {
		selectedName = endpointName;
	} else {
		const endpoints = getEndpoints();
		if (endpoints.length === 0) {
			vscode.window.showErrorMessage('没有已配置的端点');
			return;
		}
		const selected = await vscode.window.showQuickPick(
			endpoints.map((e) => ({
				label: e.name,
				description: e.baseUrl,
				detail: `模型: ${getEndpointModelIds(e).join(', ')}`,
			})),
			{ placeHolder: '选择要删除 API Key 的端点' },
		);
		if (!selected) return;
		selectedName = selected.label;
	}

	await auth.deleteApiKey(selectedName);
	provider.refreshModelsAfterAuthChange();
	vscode.window.showInformationMessage(`端点 "${selectedName}" 的 API Key 已删除`);
}

async function openRequestDumpsFolder(context: vscode.ExtensionContext): Promise<void> {
	try {
		const root = await ensureRequestDumpRoot(context.globalStorageUri);
		logger.info(`Opening request dumps folder: ${root.toString(true)}`);
		await vscode.commands.executeCommand('revealFileInOS', root);
	} catch (error) {
		logger.warn('Failed to open request dumps folder', error);
		void vscode.window.showErrorMessage(t('extension.openRequestDumpsFolderFailed'));
	}
}
