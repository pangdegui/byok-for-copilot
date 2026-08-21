import { randomBytes } from 'crypto';
import vscode from 'vscode';
import type { EndpointConfig, EndpointStyle } from '../../../config';

export interface EndpointPanelState {
	endpoint: EndpointConfig;
	canDelete: boolean;
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}

function escapeScriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

const STYLE_META: Record<EndpointStyle, { label: string; hint: string }> = {
	'openai-chat': { label: 'OpenAI Chat', hint: '/chat/completions 聊天补全' },
	'openai-responses': { label: 'OpenAI Responses', hint: '/responses Responses API' },
	'anthropic-messages': { label: 'Claude', hint: '/v1/messages Messages API' },
};

export const ENDPOINT_STYLE_ORDER: readonly EndpointStyle[] = [
	'openai-chat',
	'openai-responses',
	'anthropic-messages',
];

export function getEndpointPanelHtml(
	webview: vscode.Webview,
	state: EndpointPanelState,
): string {
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
	<title>BYOK 端点配置</title>
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
			--amber: #ff9800;
		}
		* { box-sizing: border-box; }
		body {
			font-family: var(--vscode-font-family);
			background: var(--bg);
			color: var(--fg);
			margin: 0;
			padding: 16px 20px 40px;
			font-size: 13px;
			line-height: 1.5;
		}
		h1 { font-size: 18px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
		.intro { color: var(--muted); margin: 0 0 18px; }

		.toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 16px; }
		.toolbar button {
			background: var(--card); color: var(--fg);
			border: 1px solid var(--border); border-radius: 4px;
			padding: 5px 12px; cursor: pointer; font-size: 12px;
		}
		.toolbar button:hover { border-color: var(--accent); }
		.toolbar button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
		.toolbar button.danger:hover { border-color: var(--red); color: var(--red); }
		.toolbar .spacer { flex: 1; }

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

		.check-row { display: flex; align-items: center; gap: 8px; cursor: pointer; margin-bottom: 6px; }
		.check-row input { cursor: pointer; }

		/* Style group */
		.style-group { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
		.style-head {
			display: flex; align-items: center; gap: 10px;
			padding: 10px 12px; background: var(--card); cursor: pointer; user-select: none;
		}
		.style-head .style-name { font-weight: 600; flex: 1; }
		.style-head .style-hint { color: var(--muted); font-size: 11px; }
		.style-body { padding: 4px 12px 14px; display: none; }
		.style-group.open .style-body { display: block; }
		.style-group.disabled .style-head { opacity: .5; }

		.models-list { margin-top: 6px; }
		.model-chip {
			display: inline-flex; align-items: center; gap: 6px;
			background: var(--input-bg); color: var(--input-fg);
			border: 1px solid var(--border); border-radius: 14px;
			padding: 2px 8px 2px 10px; margin: 3px 4px 3px 0; font-size: 12px;
		}
		.model-chip .rm { cursor: pointer; color: var(--muted); padding: 0 2px; }
		.model-chip .rm:hover { color: var(--red); }
		.add-model { display: flex; gap: 6px; margin-top: 8px; }
		.add-model input { flex: 1; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--border); border-radius: 4px; padding: 5px 8px; }
		.add-model button { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 4px 12px; cursor: pointer; }
		.add-model button:hover { border-color: var(--accent); }

		.status { color: var(--muted); font-size: 12px; margin-top: 8px; min-height: 18px; }
	</style>
</head>
<body>
	<main>
		<h1>⚙ BYOK 端点配置</h1>
		<p class="intro">配置端点属性与各风格下的模型。模型、风格可为一个端点配置多个。</p>

		<div class="toolbar">
			<button id="save" class="primary" title="保存配置">💾 保存</button>
			<button id="cancel" title="放弃修改">取消</button>
			<div class="spacer"></div>
			<button id="deleteEndpoint" class="danger" title="删除此端点">🗑 删除端点</button>
		</div>

		<div class="card">
			<h2>基本信息</h2>
			<div class="row">
				<div class="field">
					<label>端点名称</label>
					<input type="text" id="name" placeholder="my-provider" />
				</div>
			</div>
			<div class="field">
				<label>API 地址 (baseUrl)</label>
				<input type="url" id="baseUrl" placeholder="https://api.example.com" />
				<div style="color:var(--muted);font-size:11px;margin-top:3px;">各风格或模型可单独覆盖此地址。</div>
			</div>
			<div class="proxy-group">
				<div class="row">
					<div class="field">
						<label>代理模式 (proxy.mode)</label>
						<select id="proxyMode" data-role="proxyMode">
							<option value="system">跟随系统</option>
							<option value="direct">直连</option>
							<option value="proxy">设置代理</option>
						</select>
					</div>
					<div class="field" data-role="proxyUrlField">
						<label>代理地址 (proxy.url)</label>
						<input type="text" id="proxyUrl" data-role="proxyUrl" placeholder="示例：http://host:port（仅 http/https）" />
					</div>
				</div>
				<div style="color:var(--muted);font-size:11px;">跟随系统 = 采用环境/系统代理；直连 = 绕过代理；设置代理 = 固定走指定代理。模型级 > 风格级 > 端点级。</div>
			</div>
		</div>

		<div class="card">
			<h2>风格与模型</h2>
			<div id="styles"></div>
		</div>

		<div id="status" class="status" aria-live="polite"></div>
	</main>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const state = ${initialState};
		const ep = state.endpoint;
		const STYLE_ORDER = ${escapeScriptJson([...ENDPOINT_STYLE_ORDER])};
		const STYLE_META = ${escapeScriptJson(STYLE_META)};

		// Preserve original model objects so saving doesn't lose details.
		const modelObjects = {};
		STYLE_ORDER.forEach(s => {
			const cfg = ep.styles[s];
			if (cfg) cfg.models.forEach(m => {
				if (typeof m === 'object' && m && m.id) modelObjects[s + '|' + m.id] = m;
			});
		});

		let modelsByStyle = {};
		STYLE_ORDER.forEach(s => {
			const cfg = ep.styles[s];
			modelsByStyle[s] = cfg ? cfg.models.map(m => (typeof m === 'string' ? m : m.id)) : [];
		});

		function el(tag, className, text) {
			const node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== undefined) node.textContent = text;
			return node;
		}

		function renderStyles() {
			const container = document.getElementById('styles');
			container.innerHTML = '';
			STYLE_ORDER.forEach(style => {
				const cfg = ep.styles[style];
				const enabled = !!cfg;
				const group = el('div', 'style-group' + (enabled ? ' open' : ' disabled'));

				// header
				const head = el('div', 'style-head');
				const check = el('input', null);
				check.type = 'checkbox';
				check.checked = enabled;
				check.addEventListener('change', () => {
					group.classList.toggle('disabled', !check.checked);
					if (check.checked) group.classList.add('open');
				});
				head.appendChild(check);
				head.appendChild(el('span', 'style-name', STYLE_META[style].label));
				head.appendChild(el('span', 'style-hint', STYLE_META[style].hint));
				head.addEventListener('click', (e) => {
					if (e.target !== check) group.classList.toggle('open');
				});
				group.appendChild(head);

				// body
				const body = el('div', 'style-body');
				body.dataset.style = style;

				const overrideRow = el('div', 'row');
				const urlField = el('div', 'field');
				urlField.appendChild(el('label', null, '风格 baseUrl 覆盖（可选）'));
				const urlInput = el('input');
				urlInput.type = 'text';
				urlInput.value = (cfg && cfg.baseUrl) || '';
				urlInput.dataset.field = 'baseUrl';
				urlField.appendChild(urlInput);
				overrideRow.appendChild(urlField);

				const authField = el('div', 'field');
				authField.appendChild(el('label', null, '认证方式'));
				const authSel = el('select');
				authSel.dataset.field = 'authType';
				authSel.appendChild(new Option('Bearer', 'bearer'));
				authSel.appendChild(new Option('x-api-key', 'x-api-key'));
				authSel.value = (cfg && cfg.authType) || 'bearer';
				authField.appendChild(authSel);
				overrideRow.appendChild(authField);
				body.appendChild(overrideRow);

				if (style === 'anthropic-messages') {
					const ancField = el('div', 'field');
					ancField.appendChild(el('label', null, 'Anthropic 版本 (anthropic-version)'));
					const ancInput = el('input');
					ancInput.type = 'text';
					ancInput.value = (cfg && cfg.anthropicVersion) || '2023-06-01';
					ancInput.dataset.field = 'anthropicVersion';
					ancField.appendChild(ancInput);
					body.appendChild(ancField);
				}

				// Style-level proxy override.
				const proxyGroup = el('div', 'proxy-group');
				proxyGroup.appendChild(el('label', 'field', '风格代理覆盖（留空继承端点）'));
				const proxyRow = el('div', 'row');
				const proxyModeField = el('div', 'field');
				proxyModeField.appendChild(el('label', null, '代理模式'));
				const proxyModeSel = el('select');
				proxyModeSel.dataset.role = 'proxyMode';
				proxyModeSel.appendChild(new Option('（继承端点/默认）', ''));
				proxyModeSel.appendChild(new Option('跟随系统', 'system'));
				proxyModeSel.appendChild(new Option('直连', 'direct'));
				proxyModeSel.appendChild(new Option('设置代理', 'proxy'));
				proxyModeField.appendChild(proxyModeSel);
				proxyRow.appendChild(proxyModeField);
				const proxyUrlField = el('div', 'field');
				proxyUrlField.dataset.role = 'proxyUrlField';
				proxyUrlField.appendChild(el('label', null, '代理地址'));
				const proxyUrlInput = el('input');
				proxyUrlInput.type = 'text';
				proxyUrlInput.placeholder = '示例：http://host:port';
				proxyUrlInput.dataset.role = 'proxyUrl';
				proxyUrlField.appendChild(proxyUrlInput);
				proxyRow.appendChild(proxyUrlField);
				proxyGroup.appendChild(proxyRow);
				proxyGroup.appendChild(el('div', 'style-hint', '模型级 > 风格级 > 端点级。选择“设置代理”时需填地址。'));
				body.appendChild(proxyGroup);
				initProxy(proxyModeSel, proxyUrlInput, cfg && cfg.proxy, true);

				// Models
				const modelsWrap = el('div', 'models-list');
				modelsWrap.dataset.role = 'models';
				body.appendChild(modelsWrap);

				const addRow = el('div', 'add-model');
				const addInput = el('input');
				addInput.type = 'text';
				addInput.placeholder = '输入模型 ID 添加';
				addInput.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') { e.preventDefault(); addModel(style, addInput, modelsWrap); }
				});
				const addBtn = el('button', null, '添加');
				addBtn.addEventListener('click', () => addModel(style, addInput, modelsWrap));
				addRow.appendChild(addInput);
				addRow.appendChild(addBtn);
				body.appendChild(addRow);

				group.appendChild(body);
				renderModels(style, modelsWrap);
				container.appendChild(group);
			});
		}

		function renderModels(style, wrap) {
			wrap.innerHTML = '';
			if (modelsByStyle[style].length === 0) {
				wrap.appendChild(el('div', 'style-hint', '（无模型）'));
				return;
			}
			modelsByStyle[style].forEach(id => {
				const chip = el('span', 'model-chip');
				chip.appendChild(el('span', 'model-id', id));
				const rm = el('span', 'rm', '✕');
				rm.title = '移除 ' + id;
				rm.addEventListener('click', () => {
					modelsByStyle[style] = modelsByStyle[style].filter(x => x !== id);
					renderModels(style, wrap);
				});
				chip.appendChild(rm);
				wrap.appendChild(chip);
			});
		}

		function addModel(style, input, wrap) {
			const id = input.value.trim();
			if (!id) return;
			if (modelsByStyle[style].includes(id)) {
				setStatus('该模型 ID 已在此风格中');
				return;
			}
			modelsByStyle[style].push(id);
			input.value = '';
			renderModels(style, wrap);
		}

		function setStatus(msg, isError) {
			const box = document.getElementById('status');
			box.textContent = msg;
			box.style.color = isError ? 'var(--red)' : 'var(--muted)';
		}

		// Proxy helpers (shared by endpoint-level and style-level controls).
		function toggleProxyUrl(modeSel, urlInput) {
			const urlField = urlInput.closest('[data-role="proxyUrlField"]');
			if (urlField) urlField.style.display = modeSel.value === 'proxy' ? '' : 'none';
		}
		function initProxy(modeSel, urlInput, cfg, emptyInherits) {
			modeSel.value = (cfg && cfg.mode && (!emptyInherits || cfg.mode !== 'system'))
				? cfg.mode
				: (emptyInherits ? '' : 'system');
			urlInput.value = (cfg && cfg.url) || '';
			modeSel.addEventListener('change', () => toggleProxyUrl(modeSel, urlInput));
			toggleProxyUrl(modeSel, urlInput);
		}
		function readProxy(modeSel, urlInput) {
			const mode = modeSel.value;
			if (!mode) return undefined; // style level: inherit
			if (mode === 'system') return { mode: 'system' };
			if (mode === 'direct') return { mode: 'direct' };
			const url = urlInput.value.trim();
			if (!url) { setStatus('代理模式为“设置代理”时需填写代理地址', true); return null; }
			if (!/^https?:\\/\\//i.test(url)) {
				setStatus('代理地址仅支持 http:// 或 https://', true); return null;
			}
			return { mode: 'proxy', url };
		}

		function collect() {
			const name = document.getElementById('name').value.trim();
			const baseUrl = document.getElementById('baseUrl').value.trim();
			if (!name) { setStatus('端点名称不能为空', true); return null; }
			if (!baseUrl) { setStatus('API 地址不能为空', true); return null; }

			const epProxy = readProxy(
				document.getElementById('proxyMode'),
				document.getElementById('proxyUrl'),
			);
			if (epProxy === null) return null;

			const styles = {};
			const groups = document.querySelectorAll('.style-group');
			let hasAny = false;
			groups.forEach(group => {
				const head = group.querySelector('.style-head');
				const check = head.querySelector('input[type="checkbox"]');
				if (!check.checked) return;
				const style = group.querySelector('.style-body').dataset.style;
				const models = modelsByStyle[style] || [];
				if (models.length === 0) return;
				hasAny = true;

				const body = group.querySelector('.style-body');
				const baseUrlOverride = body.querySelector('[data-field="baseUrl"]').value.trim() || undefined;
				const authType = body.querySelector('[data-field="authType"]').value;
				let anthropicVersion;
				if (style === 'anthropic-messages') {
					anthropicVersion = body.querySelector('[data-field="anthropicVersion"]').value.trim() || '2023-06-01';
				}
				const styleProxy = readProxy(
					body.querySelector('[data-role="proxyMode"]'),
					body.querySelector('[data-role="proxyUrl"]'),
				);
				if (styleProxy === null) return null;

				const builtModels = models.map(id => {
					const orig = modelObjects[style + '|' + id];
					if (orig) return orig;
					return id;
				});

				const sc = { models: builtModels };
				if (baseUrlOverride) sc.baseUrl = baseUrlOverride;
				if (authType && authType !== 'bearer') sc.authType = authType;
				if (anthropicVersion) sc.anthropicVersion = anthropicVersion;
				if (styleProxy) sc.proxy = styleProxy;
				styles[style] = sc;
			});

			if (!hasAny) { setStatus('至少需要启用一个风格并添加模型', true); return null; }

			const out = { name, baseUrl, styles };
			if (epProxy && epProxy.mode !== 'system') out.proxy = epProxy;
			return out;
		}

		document.getElementById('name').value = ep.name;
		document.getElementById('baseUrl').value = ep.baseUrl || '';
		initProxy(
			document.getElementById('proxyMode'),
			document.getElementById('proxyUrl'),
			ep.proxy,
			false,
		);
		renderStyles();

		document.getElementById('save').addEventListener('click', () => {
			const data = collect();
			if (!data) return;
			vscode.postMessage({ type: 'save', value: data });
		});

		document.getElementById('cancel').addEventListener('click', () => {
			vscode.postMessage({ type: 'close' });
		});

		document.getElementById('deleteEndpoint').addEventListener('click', () => {
			vscode.postMessage({ type: 'delete' });
		});

		// Initial status
		setStatus('');
	</script>
</body>
</html>`;
}
