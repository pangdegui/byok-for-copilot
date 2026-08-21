import { Agent, EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from 'undici';
import type { ProxyConfig } from '../config';

/**
 * Proxy dispatcher resolution.
 *
 * Maps a per-endpoint / per-style / per-model `ProxyConfig` to an undici
 * `Dispatcher` passed to the built-in `fetch(url, { dispatcher })` used by the
 * protocol clients. Dispatchers are long-lived and cached so connections are
 * pooled and reused (no per-request rebuild).
 *
 * Modes:
 *   - 'system'  → `EnvHttpProxyAgent` (respects HTTP(S)_PROXY / NO_PROXY).
 *   - 'direct'  → plain `Agent` (no proxy, bypasses any env/system proxy).
 *   - 'proxy'   → `ProxyAgent(url)` (fixed proxy, http:// or https:// only).
 */

let directAgent: Agent | undefined;
let systemAgent: EnvHttpProxyAgent | undefined;
const proxyAgents = new Map<string, ProxyAgent>();

/**
 * Resolve the undici Dispatcher for the given proxy config.
 * Returns `undefined` semantics are NOT used here: every mode yields a
 * dispatcher. A missing/empty config defaults to 'system'.
 */
export function getDispatcher(config?: ProxyConfig): Dispatcher {
	const mode = config?.mode ?? 'system';
	switch (mode) {
		case 'direct':
			return getDirectAgent();
		case 'proxy':
			return getProxyAgent(config?.url);
		case 'system':
		default:
			return getSystemAgent();
	}
}

function getDirectAgent(): Agent {
	return (directAgent ??= new Agent({ connections: 8 }));
}

function getSystemAgent(): EnvHttpProxyAgent {
	return (systemAgent ??= new EnvHttpProxyAgent());
}

function getProxyAgent(rawUrl: string | undefined): ProxyAgent {
	const url = rawUrl?.trim();
	if (!url) {
		throw new Error('代理模式(proxy)下必须提供代理地址 proxy.url');
	}
	assertHttpProxyUrl(url);
	let agent = proxyAgents.get(url);
	if (!agent) {
		agent = new ProxyAgent(url);
		proxyAgents.set(url, agent);
	}
	return agent;
}

/** Only http:// and https:// proxies are supported for now. */
function assertHttpProxyUrl(url: string): void {
	let protocol: string;
	try {
		protocol = new URL(url).protocol;
	} catch {
		throw new Error(`无效的代理地址: ${url}`);
	}
	if (protocol !== 'http:' && protocol !== 'https:') {
		throw new Error(`不支持的代理协议 ${protocol}（仅支持 http:// 或 https://）: ${url}`);
	}
}
