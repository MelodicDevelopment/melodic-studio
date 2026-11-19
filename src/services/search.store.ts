/**
 * Find in files (Cmd/Ctrl+Shift+F): the text, its options and the answer, kept here so they
 * outlive the Files tab's sidebar, which is rebuilt on every tab switch. The searching is
 * `git grep` in the active checkout (`Git::grep`); see shared/search.ts for the shapes.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal } from '@melodicdev/core/signals';
import { BackendService } from './backend.service';
import { RepoStore } from './repo.store';
import type { SearchOptions, SearchResult } from '../shared/search';

const OPTIONS_KEY = 'studio.search.options';
/** Typing waits this long before it searches. */
const TYPING_MS = 220;

function savedOptions(): SearchOptions {
	try {
		const o = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Partial<SearchOptions>;
		return { matchCase: o.matchCase === true, wholeWord: o.wholeWord === true, regex: o.regex === true };
	} catch {
		return { matchCase: false, wholeWord: false, regex: false };
	}
}

@Injectable()
export class SearchStore {
	readonly query = signal('');
	readonly options = signal<SearchOptions>(savedOptions());
	/** The answer to the last search that finished; null before one has. */
	readonly result = signal<SearchResult | null>(null);
	readonly busy = signal(false);
	/** Why the search could not run (an expression git cannot read). */
	readonly error = signal('');
	/** Files whose matches are folded away. */
	readonly folded = signal<ReadonlySet<string>>(new Set());
	/** The match last opened, as `path:line`. */
	readonly opened = signal('');
	/** Goes up each time the box is asked to take the keyboard; the box compares it with `focused`. */
	readonly focusAsked = signal(0);
	focused = 0;
	/** The editor's selected text, when the editor is on screen: what Cmd/Ctrl+Shift+F starts with. */
	selection: (() => string) | null = null;

	private _token = 0;
	private _timer = 0;
	/** The checkout the answer is for. */
	private _for = '';

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
	}

	/** Whether the results take the tree's place. */
	active(): boolean {
		return this.query().length > 0;
	}

	type(value: string): void {
		this.query.set(value);
		window.clearTimeout(this._timer);
		if (!value) {
			this.clear();
			return;
		}
		this._timer = window.setTimeout(() => void this.run(), TYPING_MS);
	}

	setOption(key: keyof SearchOptions, on: boolean): void {
		this.options.set({ ...this.options(), [key]: on });
		try {
			localStorage.setItem(OPTIONS_KEY, JSON.stringify(this.options()));
		} catch {
			/* blocked storage */
		}
		void this.run();
	}

	clear(): void {
		window.clearTimeout(this._timer);
		this._token++;
		this.query.set('');
		this.result.set(null);
		this.error.set('');
		this.busy.set(false);
		this.folded.set(new Set());
		this.opened.set('');
	}

	/** Cmd/Ctrl+Shift+F: the box takes the keyboard, starting from the editor's selection when there is one. */
	ask(): void {
		const selected = this.selection?.() ?? '';
		if (selected && selected !== this.query()) {
			this.query.set(selected);
			void this.run();
		}
		this.focusAsked.set(this.focusAsked() + 1);
	}

	/** The checkout on screen changed (another repository, a worktree): the answer was for the old one. */
	checkoutChanged(): void {
		if (this.active() && this.checkout() !== this._for) {
			void this.run();
		}
	}

	private checkout(): string {
		const repo = this.repos.repo();
		return repo ? `${repo.id}\n${repo.worktree ?? ''}` : '';
	}

	/** Search now. An answer to an earlier search that arrives after this one started is dropped. */
	async run(): Promise<void> {
		window.clearTimeout(this._timer);
		const token = ++this._token;
		const repo = this.repos.repo();
		const query = this.query();
		if (!repo || !query) {
			return;
		}
		const checkout = this.checkout();
		this.busy.set(true);
		try {
			const result = await this.backend.searchFiles(repo.id, query, this.options());
			if (token !== this._token) {
				return;
			}
			this._for = checkout;
			this.result.set(result);
			this.error.set('');
			this.folded.set(new Set());
		} catch (e) {
			if (token !== this._token) {
				return;
			}
			this._for = checkout;
			this.result.set(null);
			this.error.set((e as { message?: string })?.message ?? String(e));
		} finally {
			if (token === this._token) {
				this.busy.set(false);
			}
		}
	}

	fold(path: string): void {
		const next = new Set(this.folded());
		if (!next.delete(path)) {
			next.add(path);
		}
		this.folded.set(next);
	}
}
