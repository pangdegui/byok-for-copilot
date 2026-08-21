/**
 * In-process cache for OpenAI Responses reasoning replay state.
 *
 * In the stateful (`store: true`) reasoning-replay mode, the server returns a
 * `response.id` (e.g. `resp_xxx`) that must be sent back on the next turn via
 * `previous_response_id`. VS Code drives the tool loop by re-invoking the
 * provider for every turn, so we key the most recent `response.id` by the
 * conversation segment id and reuse it across turns within the same session.
 *
 * This is intentionally a simple in-memory map: the same extension host serves
 * a single conversation, and the segment id is stable across turns (it is
 * persisted inside the replay marker). Cross-process persistence (e.g. via
 * SecretStorage) is a possible future enhancement but is not required for the
 * multi-turn / tool-call loop to work.
 */
export class ReasoningStateCache {
	private readonly store = new Map<string, string>();

	/** Get the last `response.id` cached for a segment, if any. */
	get(segmentId: string): string | undefined {
		return this.store.get(segmentId);
	}

	/** Record the `response.id` returned for a segment. */
	set(segmentId: string, responseId: string): void {
		this.store.set(segmentId, responseId);
	}

	/** Drop a cached id (e.g. when a segment is known to be finished). */
	delete(segmentId: string): void {
		this.store.delete(segmentId);
	}
}

export const reasoningStateCache = new ReasoningStateCache();
