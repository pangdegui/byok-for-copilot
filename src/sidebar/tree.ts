import vscode from 'vscode';
import type { AuthManager } from '../auth';
import { CONFIG_SECTION, API_KEY_SECRET } from '../consts';
import { getEndpoints, type EndpointConfig } from '../config';

const VIEW_ID = 'byok-copilot.endpointsSidebar';

enum TreeItemType {
	ENDPOINT = 1,
	KEY_ITEM = 2,
	MODELS_HEADER = 3,
	MODEL_ITEM = 4,
}

class EndpointTreeItem extends vscode.TreeItem {
	type: TreeItemType;
	endpointName: string;
	modelId: string | undefined;

	constructor(
		label: string,
		type: TreeItemType,
		endpointName: string,
		collapsibleState?: vscode.TreeItemCollapsibleState,
	) {
		super(label, collapsibleState ?? vscode.TreeItemCollapsibleState.None);
		this.type = type;
		this.endpointName = endpointName;
		this.modelId = undefined;
	}
}

/** 从 tree view 内联按钮回调参数中提取端点名称 */
function resolveEndpointName(arg: unknown): string {
	if (arg instanceof EndpointTreeItem) {
		return arg.endpointName || '';
	}
	if (typeof arg === 'string') {
		return arg;
	}
	return '';
}

/** 从 tree view 内联按钮回调参数中提取模型 ID */
function resolveModelId(arg: unknown): string {
	if (arg instanceof EndpointTreeItem) {
		return arg.modelId || '';
	}
	if (typeof arg === 'string') {
		return arg;
	}
	return '';
}

function iconPath(color: string): vscode.Uri {
	return vscode.Uri.parse(
		`data:image/svg+xml,${encodeURIComponent(
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="4" fill="${encodeURIComponent(color)}"/></svg>`,
		)}`,
	);
}

export class EndpointsTreeDataProvider implements vscode.TreeDataProvider<EndpointTreeItem> {
	private readonly authManager: AuthManager;
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<EndpointTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly keyStatusCache = new Map<string, boolean>();

	constructor(authManager: AuthManager) {
		this.authManager = authManager;
	}

	refresh(): void {
		this.keyStatusCache.clear();
		this._onDidChangeTreeData.fire(undefined);
	}

	async getChildren(element?: EndpointTreeItem): Promise<EndpointTreeItem[]> {
		if (!element) {
			return this.buildRootItems();
		}
		if (element.type === TreeItemType.ENDPOINT) {
			const endpoints = getEndpoints();
			const ep = endpoints.find(e => e.name === element.endpointName);
			if (ep) {
				return this.buildEndpointChildren(ep);
			}
		}
		return [];
	}

	private async buildRootItems(): Promise<EndpointTreeItem[]> {
		const items: EndpointTreeItem[] = [];
		const endpoints = getEndpoints();

		for (const ep of endpoints) {
			const hasKey = await this.getKeyStatus(ep.name);
			const protocolLabel = ep.protocol === 'anthropic-messages' ? 'Anthropic' : 'OpenAI';
			const epItem = new EndpointTreeItem(
				ep.name,
				TreeItemType.ENDPOINT,
				ep.name,
				vscode.TreeItemCollapsibleState.Expanded,
			);
			epItem.description = `${ep.baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')} (${protocolLabel})`;
			epItem.iconPath = hasKey ? iconPath('#4caf50') : iconPath('#ff9800');
			epItem.tooltip = [
				`端点: ${ep.name}`,
				`URL: ${ep.baseUrl}`,
				`协议: ${ep.protocol || 'openai-completions'}`,
				`模型: ${ep.models.map(m => typeof m === 'string' ? m : m.id).join(', ')}`,
				`API Key: ${hasKey ? '已配置 ✓' : '未配置 ✗'}`,
			].join('\n');

			epItem.contextValue = hasKey ? 'endpointKeySet' : 'endpointKeyUnset';
			items.push(epItem);
		}

		return items;
	}

	private async buildEndpointChildren(endpoint: EndpointConfig): Promise<EndpointTreeItem[]> {
		const items: EndpointTreeItem[] = [];
		const hasKey = await this.getKeyStatus(endpoint.name);

		// ---- API Key item (with inline set/clear icon) ----
		const keyItem = new EndpointTreeItem(
			`API Key: ${hasKey ? '已配置 ✓' : '未配置 ✗'}`,
			TreeItemType.KEY_ITEM,
			endpoint.name,
		);
		keyItem.iconPath = hasKey ? iconPath('#4caf50') : iconPath('#f44336');
		keyItem.tooltip = hasKey
			? 'API Key 已安全存储在 SecretStorage 中'
			: '请为此端点设置 API Key';
		keyItem.contextValue = hasKey ? 'endpointKeyItemSet' : 'endpointKeyItemUnset';
		items.push(keyItem);

		// ---- Models header (with inline add model icon) ----
		const modelsHeader = new EndpointTreeItem(
			`模型 (${endpoint.models.length})`,
			TreeItemType.MODELS_HEADER,
			endpoint.name,
		);
		modelsHeader.iconPath = new vscode.ThemeIcon('symbol-class');
		modelsHeader.tooltip = '此端点服务的模型列表';
		modelsHeader.contextValue = 'modelsHeader';
		items.push(modelsHeader);

		// ---- Individual model items (with inline delete icon) ----
		for (const m of endpoint.models) {
			const modelId = typeof m === 'string' ? m : m.id;
			const modelDisplay = typeof m === 'string' ? m : (m.displayName || m.id);
			const modelItem = new EndpointTreeItem(
				modelDisplay,
				TreeItemType.MODEL_ITEM,
				endpoint.name,
			);
			modelItem.modelId = modelId;
			modelItem.iconPath = new vscode.ThemeIcon('symbol-method');
			modelItem.description = modelId !== modelDisplay ? modelId : '';
			modelItem.tooltip = `模型 ID: ${modelId}`;
			modelItem.contextValue = 'modelItem';
			items.push(modelItem);
		}

		return items;
	}

	getTreeItem(element: EndpointTreeItem): vscode.TreeItem {
		return element;
	}

	private async getKeyStatus(endpointName: string): Promise<boolean> {
		if (this.keyStatusCache.has(endpointName)) {
			return this.keyStatusCache.get(endpointName)!;
		}
		const key = await this.authManager.getApiKeyForEndpoint(endpointName);
		const hasKey = key !== undefined && key.length > 0;
		this.keyStatusCache.set(endpointName, hasKey);
		return hasKey;
	}
}

/** 修改端点配置的辅助函数 */
async function updateEndpointConfig(
	endpointName: string,
	updater: (ep: EndpointConfig) => EndpointConfig | null,
): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const existing = config.get<unknown[]>('endpoints', []) as EndpointConfig[];
	const idx = existing.findIndex(e => e.name === endpointName);
	if (idx === -1) {
		return;
	}
	const updated = updater(existing[idx]);
	if (updated === null) {
		existing.splice(idx, 1);
	} else {
		existing[idx] = updated;
	}
	await config.update('endpoints', existing, vscode.ConfigurationTarget.Global);
}

export async function registerEndpointsSidebar(
	context: vscode.ExtensionContext,
	authManager: AuthManager,
): Promise<EndpointsTreeDataProvider> {
	const treeDataProvider = new EndpointsTreeDataProvider(authManager);

	const treeView = vscode.window.createTreeView(VIEW_ID, {
		treeDataProvider,
		showCollapseAll: true,
	});

	context.subscriptions.push(treeView);

	// ---- Commands ----

	// Refresh tree
	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.refreshEndpoints', () => {
			treeDataProvider.refresh();
		}),
	);

	// Add new endpoint
	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.addEndpoint', async () => {
			const name = await vscode.window.showInputBox({
				prompt: '端点名称',
				placeHolder: '例如: my-proxy',
				validateInput: (v: string) => {
					if (!v?.trim()) return '名称不能为空';
					const existing = getEndpoints();
					if (existing.find(e => e.name === v.trim())) return '此名称已被使用';
					return undefined;
				},
			});
			if (!name) return;

			const baseUrl = await vscode.window.showInputBox({
				prompt: 'API 地址',
				placeHolder: 'https://api.example.com',
				value: 'https://api.example.com',
				validateInput: (v: string) => {
					if (!v?.trim()) return '地址不能为空';
					try { new URL(v.trim()); return undefined; } catch { return '请输入有效的 URL'; }
				},
			});
			if (!baseUrl) return;

			const protocol = await vscode.window.showQuickPick([
				{ label: 'OpenAI Chat Completions', description: 'openai-completions', detail: '适用于 OpenAI 及兼容 API' },
				{ label: 'Anthropic Messages', description: 'anthropic-messages', detail: '适用于 Claude 及兼容 API' },
			], { placeHolder: '选择 API 协议类型' });
			if (!protocol) return;

			const models = await vscode.window.showInputBox({
				prompt: '模型列表（逗号分隔）',
				placeHolder: 'gpt-4o, claude-sonnet-4',
				value: 'gpt-4o',
				validateInput: (v: string) => !v?.trim() ? '至少需要一个模型' : undefined,
			});
			if (!models) return;

			const modelList = models.split(',').map(s => s.trim()).filter(s => s);
			const newEndpoint = {
				name: name.trim(),
				baseUrl: baseUrl.trim().replace(/\/+$/, ''),
				protocol: protocol.description,
				models: modelList,
			};

			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const existing = config.get<unknown[]>('endpoints', []);
			await config.update('endpoints', [...existing, newEndpoint], vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`端点 "${newEndpoint.name}" 已添加 (${protocol.label})`);
			treeDataProvider.refresh();
		}),
	);

	// Edit endpoint
	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.editEndpoint', async (arg: unknown) => {
			const endpointName = resolveEndpointName(arg);
			if (!endpointName) return;

			const endpoints = getEndpoints();
			const ep = endpoints.find(e => e.name === endpointName);
			if (!ep) {
				vscode.window.showErrorMessage(`端点 "${endpointName}" 未找到`);
				return;
			}

			const newBaseUrl = await vscode.window.showInputBox({
				prompt: 'API 地址',
				value: ep.baseUrl,
				validateInput: (v: string) => {
					if (!v?.trim()) return '地址不能为空';
					try { new URL(v.trim()); return undefined; } catch { return '请输入有效的 URL'; }
				},
			});
			if (!newBaseUrl) return;

			const protocolPick = await vscode.window.showQuickPick([
				{ label: 'OpenAI Chat Completions', description: 'openai-completions', detail: '适用于 OpenAI 及兼容 API' },
				{ label: 'Anthropic Messages', description: 'anthropic-messages', detail: '适用于 Claude 及兼容 API' },
			], { placeHolder: '选择 API 协议类型' });
			if (!protocolPick) return;

			const models = await vscode.window.showInputBox({
				prompt: '模型列表（逗号分隔）',
				value: ep.models.map(m => typeof m === 'string' ? m : m.id).join(', '),
				validateInput: (v: string) => !v?.trim() ? '至少需要一个模型' : undefined,
			});
			if (!models) return;

			const modelList = models.split(',').map(s => s.trim()).filter(s => s);
			const confirm = await vscode.window.showWarningMessage(
				`确定要更新端点 "${endpointName}" 吗？`, { modal: true }, '更新',
			);
			if (confirm !== '更新') return;

			await updateEndpointConfig(endpointName, (ep) => ({
				...ep,
				baseUrl: newBaseUrl.trim().replace(/\/+$/, ''),
				protocol: protocolPick.description as EndpointConfig['protocol'],
				models: modelList,
			}));
			vscode.window.showInformationMessage(`端点 "${endpointName}" 已更新`);
			treeDataProvider.refresh();
		}),
	);

	// Delete endpoint
	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.deleteEndpoint', async (arg: unknown) => {
			const endpointName = resolveEndpointName(arg);
			if (!endpointName) return;

			const confirm = await vscode.window.showWarningMessage(
				`确定要删除端点 "${endpointName}" 吗？`, { modal: true }, '删除',
			);
			if (confirm !== '删除') return;

			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const existing = config.get<unknown[]>('endpoints', []) as EndpointConfig[];
			await config.update('endpoints', existing.filter(e => e.name !== endpointName), vscode.ConfigurationTarget.Global);
			await authManager.deleteApiKey(endpointName).catch(() => {});
			vscode.window.showInformationMessage(`端点 "${endpointName}" 已删除`);
			treeDataProvider.refresh();
		}),
	);

	// Set endpoint API key
	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.setEndpointApiKey', async (arg: unknown) => {
			let endpointName = resolveEndpointName(arg);

			// 命令面板调用时 arg 为空，让用户选择端点
			if (!endpointName) {
				const endpoints = getEndpoints();
				if (endpoints.length === 0) {
					vscode.window.showErrorMessage('请先在设置中添加端点');
					return;
				}
				const selected = await vscode.window.showQuickPick(
					endpoints.map((e) => ({
						label: e.name,
						description: e.baseUrl,
						detail: `模型: ${e.models.map(m => typeof m === 'string' ? m : m.id).join(', ')}`,
					})),
					{ placeHolder: '选择要设置 API Key 的端点' },
				);
				if (!selected) return;
				endpointName = selected.label;
			}

			await authManager.promptForApiKey(endpointName);
			treeDataProvider.refresh();
		}),
	);

	// Clear API key from sidebar inline button
	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.clearEndpointApiKeyFromSidebar', async (arg: unknown) => {
			const endpointName = resolveEndpointName(arg);
			if (!endpointName) return;

			const confirm = await vscode.window.showWarningMessage(
				`确定要清除端点 "${endpointName}" 的 API Key 吗？`, { modal: true }, '清除',
			);
			if (confirm !== '清除') return;
			await authManager.deleteApiKey(endpointName);
			vscode.window.showInformationMessage(`端点 "${endpointName}" 的 API Key 已清除`);
			treeDataProvider.refresh();
		}),
	);

	// Add model to endpoint
	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.addModelToEndpoint', async (arg: unknown) => {
			const endpointName = resolveEndpointName(arg);
			if (!endpointName) return;

			const modelId = await vscode.window.showInputBox({
				prompt: `为端点 "${endpointName}" 添加模型`,
				placeHolder: 'gpt-4o',
				validateInput: (v: string) => {
					if (!v?.trim()) return '模型 ID 不能为空';
					const ep = getEndpoints().find(e => e.name === endpointName);
					if (ep?.models.some(m => (typeof m === 'string' ? m : m.id) === v.trim())) {
						return '此模型 ID 已存在';
					}
					return undefined;
				},
			});
			if (!modelId) return;

			const trimmedId = modelId.trim();
			await updateEndpointConfig(endpointName, (ep) => ({
				...ep,
				models: [...ep.models, trimmedId],
			}));
			vscode.window.showInformationMessage(`模型 "${trimmedId}" 已添加到端点 "${endpointName}"`);
			treeDataProvider.refresh();
		}),
	);

	// Delete model from endpoint
	context.subscriptions.push(
		vscode.commands.registerCommand('byok-copilot.deleteModelFromEndpoint', async (arg: unknown) => {
			const endpointName = resolveEndpointName(arg);
			const modelId = resolveModelId(arg);
			if (!endpointName || !modelId) return;

			const ep = getEndpoints().find(e => e.name === endpointName);
			if (!ep) return;

			// 不允许删除最后一个模型
			if (ep.models.length <= 1) {
				vscode.window.showErrorMessage('不能删除唯一的模型，端点至少需要一个模型');
				return;
			}

			const confirm = await vscode.window.showWarningMessage(
				`确定要从端点 "${endpointName}" 中删除模型 "${modelId}" 吗？`,
				{ modal: true },
				'删除',
			);
			if (confirm !== '删除') return;

			await updateEndpointConfig(endpointName, (ep) => ({
				...ep,
				models: ep.models.filter(m => (typeof m === 'string' ? m : m.id) !== modelId),
			}));
			vscode.window.showInformationMessage(`模型 "${modelId}" 已从端点 "${endpointName}" 中删除`);
			treeDataProvider.refresh();
		}),
	);

	// Refresh on config change
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('byok-copilot.endpoints')) {
				treeDataProvider.refresh();
			}
		}),
	);

	// Refresh on secrets change (multi-window)
	context.subscriptions.push(
		context.secrets.onDidChange((e) => {
			if (e.key === API_KEY_SECRET || e.key.startsWith(API_KEY_SECRET + '.')) {
				treeDataProvider.refresh();
			}
		}),
	);

	return treeDataProvider;
}


