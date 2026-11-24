import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, labelled, mount, text } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { RepoStatus } from '../../services/backend.service';

// Monaco cannot run in happy-dom, and the language services reach for it as soon as the status changes.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));

let w: World;
let repos: RepoStore;
/** The dialogs the component asked for, by id. */
let opened: string[];

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
	w = await world();
	forgetElements();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	const { DialogService } = await import('@melodicdev/components/dialog');
	opened = [];
	vi.spyOn(w.get(DialogService), 'open').mockImplementation(((id: string) => void opened.push(id)) as never);
	await repos.init();
	repos.tab.set('changes');
});

/** The status the native side answers from now on: the demo's, with `change` on top. */
async function status(change: Partial<RepoStatus>): Promise<void> {
	const base = repos.status()!;
	w.on('repo_status', () => ({ ...base, ...change }));
	await repos.refresh();
	await settle();
}

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
	return out.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
}

/** The element that reads `label`, icons aside. */
function named(root: Element, selector: string, label: string): HTMLElement | null {
	return all(root, selector).find((e) => words(e) === label) ?? null;
}

/** The button a person presses inside an `ml-button`. */
function inner(button: Element | null): HTMLButtonElement {
	return find<HTMLButtonElement>(button!, 'button')!;
}

/** Ticks or unticks an `ml-checkbox`, as a click on its box does. */
async function tick(box: Element | null, on: boolean): Promise<void> {
	const input = find<HTMLInputElement>(box!, 'input')!;
	input.checked = on;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

/** Types into an `ml-input` or `ml-textarea`. */
async function type(field: Element | null, value: string): Promise<void> {
	const input = find<HTMLInputElement>(field!, 'input, textarea')!;
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}

function rows(el: Element): HTMLElement[] {
	return all(el, '.list .row');
}

function row(el: Element, file: string): HTMLElement {
	return rows(el).find((r) => text(r).includes(file))!;
}

function commitButton(el: Element): HTMLElement {
	return find(el, '.commit ml-button')!;
}

async function rightClick(target: Element): Promise<void> {
	target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 40, clientY: 60 }));
	await settle();
}

describe('the list', () => {
	test('lists every changed file', async () => {
		const el = await mount('ms-changes');
		const shown = text(el);
		for (const f of repos.status()!.files) {
			expect(shown).toContain(f.path.split('/').pop());
		}
		expect(shown).toContain('5 changed files');
	});

	test('every file starts ticked', async () => {
		const el = await mount('ms-changes');
		const boxes = rows(el).map((r) => find<HTMLInputElement>(r, 'input')!);
		expect(boxes.length).toBe(repos.status()!.files.length);
		expect(boxes.every((b) => b.checked)).toBe(true);
	});

	test('a file is marked by what happened to it', async () => {
		const el = await mount('ms-changes');
		expect(find(row(el, 'old-notes.md'), '.mark')!.title).toBe('Deleted');
		expect(find(row(el, 'repeat.ts'), '.mark')!.title).toBe('New');
		expect(find(row(el, 'shuffle.ts'), '.mark')!.title).toBe('Conflicted');
		expect(find(row(el, 'queue.ts'), '.mark')!.title).toBe('Modified');
	});

	test('a renamed file says where it came from', async () => {
		await status({ files: [{ path: 'src/new-name.ts', oldPath: 'src/old-name.ts', status: 'renamed' }] });
		const el = await mount('ms-changes');
		expect(rows(el)[0].title).toBe('src/old-name.ts → src/new-name.ts');
	});

	test('clicking a file shows its diff', async () => {
		const el = await mount('ms-changes');
		await click(row(el, 'repeat.ts'));
		expect(repos.selectedPath()).toBe('src/player/repeat.ts');
		expect(w.sent('file_diff').at(-1)!.args.path).toBe('src/player/repeat.ts');
	});

	test('no changes: nothing to tick, stash or discard', async () => {
		await status({ files: [] });
		const el = await mount('ms-changes');
		expect(text(el)).toContain('0 changed files');
		expect(find(el, '.head ml-checkbox')!.hasAttribute('disabled')).toBe(true);
		expect(find(el, '[title="Stash all changes"]')).toBeNull();
		expect(find(el, '[title="Discard all changes…"]')).toBeNull();
		expect(text(commitButton(el))).toBe('Select files to commit');
	});
});

describe('the checked files are the commit', () => {
	test('the button says how many files go to which branch', async () => {
		const el = await mount('ms-changes');
		expect(text(commitButton(el))).toBe('Commit 5 files to feature/repeat-mode');
	});

	test('unticking a file leaves it out of the commit', async () => {
		const el = await mount('ms-changes');
		await tick(find(row(el, 'cover.png'), 'ml-checkbox'), false);
		expect(text(commitButton(el))).toBe('Commit 4 files to feature/repeat-mode');
		await type(find(el, '.commit ml-input'), 'Part of it');
		await click(inner(commitButton(el)));
		const sent = w.sent('commit_changes').at(-1)!.args;
		expect(sent.paths).toEqual(['docs/old-notes.md', 'src/player/queue.ts', 'src/player/repeat.ts', 'src/player/shuffle.ts']);
		expect(sent.summary).toBe('Part of it');
		expect(sent.amend).toBe(false);
	});

	test('ticking a row does not select it', async () => {
		const el = await mount('ms-changes');
		const before = repos.selectedPath();
		await click(find(row(el, 'repeat.ts'), '.check'));
		expect(repos.selectedPath()).toBe(before);
	});

	test('the description typed goes with the commit', async () => {
		const el = await mount('ms-changes');
		await type(find(el, '.commit ml-input'), 'Summary');
		await type(find(el, '.commit ml-textarea'), 'Why it was done');
		await click(inner(commitButton(el)));
		expect(w.sent('commit_changes').at(-1)!.args).toMatchObject({ summary: 'Summary', description: 'Why it was done' });
	});

	test('the box at the top unticks and ticks them all', async () => {
		const el = await mount('ms-changes');
		const top = find(el, '.head ml-checkbox')!;
		await tick(top, false);
		expect(repos.includedFiles()).toEqual([]);
		expect(text(commitButton(el))).toBe('Select files to commit');
		await tick(top, true);
		expect(repos.includedFiles().length).toBe(5);
	});

	test('the box at the top is half-ticked while only some files are', async () => {
		const el = await mount('ms-changes');
		const top = find<HTMLElement & { checked: boolean; indeterminate: boolean }>(el, '.head ml-checkbox')!;
		expect(top.checked).toBe(true);
		expect(top.indeterminate).toBe(false);
		await tick(find(row(el, 'cover.png'), 'ml-checkbox'), false);
		expect(top.checked).toBe(false);
		expect(top.indeterminate).toBe(true);
	});

	test('nothing ticked: the button is off and nothing is committed', async () => {
		const el = await mount('ms-changes');
		await tick(find(el, '.head ml-checkbox'), false);
		await type(find(el, '.commit ml-input'), 'Empty');
		expect(inner(commitButton(el)).disabled).toBe(true);
		await click(inner(commitButton(el)));
		expect(w.sent('commit_changes')).toEqual([]);
	});

	test('several files and no summary: the button is off until one is typed', async () => {
		const el = await mount('ms-changes');
		expect(inner(commitButton(el)).disabled).toBe(true);
		await type(find(el, '.commit ml-input'), 'Repeat mode');
		expect(inner(commitButton(el)).disabled).toBe(false);
	});

	test('one file ticked offers a summary of its own, and commits with it', async () => {
		const el = await mount('ms-changes');
		await tick(find(el, '.head ml-checkbox'), false);
		await tick(find(row(el, 'queue.ts'), 'ml-checkbox'), true);
		expect(find(el, '.commit ml-input')!.getAttribute('placeholder')).toBe('Update queue.ts');
		expect(text(commitButton(el))).toBe('Commit 1 file to feature/repeat-mode');
		expect(inner(commitButton(el)).disabled).toBe(false);
		await click(inner(commitButton(el)));
		expect(w.sent('commit_changes').at(-1)!.args).toMatchObject({ paths: ['src/player/queue.ts'], summary: 'Update queue.ts' });
	});

	test('a renamed file is committed under both its names', async () => {
		await status({ files: [{ path: 'src/new-name.ts', oldPath: 'src/old-name.ts', status: 'renamed' }] });
		const el = await mount('ms-changes');
		expect(find(el, '.commit ml-input')!.getAttribute('placeholder')).toBe('Rename new-name.ts');
		await click(inner(commitButton(el)));
		expect(w.sent('commit_changes').at(-1)!.args.paths).toEqual(['src/old-name.ts', 'src/new-name.ts']);
	});

	test.each([
		['Cmd', { metaKey: true }],
		['Ctrl', { ctrlKey: true }],
	])('%s+Enter in the message commits', async (_name, mods) => {
		const el = await mount('ms-changes');
		await type(find(el, '.commit ml-input'), 'By key');
		find(el, '.commit ml-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true, ...mods }));
		await settle();
		expect(w.sent('commit_changes').at(-1)!.args.summary).toBe('By key');
	});

	test('Enter by itself does not commit', async () => {
		const el = await mount('ms-changes');
		await type(find(el, '.commit ml-input'), 'Not yet');
		find(el, '.commit ml-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
		await settle();
		expect(w.sent('commit_changes')).toEqual([]);
	});

	test('after a commit the message is empty and the files are gone from the list', async () => {
		const el = await mount('ms-changes');
		await type(find(el, '.commit ml-input'), 'All of it');
		await click(inner(commitButton(el)));
		expect(repos.summary()).toBe('');
		expect(rows(el)).toEqual([]);
		expect(text(el)).toContain('0 changed files');
	});
});

describe('amend and undo', () => {
	test('offered while the last commit is on no remote', async () => {
		const el = await mount('ms-changes');
		expect(repos.status()!.undo).not.toBeNull();
		expect(find(el, 'ml-checkbox[label="Amend last commit"]')).not.toBeNull();
		expect(text(find(el, '.undo')!)).toContain('Last commit, not pushed yet');
		expect(text(find(el, '.undo')!)).toContain('Wrap the queue when repeat is on');
		expect(labelled(el, '.undo ml-button', 'Undo')).not.toBeNull();
	});

	test('not offered once the last commit is pushed', async () => {
		await status({ undo: null });
		const el = await mount('ms-changes');
		expect(find(el, 'ml-checkbox[label="Amend last commit"]')).toBeNull();
		expect(find(el, '.undo')).toBeNull();
		expect(text(el)).not.toContain('Undo');
	});

	test('ticking amend takes the last commit\'s message and replaces that commit', async () => {
		const el = await mount('ms-changes');
		await tick(find(el, 'ml-checkbox[label="Amend last commit"]'), true);
		expect(text(commitButton(el))).toBe('Amend last commit');
		expect(repos.summary()).toBe('Wrap the queue when repeat is on');
		expect(repos.description()).toBe('The cursor resets instead of running off the end.');
		await click(inner(commitButton(el)));
		expect(w.sent('commit_changes').at(-1)!.args).toMatchObject({ amend: true, summary: 'Wrap the queue when repeat is on' });
	});

	test('amending does not replace a message already typed', async () => {
		const el = await mount('ms-changes');
		await type(find(el, '.commit ml-input'), 'My words');
		await tick(find(el, 'ml-checkbox[label="Amend last commit"]'), true);
		expect(repos.summary()).toBe('My words');
	});

	test('amend works with no file ticked', async () => {
		const el = await mount('ms-changes');
		await tick(find(el, '.head ml-checkbox'), false);
		await tick(find(el, 'ml-checkbox[label="Amend last commit"]'), true);
		expect(inner(commitButton(el)).disabled).toBe(false);
		await click(inner(commitButton(el)));
		expect(w.sent('commit_changes').at(-1)!.args).toMatchObject({ amend: true, paths: [] });
	});

	test('Undo takes the commit back and puts its message in the form', async () => {
		const el = await mount('ms-changes');
		await click(inner(labelled(el, '.undo ml-button', 'Undo')));
		expect(w.sent('undo_commit').length).toBe(1);
		expect(repos.summary()).toBe('Wrap the queue when repeat is on');
		// The commit under it is pushed, so there is nothing more to undo.
		expect(find(el, '.undo')).toBeNull();
	});
});

describe('an operation that stopped', () => {
	test('a merge with conflicts says how many files to resolve', async () => {
		await status({ operation: 'merge', mergeInProgress: true });
		const el = await mount('ms-changes');
		expect(text(find(el, '.banner:not(.plain)')!)).toContain('Merge stopped: 1 conflicted file to resolve.');
	});

	test('with nothing conflicted it is only in progress', async () => {
		const files = repos.status()!.files.filter((f) => f.status !== 'conflicted');
		await status({ operation: 'squash', files });
		const el = await mount('ms-changes');
		expect(text(el)).toContain('Squash merge in progress.');
	});

	test.each([
		['rebase', 'Rebase stopped'],
		['cherry-pick', 'Cherry-pick stopped'],
		['revert', 'Revert stopped'],
	] as const)('a %s is named', async (operation, words) => {
		await status({ operation });
		const el = await mount('ms-changes');
		expect(text(el)).toContain(words);
	});

	test('Continue carries on and Abort gives up', async () => {
		await status({ operation: 'rebase', rebaseInProgress: true });
		const el = await mount('ms-changes');
		await click(labelled(el, '.banner a', 'Continue'));
		expect(w.sent('op_continue').length).toBe(1);
		expect(w.sent('op_abort').length).toBe(0);
		await click(labelled(el, '.banner a', 'Abort'));
		expect(w.sent('op_abort').length).toBe(1);
	});

	test('no bar without an operation', async () => {
		const el = await mount('ms-changes');
		expect(labelled(el, 'a', 'Continue')).toBeNull();
		expect(labelled(el, 'a', 'Abort')).toBeNull();
	});

	test('stashing is not offered in the middle of one', async () => {
		await status({ operation: 'merge' });
		const el = await mount('ms-changes');
		expect(find(el, '[title="Stash all changes"]')).toBeNull();
		expect(find(el, '[title="Discard all changes…"]')).not.toBeNull();
	});
});

describe('stash', () => {
	test('stashing puts the changes away, with the summary as its name', async () => {
		const el = await mount('ms-changes');
		await type(find(el, '.commit ml-input'), 'Half done');
		await click(find(el, '[title="Stash all changes"]'));
		expect(w.sent('stash_save').at(-1)!.args.message).toBe('Half done');
		expect(rows(el)).toEqual([]);
		expect(text(find(el, '.banner.plain')!)).toContain('Stashed changes');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Changes stashed' });
	});

	test('Restore brings the stash back', async () => {
		const el = await mount('ms-changes');
		await click(find(el, '[title="Stash all changes"]'));
		await click(labelled(el, '.banner a', 'Restore'));
		expect(w.sent('stash_pop').at(-1)!.args.name).toBe('stash@{0}');
		expect(rows(el).length).toBe(5);
		expect(find(el, '.banner.plain')).toBeNull();
	});

	test('Discard drops the stash', async () => {
		const el = await mount('ms-changes');
		await click(find(el, '[title="Stash all changes"]'));
		await click(labelled(el, '.banner a', 'Discard'));
		expect(w.sent('stash_drop').at(-1)!.args.name).toBe('stash@{0}');
		expect(find(el, '.banner.plain')).toBeNull();
	});

	test('several stashes are counted', async () => {
		const stash = { name: 'stash@{0}', message: 'On main: one', date: new Date().toISOString() };
		await status({ stashes: [stash, { ...stash, name: 'stash@{1}' }] });
		const el = await mount('ms-changes');
		expect(text(find(el, '.banner.plain')!)).toContain('Stashed changes (2)');
	});
});

describe('discarding', () => {
	test('Discard all asks first, about every file', async () => {
		const el = await mount('ms-changes');
		await click(find(el, '[title="Discard all changes…"]'));
		expect(opened).toEqual(['discard']);
		expect(repos.prompt().files).toEqual(repos.status()!.files);
		expect(w.sent('discard_changes')).toEqual([]);
	});
});

describe('the right-click menu', () => {
	function items(el: Element): string[] {
		return all(el, '.ctx .ctx-item').map((i) => words(i));
	}

	test('a modified file: open in a tab, discard, copy its path', async () => {
		const el = await mount('ms-changes');
		await rightClick(row(el, 'queue.ts'));
		expect(items(el)).toEqual(['Open in new tab', 'Discard changes…', 'Copy file path']);
		expect(repos.selectedPath()).toBe('src/player/queue.ts');
	});

	test('a new file can also be ignored', async () => {
		const el = await mount('ms-changes');
		await rightClick(row(el, 'repeat.ts'));
		expect(items(el)).toContain('Ignore file (add to .gitignore)');
		await click(named(el, '.ctx-item', 'Ignore file (add to .gitignore)'));
		expect(w.sent('ignore_file').at(-1)!.args.path).toBe('src/player/repeat.ts');
	});

	test('a conflicted file can be resolved either way', async () => {
		const el = await mount('ms-changes');
		await rightClick(row(el, 'shuffle.ts'));
		expect(items(el)).toEqual(['Open in new tab', 'Resolve using my version', 'Resolve using their version', 'Propose a resolution', 'Discard changes…', 'Copy file path']);
		await click(named(el, '.ctx-item', 'Resolve using their version'));
		expect(w.sent('resolve_file').at(-1)!.args).toMatchObject({ path: 'src/player/shuffle.ts', side: 'theirs' });
	});

	test('"my version" resolves with mine', async () => {
		const el = await mount('ms-changes');
		await rightClick(row(el, 'shuffle.ts'));
		await click(named(el, '.ctx-item', 'Resolve using my version'));
		expect(w.sent('resolve_file').at(-1)!.args.side).toBe('mine');
	});

	test('Open in new tab pins the file above the diff', async () => {
		const el = await mount('ms-changes');
		await rightClick(row(el, 'cover.png'));
		await click(named(el, '.ctx-item', 'Open in new tab'));
		expect(repos.openTabs()).toEqual(['public/cover.png']);
	});

	test('Discard changes asks first, about that file only', async () => {
		const el = await mount('ms-changes');
		await rightClick(row(el, 'cover.png'));
		await click(named(el, '.ctx-item', 'Discard changes…'));
		expect(opened).toEqual(['discard']);
		expect(repos.prompt().files!.map((f) => f.path)).toEqual(['public/cover.png']);
		expect(w.sent('discard_changes')).toEqual([]);
	});

	test('Copy file path puts the path on the clipboard', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const el = await mount('ms-changes');
		await rightClick(row(el, 'cover.png'));
		await click(named(el, '.ctx-item', 'Copy file path'));
		expect(writeText).toHaveBeenCalledWith('public/cover.png');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Path copied' });
	});

	test('a click anywhere else closes it', async () => {
		const el = await mount('ms-changes');
		await rightClick(row(el, 'queue.ts'));
		expect(find(el, '.ctx')).not.toBeNull();
		window.dispatchEvent(new MouseEvent('click'));
		await settle();
		expect(find(el, '.ctx')).toBeNull();
	});
});

describe('a Jira key in the branch name', () => {
	test('is offered as the start of the summary', async () => {
		await status({ branch: 'ABC-12-login' });
		const el = await mount('ms-changes');
		const chip = named(el, 'button', 'Add ABC-12');
		expect(chip).not.toBeNull();
		await type(find(el, '.commit ml-input'), 'Fix the form');
		await click(named(el, 'button', 'Add ABC-12'));
		expect(repos.summary()).toBe('ABC-12 Fix the form');
		expect(named(el, 'button', 'Add ABC-12')).toBeNull();
	});

	test('is not offered on a branch without one', async () => {
		const el = await mount('ms-changes');
		expect(find(el, '.keychip')).toBeNull();
	});
});
