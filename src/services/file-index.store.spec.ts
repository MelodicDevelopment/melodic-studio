import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../test/world';
import { all, mount, text } from '../test/dom';
import { fakeMonaco } from './monaco-fake.spec-helper';
import type { FileIndexStore } from './file-index.store';
import type { RepoStore } from './repo.store';

// Only the "Go to" box at the end needs these two: it brings the editor's stores and the language servers along.
vi.mock('../shared/monaco', async () => (await import('./monaco-fake.spec-helper')).monacoModule());
vi.mock('./lsp.service', () => ({
	LspService: class {
		cover = async () => null;
		findSymbols = async () => null;
		uncover(): void {}
	},
}));

const HARMONY = '/Users/demo/Source/harmony';
const CADENCE = '/Users/demo/Source/cadence';
const TREE = '/Users/demo/Source/harmony.worktrees/shuffle';
const RECENT_KEY = 'studio.files.recent';

let w: World;
let repos: RepoStore;
let index: FileIndexStore;
/** What `git ls-files` lists in the checkout on screen. */
let listed: string[];

/** The app with a repository open; `before` runs once storage is empty and before any store exists. */
async function start(before: () => void = () => undefined): Promise<void> {
	w = await world();
	before();
	listed = ['README.md', 'src/main.ts', 'src/player/queue.ts'];
	w.on('files_list', () => ({ paths: [...listed], truncated: false }));
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	index = w.get((await import('./file-index.store')).FileIndexStore);
}

async function showWorktree(path: string | null): Promise<void> {
	const { BackendService } = await import('./backend.service');
	await w.get(BackendService).selectWorktree(HARMONY, path);
	await repos.switchContext();
}

/** An answer that waits until the test lets it go. */
function gate(): { wait: Promise<void>; open: () => void } {
	let open!: () => void;
	const wait = new Promise<void>((resolve) => (open = resolve));
	return { wait, open };
}

const saved = (): Record<string, string[]> => JSON.parse(localStorage.getItem(RECENT_KEY) ?? '{}') as Record<string, string[]>;

describe('the list of files', () => {
	beforeEach(() => start());

	test('there is none until it has been read', async () => {
		expect(index.list()).toBeNull();
		expect(w.sent('files_list')).toEqual([]);
		const answer = await index.load();
		expect(w.sent('files_list').map((c) => c.args)).toEqual([{ id: HARMONY }]);
		expect(answer).toBe(index.list());
		expect(index.list()!.index.paths).toEqual(['README.md', 'src/main.ts', 'src/player/queue.ts']);
		expect(index.list()!.truncated).toBe(false);
	});

	test('it is read again each time it is asked for, since files come and go', async () => {
		await index.load();
		listed = ['README.md', 'src/shuffle.ts'];
		await index.load();
		expect(w.sent('files_list').length).toBe(2);
		expect(index.list()!.index.paths).toEqual(['README.md', 'src/shuffle.ts']);
	});

	test('the list already known stays up while the new one is read', async () => {
		await index.load();
		const slow = gate();
		w.on('files_list', async () => {
			await slow.wait;
			return { paths: ['only.ts'], truncated: false };
		});
		const reading = index.load();
		expect(index.list()!.index.paths.length).toBe(3);
		slow.open();
		await reading;
		expect(index.list()!.index.paths).toEqual(['only.ts']);
	});

	test('two requests at once share one read', async () => {
		const [a, b] = await Promise.all([index.load(), index.load()]);
		expect(w.sent('files_list').length).toBe(1);
		expect(a).toBe(b);
	});

	test('a list git cut short says so', async () => {
		w.on('files_list', () => ({ paths: ['a.ts'], truncated: true }));
		await index.load();
		expect(index.list()!.truncated).toBe(true);
	});

	test('a read that fails keeps the list read before; with none before there is none', async () => {
		w.on('files_list', () => {
			throw appError('git', 'fatal: not a git repository');
		});
		expect(await index.load()).toBeNull();
		expect(index.list()).toBeNull();
		w.on('files_list', () => ({ paths: ['a.ts'], truncated: false }));
		await index.load();
		w.on('files_list', () => {
			throw appError('git', 'fatal: index file corrupt');
		});
		const answer = await index.load();
		expect(answer!.index.paths).toEqual(['a.ts']);
		expect(index.list()!.index.paths).toEqual(['a.ts']);
		expect(w.toasts).toEqual([]);
		// A failed read does not stand in the way of the next one.
		w.on('files_list', () => ({ paths: ['b.ts'], truncated: false }));
		await index.load();
		expect(index.list()!.index.paths).toEqual(['b.ts']);
	});

	test('each repository has its own list, still there on return', async () => {
		await index.load();
		await repos.selectRepo(CADENCE);
		expect(index.list()).toBeNull();
		listed = ['cadence.ts'];
		await index.load();
		expect(w.sent('files_list').at(-1)!.args).toEqual({ id: CADENCE });
		expect(index.list()!.index.paths).toEqual(['cadence.ts']);
		const reads = w.sent('files_list').length;
		await repos.selectRepo(HARMONY);
		expect(index.list()!.index.paths).toEqual(['README.md', 'src/main.ts', 'src/player/queue.ts']);
		expect(w.sent('files_list').length).toBe(reads);
	});

	test('a worktree is a checkout of its own under the same repository', async () => {
		await index.load();
		await showWorktree(TREE);
		expect(index.list()).toBeNull();
		listed = ['only-in-the-worktree.ts'];
		await index.load();
		expect(w.sent('files_list').at(-1)!.args).toEqual({ id: HARMONY });
		expect(index.list()!.index.paths).toEqual(['only-in-the-worktree.ts']);
		await showWorktree(null);
		expect(index.list()!.index.paths).toEqual(['README.md', 'src/main.ts', 'src/player/queue.ts']);
	});

	test('a list that arrives after the checkout changed is kept for the checkout it was read in', async () => {
		const slow = gate();
		w.on('files_list', async () => {
			await slow.wait;
			return { paths: ['harmony.ts'], truncated: false };
		});
		const reading = index.load();
		await repos.selectRepo(CADENCE);
		slow.open();
		await reading;
		expect(index.list()).toBeNull();
		await repos.selectRepo(HARMONY);
		expect(index.list()!.index.paths).toEqual(['harmony.ts']);
	});

});

describe('files opened lately', () => {
	beforeEach(() => start());

	test('the latest is first, and a file opened again moves up instead of being listed twice', () => {
		expect(index.recent()).toEqual([]);
		index.opened('a.ts');
		index.opened('b.ts');
		index.opened('c.ts');
		index.opened('a.ts');
		expect(index.recent()).toEqual(['a.ts', 'c.ts', 'b.ts']);
	});

	test('no more than 40 are remembered', () => {
		for (let i = 0; i < 45; i++) {
			index.opened(`file-${i}.ts`);
		}
		expect(index.recent().length).toBe(40);
		expect(index.recent()[0]).toBe('file-44.ts');
		expect(index.recent()).not.toContain('file-4.ts');
		expect(index.recent().at(-1)).toBe('file-5.ts');
	});

	test('each checkout has its own', async () => {
		index.opened('harmony.ts');
		await repos.selectRepo(CADENCE);
		expect(index.recent()).toEqual([]);
		index.opened('cadence.ts');
		await repos.selectRepo(HARMONY);
		expect(index.recent()).toEqual(['harmony.ts']);
		await showWorktree(TREE);
		expect(index.recent()).toEqual([]);
		index.opened('worktree.ts');
		expect(saved()).toEqual({ [TREE]: ['worktree.ts'], [HARMONY]: ['harmony.ts'], [CADENCE]: ['cadence.ts'] });
	});

	test('they are kept on this computer and are there at the next start', async () => {
		index.opened('a.ts');
		index.opened('b.ts');
		expect(saved()).toEqual({ [HARMONY]: ['b.ts', 'a.ts'] });
		const kept = localStorage.getItem(RECENT_KEY)!;
		await start(() => localStorage.setItem(RECENT_KEY, kept));
		expect(index.recent()).toEqual(['b.ts', 'a.ts']);
	});

	test('only 60 checkouts are remembered: the ones used longest ago fall off', async () => {
		const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`/work/tree-${i}`, [`file-${i}.ts`]]));
		await start(() => localStorage.setItem(RECENT_KEY, JSON.stringify(many)));
		index.opened('a.ts');
		const kept = Object.keys(saved());
		expect(kept.length).toBe(60);
		expect(kept[0]).toBe(HARMONY);
		expect(kept).toContain('/work/tree-0');
		expect(kept).not.toContain('/work/tree-59');
	});

	test('storage that cannot be written does not stop a file from being noted', () => {
		// Stubbed whole: happy-dom hands out its own copy of `setItem`, which a spy on the prototype does not reach.
		vi.stubGlobal('localStorage', {
			getItem: () => null,
			setItem: () => {
				throw new Error('blocked');
			},
		});
		try {
			index.opened('a.ts');
		} finally {
			vi.unstubAllGlobals();
		}
		expect(index.recent()).toEqual(['a.ts']);
		expect(localStorage.getItem(RECENT_KEY)).toBeNull();
	});
});

describe('what was saved by an older or broken version', () => {
	test('text that is not JSON counts as nothing', async () => {
		await start(() => localStorage.setItem(RECENT_KEY, '{"/Users/demo'));
		expect(index.recent()).toEqual([]);
		index.opened('a.ts');
		expect(saved()).toEqual({ [HARMONY]: ['a.ts'] });
	});

	test('entries that are not lists are dropped, and so is anything in a list that is not a path', async () => {
		await start(() => localStorage.setItem(RECENT_KEY, JSON.stringify({ [HARMONY]: ['a.ts', 7, null, { path: 'b.ts' }, 'c.ts'], [CADENCE]: 'README.md', '/elsewhere': { 0: 'x' } })));
		expect(index.recent()).toEqual(['a.ts', 'c.ts']);
		await repos.selectRepo(CADENCE);
		expect(index.recent()).toEqual([]);
	});
});

describe('with no repository open', () => {
	test('nothing is read and nothing is noted', async () => {
		w = await world();
		w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: '', authorEmail: '', appVersion: '0.0.0' }));
		repos = w.get((await import('./repo.store')).RepoStore);
		await repos.init();
		index = w.get((await import('./file-index.store')).FileIndexStore);
		expect(await index.load()).toBeNull();
		expect(index.list()).toBeNull();
		index.opened('a.ts');
		expect(index.recent()).toEqual([]);
		expect(w.sent('files_list')).toEqual([]);
		expect(localStorage.getItem(RECENT_KEY)).toBeNull();
	});
});

describe('with the "Go to" box\'s matching (shared/fuzzy.ts)', () => {
	beforeEach(() => start());

	test('with nothing typed, the files opened lately lead, the latest first', async () => {
		const { rankFiles } = await import('../shared/fuzzy');
		listed = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
		await index.load();
		index.opened('c.ts');
		index.opened('d.ts');
		index.opened('no-longer-listed.ts');
		expect(rankFiles(index.list()!.index, '', index.recent(), 10).map((r) => r.path)).toEqual(['d.ts', 'c.ts', 'a.ts', 'b.ts']);
	});

	test('between two files that match alike, the one opened lately wins', async () => {
		const { rankFiles } = await import('../shared/fuzzy');
		listed = ['src/app/index.ts', 'src/web/index.ts'];
		await index.load();
		expect(rankFiles(index.list()!.index, 'index', index.recent(), 10)[0].path).toBe('src/app/index.ts');
		index.opened('src/web/index.ts');
		expect(rankFiles(index.list()!.index, 'index', index.recent(), 10)[0].path).toBe('src/web/index.ts');
	});
});

describe('in the "Go to" box (ms-go-to)', () => {
	let box: HTMLElement;
	let open: () => void;

	// One app for these tests: an element is defined once per page, so the box belongs to the stores of the
	// world it was first imported in, and a later `world()` would leave it looking at those.
	beforeAll(async () => {
		await start();
		await fakeMonaco();
		const { Injectable } = await import('@melodicdev/core/injection');
		const { LspService } = await import('./lsp.service');
		Injectable()(LspService); // the stand-in above is a plain class: the injector has to be told of it
		const goTo = await import('../components/explorer/go-to.component');
		open = () => goTo.openGoTo('files');
		box = await mount('ms-go-to');
	});

	afterEach(async () => {
		// A click beside the box puts it away.
		all(box, '.veil')[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		await settle();
	});

	const offered = (): string[] => all(box, 'button.hit').map((b) => b.getAttribute('title') ?? '');

	test('the list is read again each time the box opens', async () => {
		const reads = w.sent('files_list').length;
		listed = ['README.md', 'src/main.ts'];
		open();
		await settle();
		expect(w.sent('files_list').length).toBe(reads + 1);
		expect(offered()).toEqual(['README.md', 'src/main.ts']);
		all(box, '.veil')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		await settle();
		expect(offered()).toEqual([]);
		listed = ['README.md', 'src/shuffle.ts'];
		open();
		await settle();
		expect(w.sent('files_list').length).toBe(reads + 2);
		expect(offered()).toEqual(['README.md', 'src/shuffle.ts']);
	});

	test('a file the status marks deleted is not offered, though git still lists it', async () => {
		const gone = repos.status()!.files.find((f) => f.status === 'deleted')!.path;
		listed = ['README.md', gone, 'src/main.ts'];
		open();
		await settle();
		expect(index.list()!.index.paths).toContain(gone);
		expect(offered()).toEqual(['README.md', 'src/main.ts']);
	});

	test('a file opened lately leads and is marked so', async () => {
		listed = ['README.md', 'src/main.ts', 'src/player/queue.ts'];
		index.opened('src/main.ts');
		open();
		await settle();
		expect(offered()).toEqual(['src/main.ts', 'README.md', 'src/player/queue.ts']);
		expect(text(all(box, 'button.hit')[0])).toContain('opened lately');
		expect(text(all(box, 'button.hit')[1])).not.toContain('opened lately');
	});
});
