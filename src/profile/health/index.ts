// ============================================================================
// profile/health — 端点连接/健康/延迟遥测(只记录,不决策)
//
// Phase 3 & Phase 6 (docs/ARCHITECTURE.md ⑤ profile 遥测层):
//   收敛到统一 profile 目录,并在侧栏/面板展示。
//   本模块只负责【记录】每端点的最近请求时间、成功/失败数、延迟、最后错误、
//   连接状态(ok | unreachable | error),不做任何业务决策。
// ============================================================================

export type EndpointHealthStatus = 'ok' | 'unreachable' | 'error';

export interface EndpointHealth {
	/** Last time a request to this endpoint was attempted (ms epoch). */
	lastRequestAt?: number;
	/** Last time a request to this endpoint succeeded (ms epoch). */
	lastSuccessAt?: number;
	/** Successful request count. */
	successCount: number;
	/** Failed request count. */
	failureCount: number;
	/** Moving-average latency in ms of the last successful request(s). */
	avgLatencyMs?: number;
	/** The most recent error message, kept short. */
	lastError?: string;
	/** Latest derived connection state. */
	status: EndpointHealthStatus;
}

/**
 * In-memory health store for all endpoints. Persisted state is intentionally
 * kept minimal: consumers can snapshot on demand. Only records — never decides.
 */
class HealthStore {
	private readonly byEndpoint = new Map<string, EndpointHealth>();
	private readonly listeners = new Set<() => void>();

	/** Subscribe to health changes. Returns an unsubscribe function. */
	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Presentation listeners must never break health recording.
			}
		}
	}

	private get(name: string): EndpointHealth {
		let entry = this.byEndpoint.get(name);
		if (!entry) {
			entry = {
				successCount: 0,
				failureCount: 0,
				status: 'ok',
			};
			this.byEndpoint.set(name, entry);
		}
		return entry;
	}

	/** Record the *start* of an attempt (e.g. before streaming begins). */
	recordAttempt(name: string): void {
		const entry = this.get(name);
		entry.lastRequestAt = Date.now();
		this.notify();
	}

	/** Record a successful completion with the round-trip latency in ms. */
	recordSuccess(name: string, latencyMs: number): void {
		const entry = this.get(name);
		entry.lastSuccessAt = Date.now();
		entry.successCount += 1;
		entry.lastError = undefined;
		entry.status = 'ok';
		entry.avgLatencyMs = entry.avgLatencyMs
			? (entry.avgLatencyMs * (entry.successCount - 1) + latencyMs) / entry.successCount
			: latencyMs;
		this.notify();
	}

	/** Record a failure. */
	recordFailure(name: string, error: unknown): void {
		const entry = this.get(name);
		entry.failureCount += 1;
		entry.lastError = errorMessage(error);
		entry.status = classify(errorMessage(error));
		this.notify();
	}

	/** Snapshot a single endpoint. */
	getHealth(name: string): EndpointHealth {
		return { ...this.get(name) };
	}

	/** Snapshot all endpoints, sorted by name. */
	snapshot(): { name: string; health: EndpointHealth }[] {
		return [...this.byEndpoint.entries()]
			.map(([name, health]) => ({ name, health: { ...health } }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	reset(name?: string): void {
		if (name) {
			this.byEndpoint.delete(name);
		} else {
			this.byEndpoint.clear();
		}
		this.notify();
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message.slice(0, 200);
	}
	if (typeof error === 'string') {
		return error.slice(0, 200);
	}
	return 'Unknown error';
}

function classify(message: string): EndpointHealthStatus {
	const lower = message.toLowerCase();
	if (/timeout|econnrefused|econnreset|enetunreach|enotfound|unreachable/i.test(lower)) {
		return 'unreachable';
	}
	return 'error';
}

/** Shared singleton. Presentation (sidebar/panel) reads via `snapshot()`. */
export const healthStore = new HealthStore();
