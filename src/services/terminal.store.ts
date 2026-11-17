/**
 * The integrated terminal: every open shell with its xterm.js screen, plus the
 * panel's open/closed state and height. The screens live here, not in the
 * component, so a shell keeps running (and keeps its scrollback) while the
 * panel is hidden or the work area is rebuilt around it.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal } from '@melodicdev/core/signals';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { BackendService, isMac } from './backend.service';
import { RepoStore } from './repo.store';
import { adoptXtermStyles, loadXterm, termFont, xtermTheme, type XtermApi } from '../shared/xterm';

/** One terminal, as the tab strip shows it. */
export interface TermTab {
	id: string;
	title: string;
	/** The checkout it was opened in. */
	cwd: string;
	/** The shell is gone; the tab stays so its last words can be read. */
	ended: boolean;
}

interface TermData {
	key: string;
	/** Base64 of raw bytes: a read can end in the middle of a UTF-8 character. */
	data: string;
}
interface TermExit {
	key: string;
	code: number | null;
}

interface Screen {
	term: Terminal;
	fit: FitAddon;
	/** What xterm draws into. Moves into the panel when the terminal is shown. */
	host: HTMLDivElement;
	/** The native side's name for the shell; null until `term_open` has answered. */
	key: string | null;
	/** `term.open()` has run; it needs a host that is on screen. */
	opened: boolean;
	ended: boolean;
	started: number;
	/** Keystrokes not sent yet. One write at a time keeps them in order. */
	outbox: string;
	sending: boolean;
}

const OPEN_KEY = 'studio.terminal.open';
const HEIGHT_KEY = 'studio.terminal.height';
const MIN_H = 120;
const DEFAULT_H = 280;
/** The least of the main pane (and toolbar) a tall terminal leaves showing. */
const KEEP_ABOVE = 180;
/** A shell that fails this soon after starting never worked; its tab stays open to say why. */
const FAILED_START_MS = 3000;

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

function decode(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function folderName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function isWindows(): boolean {
	return typeof navigator !== 'undefined' && /Win/i.test(navigator.platform);
}

@Injectable()
export class TerminalStore {
	/** The panel is showing. */
	readonly open = signal(saved(OPEN_KEY) === '1');
	readonly height = signal(savedHeight());
	readonly tabs = signal<TermTab[]>([]);
	readonly active = signal<string | null>(null);
	/** A terminal is on its way: xterm is loading, or its tab is about to appear. */
	readonly starting = signal(false);

	private readonly _screens = new Map<string, Screen>();
	/** Native key -> tab id. */
	private readonly _byKey = new Map<string, string>();
	/** Events for a key nobody knows yet: output can beat the answer to `term_open`. */
	private _early: { key: string; apply: (screen: Screen, id: string) => void }[] = [];
	private _opening = 0;
	private _container: HTMLElement | null = null;
	private _listening: Promise<void> | null = null;
	private _seq = 0;

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
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
		this._screens.forEach((screen) => screen.term.blur());
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
		const container = this._container;
		const screen = this._screens.get(this.active() ?? '');
		if (!container || !screen || !container.clientWidth || !container.clientHeight) {
			return;
		}
		if (screen.host.parentNode !== container) {
			container.appendChild(screen.host);
		}
		if (!screen.opened) {
			adoptXtermStyles(container.getRootNode());
			screen.term.open(screen.host);
			screen.opened = true;
		}
		try {
			// Changes the terminal's size only when it differs; onResize then tells the shell.
			screen.fit.fit();
		} catch {
			/* nothing measurable yet; the next layout will do it */
		}
	}

	focus(): void {
		this.layout();
		this._screens.get(this.active() ?? '')?.term.focus();
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
			const xterm = await loadXterm();
			await (this._listening ??= this.listen());
			const cwd = repo.worktree || repo.path;
			id = `t${++this._seq}`;
			const screen = this.createScreen(xterm);
			this._screens.set(id, screen);
			this.tabs.set([...this.tabs(), { id, title: this.titleFor(cwd), cwd, ended: false }]);
			this.starting.set(false);
			this.select(id);

			// The shell starts at the size the panel has, so its first prompt is not drawn for 80 columns and then redrawn.
			const size = { cols: screen.term.cols, rows: screen.term.rows };
			this._opening++;
			let key: string;
			try {
				key = await this.backend.termOpen(repo.id, size.cols, size.rows);
			} finally {
				this._opening--;
			}
			if (this._screens.get(id) !== screen) {
				// Closed while the shell was starting.
				void this.backend.termClose(key).catch(() => undefined);
			} else {
				screen.key = key;
				this._byKey.set(key, id);
				const tabId = id;
				this._early.filter((e) => e.key === key).forEach((e) => e.apply(screen, tabId));
				if (screen.term.cols !== size.cols || screen.term.rows !== size.rows) {
					void this.backend.termResize(key, screen.term.cols, screen.term.rows).catch(() => undefined);
				}
				void this.flush(screen);
			}
			this._early = this._opening ? this._early.filter((e) => e.key !== key) : [];
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
		if (!this._screens.has(id)) {
			return;
		}
		this.active.set(id);
		this._screens.forEach((screen, key) => (screen.host.hidden = key !== id));
		this.focus();
	}

	/** Close a terminal and end its shell. */
	close(id: string): void {
		const key = this._screens.get(id)?.key;
		this.remove(id);
		if (key) {
			void this.backend.termClose(key).catch(() => undefined);
		}
	}

	private remove(id: string): void {
		const screen = this._screens.get(id);
		if (!screen) {
			return;
		}
		this._screens.delete(id);
		if (screen.key) {
			this._byKey.delete(screen.key);
		}
		screen.term.dispose();
		screen.host.remove();
		const tabs = this.tabs();
		const at = tabs.findIndex((t) => t.id === id);
		const left = tabs.filter((t) => t.id !== id);
		this.tabs.set(left);
		if (this.active() === id) {
			const next = left[Math.min(at, left.length - 1)] ?? null;
			this.active.set(next?.id ?? null);
			if (next && this.open()) {
				this.select(next.id);
			}
		}
		if (!left.length) {
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

	private createScreen(xterm: XtermApi): Screen {
		const term = new xterm.Terminal({
			fontFamily: termFont(),
			fontSize: 12,
			theme: xtermTheme(),
			cursorBlink: true,
			scrollback: 5000,
			// Programs pick their own colours; this keeps them readable on either theme.
			minimumContrastRatio: 4.5,
		});
		const fit = new xterm.FitAddon();
		term.loadAddon(fit);
		// Addresses in the output open in the browser on Cmd+click (Ctrl+click off the Mac), like VS Code:
		// a plain click stays free for selecting text. Output is untrusted, so only http(s) is opened.
		term.loadAddon(
			new xterm.WebLinksAddon((event, uri) => {
				if (!(isMac() ? event.metaKey : event.ctrlKey) || !/^https?:\/\//i.test(uri)) {
					return;
				}
				event.preventDefault();
				void this.backend.openUrl(uri).catch(() => undefined);
			}),
		);
		const host = document.createElement('div');
		host.className = 'screen';
		const screen: Screen = { term, fit, host, key: null, opened: false, ended: false, started: Date.now(), outbox: '', sending: false };

		term.onData((data) => {
			if (!screen.ended) {
				screen.outbox += data;
				void this.flush(screen);
			}
		});
		term.onResize(({ cols, rows }) => {
			if (screen.key && !screen.ended) {
				void this.backend.termResize(screen.key, cols, rows).catch(() => undefined);
			}
		});
		// Off the Mac, Ctrl+C and Ctrl+V belong to the shell, so copy and paste are Ctrl+Shift+C / Ctrl+Shift+V
		// as in other terminals. Windows also gets its own habits: Ctrl+V pastes, Ctrl+C copies when text is selected.
		term.attachCustomKeyEventHandler((e) => {
			if (e.type !== 'keydown' || isMac() || !e.ctrlKey || e.altKey || e.metaKey) {
				return true;
			}
			const key = e.key.toLowerCase();
			if (key === 'c' && term.hasSelection() && (e.shiftKey || isWindows())) {
				e.preventDefault();
				void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined);
				term.clearSelection();
				return false;
			}
			// Not handled here: the browser pastes into xterm's input, and xterm takes it from there.
			return !(key === 'v' && (e.shiftKey || isWindows()));
		});
		return screen;
	}

	/** Send what was typed, one write at a time so nothing overtakes anything. */
	private async flush(screen: Screen): Promise<void> {
		if (screen.sending || !screen.key) {
			return;
		}
		screen.sending = true;
		try {
			while (screen.outbox && !screen.ended) {
				const data = screen.outbox;
				screen.outbox = '';
				await this.backend.termWrite(screen.key, data);
			}
		} catch {
			// The shell is gone; `term-exit` says so.
			screen.outbox = '';
		} finally {
			screen.sending = false;
		}
	}

	// ---- events from the native side ----------------------------------------

	private async listen(): Promise<void> {
		await this.backend.listen<TermData>('term-data', (e) => this.receive(e.key, (screen) => screen.term.write(decode(e.data))));
		await this.backend.listen<TermExit>('term-exit', (e) => this.receive(e.key, (screen, id) => this.ended(id, screen, e.code)));
		// xterm wants real colours, so the theme is resolved again whenever the app switches light/dark.
		new MutationObserver(() => {
			const theme = xtermTheme();
			this._screens.forEach((screen) => (screen.term.options.theme = theme));
		}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
	}

	private receive(key: string, apply: (screen: Screen, id: string) => void): void {
		const id = this._byKey.get(key);
		const screen = id ? this._screens.get(id) : undefined;
		if (id && screen) {
			apply(screen, id);
		} else if (this._opening) {
			this._early.push({ key, apply });
		}
	}

	private ended(id: string, screen: Screen, code: number | null): void {
		if (!code || Date.now() - screen.started > FAILED_START_MS) {
			this.remove(id);
			return;
		}
		screen.ended = true;
		screen.term.write(`\r\n\x1b[2m[The shell ended with exit code ${code}]\x1b[0m\r\n`);
		this.tabs.set(this.tabs().map((t) => (t.id === id ? { ...t, ended: true } : t)));
	}
}

/** For templates outside the terminal panel (the toolbar button). */
export function terminals(): TerminalStore {
	return Injector.get(TerminalStore);
}
