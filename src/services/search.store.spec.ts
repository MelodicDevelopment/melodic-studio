import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../test/world';
import { all, find, mount, text } from '../test/dom';
import { fakeMonaco } from './monaco-fake.spec-helper';
import type { SearchStore } from './search.store';
import type { RepoStore } from './repo.store';
import type { SearchMatch, SearchResult } from '../shared/search';

// Only the last test needs these: the box on the page brings the editor's store along, and the stores behind
// that one bring the language servers' client, which starts itself as soon as it is imported.
vi.mock('../shared/monaco', async () => (await import('./monaco-fake.spec-helper')).monacoModule());
vi.mock('./lsp.service', () => ({ LspService: class {} }));

const HARMONY = '/Users/demo/Source/harmony';
const CADENCE = '/Users/demo/Source/cadence';
const TREE = '/Users/demo/Source/harmony.worktrees/shuffle';
const OPTIONS_KEY = 'studio.search.options';
const OFF = { matchCase: false, wholeWord: false, regex: false };

let w: World;
let repos: RepoStore;
let search: SearchStore;

const line = (path: string, n: number, lineText: string): SearchMatch => ({ path, line: n, column: 1, text: lineText, start: 0 });
const found = (...matches: SearchMatch[]): SearchResult => ({ matches, truncated: false });

/** The app with a repository open; `before` runs once storage is empty and before any store exists. */
async function start(before: () => void = () => undefined): Promise<void> {
	w = await world();
	before();
	// What git finds is each test's to say: by default one line that holds the text.
	w.on('files_search', (args) => found(line('src/main.ts', 1, `// ${String(args.pattern)}`)));
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	search = w.get((await import('./search.store')).SearchStore);
}

async function showWorktree(path: string | null): Promise<void> {
	const { BackendService } = await import('./backend.service');
	await w.get(BackendService).selectWorktree(HARMONY, path);
	await repos.switchContext();
}

/** An answer that waits until the test lets it go, with what it should then be. */
function gate<T>(): { wait: Promise<T>; open: (value: T) => void; fail: (reason: unknown) => void } {
	let open!: (value: T) => void;
	let fail!: (reason: unknown) => void;
	const wait = new Promise<T>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { wait, open, fail };
}

const sent = () => w.sent('files_search').map((c) => c.args);

afterEach(() => {
	vi.useRealTimers();
});

describe('what is sent to git', () => {
	beforeEach(() => start());

	test('the text as it was typed, the repository on screen and the options', async () => {
		search.query.set('queue.next(');
		await search.run();
		expect(sent()).toEqual([{ id: HARMONY, pattern: 'queue.next(', options: OFF }]);
	});

	test('an option turned on goes with the search, which runs again at once', async () => {
		search.query.set('Queue');
		await search.run();
		search.setOption('matchCase', true);
		search.setOption('regex', true);
		await settle();
		expect(sent().map((a) => a.options)).toEqual([OFF, { matchCase: true, wholeWord: false, regex: false }, { matchCase: true, wholeWord: false, regex: true }]);
		expect(sent().every((a) => a.pattern === 'Queue')).toBe(true);
		search.setOption('matchCase', false);
		await settle();
		expect(sent().at(-1)!.options).toEqual({ matchCase: false, wholeWord: false, regex: true });
	});

	test('an option changed with nothing typed is remembered and searches nothing', async () => {
		search.setOption('wholeWord', true);
		await settle();
		expect(sent()).toEqual([]);
		expect(search.busy()).toBe(false);
		expect(search.options().wholeWord).toBe(true);
	});

	test('nothing typed, nothing searched', async () => {
		await search.run();
		expect(sent()).toEqual([]);
		expect(search.busy()).toBe(false);
		expect(search.active()).toBe(false);
	});
});

describe('the options', () => {
	test('are all off the first time', async () => {
		await start();
		expect(search.options()).toEqual(OFF);
	});

	test('are kept on this computer and are there at the next start', async () => {
		await start();
		search.setOption('wholeWord', true);
		search.setOption('regex', true);
		const kept = localStorage.getItem(OPTIONS_KEY)!;
		expect(JSON.parse(kept)).toEqual({ matchCase: false, wholeWord: true, regex: true });
		await start(() => localStorage.setItem(OPTIONS_KEY, kept));
		expect(search.options()).toEqual({ matchCase: false, wholeWord: true, regex: true });
	});

	test('saved text that is not JSON counts as all off', async () => {
		await start(() => localStorage.setItem(OPTIONS_KEY, '{"matchCase":'));
		expect(search.options()).toEqual(OFF);
	});

	test('only a saved `true` turns an option on, and what is not an option is dropped', async () => {
		await start(() => localStorage.setItem(OPTIONS_KEY, JSON.stringify({ matchCase: 'yes', wholeWord: 1, regex: true, fuzzy: true })));
		expect(search.options()).toEqual({ matchCase: false, wholeWord: false, regex: true });
	});

	test('storage that cannot be written does not stop an option from changing', async () => {
		await start();
		search.query.set('queue');
		vi.stubGlobal('localStorage', {
			getItem: () => null,
			setItem: () => {
				throw new Error('blocked');
			},
		});
		try {
			search.setOption('matchCase', true);
		} finally {
			vi.unstubAllGlobals();
		}
		await settle();
		expect(search.options().matchCase).toBe(true);
		expect(sent().at(-1)!.options).toMatchObject({ matchCase: true });
	});
});

describe('typing', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		await start();
	});

	test('searches once the typing has paused, for the text as it then is', async () => {
		search.type('q');
		await vi.advanceTimersByTimeAsync(150);
		search.type('qu');
		await vi.advanceTimersByTimeAsync(150);
		search.type('queue');
		expect(search.query()).toBe('queue');
		expect(search.active()).toBe(true);
		await vi.advanceTimersByTimeAsync(200);
		expect(sent()).toEqual([]);
		await vi.advanceTimersByTimeAsync(50);
		expect(sent().map((a) => a.pattern)).toEqual(['queue']);
		expect(search.result()!.matches[0].text).toBe('// queue');
	});

	test('Enter searches at once and the pause that was pending does not search again', async () => {
		search.type('queue');
		await search.run();
		await vi.advanceTimersByTimeAsync(1000);
		expect(sent().length).toBe(1);
	});

	test('emptying the box puts the results away and searches nothing', async () => {
		search.type('queue');
		await vi.advanceTimersByTimeAsync(300);
		search.fold('src/main.ts');
		search.opened.set('src/main.ts:1');
		search.type('que');
		search.type('');
		await vi.advanceTimersByTimeAsync(1000);
		expect(sent().length).toBe(1);
		expect(search.active()).toBe(false);
		expect(search.result()).toBeNull();
		expect(search.folded().size).toBe(0);
		expect(search.opened()).toBe('');
		expect(search.busy()).toBe(false);
	});

	test('clearing while the typing pause is pending searches nothing', async () => {
		search.type('queue');
		search.clear();
		await vi.advanceTimersByTimeAsync(1000);
		expect(sent()).toEqual([]);
		expect(search.query()).toBe('');
	});
});

describe('the answer', () => {
	beforeEach(() => start());

	test('is busy while git looks, then holds what git found', async () => {
		const git = gate<SearchResult>();
		w.on('files_search', () => git.wait);
		search.query.set('queue');
		const running = search.run();
		expect(search.busy()).toBe(true);
		expect(search.result()).toBeNull();
		const answer = found(line('src/main.ts', 4, 'const queue = new Queue();'), line('src/player/queue.ts', 3, 'export class Queue {'));
		git.open(answer);
		await running;
		expect(search.busy()).toBe(false);
		expect(search.result()).toEqual(answer);
		expect(search.error()).toBe('');
	});

	test('says when there were more matching lines than are listed', async () => {
		w.on('files_search', () => ({ matches: [line('a.ts', 1, 'x')], truncated: true }));
		search.query.set('x');
		await search.run();
		expect(search.result()!.truncated).toBe(true);
	});

	test('an answer to an older search that arrives late is dropped', async () => {
		const older = gate<SearchResult>();
		const newer = gate<SearchResult>();
		w.on('files_search', (args) => (args.pattern === 'que' ? older.wait : newer.wait));
		search.query.set('que');
		const first = search.run();
		search.query.set('queue');
		const second = search.run();
		newer.open(found(line('new.ts', 1, 'queue')));
		await second;
		expect(search.busy()).toBe(false);
		older.open(found(line('old.ts', 1, 'que'), line('old.ts', 2, 'que')));
		await first;
		expect(search.result()!.matches.map((m) => m.path)).toEqual(['new.ts']);
		expect(search.busy()).toBe(false);
	});

	test('an older search that ends first neither shows nor stops the spinner of the newer one', async () => {
		const older = gate<SearchResult>();
		const newer = gate<SearchResult>();
		w.on('files_search', (args) => (args.pattern === 'que' ? older.wait : newer.wait));
		search.query.set('que');
		const first = search.run();
		search.query.set('queue');
		const second = search.run();
		older.open(found(line('old.ts', 1, 'que')));
		await first;
		expect(search.result()).toBeNull();
		expect(search.busy()).toBe(true);
		newer.open(found(line('new.ts', 1, 'queue')));
		await second;
		expect(search.result()!.matches.map((m) => m.path)).toEqual(['new.ts']);
		expect(search.busy()).toBe(false);
	});

	test('an older search that fails late does not replace the newer answer with its complaint', async () => {
		const older = gate<SearchResult>();
		w.on('files_search', (args) => (args.pattern === 'que(' ? older.wait : found(line('new.ts', 1, 'queue'))));
		search.setOption('regex', true);
		search.query.set('que(');
		const first = search.run();
		search.query.set('queue');
		await search.run();
		older.fail(appError('git', 'fatal: command line, \'que(\': parentheses not balanced'));
		await first;
		expect(search.error()).toBe('');
		expect(search.result()!.matches.map((m) => m.path)).toEqual(['new.ts']);
	});

	test('an answer that arrives after the box was cleared is dropped', async () => {
		const git = gate<SearchResult>();
		w.on('files_search', () => git.wait);
		search.query.set('queue');
		const running = search.run();
		search.clear();
		expect(search.busy()).toBe(false);
		git.open(found(line('a.ts', 1, 'queue')));
		await running;
		expect(search.result()).toBeNull();
		expect(search.query()).toBe('');
		expect(search.busy()).toBe(false);
	});

	test('an expression git refuses is said in git\'s words, and the old results go', async () => {
		search.query.set('queue');
		await search.run();
		w.on('files_search', () => {
			throw appError('git', 'fatal: command line, \'que(\': parentheses not balanced');
		});
		search.setOption('regex', true);
		search.query.set('que(');
		await search.run();
		expect(search.error()).toBe('fatal: command line, \'que(\': parentheses not balanced');
		expect(search.result()).toBeNull();
		expect(search.busy()).toBe(false);
		// Said beside the box, not as a toast over the window.
		expect(w.toasts).toEqual([]);
	});

	test('the next search that works takes the complaint away', async () => {
		w.on('files_search', () => {
			throw appError('git', 'fatal: unmatched [');
		});
		search.query.set('[a');
		await search.run();
		expect(search.error()).toBe('fatal: unmatched [');
		w.on('files_search', () => found(line('a.ts', 1, '[a]')));
		search.query.set('[a]');
		await search.run();
		expect(search.error()).toBe('');
		expect(search.result()!.matches.length).toBe(1);
	});

	test('a failure with no words of its own is still said', async () => {
		w.on('files_search', () => Promise.reject('git is not installed'));
		search.query.set('queue');
		await search.run();
		expect(search.error()).toBe('git is not installed');
	});

	test('clearing takes a complaint away too', async () => {
		w.on('files_search', () => {
			throw appError('git', 'fatal: unmatched [');
		});
		search.query.set('[a');
		await search.run();
		search.clear();
		expect(search.error()).toBe('');
	});
});

describe('the results list', () => {
	beforeEach(() => start());

	test('a file\'s matches fold away and back', () => {
		search.fold('src/main.ts');
		search.fold('README.md');
		expect([...search.folded()].sort()).toEqual(['README.md', 'src/main.ts']);
		search.fold('src/main.ts');
		expect([...search.folded()]).toEqual(['README.md']);
	});

	test('a new answer starts with every file unfolded', async () => {
		search.query.set('queue');
		await search.run();
		search.fold('src/main.ts');
		await search.run();
		expect(search.folded().size).toBe(0);
	});
});

describe('Cmd/Ctrl+Shift+F', () => {
	beforeEach(() => start());

	test('asks the box to take the keyboard, every time', () => {
		search.ask();
		search.ask();
		expect(search.focusAsked()).toBe(2);
		expect(sent()).toEqual([]);
	});

	test('starts from the editor\'s selection and searches it at once', async () => {
		search.selection = () => 'nextRepeatMode';
		search.ask();
		expect(search.query()).toBe('nextRepeatMode');
		expect(search.focusAsked()).toBe(1);
		await settle();
		expect(sent().map((a) => a.pattern)).toEqual(['nextRepeatMode']);
		expect(search.result()).not.toBeNull();
	});

	test('with nothing selected, or what is already in the box, the search in the box stays as it is', async () => {
		search.query.set('queue');
		await search.run();
		const before = search.result();
		search.selection = () => '';
		search.ask();
		search.selection = () => 'queue';
		search.ask();
		await settle();
		expect(search.query()).toBe('queue');
		expect(sent().length).toBe(1);
		expect(search.result()).toBe(before);
		expect(search.focusAsked()).toBe(2);
	});
});

describe('another checkout on screen', () => {
	beforeEach(() => start());

	test('the search runs again there, since the answer was the old checkout\'s', async () => {
		search.query.set('queue');
		await search.run();
		await repos.selectRepo(CADENCE);
		search.checkoutChanged();
		await settle();
		expect(sent().map((a) => a.id)).toEqual([HARMONY, CADENCE]);
		expect(sent()[1]).toMatchObject({ pattern: 'queue', options: OFF });
	});

	test('a worktree of the same repository counts as another checkout', async () => {
		search.query.set('queue');
		await search.run();
		await showWorktree(TREE);
		search.checkoutChanged();
		await settle();
		expect(sent().length).toBe(2);
		await showWorktree(null);
		search.checkoutChanged();
		await settle();
		expect(sent().length).toBe(3);
	});

	test('the same checkout still on screen searches nothing again', async () => {
		search.query.set('queue');
		await search.run();
		search.checkoutChanged();
		search.checkoutChanged();
		await settle();
		expect(sent().length).toBe(1);
	});

	test('with nothing in the box there is nothing to run again', async () => {
		await repos.selectRepo(CADENCE);
		search.checkoutChanged();
		await settle();
		expect(sent()).toEqual([]);
	});

	test('an answer for the checkout that was left is replaced by the new checkout\'s, whichever arrives first', async () => {
		const old = gate<SearchResult>();
		w.on('files_search', (args) => (args.id === HARMONY ? old.wait : found(line('cadence.ts', 1, 'queue'))));
		search.query.set('queue');
		const first = search.run();
		await repos.selectRepo(CADENCE);
		search.checkoutChanged();
		await settle();
		old.open(found(line('harmony.ts', 1, 'queue')));
		await first;
		expect(search.result()!.matches.map((m) => m.path)).toEqual(['cadence.ts']);
	});
});

describe('with no repository open', () => {
	test('nothing is searched', async () => {
		w = await world();
		w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: '', authorEmail: '', appVersion: '0.0.0' }));
		repos = w.get((await import('./repo.store')).RepoStore);
		await repos.init();
		search = w.get((await import('./search.store')).SearchStore);
		search.query.set('queue');
		await search.run();
		expect(w.sent('files_search')).toEqual([]);
		expect(search.busy()).toBe(false);
	});
});

describe('on the page (ms-find-in-files)', () => {
	test('the text, its options and the answer outlive the box, which is rebuilt on every tab switch', async () => {
		await start();
		await fakeMonaco();
		await import('../components/explorer/find-in-files.component');
		w.on('files_search', () => found(line('src/player/queue.ts', 8, 'next(repeat = false): Track | null {')));
		search.setOption('matchCase', true);
		search.query.set('next(');
		await search.run();
		const searches = sent().length;

		const first = await mount('ms-find-in-files');
		expect(find<HTMLInputElement>(first, 'input')!.value).toBe('next(');
		expect(text(first)).toContain('1 result in 1 file');
		expect(all(first, 'button.hit').map((b) => b.getAttribute('title'))).toEqual(['src/player/queue.ts:8']);
		first.remove();
		await settle();
		expect(search.query()).toBe('next(');
		expect(search.result()!.matches.length).toBe(1);

		const second = await mount('ms-find-in-files');
		expect(find<HTMLInputElement>(second, 'input')!.value).toBe('next(');
		expect(all(second, 'button.hit').map((b) => b.getAttribute('title'))).toEqual(['src/player/queue.ts:8']);
		expect(find(second, 'button.matchCase')!.getAttribute('aria-pressed')).toBe('true');
		// Shown from what the store holds: git was not asked again.
		expect(sent().length).toBe(searches);
	});
});
