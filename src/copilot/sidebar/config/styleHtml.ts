import { randomBytes } from 'crypto';
import vscode from 'vscode';
import type { EndpointStyle, EndpointStyleConfig, ProxyConfig } from '../../../config';

export interface StyleConfigEntry {
	baseUrl?: string;
	authType?: 'bearer' | 'x-api-key';
	anthropicVersion?: string;
	supportsReasoningReplay?: boolean;
	proxy?: ProxyConfig;
}

export interface StylePanelState {
	endpointName: string;
	style: EndpointStyle;
	modelCount: number;
	entry: StyleConfigEntry;
	isNew: boolean;
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}

function escapeScriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function getStylePanelHtml(webview: vscode.Webview, state: StylePanelState): string {
	const nonce = createNonce();
	const htmlLang = vscode.env.language.toLowerCase() === 'zh-cn' ? 'zh-CN' : 'en';
	const initialState = escapeScriptJson(state);
	const csp = [
		"default-src 'none'",
		`style-src 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
		`img-src ${webview.cspSource} data:`,
	].join('; ');

	return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>BYOK 风格配置</title>
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
		.field input[type="text"], .field input[type="url"], .field select {
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
		.explain {
			margin: 6px 0 4px 24px;
			color: var(--muted); font-size: 11px; line-height: 1.6;
		}
		.explain code { color: var(--fg); font-size: 11px; }
		.status { color: var(--muted); font-size: 12px; margin-top: 8px; min-height: 18px; }
	</style>
</head>
<body>
	<main>
		<h1>⚙ BYOK 风格配置</h1>
		<p class="intro">对风格 <code id="styleId"></code> 进行配置。风格级配置会覆盖端点级，但会被模型级覆盖（模型 &gt; 风格 &gt; 端点）。</p>

		<div class="toolbar">
			<button id="save" class="primary" title="保存配置">💾 保存</button>
			<button id="cancel" title="放弃修改">取消</button>
		</div>

		<div class="card">
			<h2>请求与覆盖</h2>
			<div class="field">
				<label>风格 Base URL（可选，留空继承端点）</label>
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
				<div id="anthropicField" style="display:none;" class="field">
					<label>Anthropic 版本 (anthropicVersion)</label>
					<input type="text" id="anthropicVersion" placeholder="2023-06-01" />
				</div>
			</div>
			<div class="proxy-group">
				<div style="color:var(--muted);font-size:11px;margin-bottom:6px;">代理（风格级覆盖，留空继承端点）</div>
				<div class="row">
					<div class="field">
						<label>代理模式</label>
						<select id="proxyMode">
							<option value="">（继承）</option>
							<option value="system">跟随系统</option>
							<option value="direct">直连</option>
							<option value="proxy">设置代理</option>
						</select>
					</div>
					<div class="field" data-role="proxyUrlField">
						<label>代理地址（仅 HTTP/HTTPS）</label>
						<input type="text" id="proxyUrl" placeholder="示例：http://host:port（仅 http/https）" />
					</div>
				</div>
			</div>
		</div>

		<div class="card">
			<h2>能力</h2>
			<label id="replayRow" style="display:none;" class="check-row"><input type="checkbox" id="supportsReasoningReplay" /> <span>支持 Responses 推理重放 (supportsReasoningReplay)</span> <span class="hint">（仅 openai-responses 风格）</span></label>
			<div id="replayExplain" style="display:none;" class="explain">
				开启后，本风格的思维链（reasoning）会在多轮对话 / 工具调用循环中保持完整：
				请求会以有状态方式带上上一轮的 <code>previous_response_id</code>（或 <code>encrypted_content</code>），
				让模型“记得”之前的推理过程，避免重复思考、省 token。
				关闭则回退为普通 <code>output_text</code>，思维链不跨轮保留。
				仅对 <code>openai-responses</code> 风格生效；若你的网关 / 兼容实现不支持有状态接口，请关闭。
			</div>
			<div style="color:var(--muted);font-size:11px;">该风格下模型数量：<code id="modelCount"></code>（模型的增删请在侧边栏或端点配置页进行）</div>
		</div>

		<div id="status" class="status" aria-live="polite"></div>
	</main>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const state = ${initialState};
		const entry = state.entry || {};

		function set(id, value) { const n = document.getElementById(id); if (n && value !== undefined && value !== null && value !== '') n.value = value; }
		function setStatus(msg, isError) {
			const box = document.getElementById('status');
			box.textContent = msg || '';
			box.style.color = isError ? 'var(--red)' : 'var(--muted)';
		}

		document.getElementById('styleId').textContent = state.style + ' @ ' + state.endpointName;
		document.getElementById('modelCount').textContent = state.modelCount;

		if (state.style === 'anthropic-messages') {
			document.getElementById('anthropicField').style.display = '';
		}
		if (state.style === 'openai-responses') {
			document.getElementById('replayRow').style.display = '';
			document.getElementById('replayExplain').style.display = '';
		}

		set('baseUrl', entry.baseUrl);
		set('authType', entry.authType || 'bearer');
		set('anthropicVersion', entry.anthropicVersion);
		if (state.style === 'openai-responses') {
			document.getElementById('supportsReasoningReplay').checked = !!entry.supportsReasoningReplay;
		}

		// Proxy fields (style-level override; empty = inherit).
		const proxyMode = document.getElementById('proxyMode');
		const proxyUrl = document.getElementById('proxyUrl');
		function toggleProxyUrl() {
			const field = document.querySelector('[data-role="proxyUrlField"]');
			if (field) field.style.display = proxyMode.value === 'proxy' ? '' : 'none';
		}
		if (entry.proxy && entry.proxy.mode) {
			proxyMode.value = entry.proxy.mode;
		}
		proxyUrl.value = (entry.proxy && entry.proxy.url) || '';
		proxyMode.addEventListener('change', toggleProxyUrl);
		toggleProxyUrl();

		function collect() {
			const out = {};
			const baseUrl = document.getElementById('baseUrl').value.trim();
			const authType = document.getElementById('authType').value;
			if (baseUrl) out.baseUrl = baseUrl.replace(/\\/+$/, '');
			if (authType && authType !== 'bearer') out.authType = authType;
			if (state.style === 'anthropic-messages') {
				out.anthropicVersion = document.getElementById('anthropicVersion').value.trim() || '2023-06-01';
			}
			if (state.style === 'openai-responses') {
				out.supportsReasoningReplay = document.getElementById('supportsReasoningReplay').checked;
			}

			const pm = proxyMode.value;
			const pu = proxyUrl.value.trim();
			if (pm === 'proxy') {
				if (!pu) { setStatus('代理模式为“设置代理”时需填写代理地址', true); return null; }
				if (!/^https?:\\/\\//i.test(pu)) {
					setStatus('代理地址仅支持 http:// 或 https://', true); return null;
				}
				out.proxy = { mode: 'proxy', url: pu };
			} else if (pm === 'direct') {
				out.proxy = { mode: 'direct' };
			} else if (pm === 'system') {
				out.proxy = { mode: 'system' };
			}
			return out;
		}

		document.getElementById('save').addEventListener('click', () => {
			const data = collect();
			if (!data) return;
			vscode.postMessage({ type: 'save', value: data });
		});
		document.getElementById('cancel').addEventListener('click', () => {
			vscode.postMessage({ type: 'close' });
		});
		setStatus('');
	</script>
</body>
</html>`;
}
