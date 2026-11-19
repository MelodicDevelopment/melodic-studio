/**
 * Every terminal screen in the app, whatever runs in it (a shell in the bottom
 * panel, a shell or a Claude conversation in the workspace): its xterm.js
 * `Terminal`, the element it draws into, and the native pty behind it. The
 * screens live here, not in components, so a program keeps running (and keeps
 * its scrollback) while its view is hidden, moved to another pane, or rebuilt.
 *
 * A screen is created first and started once it has a size: the program is
 * then started at the size it will be shown at, so its first screen is not
 * drawn for 80 columns and redrawn.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { BackendService, isMac } from './backend.service';
import { adoptXtermStyles, loadXterm, xtermTheme } from '../shared/xterm';
import { effect } from '@melodicdev/core/signals';
import { EditorSettingsStore } from './editor-settings.store';

interface TermData {
	key: string;
	/** Base64 of raw bytes: a read can end in the middle of a UTF-8 character. */
	data: string;
}
interface TermExit {
	key: string;
	code: number | null;
}

export interface ScreenEvents {
	/** The program ended. `code` is null when the system did not report one. */
	exit(code: number | null, ranFor: number): void;
	/** Something was typed or pasted (before it is sent). */
	input?(data: string): void;
	/** What the program printed, as text (escape sequences and all), in the order it arrived. */
	output?(text: string): void;
}

interface Screen {
	term: Terminal;
	fit: FitAddon;
	/** What xterm draws into. Moves into whichever view shows the screen. */
	host: HTMLDivElement;
	/** The native side's name for the pty; null until it has started. */
	key: string | null;
	/** `term.open()` has run; it needs a host that is on screen. */
	opened: boolean;
	ended: boolean;
	started: number;
	/** Keystrokes not sent yet. One write at a time keeps them in order. */
	outbox: string;
	sending: boolean;
	events: ScreenEvents;
	/** For `events.output`: a read can end in the middle of a character, so the decoding carries over. */
	decoder: TextDecoder | null;
}

function decode(data: string): Uint8Array {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

function isWindows(): boolean {
	return typeof navigator !== 'undefined' && /Win/i.test(navigator.platform);
}

/**
 * Lines a terminal keeps above the screen. Every line is held at the terminal's full width whatever
 * it says, so this is what a terminal costs: measured at 10,000 lines, three terminals with long
 * output added 180 MB to the web view (docs/daily-driver.md, step 5).
 */
const SCROLLBACK = 5000;

@Injectable()
export class ScreenPool {
	private readonly _screens = new Map<string, Screen>();
	/** Native key -> screen id. */
	private readonly _byKey = new Map<string, string>();
	/** Events for a key nobody knows yet: output can beat the answer to the open call. */
	private _early: { key: string; apply: (screen: Screen, id: string) => void }[] = [];
	private _opening = 0;
	private _listening: Promise<void> | null = null;
	private _seq = 0;

	private get settings(): EditorSettingsStore {
		return Injector.get(EditorSettingsStore);
	}
	private get backend(): BackendService {
		return Injector.get(BackendService);
	}

	has(id: string): boolean {
		return this._screens.has(id);
	}

	/** Whether the program has been started (and may still be running). */
	started(id: string): boolean {
		return !!this._screens.get(id)?.key;
	}

	ended(id: string): boolean {
		return this._screens.get(id)?.ended ?? true;
	}

	/** A new screen with nothing running in it yet. */
	async create(events: ScreenEvents): Promise<string> {
		const xterm = await loadXterm();
		await (this._listening ??= this.listen());
		const id = `s${++this._seq}`;
		const term = new xterm.Terminal({
			fontFamily: this.settings.font(),
			fontSize: this.settings.settings().terminalFontSize,
			theme: xtermTheme(),
			cursorBlink: true,
			scrollback: SCROLLBACK,
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
		const screen: Screen = { term, fit, host, key: null, opened: false, ended: false, started: Date.now(), outbox: '', sending: false, events, decoder: events.output ? new TextDecoder() : null };

		term.onData((data) => {
			if (!screen.ended) {
				screen.events.input?.(data);
				screen.outbox += data;
				void this.flush(screen);
			}
		});
		term.onResize(({ cols, rows }) => {
			if (screen.key && !screen.ended) {
				void this.backend.termResize(screen.key, cols, rows).catch(() => undefined);
			}
		});
		term.attachCustomKeyEventHandler((e) => {
			// xterm sends a bare CR for Shift+Return too, so Claude Code cannot tell it from Return. ESC+CR is what
			// VS Code sends after Claude's /terminal-setup: a new line in Claude, Alt+Return (usually nothing) elsewhere.
			if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
				if (e.type === 'keydown') {
					e.preventDefault();
					term.input('\x1b\r');
				}
				return false;
			}
			// Off the Mac, Ctrl+C and Ctrl+V belong to the program, so copy and paste are Ctrl+Shift+C / Ctrl+Shift+V
			// as in other terminals. Windows also gets its own habits: Ctrl+V pastes, Ctrl+C copies when text is selected.
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
		this._screens.set(id, screen);
		return id;
	}

	/**
	 * Start the program behind screen `id`. `open` gets the screen's size and
	 * answers the native key (`termOpen`, `claudeOpen`). Call after `show`, so the
	 * size is the real one. Throws what `open` throws.
	 */
	async start(id: string, open: (cols: number, rows: number) => Promise<string>): Promise<void> {
		const screen = this._screens.get(id);
		if (!screen || screen.key) {
			return;
		}
		screen.ended = false;
		screen.started = Date.now();
		const size = { cols: screen.term.cols, rows: screen.term.rows };
		this._opening++;
		let key: string;
		try {
			key = await open(size.cols, size.rows);
		} finally {
			this._opening--;
		}
		if (this._screens.get(id) !== screen) {
			// Closed while the program was starting.
			void this.backend.termClose(key).catch(() => undefined);
		} else {
			screen.key = key;
			this._byKey.set(key, id);
			this._early.filter((e) => e.key === key).forEach((e) => e.apply(screen, id));
			if (screen.term.cols !== size.cols || screen.term.rows !== size.rows) {
				void this.backend.termResize(key, screen.term.cols, screen.term.rows).catch(() => undefined);
			}
			void this.flush(screen);
		}
		this._early = this._opening ? this._early.filter((e) => e.key !== key) : [];
	}

	/**
	 * Show screen `id` in `container`, at the container's size, hiding any other
	 * screen in it. Safe to call whenever either may have changed; does nothing
	 * while the container is not on screen.
	 */
	show(id: string, container: HTMLElement): boolean {
		const screen = this._screens.get(id);
		if (!screen) {
			return false;
		}
		for (const child of Array.from(container.children)) {
			if (child instanceof HTMLElement && child.classList.contains('screen')) {
				child.hidden = child !== screen.host;
			}
		}
		if (screen.host.parentNode !== container) {
			container.appendChild(screen.host);
		}
		screen.host.hidden = false;
		if (!container.clientWidth || !container.clientHeight) {
			return false;
		}
		// Every time: a screen moves between shadow roots (panes, a rebuilt panel), and xterm's CSS (which also
		// hides its measuring text) has to be in whichever one shows it.
		adoptXtermStyles(container.getRootNode());
		if (!screen.opened) {
			screen.term.open(screen.host);
			screen.opened = true;
		}
		try {
			// Changes the terminal's size only when it differs; onResize then tells the program.
			screen.fit.fit();
		} catch {
			/* nothing measurable yet; the next call will do it */
		}
		return true;
	}

	/** Take screen `id` off whatever shows it (it keeps running). */
	hide(id: string): void {
		const screen = this._screens.get(id);
		if (screen) {
			screen.host.hidden = true;
			screen.term.blur();
		}
	}

	focus(id: string): void {
		const screen = this._screens.get(id);
		if (screen?.opened) {
			screen.term.focus();
		}
	}

	blur(id: string): void {
		this._screens.get(id)?.term.blur();
	}

	/** Text of ours on the screen (not sent to the program). */
	note(id: string, text: string): void {
		this._screens.get(id)?.term.write(`\r\n\x1b[2m${text}\x1b[0m\r\n`);
	}

	/** Send text to the program as if typed. */
	type(id: string, text: string): void {
		const screen = this._screens.get(id);
		if (screen && !screen.ended) {
			screen.outbox += text;
			void this.flush(screen);
		}
	}

	/** End the program but keep the screen, so what it printed can still be read. Its `exit` event follows. */
	stop(id: string): void {
		const screen = this._screens.get(id);
		if (screen?.key && !screen.ended) {
			void this.backend.termClose(screen.key).catch(() => undefined);
		}
	}

	/** The text selected on the screen, if any. */
	selection(id: string): string {
		return this._screens.get(id)?.term.getSelection() ?? '';
	}

	/** Ready to `start` again (after the program ended), keeping what is on screen. */
	reset(id: string): void {
		const screen = this._screens.get(id);
		if (screen?.key) {
			this._byKey.delete(screen.key);
			screen.key = null;
		}
	}

	/** Remove the screen and end its program. */
	close(id: string): void {
		const screen = this._screens.get(id);
		if (!screen) {
			return;
		}
		this._screens.delete(id);
		const key = screen.key;
		if (key) {
			this._byKey.delete(key);
			if (!screen.ended) {
				void this.backend.termClose(key).catch(() => undefined);
			}
		}
		screen.term.dispose();
		screen.host.remove();
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
			// The program is gone; `term-exit` says so.
			screen.outbox = '';
		} finally {
			screen.sending = false;
		}
	}

	private async listen(): Promise<void> {
		await this.backend.listen<TermData>('term-data', (e) =>
			this.receive(e.key, (screen) => {
				const bytes = decode(e.data);
				screen.term.write(bytes);
				if (screen.decoder) {
					screen.events.output?.(screen.decoder.decode(bytes, { stream: true }));
				}
			}),
		);
		await this.backend.listen<TermExit>('term-exit', (e) =>
			this.receive(e.key, (screen) => {
				screen.ended = true;
				screen.outbox = '';
				screen.events.exit(e.code, Date.now() - screen.started);
			}),
		);
		// Settings > Editor: the code font and the terminal's text size, on every screen at once.
		effect(() => {
			const size = this.settings.settings().terminalFontSize;
			const font = this.settings.font();
			this._screens.forEach((screen) => {
				if (screen.term.options.fontSize !== size || screen.term.options.fontFamily !== font) {
					screen.term.options.fontSize = size;
					screen.term.options.fontFamily = font;
					try {
						screen.fit.fit();
					} catch {
						/* not on screen */
					}
				}
			});
		});
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
}
