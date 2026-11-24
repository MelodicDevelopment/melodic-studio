import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../test/world';
import { fakeMonaco, type FakeModel, type FakeMonaco } from './monaco-fake.spec-helper';
import type { ExplorerStore } from './explorer.store';
import type { RepoStore } from './repo.store';
import type { EditorSettingsStore } from './editor-settings.store';
import type { FileContent, TreeEntry } from './backend.service';

vi.mock('../shared/monaco', async () => (await import('./monaco-fake.spec-helper')).monacoModule());

const HARMONY = '/Users/demo/Source/harmony';
const CADENCE = '/Users/demo/Source/cadence';
const TREE = '/Users/demo/Source/harmony.worktrees/shuffle';

const PICTURE: FileContent = { text: '', binary: true, tooLarge: false, size: 48_211 };
const HUGE: FileContent = { text: '', binary: false, tooLarge: true, size: 9_000_000 };

let w: World;
let repos: RepoStore;
let explorer: ExplorerStore;
let settings: EditorSettingsStore;
let monaco: FakeMonaco;
/** The checkout's files as the native side would find them. One disk for every checkout: the tests say which is on screen. */
let files: Map<string, string | FileContent>;
/** With the clock held (`vi.useFakeTimers`), waiting is advancing it. */
let held = false;
/** What the app hooked onto the window in a test (auto-save listens for the window losing focus), unhooked after it: the window outlives the test. */
const hooked: [string, EventListenerOrEventListenerObject][] = [];
const hook = window.addEventListener.bind(window);

const pause = async (): Promise<void> => {
	if (held) {
		await vi.advanceTimersByTimeAsync(1);
	} else {
		await settle();
	}
};

function listing(dir: string): TreeEntry[] {
	const prefix = dir ? `${dir}/` : '';
	const seen = new Map<string, TreeEntry>();
	for (const path of files.keys()) {
		if (path.startsWith(prefix)) {
			const rest = path.slice(prefix.length);
			const name = rest.split('/')[0];
			seen.set(name, { name, path: prefix + name, isDir: rest.includes('/'), ignored: false });
		}
	}
	if (dir && !seen.size) {
		throw appError('error', `${dir} no longer exists`);
	}
	return [...seen.values()];
}

function reading(path: string): FileContent {
	const file = files.get(path);
	if (file === undefined) {
		throw appError('error', `${path} no longer exists`);
	}
	return typeof file === 'string' ? { text: file, binary: false, tooLarge: false, size: file.length } : file;
}

function writing(path: string, text: string): void {
	if (!files.has(path)) {
		throw appError('error', `${path} is not a file`); // saving never creates one
	}
	files.set(path, text);
}

/** An answer that waits until the test lets it go. */
function gate(): { wait: Promise<void>; open: () => void } {
	let open!: () => void;
	const wait = new Promise<void>((resolve) => (open = resolve));
	return { wait, open };
}

async function start(): Promise<void> {
	w = await world();
	vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
		hooked.push([type, listener]);
		hook(type, listener, options);
	});
	files = new Map<string, string | FileContent>([
		['README.md', '# harmony\n'],
		['logo.png', PICTURE],
		['docs/notes.md', 'notes\n'],
		['src/main.ts', 'const a = 1;\n'],
		['src/player/queue.ts', 'export class Queue {}\n'],
		['src/player/track.ts', 'export interface Track {}\n'],
	]);
	w.on('list_dir', (args) => listing(String(args.path)));
	w.on('read_file', (args) => reading(String(args.path)));
	w.on('write_file', (args) => writing(String(args.path), String(args.text)));
	monaco = await fakeMonaco();
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	settings = w.get((await import('./editor-settings.store')).EditorSettingsStore);
	explorer = w.get((await import('./explorer.store')).ExplorerStore);
	explorer.sync();
	await pause();
}

/** Opens a file in a tab of its own and hands back the editor's model for it. */
async function edit(path: string): Promise<FakeModel> {
	explorer.open(path, true);
	await pause();
	return (await model(path))!;
}

async function model(path: string): Promise<FakeModel | null> {
	return (await explorer.model(path)) as unknown as FakeModel | null;
}

const tab = (path: string) => explorer.tabs().find((t) => t.path === path);
const paths = () => explorer.tabs().map((t) => t.path);
const written = () => w.sent('write_file').map((c) => ({ path: c.args.path, text: c.args.text }));

async function showRepo(id: string): Promise<void> {
	await repos.selectRepo(id);
	explorer.sync();
	await pause();
}

async function showWorktree(path: string | null): Promise<void> {
	const { BackendService } = await import('./backend.service');
	await w.get(BackendService).selectWorktree(HARMONY, path);
	await repos.switchContext();
	explorer.sync();
	await pause();
}

afterEach(() => {
	hooked.forEach(([type, listener]) => window.removeEventListener(type, listener));
	hooked.length = 0;
	vi.useRealTimers();
	held = false;
});

describe('the tree', () => {
	beforeEach(start);

	test('only the top folder is read until a folder is opened', () => {
		expect(w.sent('list_dir').map((c) => c.args)).toEqual([{ id: HARMONY, path: '' }]);
		expect(explorer.children().get('')!.map((e) => e.name).sort()).toEqual(['README.md', 'docs', 'logo.png', 'src']);
		expect(explorer.children().has('src')).toBe(false);
	});

	test('opening a folder reads it; folding it away reads nothing; opening it again reads it again', async () => {
		const reads = () => w.sent('list_dir').filter((c) => c.args.path === 'src').length;
		explorer.toggle('src');
		await pause();
		expect(explorer.expanded().has('src')).toBe(true);
		expect(explorer.children().get('src')!.map((e) => e.path).sort()).toEqual(['src/main.ts', 'src/player']);
		explorer.toggle('src');
		await pause();
		expect(explorer.expanded().has('src')).toBe(false);
		expect(reads()).toBe(1);
		explorer.toggle('src');
		await pause();
		expect(reads()).toBe(2);
	});

	test('a rescan reads every open folder again', async () => {
		explorer.toggle('src');
		explorer.toggle('src/player');
		await pause();
		files.set('src/player/shuffle.ts', '');
		files.set('LICENSE', 'MIT\n');
		await explorer.rescan();
		expect(explorer.children().get('src/player')!.map((e) => e.name)).toContain('shuffle.ts');
		expect(explorer.children().get('')!.map((e) => e.name)).toContain('LICENSE');
	});

	test('a listing that did not change leaves the tree as it was', async () => {
		explorer.toggle('src');
		await pause();
		const before = explorer.children();
		await explorer.rescan();
		expect(explorer.children()).toBe(before);
	});

	test('a folder that is gone is dropped, with the folders that were open under it', async () => {
		explorer.toggle('src');
		explorer.toggle('src/player');
		explorer.toggle('docs');
		await pause();
		for (const path of [...files.keys()].filter((p) => p.startsWith('src/'))) {
			files.delete(path);
		}
		await explorer.rescan();
		expect([...explorer.expanded()]).toEqual(['docs']);
		expect(explorer.children().has('src')).toBe(false);
		expect(explorer.children().has('src/player')).toBe(false);
		expect(explorer.children().get('')!.map((e) => e.name)).not.toContain('src');
	});

	test('a top folder that cannot be read shows as empty', async () => {
		w.on('list_dir', () => {
			throw appError('error', 'The folder is gone');
		});
		await explorer.rescan();
		expect(explorer.children().get('')).toEqual([]);
	});

	test('collapse all folds every folder', async () => {
		explorer.toggle('src');
		explorer.toggle('docs');
		await pause();
		explorer.collapseAll();
		expect(explorer.expanded().size).toBe(0);
	});

	test('the rows picked are whatever was last selected', () => {
		explorer.select(['README.md', 'src']);
		expect([...explorer.selected()]).toEqual(['README.md', 'src']);
		explorer.select([]);
		expect(explorer.selected().size).toBe(0);
	});
});

describe('opening files', () => {
	beforeEach(start);

	test('a single click opens the file as the preview tab and reads it', async () => {
		explorer.open('README.md');
		expect(explorer.tabs()).toEqual([{ path: 'README.md', kind: 'loading', dirty: false }]);
		expect(explorer.active()).toBe('README.md');
		expect(explorer.preview()).toBe('README.md');
		await pause();
		expect(explorer.tabs()).toEqual([{ path: 'README.md', kind: 'text', dirty: false }]);
		expect(explorer.activeTab()).toEqual({ path: 'README.md', kind: 'text', dirty: false });
		expect(w.sent('read_file').filter((c) => c.args.path === 'README.md')[0].args).toEqual({ id: HARMONY, path: 'README.md' });
	});

	test('the next single click takes the preview tab\'s place', async () => {
		explorer.open('docs/notes.md', true);
		explorer.open('README.md');
		await pause();
		const old = (await model('README.md'))!;
		explorer.open('src/main.ts');
		await pause();
		expect(paths()).toEqual(['docs/notes.md', 'src/main.ts']);
		expect(explorer.active()).toBe('src/main.ts');
		expect(explorer.preview()).toBe('src/main.ts');
		expect(old.disposed).toBe(true);
		expect(await model('README.md')).toBeNull();
	});

	test('a double click gives the file a tab of its own', async () => {
		explorer.open('README.md', true);
		expect(explorer.preview()).toBeNull();
		explorer.open('src/main.ts');
		await pause();
		expect(paths()).toEqual(['README.md', 'src/main.ts']);
	});

	test('a double click on the preview tab keeps it', async () => {
		explorer.open('README.md');
		explorer.open('README.md', true);
		expect(explorer.preview()).toBeNull();
		explorer.open('src/main.ts');
		await pause();
		expect(paths()).toEqual(['README.md', 'src/main.ts']);
	});

	test('editing the preview tab keeps it', async () => {
		explorer.open('README.md');
		await pause();
		(await model('README.md'))!.type('# harmony, edited\n');
		expect(explorer.preview()).toBeNull();
		explorer.open('src/main.ts');
		await pause();
		expect(paths()).toEqual(['README.md', 'src/main.ts']);
	});

	test('a file that is already open is only shown, not read again', async () => {
		explorer.open('README.md', true);
		explorer.open('src/main.ts', true);
		await pause();
		const reads = w.sent('read_file').length;
		explorer.open('README.md');
		await pause();
		expect(explorer.active()).toBe('README.md');
		expect(paths()).toEqual(['README.md', 'src/main.ts']);
		expect(explorer.preview()).toBeNull();
		expect(w.sent('read_file').length).toBe(reads);
	});

	test('a picture, a file too big to show and a file that is not there each say so, and have nothing to edit', async () => {
		files.set('dump.sql', HUGE);
		explorer.open('logo.png', true);
		explorer.open('dump.sql', true);
		explorer.open('gone.ts', true);
		await pause();
		expect(tab('logo.png')!.kind).toBe('binary');
		expect(tab('dump.sql')!.kind).toBe('large');
		expect(tab('gone.ts')!.kind).toBe('missing');
		expect(await model('logo.png')).toBeNull();
		expect(await model('dump.sql')).toBeNull();
		expect(await model('gone.ts')).toBeNull();
		expect(monaco.fake.made).toEqual([]);
	});

	test('every opened file is noted as opened lately, the latest first', async () => {
		const { FileIndexStore } = await import('./file-index.store');
		explorer.open('README.md', true);
		explorer.open('src/main.ts', true);
		explorer.open('README.md');
		expect(w.get(FileIndexStore).recent()).toEqual(['README.md', 'src/main.ts']);
	});
});

describe('the editor\'s text', () => {
	beforeEach(start);

	test('the model is made once, from the text on disk, at the file\'s own place in the checkout', async () => {
		const m = await edit('src/main.ts');
		expect(m.getValue()).toBe('const a = 1;\n');
		expect(m.uri.fsPath).toBe(`${HARMONY}/src/main.ts`);
		expect(await model('src/main.ts')).toBe(m);
		expect(monaco.fake.made.length).toBe(1);
	});

	test('a file that is not open has no model', async () => {
		expect(await model('src/main.ts')).toBeNull();
	});

	test('a file closed while the editor was asking for its model gets none', async () => {
		explorer.open('src/main.ts', true);
		await pause();
		const asking = model('src/main.ts');
		explorer.close('src/main.ts');
		expect(await asking).toBeNull();
		expect(monaco.fake.made).toEqual([]);
	});

	test('typing marks the tab unsaved; undoing back to what is on disk clears the mark', async () => {
		const m = await edit('src/main.ts');
		m.type('const a = 2;\n');
		expect(tab('src/main.ts')!.dirty).toBe(true);
		m.type('const a = 3;\n');
		m.undo();
		expect(tab('src/main.ts')!.dirty).toBe(true);
		m.undo();
		expect(tab('src/main.ts')!.dirty).toBe(false);
	});

	test('where the editor was scrolled to is kept with the file', async () => {
		await edit('src/main.ts');
		const view = { scrolled: 120 } as never;
		expect(explorer.view('src/main.ts')).toBeNull();
		explorer.saveView('src/main.ts', view);
		expect(explorer.view('src/main.ts')).toBe(view);
		explorer.saveView('not-open.ts', view);
		expect(explorer.view('not-open.ts')).toBeNull();
	});

	test('a file changed on disk is shown as it is now, and that is not an edit', async () => {
		const m = await edit('src/main.ts');
		files.set('src/main.ts', 'const a = 99;\n');
		await explorer.rescan();
		expect(m.getValue()).toBe('const a = 99;\n');
		expect(tab('src/main.ts')!.dirty).toBe(false);
		m.type('mine');
		m.undo();
		expect(tab('src/main.ts')!.dirty).toBe(false);
	});

	test('a file with unsaved edits is not read again, so the edits stay', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		files.set('src/main.ts', 'theirs\n');
		const reads = w.sent('read_file').filter((c) => c.args.path === 'src/main.ts').length;
		await explorer.rescan();
		expect(w.sent('read_file').filter((c) => c.args.path === 'src/main.ts').length).toBe(reads);
		expect(m.getValue()).toBe('mine\n');
		expect(tab('src/main.ts')!.dirty).toBe(true);
	});

	test('an open file that is gone from disk closes by itself, unless it has unsaved edits', async () => {
		await edit('README.md');
		const m = await edit('src/main.ts');
		m.type('mine\n');
		files.delete('README.md');
		files.delete('src/main.ts');
		await explorer.rescan();
		expect(paths()).toEqual(['src/main.ts']);
		expect(m.disposed).toBe(false);
		expect(w.toasts).toEqual([]);
	});

	test('a file that became a picture on disk stops being text', async () => {
		await edit('src/main.ts');
		files.set('src/main.ts', PICTURE);
		await explorer.rescan();
		expect(tab('src/main.ts')!.kind).toBe('binary');
	});
});

describe('closing', () => {
	beforeEach(start);

	test('closing the tab on screen shows its neighbour', async () => {
		explorer.open('README.md', true);
		explorer.open('src/main.ts', true);
		explorer.open('docs/notes.md', true);
		await pause();
		explorer.open('src/main.ts');
		explorer.close('src/main.ts');
		expect(paths()).toEqual(['README.md', 'docs/notes.md']);
		expect(explorer.active()).toBe('docs/notes.md');
		explorer.close('docs/notes.md');
		expect(explorer.active()).toBe('README.md');
		explorer.close('README.md');
		expect(explorer.active()).toBeNull();
		expect(explorer.activeTab()).toBeNull();
	});

	test('closing another tab leaves the one on screen', async () => {
		explorer.open('README.md', true);
		explorer.open('src/main.ts', true);
		await pause();
		explorer.close('README.md');
		expect(explorer.active()).toBe('src/main.ts');
	});

	test('closing the preview tab leaves no preview', async () => {
		explorer.open('README.md');
		await pause();
		explorer.close('README.md');
		expect(explorer.preview()).toBeNull();
		expect(paths()).toEqual([]);
	});

	test('a closed file gives up its model', async () => {
		const m = await edit('src/main.ts');
		explorer.close('src/main.ts');
		expect(m.disposed).toBe(true);
	});

	test('a file with unsaved edits asks before it closes', async () => {
		explorer.open('README.md', true);
		const m = await edit('src/main.ts');
		m.type('mine\n');
		explorer.open('README.md');
		explorer.close('src/main.ts');
		expect(paths()).toEqual(['README.md', 'src/main.ts']);
		expect(explorer.notice()).toEqual({ path: 'src/main.ts', kind: 'close' });
		expect(explorer.active()).toBe('src/main.ts');
		explorer.dismissNotice();
		expect(explorer.notice()).toBeNull();
		expect(paths()).toContain('src/main.ts');
		expect(m.disposed).toBe(false);
	});

	test('"Don\'t save" closes it and the edits are gone', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		explorer.close('src/main.ts');
		explorer.close('src/main.ts', true);
		expect(paths()).toEqual([]);
		expect(explorer.notice()).toBeNull();
		expect(m.disposed).toBe(true);
		expect(written()).toEqual([]);
	});

	test('"Save" writes the edits, then closes', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		explorer.close('src/main.ts');
		await explorer.saveAndClose('src/main.ts');
		expect(written()).toEqual([{ path: 'src/main.ts', text: 'mine\n' }]);
		expect(paths()).toEqual([]);
		expect(explorer.notice()).toBeNull();
	});

	test('"Save" that cannot save leaves the tab open', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		files.set('src/main.ts', 'theirs\n');
		await explorer.saveAndClose('src/main.ts');
		expect(paths()).toEqual(['src/main.ts']);
		expect(m.getValue()).toBe('mine\n');
	});

	test('closing a file that is not open does nothing', () => {
		explorer.close('nope.ts');
		expect(explorer.notice()).toBeNull();
	});
});

describe('saving', () => {
	beforeEach(start);

	test('the edits are written to the file, naming the checkout they were read from, and the tab is clean again', async () => {
		const m = await edit('src/main.ts');
		m.type('const a = 2;\n');
		const status = w.sent('repo_status').length;
		expect(await explorer.save('src/main.ts')).toBe(true);
		expect(w.sent('write_file').map((c) => c.args)).toEqual([{ id: HARMONY, path: 'src/main.ts', text: 'const a = 2;\n', root: HARMONY }]);
		expect(tab('src/main.ts')!.dirty).toBe(false);
		expect(explorer.saving()).toBeNull();
		await pause();
		// The Changes tab has something new to show.
		expect(w.sent('repo_status').length).toBeGreaterThan(status);
	});

	test('after a save, undoing goes back to unsaved and redoing the save point is clean', async () => {
		const m = await edit('src/main.ts');
		m.type('one\n');
		await explorer.save('src/main.ts');
		m.type('two\n');
		expect(tab('src/main.ts')!.dirty).toBe(true);
		m.undo();
		expect(tab('src/main.ts')!.dirty).toBe(false);
		m.undo();
		expect(tab('src/main.ts')!.dirty).toBe(true);
	});

	test('a file that is not open in the editor is never written', async () => {
		expect(await explorer.save('src/brand-new.ts')).toBe(false);
		explorer.open('src/main.ts', true);
		await pause();
		// Open, but the editor has not made its model: there is nothing of the user's to write.
		expect(await explorer.save('src/main.ts')).toBe(false);
		expect(written()).toEqual([]);
		expect(w.toasts).toEqual([]);
	});

	test('saving never creates a file: one deleted from disk is refused, said, and stays unsaved', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		files.delete('src/main.ts');
		expect(await explorer.save('src/main.ts')).toBe(false);
		expect(files.has('src/main.ts')).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'src/main.ts is not a file' });
		expect(tab('src/main.ts')!.dirty).toBe(true);
		expect(m.getValue()).toBe('mine\n');
		expect(explorer.saving()).toBeNull();
	});

	test('a file that changed on disk since it was read is not overwritten: the editor asks', async () => {
		explorer.open('README.md', true);
		const m = await edit('src/main.ts');
		m.type('mine\n');
		explorer.open('README.md');
		files.set('src/main.ts', 'theirs\n');
		expect(await explorer.save('src/main.ts')).toBe(false);
		expect(written()).toEqual([]);
		expect(files.get('src/main.ts')).toBe('theirs\n');
		expect(explorer.notice()).toEqual({ path: 'src/main.ts', kind: 'conflict' });
		expect(explorer.active()).toBe('src/main.ts');
		expect(tab('src/main.ts')!.dirty).toBe(true);
		expect(explorer.saving()).toBeNull();
		expect(w.toasts).toEqual([]);
	});

	test('a file that turned into something that is not text is not overwritten either', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		files.set('src/main.ts', PICTURE);
		expect(await explorer.save('src/main.ts')).toBe(false);
		expect(written()).toEqual([]);
		expect(explorer.notice()).toEqual({ path: 'src/main.ts', kind: 'conflict' });
	});

	test('"Overwrite" writes over the changed file without looking again', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		files.set('src/main.ts', 'theirs\n');
		await explorer.save('src/main.ts');
		const reads = w.sent('read_file').length;
		expect(await explorer.save('src/main.ts', true)).toBe(true);
		expect(w.sent('read_file').length).toBe(reads);
		expect(files.get('src/main.ts')).toBe('mine\n');
		expect(explorer.notice()).toBeNull();
		expect(tab('src/main.ts')!.dirty).toBe(false);
	});

	test('"Revert" shows the file as it is on disk and the edits are gone', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		files.set('src/main.ts', 'theirs\n');
		await explorer.save('src/main.ts');
		await explorer.revert('src/main.ts');
		expect(m.getValue()).toBe('theirs\n');
		expect(tab('src/main.ts')).toEqual({ path: 'src/main.ts', kind: 'text', dirty: false });
		expect(explorer.notice()).toBeNull();
		expect(written()).toEqual([]);
		// What is on disk now is what the next save compares with.
		m.type('mine again\n');
		expect(await explorer.save('src/main.ts')).toBe(true);
	});

	test('reverting edits when the disk did not change still puts the text back', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		await explorer.revert('src/main.ts');
		expect(m.getValue()).toBe('const a = 1;\n');
		expect(tab('src/main.ts')!.dirty).toBe(false);
	});

	test('reverting a file that is gone closes it', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		files.delete('src/main.ts');
		await explorer.revert('src/main.ts');
		expect(paths()).toEqual([]);
	});

	test('the native side\'s refusal (another checkout is active by now) is said and the edits stay unsaved', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		w.on('write_file', () => {
			throw appError('error', 'Another checkout is active now');
		});
		expect(await explorer.save('src/main.ts')).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'Another checkout is active now' });
		expect(tab('src/main.ts')!.dirty).toBe(true);
		expect(explorer.saving()).toBeNull();
	});

	test('a save under way when the checkout on screen changes writes nothing', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		const check = gate();
		w.on('read_file', async (args) => {
			if (args.path === 'src/main.ts') {
				await check.wait;
			}
			return reading(String(args.path));
		});
		const saving = explorer.save('src/main.ts');
		await showWorktree(TREE);
		check.open();
		expect(await saving).toBe(false);
		expect(written()).toEqual([]);
	});

	test('a second save while one is under way does nothing', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		const first = explorer.save('src/main.ts');
		expect(explorer.saving()).toBe('src/main.ts');
		expect(await explorer.save('src/main.ts')).toBe(false);
		expect(await first).toBe(true);
		expect(written().length).toBe(1);
		expect(explorer.saving()).toBeNull();
	});

	test('what is typed while the file is being written stays unsaved, and saves next time', async () => {
		const m = await edit('src/main.ts');
		m.type('first\n');
		w.on('write_file', (args) => {
			writing(String(args.path), String(args.text));
			if (m.getValue() === 'first\n') {
				m.type('first\nsecond\n');
			}
		});
		expect(await explorer.save('src/main.ts')).toBe(true);
		expect(files.get('src/main.ts')).toBe('first\n');
		expect(tab('src/main.ts')!.dirty).toBe(true);
		expect(await explorer.save('src/main.ts')).toBe(true);
		expect(files.get('src/main.ts')).toBe('first\nsecond\n');
		expect(tab('src/main.ts')!.dirty).toBe(false);
		expect(explorer.notice()).toBeNull();
	});

	test('whoever listens for saves gets the model once its text is on disk, and not when the save was refused', async () => {
		const seen: unknown[] = [];
		explorer.afterSave.push((saved) => seen.push(saved, files.get('src/main.ts')));
		const m = await edit('src/main.ts');
		m.type('mine\n');
		await explorer.save('src/main.ts');
		expect(seen).toEqual([m, 'mine\n']);
		m.type('mine again\n');
		files.set('src/main.ts', 'theirs\n');
		await explorer.save('src/main.ts');
		w.on('write_file', () => {
			throw appError('error', 'disk full');
		});
		await explorer.save('src/main.ts', true);
		expect(seen.length).toBe(2);
	});

	test('"save all" writes every file with unsaved edits and no other', async () => {
		const a = await edit('src/main.ts');
		const b = await edit('README.md');
		await edit('docs/notes.md');
		a.type('a\n');
		b.type('b\n');
		await explorer.saveAll();
		expect(written()).toEqual([
			{ path: 'src/main.ts', text: 'a\n' },
			{ path: 'README.md', text: 'b\n' },
		]);
		expect(explorer.tabs().some((t) => t.dirty)).toBe(false);
	});

	test('a file the app itself rewrote is shown as it is now, unless it has unsaved edits', async () => {
		const clean = await edit('src/main.ts');
		const edited = await edit('README.md');
		edited.type('mine\n');
		files.set('src/main.ts', 'renamed by the language server\n');
		files.set('README.md', 'theirs\n');
		await explorer.reload('src/main.ts');
		await explorer.reload('README.md');
		await explorer.reload('not-open.ts');
		expect(clean.getValue()).toBe('renamed by the language server\n');
		expect(tab('src/main.ts')!.dirty).toBe(false);
		expect(edited.getValue()).toBe('mine\n');
		expect(tab('README.md')!.dirty).toBe(true);
	});
});

describe('tidying on save', () => {
	beforeEach(start);

	test('nothing is touched unless Settings or .editorconfig ask', async () => {
		const m = await edit('src/main.ts');
		m.type('a  \nb');
		await explorer.save('src/main.ts');
		expect(files.get('src/main.ts')).toBe('a  \nb');
	});

	test('Settings can have spaces and tabs at line ends removed', async () => {
		settings.set('trimTrailing', true);
		const m = await edit('src/main.ts');
		m.type('a  \n\tb\t \n\nc');
		await explorer.save('src/main.ts');
		expect(files.get('src/main.ts')).toBe('a\n\tb\n\nc');
		expect(tab('src/main.ts')!.dirty).toBe(false);
	});

	test('Settings can have a newline put at the end, once', async () => {
		settings.set('finalNewline', true);
		const m = await edit('src/main.ts');
		m.type('a\nb');
		await explorer.save('src/main.ts');
		expect(files.get('src/main.ts')).toBe('a\nb\n');
		m.type('a\nb\nc\n');
		await explorer.save('src/main.ts');
		expect(files.get('src/main.ts')).toBe('a\nb\nc\n');
	});

	test('an empty file stays empty', async () => {
		settings.set('finalNewline', true);
		settings.set('trimTrailing', true);
		const m = await edit('src/main.ts');
		m.type('');
		await explorer.save('src/main.ts');
		expect(files.get('src/main.ts')).toBe('');
	});

	test('with both, a last line of only spaces becomes the end of the file', async () => {
		settings.set('finalNewline', true);
		settings.set('trimTrailing', true);
		const m = await edit('src/main.ts');
		m.type('a  \n   ');
		await explorer.save('src/main.ts');
		expect(files.get('src/main.ts')).toBe('a\n');
	});

	test('the tidying is an edit the user can undo', async () => {
		settings.set('trimTrailing', true);
		const m = await edit('src/main.ts');
		m.type('a  ');
		await explorer.save('src/main.ts');
		m.undo();
		expect(m.getValue()).toBe('a  ');
		expect(tab('src/main.ts')!.dirty).toBe(true);
	});

	test('the repository\'s .editorconfig wins over Settings for its files', async () => {
		files.set('.editorconfig', '[*.md]\ntrim_trailing_whitespace = false\n\n[*.ts]\ninsert_final_newline = true\n');
		await explorer.rescan();
		settings.set('trimTrailing', true);
		const md = await edit('README.md');
		const ts = await edit('src/main.ts');
		md.type('two spaces make a line break  \nhere');
		ts.type('a  \nb');
		await explorer.saveAll();
		expect(files.get('README.md')).toBe('two spaces make a line break  \nhere');
		expect(files.get('src/main.ts')).toBe('a\nb\n');
	});

	test('what .editorconfig says about a file is there to ask for', async () => {
		files.set('.editorconfig', '[*]\nindent_style = space\nindent_size = 2\n\n[*.md]\nmax_line_length = 100\n');
		await explorer.rescan();
		expect(explorer.configFor('src/main.ts')).toEqual({ indentStyle: 'space', indentSize: 2 });
		expect(explorer.configFor('docs/notes.md')).toEqual({ indentStyle: 'space', indentSize: 2, maxLineLength: 100 });
	});

	test('.editorconfig is read again on every rescan', async () => {
		expect(explorer.configFor('src/main.ts')).toEqual({});
		files.set('.editorconfig', '[*]\nindent_size = 4\n');
		await explorer.rescan();
		expect(explorer.configFor('src/main.ts')).toEqual({ indentSize: 4 });
		files.delete('.editorconfig');
		await explorer.rescan();
		expect(explorer.configFor('src/main.ts')).toEqual({});
	});

	test('with .editorconfig turned off in Settings it says nothing, and Settings decide alone', async () => {
		files.set('.editorconfig', '[*]\ntrim_trailing_whitespace = true\nindent_size = 2\n');
		await explorer.rescan();
		settings.set('editorconfig', false);
		expect(explorer.configFor('src/main.ts')).toEqual({});
		const m = await edit('src/main.ts');
		m.type('a  ');
		await explorer.save('src/main.ts');
		expect(files.get('src/main.ts')).toBe('a  ');
	});

	test('a .editorconfig that is not text counts as none', async () => {
		files.set('.editorconfig', PICTURE);
		await explorer.rescan();
		expect(explorer.configFor('src/main.ts')).toEqual({});
	});
});

describe('saving by itself', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		held = true;
		await start();
	});

	test('off unless asked for: edits wait for the user', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		await vi.advanceTimersByTimeAsync(10_000);
		window.dispatchEvent(new Event('blur'));
		await pause();
		expect(written()).toEqual([]);
		expect(tab('src/main.ts')!.dirty).toBe(true);
	});

	test('"after a delay" saves a second after the typing stops', async () => {
		settings.set('autoSave', 'delay');
		const m = await edit('src/main.ts');
		m.type('m');
		await vi.advanceTimersByTimeAsync(900);
		m.type('mine\n');
		await vi.advanceTimersByTimeAsync(900);
		expect(written()).toEqual([]);
		await vi.advanceTimersByTimeAsync(200);
		expect(written()).toEqual([{ path: 'src/main.ts', text: 'mine\n' }]);
		expect(tab('src/main.ts')!.dirty).toBe(false);
	});

	test('"after a delay" does not save a file closed meanwhile, or one that is clean again', async () => {
		settings.set('autoSave', 'delay');
		const a = await edit('src/main.ts');
		const b = await edit('README.md');
		a.type('mine\n');
		b.type('mine\n');
		explorer.close('src/main.ts', true);
		b.undo();
		await vi.advanceTimersByTimeAsync(2000);
		expect(written()).toEqual([]);
	});

	test('"when the window loses focus" saves every unsaved file then', async () => {
		settings.set('autoSave', 'focus');
		const a = await edit('src/main.ts');
		const b = await edit('README.md');
		a.type('a\n');
		b.type('b\n');
		await vi.advanceTimersByTimeAsync(5000);
		expect(written()).toEqual([]);
		window.dispatchEvent(new Event('blur'));
		await pause();
		await pause();
		expect(written().map((x) => x.path)).toEqual(['src/main.ts', 'README.md']);
	});
});

describe('showing a file at a line', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		held = true;
		await start();
		files.set('src/long.ts', 'one\ntwo\nthree\nfour\n');
	});

	test('the cursor goes there once the editor shows the file, in a tab of its own', async () => {
		const going = explorer.openAt('src/long.ts', 3, 2);
		await pause();
		expect(explorer.active()).toBe('src/long.ts');
		expect(explorer.preview()).toBeNull();
		const editor = monaco.fake.show(null);
		await vi.advanceTimersByTimeAsync(200);
		editor.setModel(await model('src/long.ts'));
		await vi.advanceTimersByTimeAsync(60);
		expect(await going).toBe(true);
		expect(editor.position).toEqual({ lineNumber: 3, column: 2 });
		expect(editor.revealed).toEqual({ lineNumber: 3, column: 2 });
		expect(editor.focused).toBe(true);
	});

	test('a line past the end is the last line; a line or column before the start is the first', async () => {
		const editor = monaco.fake.show(await edit('src/long.ts'));
		const far = explorer.openAt('src/long.ts', 400);
		await vi.advanceTimersByTimeAsync(60);
		expect(await far).toBe(true);
		expect(editor.position).toEqual({ lineNumber: 5, column: 1 });
		const near = explorer.openAt('src/long.ts', 0, 0);
		await vi.advanceTimersByTimeAsync(60);
		expect(await near).toBe(true);
		expect(editor.position).toEqual({ lineNumber: 1, column: 1 });
	});

	test('a file that is not there, or is not text, is not waited for', async () => {
		const gone = explorer.openAt('src/gone.ts', 3);
		await vi.advanceTimersByTimeAsync(120);
		expect(await gone).toBe(false);
		const picture = explorer.openAt('logo.png', 3);
		await vi.advanceTimersByTimeAsync(120);
		expect(await picture).toBe(false);
	});

	test('closing the tab before the editor shows it ends the wait', async () => {
		const going = explorer.openAt('src/long.ts', 3);
		await vi.advanceTimersByTimeAsync(60);
		explorer.close('src/long.ts');
		await vi.advanceTimersByTimeAsync(60);
		expect(await going).toBe(false);
	});

	test('an editor that never comes up is given up on after a few seconds', async () => {
		let answer: boolean | null = null;
		void explorer.openAt('src/long.ts', 3).then((ok) => (answer = ok));
		await vi.advanceTimersByTimeAsync(5000);
		expect(answer).toBeNull();
		await vi.advanceTimersByTimeAsync(5000);
		expect(answer).toBe(false);
		expect(tab('src/long.ts')!.kind).toBe('text');
	});
});

describe('new, renamed, moved, copied and deleted entries', () => {
	beforeEach(start);

	/** The native side's move: the disk follows, and it reports what went where. */
	function moves(): void {
		w.on('files_move', (args) => {
			const to = String(args.to);
			const done: string[] = [];
			for (const from of args.paths as string[]) {
				const name = (args.rename as string | null) ?? from.slice(from.lastIndexOf('/') + 1);
				const dest = to ? `${to}/${name}` : name;
				for (const [path, file] of [...files]) {
					if (path === from || path.startsWith(`${from}/`)) {
						files.delete(path);
						files.set(dest + path.slice(from.length), file);
					}
				}
				done.push(dest);
			}
			return { done, sources: args.paths, conflicts: [] };
		});
	}

	test('a new file is made where asked, shown in the tree and opened in a tab of its own', async () => {
		w.on('files_create', (args) => {
			const path = `${String(args.dir)}/${String(args.name)}`;
			files.set(path, '');
			return path;
		});
		expect(await explorer.create('src/player', '  shuffle.ts ', false)).toBe('src/player/shuffle.ts');
		expect(w.sent('files_create').map((c) => c.args)).toEqual([{ id: HARMONY, root: HARMONY, dir: 'src/player', name: 'shuffle.ts', isDir: false }]);
		expect([...explorer.expanded()].sort()).toEqual(['src', 'src/player']);
		expect(explorer.children().get('src/player')!.map((e) => e.name)).toContain('shuffle.ts');
		expect([...explorer.selected()]).toEqual(['src/player/shuffle.ts']);
		expect(explorer.active()).toBe('src/player/shuffle.ts');
		expect(explorer.preview()).toBeNull();
		await pause();
		expect(tab('src/player/shuffle.ts')!.kind).toBe('text');
	});

	test('a new folder is selected but opens no tab', async () => {
		w.on('files_create', () => 'assets');
		expect(await explorer.create('', 'assets', true)).toBe('assets');
		expect(w.sent('files_create')[0].args).toMatchObject({ dir: '', name: 'assets', isDir: true });
		expect([...explorer.selected()]).toEqual(['assets']);
		expect(paths()).toEqual([]);
	});

	test('a name the native side refuses is said and nothing opens', async () => {
		w.on('files_create', () => {
			throw appError('error', 'main.ts already exists');
		});
		expect(await explorer.create('src', 'main.ts', false)).toBeNull();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'main.ts already exists' });
		expect(paths()).toEqual([]);
		expect(explorer.selected().size).toBe(0);
	});

	test('a renamed file takes its tab along, and the editor gets a model at the new name', async () => {
		moves();
		explorer.open('README.md', true);
		const old = await edit('src/main.ts');
		const placed = await explorer.move(['src/main.ts'], 'src', 'start.ts');
		expect(placed).toEqual({ done: ['src/start.ts'], sources: ['src/main.ts'], conflicts: [] });
		expect(w.sent('files_move').map((c) => c.args)).toEqual([{ id: HARMONY, root: HARMONY, paths: ['src/main.ts'], to: 'src', rename: 'start.ts', onConflict: 'ask' }]);
		expect(explorer.tabs()).toEqual([
			{ path: 'README.md', kind: 'text', dirty: false },
			{ path: 'src/start.ts', kind: 'text', dirty: false },
		]);
		expect(explorer.active()).toBe('src/start.ts');
		expect([...explorer.selected()]).toEqual(['src/start.ts']);
		expect(old.disposed).toBe(true);
		const now = (await model('src/start.ts'))!;
		expect(now.uri.fsPath).toBe(`${HARMONY}/src/start.ts`);
		expect(now.getValue()).toBe('const a = 1;\n');
		expect(tab('src/start.ts')!.dirty).toBe(false);
		expect(await model('src/main.ts')).toBeNull();
	});

	test('unsaved edits go with a renamed file and are saved under the new name', async () => {
		moves();
		const old = await edit('src/main.ts');
		old.type('mine\n');
		await explorer.move(['src/main.ts'], 'src', 'start.ts');
		expect(tab('src/start.ts')!.dirty).toBe(true);
		const now = (await model('src/start.ts'))!;
		expect(now.getValue()).toBe('mine\n');
		// Still unsaved, whatever the user does to the new model short of saving.
		now.type('mine, more\n');
		now.undo();
		expect(tab('src/start.ts')!.dirty).toBe(true);
		expect(await explorer.save('src/start.ts')).toBe(true);
		expect(written()).toEqual([{ path: 'src/start.ts', text: 'mine\n' }]);
		expect(tab('src/start.ts')!.dirty).toBe(false);
		expect(files.has('src/main.ts')).toBe(false);
	});

	test('a renamed file the app then rewrote shows what was written, not the text it had before the rename', async () => {
		moves();
		await edit('src/main.ts');
		await explorer.move(['src/main.ts'], 'src', 'start.ts');
		files.set('src/start.ts', 'rewritten by the language server\n');
		await explorer.reload('src/start.ts');
		const now = (await model('src/start.ts'))!;
		expect(now.getValue()).toBe('rewritten by the language server\n');
		expect(tab('src/start.ts')!.dirty).toBe(false);
	});

	test('the preview tab and a question about a file follow it when it moves', async () => {
		moves();
		explorer.open('README.md');
		await pause();
		await explorer.move(['README.md'], 'docs', null);
		expect(explorer.preview()).toBe('docs/README.md');
		const m = (await model('docs/README.md'))!;
		m.type('mine\n');
		explorer.close('docs/README.md');
		await explorer.move(['docs/README.md'], '', 'INTRO.md');
		expect(explorer.notice()).toEqual({ path: 'INTRO.md', kind: 'close' });
		expect(explorer.active()).toBe('INTRO.md');
	});

	test('a moved folder takes along the tabs and the open folders under it', async () => {
		moves();
		explorer.toggle('src');
		explorer.toggle('src/player');
		explorer.open('src/main.ts', true);
		const queue = await edit('src/player/queue.ts');
		queue.type('mine\n');
		await explorer.move(['src/player'], 'docs', null);
		expect(paths()).toEqual(['src/main.ts', 'docs/player/queue.ts']);
		expect(explorer.active()).toBe('docs/player/queue.ts');
		expect([...explorer.expanded()].sort()).toEqual(['docs', 'docs/player', 'src']);
		expect(explorer.children().get('docs')!.map((e) => e.name)).toContain('player');
		expect(explorer.children().get('src')!.map((e) => e.name)).toEqual(['main.ts']);
		expect((await model('docs/player/queue.ts'))!.getValue()).toBe('mine\n');
	});

	test('a folder moved together with something inside it brings that along: only the folder is named', async () => {
		moves();
		await explorer.move(['src/player/queue.ts', 'src/player', 'README.md'], 'docs', null);
		expect(w.sent('files_move')[0].args.paths).toEqual(['src/player', 'README.md']);
	});

	test('a name already taken changes nothing and is handed back to ask about', async () => {
		w.on('files_move', () => ({ done: [], sources: [], conflicts: ['notes.md'] }));
		explorer.open('docs/notes.md', true);
		await pause();
		explorer.select(['docs/notes.md']);
		const lists = w.sent('list_dir').length;
		const placed = await explorer.move(['docs/notes.md'], '', null);
		expect(placed!.conflicts).toEqual(['notes.md']);
		expect(paths()).toEqual(['docs/notes.md']);
		expect([...explorer.selected()]).toEqual(['docs/notes.md']);
		expect(explorer.expanded().size).toBe(0);
		expect(w.sent('list_dir').length).toBe(lists);
		expect(w.toasts).toEqual([]);
	});

	test('the answer to that question is sent as given', async () => {
		moves();
		await explorer.move(['docs/notes.md'], '', null, 'keep-both');
		expect(w.sent('files_move')[0].args.onConflict).toBe('keep-both');
	});

	test('a move the native side refuses is said, and the tabs stay where they were', async () => {
		w.on('files_move', () => {
			throw appError('error', 'src cannot be moved inside itself');
		});
		explorer.open('src/main.ts', true);
		await pause();
		expect(await explorer.move(['src'], 'src/player', null)).toBeNull();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'src cannot be moved inside itself' });
		expect(paths()).toEqual(['src/main.ts']);
	});

	test('a copy is selected in the tree, not opened', async () => {
		w.on('files_duplicate', (args) => {
			files.set('src/main copy.ts', files.get(String(args.path))!);
			return 'src/main copy.ts';
		});
		explorer.toggle('src');
		await pause();
		expect(await explorer.duplicate('src/main.ts')).toBe('src/main copy.ts');
		expect(w.sent('files_duplicate').map((c) => c.args)).toEqual([{ id: HARMONY, root: HARMONY, path: 'src/main.ts' }]);
		expect([...explorer.selected()]).toEqual(['src/main copy.ts']);
		expect(explorer.children().get('src')!.map((e) => e.name)).toContain('main copy.ts');
		expect(paths()).toEqual([]);
	});

	test('a copy that fails is said', async () => {
		w.on('files_duplicate', () => {
			throw appError('error', 'src/main.ts no longer exists');
		});
		expect(await explorer.duplicate('src/main.ts')).toBeNull();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'src/main.ts no longer exists' });
	});

	test('what goes to the trash has its tabs closed, unsaved edits included', async () => {
		w.on('files_trash', (args) => {
			for (const gone of args.paths as string[]) {
				for (const path of [...files.keys()]) {
					if (path === gone || path.startsWith(`${gone}/`)) {
						files.delete(path);
					}
				}
			}
		});
		explorer.toggle('src');
		explorer.open('README.md', true);
		explorer.open('src/player/track.ts', true);
		const queue = await edit('src/player/queue.ts');
		queue.type('mine\n');
		explorer.select(['src/player']);
		expect(await explorer.trash(['src/player'])).toBe(true);
		expect(w.sent('files_trash').map((c) => c.args)).toEqual([{ id: HARMONY, root: HARMONY, paths: ['src/player'] }]);
		expect(paths()).toEqual(['README.md']);
		expect(explorer.active()).toBe('README.md');
		expect(explorer.notice()).toBeNull();
		expect(queue.disposed).toBe(true);
		expect(explorer.selected().size).toBe(0);
		expect(explorer.children().get('src')!.map((e) => e.name)).toEqual(['main.ts']);
	});

	test('when the trash refuses, the tabs stay and the reason is said', async () => {
		w.on('files_trash', () => {
			throw appError('error', 'README.md no longer exists');
		});
		explorer.open('README.md', true);
		await pause();
		expect(await explorer.trash(['README.md'])).toBe(false);
		expect(paths()).toEqual(['README.md']);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'README.md no longer exists' });
	});

	test('files dropped from outside are copied into the folder, which opens to show them', async () => {
		w.on('files_import', () => {
			files.set('docs/cover.png', PICTURE);
			return { done: ['docs/cover.png'], sources: ['/Users/me/Desktop/cover.png'], conflicts: [] };
		});
		const placed = await explorer.importFiles(['/Users/me/Desktop/cover.png'], 'docs');
		expect(w.sent('files_import').map((c) => c.args)).toEqual([{ id: HARMONY, root: HARMONY, sources: ['/Users/me/Desktop/cover.png'], to: 'docs', onConflict: 'ask' }]);
		expect(placed!.done).toEqual(['docs/cover.png']);
		expect(explorer.expanded().has('docs')).toBe(true);
		expect(explorer.children().get('docs')!.map((e) => e.name)).toContain('cover.png');
		expect([...explorer.selected()]).toEqual(['docs/cover.png']);
		expect(paths()).toEqual([]);
	});

	test('a dropped file whose name is taken changes nothing until the user has answered', async () => {
		w.on('files_import', (args) => (args.onConflict === 'ask' ? { done: [], sources: [], conflicts: ['notes.md'] } : { done: ['docs/notes 2.md'], sources: ['/tmp/notes.md'], conflicts: [] }));
		const asked = await explorer.importFiles(['/tmp/notes.md'], 'docs');
		expect(asked!.conflicts).toEqual(['notes.md']);
		expect(explorer.expanded().size).toBe(0);
		expect(explorer.selected().size).toBe(0);
		const kept = await explorer.importFiles(['/tmp/notes.md'], 'docs', 'keep-both');
		expect(w.sent('files_import')[1].args.onConflict).toBe('keep-both');
		expect([...explorer.selected()]).toEqual(kept!.done);
	});

	test('a drop that fails is said', async () => {
		w.on('files_import', () => {
			throw appError('error', 'No room left');
		});
		expect(await explorer.importFiles(['/tmp/a.png'], '')).toBeNull();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'No room left' });
	});

	test('"show in the file manager" names every picked entry', async () => {
		w.on('open_in', () => null);
		await explorer.reveal(['README.md', 'src/main.ts']);
		expect(w.sent('open_in').map((c) => c.args)).toEqual([{ id: HARMONY, target: 'reveal', arg: 'README.md\nsrc/main.ts' }]);
		w.on('open_in', () => {
			throw appError('error', 'xdg-open is not installed');
		});
		await explorer.reveal(['README.md']);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'xdg-open is not installed' });
	});

	test('the tabs under a folder are the ones in it, not ones that merely start with its name', async () => {
		files.set('src/player2/x.ts', 'x\n');
		explorer.open('src/player/queue.ts', true);
		explorer.open('src/player2/x.ts', true);
		explorer.open('src/main.ts', true);
		await pause();
		expect(explorer.openUnder('src/player').map((t) => t.path)).toEqual(['src/player/queue.ts']);
		expect(explorer.openUnder('src/main.ts').map((t) => t.path)).toEqual(['src/main.ts']);
		expect(explorer.openUnder('src').length).toBe(3);
	});
});

describe('one state per checkout', () => {
	beforeEach(start);

	test('each repository has its own folders and tabs, found again on return', async () => {
		explorer.toggle('src');
		explorer.open('README.md', true);
		explorer.open('src/main.ts');
		explorer.select(['README.md']);
		await pause();

		await showRepo(CADENCE);
		expect(explorer.root).toBe(CADENCE);
		expect(paths()).toEqual([]);
		expect(explorer.active()).toBeNull();
		expect(explorer.preview()).toBeNull();
		expect(explorer.expanded().size).toBe(0);
		expect(explorer.selected().size).toBe(0);
		expect(w.sent('list_dir').at(-1)!.args).toEqual({ id: CADENCE, path: '' });
		explorer.toggle('docs');
		explorer.open('docs/notes.md', true);
		await pause();

		await showRepo(HARMONY);
		expect(explorer.root).toBe(HARMONY);
		expect(explorer.tabs()).toEqual([
			{ path: 'README.md', kind: 'text', dirty: false },
			{ path: 'src/main.ts', kind: 'text', dirty: false },
		]);
		expect(explorer.active()).toBe('src/main.ts');
		expect(explorer.preview()).toBe('src/main.ts');
		expect([...explorer.expanded()]).toEqual(['src']);
		expect(explorer.children().has('src')).toBe(true);

		await showRepo(CADENCE);
		expect(paths()).toEqual(['docs/notes.md']);
		expect([...explorer.expanded()]).toEqual(['docs']);
	});

	test('a question about a file does not follow to another checkout', async () => {
		const m = await edit('src/main.ts');
		m.type('mine\n');
		explorer.close('src/main.ts');
		expect(explorer.notice()).not.toBeNull();
		await showRepo(CADENCE);
		expect(explorer.notice()).toBeNull();
	});

	test('a checkout off screen gives up its models; its tabs, their text and where they were scrolled to stay', async () => {
		const m = await edit('README.md');
		const view = { scrolled: 300 } as never;
		explorer.saveView('README.md', view);
		await showRepo(CADENCE);
		expect(m.disposed).toBe(true);

		// Coming back, the text last read is there before the disk has answered again.
		w.on('read_file', () => new Promise(() => undefined));
		await showRepo(HARMONY);
		expect(explorer.tabs()).toEqual([{ path: 'README.md', kind: 'text', dirty: false }]);
		expect(explorer.view('README.md')).toBe(view);
		const again = (await model('README.md'))!;
		expect(again).not.toBe(m);
		expect(again.disposed).toBe(false);
		expect(again.getValue()).toBe('# harmony\n');
		expect(tab('README.md')!.dirty).toBe(false);
	});

	test('a file with unsaved edits keeps its model, the edits and their undo while its checkout is off screen', async () => {
		const m = await edit('README.md');
		m.type('mine\n');
		await showRepo(CADENCE);
		expect(m.disposed).toBe(false);
		expect(written()).toEqual([]);

		await showRepo(HARMONY);
		expect(tab('README.md')).toEqual({ path: 'README.md', kind: 'text', dirty: true });
		expect(await model('README.md')).toBe(m);
		expect(m.getValue()).toBe('mine\n');
		m.undo();
		expect(tab('README.md')!.dirty).toBe(false);
	});

	test('a file changed on disk while its checkout was off screen shows the new text on return', async () => {
		await edit('README.md');
		await showRepo(CADENCE);
		files.set('README.md', '# changed elsewhere\n');
		await showRepo(HARMONY);
		const again = (await model('README.md'))!;
		expect(again.getValue()).toBe('# changed elsewhere\n');
		expect(tab('README.md')!.dirty).toBe(false);
		again.type('mine\n');
		expect(await explorer.save('README.md')).toBe(true);
	});

	test('the same path in two repositories is two files with two models', async () => {
		const here = await edit('README.md');
		here.type('harmony\'s, unsaved\n');
		await showRepo(CADENCE);
		const there = await edit('README.md');
		expect(there).not.toBe(here);
		expect(there.uri.fsPath).toBe(`${CADENCE}/README.md`);
		expect(there.getValue()).toBe('# harmony\n');
		expect(tab('README.md')!.dirty).toBe(false);
	});

	test('a worktree is another set of files under the same repository', async () => {
		explorer.open('README.md', true);
		await pause();
		await showWorktree(TREE);
		expect(explorer.root).toBe(TREE);
		expect(paths()).toEqual([]);
		expect(explorer.absolutePath('src/main.ts')).toBe(`${TREE}/src/main.ts`);

		const m = await edit('src/main.ts');
		expect(m.uri.fsPath).toBe(`${TREE}/src/main.ts`);
		m.type('in the worktree\n');
		expect(await explorer.save('src/main.ts')).toBe(true);
		// The repository is named by its id; the checkout the text came from goes along so the native side can refuse.
		expect(w.sent('write_file').at(-1)!.args).toEqual({ id: HARMONY, path: 'src/main.ts', text: 'in the worktree\n', root: TREE });

		await showWorktree(null);
		expect(explorer.root).toBe(HARMONY);
		expect(paths()).toEqual(['README.md']);
		expect(explorer.absolutePath('src/main.ts')).toBe(`${HARMONY}/src/main.ts`);
	});

	test('file operations name the checkout they were aimed at', async () => {
		await showWorktree(TREE);
		w.on('files_trash', () => undefined);
		w.on('files_create', () => 'x.ts');
		await explorer.trash(['README.md']);
		await explorer.create('', 'x.ts', true);
		expect(w.sent('files_trash')[0].args).toMatchObject({ id: HARMONY, root: TREE });
		expect(w.sent('files_create')[0].args).toMatchObject({ id: HARMONY, root: TREE });
	});

	test('each checkout follows its own .editorconfig', async () => {
		files.set('.editorconfig', '[*]\nindent_size = 2\n');
		await explorer.rescan();
		expect(explorer.configFor('a.ts')).toEqual({ indentSize: 2 });
		files.delete('.editorconfig');
		await showRepo(CADENCE);
		expect(explorer.configFor('a.ts')).toEqual({});
	});

	test('a folder listing that arrives after the checkout changed is dropped', async () => {
		const slow = gate();
		w.on('list_dir', async (args) => {
			if (args.path === 'src') {
				await slow.wait;
			}
			return listing(String(args.path));
		});
		explorer.toggle('src');
		await showRepo(CADENCE);
		slow.open();
		await pause();
		expect(explorer.children().has('src')).toBe(false);
	});

	test('a file\'s text that arrives after the checkout changed does not land in the other checkout\'s tab', async () => {
		const slow = gate();
		let waits = 1;
		w.on('read_file', async (args) => {
			if (args.path === 'README.md' && waits-- > 0) {
				await slow.wait;
				return { text: 'harmony\'s text\n', binary: false, tooLarge: false, size: 15 };
			}
			return reading(String(args.path));
		});
		explorer.open('README.md', true);
		await showRepo(CADENCE);
		const there = await edit('README.md');
		slow.open();
		await pause();
		expect(there.getValue()).toBe('# harmony\n');
		expect(tab('README.md')).toEqual({ path: 'README.md', kind: 'text', dirty: false });
	});

	// A bug until 2026-11-23 (explorer.store.ts `read`, the guard at, and `rescan`, the filter at).
	// What holds now: a file whose read was still under way when its checkout went off screen is read when the
	// checkout comes back. Before the fix: the late answer is dropped (rightly) and nothing asks again, because a
	// rescan skips tabs that are `loading` and `open()` does not read a file that already has a tab: the
	// tab says "loading" until it is closed and opened again.
	test('a file still loading when its checkout went off screen is read when it comes back', async () => {
		const slow = gate();
		let waits = 1;
		w.on('read_file', async (args) => {
			if (args.path === 'README.md' && waits-- > 0) {
				await slow.wait;
			}
			return reading(String(args.path));
		});
		explorer.open('README.md', true);
		await showRepo(CADENCE);
		slow.open();
		await pause();
		await showRepo(HARMONY);
		expect(tab('README.md')!.kind).toBe('text');
	});

	// A bug until 2026-11-23 (explorer.store.ts `save`: `setDirty(path, …)` after the write, with no check
	// that the checkout is still the one the save began in; `read` and `loadDir` have that check).
	// What holds now: a save that finishes after the user moved to another checkout leaves that checkout's tabs
	// alone. Before the fix: the tab with the same path there (the usual case between a worktree and the main
	// checkout) is marked saved while its model still holds unsaved edits: it no longer shows as unsaved,
	// closes without the question, and is read again from disk at the next rescan.
	test('a save that finishes after a switch does not mark the other checkout\'s file of the same name as saved', async () => {
		await showWorktree(TREE);
		const theirs = await edit('src/main.ts');
		theirs.type('the worktree\'s, unsaved\n');
		await showWorktree(null);
		const mine = await edit('src/main.ts');
		mine.type('main\'s\n');
		const slow = gate();
		w.on('write_file', async (args) => {
			await slow.wait;
			writing(String(args.path), String(args.text));
		});
		const saving = explorer.save('src/main.ts');
		await pause();
		await showWorktree(TREE);
		slow.open();
		await saving;
		await pause();
		expect(theirs.getValue()).toBe('the worktree\'s, unsaved\n');
		expect(tab('src/main.ts')!.dirty).toBe(true);
	});

	// A bug until 2026-11-23 (explorer.store.ts `revert`: `patch(path, { kind, dirty: false })` after the
	// read, again without checking the checkout). Expected and actual as for the save above: reverting a
	// file, then switching before the disk answers, marks the other checkout's file of the same name as
	// saved although its edits are still in its model.
	test('a revert that finishes after a switch does not mark the other checkout\'s file of the same name as saved', async () => {
		await showWorktree(TREE);
		const theirs = await edit('src/main.ts');
		theirs.type('the worktree\'s, unsaved\n');
		await showWorktree(null);
		const mine = await edit('src/main.ts');
		mine.type('main\'s\n');
		const slow = gate();
		let waits = 1;
		w.on('read_file', async (args) => {
			if (args.path === 'src/main.ts' && waits-- > 0) {
				await slow.wait;
			}
			return reading(String(args.path));
		});
		const reverting = explorer.revert('src/main.ts');
		await showWorktree(TREE);
		slow.open();
		await reverting;
		expect(theirs.getValue()).toBe('the worktree\'s, unsaved\n');
		expect(tab('src/main.ts')!.dirty).toBe(true);
	});
});

describe('with no repository open', () => {
	test('there is nothing to list, open at a line or spell out', async () => {
		w = await world();
		w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: '', authorEmail: '', appVersion: '0.0.0' }));
		repos = w.get((await import('./repo.store')).RepoStore);
		await repos.init();
		explorer = w.get((await import('./explorer.store')).ExplorerStore);
		explorer.sync();
		await settle();
		expect(explorer.root).toBe('');
		expect(explorer.absolutePath('src/main.ts')).toBeNull();
		expect(await explorer.openAt('src/main.ts', 3)).toBe(false);
		expect(await explorer.model('src/main.ts')).toBeNull();
		expect(await explorer.save('src/main.ts')).toBe(false);
		expect(w.sent('list_dir')).toEqual([]);
		expect(w.sent('read_file')).toEqual([]);
	});
});
