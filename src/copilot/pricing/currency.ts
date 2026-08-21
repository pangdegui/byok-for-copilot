import vscode from 'vscode';

/**
 * Provides a display currency for pricing information.
 * For a generic BYOK adapter, uses locale-based fallback (CNY for zh-*, USD otherwise).
 */
export class BalanceCurrencyResolver {
	constructor(
		_context: vscode.ExtensionContext,
		_authManager: unknown,
		private readonly onDidChangeCurrency: () => void,
	) {}

	getDisplayCurrency(): 'USD' | 'CNY' {
		return getLocaleFallbackCurrency();
	}

	refreshInBackground(): void {
		// No-op: generic adapter does not fetch balance from a specific provider.
	}

	async invalidate(): Promise<void> {
		// No-op
	}

	needsRefresh(): boolean {
		return false;
	}
}

function getLocaleFallbackCurrency(): 'USD' | 'CNY' {
	return vscode.env.language.toLowerCase().startsWith('zh') ? 'CNY' : 'USD';
}
