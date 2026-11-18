/**
 * The integrated terminal panel: its shells (as tabs), plus the panel's
 * open/closed state and height. The xterm screens themselves live in
 * ScreenPool, so a shell keeps running (and keeps its scrollback) while the
 * panel is hidden or the work area is rebuilt around it.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { computed, signal } from '@melodicdev/core/signals';
import { BackendService } from './backend.service';
import { RepoStore } from './repo.store';
import { ScreenPool } from './screens';

/** One terminal, as the tab strip shows it. */
export interface TermTab {
	id: string;
	/** Each repository tab has its own terminals; the others keep running out of sight. */
	repoId: string;
	title: string;
	/** The checkout it was opened in. */
	cwd: string;
	/** The shell is gone; the tab stays so its last words can be read. */
	ended: boolean;
}

const OPEN_KEY = 'studio.terminal.open';
const HEIGHT_KEY = 'studio.terminal.height';
const MIN_H = 120;
const DEFAULT_H = 280;
/** The least of the main pane (and toolbar) a tall terminal leaves showing. */
const KEEP_ABOVE = 180;
/** A shell that fails this soon after starting never worked; its tab stays open to say why. */
export const FAILED_START_MS = 3000;

function saved(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function save(key: string, value: string | null): void {
	try {
		if (value === null) {
			localStorage.removeItem(key);
		} else {
			localStorage.setItem(key, value);
		}
	} catch {
		/* blocked storage */
	}
}

function clampHeight(h: number): number {
	const max = Math.max(MIN_H, (typeof window === 'undefined' ? 800 : window.innerHeight) - KEEP_ABOVE);
	return Math.round(Math.min(max, Math.max(MIN_H, h)));
}

function savedHeight(): number {
	const h = Number(saved(HEIGHT_KEY));
	return h >= MIN_H ? clampHeight(h) : DEFAULT_H;
}

export function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

@Injectable()
export class TerminalStore {
	/** The panel is showing. */
	readonly open = signal(saved(OPEN_KEY) === '1');
	readonly height = signal(savedHeight());
	/** Every terminal, in every repository. */
	readonly all = signal<TermTab[]>([]);
	/** The selected terminal of each repository. */
	private readonly _active = signal<Record<string, string | null>>({});
	/** The open repository's terminals. */
	readonly tabs = computed<TermTab[]>(() => {
		const repo = this.repos.repo()?.id;
		return this.all().filter((t) => t.repoId === repo);
	});
	readonly active = computed<string | null>(() => {
		const tabs = this.tabs();
		const chosen = this._active()[this.repos.repo()?.id ?? ''];
		return tabs.some((t) => t.id === chosen) ? chosen! : (tabs[0]?.id ?? null);
	});
	/** A terminal is on its way: xterm is loading, or its tab is about to appear. */
	readonly starting = signal(false);

	private _container: HTMLElement | null = null;

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
	}
	private get pool(): ScreenPool {
		return Injector.get(ScreenPool);
	}

	// ---- panel --------------------------------------------------------------

	/** The panel's element that holds the screens, while the panel component is in the page. */
	attach(container: HTMLElement): void {
		this._container = container;
		if (!this.open()) {
			return;
		}
		// No focus here: the panel is rebuilt on a repository or worktree switch, and that must not move the keyboard.
		if (this.tabs().length) {
			this.layout();
		} else if (!this.starting()) {
			void this.add();
		}
	}

	detach(container: HTMLElement): void {
		if (this._container === container) {
			this._container = null;
		}
	}

	toggle(): void {
		if (this.open()) {
			this.hide();
		} else {
			this.reveal();
		}
	}

	/** Show the panel with a terminal in it, starting one when there is none. */
	reveal(): void {
		this.setOpen(true);
		if (this.tabs().length) {
			// After the render that un-hides the panel, so there is a size to fit to.
			requestAnimationFrame(() => this.focus());
		} else if (!this.starting()) {
			void this.add();
		}
	}

	hide(): void {
		this.setOpen(false);
		// A hidden terminal must not go on swallowing the keyboard.
		this.all().forEach((t) => this.pool.blur(t.id));
	}

	private setOpen(open: boolean): void {
		if (this.open() !== open) {
			this.open.set(open);
			save(OPEN_KEY, open ? '1' : '0');
		}
	}

	setHeight(height: number): void {
		this.height.set(clampHeight(height));
	}

	saveHeight(): void {
		save(HEIGHT_KEY, String(this.height()));
	}

	resetHeight(): void {
		this.height.set(clampHeight(DEFAULT_H));
		save(HEIGHT_KEY, null);
	}

	/**
	 * Put the active screen in the panel, at the panel's size. Safe to call
	 * whenever either may have changed; does nothing while the panel is hidden.
	 */
	layout(): void {
		const id = this.active();
		if (!this._container) {
			return;
		}
		if (id) {
			this.pool.show(id, this._container);
		} else {
			// Another repository's terminals stay in the panel's element, hidden.
			for (const child of Array.from(this._container.children)) {
				if (child instanceof HTMLElement && child.classList.contains('screen')) {
					child.hidden = true;
				}
			}
		}
	}

	focus(): void {
		this.layout();
		const id = this.active();
		if (id) {
			this.pool.focus(id);
		}
	}

	// ---- terminals ----------------------------------------------------------

	/** A new terminal in whichever checkout is active: the repository, or the worktree being looked at. */
	async add(): Promise<void> {
		const repo = this.repos.repo();
		if (!repo || this.starting()) {
			return;
		}
		this.starting.set(true);
		this.setOpen(true);
		let id: string | null = null;
		try {
			const cwd = repo.worktree || repo.path;
			const screen = await this.pool.create({ exit: (code, ranFor) => screen && this.ended(screen, code, ranFor) });
			id = screen;
			this.all.set([...this.all(), { id, repoId: repo.id, title: this.titleFor(cwd), cwd, ended: false }]);
			this.starting.set(false);
			this.select(id);
			await this.pool.start(id, (cols, rows) => this.backend.termOpen(repo.id, cols, rows));
		} catch (e) {
			if (id) {
				this.remove(id);
			}
			this.repos.fail(e);
		} finally {
			this.starting.set(false);
		}
	}

	select(id: string): void {
		const tab = this.all().find((t) => t.id === id);
		if (!tab || !this.pool.has(id)) {
			return;
		}
		this._active.set({ ...this._active(), [tab.repoId]: id });
		this.focus();
	}

	/** Close a terminal and end its shell. */
	close(id: string): void {
		this.remove(id);
	}

	private remove(id: string): void {
		const gone = this.all().find((t) => t.id === id);
		if (!gone) {
			return;
		}
		this.pool.close(id);
		const siblings = this.all().filter((t) => t.repoId === gone.repoId);
		const at = siblings.findIndex((t) => t.id === id);
		const left = siblings.filter((t) => t.id !== id);
		const wasActive = this._active()[gone.repoId] === id || (!this._active()[gone.repoId] && at === 0);
		this.all.set(this.all().filter((t) => t.id !== id));
		const onScreen = gone.repoId === this.repos.repo()?.id;
		if (wasActive) {
			const next = left[Math.min(at, left.length - 1)] ?? null;
			this._active.set({ ...this._active(), [gone.repoId]: next?.id ?? null });
			if (next && this.open() && onScreen) {
				this.select(next.id);
			}
		}
		if (!left.length && onScreen) {
			this.hide();
		}
	}

	private titleFor(cwd: string): string {
		const base = folderName(cwd);
		const taken = new Set(this.tabs().map((t) => t.title));
		let title = base;
		for (let n = 2; taken.has(title); n++) {
			title = `${base} ${n}`;
		}
		return title;
	}

	private ended(id: string, code: number | null, ranFor: number): void {
		if (!code || ranFor > FAILED_START_MS) {
			this.remove(id);
			return;
		}
		this.pool.note(id, `[The shell ended with exit code ${code}]`);
		this.all.set(this.all().map((t) => (t.id === id ? { ...t, ended: true } : t)));
	}
}

/** For templates outside the terminal panel (the toolbar button). */
export function terminals(): TerminalStore {
	return Injector.get(TerminalStore);
}
