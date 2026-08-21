import vscode from 'vscode';
import { AuthManager } from '../config/auth';
import {
	getEndpoints,
	getStabilizeToolListEnabled,
} from '../config';
import { t } from '../i18n';
import { logger } from '../logger';
import { createCacheDiagnosticsRecorder, dumpProviderInput } from './debug';
import { BalanceCurrencyResolver } from './pricing/currency';
import { prepareChatRequest } from '../app/request';
import { classifyProviderRequest } from '../capability/routing';
import { resolveConversationSegment } from '../capability/segment';
import { streamChatCompletion } from '../app/stream';
import { estimateTokenCount } from '../domain/model/tokens';
import { processToolFlow } from '../capability/tools/flow';
import { createVisionService } from '../capability/vision';
import { ModelListBuilder } from './modelListBuilder';
import { healthStore } from '../profile';

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
	private readonly modelListBuilder: ModelListBuilder;

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
		this.modelListBuilder = new ModelListBuilder({
			authManager: this.authManager,
			balanceCurrencyResolver: this.balanceCurrencyResolver,
			isActive: () => this.isActive,
		});

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
				this.refreshModelsAfterAuthChange();
			}),
			// Multi-window: SecretStorage changes refresh model picker.
			context.secrets.onDidChange((e) => {
				if (e.key === 'byok-copilot.apiKey' || e.key.startsWith('byok-copilot.apiKey.')) {
					this.refreshModelsAfterAuthChange();
				}
			}),
		);
	}

	// ---- Public accessors used by command delegation (runtime/commands.ts) ----

	/** Auth manager used to set/delete per-endpoint API keys. */
	getAuthManager(): AuthManager {
		return this.authManager;
	}

	/** Vision proxy service (used to open the vision-model configuration). */
	getVision(): ReturnType<typeof createVisionService> {
		return this.vision;
	}

	/** Whether any API key is configured for any endpoint (welcome flow). */
	async hasApiKey(): Promise<boolean> {
		return this.authManager.hasAnyApiKey();
	}

	/** Force Copilot Chat to re-query model information (including configurationSchema). */
	refreshModelPicker(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
	}

	/** Invalidate cached balance currency then refresh the model picker. */
	refreshModelsAfterAuthChange(): void {
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

// ---- LanguageModelChatProvider ----

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		return this.modelListBuilder.build();
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const endpointName = endpointNameFromModelId(modelInfo.id);
		if (endpointName) {
			healthStore.recordAttempt(endpointName);
		}
		const startedAt = Date.now();

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

		// Every model accepts a tool set, so the experimental `stabilizeToolList`
		// switch is the single owner of compressing the first-round `activate_*`
		// virtual tool list. When it's off, tools pass through untouched (real
		// tools are never compressed by preflight).
		const stabilizeToolList = getStabilizeToolListEnabled();

		const toolFlow = processToolFlow({
			stabilizeToolList,
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
		}).then(
			() => {
				if (endpointName) {
					healthStore.recordSuccess(endpointName, Date.now() - startedAt);
				}
			},
			(error: unknown) => {
				if (endpointName) {
					healthStore.recordFailure(endpointName, error);
				}
				throw error;
			},
		);
	}

	async provideTokenCount(
		_modelInfo: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return estimateTokenCount(text, this.charsPerToken);
	}
}

/** Extract the `@endpointName` suffix from a model id like `deepseek@opencode`. */
function endpointNameFromModelId(modelId: string): string | undefined {
	const atIndex = modelId.indexOf('@');
	if (atIndex < 0 || atIndex === modelId.length - 1) {
		return undefined;
	}
	return modelId.slice(atIndex + 1);
}

function joinInitialResponseNotices(...notices: (string | undefined)[]): string | undefined {
	const joined = notices
		.filter((notice: string | undefined) => notice && notice.trim().length > 0)
		.join('\n');
	return joined || undefined;
}
