import vscode from 'vscode';
import { API_KEY_SECRET } from './consts';
import { t } from './i18n';
import { getEndpoints } from './config';

/**
 * Manages API keys via VS Code SecretStorage (secure).
 * All keys are per-endpoint — no global default key.
 */
export class AuthManager {
	private readonly secretStorage: vscode.SecretStorage;

	constructor(context: vscode.ExtensionContext) {
		this.secretStorage = context.secrets;
	}

	/**
	 * Store API key for a specific endpoint.
	 */
	async setApiKey(apiKey: string, endpointName: string): Promise<void> {
		if (!endpointName) {
			throw new Error('endpointName is required for setApiKey');
		}
		const key = `${API_KEY_SECRET}.${endpointName}`;
		await this.secretStorage.store(key, apiKey.trim());
	}

	/**
	 * Delete stored API key for a specific endpoint.
	 */
	async deleteApiKey(endpointName: string): Promise<void> {
		if (!endpointName) {
			return;
		}
		const key = `${API_KEY_SECRET}.${endpointName}`;
		await this.secretStorage.delete(key);
	}

	/**
	 * Get API key for a specific endpoint name.
	 * Returns undefined if no key is stored.
	 */
	async getApiKeyForEndpoint(endpointName: string): Promise<string | undefined> {
		if (!endpointName) {
			return undefined;
		}
		const scopedKey = `${API_KEY_SECRET}.${endpointName}`;
		return this.secretStorage.get(scopedKey);
	}

	/**
	 * Check if any API key is configured for any endpoint.
	 */
	async hasAnyApiKey(): Promise<boolean> {
		const endpoints = getEndpoints();
		for (const ep of endpoints) {
			const key = await this.secretStorage.get(`${API_KEY_SECRET}.${ep.name}`);
			if (key) return true;
		}
		return false;
	}

	/**
	 * Prompt user to enter API key for a specific endpoint.
	 */
	async promptForApiKey(endpointName?: string): Promise<boolean> {
		if (!endpointName) {
			const endpoints = getEndpoints();
			if (endpoints.length === 0) {
				vscode.window.showErrorMessage('请先在设置中添加端点');
				return false;
			}
			endpointName = endpoints[0].name;
		}

		const apiKey = await vscode.window.showInputBox({
			prompt: t('auth.prompt'),
			placeHolder: t('auth.placeholder'),
			password: true,
			ignoreFocusOut: true,
			validateInput: (value: string) => {
				if (!value?.trim()) {
					return t('auth.emptyValidation');
				}
				return undefined;
			},
		});

		if (apiKey) {
			await this.setApiKey(apiKey, endpointName);
			vscode.window.showInformationMessage(`端点 "${endpointName}" 的 API Key 已保存`);
			return true;
		}

		return false;
	}
}
