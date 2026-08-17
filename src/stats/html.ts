import { randomBytes } from 'crypto';
import vscode from 'vscode';
import type { StatsSnapshot } from './store';

export interface StatsPanelState {
	snapshot: StatsSnapshot;
	debugMode: string;
	endpointCount: number;
}

function createNonce(): string {
	return randomBytes(16).toString('base64');
}

function escapeScriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function getStatsPanelHtml(
	webview: vscode.Webview,
	state: StatsPanelState,
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
	<title>BYOK 用量统计</title>
	<style nonce="${nonce}">
		:root {
			--vscode-font-family: var(--vscode-font-family, system-ui);
			--bg: var(--vscode-editor-background, #1e1e1e);
			--fg: var(--vscode-foreground, #cccccc);
			--muted: var(--vscode-descriptionForeground, #8a8a8a);
			--border: var(--vscode-panel-border, #3a3a3a);
			--card: var(--vscode-editorWidget-background, #252526);
			--accent: var(--vscode-textLink-foreground, #3794ff);
			--green: #4caf50;
			--amber: #ff9800;
			--red: #f44336;
			--purple: #b388ff;
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
		.intro { color: var(--muted); margin: 0 0 16px; }

		/* ---- Toolbar ---- */
		.toolbar {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin: 12px 0 16px;
		}
		.toolbar button {
			background: var(--card);
			color: var(--fg);
			border: 1px solid var(--border);
			border-radius: 4px;
			padding: 5px 12px;
			cursor: pointer;
			font-size: 12px;
		}
		.toolbar button:hover { border-color: var(--accent); }
		.toolbar button.danger:hover { border-color: var(--red); color: var(--red); }
		.toolbar button.primary {
			background: var(--accent);
			color: #fff;
			border-color: var(--accent);
		}
		.toolbar .spacer { flex: 1; }

		/* ---- Summary bar ---- */
		.summary {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
			gap: 10px;
			margin-bottom: 18px;
		}
		.summary-card {
			background: var(--card);
			border: 1px solid var(--border);
			border-radius: 8px;
			padding: 10px 12px;
		}
		.summary-card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .4px; }
		.summary-card .value { font-size: 20px; font-weight: 600; margin-top: 2px; }
		.summary-card .sub { color: var(--muted); font-size: 11px; }

		/* ---- Config strip ---- */
		.config-strip {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 14px;
			background: var(--card);
			border: 1px solid var(--border);
			border-radius: 8px;
			padding: 8px 12px;
			margin-bottom: 18px;
			color: var(--muted);
			font-size: 12px;
		}
		.config-strip .chip {
			display: inline-flex;
			align-items: center;
			gap: 6px;
		}
		.config-strip .chip .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
		.config-strip a { color: var(--accent); cursor: pointer; text-decoration: none; }
		.config-strip a:hover { text-decoration: underline; }

		/* ---- Model cards ---- */
		.model-card {
			background: var(--card);
			border: 1px solid var(--border);
			border-radius: 10px;
			margin-bottom: 14px;
			overflow: hidden;
		}
		.model-head {
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 12px 14px;
			border-bottom: 1px solid var(--border);
		}
		.model-icon {
			width: 32px; height: 32px;
			border-radius: 8px;
			display: flex; align-items: center; justify-content: center;
			font-size: 18px;
			color: #fff;
			flex-shrink: 0;
		}
		.model-title { flex: 1; min-width: 0; }
		.model-name { font-size: 14px; font-weight: 600; }
		.model-meta { color: var(--muted); font-size: 11px; margin-top: 2px; }
		.model-actions { display: flex; gap: 6px; }
		.model-actions button {
			background: transparent;
			color: var(--muted);
			border: 1px solid var(--border);
			border-radius: 4px;
			padding: 3px 8px;
			cursor: pointer;
			font-size: 11px;
		}
		.model-actions button:hover { color: var(--fg); border-color: var(--accent); }

		.metrics {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
			gap: 1px;
			background: var(--border);
		}
		.metric {
			background: var(--card);
			padding: 10px 14px;
		}
		.metric .label { color: var(--muted); font-size: 11px; }
		.metric .value { font-size: 15px; font-weight: 600; margin-top: 2px; }
		.metric .avg { color: var(--muted); font-size: 11px; }

		.cache-row { padding: 10px 14px; border-top: 1px solid var(--border); }
		.cache-row .label { color: var(--muted); font-size: 11px; margin-bottom: 6px; }
		.bar { height: 8px; background: var(--border); border-radius: 4px; overflow: hidden; }
		.bar-fill { height: 100%; background: linear-gradient(90deg, var(--green), #81c784); transition: width .3s; }
		.bar-legend { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; margin-top: 4px; }

		.empty {
			text-align: center;
			color: var(--muted);
			padding: 60px 20px;
			border: 1px dashed var(--border);
			border-radius: 10px;
		}
		.empty .big { font-size: 42px; margin-bottom: 8px; }

		.status { color: var(--muted); font-size: 12px; margin-top: 8px; min-height: 18px; }
	</style>
</head>
<body>
	<main>
		<h1>📊 BYOK 用量统计</h1>
		<p class="intro">按模型汇总的长期使用数据（总和与均值）。数据保存在本地，不会上传。</p>

		<div class="toolbar">
			<button id="refresh" title="重新读取统计">⟳ 刷新</button>
			<button id="export" title="复制 JSON 到剪贴板">⧉ 导出</button>
			<button id="resetAll" class="danger" title="清空所有模型的统计">🗑 重置全部</button>
			<div class="spacer"></div>
			<button id="showLogs" title="打开 BYOK 输出日志">📜 日志</button>
			<button id="openSettings" title="打开 BYOK 设置">⚙ 设置</button>
		</div>

		<div id="summary" class="summary"></div>

		<div id="configStrip" class="config-strip"></div>

		<div id="models"></div>

		<div id="status" class="status" aria-live="polite"></div>
	</main>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		let state = ${initialState};

		function el(tag, className, text) {
			const node = document.createElement(tag);
			if (className) node.className = className;
			if (text !== undefined) node.textContent = text;
			return node;
		}

		function fmt(value) {
			if (typeof value !== 'number' || !isFinite(value)) return 'n/a';
			if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B';
			if (value >= 1e6) return (value / 1e6).toFixed(2) + 'M';
			if (value >= 1e3) return (value / 1e3).toFixed(1) + 'k';
			return String(Math.round(value));
		}

		function pct(value) {
			return value === undefined ? 'n/a' : value.toFixed(1) + '%';
		}

		function renderSummary() {
			const s = state.snapshot;
			const box = document.getElementById('summary');
			box.innerHTML = '';
			const items = [
				{ label: '请求数', value: String(s.requests) },
				{ label: '输入 tokens', value: fmt(s.promptTokens), sub: '总计' },
				{ label: '输出 tokens', value: fmt(s.completionTokens), sub: '总计' },
				{ label: '总 tokens', value: fmt(s.totalTokens), sub: '总计' },
				{ label: '缓存命中', value: fmt(s.cacheHitTokens), sub: '总计' },
			];
			const total = s.cacheHitTokens + s.cacheMissTokens;
			const rate = total > 0 ? (s.cacheHitTokens / total * 100) : 0;
			items.push({ label: '缓存命中率', value: total > 0 ? rate.toFixed(1) + '%' : 'n/a' });
			for (const it of items) {
				const card = el('div', 'summary-card');
				card.appendChild(el('div', 'label', it.label));
				card.appendChild(el('div', 'value', it.value));
				if (it.sub) card.appendChild(el('div', 'sub', it.sub));
				box.appendChild(card);
			}
		}

		function renderConfig() {
			const strip = document.getElementById('configStrip');
			strip.innerHTML = '';
			const debugDot = state.debugMode === 'verbose' ? 'var(--red)'
				: state.debugMode === 'metadata' ? 'var(--amber)' : 'var(--green)';
			const chip1 = el('span', 'chip');
			chip1.appendChild(el('span', 'dot'));
			chip1.lastChild.style.background = debugDot;
			chip1.appendChild(document.createTextNode('调试模式: ' + state.debugMode));
			strip.appendChild(chip1);

			const chip2 = el('span', 'chip');
			chip2.appendChild(el('span', 'dot'));
			chip2.lastChild.style.background = 'var(--accent)';
			chip2.appendChild(document.createTextNode('端点: ' + state.endpointCount));
			strip.appendChild(chip2);

			const link = el('a', null, '⚙ 配置选项…');
			link.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
			strip.appendChild(link);

			const link2 = el('a', null, '🔑 设置 API Key…');
			link2.addEventListener('click', () => vscode.postMessage({ type: 'setApiKey' }));
			strip.appendChild(link2);
		}

		function renderModel(model) {
			const card = el('div', 'model-card');

			const head = el('div', 'model-head');
			const icon = el('div', 'model-icon', '🤖');
			icon.style.background = 'linear-gradient(135deg, #667eea, #764ba2)';
			head.appendChild(icon);

			const title = el('div', 'model-title');
			title.appendChild(el('div', 'model-name', model.modelId));
			const metaParts = [];
			metaParts.push(model.apiModelId && model.apiModelId !== model.modelId ? 'api: ' + model.apiModelId : '');
			metaParts.push(model.requests + ' 次请求');
			metaParts.push('更新于 ' + new Date(model.lastUpdated).toLocaleString());
			title.appendChild(el('div', 'model-meta', metaParts.filter(Boolean).join(' · ')));
			head.appendChild(title);

			const actions = el('div', 'model-actions');
			const resetBtn = el('button', null, '重置');
			resetBtn.title = '清空该模型的统计';
			resetBtn.addEventListener('click', () => vscode.postMessage({ type: 'resetModel', modelId: model.modelId }));
			actions.appendChild(resetBtn);
			head.appendChild(actions);
			card.appendChild(head);

			const metrics = el('div', 'metrics');
			const rows = [
				{ label: '输入 tokens', value: fmt(model.promptTokens), avg: '均 ' + fmt(model.avgPromptTokens) },
				{ label: '输出 tokens', value: fmt(model.completionTokens), avg: '均 ' + fmt(model.avgCompletionTokens) },
				{ label: '总 tokens', value: fmt(model.totalTokens), avg: '均 ' + fmt(model.avgTotalTokens) },
				{ label: '缓存命中', value: fmt(model.cacheHitTokens), avg: '均 ' + fmt(model.cacheHitTokens / Math.max(1, model.requests)) },
				{ label: '缓存未命中', value: fmt(model.cacheMissTokens), avg: '均 ' + fmt(model.cacheMissTokens / Math.max(1, model.requests)) },
				{ label: 'chars/token', value: model.avgCharsPerToken.toFixed(2), avg: '均值' },
			];
			for (const row of rows) {
				const metric = el('div', 'metric');
				metric.appendChild(el('div', 'label', row.label));
				metric.appendChild(el('div', 'value', row.value));
				if (row.avg) metric.appendChild(el('div', 'avg', row.avg));
				metrics.appendChild(metric);
			}
			card.appendChild(metrics);

			const cacheRow = el('div', 'cache-row');
			cacheRow.appendChild(el('div', 'label', '缓存命中率 (聚合)'));
			const bar = el('div', 'bar');
			const fill = el('div', 'bar-fill');
			const totalCache = model.cacheHitTokens + model.cacheMissTokens;
			const rate = totalCache > 0 ? (model.cacheHitTokens / totalCache * 100) : 0;
			fill.style.width = (totalCache > 0 ? rate : 0) + '%';
			bar.appendChild(fill);
			cacheRow.appendChild(bar);
			const legend = el('div', 'bar-legend');
			legend.appendChild(el('span', null, 'hit ' + fmt(model.cacheHitTokens)));
			legend.appendChild(el('span', null, pct(model.cacheRate)));
			legend.appendChild(el('span', null, 'miss ' + fmt(model.cacheMissTokens)));
			cacheRow.appendChild(legend);
			card.appendChild(cacheRow);

			return card;
		}

		function renderModels() {
			const box = document.getElementById('models');
			box.innerHTML = '';
			if (!state.snapshot.models.length) {
				const empty = el('div', 'empty');
				empty.appendChild(el('div', 'big', '📭'));
				empty.appendChild(el('div', null, '暂无统计数据 — 发起一次 BYOK 对话后这里会出现按模型汇总的用量。'));
				box.appendChild(empty);
				return;
			}
			for (const model of state.snapshot.models) {
				box.appendChild(renderModel(model));
			}
		}

		function render() {
			renderSummary();
			renderConfig();
			renderModels();
		}

		document.getElementById('refresh').addEventListener('click', () => {
			vscode.postMessage({ type: 'refresh' });
		});
		document.getElementById('export').addEventListener('click', () => {
			vscode.postMessage({ type: 'export' });
		});
		document.getElementById('resetAll').addEventListener('click', () => {
			vscode.postMessage({ type: 'resetAll' });
		});
		document.getElementById('showLogs').addEventListener('click', () => {
			vscode.postMessage({ type: 'showLogs' });
		});
		document.getElementById('openSettings').addEventListener('click', () => {
			vscode.postMessage({ type: 'openSettings' });
		});

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (message.type === 'state') {
				state = message.value;
				render();
				const status = document.getElementById('status');
				status.textContent = '已更新 ' + new Date().toLocaleTimeString();
			}
		});

		render();
	</script>
</body>
</html>`;
}
