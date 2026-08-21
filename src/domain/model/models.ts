import vscode from 'vscode';
import { t } from '../../i18n';
import type { ModelDefinition, PricingCurrency } from '../../types';
import { toModelCostInfo, type ModelCostInformation } from '../../copilot/pricing/costs';

/**
 * NOTE: Non-public API surface.
 *
 * The fields below (`configurationSchema` on chat info, cost metadata,
 * `modelConfiguration` on response options, plus `isBYOK` / `isUserSelectable` /
 * `statusIcon`)
 * are not part of the stable `vscode.LanguageModelChat*` typings yet. They are
 * the same shape currently consumed by GitHub Copilot Chat to render model picker
 * metadata and per-model configuration controls.
 */

/** Thinking effort value sent to the backend. Free-form: the plugin passes
 * whatever the per-model effort list declares (e.g. 'none' | 'high' | 'middle'). */
export type ThinkingEffort = string;

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

type ThinkingEffortConfigurationSchema = ReturnType<typeof buildThinkingEffortSchema>;

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation &
	ModelCostInformation & {
		readonly isUserSelectable: boolean;
		readonly isBYOK: true;
		readonly statusIcon?: vscode.ThemeIcon;
		readonly configurationSchema?: ThinkingEffortConfigurationSchema;
	};

export function toChatInfo(
	m: ModelDefinition,
	hasApiKey: boolean,
	pricingCurrency?: PricingCurrency,
): ModelPickerChatInformation {
	const modelDetail = resolveModelText(m, 'detail') ?? m.detail;
	const modelTooltip = resolveModelText(m, 'tooltip');
	return {
		id: m.id,
		name: m.name,
		family: m.family,
		version: m.version,
		detail: hasApiKey ? modelDetail : t('auth.apiKeyRequiredDetail'),
		tooltip: hasApiKey ? modelTooltip : t('auth.apiKeyRequiredDetail'),
		statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
		maxInputTokens: m.maxInputTokens,
		maxOutputTokens: m.maxOutputTokens,
		isBYOK: true,
		isUserSelectable: true,
		capabilities: {
			toolCalling: m.capabilities.toolCalling,
			imageInput: m.capabilities.imageInput,
		},
		...toModelCostInfo(m, pricingCurrency),
		...(m.capabilities.thinking
			? { configurationSchema: buildThinkingEffortSchema(m.thinkingEfforts) }
			: {}),
	};
}

export function getConfiguredThinkingEffort(options: ModelConfigurationOptions): ThinkingEffort {
	const configuredEffort =
		options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;

	// The value comes straight from the VS Code model picker; it is whatever the
	// per-model effort list declared. Default to 'high' when unset.
	return typeof configuredEffort === 'string' && configuredEffort ? configuredEffort : 'high';
}

/** Parse one effort-list entry. `display(value)` → {label: display, value: value};
 * a bare `value` is used as both label and wire value. */
function parseEffortEntry(entry: string): { value: string; label: string } | undefined {
	const trimmed = entry.trim();
	if (!trimmed) {
		return undefined;
	}
	const match = trimmed.match(/^(.+)\((.+)\)$/);
	if (match) {
		const label = match[1].trim();
		const value = match[2].trim();
		return label && value ? { label, value } : undefined;
	}
	return { label: trimmed, value: trimmed };
}

function buildThinkingEffortSchema(efforts?: string[]) {
	// Per-model override: the configured list defines exactly what the VS Code
	// model picker offers. Entries are free-form: bare values (`middle`) or
	// display/param pairs (`标准(middle)`). Empty/undefined = default list.
	const DEFAULT_EFFORTS = ['none', 'high', 'max'];
	const parsed = (efforts ?? [])
		.map(parseEffortEntry)
		.filter((l): l is { value: string; label: string } => l !== undefined);
	const levels = parsed.length > 0 ? parsed : DEFAULT_EFFORTS.map((v) => ({ value: v, label: v }));

	return {
		properties: {
			reasoningEffort: {
				type: 'string',
				title: t('status.thinking'),
				enum: levels.map((l) => l.value),
				enumItemLabels: levels.map((l) => l.label),
				enumDescriptions: levels.map((l) => l.label),
				default: levels.some((l) => l.value === 'high') ? 'high' : levels[0].value,
				group: 'navigation',
			},
		},
	} as const;
}

function resolveModelText(m: ModelDefinition, field: 'detail' | 'tooltip'): string | undefined {
	const suffix = m.id.startsWith('byok-v4-') ? m.id.slice('byok-v4-'.length) : m.id;
	const key = `model.${suffix}.${field}`;
	const translated = t(key);
	return translated !== key ? translated : undefined;
}
