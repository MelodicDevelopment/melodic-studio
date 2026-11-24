import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { ExplorerStore } from '../../services/explorer.store';
import type { SearchStore } from '../../services/search.store';
import type { SearchMatch } from '../../shared/search';

// Monaco cannot run in happy-dom: the file a result would open is watched for, not opened.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));

let w: World;
let repos: RepoStore;
let search: SearchStore;
let openAt: MockInstance<ExplorerStore['openAt']>;
let el: HTMLElement;
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

/** The search waits 220 ms after a keystroke: here that pause is over at once. */
const realTimeout = window.setTimeout.bind(window);
function noTypingPause(): void {
	vi.spyOn(window, 'setTimeout').mockImplementation(((run: () => void, ms?: number, ...rest: unknown[]) => realTimeout(run, ms === 220 ? 0 : ms, ...rest)) as typeof window.setTimeout);
}

/** The app on this platform (`navigator.platform` is what `isMac()` reads), with the box on screen. */
async function start(on = 'MacIntel'): Promise<void> {
	Object.defineProperty(navigator, 'platform', { value: on, configurable: true });
	w = await world();
	forgetElements();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	search = w.get((await import('../../services/search.store')).SearchStore);
	openAt = vi.spyOn(w.get((await import('../../services/explorer.store')).ExplorerStore), 'openAt').mockResolvedValue(undefined as never);
	noTypingPause();
	await repos.init();
	el = await mount('ms-find-in-files');
}

beforeEach(() => start());

afterEach(() => {
	if (platform) {
		Object.defineProperty(navigator, 'platform', platform);
	}
});

function box(): HTMLInputElement {
	return find<HTMLInputElement>(el, '.box input')!;
}

/** Types into the box; the search follows once the typing pauses. */
async function type(value: string): Promise<void> {
	box().value = value;
	box().dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}

async function press(target: Element, name: string): Promise<KeyboardEvent> {
	const event = new KeyboardEvent('keydown', { key: name, bubbles: true, composed: true, cancelable: true });
	target.dispatchEvent(event);
	await settle();
	return event;
}

function status(): string {
	return find(el, '.status')?.textContent ?? '';
}

/** Each file of the results: its name, folder and count. */
function fileRows(): string[][] {
	return all(el, '.results .file').map((f) => [find(f, '.name')!.textContent!, find(f, '.dir')!.textContent!, find(f, '.count')!.textContent!]);
}

function hitRows(): HTMLElement[] {
	return all(el, '.results .hit');
}

function option(title: string): HTMLButtonElement {
	return find<HTMLButtonElement>(el, `.opt[title="${title}"]`)!;
}

function match(path: string, line: number, text: string, column = 1): SearchMatch {
	return { path, line, column, text, start: 0 };
}

describe('the box', () => {
	test('names its shortcut the Mac way on a Mac', () => {
		expect(box().placeholder).toBe('Find in files (⇧⌘F)');
	});

	test.each(['Win32', 'Linux x86_64'])('names its shortcut with Ctrl on %s', async (system) => {
		await start(system);
		expect(box().placeholder).toBe('Find in files (Ctrl+Shift+F)');
	});

	test('with nothing typed there is no status and no result', () => {
		expect(find(el, '.status')).toBeNull();
		expect(find(el, '.results')).toBeNull();
		expect(w.sent('files_search')).toEqual([]);
	});

	test('the search runs once the typing pauses, on the text as it was typed', async () => {
		await type('nextRepeatMode');
		expect(w.sent('files_search').length).toBe(1);
		expect(w.sent('files_search')[0].args).toEqual({ id: repos.repo()!.id, pattern: 'nextRepeatMode', options: { matchCase: false, wholeWord: false, regex: false } });
	});

	test('Enter searches at once', async () => {
		vi.mocked(window.setTimeout).mockRestore();
		box().value = 'Queue';
		box().dispatchEvent(new Event('input', { bubbles: true }));
		const event = await press(box(), 'Enter');
		expect(event.defaultPrevented).toBe(true);
		expect(w.sent('files_search').length).toBe(1);
	});

	test('while git looks it says so', async () => {
		w.on('files_search', () => new Promise(() => {}));
		await type('Queue');
		expect(status()).toBe('Searching…');
		expect(find(el, '.box ml-spinner')).not.toBeNull();
	});

	test('the cross and Esc both clear the search', async () => {
		await type('Queue');
		await click(find(el, '[title="Clear (Esc)"]'));
		expect(box().value).toBe('');
		expect(find(el, '.results')).toBeNull();
		await type('Queue');
		const event = await press(box(), 'Escape');
		expect(event.defaultPrevented).toBe(true);
		expect(search.query()).toBe('');
		expect(find(el, '.status')).toBeNull();
	});

	test('the shortcut puts the cursor in the box with what is there selected', async () => {
		await type('Queue');
		const select = vi.spyOn(box(), 'select');
		search.ask();
		await settle();
		expect(el.shadowRoot!.activeElement).toBe(box());
		expect(select).toHaveBeenCalled();
	});

	test('the editor\'s selection is what the shortcut starts with', async () => {
		search.selection = () => 'previous';
		search.ask();
		await settle();
		expect(box().value).toBe('previous');
		expect(w.sent('files_search').at(-1)!.args.pattern).toBe('previous');
	});
});

describe('the results', () => {
	test('are counted, and listed under their files with a line number each', async () => {
		await type('RepeatMode');
		expect(status()).toMatch(/^\d+ results in 2 files$/);
		expect(fileRows().map((f) => f.slice(0, 2))).toEqual([
			['main.ts', 'src'],
			['repeat.ts', 'src/player'],
		]);
		expect(fileRows().map((f) => Number(f[2])).reduce((a, b) => a + b, 0)).toBe(hitRows().length);
		expect(hitRows()[0].title).toMatch(/^src\/main\.ts:\d+$/);
		expect(find(hitRows()[0], '.ln')!.textContent).toBe(hitRows()[0].title.split(':')[1]);
	});

	test('what matched is marked in each line', async () => {
		await type('repeatmode');
		for (const hit of hitRows()) {
			const marked = all(hit, '.text b').map((b) => b.textContent!.toLowerCase());
			expect(marked.length).toBeGreaterThan(0);
			expect(marked.every((m) => m === 'repeatmode')).toBe(true);
		}
	});

	test('one result in one file is said in the singular', async () => {
		w.on('files_search', () => ({ matches: [match('src/main.ts', 4, 'const queue = new Queue();')], truncated: false }));
		await type('new Queue');
		expect(status()).toBe('1 result in 1 file');
	});

	test('nothing found says so, and what is not searched', async () => {
		await type('there-is-no-such-text');
		expect(status()).toBe('No results. Files that .gitignore leaves out and binary files are not searched.');
		expect(hitRows()).toEqual([]);
	});

	test('a search cut off at the 2,000-line cap says there are more', async () => {
		w.on('files_search', () => ({ matches: [match('a.ts', 1, 'x'), match('b.ts', 1, 'x')], truncated: true }));
		await type('x');
		expect(status()).toBe('The first 2,000 results (2 files). There are more: narrow the search to see them.');
	});

	test('a result opens its file at that line and column, and stays marked', async () => {
		w.on('files_search', () => ({ matches: [match('src/main.ts', 4, 'const queue = new Queue();', 19), match('src/main.ts', 9, 'queue.next()')], truncated: false }));
		await type('Queue');
		await click(hitRows()[0]);
		expect(openAt).toHaveBeenCalledWith('src/main.ts', 4, 19);
		expect(hitRows().map((h) => h.classList.contains('sel'))).toEqual([true, false]);
	});

	test('a file\'s results fold away on its name and come back', async () => {
		await type('RepeatMode');
		const total = hitRows().length;
		const first = all(el, '.results .file')[0];
		await click(first);
		expect(first.getAttribute('aria-expanded')).toBe('false');
		expect(hitRows().length).toBe(total - Number(fileRows()[0][2]));
		expect(hitRows().every((h) => !h.title.startsWith('src/main.ts'))).toBe(true);
		await click(all(el, '.results .file')[0]);
		expect(hitRows().length).toBe(total);
	});

	test('a line from a file is shown as text', async () => {
		w.on('files_search', () => ({ matches: [match('public/index.html', 3, '<script>window.pwned = true</script><img src=x onerror="window.pwned = true">')], truncated: false }));
		await type('pwned');
		expect(find(hitRows()[0], '.text')!.textContent).toBe('<script>window.pwned = true</script><img src=x onerror="window.pwned = true">');
		expect(all(el, '.results script, .results img')).toEqual([]);
		expect(all(hitRows()[0], '.text b').map((b) => b.textContent)).toEqual(['pwned', 'pwned']);
	});

	test('a file name is shown as text too', async () => {
		w.on('files_search', () => ({ matches: [match('docs/<img src=x onerror="window.pwned = true">.md', 1, 'x')], truncated: false }));
		await type('x');
		expect(fileRows()[0][0]).toBe('<img src=x onerror="window.pwned = true">.md');
		expect(find(el, '.results .file img')).toBeNull();
	});

	test('the arrow keys walk from the box down the results and back', async () => {
		await type('RepeatMode');
		const rows = all(el, '.results button');
		await press(box(), 'ArrowDown');
		expect(el.shadowRoot!.activeElement).toBe(rows[0]);
		await press(rows[0], 'ArrowDown');
		expect(el.shadowRoot!.activeElement).toBe(rows[1]);
		await press(rows[1], 'ArrowUp');
		await press(rows[0], 'ArrowUp');
		expect(el.shadowRoot!.activeElement).toBe(box());
	});
});

describe('the options', () => {
	test('are off to begin with', () => {
		expect(['Match case', 'Whole word', 'Regular expression'].map((t) => option(t).getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false']);
	});

	test.each([
		['Match case', 'matchCase'],
		['Whole word', 'wholeWord'],
		['Regular expression', 'regex'],
	])('"%s" searches again with it on, and is remembered', async (title, key) => {
		await type('queue');
		await click(option(title));
		expect(option(title).getAttribute('aria-pressed')).toBe('true');
		expect(w.sent('files_search').length).toBe(2);
		expect((w.sent('files_search')[1].args.options as Record<string, boolean>)[key]).toBe(true);
		expect(JSON.parse(localStorage.getItem('studio.search.options')!)[key]).toBe(true);
		await click(option(title));
		expect(option(title).getAttribute('aria-pressed')).toBe('false');
	});

	test('with "Match case" only the same case is marked', async () => {
		w.on('files_search', () => ({ matches: [match('src/main.ts', 1, 'Queue queue QUEUE')], truncated: false }));
		await type('queue');
		expect(all(hitRows()[0], '.text b').map((b) => b.textContent)).toEqual(['Queue', 'queue', 'QUEUE']);
		await click(option('Match case'));
		expect(all(hitRows()[0], '.text b').map((b) => b.textContent)).toEqual(['queue']);
	});

	test('an expression git refuses is said in git\'s words', async () => {
		w.on('files_search', () => {
			throw appError('git', 'fatal: command line, \'(\': Unmatched ( or \\(');
		});
		await click(option('Regular expression'));
		await type('(');
		expect(status()).toBe("fatal: command line, '(': Unmatched ( or \\(");
		expect(find(el, '.status')!.classList.contains('bad')).toBe(true);
		expect(hitRows()).toEqual([]);
	});
});

describe('what is kept', () => {
	test('the search outlives the box: the sidebar is rebuilt on every tab switch', async () => {
		await type('RepeatMode');
		const hits = hitRows().length;
		el.remove();
		el = await mount('ms-find-in-files');
		expect(box().value).toBe('RepeatMode');
		expect(hitRows().length).toBe(hits);
		expect(w.sent('files_search').length).toBe(1);
	});

	test('an answer to an older search is dropped', async () => {
		const answers: ((result: { matches: SearchMatch[]; truncated: boolean }) => void)[] = [];
		w.on('files_search', () => new Promise((resolve) => answers.push(resolve)));
		await type('first');
		await type('second');
		answers[1]({ matches: [match('b.ts', 1, 'second')], truncated: false });
		await settle();
		answers[0]({ matches: [match('a.ts', 1, 'first'), match('a.ts', 2, 'first')], truncated: false });
		await settle();
		expect(hitRows().map((h) => h.title)).toEqual(['b.ts:1']);
	});

	test('another repository on screen is searched afresh', async () => {
		await type('RepeatMode');
		await repos.selectRepo('/Users/demo/Source/cadence');
		await settle();
		expect(w.sent('files_search').at(-1)!.args.id).toBe('/Users/demo/Source/cadence');
		expect(status()).toBe('No results. Files that .gitignore leaves out and binary files are not searched.');
	});
});
