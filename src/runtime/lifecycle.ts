import vscode from 'vscode';
import { AuthManager } from '../auth';
import { t } from '../i18n';
import { logger } from '../logger';
import { registerActionUrls } from './actions';
import { registerCommands } from './commands';
import { initializeDiagnostics } from './diagnostics';
import { registerProvider } from './provider';
import { registerEndpointsSidebar } from '../sidebar/tree';
import { initializeUsageTracker, registerUsageStatsSidebar, openStatsPanel } from '../stats';
import { showWelcomeIfNeeded } from './welcome';

let activeProvider: Awaited<ReturnType<typeof registerProvider>> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	console.log('[BYOK] activate() called');
	try {
		await initializeDiagnostics(context);
		console.log('[BYOK] diagnostics initialized');
	} catch (e) {
		console.error('[BYOK] initializeDiagnostics failed:', e);
	}

	// Initialize the long-term usage statistics tracker (persisted in globalState).
	const usageTracker = initializeUsageTracker(context);
	console.log('[BYOK] usage tracker initialized');

	try {
		registerCommands(context);
		console.log('[BYOK] commands registered');
	} catch (e) {
		console.error('[BYOK] registerCommands failed:', e);
	}

	try {
		registerActionUrls(context);
		console.log('[BYOK] action URLs registered');
	} catch (e) {
		console.error('[BYOK] registerActionUrls failed:', e);
	}

	try {
		registerUsageStatsSidebar(context, usageTracker);
		console.log('[BYOK] usage stats sidebar registered');

		context.subscriptions.push(
			vscode.commands.registerCommand('byok-copilot.openStatsPanel', () => {
				openStatsPanel(usageTracker);
			}),
		);

		const provider = await registerProvider(context);
		activeProvider = provider;
		console.log('[BYOK] provider registered');

		// Register the endpoints management sidebar
		const authManager = new AuthManager(context);
		registerEndpointsSidebar(context, authManager);
		console.log('[BYOK] sidebar registered');

		void showWelcomeIfNeeded(context, provider).catch((error) => {
			logger.warn(t('extension.welcomeFailed'), error);
		});

		logger.info(`Extension activated version=${context.extension.packageJSON.version}`);
		console.log('[BYOK] activation complete');
	} catch (error) {
		activeProvider = undefined;
		console.error('[BYOK] Activation failed:', error);
		logger.error('Failed to activate BYOK extension', error);
		void vscode.window.showErrorMessage(t('extension.activateFailed'));
		throw error;
	}
}

export async function deactivate(): Promise<void> {
	try {
		await activeProvider?.prepareForDeactivate();
	} catch (error) {
		logger.warn(t('extension.deactivateFailed'), error);
	} finally {
		activeProvider = undefined;
		logger.info('Extension deactivated');
		logger.dispose();
	}
}
