import vscode from 'vscode';
import { healthStore, type EndpointHealth, type EndpointHealthStatus } from './index';

let currentPanel: vscode.WebviewPanel | undefined;

function statusLabel(status: EndpointHealthStatus): string {
	switch (status) {
		case 'unreachable':
			return '不可达';
		case 'error':
			return '出错';
		default:
			return '正常';
	}
}

function statusColor(status: EndpointHealthStatus): string {
	switch (status) {
		case 'unreachable':
			return '#d97706';
		case 'error':
			return '#dc2626';
		default:
			return '#16a34a';
	}
}

function formatTime(ms?: number): string {
	if (ms === undefined) {
		return '—';
	}
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface HealthPanelState {
	endpoints: { name: string; health: EndpointHealth }[];
}

export function openHealthPanel(): void {
	if (currentPanel) {
		currentPanel.reveal();
		postState(currentPanel);
		return;
	}

	const panel = vscode.window.createWebviewPanel(
		'byokHealth',
		'BYOK 连接健康',
		vscode.ViewColumn.Active,
		{ enableScripts: true, retainContextWhenHidden: true },
	);
	currentPanel = panel;

	panel.onDidDispose(() => {
		currentPanel = undefined;
		dispose();
	});

	panel.webview.onDidReceiveMessage((message: unknown) => {
		if (isMessage(message) && message.type === 'refresh') {
			postState(panel);
		}
	});

	renderPanel(panel);

	// Live updates while the panel is open.
	const off = healthStore.onDidChange(() => postState(panel));
	let disposed = false;
	const dispose = () => {
		if (!disposed) {
			disposed = true;
			off();
		}
	};
	panel.onDidDispose(dispose);
}

function renderPanel(panel: vscode.WebviewPanel): void {
	panel.webview.html = getHealthPanelHtml(getPanelState());
}

function getPanelState(): HealthPanelState {
	return { endpoints: healthStore.snapshot() };
}

function postState(panel: vscode.WebviewPanel): void {
	void panel.webview.postMessage({
		type: 'state',
		value: { body: buildHealthBody(getPanelState()) },
	});
}

function isMessage(message: unknown): message is { type: string } {
	return typeof message === 'object' && message !== null && 'type' in message;
}

export function getHealthPanelHtml(state: HealthPanelState): string {
	const body = buildHealthBody(state);

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
	body { font-family: var(--vscode-font-family); padding: 16px; color: var(--vscode-foreground); }
	h1 { font-size: 16px; margin: 0 0 16px; }
	.card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; margin-bottom: 12px; }
	.row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
	.dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
	.name { font-weight: 600; }
	.status { margin-left: auto; font-size: 12px; }
	.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
	.grid > div { display: flex; flex-direction: column; gap: 2px; }
	.label { font-size: 11px; opacity: 0.7; }
	.value { font-size: 13px; }
	.err { margin-top: 10px; font-size: 12px; color: var(--vscode-errorForeground); word-break: break-all; }
	.empty { opacity: 0.8; }
	.toolbar { margin-bottom: 12px; }
</style>
</head>
<body>
	<div class="toolbar"><button id="refresh">刷新</button></div>
	<h1>BYOK 端点连接健康</h1>
	<div id="content">${body}</div>
<script>
	const vscode = acquireVsCodeApi();
	document.getElementById('refresh').addEventListener('click', () => {
		vscode.postMessage({ type: 'refresh' });
	});
	window.addEventListener('message', (event) => {
		const message = event.data;
		if (message && message.type === 'state') {
			document.getElementById('content').innerHTML = message.value.body;
		}
	});
</script>
</body>
</html>`;
}

function buildHealthBody(state: HealthPanelState): string {
	const rows = state.endpoints
		.map(({ name, health }) => {
			const total = health.successCount + health.failureCount;
			const rate = total > 0 ? Math.round((health.successCount / total) * 100) : 100;
			const color = statusColor(health.status);
			const latency =
				health.avgLatencyMs !== undefined ? `${health.avgLatencyMs.toFixed(0)} ms` : '—';
			const errorHtml = health.lastError
				? `<div class="err" title="${escapeHtml(health.lastError)}">⚠ ${escapeHtml(health.lastError)}</div>`
				: '';
			return `<div class="card">
				<div class="row">
					<span class="dot" style="background:${color}"></span>
					<span class="name">${escapeHtml(name)}</span>
					<span class="status" style="color:${color}">${statusLabel(health.status)}</span>
				</div>
				<div class="grid">
					<div><span class="label">成功</span><span class="value">${health.successCount}</span></div>
					<div><span class="label">失败</span><span class="value">${health.failureCount}</span></div>
					<div><span class="label">成功率</span><span class="value">${rate}%</span></div>
					<div><span class="label">延迟</span><span class="value">${latency}</span></div>
					<div><span class="label">最近请求</span><span class="value">${formatTime(health.lastRequestAt)}</span></div>
					<div><span class="label">最近成功</span><span class="value">${formatTime(health.lastSuccessAt)}</span></div>
				</div>
				${errorHtml}
			</div>`;
		})
		.join('\n');

	const body =
		state.endpoints.length === 0
			? `<p class="empty">暂无连接数据。发起一次对话后，这里会显示各端点的连接状态、成功率与延迟。</p>`
			: rows;
	return body;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => {
		switch (ch) {
			case '&':
				return '&amp;';
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '"':
				return '&quot;';
			default:
				return '&#39;';
		}
	});
}
