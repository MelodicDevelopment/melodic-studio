/**
 * The files of the checkout on screen, for opening one by name (the "Go to" box, Cmd/Ctrl+P):
 * `git ls-files` for tracked and new files, kept per checkout and read again when asked.
 * Also which files were opened lately, per checkout (localStorage `studio.files.recent`).
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal } from '@melodicdev/core/signals';
import { BackendService } from './backend.service';
import { RepoStore } from './repo.store';
import { buildIndex, type FileIndex } from '../shared/fuzzy';

const RECENT_KEY = 'studio.files.recent';
const RECENT_FILES = 40;
const RECENT_CHECKOUTS = 60;

interface Listed {
	index: FileIndex;
	truncated: boolean;
}

function savedRecent(): Record<string, string[]> {
	try {
		const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, unknown>;
		return Object.fromEntries(Object.entries(all).filter(([, list]) => Array.isArray(list)).map(([key, list]) => [key, (list as unknown[]).filter((p): p is string => typeof p === 'string')]));
	} catch {
		return {};
	}
}

@Injectable()
export class FileIndexStore {
	/** Every checkout's list as last read; `list()` is the one on screen. */
	private readonly _lists = signal<ReadonlyMap<string, Listed>>(new Map());
	private readonly _reading = new Map<string, Promise<Listed | null>>();
	private readonly _recent = signal<Record<string, string[]>>(savedRecent());

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
	}

	/** A linked worktree is a different set of files under the same repository id (as in ExplorerStore). */
	private checkout(): string {
		const repo = this.repos.repo();
		return repo ? repo.worktree || repo.id : '';
	}

	/** The list for the checkout on screen, or null while it has never been read. */
	list(): Listed | null {
		return this._lists().get(this.checkout()) ?? null;
	}

	/** The files opened lately in the checkout on screen, most recent first. */
	recent(): string[] {
		return this._recent()[this.checkout()] ?? [];
	}

	/** Read the list again (files come and go). Calls that overlap share one read. */
	load(): Promise<Listed | null> {
		const repo = this.repos.repo();
		const checkout = this.checkout();
		if (!repo) {
			return Promise.resolve(null);
		}
		const running = this._reading.get(checkout);
		if (running) {
			return running;
		}
		const read = (async (): Promise<Listed | null> => {
			try {
				const files = await this.backend.listFiles(repo.id);
				const listed: Listed = { index: buildIndex(files.paths), truncated: files.truncated };
				this._lists.set(new Map(this._lists()).set(checkout, listed));
				return listed;
			} catch {
				return this._lists().get(checkout) ?? null; // what was read before is better than nothing
			} finally {
				this._reading.delete(checkout);
			}
		})();
		this._reading.set(checkout, read);
		return read;
	}

	/** A file was opened in the checkout on screen. */
	opened(path: string): void {
		const checkout = this.checkout();
		if (!checkout) {
			return;
		}
		const all = { ...this._recent() };
		delete all[checkout];
		const next = { [checkout]: [path, ...this.recent().filter((p) => p !== path)].slice(0, RECENT_FILES), ...all };
		// Checkouts come and go (worktrees): the ones used longest ago fall off.
		this._recent.set(Object.fromEntries(Object.entries(next).slice(0, RECENT_CHECKOUTS)));
		try {
			localStorage.setItem(RECENT_KEY, JSON.stringify(this._recent()));
		} catch {
			/* blocked storage */
		}
	}
}
