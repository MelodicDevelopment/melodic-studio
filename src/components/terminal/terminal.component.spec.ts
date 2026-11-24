import { beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { Run, RunError, RunStore } from '../../services/run.store';
import type { TerminalStore } from '../../services/terminal.store';
import type { AgentsStore } from '../../services/agents.store';

/** What the pretend terminal has selected. */
const screen = vi.hoisted(() => ({ selection: '' }));

// Monaco cannot run in happy-dom, and the language services reach for it as soon as the status changes.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
// xterm cannot run here either: this stands in for it. The panel's tabs, bars and buttons are what is tested, not the terminal.
vi.mock('../../shared/xterm', () => {
	class Terminal {
		cols = 80;
		rows = 24;
		options: Record<string, unknown> = {};
		loadAddon(): void {}
		open(): void {}
		write(): void {}
		focus(): void {}
		blur(): void {}
		dispose(): void {}
		onData(): void {}
		onResize(): void {}
		attachCustomKeyEventHandler(): void {}
		getSelection(): string {
			return screen.selection;
		}
	}
	class Addon {
		fit(): void {}
	}
	return { loadXterm: async () => ({ Terminal, FitAddon: Addon, WebLinksAddon: Addon }), adoptXtermStyles: () => {}, xtermTheme: () => ({}) };
});

const HARMONY = '/Users/demo/Source/harmony';

let w: World;
let repos: RepoStore;
let terminals: TerminalStore;
let runs: RunStore;
let agents: AgentsStore;
/** Keys the pretend native side has given out, newest last. */
let keys: string[];

/**
 * happy-dom keeps its custom elements across `vi.resetModules()` and Melodic defines a tag only once, so
 * without this every test after the first would mount the first test's classes, bound to its stores.
 */
function forgetElements(): void {
	const registry = customElements as unknown as Record<symbol, unknown>;
	for (const key of Object.getOwnPropertySymbols(registry)) {
		const value = registry[key];
		if (value instanceof Map) {
			value.clear();
		}
	}
}

beforeEach(async () => {
	screen.selection = '';
	w = await world();
	forgetElements();
	// Shells and programs are answered here: the demo's own print on timers.
	keys = [];
	const open = (): string => {
		keys.push(`pty-${keys.length + 1}`);
		return keys.at(-1)!;
	};
	w.on('term_open', open);
	w.on('target_run', () => ({ key: open(), port: null, command: 'npm run dev' }));
	w.on('term_write', () => undefined);
	w.on('term_resize', () => undefined);
	w.on('term_close', () => undefined);
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	terminals = w.get((await import('../../services/terminal.store')).TerminalStore);
	runs = w.get((await import('../../services/run.store')).RunStore);
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	await repos.init();
	await runs.load();
});

/**
 * What a person reads under `root`, through shadow roots: the text as it is written, a space where an element
 * starts or ends, and no icons (an `ml-icon` draws a private-use character of its font).
 */
function words(root: Node): string {
	let out = '';
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			out += node.textContent ?? '';
			return;
		}
		if (node instanceof Element) {
			if (node.tagName === 'STYLE' || node.tagName === 'SCRIPT') {
				return;
			}
			if (node.shadowRoot) {
				walk(node.shadowRoot);
			}
		}
		out += ' ';
		node.childNodes.forEach(walk);
		out += ' ';
	};
	walk(root);
	return out.replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
}

async function panel(): Promise<HTMLElement> {
	const el = await mount('ms-terminal');
	await settle();
	return el;
}

function isOpen(el: Element): boolean {
	return !find(el, '.panel')!.classList.contains('closed');
}

function tabs(el: Element): HTMLElement[] {
	return all(el, '.ttab');
}

function titles(el: Element): string[] {
	return tabs(el).map((t) => t.querySelector('span:not(.eq)')!.textContent ?? '');
}

async function key(init: KeyboardEventInit): Promise<KeyboardEvent> {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'Backquote', key: '`', ...init });
	window.dispatchEvent(event);
	await settle();
	return event;
}

/** What a program prints arrives as base64 of its bytes. */
function prints(ptyKey: string, text: string): void {
	w.emit('term-data', { key: ptyKey, data: btoa(String.fromCharCode(...new TextEncoder().encode(text))) });
}

async function ends(ptyKey: string, code: number | null): Promise<void> {
	w.emit('term-exit', { key: ptyKey, code });
	await settle();
}

/** An error as the spotter records one, for tests that put it on a run directly. */
function spotted(change: Partial<RunError> = {}): RunError {
	return {
		id: `e${Math.random()}`,
		at: Date.now(),
		dismissed: false,
		site: null,
		kind: 'exception',
		runtime: 'node',
		summary: "TypeError: Cannot read properties of null (reading 'title')",
		type: 'TypeError',
		message: "Cannot read properties of null (reading 'title')",
		test: null,
		frames: [],
		text: '',
		line: 0,
		...change,
	};
}

/** The `dev` target running in a tab, with these errors spotted in it. */
async function running(errors: RunError[] = []): Promise<Run> {
	const run = (await runs.start())!;
	runs.runs.set(runs.runs().map((r) => (r.id === run.id ? { ...r, errors } : r)));
	await settle();
	return runs.run(run.id)!;
}

describe('the panel', () => {
	test('is closed to begin with, and no shell is started', async () => {
		const el = await panel();
		expect(isOpen(el)).toBe(false);
		expect(tabs(el)).toEqual([]);
		expect(w.sent('term_open')).toEqual([]);
	});

	test('Ctrl+` opens it with a shell in the repository, and again hides it without ending the shell', async () => {
		const el = await panel();
		const event = await key({ ctrlKey: true });
		expect(event.defaultPrevented).toBe(true);
		expect(isOpen(el)).toBe(true);
		expect(w.sent('term_open').length).toBe(1);
		expect(w.sent('term_open')[0].args).toMatchObject({ id: HARMONY, at: null });
		expect(titles(el)).toEqual(['harmony']);
		expect(tabs(el)[0].title).toBe(HARMONY);

		await key({ ctrlKey: true });
		expect(isOpen(el)).toBe(false);
		expect(titles(el)).toEqual(['harmony']);
		expect(w.sent('term_close')).toEqual([]);
	});

	test('it is Ctrl on a Mac too: Cmd+` is the system\'s, and is left alone', async () => {
		const el = await panel();
		const event = await key({ metaKey: true });
		expect(event.defaultPrevented).toBe(false);
		expect(isOpen(el)).toBe(false);
		const both = await key({ ctrlKey: true, metaKey: true });
		expect(both.defaultPrevented).toBe(false);
		expect(isOpen(el)).toBe(false);
	});

	test('the key is taken before a focused terminal could send it to the shell', async () => {
		await panel();
		const later = vi.fn();
		window.addEventListener('keydown', later);
		await key({ ctrlKey: true });
		window.removeEventListener('keydown', later);
		expect(later).not.toHaveBeenCalled();
	});

	test('Ctrl+Shift+` opens another terminal, named apart from the first', async () => {
		const el = await panel();
		await key({ ctrlKey: true });
		await key({ ctrlKey: true, shiftKey: true });
		expect(titles(el)).toEqual(['harmony', 'harmony 2']);
		expect(w.sent('term_open').length).toBe(2);
		expect(tabs(el).map((t) => t.classList.contains('on'))).toEqual([false, true]);
	});

	test('open or closed is remembered for the repository', async () => {
		await panel();
		await key({ ctrlKey: true });
		expect(JSON.parse(localStorage.getItem('studio.terminal.opens')!)).toEqual({ [HARMONY]: true });
	});

	test('the buttons name their shortcuts with Ctrl', async () => {
		const el = await panel();
		expect(find(el, '.tabs > button.tool')!.title).toBe('New terminal (Ctrl+Shift+`)');
		expect(all(el, '.head > button.tool').at(-1)!.title).toBe('Hide terminal (Ctrl+`)');
	});
});

describe('the tabs', () => {
	async function two(): Promise<HTMLElement> {
		const el = await panel();
		await terminals.add();
		await terminals.add();
		await settle();
		return el;
	}

	test('clicking a tab shows that terminal', async () => {
		const el = await two();
		await click(tabs(el)[0]);
		expect(tabs(el).map((t) => t.classList.contains('on'))).toEqual([true, false]);
		expect(terminals.active()).toBe(terminals.tabs()[0].id);
	});

	test('the plus opens another terminal', async () => {
		const el = await two();
		await click(find(el, '.tabs > button.tool'));
		expect(titles(el)).toEqual(['harmony', 'harmony 2', 'harmony 3']);
	});

	test('the cross closes a terminal and ends its shell, without selecting it', async () => {
		const el = await two();
		const active = terminals.active();
		await click(find(tabs(el)[0], 'button'));
		expect(titles(el)).toEqual(['harmony 2']);
		expect(w.sent('term_close').map((c) => c.args.key)).toEqual(['pty-1']);
		expect(terminals.active()).toBe(active);
		expect(isOpen(el)).toBe(true);
	});

	test('closing the last terminal hides the panel', async () => {
		const el = await two();
		await click(find(tabs(el)[0], 'button'));
		await click(find(tabs(el)[0], 'button'));
		expect(tabs(el)).toEqual([]);
		expect(isOpen(el)).toBe(false);
	});

	test('a middle click closes; another extra button does not', async () => {
		const el = await two();
		tabs(el)[1].dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
		await settle();
		expect(tabs(el).length).toBe(2);
		tabs(el)[1].dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
		await settle();
		expect(titles(el)).toEqual(['harmony']);
	});

	test('the caret hides the panel and keeps the terminals', async () => {
		const el = await two();
		await click(all(el, '.head > button.tool').at(-1)!);
		expect(isOpen(el)).toBe(false);
		expect(tabs(el).length).toBe(2);
		expect(w.sent('term_close')).toEqual([]);
	});

	test('a shell that ends takes its tab with it', async () => {
		const el = await two();
		await ends('pty-1', 0);
		expect(titles(el)).toEqual(['harmony 2']);
	});

	test('a shell that could not start is said, and leaves no tab', async () => {
		const el = await panel();
		w.on('term_open', () => {
			throw appError('error', 'No shell found');
		});
		await terminals.add();
		await settle();
		expect(tabs(el)).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'No shell found' });
		expect(words(find(el, '.none')!)).toBe('No terminal is open. New terminal');
	});

	test('each repository has its own terminals, and they are still there on the way back', async () => {
		const el = await two();
		await repos.selectRepo('/Users/demo/Source/cadence', true);
		await settle();
		expect(tabs(el)).toEqual([]);
		expect(isOpen(el)).toBe(false);
		await repos.selectRepo(HARMONY);
		await settle();
		expect(titles(el)).toEqual(['harmony', 'harmony 2']);
		expect(isOpen(el)).toBe(true);
		expect(w.sent('term_close')).toEqual([]);
	});
});

describe('the top edge', () => {
	function height(el: Element): string {
		return find(el, '.panel')!.style.height;
	}

	test('drags the height, never under 120 px, and the height is remembered when let go', async () => {
		const el = await panel();
		expect(height(el)).toBe('280px');
		const grip = find(el, '.grip')!;
		(grip as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
		grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 500 }));
		grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 440 }));
		await settle();
		expect(height(el)).toBe('340px');
		expect(find(el, '.panel')!.classList.contains('dragging')).toBe(true);
		grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 900 }));
		grip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		await settle();
		expect(height(el)).toBe('120px');
		expect(localStorage.getItem('studio.terminal.height')).toBe('120');
		expect(find(el, '.panel')!.classList.contains('dragging')).toBe(false);
	});

	test('a double click goes back to 280 px', async () => {
		const el = await panel();
		terminals.setHeight(400);
		terminals.saveHeight();
		await settle();
		find(el, '.grip')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await settle();
		expect(height(el)).toBe('280px');
		expect(localStorage.getItem('studio.terminal.height')).toBeNull();
	});
});

describe('a run', () => {
	test('is a tab of its own, with its command beside the tabs', async () => {
		const el = await panel();
		await running();
		expect(titles(el)).toEqual(['dev']);
		expect(tabs(el)[0].classList.contains('run')).toBe(true);
		expect(tabs(el)[0].title).toBe(`npm run dev\n${HARMONY}`);
		expect(find(tabs(el)[0], '.eq')).not.toBeNull();
		expect(words(find(el, '.head .cmd')!)).toBe('npm run dev');
		expect(isOpen(el)).toBe(true);
	});

	test('its cross warns that closing stops it; a shell\'s only closes', async () => {
		const el = await panel();
		await running();
		await terminals.add();
		await settle();
		expect(tabs(el).map((t) => find(t, 'button')!.title)).toEqual(['Close (stops it if it is running)', 'Close terminal']);
	});

	test('the tab stays when the program ends, so its output can be read', async () => {
		const el = await panel();
		await running();
		await ends(keys.at(-1)!, 0);
		expect(titles(el)).toEqual(['dev']);
		expect(tabs(el)[0].classList.contains('ended')).toBe(true);
		expect(find(tabs(el)[0], '.eq')).toBeNull();
		expect(runs.runs()[0]).toMatchObject({ state: 'ended', exitCode: 0 });
	});
});

describe('"Error spotted"', () => {
	const CRASH = [
		`${HARMONY}/src/player/queue.ts:12`,
		'  return current.title;',
		'                 ^',
		'',
		"TypeError: Cannot read properties of null (reading 'title')",
		`    at next (${HARMONY}/src/player/queue.ts:12:18)`,
		`    at advance (${HARMONY}/src/player/repeat.ts:4:10)`,
		'    at Module._compile (node:internal/modules/cjs/loader:1761:14)',
		'    at handle (/opt/elsewhere/server.js:9:3)',
		'',
		'Node.js v24.11.1',
		'',
	].join('\r\n');

	test('nothing is there while the program has printed no error', async () => {
		const el = await panel();
		await running();
		prints(keys.at(-1)!, 'ready on http://localhost:5173\r\n');
		await settle();
		expect(find(el, '.spotted')).toBeNull();
	});

	test('an exception in the program\'s output shows in a bar between the tabs and the terminal', async () => {
		const el = await panel();
		await running();
		prints(keys.at(-1)!, CRASH);
		await ends(keys.at(-1)!, 1);
		const bar = find(el, '.spotted')!;
		expect(words(find(bar, 'b')!)).toBe('Error spotted');
		expect(find(bar, '.sum')!.textContent).toBe('TypeError in next');
		expect(find(bar, '.sum')!.title).toBe('TypeError in next');
		expect(bar.previousElementSibling).toBe(find(el, '.head'));
		expect(bar.nextElementSibling).toBe(find(el, '.screens'));
		expect(find(el, '.screens .spotted')).toBeNull();
		expect(words(find(tabs(el)[0], '.errs')!)).toBe('1 error');
	});

	test('the frames inside the checkout are links; the others are left out', async () => {
		const el = await panel();
		await running();
		prints(keys.at(-1)!, CRASH);
		await ends(keys.at(-1)!, 1);
		expect(all(el, '.spotted .frames a').map((a) => [a.textContent, a.title])).toEqual([
			['queue.ts:12', 'next'],
			['repeat.ts:4', 'advance'],
		]);
	});

	test('a frame opens its file in the Files tab at that line', async () => {
		const { ExplorerStore } = await import('../../services/explorer.store');
		const openAt = vi.spyOn(w.get(ExplorerStore), 'openAt').mockResolvedValue(undefined as never);
		repos.setTab('changes');
		const el = await panel();
		await running();
		prints(keys.at(-1)!, CRASH);
		await ends(keys.at(-1)!, 1);
		const event = new MouseEvent('click', { bubbles: true, cancelable: true });
		all(el, '.spotted .frames a')[1].dispatchEvent(event);
		await settle();
		expect(event.defaultPrevented).toBe(true);
		expect(repos.tab()).toBe('files');
		expect(openAt).toHaveBeenCalledWith('src/player/repeat.ts', 4, 10);
	});

	test('text from the program is shown as text', async () => {
		const el = await panel();
		await running([spotted({ summary: '<img src=x onerror="window.pwned = true"> Error' })]);
		expect(find(el, '.spotted .sum')!.textContent).toBe('<img src=x onerror="window.pwned = true"> Error');
		expect(find(el, '.spotted img')).toBeNull();
	});

	test('a failed test is called one', async () => {
		const el = await panel();
		await running([spotted({ kind: 'test', summary: 'queue > wraps on repeat', test: 'queue > wraps on repeat' })]);
		expect(words(find(el, '.spotted b')!)).toBe('Test failed');
	});

	test('Dismiss puts the error away', async () => {
		const el = await panel();
		await running([spotted()]);
		await click(all(el, '.spotted button').find((b) => words(b) === 'Dismiss')!);
		expect(find(el, '.spotted')).toBeNull();
		expect(find(tabs(el)[0], '.errs')).toBeNull();
		expect(runs.runs()[0].errors[0].dismissed).toBe(true);
	});

	test('with several errors the newest shows first, and the others are one click away', async () => {
		const el = await panel();
		await running([spotted({ summary: 'First to happen' }), spotted({ summary: 'Second to happen' })]);
		const sum = (): string => find(el, '.spotted .sum')!.textContent ?? '';
		expect(sum()).toBe('Second to happen');
		expect(words(find(el, '.pager')!)).toBe('1 of 2');
		expect(words(find(tabs(el)[0], '.errs')!)).toBe('2 errors');
		expect(find<HTMLButtonElement>(el, '[title="Newer error"]')!.disabled).toBe(true);
		await click(find(el, '[title="Older error"]'));
		expect(sum()).toBe('First to happen');
		expect(words(find(el, '.pager')!)).toBe('2 of 2');
		expect(find<HTMLButtonElement>(el, '[title="Older error"]')!.disabled).toBe(true);
		await click(find(el, '[title="Newer error"]'));
		expect(sum()).toBe('Second to happen');
	});

	test('Investigate hands the error, the target and its command to Claude', async () => {
		const investigate = vi.spyOn(agents, 'investigate').mockResolvedValue(true);
		const el = await panel();
		const error = spotted();
		const run = await running([error]);
		await click(find(el, '.spotted button.ask'));
		expect(investigate).toHaveBeenCalledTimes(1);
		expect(investigate.mock.calls[0][0]).toMatchObject({ description: '', error, target: run.target, command: 'npm run dev' });
		expect(find(el, '.spotted button.ask')!.title).toContain('Your files are not touched.');
	});

	test('the bar belongs to the run on screen: another terminal\'s tab has none', async () => {
		const el = await panel();
		await running([spotted()]);
		await terminals.add();
		await settle();
		expect(find(el, '.spotted')).toBeNull();
		await click(tabs(el)[0]);
		expect(find(el, '.spotted')).not.toBeNull();
	});

	test('a non-zero exit that nothing else explains is an error too', async () => {
		const el = await panel();
		await running();
		prints(keys.at(-1)!, 'building…\r\n');
		await ends(keys.at(-1)!, 2);
		expect(find(el, '.spotted .sum')!.textContent).toMatch(/exit code 2|code 2/);
	});
});

describe('the sparkle button', () => {
	test('opens "describe a bug" with the text selected in the terminal on screen', async () => {
		const openInvestigate = vi.spyOn(agents, 'openInvestigate').mockImplementation(() => {});
		const el = await panel();
		await terminals.add();
		await settle();
		screen.selection = 'Error: boom\n    at main (src/main.ts:3:1)';
		await click(find(el, 'button.tool.ai'));
		expect(openInvestigate).toHaveBeenCalledWith('Error: boom\n    at main (src/main.ts:3:1)');
	});

	test('with no terminal there is nothing selected to hand over', async () => {
		const openInvestigate = vi.spyOn(agents, 'openInvestigate').mockImplementation(() => {});
		const el = await panel();
		await click(find(el, 'button.tool.ai'));
		expect(openInvestigate).toHaveBeenCalledWith('');
	});
});
