import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, world, type World } from '../test/world';
import type { BackendService } from './backend.service';
import type { RepoStore } from './repo.store';
import type { ProgramTab, TerminalStore } from './terminal.store';

// xterm.js needs a real page to measure in. A stand-in that keeps what was written to it and lets a test
// type into it, so the pool is tested and the terminal emulator is not.
const xterm = vi.hoisted(() => {
	interface Key {
		type: string;
		key: string;
		shiftKey?: boolean;
		ctrlKey?: boolean;
		altKey?: boolean;
		metaKey?: boolean;
		preventDefault(): void;
	}
	class FakeTerminal {
		cols = 80;
		rows = 24;
		options: Record<string, unknown>;
		/** What was written to the screen, in order. */
		written: (string | Uint8Array)[] = [];
		host: HTMLElement | null = null;
		focused = false;
		disposed = false;
		selected = '';
		/** The handler the pool gave for keys: false means xterm leaves the key alone. */
		keys: (e: Key) => boolean = () => true;
		private _data: ((data: string) => void)[] = [];
		private _resize: ((size: { cols: number; rows: number }) => void)[] = [];
		constructor(options: Record<string, unknown> = {}) {
			this.options = { ...options };
			terms.push(this);
		}
		loadAddon(): void {}
		onData(fn: (data: string) => void): void {
			this._data.push(fn);
		}
		onResize(fn: (size: { cols: number; rows: number }) => void): void {
			this._resize.push(fn);
		}
		attachCustomKeyEventHandler(fn: (e: Key) => boolean): void {
			this.keys = fn;
		}
		open(host: HTMLElement): void {
			this.host = host;
		}
		write(data: string | Uint8Array): void {
			this.written.push(data);
		}
		/** As xterm does for a key or a paste: it goes to the program. */
		input(data: string): void {
			this._data.forEach((fn) => fn(data));
		}
		paste(data: string): void {
			this.input(data);
		}
		resize(cols: number, rows: number): void {
			this.cols = cols;
			this.rows = rows;
			this._resize.forEach((fn) => fn({ cols, rows }));
		}
		focus(): void {
			this.focused = true;
		}
		blur(): void {
			this.focused = false;
		}
		dispose(): void {
			this.disposed = true;
		}
		getSelection(): string {
			return this.selected;
		}
		hasSelection(): boolean {
			return !!this.selected;
		}
		clearSelection(): void {
			this.selected = '';
		}
		/** The screen's text so far. */
		text(): string {
			const decoder = new TextDecoder();
			return this.written.map((d) => (typeof d === 'string' ? d : decoder.decode(d, { stream: true }))).join('');
		}
	}
	const terms: FakeTerminal[] = [];
	return { terms, FakeTerminal };
});

vi.mock('../shared/xterm', () => ({
	loadXterm: async () => ({ Terminal: xterm.FakeTerminal, FitAddon: class { fit(): void {} }, WebLinksAddon: class {} }),
	adoptXtermStyles: () => undefined,
	xtermTheme: () => ({ background: document.documentElement.getAttribute('data-theme') === 'dark' ? '#000000' : '#ffffff' }),
}));


let w: World;
let repos: RepoStore;
let terms: TerminalStore;
let backend: BackendService;

const HARMONY = '/Users/demo/Source/harmony';
const CADENCE = '/Users/demo/Source/cadence';
const OPEN_KEY = 'studio.terminal.open';
const OPENS_KEY = 'studio.terminal.opens';
const HEIGHT_KEY = 'studio.terminal.height';

/** Base64 of the bytes, as the native side sends terminal output. */
function b64(text: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** An element with a size, as the panel has on screen. */
function box(): HTMLElement {
	const el = document.createElement('div');
	Object.defineProperty(el, 'clientWidth', { value: 800, configurable: true });
	Object.defineProperty(el, 'clientHeight', { value: 280, configurable: true });
	document.body.append(el);
	return el;
}

/** Lets promises, frames and timers up to `ms` from now run. */
async function tick(ms = 20): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

/** The app started over, with `storage` as the last session left it. Shells get the keys k1, k2, ... */
async function start(storage: Record<string, string> = {}): Promise<void> {
	xterm.terms.length = 0;
	w = await world();
	for (const [key, value] of Object.entries(storage)) {
		localStorage.setItem(key, value);
	}
	let n = 0;
	w.on('term_open', () => `k${++n}`);
	w.on('term_write', () => undefined);
	w.on('term_resize', () => undefined);
	w.on('term_close', () => undefined);
	backend = w.get((await import('./backend.service')).BackendService);
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	terms = w.get((await import('./terminal.store')).TerminalStore);
}

/** A program Studio starts in a tab of the panel, known to the native side as `key`. */
async function program(over: Partial<ProgramTab> = {}, key = 'p1'): Promise<string> {
	const adding = terms.addProgram({ repoId: HARMONY, title: 'dev', cwd: HARMONY, kind: 'run', reveal: true, open: async () => ({ key }), ...over });
	// So a failure is the caller's to look at, not an unhandled one while the frame is waited for.
	adding.catch(() => undefined);
	await tick();
	return adding;
}

beforeEach(async () => {
	vi.useFakeTimers();
	await start();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the panel, open or closed', () => {
	test('it starts closed', () => {
		expect(terms.open()).toBe(false);
		expect(terms.tabs()).toEqual([]);
		expect(terms.active()).toBeNull();
	});

	test('a repository with no state of its own starts with the old shared one', async () => {
		await start({ [OPEN_KEY]: '1' });
		expect(terms.open()).toBe(true);
		await repos.selectRepo(CADENCE);
		expect(terms.open()).toBe(true);
	});

	test('each repository keeps its own', async () => {
		await start({ [OPEN_KEY]: '1', [OPENS_KEY]: JSON.stringify({ [HARMONY]: false }) });
		expect(terms.open()).toBe(false);
		await repos.selectRepo(CADENCE);
		expect(terms.open()).toBe(true);
	});

	test('closing it in one repository leaves the others as they were and is remembered', async () => {
		await start({ [OPEN_KEY]: '1' });
		terms.hide();
		expect(terms.open()).toBe(false);
		expect(JSON.parse(localStorage.getItem(OPENS_KEY)!)).toEqual({ [HARMONY]: false });
		// The old shared value is not rewritten: it is only where a repository starts.
		expect(localStorage.getItem(OPEN_KEY)).toBe('1');
		await repos.selectRepo(CADENCE);
		expect(terms.open()).toBe(true);
		await repos.selectRepo(HARMONY);
		expect(terms.open()).toBe(false);
	});

	test('damaged saved state is ignored', async () => {
		await start({ [OPEN_KEY]: '1', [OPENS_KEY]: '{not json' });
		expect(terms.open()).toBe(true);
		await start({ [OPENS_KEY]: JSON.stringify({ [HARMONY]: 'yes', [CADENCE]: true }) });
		expect(terms.open()).toBe(false);
		await repos.selectRepo(CADENCE);
		expect(terms.open()).toBe(true);
	});

	test('showing it with no terminal starts one', async () => {
		terms.reveal();
		await tick();
		expect(terms.open()).toBe(true);
		expect(terms.tabs().length).toBe(1);
		expect(w.sent('term_open').length).toBe(1);
	});

	test('showing it again starts no second terminal', async () => {
		terms.reveal();
		await tick();
		terms.hide();
		terms.reveal();
		await tick();
		expect(terms.open()).toBe(true);
		expect(w.sent('term_open').length).toBe(1);
	});

	test('toggle hides it and the shells keep running', async () => {
		await terms.add();
		terms.toggle();
		expect(terms.open()).toBe(false);
		expect(terms.tabs().length).toBe(1);
		expect(w.sent('term_close')).toEqual([]);
		terms.toggle();
		await tick();
		expect(terms.open()).toBe(true);
		expect(w.sent('term_open').length).toBe(1);
	});

	test('a hidden terminal lets go of the keyboard', async () => {
		terms.attach(box());
		await terms.add();
		expect(xterm.terms[0].focused).toBe(true);
		terms.hide();
		expect(xterm.terms[0].focused).toBe(false);
	});

	test('the panel coming into the page starts a terminal when it is open and has none', async () => {
		await start({ [OPEN_KEY]: '1' });
		terms.attach(box());
		await tick();
		expect(terms.tabs().length).toBe(1);
		expect(w.sent('term_open').length).toBe(1);
	});

	test('the panel coming into the page while closed starts nothing', async () => {
		terms.attach(box());
		await tick();
		expect(terms.tabs()).toEqual([]);
		expect(w.sent('term_open')).toEqual([]);
	});

	test('a rebuilt panel gets the running terminal back, without a new shell', async () => {
		const first = box();
		terms.attach(first);
		await terms.add();
		w.emit('term-data', { key: 'k1', data: b64('scrollback') });
		terms.detach(first);
		const second = box();
		terms.attach(second);
		await tick();
		expect(second.querySelector('.screen')).toBe(xterm.terms[0].host);
		expect(xterm.terms[0].text()).toBe('scrollback');
		expect(w.sent('term_open').length).toBe(1);
		expect(xterm.terms.length).toBe(1);
	});
});

describe('the panel\'s height', () => {
	const tallest = (): number => window.innerHeight - 180;

	test('starts at the default and is shared by every repository', async () => {
		expect(terms.height()).toBe(280);
		terms.setHeight(333);
		await repos.selectRepo(CADENCE);
		expect(terms.height()).toBe(333);
	});

	test('a saved height comes back', async () => {
		await start({ [HEIGHT_KEY]: '400' });
		expect(terms.height()).toBe(400);
	});

	test('a saved height that is too small or not a number is the default', async () => {
		await start({ [HEIGHT_KEY]: '40' });
		expect(terms.height()).toBe(280);
		await start({ [HEIGHT_KEY]: 'tall' });
		expect(terms.height()).toBe(280);
	});

	test('a saved height taller than the window leaves the main pane showing', async () => {
		await start({ [HEIGHT_KEY]: '5000' });
		expect(terms.height()).toBe(tallest());
	});

	test('dragging stays between the smallest panel and what the window allows', () => {
		terms.setHeight(10);
		expect(terms.height()).toBe(120);
		terms.setHeight(99_999);
		expect(terms.height()).toBe(tallest());
		terms.setHeight(301.6);
		expect(terms.height()).toBe(302);
	});

	test('the height is saved when the drag ends, not while dragging', () => {
		terms.setHeight(350);
		expect(localStorage.getItem(HEIGHT_KEY)).toBeNull();
		terms.saveHeight();
		expect(localStorage.getItem(HEIGHT_KEY)).toBe('350');
	});

	test('reset goes back to the default and forgets the saved one', () => {
		terms.setHeight(350);
		terms.saveHeight();
		terms.resetHeight();
		expect(terms.height()).toBe(280);
		expect(localStorage.getItem(HEIGHT_KEY)).toBeNull();
	});
});

describe('a new terminal', () => {
	test('starts the user\'s shell in the open repository and shows the panel', async () => {
		await terms.add();
		expect(w.sent('term_open').map((c) => c.args)).toEqual([{ id: HARMONY, cols: 80, rows: 24, at: null }]);
		expect(terms.tabs()).toMatchObject([{ repoId: HARMONY, title: 'harmony', cwd: HARMONY, ended: false, kind: 'shell' }]);
		expect(terms.active()).toBe(terms.tabs()[0].id);
		expect(terms.open()).toBe(true);
		expect(terms.starting()).toBe(false);
	});

	test('a second one in the same folder is numbered', async () => {
		await terms.add();
		await terms.add();
		await terms.add();
		expect(terms.tabs().map((t) => t.title)).toEqual(['harmony', 'harmony 2', 'harmony 3']);
		expect(terms.active()).toBe(terms.tabs()[2].id);
	});

	test('a folder inside the repository is where it starts, and its name is the title', async () => {
		await terms.add('packages/web');
		expect(w.sent('term_open')[0].args).toMatchObject({ id: HARMONY, at: 'packages/web' });
		expect(terms.tabs()[0]).toMatchObject({ title: 'web', cwd: `${HARMONY}/packages/web` });
	});

	test('text for its command line is typed in and not run', async () => {
		await terms.add(null, 'npm test');
		await tick();
		expect(w.sent('term_write').map((c) => c.args)).toEqual([{ key: 'k1', data: 'npm test' }]);
	});

	test('it follows a worktree switch, and the ones already open stay where they are', async () => {
		await terms.add();
		const tree = await backend.addWorktree(HARMONY, 'agent/shuffle', null);
		await backend.selectWorktree(HARMONY, tree);
		await repos.switchContext();
		await terms.add();
		expect(terms.tabs().map((t) => t.cwd)).toEqual([HARMONY, tree]);
		expect(terms.tabs()[1].title).toBe('agent-shuffle');
	});

	test('asking twice at once starts one', async () => {
		const both = [terms.add(), terms.add()];
		expect(terms.starting()).toBe(true);
		await Promise.all(both);
		expect(w.sent('term_open').length).toBe(1);
		expect(terms.tabs().length).toBe(1);
	});

	test('a shell that cannot start leaves no tab, says why, and the panel closes', async () => {
		w.on('term_open', () => { throw appError('error', 'no pty for you'); });
		await terms.add();
		expect(terms.all()).toEqual([]);
		expect(terms.starting()).toBe(false);
		expect(terms.open()).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'no pty for you' });
		expect(xterm.terms[0].disposed).toBe(true);
	});

	test('with no repository open there is nothing to start', async () => {
		w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: '', authorEmail: '', appVersion: '0' }));
		await repos.switchContext();
		await terms.add();
		expect(w.sent('term_open')).toEqual([]);
		expect(terms.all()).toEqual([]);
	});
});

describe('output and keys', () => {
	test('output that arrives before the open call has answered is held until the key is known', async () => {
		w.on('term_open', () => {
			w.emit('term-data', { key: 'early-key', data: b64('Last login: today\r\n') });
			return 'early-key';
		});
		await terms.add();
		w.emit('term-data', { key: 'early-key', data: b64('$ ') });
		expect(xterm.terms[0].text()).toBe('Last login: today\r\n$ ');
	});

	test('each terminal gets its own output', async () => {
		await terms.add();
		await terms.add();
		w.emit('term-data', { key: 'k2', data: b64('second') });
		w.emit('term-data', { key: 'k1', data: b64('first') });
		expect(xterm.terms.map((t) => t.text())).toEqual(['first', 'second']);
	});

	test('keys are sent one write at a time, in the order they were typed', async () => {
		await terms.add();
		const waiting: (() => void)[] = [];
		w.on('term_write', () => new Promise<void>((resolve) => waiting.push(resolve)));
		const term = xterm.terms[0];
		term.input('g');
		await tick();
		term.input('i');
		term.input('t');
		await tick();
		expect(w.sent('term_write').map((c) => c.args.data)).toEqual(['g']);
		waiting.shift()!();
		await tick();
		expect(w.sent('term_write').map((c) => c.args)).toEqual([{ key: 'k1', data: 'g' }, { key: 'k1', data: 'it' }]);
	});

	test('the selection is the active terminal\'s', async () => {
		expect(terms.selection()).toBe('');
		await terms.add();
		await terms.add();
		xterm.terms[0].selected = 'one';
		xterm.terms[1].selected = 'two';
		expect(terms.selection()).toBe('two');
		terms.select(terms.tabs()[0].id);
		expect(terms.selection()).toBe('one');
	});
});

describe('tabs', () => {
	test('selecting a tab shows its screen and hides the other', async () => {
		const panel = box();
		terms.attach(panel);
		await terms.add();
		await terms.add();
		const [a, b] = terms.tabs();
		expect(terms.active()).toBe(b.id);
		terms.select(a.id);
		expect(terms.active()).toBe(a.id);
		expect(xterm.terms[0].host!.hidden).toBe(false);
		expect(xterm.terms[1].host!.hidden).toBe(true);
		expect(xterm.terms[0].focused).toBe(true);
	});

	test('selecting a tab that is not there changes nothing', async () => {
		await terms.add();
		const active = terms.active();
		terms.select('nope');
		expect(terms.active()).toBe(active);
	});

	test('closing a terminal ends its shell', async () => {
		await terms.add();
		await terms.add();
		terms.close(terms.tabs()[0].id);
		await tick();
		expect(w.sent('term_close').map((c) => c.args)).toEqual([{ key: 'k1' }]);
		expect(terms.tabs().map((t) => t.title)).toEqual(['harmony 2']);
	});

	test('closing the active tab moves to the one that takes its place, else the one before', async () => {
		await terms.add();
		await terms.add();
		await terms.add();
		const [a, b, c] = terms.tabs();
		terms.select(a.id);
		terms.close(a.id);
		expect(terms.active()).toBe(b.id);
		terms.select(c.id);
		terms.close(c.id);
		expect(terms.active()).toBe(b.id);
	});

	test('closing another tab leaves the active one', async () => {
		await terms.add();
		await terms.add();
		const [a, b] = terms.tabs();
		terms.close(a.id);
		expect(terms.active()).toBe(b.id);
	});

	test('closing the last terminal closes the panel', async () => {
		await terms.add();
		terms.close(terms.tabs()[0].id);
		expect(terms.tabs()).toEqual([]);
		expect(terms.active()).toBeNull();
		expect(terms.open()).toBe(false);
	});
});

describe('a shell ending', () => {
	test('a shell that exits takes its tab along', async () => {
		await terms.add();
		w.emit('term-exit', { key: 'k1', code: 0 });
		expect(terms.tabs()).toEqual([]);
		expect(terms.open()).toBe(false);
		expect(xterm.terms[0].disposed).toBe(true);
	});

	test('a shell that fails right after starting keeps its tab to say why', async () => {
		await terms.add();
		await tick(1000);
		w.emit('term-exit', { key: 'k1', code: 127 });
		expect(terms.tabs()).toMatchObject([{ ended: true, kind: 'shell' }]);
		expect(xterm.terms[0].text()).toContain('exit code 127');
		expect(terms.open()).toBe(true);
	});

	test('a shell that ran a while and ends with an error is closed like any other', async () => {
		await terms.add();
		await tick(3001);
		w.emit('term-exit', { key: 'k1', code: 1 });
		expect(terms.tabs()).toEqual([]);
	});

	test('an exit with no code reported closes the tab', async () => {
		await terms.add();
		w.emit('term-exit', { key: 'k1', code: null });
		expect(terms.tabs()).toEqual([]);
	});

	test('an exit for another terminal\'s key leaves this one alone', async () => {
		await terms.add();
		await terms.add();
		w.emit('term-exit', { key: 'k2', code: 0 });
		expect(terms.tabs().map((t) => t.title)).toEqual(['harmony']);
		expect(terms.active()).toBe(terms.tabs()[0].id);
	});
});

describe('one set of terminals per repository', () => {
	test('another repository has its own tabs, and the first one\'s keep running out of sight', async () => {
		await terms.add();
		const mine = terms.tabs()[0];
		await repos.selectRepo(CADENCE);
		expect(terms.tabs()).toEqual([]);
		expect(terms.active()).toBeNull();
		expect(terms.all()).toEqual([mine]);
		expect(w.sent('term_close')).toEqual([]);
		await terms.add();
		expect(w.sent('term_open').at(-1)!.args.id).toBe(CADENCE);
		expect(terms.tabs()).toMatchObject([{ repoId: CADENCE, title: 'cadence' }]);
		expect(terms.all().length).toBe(2);
	});

	test('each repository remembers which of its terminals was selected', async () => {
		await terms.add();
		await terms.add();
		const first = terms.tabs()[0].id;
		terms.select(first);
		await repos.selectRepo(CADENCE);
		await terms.add();
		const theirs = terms.active();
		await repos.selectRepo(HARMONY);
		expect(terms.active()).toBe(first);
		await repos.selectRepo(CADENCE);
		expect(terms.active()).toBe(theirs);
	});

	test('titles are numbered within a repository, not across them', async () => {
		await terms.add();
		await repos.selectRepo(CADENCE);
		await terms.add();
		await terms.add();
		expect(terms.all().map((t) => t.title)).toEqual(['harmony', 'cadence', 'cadence 2']);
	});

	test('the other repository\'s screens stay in the panel, hidden', async () => {
		const panel = box();
		terms.attach(panel);
		await terms.add();
		await repos.selectRepo(CADENCE);
		terms.layout();
		expect(xterm.terms[0].host!.hidden).toBe(true);
		expect(panel.contains(xterm.terms[0].host)).toBe(true);
		await repos.selectRepo(HARMONY);
		terms.layout();
		expect(xterm.terms[0].host!.hidden).toBe(false);
	});

	test('a terminal ending in a repository that is not on screen does not close this one\'s panel', async () => {
		await terms.add();
		await repos.selectRepo(CADENCE);
		await terms.add();
		expect(terms.open()).toBe(true);
		w.emit('term-exit', { key: 'k1', code: 0 });
		expect(terms.all().map((t) => t.repoId)).toEqual([CADENCE]);
		expect(terms.open()).toBe(true);
		await repos.selectRepo(HARMONY);
		expect(terms.tabs()).toEqual([]);
	});
});

describe('a program Studio starts', () => {
	test('is a tab of its kind, selected, with the panel open', async () => {
		const open = vi.fn(async () => ({ key: 'p1', command: 'npm run dev' }));
		const id = await program({ title: 'web · dev', open });
		expect(terms.tabs()).toEqual([{ id, repoId: HARMONY, title: 'web · dev', cwd: HARMONY, ended: false, kind: 'run', command: 'npm run dev' }]);
		expect(terms.active()).toBe(id);
		expect(terms.open()).toBe(true);
		expect(open).toHaveBeenCalledTimes(1);
		expect(open).toHaveBeenCalledWith(80, 24);
	});

	test('an investigation\'s copy of the app is a tab of its own kind', async () => {
		await program({ kind: 'investigation' });
		expect(terms.tabs()[0].kind).toBe('investigation');
	});

	test('the tab stays when the program ends, with how it ended on its screen', async () => {
		const exit = vi.fn();
		const id = await program({ exit });
		w.emit('term-data', { key: 'p1', data: b64('Server crashed\r\n') });
		w.emit('term-exit', { key: 'p1', code: 1 });
		expect(terms.tabs()).toMatchObject([{ id, ended: true }]);
		expect(exit).toHaveBeenCalledWith(1);
		expect(xterm.terms[0].text()).toContain('Server crashed');
		expect(xterm.terms[0].text()).toContain('[Ended with exit code 1]');
		expect(terms.open()).toBe(true);
	});

	test('it stays after a clean exit too, long after it started', async () => {
		const id = await program();
		await tick(60_000);
		w.emit('term-exit', { key: 'p1', code: 0 });
		expect(terms.tabs()).toMatchObject([{ id, ended: true }]);
		expect(xterm.terms[0].text()).toContain('[Ended with exit code 0]');
	});

	test('a program that was stopped says so instead of a code', async () => {
		const exit = vi.fn();
		await program({ exit });
		w.emit('term-exit', { key: 'p1', code: null });
		expect(xterm.terms[0].text()).toContain('[Stopped]');
		expect(exit).toHaveBeenCalledWith(null);
	});

	test('stop ends the program and keeps the tab', async () => {
		const id = await program();
		terms.stop(id);
		await tick();
		expect(w.sent('term_close').map((c) => c.args)).toEqual([{ key: 'p1' }]);
		expect(terms.tabs().map((t) => t.id)).toEqual([id]);
	});

	test('what it prints is handed on as text', async () => {
		const heard: string[] = [];
		await program({ output: (text) => heard.push(text) });
		w.emit('term-data', { key: 'p1', data: b64('ready in 312 ms\r\n') });
		expect(heard).toEqual(['ready in 312 ms\r\n']);
	});

	test('a program that cannot start leaves no tab and the failure is the caller\'s', async () => {
		const failed = appError('error', 'That run target is no longer in this checkout');
		await expect(program({ open: async () => { throw failed; } })).rejects.toBe(failed);
		expect(terms.all()).toEqual([]);
		expect(w.toasts).toEqual([]);
	});

	test('one that is not to be shown leaves the panel closed', async () => {
		const id = await program({ reveal: false });
		expect(terms.open()).toBe(false);
		expect(terms.tabs().map((t) => t.id)).toEqual([id]);
		expect(terms.active()).toBe(id);
	});

	test('one that is not to be shown does not take the selection from a terminal', async () => {
		await terms.add();
		const shell = terms.active();
		await program({ reveal: false });
		expect(terms.tabs().length).toBe(2);
		expect(terms.active()).toBe(shell);
	});

	test('one for a repository that is not on screen does not open this panel', async () => {
		const id = await program({ repoId: CADENCE, cwd: CADENCE });
		expect(terms.open()).toBe(false);
		expect(terms.tabs()).toEqual([]);
		expect(terms.all().map((t) => t.id)).toEqual([id]);
		await repos.selectRepo(CADENCE);
		expect(terms.tabs().map((t) => t.id)).toEqual([id]);
		expect(terms.active()).toBe(id);
	});

	test('closing its tab ends it', async () => {
		const id = await program();
		terms.close(id);
		await tick();
		expect(w.sent('term_close').map((c) => c.args)).toEqual([{ key: 'p1' }]);
		expect(terms.all()).toEqual([]);
	});
});

describe('names', () => {
	test('a folder\'s name is the last part of its path, however it is spelled', async () => {
		const { folderName } = await import('./terminal.store');
		expect(folderName('/Users/me/Source/harmony')).toBe('harmony');
		expect(folderName('/Users/me/Source/harmony/')).toBe('harmony');
		expect(folderName('C:\\Users\\me\\harmony')).toBe('harmony');
		expect(folderName('harmony')).toBe('harmony');
	});
});
