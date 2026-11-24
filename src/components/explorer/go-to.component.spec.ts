import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { ExplorerStore } from '../../services/explorer.store';
import type { FileIndexStore } from '../../services/file-index.store';
import type { Coverage, LspService, SymbolHit } from '../../services/lsp.service';

// Monaco cannot run in happy-dom: the files a hit would open are watched for, not opened.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));

let w: World;
let repos: RepoStore;
let explorer: ExplorerStore;
let files: FileIndexStore;
let lsp: LspService;
let el: HTMLElement;
let open: MockInstance<ExplorerStore['open']>;
let openAt: MockInstance<ExplorerStore['openAt']>;
let cover: MockInstance<LspService['cover']>;
let findSymbols: MockInstance<LspService['findSymbols']>;
let uncover: MockInstance<LspService['uncover']>;
/** What the pretend language servers cover, and what they find. */
let coverage: Coverage | null;
let symbols: SymbolHit[] | null;
const platform = Object.getOwnPropertyDescriptor(navigator, 'platform');

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

/** The box waits 150 ms after a keystroke before it asks for symbols: here that pause is over at once. */
const realTimeout = window.setTimeout.bind(window);
function noTypingPause(): void {
	vi.spyOn(window, 'setTimeout').mockImplementation(((run: () => void, ms?: number, ...rest: unknown[]) => realTimeout(run, ms === 150 ? 0 : ms, ...rest)) as typeof window.setTimeout);
}

/** The app on this platform (`navigator.platform` is what `isMac()` reads), with the box in the page, closed. */
async function start(on = 'MacIntel'): Promise<void> {
	Object.defineProperty(navigator, 'platform', { value: on, configurable: true });
	w = await world();
	forgetElements();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	explorer = w.get((await import('../../services/explorer.store')).ExplorerStore);
	files = w.get((await import('../../services/file-index.store')).FileIndexStore);
	lsp = w.get((await import('../../services/lsp.service')).LspService);
	open = vi.spyOn(explorer, 'open').mockResolvedValue(undefined as never);
	openAt = vi.spyOn(explorer, 'openAt').mockResolvedValue(undefined as never);
	vi.spyOn(explorer, 'sync').mockImplementation(() => {});
	coverage = { covered: ['TypeScript'], without: [] };
	symbols = [];
	cover = vi.spyOn(lsp, 'cover').mockImplementation(async () => coverage);
	findSymbols = vi.spyOn(lsp, 'findSymbols').mockImplementation(async () => symbols);
	uncover = vi.spyOn(lsp, 'uncover').mockImplementation(() => {});
	noTypingPause();
	await repos.init();
	repos.setTab('changes');
	el = await mount('ms-go-to');
}

beforeEach(() => start());

afterEach(() => {
	if (platform) {
		Object.defineProperty(navigator, 'platform', platform);
	}
});

async function key(init: KeyboardEventInit, from: EventTarget = window): Promise<KeyboardEvent> {
	const event = new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, ...init });
	from.dispatchEvent(event);
	await settle();
	return event;
}

function box(): HTMLInputElement | null {
	return find<HTMLInputElement>(el, '.box input');
}

async function type(value: string): Promise<void> {
	box()!.value = value;
	box()!.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}

/** A key pressed in the box. */
async function press(name: string): Promise<void> {
	await key({ key: name }, box()!);
}

function hits(): string[] {
	return all(el, '.hit').map((h) => h.title || find(h, '.name')!.textContent!);
}

function note(): string {
	return find(el, '.note')?.textContent ?? '';
}

function symbol(name: string, change: Partial<SymbolHit> = {}): SymbolHit {
	return { name, kind: 11, container: '', path: 'src/player/queue.ts', line: 8, column: 2, ...change };
}

describe('opening and closing', () => {
	test('nothing is there until it is asked for', () => {
		expect(box()).toBeNull();
		expect(find(el, '.veil')).toBeNull();
	});

	test.each([
		['Cmd', { metaKey: true }],
		['Ctrl', { ctrlKey: true }],
	])('%s+P opens it on files, from any tab, and reads the list of files again', async (_name, mods) => {
		const before = w.sent('files_list').length;
		const event = await key({ key: 'p', ...mods });
		expect(event.defaultPrevented).toBe(true);
		expect(box()!.value).toBe('');
		expect(box()!.placeholder).toBe('Go to a file by name    @ for a symbol    :12 for a line');
		expect(w.sent('files_list').length).toBe(before + 1);
		expect(hits().length).toBeGreaterThan(0);
	});

	test('the list is read again each time the box opens', async () => {
		await key({ key: 'p', metaKey: true });
		await press('Escape');
		const before = w.sent('files_list').length;
		await key({ key: 'p', metaKey: true });
		expect(w.sent('files_list').length).toBe(before + 1);
	});

	test('the same key again puts it away; the other key swaps what it looks for', async () => {
		await key({ key: 'p', metaKey: true });
		await key({ key: 't', metaKey: true });
		expect(box()!.value).toBe('@');
		await key({ key: 'p', metaKey: true });
		expect(box()!.value).toBe('');
		await key({ key: 'p', metaKey: true });
		expect(box()).toBeNull();
	});

	test('Esc, or a click beside the box, closes it', async () => {
		await key({ key: 'p', metaKey: true });
		await press('Escape');
		expect(box()).toBeNull();
		await key({ key: 'p', metaKey: true });
		find(el, '.veil')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		await settle();
		expect(box()).toBeNull();
	});

	test('with Shift or Alt the keys are someone else\'s', async () => {
		const shifted = await key({ key: 'P', metaKey: true, shiftKey: true });
		const alted = await key({ key: 'p', metaKey: true, altKey: true });
		expect(shifted.defaultPrevented || alted.defaultPrevented).toBe(false);
		expect(box()).toBeNull();
	});

	test('with no repository open there is nothing to go to', async () => {
		w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: '', authorEmail: '', appVersion: '0.1.0' }));
		await repos.switchContext();
		await key({ key: 'p', metaKey: true });
		expect(box()).toBeNull();
	});

	test('on a Mac the keys work from inside a terminal too', async () => {
		const terminal = document.createElement('ms-terminal');
		document.body.append(terminal);
		await key({ key: 'p', metaKey: true }, terminal);
		expect(box()).not.toBeNull();
	});

	test('off the Mac a terminal keeps Ctrl+P and Ctrl+T for the shell', async () => {
		await start('Win32');
		const terminal = document.createElement('ms-terminal');
		document.body.append(terminal);
		const event = await key({ key: 'p', ctrlKey: true }, terminal);
		expect(event.defaultPrevented).toBe(false);
		expect(box()).toBeNull();
		await key({ key: 'p', ctrlKey: true });
		expect(box()).not.toBeNull();
	});
});

describe('a file by name', () => {
	beforeEach(async () => {
		await key({ key: 'p', metaKey: true });
	});

	test('with nothing typed it lists the checkout\'s files, without the ones .gitignore leaves out', async () => {
		expect(hits()).toContain('src/player/queue.ts');
		expect(hits()).toContain('README.md');
		expect(hits().some((p) => p.startsWith('node_modules/') || p.startsWith('dist/') || p === 'debug.log')).toBe(false);
		expect(note()).toBe('');
	});

	test('typing finds a file from a few letters of its name, with the letters marked', async () => {
		await type('queu');
		expect(hits()[0]).toBe('src/player/queue.ts');
		expect(all(find(el, '.hit')!, '.name b').map((b) => b.textContent).join('')).toBe('queu');
		expect(find(el, '.hit .dir')!.textContent).toBe('src/player');
	});

	test('every word typed has to match', async () => {
		await type('player track');
		expect(hits()).toEqual(['src/player/track.ts']);
	});

	test('a name nothing is like says so, and why a file may be missing', async () => {
		await type('zzzz');
		expect(hits()).toEqual([]);
		expect(note()).toBe('No file named like "zzzz". Files that .gitignore leaves out are not listed.');
	});

	test('Enter opens the first file in the Files tab and closes the box', async () => {
		await type('queu');
		await press('Enter');
		expect(open).toHaveBeenCalledWith('src/player/queue.ts', true);
		expect(repos.tab()).toBe('files');
		expect(box()).toBeNull();
	});

	test('the arrows move through the list, round the ends, and Enter takes the one they are on', async () => {
		await type('player');
		const listed = hits();
		expect(listed.length).toBeGreaterThan(2);
		await press('ArrowDown');
		await press('ArrowDown');
		await press('ArrowUp');
		expect(all(el, '.hit.on').map((h) => h.title)).toEqual([listed[1]]);
		await press('ArrowUp');
		await press('ArrowUp');
		expect(all(el, '.hit.on').map((h) => h.title)).toEqual([listed.at(-1)]);
		await press('Enter');
		expect(open).toHaveBeenCalledWith(listed.at(-1), true);
	});

	test('a click on a file opens it', async () => {
		await type('player');
		await click(all(el, '.hit').find((h) => h.title === 'src/player/repeat.ts')!);
		expect(open).toHaveBeenCalledWith('src/player/repeat.ts', true);
		expect(box()).toBeNull();
	});

	test('`name:40` opens the file at that line, `name:40:7` at that column', async () => {
		await type('queu:40');
		expect(hits()[0]).toBe('src/player/queue.ts');
		await press('Enter');
		expect(openAt).toHaveBeenCalledWith('src/player/queue.ts', 40, 1);
		expect(open).not.toHaveBeenCalled();

		await key({ key: 'p', metaKey: true });
		await type('queu:40:7');
		await press('Enter');
		expect(openAt).toHaveBeenLastCalledWith('src/player/queue.ts', 40, 7);
	});

	test('a file opened lately leads when nothing is typed, and says so', async () => {
		await press('Escape');
		files.opened('src/styles/app.css');
		await key({ key: 'p', metaKey: true });
		expect(hits()[0]).toBe('src/styles/app.css');
		expect(find(all(el, '.hit')[0], '.tag')!.textContent).toBe('opened lately');
		expect(all(el, '.hit .tag').length).toBe(1);
		await type('app');
		expect(find(el, '.hit .tag')).toBeNull();
	});

	test('a file deleted since the last commit is still in git\'s list, and is left out', async () => {
		await press('Escape');
		w.on('files_list', () => ({ paths: ['docs/old-notes.md', 'docs/shortcuts.md'], truncated: false }));
		await key({ key: 'p', metaKey: true });
		expect(hits()).toEqual(['docs/shortcuts.md']);
	});

	test('a list that was cut short says so', async () => {
		await press('Escape');
		w.on('files_list', () => ({ paths: ['a.ts', 'b.ts'], truncated: true }));
		await key({ key: 'p', metaKey: true });
		expect(note()).toBe('Only the first 2 files of this checkout are listed.');
	});

	test('an empty checkout says so', async () => {
		await press('Escape');
		w.on('files_list', () => ({ paths: [], truncated: false }));
		await key({ key: 'p', metaKey: true });
		expect(note()).toBe('This checkout has no files yet.');
	});

	test('a file name is shown as text', async () => {
		await press('Escape');
		w.on('files_list', () => ({ paths: ['docs/<img src=x onerror="window.pwned = true">.md'], truncated: false }));
		await key({ key: 'p', metaKey: true });
		expect(find(el, '.hit .name')!.textContent).toBe('<img src=x onerror="window.pwned = true">.md');
		expect(find(el, '.hit img')).toBeNull();
	});
});

describe('while the list of files is being read', () => {
	test('it says so, and the files show as soon as they arrive', async () => {
		let arrive: (list: { paths: string[]; truncated: boolean }) => void = () => {};
		w.on('files_list', () => new Promise((resolve) => (arrive = resolve)));
		await key({ key: 'p', metaKey: true });
		expect(note()).toBe('Reading the list of files…');
		arrive({ paths: ['src/main.ts'], truncated: false });
		await settle();
		expect(hits()).toEqual(['src/main.ts']);
		expect(note()).toBe('');
	});
});

describe('a symbol with @', () => {
	test.each([
		['Cmd', { metaKey: true }],
		['Ctrl', { ctrlKey: true }],
	])('%s+T opens the box with @ typed, and starts the servers for the languages the checkout has', async (_name, mods) => {
		await key({ key: 't', ...mods });
		expect(box()!.value).toBe('@');
		expect(cover).toHaveBeenCalledTimes(1);
		expect(cover.mock.calls[0][0]).toContain('src/player/queue.ts');
		expect(hits()).toEqual([]);
	});

	test('typing @ in the files box is the same thing', async () => {
		await key({ key: 'p', metaKey: true });
		await type('@');
		expect(cover).toHaveBeenCalledTimes(1);
		expect(hits()).toEqual([]);
	});

	test('it says what it searches', async () => {
		coverage = { covered: ['TypeScript', 'Rust'], without: [] };
		await key({ key: 't', metaKey: true });
		expect(note()).toBe('Searches TypeScript and Rust.');
	});

	test('it says which languages have no server, and where to get one', async () => {
		coverage = { covered: ['TypeScript'], without: ['PHP', 'C#', 'Go'] };
		await key({ key: 't', metaKey: true });
		expect(note()).toBe('Searches TypeScript. No language server answers for PHP, C# and Go: see Settings > Language servers.');
	});

	test('with no server at all it says nothing can be searched yet', async () => {
		coverage = { covered: [], without: ['PHP'] };
		await key({ key: 't', metaKey: true });
		expect(note()).toBe('Nothing can be searched yet. No language server answers for PHP: see Settings > Language servers.');
	});

	test('a checkout with no language a server knows says so', async () => {
		coverage = { covered: [], without: [] };
		await key({ key: 't', metaKey: true });
		expect(note()).toBe('This checkout has no files in a language that has a language server here, so there are no symbols to search.');
	});

	test('while the servers start it says so', async () => {
		cover.mockImplementation(() => new Promise(() => {}));
		await key({ key: 't', metaKey: true });
		expect(note()).toBe('Starting the language servers for this checkout…');
	});

	test('what is typed after the @ is asked of the servers, and each answer says what it is and where', async () => {
		symbols = [symbol('nextRepeatMode', { path: 'src/player/repeat.ts', line: 5 }), symbol('next', { kind: 5, container: 'Queue' })];
		await key({ key: 't', metaKey: true });
		await type('@next');
		expect(findSymbols).toHaveBeenLastCalledWith('next');
		expect(all(el, '.hit').map((h) => [...h.children].map((c) => c.textContent))).toEqual([
			['nextRepeatMode', 'function', 'src/player/repeat.ts:5'],
			['next', 'method in Queue', 'src/player/queue.ts:8'],
		]);
		expect(note()).toBe('');
	});

	test('names that start with what was typed come first', async () => {
		symbols = [symbol('preNext'), symbol('NextUp'), symbol('renext'), symbol('next')];
		await key({ key: 't', metaKey: true });
		await type('@next');
		expect(all(el, '.hit .name').map((n) => n.textContent)).toEqual(['NextUp', 'next', 'preNext', 'renext']);
	});

	test('Enter goes to the symbol\'s file, line and column in the Files tab', async () => {
		symbols = [symbol('next', { line: 8, column: 2 }), symbol('nextUp', { line: 30, column: 1 })];
		await key({ key: 't', metaKey: true });
		await type('@next');
		await press('ArrowDown');
		await press('Enter');
		expect(openAt).toHaveBeenCalledWith('src/player/queue.ts', 30, 1);
		expect(repos.tab()).toBe('files');
		expect(box()).toBeNull();
	});

	test('a click on a symbol goes to it', async () => {
		symbols = [symbol('next')];
		await key({ key: 't', metaKey: true });
		await type('@next');
		await click(find(el, '.hit'));
		expect(openAt).toHaveBeenCalledWith('src/player/queue.ts', 8, 2);
	});

	test('more than fifty answers show the first fifty and say how many there are', async () => {
		symbols = Array.from({ length: 60 }, (_, i) => symbol(`item${i}`));
		await key({ key: 't', metaKey: true });
		await type('@item');
		expect(all(el, '.hit').length).toBe(50);
		expect(note()).toBe('The first 50 of 60. Type more to narrow it down.');
	});

	test('an empty answer from servers that have only just started is not taken for "nothing"', async () => {
		await key({ key: 't', metaKey: true });
		await type('@gone');
		expect(note()).toBe('The language servers are still reading the project…');
	});

	test('once the servers have had their time, nothing found is said as that', async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		await key({ key: 't', metaKey: true });
		clock.mockReturnValue(now + 12_001);
		await type('@gone');
		expect(note()).toBe('Nothing named like "gone".');
	});

	test('with no server to ask, it says what the search covers instead of "nothing"', async () => {
		coverage = { covered: [], without: ['PHP'] };
		symbols = null;
		await key({ key: 't', metaKey: true });
		await type('@thing');
		expect(note()).toBe('Nothing can be searched yet. No language server answers for PHP: see Settings > Language servers.');
	});

	test('closing the box closes the files that were shown to the servers for the search', async () => {
		await key({ key: 't', metaKey: true });
		expect(uncover).not.toHaveBeenCalled();
		await press('Escape');
		expect(uncover).toHaveBeenCalledTimes(1);
	});

	test('what a server answers is shown as text', async () => {
		symbols = [symbol('<img src=x onerror="window.pwned = true">', { container: '<b>Queue</b>' })];
		await key({ key: 't', metaKey: true });
		await type('@img');
		expect(find(el, '.hit .name')!.textContent).toBe('<img src=x onerror="window.pwned = true">');
		expect(find(el, '.hit .kind')!.textContent).toBe('function in <b>Queue</b>');
		expect(all(el, '.hit img, .hit .kind b')).toEqual([]);
	});
});
