import vscode from 'vscode';
import { AuthManager } from '../auth';
import { getEndpoints, getStabilizeToolListEnabled } from '../config';
import { MODEL_TEMPLATES } from '../consts';
import { t } from '../i18n';
import { logger } from '../logger';
import { createCacheDiagnosticsRecorder, dumpProviderInput } from './debug';
import { toChatInfo } from './models';
import { BalanceCurrencyResolver } from './pricing/currency';
import { prepareChatRequest } from './request';
import { classifyProviderRequest } from './routing';
import { resolveConversationSegment } from './segment';
import { streamChatCompletion } from './stream';
import { estimateTokenCount } from './tokens';
import { processToolFlow } from './tools/flow';
import { createVisionService } from './vision';

/**
 * BYOK Chat Provider — implements vscode.LanguageModelChatProvider so
 * BYOK V4 models appear directly in the Copilot Chat model picker.
 */
export class BYOKChatProvider implements vscode.LanguageModelChatProvider {
	private readonly authManager: AuthManager;
	private readonly globalStorageUri: vscode.Uri;
	private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
	private isActive = true;

	readonly onDidChangeLanguageModelChatInformation =
		this.onDidChangeLanguageModelChatInformationEmitter.event;

	private readonly cacheDiagnostics = createCacheDiagnosticsRecorder();

	/** Vision proxy: internal bridge + VS Code LM fallback. */
	private readonly vision: ReturnType<typeof createVisionService>;
	private readonly balanceCurrencyResolver: BalanceCurrencyResolver;

	/**
	 * Adaptive chars-per-token ratio, calibrated from actual usage data.
	 * Updated via exponential moving average each time the API reports real token counts.
	 */
	private charsPerToken = 4.0;

	constructor(context: vscode.ExtensionContext) {
		this.authManager = new AuthManager(context);
		this.globalStorageUri = context.globalStorageUri;
		this.vision = createVisionService(context);
		this.balanceCurrencyResolver = new BalanceCurrencyResolver(
			context,
			this.authManager,
			() => this.onDidChangeLanguageModelChatInformationEmitter.fire(),
		);

		// No legacy key migration needed — all keys are per-endpoint.
		// Snapshot relevant config values so we only refresh on actual changes.
		let prevEndpointsJson = JSON.stringify(getEndpoints());

		context.subscriptions.push(
			this.onDidChangeLanguageModelChatInformationEmitter,
			// Endpoint configuration changes.
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (!e.affectsConfiguration('byok-copilot.endpoints')) {
					return;
				}
				const newEndpointsJson = JSON.stringify(getEndpoints());
				if (newEndpointsJson === prevEndpointsJson) {
					return;
				}
				prevEndpointsJson = newEndpointsJson;
				this.invalidateCurrencyAndRefreshModels();
			}),
			// Multi-window: SecretStorage changes refresh model picker.
			context.secrets.onDidChange((e) => {
				if (e.key === 'byok-copilot.apiKey' || e.key.startsWith('byok-copilot.apiKey.')) {
					this.invalidateCurrencyAndRefreshModels();
				}
			}),
		);
	}

	// ---- Public commands ----

	async configureApiKey(): Promise<void> {
		// Open the endpoints settings page for the user to configure endpoints and keys
		await vscode.commands.executeCommand(
			'workbench.action.openSettings',
			'byok-copilot.endpoints',
		);
	}

	async clearApiKey(): Promise<void> {
		// Clear API keys via the sidebar UI
		await vscode.commands.executeCommand('byok-copilot.refreshEndpoints');
	}

	async hasApiKey(): Promise<boolean> {
		return this.authManager.hasAnyApiKey();
	}

	/** Force Copilot Chat to re-query model information (including configurationSchema). */
	refreshModelPicker(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
	}

	private invalidateCurrencyAndRefreshModels(): void {
		void this.balanceCurrencyResolver
			.invalidate()
			.catch((error) => logger.warn('Failed to invalidate BYOK balance currency', error))
			.finally(() => this.onDidChangeLanguageModelChatInformationEmitter.fire());
	}

	async prepareForDeactivate(): Promise<void> {
		this.isActive = false;
		this.onDidChangeLanguageModelChatInformationEmitter.fire();

		// Force the host to re-pull `provideLanguageModelChatInformation` synchronously
		// before the extension unloads. With `isActive = false` we now return [],
		// which makes Copilot Chat drop BYOK models from the picker immediately
		// instead of leaving stale entries behind after deactivate. The returned
		// model list itself is unused — we only call this for its side effect.
		try {
			await vscode.lm.selectChatModels({ vendor: 'byok' });
		} catch (error) {
			logger.warn('Failed to refresh BYOK models during deactivate', error);
		}
	}

	async setVisionModel(): Promise<void> {
		await this.vision.openConfiguration();
	}

	async configureEndpointApiKey(endpointName?: string): Promise<void> {
		let selectedName: string | undefined;

		if (endpointName) {
			selectedName = endpointName;
		} else {
			const endpoints = getEndpoints();
			if (endpoints.length === 0) {
				vscode.window.showErrorMessage('请先在设置中配置 byok-copilot.endpoints');
				return;
			}
			const selected = await vscode.window.showQuickPick(
				endpoints.map((e) => ({
					label: e.name,
					description: e.baseUrl,
					detail: `模型: ${e.models.join(', ')}`,
				})),
				{ placeHolder: '选择要设置 API Key 的端点' },
			);
			if (!selected) return;
			selectedName = selected.label;
		}

		const key = await vscode.window.showInputBox({
			prompt: `为端点 "${selectedName}" 输入 API Key`,
			password: true,
			ignoreFocusOut: true,
			validateInput: (v: string) => (!v?.trim() ? 'API Key 不能为空' : undefined),
		});

		if (key) {
			await this.authManager.setApiKey(key, selectedName);
			this.invalidateCurrencyAndRefreshModels();
			vscode.window.showInformationMessage(`端点 "${selectedName}" 的 API Key 已保存`);
		}
	}

	async deleteEndpointApiKey(endpointName?: string): Promise<void> {
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
					detail: `模型: ${e.models.join(', ')}`,
				})),
				{ placeHolder: '选择要删除 API Key 的端点' },
			);
			if (!selected) return;
			selectedName = selected.label;
		}

		await this.authManager.deleteApiKey(selectedName);
		this.invalidateCurrencyAndRefreshModels();
		vscode.window.showInformationMessage(`端点 "${selectedName}" 的 API Key 已删除`);
	}

// ---- LanguageModelChatProvider ----

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.isActive) {
			return [];
		}

		const pricingCurrency = this.balanceCurrencyResolver.getDisplayCurrency();
		const result: vscode.LanguageModelChatInformation[] = [];

		// Collect ALL user-configured endpoints
		const allEndpoints = getEndpoints();

		// Check if any key is configured for background refresh
		const hasAnyKey = await this.authManager.hasAnyApiKey();
		if (hasAnyKey) {
			this.balanceCurrencyResolver.refreshInBackground();
		}

		logger.info(`provideModelInfo: ${allEndpoints.length} endpoints`);

		const template = MODEL_TEMPLATES[0] || {
			family: 'byok',
			version: 'v4',
			maxInputTokens: 655360,
			maxOutputTokens: 393216,
			capabilities: { toolCalling: 128, imageInput: false },
			requiresThinkingParam: false,
			pricing: undefined,
			priceCategory: 'low',
		};

		for (const ep of allEndpoints) {
			logger.info(`endpoint "${ep.name}": models=${JSON.stringify(ep.models)}`);
			const epHasKey = await this.authManager.getApiKeyForEndpoint(ep.name);

			for (const modelEntry of ep.models) {
				let baseModelId: string;
				let displayName: string;
				let modelDef: Record<string, unknown>;

				if (typeof modelEntry === 'string') {
					baseModelId = modelEntry;
					const found = MODEL_TEMPLATES.find((m) => m.id === baseModelId);
					if (found) {
						modelDef = found as unknown as Record<string, unknown>;
						displayName = modelDef.name as string;
					} else {
						// Model not in built-in templates — use default template with the custom model ID
						logger.info(`endpoint model "${baseModelId}" is custom, using default template`);
						modelDef = {
							...template,
							id: baseModelId,
							name: baseModelId,
							detail: `Custom model: ${baseModelId}`,
						};
						displayName = baseModelId;
					}
				} else if (typeof modelEntry === 'object' && modelEntry.id) {
					baseModelId = modelEntry.id;
					displayName = modelEntry.displayName || modelEntry.id;
					const builtin = MODEL_TEMPLATES.find((m) => m.id === baseModelId);
					const base = builtin || template;
					modelDef = {
						id: baseModelId,
						name: displayName,
						family: modelEntry.family ?? base.family,
						version: modelEntry.version ?? base.version,
						detail: modelEntry.detail ?? displayName,
						maxInputTokens: modelEntry.maxInputTokens ?? base.maxInputTokens,
						maxOutputTokens: modelEntry.maxOutputTokens ?? base.maxOutputTokens,
						capabilities: modelEntry.capabilities ?? base.capabilities,
						requiresThinkingParam:
							modelEntry.requiresThinkingParam ?? base.requiresThinkingParam,
						pricing: modelEntry.pricing ?? base.pricing,
						priceCategory: modelEntry.priceCategory ?? base.priceCategory,
					};
				} else {
					continue;
				}

				logger.info(
					`adding endpoint model: ${baseModelId}@${ep.name}, hasKey=${!!epHasKey}`,
				);

				const modelId = `${baseModelId}@${ep.name}`;
				const modelName = `${displayName} (${ep.name})`;

				result.push(
					toChatInfo(
						{ ...modelDef, id: modelId, name: modelName } as Parameters<typeof toChatInfo>[0],
						!!epHasKey,
						pricingCurrency,
					),
				);
			}
		}

		logger.info(`provideModelInfo: returning ${result.length} models`);
		return result;
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const segment = resolveConversationSegment(messages);
		const requestKind = classifyProviderRequest({
			messages,
			tools: options.tools,
		});

		dumpProviderInput({
			globalStorageUri: this.globalStorageUri,
			segment,
			modelInfo,
			messages,
			requestOptions: options,
			requestKind,
		});

		const toolFlow = processToolFlow({
			stabilizeToolList: getStabilizeToolListEnabled(),
			messages,
			tools: options.tools,
			progress,
			requestKind,
		});
		if (toolFlow.preflightHandled) {
			return;
		}

		const prepared = await prepareChatRequest({
			authManager: this.authManager,
			globalStorageUri: this.globalStorageUri,
			modelInfo,
			segment,
			messages: toolFlow.messages,
			options,
			token,
			cacheDiagnostics: this.cacheDiagnostics,
			getVisionDescriber: () => this.vision.get(),
		});

		return streamChatCompletion({
			prepared,
			progress,
			token,
			initialResponseNotice: joinInitialResponseNotices(
				toolFlow.initialResponseNotice,
				prepared.initialResponseNotice,
			),
			getCharsPerToken: () => this.charsPerToken,
			setCharsPerToken: (charsPerToken: number) => {
				this.charsPerToken = charsPerToken;
			},
		});
	}

	async provideTokenCount(
		_modelInfo: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return estimateTokenCount(text, this.charsPerToken);
	}
}

function joinInitialResponseNotices(...notices: (string | undefined)[]): string | undefined {
	const joined = notices
		.filter((notice: string | undefined) => notice && notice.trim().length > 0)
		.join('\n');
	return joined || undefined;
}
