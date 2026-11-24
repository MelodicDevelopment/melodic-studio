import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../test/world';
import type { ScreenEvents, ScreenPool } from './screens';

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
let pool: ScreenPool;
const platform = Object.getOwnPropertyDescriptor(navigator, 'platform');

/** Base64 of the bytes, as the native side sends terminal output. */
function b64(bytes: Uint8Array | string): string {
	const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
	return btoa(String.fromCharCode(...data));
}

/** An element with a size, as a panel on screen has. */
function box(width = 800, height = 400): HTMLElement {
	const el = document.createElement('div');
	Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
	Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
	document.body.append(el);
	return el;
}

function on(name: string): void {
	Object.defineProperty(navigator, 'platform', { value: name, configurable: true });
}

/** What gets copied, instead of the system's clipboard. */
function clipboard(): string[] {
	const copied: string[] = [];
	vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text) => void copied.push(text));
	return copied;
}

function noEvents(): ScreenEvents {
	return { exit: () => undefined };
}

/** A screen with a program behind it, known to the native side as `key`. */
async function running(key: string, events: ScreenEvents = noEvents()): Promise<{ id: string; term: InstanceType<typeof xterm.FakeTerminal> }> {
	const id = await pool.create(events);
	await pool.start(id, async () => key);
	return { id, term: xterm.terms.at(-1)! };
}

function key(k: string, mods: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}, type = 'keydown'): { type: string; key: string; preventDefault(): void } {
	return { type, key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods, preventDefault: () => undefined };
}

beforeEach(async () => {
	xterm.terms.length = 0;
	w = await world();
	// The demo backend's pretend shell answers with output of its own: these tests say what arrives.
	w.on('term_write', () => undefined);
	w.on('term_resize', () => undefined);
	w.on('term_close', () => undefined);
	pool = w.get((await import('./screens')).ScreenPool);
});

afterEach(() => {
	vi.useRealTimers();
	document.documentElement.removeAttribute('data-theme');
	if (platform) {
		Object.defineProperty(navigator, 'platform', platform);
	} else {
		delete (navigator as { platform?: string }).platform;
	}
});

describe('a screen and its program', () => {
	test('a new screen has nothing running in it', async () => {
		const id = await pool.create(noEvents());
		expect(pool.has(id)).toBe(true);
		expect(pool.started(id)).toBe(false);
		expect(pool.ended(id)).toBe(false);
		expect(w.calls).toEqual([]);
	});

	test('every screen has an id of its own', async () => {
		const a = await pool.create(noEvents());
		const b = await pool.create(noEvents());
		expect(a).not.toBe(b);
		expect(xterm.terms.length).toBe(2);
	});

	test('a screen nobody made is neither there nor running', () => {
		expect(pool.has('nope')).toBe(false);
		expect(pool.started('nope')).toBe(false);
		expect(pool.ended('nope')).toBe(true);
		expect(pool.selection('nope')).toBe('');
		expect(pool.show('nope', box())).toBe(false);
	});

	test('the program is started at the size the screen has', async () => {
		const id = await pool.create(noEvents());
		xterm.terms[0].cols = 132;
		xterm.terms[0].rows = 43;
		const open = vi.fn(async () => 'k1');
		await pool.start(id, open);
		expect(open).toHaveBeenCalledWith(132, 43);
		expect(pool.started(id)).toBe(true);
	});

	test('starting a screen that already runs does not start a second program', async () => {
		const { id } = await running('k1');
		const again = vi.fn(async () => 'k2');
		await pool.start(id, again);
		expect(again).not.toHaveBeenCalled();
	});

	test('a start that fails throws what the open threw and leaves the screen to be started again', async () => {
		const id = await pool.create(noEvents());
		await expect(pool.start(id, async () => { throw appError('error', 'no shell'); })).rejects.toMatchObject({ message: 'no shell' });
		expect(pool.started(id)).toBe(false);
		await pool.start(id, async () => 'k1');
		expect(pool.started(id)).toBe(true);
	});

	test('a size that changed while the program was starting is told to it', async () => {
		const id = await pool.create(noEvents());
		await pool.start(id, async () => {
			xterm.terms[0].cols = 100;
			xterm.terms[0].rows = 30;
			return 'k1';
		});
		await settle();
		expect(w.sent('term_resize').map((c) => c.args)).toEqual([{ key: 'k1', cols: 100, rows: 30 }]);
	});

	test('a screen closed while its program was starting ends that program', async () => {
		const id = await pool.create(noEvents());
		let answer!: (key: string) => void;
		const starting = pool.start(id, () => new Promise<string>((resolve) => (answer = resolve)));
		pool.close(id);
		answer('k1');
		await starting;
		await settle();
		expect(w.sent('term_close').map((c) => c.args)).toEqual([{ key: 'k1' }]);
		expect(pool.has(id)).toBe(false);
	});

	test('a resize reaches the program only while it runs', async () => {
		const id = await pool.create(noEvents());
		const term = xterm.terms[0];
		term.resize(90, 20);
		await pool.start(id, async () => 'k1');
		term.resize(120, 40);
		await settle();
		expect(w.sent('term_resize').map((c) => c.args)).toEqual([{ key: 'k1', cols: 120, rows: 40 }]);
		w.emit('term-exit', { key: 'k1', code: 0 });
		term.resize(60, 10);
		await settle();
		expect(w.sent('term_resize').length).toBe(1);
	});
});

describe('output', () => {
	test('what the program prints is written to its own screen', async () => {
		const a = await running('k1');
		const b = await running('k2');
		w.emit('term-data', { key: 'k1', data: b64('one\r\n') });
		w.emit('term-data', { key: 'k2', data: b64('two\r\n') });
		expect(a.term.text()).toBe('one\r\n');
		expect(b.term.text()).toBe('two\r\n');
	});

	test('output that beats the answer to the open call is held until the key is known', async () => {
		const id = await pool.create(noEvents());
		await pool.start(id, async () => {
			w.emit('term-data', { key: 'k1', data: b64('early ') });
			expect(xterm.terms[0].written).toEqual([]);
			return 'k1';
		});
		w.emit('term-data', { key: 'k1', data: b64('late') });
		expect(xterm.terms[0].text()).toBe('early late');
	});

	test('early output for one key does not land on a screen that opened with another', async () => {
		const a = await pool.create(noEvents());
		const b = await pool.create(noEvents());
		let answerA!: (key: string) => void;
		const startA = pool.start(a, () => new Promise<string>((resolve) => (answerA = resolve)));
		const startB = pool.start(b, async () => {
			w.emit('term-data', { key: 'ka', data: b64('for a') });
			w.emit('term-data', { key: 'kb', data: b64('for b') });
			return 'kb';
		});
		await startB;
		answerA('ka');
		await startA;
		expect(xterm.terms[0].text()).toBe('for a');
		expect(xterm.terms[1].text()).toBe('for b');
	});

	test('output for a key nobody is opening is dropped', async () => {
		const { term } = await running('k1');
		w.emit('term-data', { key: 'stranger', data: b64('lost') });
		const id = await pool.create(noEvents());
		await pool.start(id, async () => 'stranger');
		expect(term.written).toEqual([]);
		expect(xterm.terms[1].written).toEqual([]);
	});

	test('the output event gets the text in the order it arrived', async () => {
		const heard: string[] = [];
		await running('k1', { exit: () => undefined, output: (text) => heard.push(text) });
		w.emit('term-data', { key: 'k1', data: b64('first\r\n') });
		w.emit('term-data', { key: 'k1', data: b64('\x1b[31msecond\x1b[0m') });
		expect(heard).toEqual(['first\r\n', '\x1b[31msecond\x1b[0m']);
	});

	test('a character cut in two by a read is put together again', async () => {
		const heard: string[] = [];
		const { term } = await running('k1', { exit: () => undefined, output: (text) => heard.push(text) });
		const bytes = new TextEncoder().encode('né');
		w.emit('term-data', { key: 'k1', data: b64(bytes.slice(0, 2)) });
		w.emit('term-data', { key: 'k1', data: b64(bytes.slice(2)) });
		expect(heard.join('')).toBe('né');
		expect(heard.join('')).not.toContain('�');
		// The screen gets the raw bytes: xterm does its own decoding.
		expect(term.written.every((d) => d instanceof Uint8Array)).toBe(true);
	});

	test('a note of ours is written on the screen and not sent to the program', async () => {
		const { id, term } = await running('k1');
		pool.note(id, '[Stopped]');
		await settle();
		expect(term.text()).toContain('[Stopped]');
		expect(w.sent('term_write')).toEqual([]);
	});
});

describe('typing', () => {
	test('what is typed is sent to the program under its key', async () => {
		const { term } = await running('k1');
		term.input('ls\r');
		await settle();
		expect(w.sent('term_write').map((c) => c.args)).toEqual([{ key: 'k1', data: 'ls\r' }]);
	});

	test('one write at a time: what is typed meanwhile waits and goes as the next write, in order', async () => {
		const { term } = await running('k1');
		const waiting: (() => void)[] = [];
		w.on('term_write', () => new Promise<void>((resolve) => waiting.push(resolve)));
		term.input('a');
		await settle();
		term.input('b');
		term.input('c');
		await settle();
		expect(w.sent('term_write').map((c) => c.args.data)).toEqual(['a']);
		waiting.shift()!();
		await settle();
		expect(w.sent('term_write').map((c) => c.args.data)).toEqual(['a', 'bc']);
		waiting.shift()!();
		await settle();
		expect(w.sent('term_write').length).toBe(2);
	});

	test('what is typed before the program has started is sent once it has', async () => {
		const id = await pool.create(noEvents());
		xterm.terms[0].input('early');
		pool.type(id, ' and typed');
		await settle();
		expect(w.sent('term_write')).toEqual([]);
		await pool.start(id, async () => 'k1');
		await settle();
		expect(w.sent('term_write').map((c) => c.args)).toEqual([{ key: 'k1', data: 'early and typed' }]);
	});

	test('the input event hears what was typed, and text put in by the app does not count as typing', async () => {
		const typed: string[] = [];
		const { id, term } = await running('k1', { exit: () => undefined, input: (data) => typed.push(data) });
		term.input('y');
		pool.type(id, 'npm test');
		await settle();
		expect(typed).toEqual(['y']);
		expect(w.sent('term_write').map((c) => c.args.data).join('')).toBe('ynpm test');
	});

	test('a write that fails drops what was waiting and the next keys are sent again', async () => {
		const { term } = await running('k1');
		w.on('term_write', () => { throw appError('error', 'gone'); });
		term.input('lost');
		await settle();
		w.on('term_write', () => undefined);
		term.input('kept');
		await settle();
		expect(w.sent('term_write').map((c) => c.args.data)).toEqual(['lost', 'kept']);
	});

	test('Shift+Return is sent as Escape and Return, so Claude Code can tell it from Return', async () => {
		const { term } = await running('k1');
		expect(term.keys(key('Enter', { shiftKey: true }))).toBe(false);
		// The key coming up again sends nothing more.
		expect(term.keys(key('Enter', { shiftKey: true }, 'keyup'))).toBe(false);
		await settle();
		expect(w.sent('term_write').map((c) => c.args.data)).toEqual(['\x1b\r']);
		expect(term.keys(key('Enter'))).toBe(true);
	});

	test('on the Mac, Cmd+Left, Cmd+Right and Cmd+Backspace move and delete by line', async () => {
		on('MacIntel');
		const { term } = await running('k1');
		expect(term.keys(key('ArrowLeft', { metaKey: true }))).toBe(false);
		expect(term.keys(key('ArrowRight', { metaKey: true }))).toBe(false);
		expect(term.keys(key('Backspace', { metaKey: true }))).toBe(false);
		await settle();
		expect(w.sent('term_write').map((c) => c.args.data).join('')).toBe('\x01\x05\x15');
	});

	test('off the Mac, Ctrl+Shift+C copies the selection and Ctrl+C alone goes to the program', async () => {
		on('Linux x86_64');
		const copied = clipboard();
		const { term } = await running('k1');
		term.selected = 'some text';
		expect(term.keys(key('c', { ctrlKey: true }))).toBe(true);
		expect(copied).toEqual([]);
		expect(term.keys(key('C', { ctrlKey: true, shiftKey: true }))).toBe(false);
		expect(copied).toEqual(['some text']);
		expect(term.selected).toBe('');
		// Ctrl+Shift+V is the paste: left to the web view, not sent as a key.
		expect(term.keys(key('V', { ctrlKey: true, shiftKey: true }))).toBe(false);
		expect(term.keys(key('v', { ctrlKey: true }))).toBe(true);
	});

	test('on Windows, Ctrl+C copies when text is selected and Ctrl+V pastes', async () => {
		on('Win32');
		const copied = clipboard();
		const { term } = await running('k1');
		// Nothing selected: Ctrl+C is the program's (it interrupts).
		expect(term.keys(key('c', { ctrlKey: true }))).toBe(true);
		term.selected = 'picked';
		expect(term.keys(key('c', { ctrlKey: true }))).toBe(false);
		expect(copied).toEqual(['picked']);
		expect(term.keys(key('v', { ctrlKey: true }))).toBe(false);
	});

	test('on the Mac, Ctrl+C and Ctrl+V are the program\'s', async () => {
		on('MacIntel');
		const { term } = await running('k1');
		term.selected = 'picked';
		expect(term.keys(key('c', { ctrlKey: true }))).toBe(true);
		expect(term.keys(key('v', { ctrlKey: true }))).toBe(true);
		expect(term.selected).toBe('picked');
	});
});

describe('pasting an image into Claude Code', () => {
	function paste(host: HTMLElement, text: string, files: { type: string }[]): Event {
		const event = new Event('paste', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'clipboardData', { value: { getData: (kind: string) => (kind === 'text/plain' ? text : ''), files, items: [] } });
		host.dispatchEvent(event);
		return event;
	}

	async function shown(events: ScreenEvents): Promise<{ id: string; host: HTMLElement; term: InstanceType<typeof xterm.FakeTerminal> }> {
		const { id, term } = await running('k1', events);
		const container = box();
		pool.show(id, container);
		return { id, host: container.querySelector<HTMLElement>('.screen')!, term };
	}

	test('an image and no text sends Claude Code its own paste-image key', async () => {
		on('MacIntel');
		const { host } = await shown({ exit: () => undefined, claude: true });
		const event = paste(host, '', [{ type: 'image/png' }]);
		await settle();
		expect(event.defaultPrevented).toBe(true);
		expect(w.sent('term_write').map((c) => c.args.data)).toEqual(['\x16']);
	});

	test('on Windows that key is Alt+V', async () => {
		on('Win32');
		const { host } = await shown({ exit: () => undefined, claude: true });
		paste(host, '', [{ type: 'image/png' }]);
		await settle();
		expect(w.sent('term_write').map((c) => c.args.data)).toEqual(['\x1bv']);
	});

	test('a paste that has text is left to the terminal', async () => {
		const { host } = await shown({ exit: () => undefined, claude: true });
		const event = paste(host, 'hello', [{ type: 'image/png' }]);
		await settle();
		expect(event.defaultPrevented).toBe(false);
		expect(w.sent('term_write')).toEqual([]);
	});

	test('a file that is not an image sends nothing', async () => {
		const { host } = await shown({ exit: () => undefined, claude: true });
		paste(host, '', [{ type: 'application/pdf' }]);
		await settle();
		expect(w.sent('term_write')).toEqual([]);
	});

	test('a plain shell gets no such key', async () => {
		const { host } = await shown(noEvents());
		const event = paste(host, '', [{ type: 'image/png' }]);
		await settle();
		expect(event.defaultPrevented).toBe(false);
		expect(w.sent('term_write')).toEqual([]);
	});
});

describe('the program ending', () => {
	test('the exit event says the code and how long the program ran', async () => {
		vi.useFakeTimers();
		const exit = vi.fn();
		const { id } = await running('k1', { exit });
		vi.advanceTimersByTime(4200);
		w.emit('term-exit', { key: 'k1', code: 2 });
		expect(exit).toHaveBeenCalledWith(2, 4200);
		expect(pool.ended(id)).toBe(true);
	});

	test('a code the system did not report is null', async () => {
		const exit = vi.fn();
		await running('k1', { exit });
		w.emit('term-exit', { key: 'k1', code: null });
		expect(exit.mock.calls[0][0]).toBeNull();
	});

	test('nothing is sent to a program that has ended', async () => {
		const typed: string[] = [];
		const { id, term } = await running('k1', { exit: () => undefined, input: (data) => typed.push(data) });
		w.emit('term-exit', { key: 'k1', code: 0 });
		term.input('x');
		pool.type(id, 'y');
		await settle();
		expect(w.sent('term_write')).toEqual([]);
		expect(typed).toEqual([]);
	});

	test('an exit that beats the answer to the open call still arrives', async () => {
		const exit = vi.fn();
		const id = await pool.create({ exit });
		await pool.start(id, async () => {
			w.emit('term-exit', { key: 'k1', code: 127 });
			return 'k1';
		});
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit.mock.calls[0][0]).toBe(127);
		expect(pool.ended(id)).toBe(true);
	});

	test('stop ends the program and keeps the screen', async () => {
		const { id, term } = await running('k1');
		w.emit('term-data', { key: 'k1', data: b64('still here') });
		pool.stop(id);
		await settle();
		expect(w.sent('term_close').map((c) => c.args)).toEqual([{ key: 'k1' }]);
		expect(pool.has(id)).toBe(true);
		expect(term.disposed).toBe(false);
		expect(term.text()).toBe('still here');
	});

	test('stop does nothing for a program that has not started or has ended', async () => {
		const fresh = await pool.create(noEvents());
		pool.stop(fresh);
		const { id } = await running('k1');
		w.emit('term-exit', { key: 'k1', code: 0 });
		pool.stop(id);
		await settle();
		expect(w.sent('term_close')).toEqual([]);
	});

	test('close ends the program and removes the screen', async () => {
		const { id, term } = await running('k1');
		const container = box();
		pool.show(id, container);
		pool.close(id);
		await settle();
		expect(w.sent('term_close').map((c) => c.args)).toEqual([{ key: 'k1' }]);
		expect(pool.has(id)).toBe(false);
		expect(term.disposed).toBe(true);
		expect(container.querySelector('.screen')).toBeNull();
	});

	test('closing a screen whose program has ended does not end it again', async () => {
		const { id } = await running('k1');
		w.emit('term-exit', { key: 'k1', code: 0 });
		pool.close(id);
		await settle();
		expect(w.sent('term_close')).toEqual([]);
	});

	test('output for a closed screen goes nowhere', async () => {
		const exit = vi.fn();
		const { id, term } = await running('k1', { exit });
		pool.close(id);
		w.emit('term-data', { key: 'k1', data: b64('late') });
		w.emit('term-exit', { key: 'k1', code: 0 });
		expect(term.written).toEqual([]);
		expect(exit).not.toHaveBeenCalled();
	});

	test('after a reset the screen can be started again and keeps what is on it', async () => {
		const exit = vi.fn();
		const { id, term } = await running('k1', { exit });
		w.emit('term-data', { key: 'k1', data: b64('before ') });
		w.emit('term-exit', { key: 'k1', code: 0 });
		pool.reset(id);
		expect(pool.started(id)).toBe(false);
		await pool.start(id, async () => 'k2');
		expect(pool.started(id)).toBe(true);
		expect(pool.ended(id)).toBe(false);
		w.emit('term-data', { key: 'k2', data: b64('after') });
		// The old key is nobody's any more.
		w.emit('term-data', { key: 'k1', data: b64('stale') });
		expect(term.text()).toBe('before after');
		term.input('x');
		await settle();
		expect(w.sent('term_write').map((c) => c.args)).toEqual([{ key: 'k2', data: 'x' }]);
	});
});

describe('showing a screen', () => {
	test('a screen is opened once its container has a size', async () => {
		const id = await pool.create(noEvents());
		const term = xterm.terms[0];
		const unseen = box(0, 0);
		expect(pool.show(id, unseen)).toBe(false);
		expect(term.host).toBeNull();
		const seen = box();
		expect(pool.show(id, seen)).toBe(true);
		expect(term.host).toBe(seen.querySelector('.screen'));
		expect(unseen.querySelector('.screen')).toBeNull();
	});

	test('showing one screen hides the others in the same container', async () => {
		const a = await pool.create(noEvents());
		const b = await pool.create(noEvents());
		const container = box();
		pool.show(a, container);
		pool.show(b, container);
		const [first, second] = [...container.querySelectorAll<HTMLElement>('.screen')];
		expect(first.hidden).toBe(true);
		expect(second.hidden).toBe(false);
		pool.show(a, container);
		expect(first.hidden).toBe(false);
		expect(second.hidden).toBe(true);
		expect(container.querySelectorAll('.screen').length).toBe(2);
	});

	test('a screen moves to another container with what it has', async () => {
		const { id, term } = await running('k1');
		const one = box();
		const two = box();
		pool.show(id, one);
		w.emit('term-data', { key: 'k1', data: b64('kept') });
		pool.show(id, two);
		expect(one.querySelector('.screen')).toBeNull();
		expect(two.querySelector('.screen')).toBe(term.host);
		expect(term.text()).toBe('kept');
		expect(pool.started(id)).toBe(true);
	});

	test('a hidden screen keeps running', async () => {
		const { id, term } = await running('k1');
		const container = box();
		pool.show(id, container);
		pool.focus(id);
		pool.hide(id);
		expect(container.querySelector<HTMLElement>('.screen')!.hidden).toBe(true);
		expect(term.focused).toBe(false);
		w.emit('term-data', { key: 'k1', data: b64('meanwhile') });
		expect(term.text()).toBe('meanwhile');
		expect(w.sent('term_close')).toEqual([]);
	});

	test('focus waits for a screen that has been opened', async () => {
		const id = await pool.create(noEvents());
		pool.focus(id);
		expect(xterm.terms[0].focused).toBe(false);
		pool.show(id, box());
		pool.focus(id);
		expect(xterm.terms[0].focused).toBe(true);
		pool.blur(id);
		expect(xterm.terms[0].focused).toBe(false);
	});

	test('the selection is the screen\'s own', async () => {
		const { id, term } = await running('k1');
		term.selected = 'TypeError: nope';
		expect(pool.selection(id)).toBe('TypeError: nope');
	});
});

describe('links in the output', () => {
	function follow(term: InstanceType<typeof xterm.FakeTerminal>, uri: string, mods: { metaKey?: boolean; ctrlKey?: boolean }): void {
		const handler = term.options.linkHandler as { activate(event: unknown, uri: string): void };
		handler.activate({ metaKey: false, ctrlKey: false, ...mods, preventDefault: () => undefined }, uri);
	}

	beforeEach(() => w.on('plugin:opener|open_url', () => undefined));

	test('an address opens in the browser on Cmd+click on the Mac', async () => {
		on('MacIntel');
		const { term } = await running('k1');
		follow(term, 'https://example.com/docs', { metaKey: true });
		await settle();
		expect(w.sent('plugin:opener|open_url').map((c) => c.args)).toEqual([{ url: 'https://example.com/docs' }]);
	});

	test('off the Mac it is Ctrl+click', async () => {
		on('Linux x86_64');
		const { term } = await running('k1');
		follow(term, 'http://localhost:5173/', { metaKey: true });
		follow(term, 'http://localhost:5173/', { ctrlKey: true });
		await settle();
		expect(w.sent('plugin:opener|open_url').length).toBe(1);
	});

	test('a plain click opens nothing', async () => {
		on('MacIntel');
		const { term } = await running('k1');
		follow(term, 'https://example.com', {});
		await settle();
		expect(w.sent('plugin:opener|open_url')).toEqual([]);
	});

	test('only http and https are opened: the output is untrusted', async () => {
		on('MacIntel');
		const { term } = await running('k1');
		for (const uri of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://open?x', 'ftp://example.com', ' https://example.com']) {
			follow(term, uri, { metaKey: true });
		}
		await settle();
		expect(w.sent('plugin:opener|open_url')).toEqual([]);
	});
});

describe('settings', () => {
	test('a new screen takes the terminal text size from the settings', async () => {
		const { EditorSettingsStore } = await import('./editor-settings.store');
		w.get(EditorSettingsStore).set('terminalFontSize', 15);
		await pool.create(noEvents());
		expect(xterm.terms[0].options.fontSize).toBe(15);
	});

	test('a change of the text size reaches every screen at once', async () => {
		const { EditorSettingsStore } = await import('./editor-settings.store');
		await pool.create(noEvents());
		await pool.create(noEvents());
		w.get(EditorSettingsStore).set('terminalFontSize', 16);
		await settle();
		expect(xterm.terms.map((t) => t.options.fontSize)).toEqual([16, 16]);
	});

	test('the colours are resolved again when the app switches theme', async () => {
		await pool.create(noEvents());
		expect(xterm.terms[0].options.theme).toEqual({ background: '#ffffff' });
		document.documentElement.setAttribute('data-theme', 'dark');
		await settle();
		expect(xterm.terms[0].options.theme).toEqual({ background: '#000000' });
	});

	test('a terminal keeps a bounded number of lines above the screen', async () => {
		await pool.create(noEvents());
		expect(xterm.terms[0].options.scrollback).toBe(5000);
	});
});
