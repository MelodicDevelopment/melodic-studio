/**
 * Where an agent session or a Claude conversation stands for the person at the keyboard:
 * something to look at, something still running, or done. The Agents tab groups its list
 * by it, and the toolbar counts the first.
 */
export type Bucket = 'needs' | 'working' | 'done';

/** A session's state (AgentState in agents.store.ts; a conversation's is mapped to it by `convAgentState`). */
export type Standing = 'working' | 'failed' | 'review' | 'stopped' | 'finished';

export const BUCKETS: readonly { key: Bucket; label: string }[] = [
	{ key: 'needs', label: 'Needs you' },
	{ key: 'working', label: 'Working' },
	{ key: 'done', label: 'Done' },
];

/**
 * `unread` is "it ended since it was last on screen": that is the user's turn too,
 * until they have looked. A failed or stopped one that was seen is done.
 */
export function bucketOf(state: Standing, unread: boolean): Bucket {
	if (state === 'working') {
		return 'working';
	}
	return state === 'review' || unread ? 'needs' : 'done';
}

/** Rows that stand together (the attempts of one task) go where the most pressing of them goes. */
export function mostPressing(buckets: Bucket[]): Bucket {
	return buckets.includes('needs') ? 'needs' : buckets.includes('working') ? 'working' : 'done';
}
