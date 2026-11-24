import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../test/world';
import type { RepoStore } from './repo.store';
import type { AppStatus, Branch, Commit, FileChange, RepoStatus, RepoSummary } from './backend.service';

let w: World;
let repos: RepoStore;
/** Dialogs opened and closed through the dialog service, by id, in order. */
let opened: string[];
let closed: string[];

/** A fresh app with the store started. `before` runs once the world is there and before the store is made. */
async function start(before?: () => void): Promise<void> {
	w = await world();
	before?.();
	const { DialogService } = await import('@melodicdev/components/dialog');
	const dialogs = w.get(DialogService);
	opened = [];
	closed = [];
	dialogs.open = ((id: string) => {
		opened.push(id);
		return undefined;
	}) as unknown as typeof dialogs.open;
	dialogs.close = ((id: string) => void closed.push(id)) as unknown as typeof dialogs.close;
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

/** An answer that arrives when the test says so. */
function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Answers the calls of `cmd` one after the other; the last answer stays for the calls after it. */
function inTurn(cmd: string, ...answers: unknown[]): void {
	let n = 0;
	w.on(cmd, () => answers[Math.min(n++, answers.length - 1)]);
}

function file(path: string, status: FileChange['status'] = 'modified', oldPath: string | null = null): FileChange {
	return { path, oldPath, status };
}

function commit(n: number, extra: Partial<Commit> = {}): Commit {
	return { hash: `c${n}`, shortHash: `c${n}`, authorName: 'Me', authorEmail: 'me@example.com', date: '2026-11-20T10:00:00Z', parents: [], refs: [], summary: `Commit ${n}`, body: '', unpushed: false, ...extra };
}

/** `count` commits, numbered down from `from`: newest first, as git lists them. */
function commits(from: number, count: number): Commit[] {
	return Array.from({ length: count }, (_, i) => commit(from - i));
}

function branch(name: string, extra: Partial<Branch> = {}): Branch {
	return { name, isRemote: false, isCurrent: false, upstream: null, published: null, date: '2026-11-20T10:00:00Z', ...extra };
}

function diffOf(path: string): string {
	return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new in ${path}\n`;
}

/** The native side now answers this status (the one on screen with `change` over it), and the store has read it. */
async function statusIs(change: Partial<RepoStatus>): Promise<RepoStatus> {
	const next = { ...repos.status()!, ...change };
	w.on('repo_status', () => next);
	await repos.refresh();
	return next;
}

function errors(): string[] {
	return w.toasts.filter((t) => t.kind === 'error').map((t) => t.message);
}

beforeEach(() => start());

describe('starting', () => {
	test('reads the repositories and the open one\'s status', () => {
		expect(repos.ready()).toBe(true);
		expect(repos.repo()?.name).toBe('harmony');
		expect(repos.status()?.files.length).toBeGreaterThan(0);
		expect(repos.includedFiles().length).toBe(repos.status()!.files.length);
	});

	test('a second init does nothing', async () => {
		const before = w.sent('app_status').length;
		await repos.init();
		expect(w.sent('app_status').length).toBe(before);
	});

	test('a status that fails is said, and cleared by the next good read', async () => {
		w.on('repo_status', () => { throw appError('git', 'not a git repository'); });
		await repos.refresh();
		expect(repos.status()).toBeNull();
		expect(repos.statusError()).toBe('not a git repository');
		w.off('repo_status');
		await repos.refresh();
		expect(repos.statusError()).toBeNull();
		expect(repos.status()).not.toBeNull();
	});

	test('reads the branches too', async () => {
		await settle();
		expect(w.sent('branches').length).toBe(1);
		expect(repos.branches().some((b) => b.isCurrent)).toBe(true);
	});

	test('a list of repositories that cannot be read is said, and the app still becomes ready', async () => {
		await start(() => w.on('app_status', () => { throw appError('error', 'the config file is damaged'); }));
		expect(repos.ready()).toBe(true);
		expect(errors()).toEqual(['the config file is damaged']);
		expect(repos.repo()).toBeNull();
	});

	test('with no repository there is nothing to read and nothing to act on', async () => {
		await start(() => w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: 'Me', authorEmail: 'me@example.com', appVersion: '1.0.0' }) satisfies AppStatus));
		await settle();
		expect(repos.status()).toBeNull();
		expect(repos.sync()).toBeNull();
		expect(w.sent('repo_status')).toEqual([]);
		expect(await repos.fetch()).toBe(false);
		await repos.loadHistory(true);
		await repos.runSync();
		expect(w.sent('fetch')).toEqual([]);
		expect(w.sent('history')).toEqual([]);
		expect(repos.branches()).toEqual([]);
	});
});

describe('the checked files are the commit', () => {
	test('unticking a file leaves it out of what is sent', async () => {
		const all = repos.includedFiles().map((f) => f.path);
		repos.toggleFile(all[0], false);
		repos.summary.set('Part of it');
		await repos.commit();
		const sent = w.sent('commit_changes').at(-1)!.args;
		expect(sent.paths).toEqual(all.slice(1));
		expect(sent.summary).toBe('Part of it');
		expect(repos.summary()).toBe('');
	});

	test('nothing ticked: nothing is committed', async () => {
		repos.toggleAll(false);
		repos.summary.set('Empty');
		await repos.commit();
		expect(w.sent('commit_changes')).toEqual([]);
	});

	test('one file and no summary uses the file\'s own', async () => {
		const files = repos.status()!.files;
		repos.toggleAll(false);
		repos.toggleFile(files[0].path, true);
		const summary = repos.defaultSummary();
		expect(summary).toMatch(/^(Create|Delete|Rename|Update) /);
		await repos.commit();
		expect(w.sent('commit_changes').at(-1)!.args.summary).toBe(summary);
	});

	test('a commit that fails keeps the message and says why', async () => {
		w.on('commit_changes', () => { throw appError('git', 'pre-commit hook failed'); });
		repos.summary.set('Keep me');
		await repos.commit();
		expect(repos.summary()).toBe('Keep me');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'pre-commit hook failed' });
		expect(repos.busy()).toBe('');
	});

	test('a file that is gone from the status is no longer unticked', async () => {
		const path = repos.status()!.files[0].path;
		repos.toggleFile(path, false);
		const status = repos.status()!;
		w.on('repo_status', () => ({ ...status, files: status.files.slice(1) }));
		await repos.refresh();
		expect(repos.excluded().has(path)).toBe(false);
	});

	test('a file that changes after the others were unticked starts ticked', async () => {
		repos.toggleAll(false);
		await statusIs({ files: [...repos.status()!.files, file('brand/new.ts', 'untracked')] });
		expect(repos.includedFiles().map((f) => f.path)).toEqual(['brand/new.ts']);
	});

	test('ticking a file again puts it back', () => {
		const path = repos.status()!.files[1].path;
		repos.toggleFile(path, false);
		repos.toggleFile(path, true);
		expect(repos.includedFiles().length).toBe(repos.status()!.files.length);
		repos.toggleAll(false);
		repos.toggleAll(true);
		expect(repos.excluded().size).toBe(0);
	});

	test('a renamed file is committed under its old name and its new one', async () => {
		await statusIs({ files: [file('src/new-name.ts', 'renamed', 'src/old-name.ts'), file('b.ts')] });
		repos.summary.set('Rename it');
		await repos.commit();
		expect(w.sent('commit_changes').at(-1)!.args.paths).toEqual(['src/old-name.ts', 'src/new-name.ts', 'b.ts']);
	});

	test('the description goes with the summary, and both are cleared once committed', async () => {
		repos.summary.set('  Tidy up  ');
		repos.description.set('Because it was untidy.');
		await repos.commit();
		expect(w.sent('commit_changes').at(-1)!.args).toMatchObject({ id: repos.repo()!.id, summary: 'Tidy up', description: 'Because it was untidy.', amend: false });
		expect(repos.summary()).toBe('');
		expect(repos.description()).toBe('');
	});

	test('several files and no summary: nothing is committed', async () => {
		expect(repos.includedFiles().length).toBeGreaterThan(1);
		expect(repos.defaultSummary()).toBe('');
		await repos.commit();
		expect(w.sent('commit_changes')).toEqual([]);
	});

	test.each<[string, FileChange, string]>([
		['a new file', file('src/a.ts', 'untracked'), 'Create a.ts'],
		['an added file', file('src/a.ts', 'added'), 'Create a.ts'],
		['a deleted file', file('docs/b.md', 'deleted'), 'Delete b.md'],
		['a renamed file', file('src/c.ts', 'renamed', 'src/was.ts'), 'Rename c.ts'],
		['a modified file', file('src/d.ts', 'modified'), 'Update d.ts'],
	])('the summary offered for %s alone says what happened to it', async (_what, one, summary) => {
		await statusIs({ files: [one] });
		expect(repos.defaultSummary()).toBe(summary);
	});

	test('the status, the branches and a loaded history are read again after a commit', async () => {
		repos.setTab('history');
		await settle();
		const before = { status: w.sent('repo_status').length, branches: w.sent('branches').length, history: w.sent('history').length };
		repos.summary.set('One more');
		await repos.commit();
		await settle();
		expect(w.sent('repo_status').length).toBeGreaterThan(before.status);
		expect(w.sent('branches').length).toBeGreaterThan(before.branches);
		expect(w.sent('history').length).toBeGreaterThan(before.history);
		expect(repos.commits()[0].summary).toBe('One more');
	});
});

describe('failures', () => {
	test('conflicts go to the Changes tab', async () => {
		w.on('commit_changes', () => { throw appError('conflict', 'conflict', ['a.ts', 'b.ts']); });
		repos.tab.set('history');
		repos.summary.set('x');
		await repos.commit();
		expect(repos.tab()).toBe('changes');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'warning', title: 'Merge conflicts' });
	});

	test('a failed sign-in is said as one', async () => {
		w.on('commit_changes', () => { throw appError('auth', 'Permission denied (publickey)'); });
		repos.summary.set('x');
		await repos.commit();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'Authentication failed' });
	});

	test('the conflict toast counts the files that need resolving', async () => {
		w.on('merge_branch', () => { throw appError('conflict', 'conflict', ['a.ts', 'b.ts', 'c.ts']); });
		await repos.merge('main');
		expect(w.toasts.at(-1)!.message).toContain('3 files need resolving');
	});

	test('a very long message from git is cut short', async () => {
		w.on('fetch', () => { throw appError('git', 'x'.repeat(1000)); });
		await repos.fetch();
		expect(errors()).toEqual([`${'x'.repeat(400)}…`]);
	});

	test('something that is not one of the native side\'s errors is still said', async () => {
		w.on('fetch', () => { throw new Error('the window lost its backend'); });
		expect(await repos.fetch()).toBe(false);
		expect(errors()).toEqual(['the window lost its backend']);
		expect(repos.busy()).toBe('');
	});
});

describe('reading the status', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		await start();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const reads = () => w.sent('repo_status').length;

	test('happens again every five seconds', async () => {
		const before = reads();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(reads()).toBe(before);
		await vi.advanceTimersByTimeAsync(1);
		expect(reads()).toBe(before + 1);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(reads()).toBe(before + 3);
	});

	test('does not happen on the timer while the window is hidden', async () => {
		vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
		const before = reads();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(reads()).toBe(before);
	});

	test('does not happen on the timer while an operation is running', async () => {
		const pushed = deferred();
		w.on('push', () => pushed.promise);
		const push = repos.forcePush();
		const before = reads();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(reads()).toBe(before);
		pushed.resolve();
		await push;
		const after = reads();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(reads()).toBe(after + 1);
	});

	test('happens when the window gets the focus', async () => {
		const before = reads();
		window.dispatchEvent(new Event('focus'));
		await vi.advanceTimersByTimeAsync(0);
		expect(reads()).toBe(before + 1);
	});

	test('a status that says the same as the last one leaves what is on screen alone', async () => {
		const status = repos.status();
		const diff = repos.diff();
		expect(diff).not.toBeNull();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(repos.status()).toBe(status);
		expect(repos.diff()).toBe(diff);
	});
});

describe('a status that arrives late', () => {
	test('an older answer does not replace a newer one', async () => {
		const base = repos.status()!;
		const slow = deferred<RepoStatus>();
		inTurn('repo_status', slow.promise, { ...base, branch: 'asked-second' });
		const first = repos.refresh();
		await repos.refresh();
		expect(repos.status()!.branch).toBe('asked-second');
		slow.resolve({ ...base, branch: 'asked-first' });
		await first;
		expect(repos.status()!.branch).toBe('asked-second');
	});

	test('an older read that fails late does not wipe a newer status', async () => {
		const base = repos.status()!;
		const slow = deferred<RepoStatus>();
		inTurn('repo_status', slow.promise, { ...base, branch: 'asked-second' });
		const first = repos.refresh();
		await repos.refresh();
		slow.reject(appError('git', 'index.lock exists'));
		await first;
		expect(repos.status()!.branch).toBe('asked-second');
		expect(repos.statusError()).toBeNull();
	});

	test('an answer asked for before a worktree switch is dropped', async () => {
		const base = repos.status()!;
		const slow = deferred<RepoStatus>();
		inTurn('repo_status', slow.promise, { ...base, branch: 'the-worktree' });
		const first = repos.refresh();
		await repos.switchContext();
		slow.resolve({ ...base, branch: 'the-main-checkout' });
		await first;
		expect(repos.status()!.branch).toBe('the-worktree');
	});
});

describe('HEAD moved outside the app', () => {
	test('a new commit brings the branches and a loaded history up to date', async () => {
		repos.setTab('history');
		await settle();
		const before = { history: w.sent('history').length, branches: w.sent('branches').length };
		await statusIs({ head: 'f'.repeat(40) });
		await settle();
		expect(w.sent('history').length).toBe(before.history + 1);
		expect(w.sent('branches').length).toBe(before.branches + 1);
	});

	test('a checkout in a terminal does the same', async () => {
		await settle();
		const before = w.sent('branches').length;
		await statusIs({ branch: 'made-in-a-terminal' });
		await settle();
		expect(w.sent('branches').length).toBe(before + 1);
	});

	test('a history that was never opened is not read for it', async () => {
		await statusIs({ head: 'f'.repeat(40) });
		await settle();
		expect(w.sent('history')).toEqual([]);
	});

	test('a change to the files alone reads neither', async () => {
		repos.setTab('history');
		await settle();
		const before = { history: w.sent('history').length, branches: w.sent('branches').length };
		await statusIs({ files: [file('only/this.ts')] });
		await settle();
		expect(w.sent('history').length).toBe(before.history);
		expect(w.sent('branches').length).toBe(before.branches);
	});
});

describe('the selected file', () => {
	beforeEach(async () => {
		w.on('file_diff', ({ path }) => ({ text: diffOf(String(path)), tooLarge: false }));
		await statusIs({ files: [file('a.ts'), file('b.ts'), file('c.ts')] });
	});

	test('is the first changed file, with its diff read', () => {
		expect(repos.selectedPath()).toBe('a.ts');
		expect(repos.selectedFile()).toEqual(file('a.ts'));
		expect(repos.diff()!.raw).toBe(diffOf('a.ts'));
	});

	test('shows nothing until its diff arrives', async () => {
		const slow = deferred<{ text: string; tooLarge: boolean }>();
		w.on('file_diff', () => slow.promise);
		repos.selectFile('b.ts');
		expect(repos.selectedPath()).toBe('b.ts');
		expect(repos.diff()).toBeNull();
		slow.resolve({ text: diffOf('b.ts'), tooLarge: false });
		await settle();
		expect(repos.diff()!.raw).toBe(diffOf('b.ts'));
	});

	test('the diff is asked for with the file as the status names it', async () => {
		await statusIs({ files: [file('a.ts'), file('moved/to.ts', 'renamed', 'was/from.ts')] });
		repos.selectFile('moved/to.ts');
		await settle();
		expect(w.sent('file_diff').at(-1)!.args).toEqual({ id: repos.repo()!.id, path: 'moved/to.ts', oldPath: 'was/from.ts', status: 'renamed' });
	});

	test('selecting the file already shown asks for nothing', async () => {
		const before = w.sent('file_diff').length;
		repos.selectFile('a.ts');
		await settle();
		expect(w.sent('file_diff').length).toBe(before);
		expect(repos.diff()).not.toBeNull();
	});

	test('the diff of a file left behind is dropped when it arrives late', async () => {
		const slow = deferred<{ text: string; tooLarge: boolean }>();
		inTurn('file_diff', slow.promise, { text: diffOf('c.ts'), tooLarge: false });
		repos.selectFile('b.ts');
		repos.selectFile('c.ts');
		await settle();
		slow.resolve({ text: diffOf('b.ts'), tooLarge: false });
		await settle();
		expect(repos.selectedPath()).toBe('c.ts');
		expect(repos.diff()!.raw).toBe(diffOf('c.ts'));
	});

	test('a diff that cannot be read shows as empty, not as loading for ever', async () => {
		w.on('file_diff', () => { throw appError('git', 'bad object'); });
		repos.selectFile('b.ts');
		await settle();
		expect(repos.diff()).not.toBeNull();
		expect(repos.diff()!.lines).toEqual([]);
		expect(w.toasts).toEqual([]);
	});

	test('a diff too large to show is marked as that', async () => {
		w.on('file_diff', () => ({ text: '', tooLarge: true }));
		repos.selectFile('b.ts');
		await settle();
		expect(repos.diff()!.tooLarge).toBe(true);
	});

	test('a diff that changed on disk is read again by the next status', async () => {
		w.on('file_diff', () => ({ text: `${diffOf('a.ts')}+one more line\n`, tooLarge: false }));
		await repos.refresh();
		expect(repos.diff()!.raw).toContain('+one more line');
	});

	test('when the selected file is no longer changed the first one left is shown', async () => {
		repos.selectFile('b.ts');
		await settle();
		await statusIs({ files: [file('a.ts'), file('c.ts')] });
		expect(repos.selectedPath()).toBe('a.ts');
		expect(repos.diff()!.raw).toBe(diffOf('a.ts'));
	});

	test('with no changes left nothing is selected', async () => {
		await statusIs({ files: [] });
		expect(repos.selectedPath()).toBeNull();
		expect(repos.selectedFile()).toBeNull();
		expect(repos.diff()).toBeNull();
	});
});

describe('files pinned as tabs', () => {
	beforeEach(async () => {
		w.on('file_diff', ({ path }) => ({ text: diffOf(String(path)), tooLarge: false }));
		await statusIs({ files: [file('a.ts'), file('b.ts'), file('c.ts'), file('d.ts')] });
	});

	test('pinning a file shows it, and the tabs keep the order they were opened in', async () => {
		repos.openTab('c.ts');
		repos.openTab('a.ts');
		repos.openTab('b.ts');
		await settle();
		expect(repos.openTabs()).toEqual(['c.ts', 'a.ts', 'b.ts']);
		expect(repos.selectedPath()).toBe('b.ts');
		expect(repos.diff()!.raw).toBe(diffOf('b.ts'));
	});

	test('pinning a file twice makes one tab', () => {
		repos.openTab('b.ts');
		repos.openTab('c.ts');
		repos.openTab('b.ts');
		expect(repos.openTabs()).toEqual(['b.ts', 'c.ts']);
		expect(repos.selectedPath()).toBe('b.ts');
	});

	test('closing the tab on screen shows the one that takes its place', () => {
		repos.openTab('a.ts');
		repos.openTab('b.ts');
		repos.openTab('c.ts');
		repos.selectFile('b.ts');
		repos.closeTab('b.ts');
		expect(repos.openTabs()).toEqual(['a.ts', 'c.ts']);
		expect(repos.selectedPath()).toBe('c.ts');
	});

	test('closing the last tab in the row shows the one before it', () => {
		repos.openTab('a.ts');
		repos.openTab('b.ts');
		repos.closeTab('b.ts');
		expect(repos.openTabs()).toEqual(['a.ts']);
		expect(repos.selectedPath()).toBe('a.ts');
	});

	test('closing a tab that is not on screen keeps the one that is', () => {
		repos.openTab('a.ts');
		repos.openTab('b.ts');
		repos.closeTab('a.ts');
		expect(repos.openTabs()).toEqual(['b.ts']);
		expect(repos.selectedPath()).toBe('b.ts');
	});

	test('closing the only tab leaves its file selected in the list', () => {
		repos.openTab('d.ts');
		repos.closeTab('d.ts');
		expect(repos.openTabs()).toEqual([]);
		expect(repos.selectedPath()).toBe('d.ts');
	});

	test('closing a file that has no tab does nothing', () => {
		repos.openTab('a.ts');
		repos.closeTab('c.ts');
		expect(repos.openTabs()).toEqual(['a.ts']);
		expect(repos.selectedPath()).toBe('a.ts');
	});

	test('a pinned file that is no longer changed loses its tab', async () => {
		repos.openTab('b.ts');
		repos.openTab('c.ts');
		await statusIs({ files: [file('a.ts'), file('c.ts')] });
		expect(repos.openTabs()).toEqual(['c.ts']);
		expect(repos.selectedPath()).toBe('c.ts');
	});
});

describe('amending', () => {
	const last = { hash: 'c9', summary: 'Wrap the queue', description: 'So repeat works.' };

	test('is refused while the last commit is on a remote', async () => {
		await statusIs({ undo: null });
		repos.setAmend(true);
		expect(repos.amend()).toBe(false);
		expect(repos.summary()).toBe('');
	});

	test('starts from the last commit\'s message', async () => {
		await statusIs({ undo: last });
		repos.setAmend(true);
		expect(repos.amend()).toBe(true);
		expect(repos.summary()).toBe('Wrap the queue');
		expect(repos.description()).toBe('So repeat works.');
	});

	test('keeps a message that was already typed', async () => {
		await statusIs({ undo: last });
		repos.summary.set('My own words');
		repos.description.set('And more of them');
		repos.setAmend(true);
		expect(repos.summary()).toBe('My own words');
		expect(repos.description()).toBe('And more of them');
	});

	test('with nothing ticked still replaces the last commit (its message)', async () => {
		await statusIs({ undo: last });
		repos.toggleAll(false);
		repos.setAmend(true);
		repos.summary.set('Wrap the queue on repeat');
		await repos.commit();
		expect(w.sent('commit_changes').at(-1)!.args).toMatchObject({ paths: [], summary: 'Wrap the queue on repeat', amend: true });
	});

	test('is off again after the commit', async () => {
		await statusIs({ undo: last });
		repos.setAmend(true);
		await repos.commit();
		expect(w.sent('commit_changes').at(-1)!.args.amend).toBe(true);
		expect(repos.amend()).toBe(false);
	});

	test('stays on when the commit fails', async () => {
		await statusIs({ undo: last });
		w.on('commit_changes', () => { throw appError('git', 'hook said no'); });
		repos.setAmend(true);
		await repos.commit();
		expect(repos.amend()).toBe(true);
		expect(repos.summary()).toBe('Wrap the queue');
	});

	test('goes off when the last commit turns out to be pushed', async () => {
		await statusIs({ undo: last });
		repos.setAmend(true);
		await statusIs({ undo: null });
		expect(repos.amend()).toBe(false);
	});

	test('turning it off sends an ordinary commit', async () => {
		await statusIs({ undo: last });
		repos.setAmend(true);
		repos.setAmend(false);
		repos.summary.set('A new one');
		await repos.commit();
		expect(w.sent('commit_changes').at(-1)!.args.amend).toBe(false);
	});
});

describe('undoing the last commit', () => {
	test('puts its message back in the form and shows the Changes tab', async () => {
		w.on('undo_commit', () => ({ summary: 'Wrap the queue', description: 'So repeat works.' }));
		repos.tab.set('history');
		await repos.undoCommit();
		expect(w.sent('undo_commit')).toEqual([{ cmd: 'undo_commit', args: { id: repos.repo()!.id } }]);
		expect(repos.summary()).toBe('Wrap the queue');
		expect(repos.description()).toBe('So repeat works.');
		expect(repos.tab()).toBe('changes');
	});

	test('an undo that git refuses leaves the form and the tab as they were', async () => {
		w.on('undo_commit', () => { throw appError('git', 'the commit is already on origin'); });
		repos.tab.set('history');
		repos.summary.set('Half typed');
		await repos.undoCommit();
		expect(repos.summary()).toBe('Half typed');
		expect(repos.tab()).toBe('history');
		expect(errors()).toEqual(['the commit is already on origin']);
	});
});

describe('discarding', () => {
	test('names each file by its path and the path it had before', async () => {
		const files = [file('a.ts'), file('new.ts', 'untracked'), file('to.ts', 'renamed', 'from.ts')];
		await repos.discard(files);
		expect(w.sent('discard_changes')).toEqual([{ cmd: 'discard_changes', args: { id: repos.repo()!.id, files: [{ path: 'a.ts', oldPath: null }, { path: 'new.ts', oldPath: null }, { path: 'to.ts', oldPath: 'from.ts' }] } }]);
	});

	test('the files are gone from the list afterwards', async () => {
		const [first, ...rest] = repos.status()!.files;
		await repos.discard([first]);
		expect(repos.status()!.files).toEqual(rest);
		expect(repos.selectedPath()).toBe(rest[0].path);
	});

	test('a discard that fails is said and the files stay', async () => {
		w.on('discard_changes', () => { throw appError('error', 'the trash is not available'); });
		const files = repos.status()!.files;
		await repos.discard([files[0]]);
		expect(errors()).toEqual(['the trash is not available']);
		expect(repos.status()!.files).toEqual(files);
		expect(repos.busy()).toBe('');
	});
});

describe('one operation at a time', () => {
	test('a second one is refused while the first is running', async () => {
		const fetched = deferred();
		w.on('fetch', () => fetched.promise);
		const first = repos.fetch();
		expect(repos.busy()).toBe('fetch');
		expect(await repos.merge('main')).toBe(false);
		expect(await repos.stash()).toBe(false);
		expect(await repos.addRepo('/somewhere/else')).toBe(false);
		expect(await repos.addRepos(['/somewhere/else'])).toBe(false);
		expect(await repos.deleteBranch('main', false)).toBe('failed');
		repos.summary.set('Not now');
		await repos.commit();
		fetched.resolve();
		expect(await first).toBe(true);
		expect(repos.busy()).toBe('');
		for (const cmd of ['merge_branch', 'stash_save', 'repo_add', 'repo_add_many', 'branch_delete', 'commit_changes']) {
			expect(w.sent(cmd)).toEqual([]);
		}
		expect(repos.summary()).toBe('Not now');
	});

	test.each<[string, (r: RepoStore) => Promise<unknown>, string]>([
		['a commit', (r) => (r.summary.set('x'), r.commit()), 'commit'],
		['an undo', (r) => r.undoCommit(), 'undo'],
		['a discard', (r) => r.discard([file('a.ts')]), 'discard'],
		['a stash', (r) => r.stash(), 'stash'],
		['a merge', (r) => r.merge('main'), 'merge'],
		['a rebase', (r) => r.rebaseOnto('main'), 'merge'],
		['a cherry-pick', (r) => r.cherryPick(['c1']), 'merge'],
		['a revert', (r) => r.revertCommit('c1'), 'history'],
		['a reset', (r) => r.resetTo('c1', 'mixed'), 'history'],
		['a checkout', (r) => r.checkout(branch('main')), 'checkout'],
		['a new branch', (r) => r.createBranch('topic'), 'branch'],
		['a fetch', (r) => r.fetch(), 'fetch'],
		['a forced push', (r) => r.forcePush(), 'push'],
		['adding a repository', (r) => r.addRepo('/r/new'), 'repo'],
	])('%s shows as running until it ends', async (_what, run, busy) => {
		const done = run(repos);
		expect(repos.busy()).toBe(busy);
		await done;
		expect(repos.busy()).toBe('');
	});
});

describe('stashing', () => {
	test('stashes under the summary that was typed', async () => {
		repos.summary.set('  half a feature  ');
		expect(await repos.stash()).toBe(true);
		expect(w.sent('stash_save')).toEqual([{ cmd: 'stash_save', args: { id: repos.repo()!.id, message: 'half a feature' } }]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Changes stashed' });
	});

	test('the stash shows in the status that is read afterwards', async () => {
		await repos.stash();
		expect(repos.status()!.files).toEqual([]);
		expect(repos.status()!.stashes.length).toBe(1);
	});

	test('a stash is put back or dropped by its name', async () => {
		await repos.stashPop('stash@{1}');
		await repos.stashDrop('stash@{0}');
		expect(w.sent('stash_pop')[0].args).toEqual({ id: repos.repo()!.id, name: 'stash@{1}' });
		expect(w.sent('stash_drop')[0].args).toEqual({ id: repos.repo()!.id, name: 'stash@{0}' });
	});

	test('a stash that fails is said and nothing is called stashed', async () => {
		w.on('stash_save', () => { throw appError('git', 'No local changes to save'); });
		expect(await repos.stash()).toBe(false);
		expect(w.toasts.map((t) => t.kind)).toEqual(['error']);
	});

	test('putting one back onto conflicting changes goes to the Changes tab', async () => {
		w.on('stash_pop', () => { throw appError('conflict', 'conflict', ['a.ts']); });
		repos.tab.set('files');
		expect(await repos.stashPop('stash@{0}')).toBe(false);
		expect(repos.tab()).toBe('changes');
		expect(w.toasts.at(-1)!.message).toContain('1 file need');
	});
});

describe('history', () => {
	let all: Commit[];

	beforeEach(() => {
		all = commits(150, 150);
		w.on('history', ({ skip, limit }) => all.slice(Number(skip), Number(skip) + Number(limit)));
		w.on('commit_files', ({ hash }) => [file(`${String(hash)}/first.ts`), file(`${String(hash)}/second.ts`, 'added')]);
		w.on('commit_diff', ({ path }) => ({ text: diffOf(String(path)), tooLarge: false }));
	});

	test('opening the History tab reads the first hundred commits, once', async () => {
		repos.setTab('history');
		await settle();
		expect(w.sent('history')).toEqual([{ cmd: 'history', args: { id: repos.repo()!.id, skip: 0, limit: 100, path: null } }]);
		expect(repos.commits().length).toBe(100);
		expect(repos.historyLoaded()).toBe(true);
		expect(repos.historyEnd()).toBe(false);
		repos.setTab('changes');
		repos.setTab('history');
		await settle();
		expect(w.sent('history').length).toBe(1);
	});

	test('the next page is added after the first, and a short page is the end', async () => {
		await repos.loadHistory(true);
		await repos.loadHistory(false);
		expect(w.sent('history').at(-1)!.args).toMatchObject({ skip: 100, limit: 100 });
		expect(repos.commits().map((c) => c.hash)).toEqual(all.map((c) => c.hash));
		expect(repos.historyEnd()).toBe(true);
	});

	test('reading from the top again replaces the list', async () => {
		await repos.loadHistory(true);
		await repos.loadHistory(false);
		await repos.loadHistory(true);
		expect(repos.commits().length).toBe(100);
		expect(repos.historyEnd()).toBe(false);
	});

	test('the newest commit is selected, with its files and the first one\'s diff', async () => {
		await repos.loadHistory(true);
		await settle();
		expect(repos.selectedHash()).toBe('c150');
		expect(repos.selectedCommit()).toEqual(all[0]);
		expect(repos.commitFiles().map((f) => f.path)).toEqual(['c150/first.ts', 'c150/second.ts']);
		expect(repos.selectedCommitPath()).toBe('c150/first.ts');
		expect(repos.selectedCommitFile()).toEqual(file('c150/first.ts'));
		expect(repos.commitDiff()!.raw).toBe(diffOf('c150/first.ts'));
	});

	test('a commit that is still listed stays selected when the history is read again', async () => {
		await repos.loadHistory(true);
		repos.selectCommit('c120');
		await repos.loadHistory(true);
		expect(repos.selectedHash()).toBe('c120');
	});

	test('a selected commit that is gone gives way to the newest', async () => {
		await repos.loadHistory(true);
		repos.selectCommit('c120');
		all = commits(300, 20);
		await repos.loadHistory(true);
		expect(repos.selectedHash()).toBe('c300');
	});

	test('a branch with no commits selects nothing', async () => {
		await repos.loadHistory(true);
		await settle();
		all = [];
		await repos.loadHistory(true);
		expect(repos.commits()).toEqual([]);
		expect(repos.historyEnd()).toBe(true);
		expect(repos.selectedHash()).toBeNull();
		expect(repos.selectedCommit()).toBeNull();
		expect(repos.commitFiles()).toEqual([]);
		expect(repos.commitDiff()).toBeNull();
	});

	test('an older page that arrives late is dropped', async () => {
		const slow = deferred<Commit[]>();
		inTurn('history', slow.promise, [commit(7), commit(6)]);
		const first = repos.loadHistory(true);
		await repos.loadHistory(true);
		slow.resolve([commit(99)]);
		await first;
		expect(repos.commits().map((c) => c.hash)).toEqual(['c7', 'c6']);
	});

	test('a history that cannot be read is said, and no longer shows as loading', async () => {
		w.on('history', () => { throw appError('git', 'bad revision HEAD'); });
		await repos.loadHistory(true);
		expect(repos.historyLoaded()).toBe(true);
		expect(errors()).toEqual(['bad revision HEAD']);
	});

	test('selecting a commit clears what the last one showed until its files arrive', async () => {
		await repos.loadHistory(true);
		await settle();
		const slow = deferred<FileChange[]>();
		w.on('commit_files', () => slow.promise);
		repos.selectCommit('c149');
		expect(repos.selectedHash()).toBe('c149');
		expect(repos.commitFiles()).toEqual([]);
		expect(repos.selectedCommitPath()).toBeNull();
		expect(repos.commitDiff()).toBeNull();
		slow.resolve([file('only.ts')]);
		await settle();
		expect(repos.commitFiles()).toEqual([file('only.ts')]);
		expect(w.sent('commit_files').at(-1)!.args).toEqual({ id: repos.repo()!.id, hash: 'c149' });
	});

	test('selecting the commit already shown reads nothing', async () => {
		await repos.loadHistory(true);
		await settle();
		const before = w.sent('commit_files').length;
		repos.selectCommit('c150');
		await settle();
		expect(w.sent('commit_files').length).toBe(before);
		expect(repos.commitFiles().length).toBe(2);
	});

	test('the files of a commit left behind are dropped when they arrive late', async () => {
		await repos.loadHistory(true);
		await settle();
		const slow = deferred<FileChange[]>();
		inTurn('commit_files', slow.promise, [file('of-c148.ts')]);
		repos.selectCommit('c149');
		repos.selectCommit('c148');
		await settle();
		slow.resolve([file('of-c149.ts')]);
		await settle();
		expect(repos.selectedHash()).toBe('c148');
		expect(repos.commitFiles()).toEqual([file('of-c148.ts')]);
	});

	test('a commit that touched no file shows an empty diff', async () => {
		await repos.loadHistory(true);
		await settle();
		w.on('commit_files', () => []);
		repos.selectCommit('c149');
		await settle();
		expect(repos.commitFiles()).toEqual([]);
		expect(repos.commitDiff()).not.toBeNull();
		expect(repos.commitDiff()!.lines).toEqual([]);
	});

	test('a commit whose files cannot be read is said', async () => {
		await repos.loadHistory(true);
		await settle();
		w.on('commit_files', () => { throw appError('git', 'bad object c149'); });
		repos.selectCommit('c149');
		await settle();
		expect(errors()).toEqual(['bad object c149']);
	});

	test('another file of the commit is read when it is selected, and only then', async () => {
		await repos.loadHistory(true);
		await settle();
		const before = w.sent('commit_diff').length;
		repos.selectCommitFile('c150/first.ts');
		await settle();
		expect(w.sent('commit_diff').length).toBe(before);
		repos.selectCommitFile('c150/second.ts');
		expect(repos.commitDiff()).toBeNull();
		await settle();
		expect(w.sent('commit_diff').at(-1)!.args).toEqual({ id: repos.repo()!.id, hash: 'c150', path: 'c150/second.ts', oldPath: null });
		expect(repos.commitDiff()!.raw).toBe(diffOf('c150/second.ts'));
	});

	test('a file the commit does not have cannot be selected', async () => {
		await repos.loadHistory(true);
		await settle();
		repos.selectCommitFile('not/in/it.ts');
		expect(repos.selectedCommitPath()).toBe('c150/first.ts');
	});

	test('a commit\'s diff that cannot be read shows as empty', async () => {
		await repos.loadHistory(true);
		await settle();
		w.on('commit_diff', () => { throw appError('git', 'bad object'); });
		repos.selectCommitFile('c150/second.ts');
		await settle();
		expect(repos.commitDiff()!.lines).toEqual([]);
	});

	test('the diff of a commit file left behind is dropped when it arrives late', async () => {
		await repos.loadHistory(true);
		await settle();
		const slow = deferred<{ text: string; tooLarge: boolean }>();
		inTurn('commit_diff', slow.promise, { text: diffOf('c150/first.ts'), tooLarge: false });
		repos.selectCommitFile('c150/second.ts');
		repos.selectCommitFile('c150/first.ts');
		await settle();
		slow.resolve({ text: diffOf('c150/second.ts'), tooLarge: false });
		await settle();
		expect(repos.commitDiff()!.raw).toBe(diffOf('c150/first.ts'));
	});

	describe('of one file', () => {
		test('lists only the commits that touched it, on the History tab', async () => {
			repos.tab.set('files');
			await repos.showFileHistory('src/player/queue.ts');
			expect(repos.tab()).toBe('history');
			expect(repos.historyPath()).toBe('src/player/queue.ts');
			expect(w.sent('history').at(-1)!.args).toEqual({ id: repos.repo()!.id, skip: 0, limit: 100, path: 'src/player/queue.ts' });
		});

		test('more of them are asked for with the same file', async () => {
			await repos.showFileHistory('src/player/queue.ts');
			await repos.loadHistory(false);
			expect(w.sent('history').at(-1)!.args).toMatchObject({ skip: 100, path: 'src/player/queue.ts' });
		});

		test('the newest of its commits is selected, whatever was before', async () => {
			await repos.loadHistory(true);
			repos.selectCommit('c120');
			all = [commit(120), commit(90), commit(40)];
			await repos.showFileHistory('src/player/queue.ts');
			expect(repos.selectedHash()).toBe('c120');
			expect(repos.commits().length).toBe(3);
		});

		test('going back to every commit stays on the tab it was asked from', async () => {
			await repos.showFileHistory('src/player/queue.ts');
			repos.tab.set('changes');
			await repos.showFileHistory(null);
			expect(repos.historyPath()).toBeNull();
			expect(repos.tab()).toBe('changes');
			expect(w.sent('history').at(-1)!.args.path).toBeNull();
		});

		test('a comparison with a branch is left first', async () => {
			w.on('compare_history', () => [commit(900)]);
			w.on('compare_counts', () => []);
			await repos.loadHistory(true);
			await repos.setCompare('main');
			await repos.showFileHistory('src/player/queue.ts');
			expect(repos.compareBranch()).toBeNull();
			expect(repos.historyPath()).toBe('src/player/queue.ts');
		});
	});
});

describe('comparing with a branch', () => {
	let behind: Commit[];
	let ahead: Commit[];

	beforeEach(async () => {
		behind = [commit(902), commit(901)];
		ahead = [commit(803), commit(802), commit(801)];
		w.on('history', () => commits(10, 10));
		w.on('commit_files', () => [file('x.ts')]);
		w.on('commit_diff', () => ({ text: diffOf('x.ts'), tooLarge: false }));
		w.on('compare_history', (args) => (args.ahead ? ahead : behind).slice(Number(args.skip), Number(args.skip) + Number(args.limit)));
		w.on('compare_counts', ({ branches }) => (branches as string[]).map((name) => ({ name, ahead: ahead.length, behind: behind.length })));
		await repos.loadHistory(true);
		await settle();
	});

	test('lists what merging the branch would bring in, and counts both sides', async () => {
		await repos.setCompare('main');
		expect(repos.compareBranch()).toBe('main');
		expect(w.sent('compare_history')).toEqual([{ cmd: 'compare_history', args: { id: repos.repo()!.id, branch: 'main', ahead: false, skip: 0, limit: 100 } }]);
		expect(w.sent('compare_counts')).toEqual([{ cmd: 'compare_counts', args: { id: repos.repo()!.id, branches: ['main'] } }]);
		expect(repos.compareAhead()).toBe(false);
		expect(repos.compareCommits()).toEqual(behind);
		expect(repos.compareLoaded()).toBe(true);
		expect(repos.compareEnd()).toBe(true);
		expect(repos.compareCounts().get('main')).toEqual({ name: 'main', ahead: 3, behind: 2 });
	});

	test('the newest commit of the comparison is the selected one', async () => {
		await repos.setCompare('main');
		expect(repos.selectedHash()).toBe('c902');
		expect(repos.selectedCommit()).toEqual(behind[0]);
	});

	test('starts on this branch\'s own commits when the other is known to bring nothing', async () => {
		w.on('compare_counts', () => [{ name: 'merged-already', ahead: 3, behind: 0 }]);
		await repos.loadCompareCounts(['merged-already']);
		await repos.setCompare('merged-already');
		expect(repos.compareAhead()).toBe(true);
		expect(w.sent('compare_history').at(-1)!.args.ahead).toBe(true);
		expect(repos.compareCommits()).toEqual(ahead);
	});

	test('the other side is read when it is asked for, and not again for the side on screen', async () => {
		await repos.setCompare('main');
		repos.setCompareAhead(true);
		await settle();
		expect(repos.compareCommits()).toEqual(ahead);
		expect(w.sent('compare_history').length).toBe(2);
		repos.setCompareAhead(true);
		await settle();
		expect(w.sent('compare_history').length).toBe(2);
	});

	test('more commits are added a page at a time', async () => {
		behind = commits(1150, 150);
		await repos.setCompare('main');
		expect(repos.compareCommits().length).toBe(100);
		expect(repos.compareEnd()).toBe(false);
		await repos.loadCompare(false);
		expect(w.sent('compare_history').at(-1)!.args).toMatchObject({ skip: 100, limit: 100 });
		expect(repos.compareCommits().length).toBe(150);
		expect(repos.compareEnd()).toBe(true);
	});

	test('a side with nothing on it selects no commit', async () => {
		behind = [];
		await repos.setCompare('main');
		expect(repos.compareLoaded()).toBe(true);
		expect(repos.selectedHash()).toBeNull();
		expect(repos.commitFiles()).toEqual([]);
	});

	test('an answer for the side left behind is dropped when it arrives late', async () => {
		await repos.setCompare('main');
		const slow = deferred<Commit[]>();
		inTurn('compare_history', slow.promise, behind);
		repos.setCompareAhead(true);
		repos.setCompareAhead(false);
		await settle();
		slow.resolve(ahead);
		await settle();
		expect(repos.compareAhead()).toBe(false);
		expect(repos.compareCommits()).toEqual(behind);
	});

	test('leaving the comparison goes back to the history and its newest commit', async () => {
		await repos.setCompare('main');
		await repos.setCompare(null);
		expect(repos.compareBranch()).toBeNull();
		expect(repos.compareCommits()).toEqual([]);
		expect(repos.selectedHash()).toBe('c10');
		expect(repos.selectedCommit()!.hash).toBe('c10');
	});

	test('a branch that is gone ends the comparison without an error', async () => {
		w.on('compare_history', () => { throw appError('git', 'unknown revision gone'); });
		await repos.setCompare('gone');
		await settle();
		expect(repos.compareBranch()).toBeNull();
		expect(w.toasts).toEqual([]);
	});

	test('counts are asked for a hundred branches at most, and for none at all when the list is empty', async () => {
		await repos.loadCompareCounts([]);
		expect(w.sent('compare_counts')).toEqual([]);
		await repos.loadCompareCounts(Array.from({ length: 150 }, (_, i) => `b${i}`));
		expect((w.sent('compare_counts')[0].args.branches as string[]).length).toBe(100);
	});

	test('counts add up over the lists that asked for them', async () => {
		await repos.loadCompareCounts(['one']);
		await repos.loadCompareCounts(['two']);
		expect([...repos.compareCounts().keys()]).toEqual(['one', 'two']);
	});

	test('counts that cannot be read are not an error', async () => {
		w.on('compare_counts', () => { throw appError('git', 'no such ref'); });
		await repos.loadCompareCounts(['main']);
		expect(repos.compareCounts().size).toBe(0);
		expect(w.toasts).toEqual([]);
	});

	test('after anything that moves HEAD the counts are thrown away and the comparison is read again', async () => {
		await repos.setCompare('main');
		await repos.loadCompareCounts(['some-other-branch']);
		behind = [commit(903), ...behind];
		await repos.merge('some-other-branch');
		await settle();
		expect([...repos.compareCounts().keys()]).toEqual(['main']);
		expect(repos.compareCounts().get('main')!.behind).toBe(3);
		expect(repos.compareCommits()).toEqual(behind);
	});

	test('what a branch would bring in can be asked for without comparing', async () => {
		expect(await repos.incoming('release/1.4')).toEqual(behind);
		expect(w.sent('compare_history').at(-1)!.args).toEqual({ id: repos.repo()!.id, branch: 'release/1.4', ahead: false, skip: 0, limit: 500 });
		expect(repos.compareBranch()).toBeNull();
	});

	test('asking that of a branch that is gone answers nothing and says why', async () => {
		w.on('compare_history', () => { throw appError('git', 'unknown revision gone'); });
		expect(await repos.incoming('gone')).toEqual([]);
		expect(errors()).toEqual(['unknown revision gone']);
	});
});

describe('branches', () => {
	const id = () => repos.repo()!.id;

	/** The branch on screen and the others there are; the first name is the one checked out. */
	async function branchesAre(...names: string[]): Promise<void> {
		const list = names.map((name, i) => branch(name, { isCurrent: i === 0, isRemote: name.startsWith('origin/') }));
		w.on('branches', () => list);
		await statusIs({ branch: names[0], detached: false });
		await settle();
	}

	test('a new branch is made from the commit on screen unless told otherwise', async () => {
		expect(await repos.createBranch('topic')).toBe(true);
		expect(await repos.createBranch('from-there', 'c42')).toBe(true);
		expect(w.sent('branch_create').map((c) => c.args)).toEqual([{ id: id(), name: 'topic', start: null }, { id: id(), name: 'from-there', start: 'c42' }]);
	});

	test('the list is read again once a branch was made', async () => {
		await repos.createBranch('topic');
		await settle();
		expect(repos.branches().find((b) => b.name === 'topic')?.isCurrent).toBe(true);
		expect(repos.status()!.branch).toBe('topic');
	});

	test('a branch that cannot be made is said', async () => {
		w.on('branch_create', () => { throw appError('git', 'a branch named topic already exists'); });
		expect(await repos.createBranch('topic')).toBe(false);
		expect(errors()).toEqual(['a branch named topic already exists']);
	});

	test('switching says whether the branch is a remote one', async () => {
		await repos.checkout(branch('main'));
		await repos.checkout(branch('origin/release/1.4', { isRemote: true }));
		expect(w.sent('branch_checkout').map((c) => c.args)).toEqual([{ id: id(), name: 'main', isRemote: false }, { id: id(), name: 'origin/release/1.4', isRemote: true }]);
	});

	test('a switch stopped by local changes is said, and the branch stays', async () => {
		w.on('branch_checkout', () => { throw appError('git', 'Your local changes would be overwritten by checkout'); });
		const was = repos.status()!.branch;
		expect(await repos.checkout(branch('main'))).toBe(false);
		expect(errors()).toEqual(['Your local changes would be overwritten by checkout']);
		expect(repos.status()!.branch).toBe(was);
	});

	test('renaming names both', async () => {
		await repos.renameBranch('old', 'new');
		expect(w.sent('branch_rename')[0].args).toEqual({ id: id(), from: 'old', to: 'new' });
	});

	test('a list that cannot be read keeps the one there was, silently', async () => {
		await settle();
		const before = repos.branches();
		w.on('branches', () => { throw appError('git', 'not a git repository'); });
		await repos.loadBranches();
		expect(repos.branches()).toBe(before);
		expect(w.toasts).toEqual([]);
	});

	describe('deleting one', () => {
		test('deletes it locally only, and safely, unless asked otherwise', async () => {
			await branchesAre('topic', 'main', 'done');
			expect(await repos.deleteBranch('done', false)).toBe('ok');
			expect(w.sent('branch_delete')).toEqual([{ cmd: 'branch_delete', args: { id: id(), name: 'done', force: false, remote: false } }]);
			expect(w.sent('branch_checkout')).toEqual([]);
			expect(w.sent('branch_delete_remote')).toEqual([]);
		});

		test('with the box ticked its copy on the remote goes too, in the same call', async () => {
			await branchesAre('topic', 'main', 'done');
			expect(await repos.deleteBranch('done', false, true)).toBe('ok');
			expect(w.sent('branch_delete')[0].args).toEqual({ id: id(), name: 'done', force: false, remote: true });
		});

		test('one git will not delete safely is reported as unmerged, with no error shown', async () => {
			await branchesAre('topic', 'main', 'wip');
			w.on('branch_delete', () => { throw appError('git', 'error: The branch \'wip\' is not fully merged.'); });
			expect(await repos.deleteBranch('wip', false)).toBe('unmerged');
			expect(w.toasts).toEqual([]);
			expect(repos.busy()).toBe('');
		});

		test('forcing it is a second call, which says force', async () => {
			await branchesAre('topic', 'main', 'wip');
			w.on('branch_delete', ({ force }) => {
				if (!force) {
					throw appError('git', 'error: The branch \'wip\' is not fully merged.');
				}
			});
			expect(await repos.deleteBranch('wip', false)).toBe('unmerged');
			expect(await repos.deleteBranch('wip', true)).toBe('ok');
			expect(w.sent('branch_delete').map((c) => c.args.force)).toEqual([false, true]);
			expect(w.toasts).toEqual([]);
		});

		test('a forced delete that still fails has failed', async () => {
			await branchesAre('topic', 'main', 'wip');
			w.on('branch_delete', () => { throw appError('git', 'error: The branch \'wip\' is not fully merged.'); });
			expect(await repos.deleteBranch('wip', true)).toBe('failed');
			expect(errors().length).toBe(1);
		});

		test('any other refusal has failed and is said', async () => {
			await branchesAre('topic', 'main', 'held');
			w.on('branch_delete', () => { throw appError('git', 'the branch is checked out in a worktree'); });
			expect(await repos.deleteBranch('held', false, true)).toBe('failed');
			expect(errors()).toEqual(['the branch is checked out in a worktree']);
			expect(repos.busy()).toBe('');
		});

		test('the branch that is checked out is left first, for main', async () => {
			await branchesAre('topic', 'older', 'main', 'origin/topic');
			expect(await repos.deleteBranch('topic', false)).toBe('ok');
			const order = w.calls.filter((c) => c.cmd === 'branch_checkout' || c.cmd === 'branch_delete');
			expect(order.map((c) => c.cmd)).toEqual(['branch_checkout', 'branch_delete']);
			expect(order[0].args).toEqual({ id: id(), name: 'main', isRemote: false });
			expect(order[1].args).toMatchObject({ name: 'topic' });
		});

		test('the only branch is not deleted, and the reason is said', async () => {
			await branchesAre('only', 'origin/only', 'origin/main');
			expect(await repos.deleteBranch('only', false)).toBe('failed');
			expect(w.sent('branch_delete')).toEqual([]);
			expect(w.sent('branch_checkout')).toEqual([]);
			expect(errors()).toEqual(['This is the only branch. Create another one before deleting it.']);
		});

		test('when the branch cannot be left it is not deleted', async () => {
			await branchesAre('topic', 'main');
			w.on('branch_checkout', () => { throw appError('git', 'Your local changes would be overwritten by checkout'); });
			expect(await repos.deleteBranch('topic', false)).toBe('failed');
			expect(w.sent('branch_delete')).toEqual([]);
		});

		test('a detached HEAD at a branch of that name is not "on" it', async () => {
			await branchesAre('topic', 'main');
			await statusIs({ detached: true });
			expect(await repos.deleteBranch('topic', false)).toBe('ok');
			expect(w.sent('branch_checkout')).toEqual([]);
		});

		test('the lists are read again afterwards, whatever came of it', async () => {
			await branchesAre('topic', 'main', 'done');
			const before = { status: w.sent('repo_status').length, branches: w.sent('branches').length };
			w.on('branch_delete', () => { throw appError('git', 'no'); });
			await repos.deleteBranch('done', false);
			await settle();
			expect(w.sent('repo_status').length).toBe(before.status + 1);
			expect(w.sent('branches').length).toBe(before.branches + 1);
		});

		test('a remote branch is deleted by its own call', async () => {
			expect(await repos.deleteRemoteBranch('origin/stale')).toBe(true);
			expect(w.sent('branch_delete_remote')).toEqual([{ cmd: 'branch_delete_remote', args: { id: id(), name: 'origin/stale' } }]);
			expect(w.sent('branch_delete')).toEqual([]);
		});
	});

	describe('where deleting the checked-out branch lands', () => {
		test.each<[string[], string | null]>([
			[['topic', 'zeta', 'develop', 'master', 'main'], 'main'],
			[['topic', 'zeta', 'develop', 'master'], 'master'],
			[['topic', 'zeta', 'develop'], 'develop'],
			[['topic', 'zeta', 'alpha'], 'zeta'],
			[['topic', 'origin/main', 'origin/topic'], null],
			[['topic'], null],
		])('with %j it is %s', async (names, lands) => {
			await branchesAre(...names);
			expect(repos.fallbackBranch('topic')).toBe(lands);
		});
	});
});

describe('merge, rebase, cherry-pick, revert and reset', () => {
	type Run = (r: RepoStore) => Promise<boolean>;

	test.each<[string, Run, string, Record<string, unknown>]>([
		['merging a branch', (r) => r.merge('main'), 'merge_branch', { from: 'main' }],
		['a squash merge', (r) => r.mergeSquash('topic', 'Add repeat\n\nAll of it.'), 'merge_squash', { from: 'topic', message: 'Add repeat\n\nAll of it.' }],
		['rebasing onto a branch', (r) => r.rebaseOnto('origin/main'), 'rebase_onto', { onto: 'origin/main' }],
		['cherry-picking several commits', (r) => r.cherryPick(['c1', 'c2', 'c3']), 'cherry_pick', { hashes: ['c1', 'c2', 'c3'] }],
		['reverting a commit', (r) => r.revertCommit('c7'), 'revert_commit', { hash: 'c7' }],
		['a hard reset', (r) => r.resetTo('c7', 'hard'), 'reset_to', { hash: 'c7', mode: 'hard' }],
		['a soft reset', (r) => r.resetTo('c7', 'soft'), 'reset_to', { hash: 'c7', mode: 'soft' }],
		['checking out a commit', (r) => r.checkoutCommit('c7'), 'checkout_commit', { hash: 'c7' }],
		['a tag that is pushed', (r) => r.createTag('v1.0.0', 'c7', true), 'tag_create', { name: 'v1.0.0', hash: 'c7', push: true }],
		['a tag that stays local', (r) => r.createTag('v1.0.0', 'c7', false), 'tag_create', { name: 'v1.0.0', hash: 'c7', push: false }],
		['deleting a tag', (r) => r.deleteTag('v1.0.0'), 'tag_delete', { name: 'v1.0.0' }],
		['carrying on after conflicts', (r) => r.continueOperation(), 'op_continue', {}],
		['giving up after conflicts', (r) => r.abortOperation(), 'op_abort', {}],
		['taking my side of a conflicted file', (r) => r.resolveFile('a.ts', 'mine'), 'resolve_file', { path: 'a.ts', side: 'mine' }],
		['taking their side of a conflicted file', (r) => r.resolveFile('a.ts', 'theirs'), 'resolve_file', { path: 'a.ts', side: 'theirs' }],
		['ignoring a file', (r) => r.ignoreFile('dist/out.js'), 'ignore_file', { path: 'dist/out.js' }],
		['an interactive rebase', (r) => r.rebaseInteractive('origin/main', [{ hash: 'c1', action: 'reword', message: 'Better words' }, { hash: 'c2', action: 'fixup', message: null }]), 'rebase_interactive', { upstream: 'origin/main', steps: [{ hash: 'c1', action: 'reword', message: 'Better words' }, { hash: 'c2', action: 'fixup', message: null }] }],
	])('%s is one call, sent as asked', async (_what, run, cmd, args) => {
		// Answered here: what the native side does with it is not the store's business.
		w.on(cmd, () => undefined);
		expect(await run(repos)).toBe(true);
		expect(w.sent(cmd)).toEqual([{ cmd, args: { id: repos.repo()!.id, ...args } }]);
		expect(errors()).toEqual([]);
	});

	test.each<[string, Run, string]>([
		['a merge', (r) => r.merge('main'), 'merge_branch'],
		['a squash merge', (r) => r.mergeSquash('topic', 'Add repeat'), 'merge_squash'],
		['a rebase', (r) => r.rebaseOnto('main'), 'rebase_onto'],
		['an interactive rebase', (r) => r.rebaseInteractive(null, [{ hash: 'c1', action: 'pick', message: null }]), 'rebase_interactive'],
		['a cherry-pick', (r) => r.cherryPick(['c1', 'c2']), 'cherry_pick'],
		['a revert', (r) => r.revertCommit('c7'), 'revert_commit'],
		['carrying on with the next commit', (r) => r.continueOperation(), 'op_continue'],
	])('%s that stops on conflicts goes to the Changes tab and is not called done', async (_what, run, cmd) => {
		w.on(cmd, () => { throw appError('conflict', 'conflict', ['a.ts', 'b.ts']); });
		repos.tab.set('history');
		expect(await run(repos)).toBe(false);
		expect(repos.tab()).toBe('changes');
		expect(w.toasts.map((t) => [t.kind, t.title])).toEqual([['warning', 'Merge conflicts']]);
		expect(repos.busy()).toBe('');
	});

	test('the status is read again after conflicts, so the operation in progress shows', async () => {
		const base = repos.status()!;
		w.on('merge_branch', () => { throw appError('conflict', 'conflict', ['a.ts']); });
		w.on('repo_status', () => ({ ...base, operation: 'merge', mergeInProgress: true, files: [file('a.ts', 'conflicted')] }));
		await repos.merge('main');
		expect(repos.status()!.operation).toBe('merge');
		expect(repos.status()!.files).toEqual([file('a.ts', 'conflicted')]);
	});

	test.each<[string, Run, string]>([
		['a merge', (r) => r.merge('main'), 'Merged main'],
		['a squash merge', (r) => r.mergeSquash('topic', 'Add repeat'), 'Squashed topic into one commit'],
		['a rebase', (r) => r.rebaseOnto('main'), 'Rebased onto main'],
		['one cherry-picked commit', (r) => r.cherryPick(['c1']), 'Commit cherry-picked'],
		['several cherry-picked commits', (r) => r.cherryPick(['c1', 'c2', 'c3']), 'Cherry-picked 3 commits'],
		['a revert', (r) => r.revertCommit('c7'), 'Commit reverted'],
		['a tag', (r) => r.createTag('v2', 'c7', false), 'Tagged v2'],
	])('%s that went through says so', async (_what, run, said) => {
		expect(await run(repos)).toBe(true);
		expect(w.toasts.map((t) => [t.kind, t.title])).toEqual([['success', said]]);
	});

	test('several commits are cherry-picked in one call, in the order given', async () => {
		await repos.cherryPick(['oldest', 'middle', 'newest']);
		expect(w.sent('cherry_pick').length).toBe(1);
		expect(w.sent('cherry_pick')[0].args.hashes).toEqual(['oldest', 'middle', 'newest']);
	});

	test('a squash merge that stops on conflicts leaves its message in the commit form', async () => {
		w.on('merge_squash', () => { throw appError('conflict', 'conflict', ['a.ts']); });
		expect(await repos.mergeSquash('topic', '\nAdd repeat mode\n\nWraps the queue.\nAdds a toggle.\n')).toBe(false);
		expect(repos.summary()).toBe('Add repeat mode');
		expect(repos.description()).toBe('Wraps the queue.\nAdds a toggle.');
		expect(repos.tab()).toBe('changes');
	});

	test('a squash merge that fails for another reason leaves the commit form alone', async () => {
		w.on('merge_squash', () => { throw appError('git', 'topic is not something we can merge'); });
		repos.summary.set('Typed before');
		expect(await repos.mergeSquash('topic', 'Add repeat mode')).toBe(false);
		expect(repos.summary()).toBe('Typed before');
		expect(errors()).toEqual(['topic is not something we can merge']);
	});

	test('the commits an interactive rebase would replay are read, not changed', async () => {
		w.on('rebase_plan', () => [commit(1), commit(2)]);
		expect(await repos.rebasePlan('origin/main')).toEqual([commit(1), commit(2)]);
		expect(await repos.rebasePlan(null)).toEqual([commit(1), commit(2)]);
		expect(w.sent('rebase_plan').map((c) => c.args.upstream)).toEqual(['origin/main', null]);
		expect(w.sent('rebase_interactive')).toEqual([]);
		expect(repos.busy()).toBe('');
	});

	test('a plan git refuses (a merge in the range) is said and answers null', async () => {
		w.on('rebase_plan', () => { throw appError('git', 'there is a merge commit among them'); });
		expect(await repos.rebasePlan('origin/main')).toBeNull();
		expect(errors()).toEqual(['there is a merge commit among them']);
	});
});

describe('fetch, pull and push', () => {
	const tracked: Partial<RepoStatus> = { remote: 'origin', upstream: 'origin/topic', detached: false, ahead: 0, behind: 0 };

	test.each<[string, Partial<RepoStatus>, string]>([
		['no remote', { remote: null, upstream: null }, 'publish-repo'],
		['a branch the remote does not have', { upstream: null }, 'publish-branch'],
		['commits to bring in', { behind: 2 }, 'pull'],
		['commits on both sides', { behind: 2, ahead: 3 }, 'pull'],
		['commits to send', { ahead: 3 }, 'push'],
		['nothing either way', {}, 'fetch'],
		['a detached HEAD', { detached: true, upstream: null }, 'fetch'],
	])('with %s the one button is %s', async (_what, change, kind) => {
		await statusIs({ ...tracked, ...change });
		expect(repos.sync()!.kind).toBe(kind);
	});

	test('the button names the remote', async () => {
		await statusIs({ ...tracked, remote: 'upstream', behind: 1 });
		expect(repos.sync()!.label).toBe('Pull upstream');
	});

	test.each<[string, Partial<RepoStatus>, string]>([
		['commits to send', { ahead: 1 }, 'push'],
		['a branch the remote does not have', { upstream: null }, 'push'],
		['commits to bring in', { behind: 1, ahead: 1 }, 'pull'],
		['nothing either way', {}, 'fetch'],
	])('pressed with %s it runs %s and nothing else', async (_what, change, cmd) => {
		await statusIs({ ...tracked, ...change });
		for (const c of ['push', 'pull', 'fetch']) {
			w.on(c, () => undefined);
		}
		await repos.runSync();
		expect(w.calls.filter((c) => ['push', 'pull', 'fetch'].includes(c.cmd)).map((c) => c.cmd)).toEqual([cmd]);
		expect(opened).toEqual([]);
	});

	test('pressed with no remote it asks where to publish and sends nothing', async () => {
		await statusIs({ ...tracked, remote: null, upstream: null });
		await repos.runSync();
		expect(opened).toEqual(['publish']);
		expect(w.sent('push')).toEqual([]);
		expect(w.sent('remote_set')).toEqual([]);
	});

	test('the button\'s push is never a forced one', async () => {
		await statusIs({ ...tracked, ahead: 2 });
		await repos.runSync();
		expect(w.sent('push')).toEqual([{ cmd: 'push', args: { id: repos.repo()!.id, force: false } }]);
	});

	test('what the remote has now shows after a pull', async () => {
		const base = await statusIs({ ...tracked, behind: 2 });
		w.on('pull', () => void w.on('repo_status', () => ({ ...base, behind: 0, head: 'pulled' })));
		await repos.runSync();
		expect(repos.status()!.behind).toBe(0);
		expect(repos.sync()!.kind).toBe('fetch');
	});

	test('a fetch can be asked for whatever the button says', async () => {
		await statusIs({ ...tracked, ahead: 2 });
		expect(await repos.fetch()).toBe(true);
		expect(w.sent('fetch').length).toBe(1);
		expect(w.sent('push')).toEqual([]);
	});

	describe('forcing a push', () => {
		const rejections = [
			'To github.com:demo/harmony.git\n ! [rejected]        topic -> topic (non-fast-forward)\nerror: failed to push some refs to \'github.com:demo/harmony.git\'',
			'To github.com:demo/harmony.git\n ! [rejected]        topic -> topic (fetch first)\nerror: failed to push some refs',
			'error: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind (non-fast-forward)',
		];

		test.each(rejections)('a push the remote rejects asks about forcing instead of failing (%#)', async (message) => {
			await statusIs({ ...tracked, ahead: 1 });
			w.on('push', () => { throw appError('git', message); });
			await repos.runSync();
			expect(opened).toEqual(['force-push']);
			expect(w.toasts).toEqual([]);
		});

		test('asking is all that happens: nothing is forced until the user says so', async () => {
			await statusIs({ ...tracked, ahead: 1 });
			w.on('push', () => { throw appError('git', rejections[0]); });
			await repos.runSync();
			await settle();
			expect(w.sent('push').map((c) => c.args.force)).toEqual([false]);
		});

		test('a push that fails for another reason is only said', async () => {
			await statusIs({ ...tracked, ahead: 1 });
			w.on('push', () => { throw appError('git', 'fatal: unable to access the remote: could not resolve host'); });
			await repos.runSync();
			expect(opened).toEqual([]);
			expect(errors()).toEqual(['fatal: unable to access the remote: could not resolve host']);
		});

		test('a push with nothing wrong asks nothing', async () => {
			await statusIs({ ...tracked, ahead: 1 });
			await repos.runSync();
			expect(opened).toEqual([]);
			expect(w.toasts).toEqual([]);
		});

		test('forcing is its own action, and says force', async () => {
			expect(await repos.forcePush()).toBe(true);
			expect(w.sent('push')).toEqual([{ cmd: 'push', args: { id: repos.repo()!.id, force: true } }]);
		});

		test('a forced push the lease stops (the remote moved again) asks once more', async () => {
			w.on('push', () => { throw appError('git', ' ! [rejected]        topic -> topic (stale info)\nerror: failed to push some refs'); });
			expect(await repos.forcePush()).toBe(false);
			expect(opened).toEqual(['force-push']);
		});

		// What holds now: the force-push question comes only after a rejected push (CLAUDE.md: "offered only after a
		// rejected push"). Before the fix (2026-11-23): RepoStore.fail() matches the words in the message of any failed operation,
		// so a fetch or pull that git rejects (a tag that would be clobbered prints "! [rejected]") opens it too.
		test('a fetch that git rejects does not ask about forcing a push', async () => {
			w.on('fetch', () => { throw appError('git', 'From github.com:demo/harmony\n ! [rejected]        v1.0       -> v1.0  (would clobber existing tag)'); });
			await repos.fetch();
			expect(opened).toEqual([]);
			expect(errors().length).toBe(1);
		});
	});

	describe('publishing', () => {
		test('points origin at the address, then pushes the branch', async () => {
			expect(await repos.publish('git@github.com:me/new.git')).toBe(true);
			const order = w.calls.filter((c) => c.cmd === 'remote_set' || c.cmd === 'push');
			expect(order).toEqual([
				{ cmd: 'remote_set', args: { id: repos.repo()!.id, url: 'git@github.com:me/new.git' } },
				{ cmd: 'push', args: { id: repos.repo()!.id, force: false } },
			]);
			expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Published' });
		});

		test('an address git will not take is said and nothing is pushed', async () => {
			w.on('remote_set', () => { throw appError('git', 'that is not a remote address'); });
			expect(await repos.publish('nonsense')).toBe(false);
			expect(w.sent('push')).toEqual([]);
			expect(errors()).toEqual(['that is not a remote address']);
		});
	});
});

// ---- several repositories ------------------------------------------------------------------------

function repo(name: string): RepoSummary {
	return { id: `/r/${name}`, name, path: `/r/${name}`, missing: false };
}

interface Native {
	/** The changed files of each repository, by id; a repository not named here has two, called after it. */
	files: Record<string, FileChange[]>;
	list(): string[];
	/** Adds the repository at `path` and makes it the current one, as adding, cloning and creating do. */
	add(path: unknown): RepoSummary;
}

/**
 * Repositories of our own on the native side, the first one open: the list, which one is current, and a
 * status for each. Adding, selecting and removing work as the app's native side does them.
 */
function repositories(...names: string[]): Native {
	let list = names.map(repo);
	let current: string | null = list[0]?.id ?? null;
	const nameOf = (id: unknown) => String(id).split('/').pop()!;
	const add = (path: unknown): RepoSummary => {
		const made = repo(nameOf(path));
		if (!list.some((r) => r.id === made.id)) {
			list = [...list, made];
		}
		return made;
	};
	const open = (path: unknown): RepoSummary => {
		const made = add(path);
		current = made.id;
		return made;
	};
	const native: Native = { files: {}, list: () => list.map((r) => r.id), add: open };
	w.on('app_status', () => ({ repos: list, current, gitVersion: '2.47.0', authorName: 'Me', authorEmail: 'me@example.com', appVersion: '1.0.0' }) satisfies AppStatus);
	w.on('repo_select', ({ id }) => {
		current = String(id);
	});
	w.on('repo_remove', ({ id }) => {
		list = list.filter((r) => r.id !== id);
		if (current === id) {
			current = list[0]?.id ?? null;
		}
	});
	for (const cmd of ['repo_add', 'repo_clone', 'repo_create']) {
		w.on(cmd, (args) => open(args.path ?? args.name ?? args.url));
	}
	w.on('repo_add_many', ({ paths }) => {
		const before = list.length;
		(paths as string[]).forEach(add);
		current ??= list[0]?.id ?? null;
		return list.length - before;
	});
	w.on('repo_status', ({ id }) => {
		const name = nameOf(id);
		return {
			branch: `${name}-branch`,
			detached: false,
			hasCommits: true,
			head: `head-of-${name}`,
			upstream: `origin/${name}-branch`,
			ahead: 0,
			behind: 0,
			remote: 'origin',
			remoteUrl: null,
			defaultBranch: 'main',
			host: null,
			files: native.files[String(id)] ?? [file(`${name}/one.ts`), file(`${name}/two.ts`)],
			mergeInProgress: false,
			rebaseInProgress: false,
			operation: null,
			stashes: [],
			lastFetched: null,
			undo: null,
		} satisfies RepoStatus;
	});
	w.on('branches', ({ id }) => [branch(`${nameOf(id)}-branch`, { isCurrent: true })]);
	w.on('file_diff', ({ path }) => ({ text: diffOf(String(path)), tooLarge: false }));
	return native;
}

const stored = () => localStorage.getItem('studio.repo-tabs');
const tabs = () => repos.repoTabList().map((r) => r.name);

describe('repository tabs', () => {
	let native: Native;

	beforeEach(() => start(() => void (native = repositories('a', 'b', 'c'))));

	test('with one repository open it is the only tab, and the strip stays hidden', () => {
		expect(tabs()).toEqual(['a']);
		expect(repos.showRepoTabs()).toBe(false);
	});

	test('switching in the tab on screen puts the repository in its place', async () => {
		await repos.selectRepo('/r/b');
		expect(w.sent('repo_select')).toEqual([{ cmd: 'repo_select', args: { id: '/r/b' } }]);
		expect(repos.repo()!.name).toBe('b');
		expect(repos.status()!.branch).toBe('b-branch');
		expect(tabs()).toEqual(['b']);
		expect(repos.showRepoTabs()).toBe(false);
		expect(stored()).toBe('["/r/b"]');
	});

	test('opening in a new tab puts it beside the others, and the strip appears', async () => {
		await repos.selectRepo('/r/b', true);
		await repos.openRepoTab('/r/c');
		expect(repos.repo()!.name).toBe('c');
		expect(tabs()).toEqual(['a', 'b', 'c']);
		expect(repos.showRepoTabs()).toBe(true);
		expect(stored()).toBe('["/r/a","/r/b","/r/c"]');
	});

	test('a repository that already has a tab is switched to, however it was asked for', async () => {
		await repos.openRepoTab('/r/b');
		await repos.selectRepo('/r/a');
		expect(tabs()).toEqual(['a', 'b']);
		expect(repos.repo()!.name).toBe('a');
		await repos.selectRepo('/r/b', true);
		expect(tabs()).toEqual(['a', 'b']);
		expect(repos.repo()!.name).toBe('b');
	});

	test('switching in a tab replaces only that tab', async () => {
		await repos.openRepoTab('/r/b');
		await repos.selectRepo('/r/c');
		expect(tabs()).toEqual(['a', 'c']);
	});

	test('selecting the repository on screen sends nothing', async () => {
		await repos.selectRepo('/r/a');
		await repos.selectRepo('/r/a', true);
		expect(w.sent('repo_select')).toEqual([]);
		expect(tabs()).toEqual(['a']);
	});

	test('the branches shown are the new repository\'s', async () => {
		await repos.selectRepo('/r/b');
		await settle();
		expect(repos.branches().map((b) => b.name)).toEqual(['b-branch']);
	});

	test('a switch the native side refuses is said, and everything stays', async () => {
		w.on('repo_select', () => { throw appError('error', 'that folder is gone'); });
		repos.summary.set('Half typed');
		await repos.selectRepo('/r/b', true);
		expect(errors()).toEqual(['that folder is gone']);
		expect(repos.repo()!.name).toBe('a');
		expect(tabs()).toEqual(['a']);
		expect(repos.summary()).toBe('Half typed');
		expect(repos.status()!.branch).toBe('a-branch');
	});

	test('a status asked of the repository left behind is dropped when it arrives late', async () => {
		const slow = deferred<RepoStatus>();
		const answer = repos.status()!;
		const real = (id: unknown) => ({ ...answer, branch: `${String(id).split('/').pop()}-branch` });
		let first = true;
		w.on('repo_status', ({ id }) => {
			if (first) {
				first = false;
				return slow.promise;
			}
			return real(id);
		});
		const late = repos.refresh();
		await repos.selectRepo('/r/b');
		slow.resolve({ ...answer, branch: 'a-branch-late' });
		await late;
		expect(repos.status()!.branch).toBe('b-branch');
	});

	describe('what each tab was showing', () => {
		test('a new tab starts clean, and the first tab is as it was left on coming back', async () => {
			repos.setTab('changes');
			repos.toggleFile('a/one.ts', false);
			repos.openTab('a/two.ts');
			repos.summary.set('Half a message');
			repos.description.set('And its second half');
			await repos.openRepoTab('/r/b');
			expect(repos.tab()).toBe('files');
			expect(repos.excluded().size).toBe(0);
			expect(repos.openTabs()).toEqual([]);
			expect(repos.selectedPath()).toBe('b/one.ts');
			expect(repos.summary()).toBe('');
			expect(repos.description()).toBe('');
			await repos.selectRepo('/r/a');
			expect(repos.tab()).toBe('changes');
			expect([...repos.excluded()]).toEqual(['a/one.ts']);
			expect(repos.openTabs()).toEqual(['a/two.ts']);
			expect(repos.selectedPath()).toBe('a/two.ts');
			expect(repos.summary()).toBe('Half a message');
			expect(repos.description()).toBe('And its second half');
			await settle();
			expect(repos.diff()!.raw).toBe(diffOf('a/two.ts'));
		});

		test('each of two tabs keeps its own', async () => {
			repos.summary.set('For a');
			await repos.openRepoTab('/r/b');
			repos.setTab('agents');
			repos.summary.set('For b');
			await repos.selectRepo('/r/a');
			expect(repos.summary()).toBe('For a');
			await repos.selectRepo('/r/b');
			expect(repos.summary()).toBe('For b');
			expect(repos.tab()).toBe('agents');
		});

		test('coming back to the History tab reads the history again', async () => {
			repos.setTab('history');
			await settle();
			await repos.openRepoTab('/r/b');
			expect(repos.historyLoaded()).toBe(false);
			const before = w.sent('history').length;
			await repos.selectRepo('/r/a');
			await settle();
			expect(repos.tab()).toBe('history');
			expect(w.sent('history').length).toBe(before + 1);
			expect(w.sent('history').at(-1)!.args.id).toBe('/r/a');
		});

		test('a file that is no longer changed on coming back is neither selected, pinned nor unticked', async () => {
			repos.toggleFile('a/two.ts', false);
			repos.openTab('a/two.ts');
			await repos.openRepoTab('/r/b');
			native.files['/r/a'] = [file('a/one.ts'), file('a/three.ts')];
			await repos.selectRepo('/r/a');
			expect(repos.selectedPath()).toBe('a/one.ts');
			expect(repos.openTabs()).toEqual([]);
			expect(repos.excluded().size).toBe(0);
		});

		test('a repository replaced in its tab does not come back with what it showed', async () => {
			repos.summary.set('Thrown away with the tab');
			repos.setTab('changes');
			await repos.selectRepo('/r/b');
			await repos.selectRepo('/r/a');
			expect(repos.summary()).toBe('');
			expect(repos.tab()).toBe('files');
		});

		test('a tab closed while another was on screen starts clean when its repository is opened again', async () => {
			repos.summary.set('Was in a');
			await repos.openRepoTab('/r/b');
			await repos.closeRepoTab('/r/a');
			await repos.openRepoTab('/r/a');
			expect(repos.summary()).toBe('');
		});

		// What holds now: a closed tab is forgotten (closeRepoTab drops its view, as the test above shows for a tab
		// that was not on screen). Before the fix (2026-11-23): closing the tab on screen calls selectRepo() for its neighbour,
		// which keeps the view of the repository being left, so the closed tab's draft comes back later.
		test('the tab on screen, once closed, starts clean when its repository is opened again', async () => {
			await repos.openRepoTab('/r/b');
			repos.summary.set('Was in b');
			await repos.closeRepoTab('/r/b');
			await repos.openRepoTab('/r/b');
			expect(repos.summary()).toBe('');
		});
	});

	describe('closing one', () => {
		beforeEach(async () => {
			await repos.openRepoTab('/r/b');
			await repos.openRepoTab('/r/c');
		});

		test('the last tab in the row, on screen, moves to the one before it', async () => {
			await repos.closeRepoTab('/r/c');
			expect(tabs()).toEqual(['a', 'b']);
			expect(repos.repo()!.name).toBe('b');
			expect(stored()).toBe('["/r/a","/r/b"]');
		});

		test('a tab on screen with one after it moves to that one', async () => {
			await repos.selectRepo('/r/a');
			await repos.closeRepoTab('/r/a');
			expect(tabs()).toEqual(['b', 'c']);
			expect(repos.repo()!.name).toBe('b');
			expect(repos.status()!.branch).toBe('b-branch');
		});

		test('a tab that is not on screen goes without a switch', async () => {
			const before = w.sent('repo_select').length;
			await repos.closeRepoTab('/r/a');
			expect(tabs()).toEqual(['b', 'c']);
			expect(repos.repo()!.name).toBe('c');
			expect(w.sent('repo_select').length).toBe(before);
		});

		test('the repository stays in the list of repositories', async () => {
			await repos.closeRepoTab('/r/b');
			expect(w.sent('repo_remove')).toEqual([]);
			expect(repos.app()!.repos.map((r) => r.name)).toEqual(['a', 'b', 'c']);
		});

		test('the only tab left cannot be closed', async () => {
			await repos.closeRepoTab('/r/a');
			await repos.closeRepoTab('/r/b');
			await repos.closeRepoTab('/r/c');
			expect(tabs()).toEqual(['c']);
			expect(repos.repo()!.name).toBe('c');
		});

		test('a repository with no tab is not closed', async () => {
			await repos.closeRepoTab('/r/b');
			const before = stored();
			await repos.closeRepoTab('/r/b');
			await repos.closeRepoTab('/r/nowhere');
			expect(stored()).toBe(before);
			expect(tabs()).toEqual(['a', 'c']);
		});
	});

	describe('moving one', () => {
		beforeEach(async () => {
			await repos.openRepoTab('/r/b');
			await repos.openRepoTab('/r/c');
		});

		test.each<[string, number, string[]]>([
			['c', 0, ['c', 'a', 'b']],
			['a', 2, ['b', 'c', 'a']],
			['a', 1, ['b', 'a', 'c']],
			['b', 99, ['a', 'c', 'b']],
			['b', -5, ['b', 'a', 'c']],
		])('%s dropped at %i gives %j', (name, to, order) => {
			repos.moveRepoTab(`/r/${name}`, to);
			expect(tabs()).toEqual(order);
			expect(stored()).toBe(JSON.stringify(order.map((n) => `/r/${n}`)));
		});

		test('dropping a tab where it was changes nothing', () => {
			const before = repos.repoTabs();
			repos.moveRepoTab('/r/b', 1);
			repos.moveRepoTab('/r/nowhere', 0);
			expect(repos.repoTabs()).toBe(before);
		});

		test('moving does not switch repository', () => {
			repos.moveRepoTab('/r/a', 2);
			expect(repos.repo()!.name).toBe('c');
			expect(w.sent('repo_select').length).toBe(2);
		});
	});

	describe('stepping through them', () => {
		test('goes to the next and the previous, round the ends', async () => {
			await repos.openRepoTab('/r/b');
			await repos.openRepoTab('/r/c');
			repos.cycleRepoTab(1);
			await settle();
			expect(repos.repo()!.name).toBe('a');
			repos.cycleRepoTab(-1);
			await settle();
			expect(repos.repo()!.name).toBe('c');
			repos.cycleRepoTab(-1);
			await settle();
			expect(repos.repo()!.name).toBe('b');
			expect(tabs()).toEqual(['a', 'b', 'c']);
		});

		test('with one tab there is nowhere to go', async () => {
			repos.cycleRepoTab(1);
			await settle();
			expect(w.sent('repo_select')).toEqual([]);
		});
	});
});

describe('repository tabs kept from the last run', () => {
	/** Starts the app with this in the browser's storage and `a`, `b`, `c` on the native side, `a` open. */
	const startWith = (kept: string) =>
		start(() => {
			repositories('a', 'b', 'c');
			localStorage.setItem('studio.repo-tabs', kept);
		});

	test('come back in their order', async () => {
		await startWith('["/r/c","/r/a","/r/b"]');
		expect(tabs()).toEqual(['c', 'a', 'b']);
		expect(repos.repo()!.name).toBe('a');
		expect(repos.showRepoTabs()).toBe(true);
	});

	test('the open repository is a tab even when the list lacks it', async () => {
		await startWith('["/r/c"]');
		expect(tabs()).toEqual(['c', 'a']);
	});

	test('a repository that is no longer known is passed over', async () => {
		await startWith('["/r/removed-since","/r/b"]');
		expect(tabs()).toEqual(['b', 'a']);
	});

	test.each([
		['text that is not JSON', '{"not json'],
		['JSON that is not a list', '{"/r/b":true}'],
		['a single name', '"/r/b"'],
		['nothing', 'null'],
		['an empty text', ''],
	])('%s is taken as no tabs', async (_what, kept) => {
		await startWith(kept);
		expect(repos.repoTabs()).toEqual([]);
		expect(tabs()).toEqual(['a']);
		expect(repos.showRepoTabs()).toBe(false);
	});

	test('entries that are not ids are dropped and the rest kept', async () => {
		await startWith('[1,null,"/r/b",{"id":"/r/c"},["/r/c"]]');
		expect(repos.repoTabs()).toEqual(['/r/b']);
		expect(tabs()).toEqual(['b', 'a']);
	});

	test('broken storage is put right by the next change to the tabs', async () => {
		await startWith('{"not json');
		await repos.openRepoTab('/r/b');
		expect(stored()).toBe('["/r/a","/r/b"]');
	});

	test('storage that refuses to be written does not stop the tabs working', async () => {
		await startWith('[]');
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('QuotaExceededError');
		});
		await repos.openRepoTab('/r/b');
		expect(tabs()).toEqual(['a', 'b']);
		expect(repos.repo()!.name).toBe('b');
		expect(w.toasts).toEqual([]);
	});
});

describe('adding repositories', () => {
	let native: Native;

	beforeEach(() => start(() => void (native = repositories('a', 'b'))));

	test('an added repository is opened in place of the one on screen', async () => {
		repos.summary.set('Belongs to a');
		repos.setTab('changes');
		expect(await repos.addRepo('/r/new')).toBe(true);
		expect(w.sent('repo_add')).toEqual([{ cmd: 'repo_add', args: { path: '/r/new' } }]);
		expect(repos.repo()!.name).toBe('new');
		expect(repos.status()!.branch).toBe('new-branch');
		expect(tabs()).toEqual(['new']);
		expect(repos.summary()).toBe('');
		expect(repos.tab()).toBe('files');
		await settle();
		expect(repos.branches().map((b) => b.name)).toEqual(['new-branch']);
	});

	test('asked for from the strip\'s plus, it opens beside the others', async () => {
		repos.ask('add-repo', { newTab: true });
		await repos.addRepo('/r/new');
		expect(tabs()).toEqual(['a', 'new']);
		expect(stored()).toBe('["/r/a","/r/new"]');
	});

	test('that holds for the one repository opened next, not for the ones after', async () => {
		repos.ask('add-repo', { newTab: true });
		await repos.addRepo('/r/new');
		await repos.addRepo('/r/more');
		expect(tabs()).toEqual(['a', 'more']);
	});

	test('opening the dialog the ordinary way afterwards forgets the plus', async () => {
		repos.ask('add-repo', { newTab: true });
		repos.ask('add-repo', { tab: 'clone' });
		await repos.addRepo('/r/new');
		expect(tabs()).toEqual(['new']);
	});

	// What holds now: the plus holds until a repository is opened (the dialog stays open after a clone that fails,
	// and the second try is still the one asked for in a new tab). Before the fix (2026-11-23): openRepo() uses the plus up before
	// it knows whether the repository opened, so the second try replaces the tab on screen.
	test('a try that fails does not use the plus up', async () => {
		repos.ask('add-repo', { newTab: true });
		let typo = true;
		w.on('repo_clone', ({ url }) => {
			if (typo) {
				typo = false;
				throw appError('git', 'repository not found');
			}
			return native.add(url);
		});
		expect(await repos.cloneRepo('https://example.com/me/nwe', '/r')).toBe(false);
		expect(await repos.cloneRepo('https://example.com/me/new', '/r')).toBe(true);
		expect(tabs()).toEqual(['a', 'new']);
	});

	test('what the tab left behind was showing is there on coming back', async () => {
		repos.ask('add-repo', { newTab: true });
		repos.summary.set('Belongs to a');
		await repos.addRepo('/r/new');
		await repos.selectRepo('/r/a');
		expect(repos.summary()).toBe('Belongs to a');
	});

	test('adding a repository that already has a tab goes to that tab', async () => {
		await repos.openRepoTab('/r/b');
		await repos.selectRepo('/r/a');
		expect(await repos.addRepo('/r/b')).toBe(true);
		expect(tabs()).toEqual(['a', 'b']);
		expect(repos.repo()!.name).toBe('b');
		expect(native.list()).toEqual(['/r/a', '/r/b']);
	});

	test('a folder that cannot be added is said, and the repository on screen stays as it is', async () => {
		w.on('repo_add', () => { throw appError('error', '/r/nope is not a git repository'); });
		repos.summary.set('Still here');
		expect(await repos.addRepo('/r/nope')).toBe(false);
		expect(errors()).toEqual(['/r/nope is not a git repository']);
		expect(repos.repo()!.name).toBe('a');
		expect(repos.summary()).toBe('Still here');
		expect(repos.busy()).toBe('');
		expect(tabs()).toEqual(['a']);
	});

	test('cloning and creating open what they made the same way', async () => {
		expect(await repos.cloneRepo('https://example.com/me/cloned', '/r')).toBe(true);
		expect(w.sent('repo_clone')).toEqual([{ cmd: 'repo_clone', args: { url: 'https://example.com/me/cloned', parent: '/r' } }]);
		expect(repos.repo()!.name).toBe('cloned');
		expect(await repos.createRepo('/r', 'fresh', true)).toBe(true);
		expect(w.sent('repo_create')).toEqual([{ cmd: 'repo_create', args: { parent: '/r', name: 'fresh', readme: true } }]);
		expect(repos.repo()!.name).toBe('fresh');
	});

	describe('several at once, after a scan', () => {
		test('a scan only lists: nothing is added and the repository on screen stays', async () => {
			const found = { repos: [{ path: '/r/x', name: 'x', added: false, origin: null }, { path: '/r/a', name: 'a', added: true, origin: null }], truncated: true };
			w.on('repo_scan', () => found);
			expect(await repos.scanRepos('/r')).toEqual(found);
			expect(w.sent('repo_scan')).toEqual([{ cmd: 'repo_scan', args: { root: '/r' } }]);
			expect(w.calls.filter((c) => /^repo_(add|add_many|select|create|clone)$/.test(c.cmd))).toEqual([]);
			expect(native.list()).toEqual(['/r/a', '/r/b']);
			expect(repos.repo()!.name).toBe('a');
		});

		test('a scan that fails is said and answers null', async () => {
			w.on('repo_scan', () => { throw appError('error', 'that folder cannot be read'); });
			expect(await repos.scanRepos('/nowhere')).toBeNull();
			expect(errors()).toEqual(['that folder cannot be read']);
		});

		test('the ticked ones are added and the repository on screen is not changed', async () => {
			repos.summary.set('Still typing');
			repos.setTab('changes');
			expect(await repos.addRepos(['/r/x', '/r/y'])).toBe(true);
			expect(w.sent('repo_add_many')).toEqual([{ cmd: 'repo_add_many', args: { paths: ['/r/x', '/r/y'] } }]);
			expect(w.sent('repo_select')).toEqual([]);
			expect(repos.app()!.repos.map((r) => r.name)).toEqual(['a', 'b', 'x', 'y']);
			expect(repos.repo()!.name).toBe('a');
			expect(tabs()).toEqual(['a']);
			expect(repos.summary()).toBe('Still typing');
			expect(repos.tab()).toBe('changes');
		});

		test.each<[string[], string]>([
			[['/r/x', '/r/y'], 'Added 2 repositories'],
			[['/r/x'], 'Added 1 repository'],
			[['/r/a', '/r/b'], 'Those repositories were already added'],
		])('adding %j says "%s"', async (paths, said) => {
			await repos.addRepos(paths);
			expect(w.toasts.map((t) => [t.kind, t.title])).toEqual([['success', said]]);
		});

		test('none ticked adds nothing', async () => {
			expect(await repos.addRepos([])).toBe(false);
			expect(w.sent('repo_add_many')).toEqual([]);
		});

		test('a failure is said and nothing is called added', async () => {
			w.on('repo_add_many', () => { throw appError('error', 'the config file cannot be written'); });
			expect(await repos.addRepos(['/r/x'])).toBe(false);
			expect(w.toasts.map((t) => t.kind)).toEqual(['error']);
			expect(repos.busy()).toBe('');
		});

		test('with no repository open yet, the first of them is opened and read', async () => {
			await start(() => void repositories());
			expect(repos.repo()).toBeNull();
			expect(await repos.addRepos(['/r/x', '/r/y'])).toBe(true);
			expect(repos.repo()!.name).toBe('x');
			expect(repos.status()!.branch).toBe('x-branch');
			await settle();
			expect(repos.branches().map((b) => b.name)).toEqual(['x-branch']);
		});
	});
});

describe('removing a repository', () => {
	beforeEach(() => start(() => void repositories('a', 'b', 'c')));

	test('takes it off the list and out of the tabs', async () => {
		await repos.openRepoTab('/r/b');
		await repos.selectRepo('/r/a');
		await repos.removeRepo('/r/b');
		expect(w.sent('repo_remove')).toEqual([{ cmd: 'repo_remove', args: { id: '/r/b' } }]);
		expect(repos.app()!.repos.map((r) => r.name)).toEqual(['a', 'c']);
		expect(tabs()).toEqual(['a']);
		expect(stored()).toBe('["/r/a"]');
		expect(repos.repo()!.name).toBe('a');
		expect(repos.status()!.branch).toBe('a-branch');
	});

	test('removing the one on screen shows the repository the native side moved to', async () => {
		repos.summary.set('Goes with it');
		await repos.removeRepo('/r/a');
		await settle();
		expect(repos.repo()!.name).toBe('b');
		expect(repos.status()!.branch).toBe('b-branch');
		expect(repos.branches().map((b) => b.name)).toEqual(['b-branch']);
		expect(repos.summary()).toBe('');
		expect(tabs()).toEqual(['b']);
	});

	test('removing the last one leaves nothing open', async () => {
		await start(() => void repositories('a'));
		await repos.removeRepo('/r/a');
		await settle();
		expect(repos.repo()).toBeNull();
		expect(repos.status()).toBeNull();
		expect(repos.branches()).toEqual([]);
		expect(tabs()).toEqual([]);
	});

	test('a removal that fails is said and changes nothing', async () => {
		await repos.openRepoTab('/r/b');
		w.on('repo_remove', () => { throw appError('error', 'the config file cannot be written'); });
		repos.summary.set('Still here');
		await repos.removeRepo('/r/a');
		expect(errors()).toEqual(['the config file cannot be written']);
		expect(tabs()).toEqual(['a', 'b']);
		expect(repos.repo()!.name).toBe('b');
		expect(repos.summary()).toBe('Still here');
	});

	test('its tab does not come back with what it showed if it is added again', async () => {
		repos.summary.set('Was in a');
		await repos.openRepoTab('/r/b');
		await repos.removeRepo('/r/a');
		await repos.addRepo('/r/a');
		expect(repos.summary()).toBe('');
	});

	// What holds now: taking another repository off the list (the x beside it in the toolbar's list) leaves the
	// open repository as it is. Before the fix (2026-11-23): removeRepo() resets the open repository's state whichever one was
	// removed, so the commit message being typed is lost and the sidebar jumps to the Files tab.
	test('removing another repository leaves the one on screen as it was', async () => {
		repos.setTab('changes');
		repos.summary.set('Half typed');
		repos.toggleFile('a/one.ts', false);
		await repos.removeRepo('/r/c');
		expect(repos.summary()).toBe('Half typed');
		expect(repos.tab()).toBe('changes');
		expect([...repos.excluded()]).toEqual(['a/one.ts']);
	});
});

describe('who commits', () => {
	const me = { name: 'Me', email: 'me@example.com' };
	const work = { name: 'Me at work', email: 'me@work.example' };
	let kept: { global: typeof me; repo: typeof me | null };

	beforeEach(() => {
		kept = { global: me, repo: null };
		w.on('identity_get', () => kept);
		w.on('identity_set', () => undefined);
	});

	const sets = () => w.sent('identity_set').map((c) => c.args);

	test('the global identity and the open repository\'s own are read together', async () => {
		kept = { global: me, repo: work };
		expect(await repos.identities()).toEqual({ global: me, repo: work });
		expect(w.sent('identity_get')).toEqual([{ cmd: 'identity_get', args: { id: repos.repo()!.id } }]);
	});

	test('identities that cannot be read are said and answer null', async () => {
		w.on('identity_get', () => { throw appError('git', 'git config failed'); });
		expect(await repos.identities()).toBeNull();
		expect(errors()).toEqual(['git config failed']);
	});

	test('saving what is already there writes nothing', async () => {
		kept = { global: me, repo: work };
		expect(await repos.saveIdentities({ name: ' Me ', email: 'me@example.com ' }, { ...work })).toBe(true);
		expect(sets()).toEqual([]);
	});

	test('a changed global identity is written for every repository, and the app\'s own copy read again', async () => {
		const before = w.sent('app_status').length;
		expect(await repos.saveIdentities(work, null)).toBe(true);
		expect(sets()).toEqual([{ id: null, identity: work }]);
		expect(w.sent('app_status').length).toBe(before + 1);
	});

	test('no global identity given leaves the global one alone', async () => {
		expect(await repos.saveIdentities(null, work)).toBe(true);
		expect(sets()).toEqual([{ id: repos.repo()!.id, identity: work }]);
	});

	test('a different identity for this repository is written to it alone', async () => {
		expect(await repos.saveIdentities(me, work)).toBe(true);
		expect(sets()).toEqual([{ id: repos.repo()!.id, identity: work }]);
	});

	test('unticking the repository\'s own identity removes it', async () => {
		kept = { global: me, repo: work };
		expect(await repos.saveIdentities(me, null)).toBe(true);
		expect(sets()).toEqual([{ id: repos.repo()!.id, identity: null }]);
	});

	test('both can change in one save, the global one first', async () => {
		const other = { name: 'Someone', email: 'someone@example.com' };
		expect(await repos.saveIdentities(other, work)).toBe(true);
		expect(sets()).toEqual([{ id: null, identity: other }, { id: repos.repo()!.id, identity: work }]);
	});

	test('a save that fails is said and answers false', async () => {
		w.on('identity_set', () => { throw appError('git', 'could not lock config file'); });
		expect(await repos.saveIdentities(work, null)).toBe(false);
		expect(errors()).toEqual(['could not lock config file']);
	});
});

describe('a switch of the active checkout', () => {
	test('forgets what the last one showed and reads everything again', async () => {
		w.on('history', () => commits(5, 5));
		repos.setTab('history');
		await settle();
		repos.summary.set('Belongs to the main checkout');
		repos.toggleFile(repos.status()!.files[0].path, false);
		repos.openTab(repos.status()!.files[1].path);
		repos.amend.set(true);
		const before = { app: w.sent('app_status').length, status: w.sent('repo_status').length, branches: w.sent('branches').length };
		await repos.switchContext();
		await settle();
		expect(repos.summary()).toBe('');
		expect(repos.excluded().size).toBe(0);
		expect(repos.openTabs()).toEqual([]);
		expect(repos.amend()).toBe(false);
		expect(repos.commits()).toEqual([]);
		expect(repos.historyLoaded()).toBe(false);
		expect(repos.selectedHash()).toBeNull();
		expect(repos.compareBranch()).toBeNull();
		expect(w.sent('app_status').length).toBe(before.app + 1);
		expect(w.sent('repo_status').length).toBe(before.status + 1);
		expect(w.sent('branches').length).toBe(before.branches + 1);
		expect(repos.status()).not.toBeNull();
	});

	test('lands on the Files tab unless another is asked for', async () => {
		repos.setTab('agents');
		await repos.switchContext();
		expect(repos.tab()).toBe('files');
		await repos.switchContext('changes');
		expect(repos.tab()).toBe('changes');
	});

	test('the repository then names the worktree it is looking at', async () => {
		const app = repos.app()!;
		w.on('app_status', () => ({ ...app, repos: app.repos.map((r) => (r.id === app.current ? { ...r, worktree: `${r.path}.worktrees/agent-x` } : r)) }));
		await repos.switchContext();
		expect(repos.repo()!.worktree).toBe(`${app.current}.worktrees/agent-x`);
	});

	test('a list of repositories that cannot be read again is said, and the status is still read', async () => {
		w.on('app_status', () => { throw appError('error', 'the config file is damaged'); });
		await repos.switchContext();
		expect(errors()).toEqual(['the config file is damaged']);
		expect(repos.status()).not.toBeNull();
	});
});

describe('the Agents page', () => {
	beforeEach(() => start(() => void repositories('a', 'b')));

	test('is shown and hidden by the same call', () => {
		repos.showOverview();
		expect(repos.overview()).toBe(true);
		repos.showOverview();
		expect(repos.overview()).toBe(false);
		repos.showOverview(true);
		repos.showOverview(true);
		expect(repos.overview()).toBe(true);
		repos.showOverview(false);
		expect(repos.overview()).toBe(false);
	});

	test.each<[string, (r: RepoStore) => unknown]>([
		['going to a sidebar tab', (r) => r.setTab('changes')],
		['going to the tab already on screen', (r) => r.setTab(r.tab())],
		['switching repository', (r) => r.selectRepo('/r/b')],
		['selecting the repository already open', (r) => r.selectRepo('/r/a')],
		['opening a repository in a new tab', (r) => r.openRepoTab('/r/b')],
		['adding a repository', (r) => r.addRepo('/r/new')],
	])('%s leaves it', async (_what, go) => {
		repos.showOverview(true);
		await go(repos);
		expect(repos.overview()).toBe(false);
	});

	test('stepping to the next repository tab leaves it', async () => {
		await repos.openRepoTab('/r/b');
		repos.showOverview(true);
		repos.cycleRepoTab(1);
		await settle();
		expect(repos.overview()).toBe(false);
	});

	test('a repository that could not be added leaves it showing', async () => {
		w.on('repo_add', () => { throw appError('error', 'not a repository'); });
		repos.showOverview(true);
		await repos.addRepo('/r/nope');
		expect(repos.overview()).toBe(true);
	});
});

describe('dialogs', () => {
	test('asking opens the dialog by its name with what it is about', () => {
		const about = { branch: 'topic', remote: true };
		repos.ask('delete-branch', about);
		expect(opened).toEqual(['delete-branch']);
		expect(repos.prompt()).toEqual(about);
	});

	test('asking with nothing to say clears what the last dialog was about', () => {
		repos.ask('delete-branch', { branch: 'topic' });
		repos.ask('settings');
		expect(repos.prompt()).toEqual({});
		expect(opened).toEqual(['delete-branch', 'settings']);
	});

	test('closing closes that dialog and no other', () => {
		repos.ask('new-branch');
		repos.closeDialog('new-branch');
		expect(closed).toEqual(['new-branch']);
	});

	test('a dialog sends nothing to the native side by being opened', () => {
		const before = w.calls.length;
		for (const name of ['discard', 'reset', 'force-push', 'delete-branch', 'remove-repo', 'publish'] as const) {
			repos.ask(name, { branch: 'topic', files: [file('a.ts')] });
		}
		expect(w.calls.length).toBe(before);
	});
});

describe('opening things outside the app', () => {
	test('opens for the repository on screen unless another is named', async () => {
		await repos.openIn('terminal');
		await repos.openIn('commit', 'c7');
		await repos.openIn('finder', null, '/Users/demo/Source/cadence');
		expect(w.sent('open_in').map((c) => c.args)).toEqual([
			{ id: repos.repo()!.id, target: 'terminal', arg: null },
			{ id: repos.repo()!.id, target: 'commit', arg: 'c7' },
			{ id: '/Users/demo/Source/cadence', target: 'finder', arg: null },
		]);
	});

	test('something that cannot be opened is said', async () => {
		w.on('open_in', () => { throw appError('error', 'no terminal was found'); });
		await repos.openIn('terminal');
		expect(errors()).toEqual(['no terminal was found']);
	});

	test('a folder picker that fails answers no folder', async () => {
		w.on('pick_folder', () => '/picked');
		expect(await repos.pickFolder()).toBe('/picked');
		w.on('pick_folder', () => { throw new Error('dialog plugin missing'); });
		expect(await repos.pickFolder()).toBeNull();
		expect(w.toasts).toEqual([]);
	});
});
