import { randomBytes } from 'crypto';
import vscode from 'vscode';
import type { EndpointStyle } from '../../config';

export interface ModelConfigEntry {
	id: string;
	displayName?: string;
	baseUrl?: string;
	authType?: 'bearer' | 'x-api-key';
	anthropicVersion?: string;
	family?: string;
	version?: string;
	detail?: string;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	capabilities?: {
		toolCalling: boolean | number;
		imageInput: boolean;
		thinking: boolean;
	};
	requiresThinkingParam?: boolean;
	priceCategory?: string;
}

export interface ModelPanelState {
	endpointName: string;
	modelId: string;
	style: EndpointStyle;
	entry: ModelConfigEntry;
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}

function escapeScriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function getModelPanelHtml(webview: vscode.Webview, state: ModelPanelState): string {
	const nonce = createNonce();
	const htmlLang = vscode.env.language.toLowerCase() === 'zh-cn' ? 'zh-CN' : 'en';
	const initialState = escapeScriptJson(state);
	const csp = [
		"default-src 'none'",
		`style-src 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
		`img-src ${webview.cspSource} data:`,
	].join('; ');

	const showAnthropic = state.style === 'anthropic-messages';

	return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>BYOK 模型配置</title>
	<style nonce="${nonce}">
		:root {
			--bg: var(--vscode-editor-background, #1e1e1e);
			--fg: var(--vscode-foreground, #cccccc);
			--muted: var(--vscode-descriptionForeground, #8a8a8a);
			--border: var(--vscode-panel-border, #3a3a3a);
			--card: var(--vscode-editorWidget-background, #252526);
			--accent: var(--vscode-textLink-foreground, #3794ff);
			--input-bg: var(--vscode-input-background, #3c3c3c);
			--input-fg: var(--vscode-input-foreground, #cccccc);
			--green: #4caf50;
			--red: #f44336;
		}
		* { box-sizing: border-box; }
		body {
			font-family: var(--vscode-font-family);
			background: var(--bg); color: var(--fg);
			margin: 0; padding: 16px 20px 40px;
			font-size: 13px; line-height: 1.5;
		}
		h1 { font-size: 18px; margin: 0 0 4px; }
		.intro { color: var(--muted); margin: 0 0 18px; }
		.toolbar { display: flex; gap: 8px; margin: 12px 0 16px; }
		.toolbar button {
			background: var(--card); color: var(--fg);
			border: 1px solid var(--border); border-radius: 4px;
			padding: 5px 12px; cursor: pointer; font-size: 12px;
		}
		.toolbar button:hover { border-color: var(--accent); }
		.toolbar button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
		.card {
			background: var(--card); border: 1px solid var(--border);
			border-radius: 10px; padding: 14px 16px; margin-bottom: 16px;
		}
		.card h2 { font-size: 14px; margin: 0 0 12px; }
		.field { margin-bottom: 12px; }
		.field label { display: block; color: var(--muted); font-size: 11px; margin-bottom: 4px; }
		.field input[type="text"], .field input[type="url"], .field input[type="number"], .field select {
			width: 100%; background: var(--input-bg); color: var(--input-fg);
			border: 1px solid var(--border); border-radius: 4px;
			padding: 6px 8px; font-size: 13px;
		}
		.field input:focus, .field select:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
		.row { display: flex; gap: 12px; }
		.row .field { flex: 1; min-width: 0; }
		.check-row { display: flex; align-items: center; gap: 8px; cursor: pointer; margin-bottom: 8px; }
		.check-row input { cursor: pointer; }
		.check-row span.hint { color: var(--muted); font-size: 11px; }
		.status { color: var(--muted); font-size: 12px; margin-top: 8px; min-height: 18px; }
	</style>
</head>
<body>
	<main>
		<h1>⚙ BYOK 模型配置</h1>
		<p class="intro">对模型 <code id="modelId"></code> 进行单独配置。单独配置后会优先生效，覆盖端点 / 风格级别的同名默认值。</p>

		<div class="toolbar">
			<button id="save" class="primary" title="保存配置">💾 保存</button>
			<button id="cancel" title="放弃修改">取消</button>
		</div>

		<div class="card">
			<h2>基本信息</h2>
			<div class="row">
				<div class="field">
					<label>显示名称 (displayName)</label>
					<input type="text" id="displayName" placeholder="留空则使用模型 ID" />
				</div>
				<div class="field">
					<label>家族 (family)</label>
					<input type="text" id="family" placeholder="byok" />
				</div>
			</div>
			<div class="row">
				<div class="field">
					<label>版本 (version)</label>
					<input type="text" id="version" placeholder="v4" />
				</div>
				<div class="field">
					<label>价格类别 (priceCategory)</label>
					<select id="priceCategory">
						<option value="">（默认）</option>
						<option value="low">low</option>
						<option value="mid">mid</option>
						<option value="high">high</option>
					</select>
				</div>
			</div>
			<div class="field">
				<label>描述 (detail)</label>
				<input type="text" id="detail" placeholder="模型描述" />
			</div>
		</div>

		<div class="card">
			<h2>请求与覆盖</h2>
			<div class="field">
				<label>覆盖 Base URL（可选，留空继承端点 / 风格）</label>
				<input type="url" id="baseUrl" placeholder="https://..." />
			</div>
			<div class="row">
				<div class="field">
					<label>认证方式 (authType)</label>
					<select id="authType">
						<option value="bearer">Bearer</option>
						<option value="x-api-key">x-api-key</option>
					</select>
				</div>
				${showAnthropic ? `
				<div class="field">
					<label>Anthropic 版本 (anthropicVersion)</label>
					<input type="text" id="anthropicVersion" placeholder="2023-06-01" />
				</div>
				` : ''}
			</div>
			<div class="row">
				<div class="field">
					<label>最大输入 Token (maxInputTokens)</label>
					<input type="number" id="maxInputTokens" min="0" step="1" />
				</div>
				<div class="field">
					<label>最大输出 Token (maxOutputTokens)</label>
					<input type="number" id="maxOutputTokens" min="0" step="1" />
				</div>
			</div>
		</div>

		<div class="card">
			<h2>能力</h2>
			<label class="check-row"><input type="checkbox" id="capToolCalling" /> <span>工具调用 (toolCalling)</span></label>
			<label class="check-row"><input type="checkbox" id="capImageInput" /> <span>视觉输入 (imageInput)</span></label>
			<label class="check-row"><input type="checkbox" id="capThinking" /> <span>思维链 (thinking)</span></label>
			<label class="check-row"><input type="checkbox" id="requiresThinkingParam" /> <span>需要 thinking 参数 (requiresThinkingParam)</span> <span class="hint">（部分接口需显式声明）</span></label>
		</div>

		<div id="status" class="status" aria-live="polite"></div>
	</main>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const state = ${initialState};
		const entry = state.entry || {};

		function set(id, value) { const n = document.getElementById(id); if (n && value !== undefined && value !== null && value !== '') n.value = value; }
		function setCheck(id, value) { const n = document.getElementById(id); if (n) n.checked = !!value; }

		document.getElementById('modelId').textContent = state.modelId + ' @ ' + state.endpointName + ' (' + state.style + ')';
		set('displayName', entry.displayName);
		set('family', entry.family);
		set('version', entry.version);
		set('priceCategory', entry.priceCategory);
		set('detail', entry.detail);
		set('baseUrl', entry.baseUrl);
		set('authType', entry.authType || 'bearer');
		set('anthropicVersion', entry.anthropicVersion);
		set('maxInputTokens', entry.maxInputTokens);
		set('maxOutputTokens', entry.maxOutputTokens);
		setCheck('capToolCalling', entry.capabilities ? entry.capabilities.toolCalling : false);
		setCheck('capImageInput', entry.capabilities ? entry.capabilities.imageInput : false);
		setCheck('capThinking', entry.capabilities ? entry.capabilities.thinking : false);
		setCheck('requiresThinkingParam', entry.requiresThinkingParam);

		function num(id) {
			const v = document.getElementById(id).value.trim();
			if (v === '') return undefined;
			const n = Number(v);
			return Number.isFinite(n) && n >= 0 ? n : undefined;
		}

		function setStatus(msg, isError) {
			const box = document.getElementById('status');
			box.textContent = msg || '';
			box.style.color = isError ? 'var(--red)' : 'var(--muted)';
		}

		function collect() {
			const out = { id: state.modelId };
			const displayName = document.getElementById('displayName').value.trim();
			const family = document.getElementById('family').value.trim();
			const version = document.getElementById('version').value.trim();
			const priceCategory = document.getElementById('priceCategory').value;
			const detail = document.getElementById('detail').value.trim();
			const baseUrl = document.getElementById('baseUrl').value.trim();
			const authType = document.getElementById('authType').value;
			const anthropicVersion = document.getElementById('anthropicVersion').value.trim();

			if (displayName) out.displayName = displayName;
			if (family) out.family = family;
			if (version) out.version = version;
			if (priceCategory) out.priceCategory = priceCategory;
			if (detail) out.detail = detail;
			if (baseUrl) out.baseUrl = baseUrl.replace(/\\/+$/, '');
			if (authType && authType !== 'bearer') out.authType = authType;
			if (state.style === 'anthropic-messages') out.anthropicVersion = anthropicVersion || '2023-06-01';

			const maxInput = num('maxInputTokens');
			const maxOutput = num('maxOutputTokens');
			if (maxInput !== undefined) out.maxInputTokens = maxInput;
			if (maxOutput !== undefined) out.maxOutputTokens = maxOutput;

			out.capabilities = {
				toolCalling: document.getElementById('capToolCalling').checked,
				imageInput: document.getElementById('capImageInput').checked,
				thinking: document.getElementById('capThinking').checked,
			};
			out.requiresThinkingParam = document.getElementById('requiresThinkingParam').checked;
			return out;
		}

		document.getElementById('save').addEventListener('click', () => {
			vscode.postMessage({ type: 'save', value: collect() });
		});
		document.getElementById('cancel').addEventListener('click', () => {
			vscode.postMessage({ type: 'close' });
		});
		setStatus('');
	</script>
</body>
</html>`;
}
