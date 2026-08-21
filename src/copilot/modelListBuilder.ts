import vscode from 'vscode';
import type { AuthManager } from '../config/auth';
import { getEndpoints, ENDPOINT_STYLES, getEndpointModelIds, type EndpointStyle } from '../config';
import { MODEL_TEMPLATES } from '../config/consts';
import { logger } from '../logger';
import { toChatInfo, type ModelPickerChatInformation } from '../domain/model/models';
import type { BalanceCurrencyResolver } from './pricing/currency';

/**
 * Model list builder — extracts the triple-enumeration (endpoint × style × model)
 * + template merge logic from `provideLanguageModelChatInformation`.
 *
 * Phase 2 goal (docs/ARCHITECTURE.md): keep `BYOKChatProvider` from becoming a
 * god class by isolating model picker construction here. Pure-ish (depends only
 * on injected collaborators), so it can be reasoned about / tested in isolation.
 */
export class ModelListBuilder {
	constructor(
		private readonly deps: {
			authManager: AuthManager;
			balanceCurrencyResolver: BalanceCurrencyResolver;
			isActive: () => boolean;
		},
	) {}

	/**
	 * Build the full model picker list. Mirrors the previous inline logic in
	 * `provideLanguageModelChatInformation` exactly (same ordering, same
	 * template-merge semantics, same has-key handling).
	 */
	async build(): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.deps.isActive()) {
			return [];
		}

		const pricingCurrency = this.deps.balanceCurrencyResolver.getDisplayCurrency();
		const result: ModelPickerChatInformation[] = [];

		const allEndpoints = getEndpoints();
		const hasAnyKey = await this.deps.authManager.hasAnyApiKey();
		if (hasAnyKey) {
			this.deps.balanceCurrencyResolver.refreshInBackground();
		}

		logger.info(`provideModelInfo: ${allEndpoints.length} endpoints`);

		const template = MODEL_TEMPLATES[0] || {
			family: 'byok',
			version: 'v4',
			maxInputTokens: 655360,
			maxOutputTokens: 393216,
			capabilities: { toolCalling: true, imageInput: false, thinking: false },
			thinkingEfforts: undefined,
			pricing: undefined,
			priceCategory: 'low',
		};

		for (const ep of allEndpoints) {
			logger.info(`endpoint "${ep.name}": models=${JSON.stringify(getEndpointModelIds(ep))}`);
			const epHasKey = await this.deps.authManager.getApiKeyForEndpoint(ep.name);

			for (const style of ENDPOINT_STYLES) {
				const styleConfig = ep.styles[style];
				if (!styleConfig) {
					continue;
				}
				const styleLabel = styleLabelText(style);
				const multiStyle = Object.keys(ep.styles).length > 1;

				for (const modelEntry of styleConfig.models) {
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
						const base = (builtin || template) as typeof template & { thinkingEfforts?: string[] };
						modelDef = {
							id: baseModelId,
							name: displayName,
							family: modelEntry.family ?? base.family,
							version: modelEntry.version ?? base.version,
							detail: modelEntry.detail ?? displayName,
							maxInputTokens: modelEntry.maxInputTokens ?? base.maxInputTokens,
							maxOutputTokens: modelEntry.maxOutputTokens ?? base.maxOutputTokens,
							capabilities: modelEntry.capabilities ?? base.capabilities,
							thinkingEfforts: modelEntry.thinkingEfforts ?? base.thinkingEfforts,
							pricing: modelEntry.pricing ?? base.pricing,
							priceCategory: modelEntry.priceCategory ?? base.priceCategory,
						};
					} else {
						continue;
					}

					logger.info(
						`adding endpoint model: ${baseModelId}@${ep.name}, hasKey=${!!epHasKey} (style: ${styleLabel})`,
					);

					const modelId = `${baseModelId}@${ep.name}`;
					const modelName = `${displayName} (${ep.name}${multiStyle ? ` · ${styleLabel}` : ''})`;

					result.push(
						toChatInfo(
							{ ...modelDef, id: modelId, name: modelName } as Parameters<typeof toChatInfo>[0],
							!!epHasKey,
							pricingCurrency,
						),
					);
				}
			}
		}

		logger.info(`provideModelInfo: returning ${result.length} models`);
		return result;
	}
}

function styleLabelText(style: EndpointStyle): string {
	switch (style) {
		case 'openai-responses':
			return 'OpenAI Responses';
		case 'anthropic-messages':
			return 'Claude';
		default:
			return 'OpenAI Chat';
	}
}
