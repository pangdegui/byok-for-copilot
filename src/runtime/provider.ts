import vscode from 'vscode';
import { logger } from '../logger';
import { BYOKChatProvider } from '../provider';

let provider: BYOKChatProvider | undefined;

export async function registerProvider(
	context: vscode.ExtensionContext,
): Promise<BYOKChatProvider> {
	provider = new BYOKChatProvider(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.setApiKey', () => provider!.configureApiKey()),
		vscode.commands.registerCommand('byok-copilot.clearApiKey', () => provider!.clearApiKey()),
		vscode.commands.registerCommand('byok-copilot.deleteEndpointApiKey', (endpointName?: string) =>
			provider!.deleteEndpointApiKey(endpointName),
		),
		vscode.commands.registerCommand('byok-copilot.setVisionModel', () =>
			provider!.setVisionModel(),
		),
		vscode.lm.registerLanguageModelChatProvider('byok', provider),
	);

	// Copilot Chat can serve cached model info without configurationSchema.
	// Activate it first so this refresh reaches a live listener and re-queries the provider.
	await activateCopilotChat();
	provider.refreshModelPicker();

	return provider;
}

async function activateCopilotChat(): Promise<void> {
	try {
		await vscode.extensions.getExtension('github.copilot-chat')?.activate();
	} catch (error) {
		logger.warn('Copilot Chat activation unavailable; model picker refresh may be delayed', error);
	}
}
