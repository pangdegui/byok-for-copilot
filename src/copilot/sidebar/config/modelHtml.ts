import { randomBytes } from 'crypto';
import vscode from 'vscode';
import type { EndpointStyle, ProxyConfig } from '../../../config';

export interface ModelConfigEntry {
	id: string;
	displayName?: string;
	baseUrl?: string;
	authType?: 'bearer' | 'x-api-key';
	/** Per-model proxy override (takes priority over style / endpoint). */
	proxy?: ProxyConfig;
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
	/** Thinking effort list offered to the VS Code model picker. Entries are
	 * free-form: bare values (`middle`) or display/param pairs (`标准(middle)`).
	 * Undefined/empty = default list (none/high/max). */
	thinkingEfforts?: string[];
	isTemplateDefault?: boolean;
	/** Per-model vision description prompt override (falls back to global setting). */
	visionPrompt?: string;
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
		.field textarea {
			width: 100%; background: var(--input-bg); color: var(--input-fg);
			border: 1px solid var(--border); border-radius: 4px;
			padding: 6px 8px; font-size: 13px; resize: vertical;
			font-family: var(--vscode-font-family);
		}
		.field textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
		.field input:focus, .field select:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
		.row { display: flex; gap: 12px; }
		.row .field { flex: 1; min-width: 0; }
		.check-row { display: flex; align-items: center; gap: 8px; cursor: pointer; margin-bottom: 8px; }
		.check-row input { cursor: pointer; }
		.check-row span.hint { color: var(--muted); font-size: 11px; }
		.status { color: var(--muted); font-size: 12px; margin-top: 8px; min-height: 18px; }
		.tiers-table { width: 100%; border-collapse: collapse; margin-bottom: 8px; font-size: 12px; }
		.tiers-table th, .tiers-table td {
			border: 1px solid var(--border); padding: 4px 6px; text-align: left;
		}
		.tiers-table th { color: var(--muted); font-weight: normal; font-size: 11px; background: var(--bg); }
		.tiers-table input {
			width: 100%; min-width: 48px; background: var(--input-bg); color: var(--input-fg);
			border: 1px solid transparent; border-radius: 3px; padding: 3px 5px; font-size: 12px;
		}
		.tiers-table input:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
		.tiers-table .tier-del {
			background: none; border: none; color: var(--red); cursor: pointer;
			font-size: 14px; padding: 2px 6px; line-height: 1;
		}
		.tier-add {
			background: var(--card); color: var(--fg); border: 1px dashed var(--border);
			border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px;
		}
		.tier-add:hover { border-color: var(--accent); color: var(--accent); }
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
			</div>
			<div class="field">
				<label>描述 (detail)</label>
				<input type="text" id="detail" placeholder="模型描述" />
			</div>
			<div class="field">
				<label>思考档位列表（提供给 VS Code 模型选择器）</label>
				<input type="text" id="thinkingEfforts" placeholder="例：none,middle,high 或 停用(none),标准(middle),深度(max)" />
				<div class="explain">
					逗号分隔的档位列表，仅当模型声明了 <code>capabilities.thinking</code> 时生效。两种写法：
					<b>裸值</b>（如 <code>middle</code>）显示与传给后端的参数相同；<b>显示(参数)</b>（如
					<code>标准(middle)</code>）括号外是 VS Code 选择器显示文案，括号内是实际传给后端的参数值。
					留空则提供默认列表（none/high/max）。具体选哪个档位由用户在 VS Code 对话框中选择。
				</div>
			</div>
		</div>

		<div class="card">
			<h2>请求与覆盖</h2>
			<div class="field">
				<label>覆盖 Base URL（可选，留空继承端点 / 风格）</label>
				<input type="url" id="baseUrl" placeholder="https://..." />
			</div>
			<div class="proxy-group">
				<div style="color:var(--muted);font-size:11px;margin-bottom:6px;">代理（模型级覆盖，留空继承端点 / 风格）</div>
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
			<h2>价格配置（每百万 token 单价；工具按次）</h2>
			<div class="explain" style="margin-bottom:8px;">
				用于用量统计的费用估算。每个阶梯一行：时段<b>留空即为全时段</b>（兜底价格表）；
				填写时段的阶梯按请求时刻优先匹配。所有价格字段可选，留空不计价。
			</div>
			<div class="field">
				<label>价格阶梯 / 时段表</label>
				<table class="tiers-table" id="tiersTable">
					<thead>
						<tr>
							<th>名称</th>
							<th>时段 (如 0-8 或 21:30-06:00)</th>
							<th>输入</th>
							<th>输出</th>
							<th>缓存读</th>
							<th>缓存写</th>
							<th>工具/次</th>
							<th></th>
						</tr>
					</thead>
					<tbody id="tiersBody"></tbody>
				</table>
				<button type="button" class="tier-add" id="addTier">＋ 添加阶梯</button>
				<div class="explain">
					每个阶梯是一行：名称自定义（如 闲时/忙时）；时段填起止时间，支持小时（<code>0-8</code>）、
					时分（<code>21:30-06:00</code>）或时分秒（<code>09:00:00-18:30:00</code>），支持跨零点，留空表示不限时段。
					价格为每百万 token 单价，工具为每次调用单价，均可留空。
				</div>
			</div>
		</div>

		<div class="card">
			<h2>第三方视觉输入</h2>
			<div class="field">
				<label>视觉描述提示词 (visionPrompt)</label>
				<textarea id="visionPrompt" rows="4" placeholder="留空则继承全局 byok-copilot.visionPrompt"></textarea>
				<div class="explain">
					当图片附件交给视觉代理描述时使用的提示词。在此填写会<b>仅对该模型</b>生效，覆盖全局
					<code>byok-copilot.visionPrompt</code>；留空则使用全局设置。
				</div>
			</div>
		</div>

		<div id="status" class="status" aria-live="polite"></div>
	</main>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		// Surface any uncaught webview error to the BYOK output channel.
		window.addEventListener('error', (e) => {
			const detail = e.error && e.error.stack ? e.error.stack : (e.message || String(e));
			vscode.postMessage({ type: 'log', value: 'WEBVIEW ERROR: ' + detail });
		});
		window.addEventListener('unhandledrejection', (e) => {
			const r = e.reason;
			const detail = r && r.stack ? r.stack : String(r);
			vscode.postMessage({ type: 'log', value: 'WEBVIEW UNHANDLED REJECTION: ' + detail });
		});
		const state = ${initialState};
		const entry = state.entry || {};

		function set(id, value) { const n = document.getElementById(id); if (n && value !== undefined && value !== null && value !== '') n.value = value; }
		function setCheck(id, value) { const n = document.getElementById(id); if (n) n.checked = !!value; }
		function setStatus(msg, isError) {
			const box = document.getElementById('status');
			box.textContent = msg || '';
			box.style.color = isError ? 'var(--red)' : 'var(--muted)';
		}

		document.getElementById('modelId').textContent = state.modelId + ' @ ' + state.endpointName + ' (' + state.style + ')';
		set('displayName', entry.displayName);
		set('family', entry.family);
		set('version', entry.version);
		set('detail', entry.detail);
		set('baseUrl', entry.baseUrl);
		set('authType', entry.authType || 'bearer');
		set('anthropicVersion', entry.anthropicVersion);
		set('maxInputTokens', entry.maxInputTokens);
		set('maxOutputTokens', entry.maxOutputTokens);
		set('visionPrompt', entry.visionPrompt);

		// Thinking effort list: free-form comma-separated entries.
		const effortsInput = document.getElementById('thinkingEfforts');
		effortsInput.value = (entry.thinkingEfforts || []).join(',');

		// ---- Tier table (editable rows: name / time range / 5 price cells) ----
		// No separate default table: a tier with an empty time range IS the
		// all-time (fallback) table.
		const tiersBody = document.getElementById('tiersBody');
		const TIER_PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'toolCall'];

		function addTierRow(tier) {
			const t = tier || {};
			const tb = t.table || {};
			const tr = document.createElement('tr');

			const nameTd = document.createElement('td');
			const nameInput = document.createElement('input');
			nameInput.type = 'text';
			nameInput.placeholder = '如：闲时';
			nameInput.value = t.name || '';
			nameTd.appendChild(nameInput);
			tr.appendChild(nameTd);

			const timeTd = document.createElement('td');
			const timeInput = document.createElement('input');
			timeInput.type = 'text';
			timeInput.placeholder = '0-8';
			timeInput.value = t.condition || '';
			timeTd.appendChild(timeInput);
			tr.appendChild(timeTd);

			for (const key of TIER_PRICE_KEYS) {
				const td = document.createElement('td');
				const input = document.createElement('input');
				input.type = 'number';
				input.min = '0';
				input.step = 'any';
				const v = tb[key];
				input.value = (typeof v === 'number' && Number.isFinite(v)) ? String(v) : '';
				td.appendChild(input);
				tr.appendChild(td);
			}

			const delTd = document.createElement('td');
			const delBtn = document.createElement('button');
			delBtn.type = 'button';
			delBtn.className = 'tier-del';
			delBtn.title = '删除该阶梯';
			delBtn.textContent = '✕';
			delBtn.addEventListener('click', () => tr.remove());
			delTd.appendChild(delBtn);
			tr.appendChild(delTd);

			tiersBody.appendChild(tr);
		}

		((entry.tieredPricing || {}).tiers || []).forEach((t) => addTierRow(t));
		document.getElementById('addTier').addEventListener('click', () => addTierRow());

		// Proxy fields (model-level override; empty = inherit).
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

		function num(id) {
			const v = document.getElementById(id).value.trim();
			if (v === '') return undefined;
			const n = Number(v);
			return Number.isFinite(n) && n >= 0 ? n : undefined;
		}

		function collect() {
			const out = { id: state.modelId };
			const displayName = document.getElementById('displayName').value.trim();
			const family = document.getElementById('family').value.trim();
			const version = document.getElementById('version').value.trim();
			const detail = document.getElementById('detail').value.trim();
			const baseUrl = document.getElementById('baseUrl').value.trim();
			const authType = document.getElementById('authType').value;
			// anthropicVersion 输入框仅对 anthropic-messages 风格渲染，其余风格 DOM 中不存在。
			const anthropicVersionEl = document.getElementById('anthropicVersion');
			const anthropicVersion = anthropicVersionEl ? anthropicVersionEl.value.trim() : '';

			if (displayName) out.displayName = displayName;
			if (family) out.family = family;
			if (version) out.version = version;
			if (detail) out.detail = detail;
			if (baseUrl) out.baseUrl = baseUrl.replace(/\\/+$/, '');
			if (authType && authType !== 'bearer') out.authType = authType;
			if (state.style === 'anthropic-messages') out.anthropicVersion = anthropicVersion || '2023-06-01';

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

			const maxInput = num('maxInputTokens');
			const maxOutput = num('maxOutputTokens');
			if (maxInput !== undefined) out.maxInputTokens = maxInput;
			if (maxOutput !== undefined) out.maxOutputTokens = maxOutput;

			// Thinking effort list: persist raw entries; empty clears the override.
			out.thinkingEfforts = effortsInput.value
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s.length > 0);

			// Price tiers: read editable table rows (name / time range / 5 price cells).
			// A row with an empty time range is the all-time (fallback) table.
			const tiers = [];
			for (const tr of tiersBody.rows) {
				const cells = tr.cells;
				const name = cells[0].firstChild.value.trim();
				const condition = cells[1].firstChild.value.trim();
				const table = {};
				TIER_PRICE_KEYS.forEach((key, i) => {
					const v = cells[2 + i].firstChild.value.trim();
					if (v === '') return;
					const n = Number(v);
					if (Number.isFinite(n) && n >= 0) table[key] = n;
				});
				// Skip fully-empty rows; require a name and at least one price.
				if (!name && Object.keys(table).length === 0) continue;
				if (!name) { setStatus('价格阶梯缺少名称', true); return null; }
				tiers.push(Object.assign({ name, table }, condition ? { condition } : {}));
			}
			if (tiers.length > 0) {
				out.tieredPricing = { tiers };
			}

			const visionPrompt = document.getElementById('visionPrompt').value.trim();
			out.visionPrompt = visionPrompt;
			return out;
		}

		document.getElementById('save').addEventListener('click', () => {
			try {
				vscode.postMessage({ type: 'log', value: 'save button clicked' });
				const data = collect();
				if (data === null) {
					vscode.postMessage({ type: 'log', value: 'collect() returned null (validation error shown in panel)' });
					return;
				}
				vscode.postMessage({ type: 'log', value: 'collect() ok: ' + JSON.stringify(data) });
				vscode.postMessage({ type: 'save', value: data });
			} catch (err) {
				const msg = err && err.stack ? err.stack : String(err);
				vscode.postMessage({ type: 'log', value: 'save click THREW: ' + msg });
				vscode.postMessage({ type: 'saveError', value: String(msg) });
			}
		});
		document.getElementById('cancel').addEventListener('click', () => {
			vscode.postMessage({ type: 'log', value: 'cancel button clicked' });
			vscode.postMessage({ type: 'close' });
		});
		setStatus('');
	</script>
</body>
</html>`;
}
