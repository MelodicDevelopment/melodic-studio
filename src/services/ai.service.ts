/**
 * One-shot questions to Claude Code: "write a commit message for this diff",
 * "explain this change". Every AI feature that is not a long-running agent
 * session goes through `ask()`.
 *
 * It runs the user's own `claude` CLI in the active checkout (the same path the
 * Agents tab uses), with no MCP servers or skills loaded so it starts in a few
 * seconds, and with only the tools the caller names.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { BackendService, type AgentDone, type AgentEvent } from './backend.service';
import { RepoStore } from './repo.store';

export interface AskOptions {
	/**
	 * The question. Start it with a `[tag]` line naming the feature (`[commit-message]`);
	 * the browser preview's demo backend keys its canned answers on it (demoAnswer()).
	 */
	prompt: string;
	/**
	 * Permission rules Claude may use without asking, e.g. `['Read', 'Grep', 'Glob', 'Bash(git log:*)']`.
	 * Omit or pass `[]` for none: the answer then comes only from what is in the prompt, which is fastest.
	 */
	tools?: string[];
	/** `haiku` (default: fast, cheap), `sonnet` or `opus` for harder questions. */
	model?: string;
	/** Called as text arrives (whole messages, not characters) with everything so far. */
	onText?: (soFar: string) => void;
	/** Where to ask, when not the checkout on screen: a repository and one of its checkouts (an agent's worktree). */
	where?: { repoId: string; cwd: string };
	/** Called with what the question cost, in dollars, when Claude Code reports it. */
	onCost?: (usd: number) => void;
}

export interface Ask {
	/** Resolves with the final answer; rejects with an Error when Claude Code fails or is stopped. */
	result: Promise<string>;
	cancel(): void;
}

interface Pending {
	text: string;
	final: string | null;
	error: string | null;
	onText?: (soFar: string) => void;
	onCost?: (usd: number) => void;
	resolve(text: string): void;
	reject(error: Error): void;
}

// Re-exported from where it lives now: a module with no imports, so `ai-prompts.ts` runs under `npm test`.
export { parseJson } from '../shared/json.ts';

@Injectable()
export class AiService {
	private readonly _pending = new Map<string, Pending>();
	private _listening: Promise<void> | null = null;

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
	}

	private listen(): Promise<void> {
		return (this._listening ??= (async () => {
			await this.backend.listen<AgentEvent>('agent-event', ({ key, event }) => {
				const p = this._pending.get(key);
				if (!p) {
					return;
				}
				if (event.type === 'assistant') {
					const blocks = ((event.message as { content?: { type: string; text?: string }[] })?.content ?? []) as { type: string; text?: string }[];
					const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('');
					if (text) {
						p.text += (p.text ? '\n\n' : '') + text;
						p.onText?.(p.text);
					}
				} else if (event.type === 'result') {
					if (Number(event.total_cost_usd)) {
						p.onCost?.(Number(event.total_cost_usd));
					}
					if (event.is_error) {
						p.error = String(event.result ?? 'Claude Code reported an error.');
					} else if (typeof event.result === 'string' && event.result) {
						p.final = event.result;
					}
				}
			});
			await this.backend.listen<AgentDone>('agent-done', ({ key, ok, error }) => {
				const p = this._pending.get(key);
				if (!p) {
					return;
				}
				this._pending.delete(key);
				const answer = p.final ?? p.text;
				if (p.error || (!ok && !answer)) {
					p.reject(new Error(p.error || error || 'Claude Code exited with an error.'));
				} else {
					p.resolve(answer);
				}
			});
		})());
	}

	/** Ask in the checkout the app is looking at, or in `options.where`. */
	ask(options: AskOptions): Ask {
		const shown = this.repos.repo();
		const repo = options.where ? { id: options.where.repoId, path: options.where.cwd, worktree: null } : shown;
		const key = `ai:${crypto.randomUUID()}`;
		let cancelled = false;
		const result = new Promise<string>((resolve, reject) => {
			if (!repo) {
				reject(new Error('Open a repository first.'));
				return;
			}
			this.listen()
				.then(() => {
					if (cancelled) {
						throw new Error('Stopped.');
					}
					this._pending.set(key, { text: '', final: null, error: null, onText: options.onText, onCost: options.onCost, resolve, reject });
					const tools = options.tools ?? [];
					// With tools named, `default` mode lets exactly those run and refuses the rest.
					return this.backend.agentStart(repo.id, repo.worktree || repo.path, key, options.prompt, 'default', null, { tools, model: options.model ?? 'haiku', quick: true });
				})
				.catch((e) => {
					this._pending.delete(key);
					reject(e instanceof Error ? e : new Error((e as { message?: string })?.message ?? String(e)));
				});
		});
		return {
			result,
			cancel: () => {
				cancelled = true;
				const p = this._pending.get(key);
				if (p) {
					this._pending.delete(key);
					p.reject(new Error('Stopped.'));
					void this.backend.agentStop(key).catch(() => undefined);
				}
			},
		};
	}
}
