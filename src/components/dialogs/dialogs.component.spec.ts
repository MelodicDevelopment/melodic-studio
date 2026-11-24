import { beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { DialogName, Prompt, RepoStore } from '../../services/repo.store';
import type { AgentsStore } from '../../services/agents.store';
import type { BackendService, RepoStatus } from '../../services/backend.service';

// The dialogs that confirm something or act on a branch, a tag or a remote. The Add a repository and Settings
// dialogs are in dialogs.template.spec.ts.

// Monaco and xterm cannot run in happy-dom; nothing here needs either to arrive.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
let backend: BackendService;

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

/** happy-dom has no Popover API (an `ml-select` closes its list through it). */
function popovers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, (this: HTMLElement) => void>;
	proto.showPopover = proto.hidePopover = proto.togglePopover = function () {};
}

/**
 * `<ml-dialog #name>` takes its id from the attribute that starts with `#`. happy-dom's parser drops the `#`,
 * so no dialog would be known by the name `RepoStore.ask` opens it by: this puts it back.
 */
function dialogNames(): void {
	const names = Element.prototype.getAttributeNames;
	vi.spyOn(Element.prototype, 'getAttributeNames').mockImplementation(function (this: Element) {
		const found = names.call(this);
		return this.localName === 'ml-dialog' ? found.map((n) => (n === 'style' || n === 'class' ? n : `#${n}`)) : found;
	});
}

beforeEach(async () => {
	w = await world();
	forgetElements();
	popovers();
	dialogNames();
	w.on('ci_runs', () => []);
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	backend = w.get((await import('../../services/backend.service')).BackendService);
	await repos.init();
	await mount('ms-dialogs');
});

/** The `ml-dialog` known by `name`. */
function dialog(name: string): HTMLElement {
	return all(document.body, 'ml-dialog').find((d) => d.shadowRoot!.querySelector('dialog')!.id === name)!;
}

function isOpen(name: string): boolean {
	return dialog(name).shadowRoot!.querySelector('dialog')!.open;
}

/**
 * Opens a dialog as the app does, through `RepoStore.ask`. A dialog announces itself from inside its shadow root,
 * and happy-dom does not retarget that event to the `ml-dialog` as a browser does, so it is sent once more from
 * the `ml-dialog` itself, which is where the component listens for it.
 */
async function ask(name: DialogName, prompt: Prompt = {}): Promise<HTMLElement> {
	const host = dialog(name);
	let heard = false;
	const probe = (e: Event): void => void (heard ||= e.target === host);
	host.addEventListener('ml:open', probe);
	repos.ask(name, prompt);
	host.removeEventListener('ml:open', probe);
	if (!heard) {
		host.dispatchEvent(new CustomEvent('ml:open'));
	}
	await settle();
	return host;
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
	return out.replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
}

/** The `ml-button` that reads `label`. */
function button(root: Element, label: string): HTMLElement {
	const found = all(root, 'ml-button').find((b) => words(b) === label);
	if (!found) {
		throw new Error(`no button "${label}" among: ${all(root, 'ml-button').map((b) => words(b)).join(' | ')}`);
	}
	return found;
}

function isOff(root: Element, label: string): boolean {
	return find<HTMLButtonElement>(button(root, label), 'button')!.disabled;
}

async function press(root: Element, label: string): Promise<void> {
	await click(find(button(root, label), 'button'));
}

/** The `ml-input`, `ml-checkbox` or `ml-select` with this label. */
function field(root: Element, label: string | RegExp): HTMLElement {
	const found = all(root, 'ml-input, ml-checkbox, ml-select, ml-textarea').find((f) => {
		const own = f.getAttribute('label') ?? '';
		return typeof label === 'string' ? own === label : label.test(own);
	});
	if (!found) {
		throw new Error(`no field "${String(label)}"`);
	}
	return found;
}

function value(root: Element, label: string): string {
	return find<HTMLInputElement>(field(root, label), 'input')!.value;
}

async function type(target: Element, text: string): Promise<void> {
	const input = find<HTMLInputElement>(target, 'input, textarea')!;
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}

async function tick(box: Element, on: boolean): Promise<void> {
	const input = find<HTMLInputElement>(box, 'input')!;
	input.checked = on;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

function ticked(box: Element): boolean {
	return find<HTMLInputElement>(box, 'input')!.checked;
}

/** Picks an option of an `ml-select` by what it reads. */
async function choose(select: Element, label: string): Promise<void> {
	await click(all(select, '.ml-select__option').find((o) => words(o) === label)!);
}

/** The status the native side answers from now on: the demo's, with `change` on top. */
async function status(change: Partial<RepoStatus>): Promise<void> {
	const base = repos.status()!;
	w.on('repo_status', () => ({ ...base, ...change }));
	await repos.refresh();
	await settle();
}

describe('new branch', () => {
	test('starts empty, from the current branch, and says the changes come along', async () => {
		const d = await ask('new-branch');
		expect(value(d, 'Name')).toBe('');
		expect(isOff(d, 'Create branch')).toBe(true);
		expect(words(find(d, '.dlg p')!)).toBe('Starts from feature/repeat-mode and brings your uncommitted changes along.');
	});

	test('with a clean tree nothing is said about changes', async () => {
		await status({ files: [] });
		const d = await ask('new-branch');
		expect(words(find(d, '.dlg p')!)).toBe('Starts from feature/repeat-mode .');
	});

	test('spaces in the name become dashes', async () => {
		const d = await ask('new-branch');
		await type(field(d, 'Name'), 'fix the queue');
		expect(value(d, 'Name')).toBe('fix-the-queue');
	});

	test('Create makes the branch and closes', async () => {
		const d = await ask('new-branch');
		await type(field(d, 'Name'), 'feature/shuffle');
		await press(d, 'Create branch');
		expect(w.sent('branch_create').at(-1)!.args).toMatchObject({ name: 'feature/shuffle', start: null });
		expect(isOpen('new-branch')).toBe(false);
	});

	test('from a commit it starts there', async () => {
		repos.setTab('history');
		await settle();
		const commit = repos.commits()[2];
		const d = await ask('new-branch', { commit });
		expect(words(find(d, '.dlg p')!)).toContain(`Starts from ${commit.shortHash} ${commit.summary}`);
		await type(field(d, 'Name'), 'hotfix');
		await press(d, 'Create branch');
		expect(w.sent('branch_create').at(-1)!.args).toMatchObject({ name: 'hotfix', start: commit.hash });
	});

	test('a name git refuses keeps the dialog open', async () => {
		w.on('branch_create', () => {
			throw appError('git', "fatal: a branch named 'main' already exists");
		});
		const d = await ask('new-branch');
		await type(field(d, 'Name'), 'main');
		await press(d, 'Create branch');
		expect(isOpen('new-branch')).toBe(true);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error' });
	});

	test('the name typed last time is gone when it opens again', async () => {
		const d = await ask('new-branch');
		await type(field(d, 'Name'), 'left-over');
		await press(d, 'Cancel');
		await ask('new-branch');
		expect(value(d, 'Name')).toBe('');
	});
});

describe('rename branch', () => {
	test('starts with the branch\'s name, and Rename is off until it differs', async () => {
		const d = await ask('rename-branch', { branch: 'fix/seek-drift' });
		expect(value(d, 'Name')).toBe('fix/seek-drift');
		expect(isOff(d, 'Rename')).toBe(true);
		expect(words(d)).toContain('Only the local branch is renamed.');
	});

	test('Rename renames it and closes', async () => {
		const d = await ask('rename-branch', { branch: 'fix/seek-drift' });
		await type(field(d, 'Name'), 'fix/seek drift 2');
		await press(d, 'Rename');
		expect(w.sent('branch_rename').at(-1)!.args).toMatchObject({ from: 'fix/seek-drift', to: 'fix/seek-drift-2' });
		expect(isOpen('rename-branch')).toBe(false);
	});
});

describe('delete branch', () => {
	test('a branch that is on the remote: the box to delete it there is unticked', async () => {
		const d = await ask('delete-branch', { branch: 'main' });
		expect(words(find(d, '.dlg p')!)).toBe('Delete the branch main ?');
		const box = field(d, 'Also delete origin/main on the remote');
		expect(ticked(box)).toBe(false);
		expect(find(d, '.warn')).toBeNull();
		expect(button(d, 'Delete')).toBeDefined();
	});

	test('left unticked, only the local branch is deleted', async () => {
		const d = await ask('delete-branch', { branch: 'main' });
		await press(d, 'Delete');
		expect(w.sent('branch_delete').at(-1)!.args).toMatchObject({ name: 'main', force: false, remote: false });
		expect(isOpen('delete-branch')).toBe(false);
	});

	test('ticked, it warns, the button says both, and both are deleted', async () => {
		const d = await ask('delete-branch', { branch: 'main' });
		await tick(field(d, 'Also delete origin/main on the remote'), true);
		expect(words(find(d, '.warn')!)).toBe('Everyone who uses that remote loses the branch.');
		await press(d, 'Delete here and on the remote');
		expect(w.sent('branch_delete').at(-1)!.args).toMatchObject({ name: 'main', force: false, remote: true });
	});

	test('the box is unticked again the next time the dialog opens', async () => {
		const d = await ask('delete-branch', { branch: 'main' });
		await tick(field(d, 'Also delete origin/main on the remote'), true);
		await press(d, 'Cancel');
		await ask('delete-branch', { branch: 'main' });
		expect(ticked(field(d, 'Also delete origin/main on the remote'))).toBe(false);
	});

	test('a branch that is only local has no such box', async () => {
		const d = await ask('delete-branch', { branch: 'fix/seek-drift' });
		expect(words(find(d, '.dlg p')!)).toBe('Delete the local branch fix/seek-drift ? It has no copy on a remote.');
		expect(all(d, 'ml-checkbox')).toEqual([]);
		await press(d, 'Delete');
		expect(w.sent('branch_delete').at(-1)!.args).toMatchObject({ name: 'fix/seek-drift', remote: false });
	});

	test('a branch that tracks origin/main but has no copy of its own is not offered the remote', async () => {
		const list = repos.branches();
		w.on('branches', () => [...list, { name: 'spike', isRemote: false, isCurrent: false, upstream: 'origin/main', published: null, date: new Date().toISOString() }]);
		await repos.loadBranches();
		const d = await ask('delete-branch', { branch: 'spike' });
		expect(all(d, 'ml-checkbox')).toEqual([]);
		expect(words(d)).not.toContain('origin/main');
	});

	test('the checked-out branch: says where it switches to, and switches first', async () => {
		const d = await ask('delete-branch', { branch: 'feature/repeat-mode' });
		expect(words(d)).toContain('It is checked out, so Melodic Studio switches to main first.');
		await press(d, 'Delete');
		const order = w.calls.map((c) => c.cmd).filter((c) => c === 'branch_checkout' || c === 'branch_delete');
		expect(order).toEqual(['branch_checkout', 'branch_delete']);
		expect(w.sent('branch_checkout').at(-1)!.args).toMatchObject({ name: 'main', isRemote: false });
	});

	test('a branch with unmerged commits is not forced until asked again', async () => {
		w.on('branch_delete', (args) => {
			if (!args.force) {
				throw appError('git', "error: the branch 'fix/seek-drift' is not fully merged");
			}
		});
		const d = await ask('delete-branch', { branch: 'fix/seek-drift' });
		await press(d, 'Delete');
		expect(isOpen('delete-branch')).toBe(true);
		expect(words(find(d, '.warn')!)).toBe('This branch has commits that are not merged anywhere. Deleting it loses them.');
		expect(w.toasts).toEqual([]);
		await press(d, 'Delete anyway');
		expect(w.sent('branch_delete').map((c) => c.args.force)).toEqual([false, true]);
		expect(isOpen('delete-branch')).toBe(false);
	});

	test('a remote branch is deleted on the remote, with a warning of what that means', async () => {
		const d = await ask('delete-branch', { branch: 'origin/release/1.4', remote: true });
		expect(words(find(d, '.dlg p')!)).toBe('Delete origin/release/1.4 on the remote? Everyone who uses that remote loses the branch. Local branches are left alone.');
		await press(d, 'Delete');
		expect(w.sent('branch_delete_remote').at(-1)!.args.name).toBe('origin/release/1.4');
		expect(w.sent('branch_delete')).toEqual([]);
	});

	test('a branch a worktree holds: the worktree goes too, and it is said', async () => {
		const path = await backend.addWorktree(repos.repo()!.id, 'agent/fix-queue', null);
		await repos.loadBranches();
		const d = await ask('delete-branch', { branch: 'agent/fix-queue' });
		expect(words(d)).toContain('It is checked out in a worktree, which is removed too.');
		expect(words(d)).not.toContain('uncommitted');
		await press(d, 'Delete branch and worktree');
		const order = w.calls.map((c) => c.cmd).filter((c) => c === 'worktree_remove' || c === 'branch_delete');
		expect(order).toEqual(['worktree_remove', 'branch_delete']);
		expect(w.sent('worktree_remove').at(-1)!.args).toMatchObject({ path, force: false, deleteBranch: false });
	});

	test('uncommitted changes in that worktree are said to be lost, and it is removed by force', async () => {
		const path = await backend.addWorktree(repos.repo()!.id, 'agent/fix-queue', null);
		const trees = await backend.worktrees(repos.repo()!.id);
		w.on('worktree_list', () => trees.map((t) => (t.path === path ? { ...t, changes: 2 } : t)));
		await repos.loadBranches();
		const d = await ask('delete-branch', { branch: 'agent/fix-queue' });
		expect(words(d)).toContain('That worktree has 2 uncommitted changes. They are lost.');
		await press(d, 'Delete branch and worktree');
		expect(w.sent('worktree_remove').at(-1)!.args).toMatchObject({ path, force: true });
	});

	test('a branch the main checkout holds cannot be deleted from a worktree', async () => {
		const trees = await backend.worktrees(repos.repo()!.id);
		w.on('worktree_list', () => [{ ...trees[0], active: false, branch: 'main' }]);
		const d = await ask('delete-branch', { branch: 'main' });
		expect(words(d)).toContain('It is checked out in the main checkout. Switch that to another branch first.');
		expect(isOff(d, 'Delete branch and worktree')).toBe(true);
		await press(d, 'Delete branch and worktree');
		expect(w.sent('branch_delete')).toEqual([]);
		expect(w.sent('worktree_remove')).toEqual([]);
	});
});

describe('create tag', () => {
	async function tagDialog(): Promise<HTMLElement> {
		repos.setTab('history');
		await settle();
		return ask('new-tag', { commit: repos.commits()[1] });
	}

	test('names the commit, and pushing the tag is unticked', async () => {
		const d = await tagDialog();
		const commit = repos.commits()[1];
		expect(words(find(d, '.dlg p')!)).toBe(`Tags ${commit.shortHash} ${commit.summary} .`);
		expect(ticked(field(d, 'Push the tag to origin'))).toBe(false);
		expect(isOff(d, 'Create tag')).toBe(true);
	});

	test('Create tags the commit locally', async () => {
		const d = await tagDialog();
		await type(field(d, 'Name'), 'v 1.4.0');
		await press(d, 'Create tag');
		expect(w.sent('tag_create').at(-1)!.args).toMatchObject({ name: 'v-1.4.0', hash: repos.commits()[1].hash, push: false });
		expect(isOpen('new-tag')).toBe(false);
	});

	test('with the box ticked the tag is pushed too', async () => {
		const d = await tagDialog();
		await type(field(d, 'Name'), 'v1.4.0');
		await tick(field(d, 'Push the tag to origin'), true);
		await press(d, 'Create tag');
		expect(w.sent('tag_create').at(-1)!.args.push).toBe(true);
	});

	test('without a remote there is nowhere to push it', async () => {
		await status({ remote: null });
		const d = await tagDialog();
		expect(all(d, 'ml-checkbox')).toEqual([]);
	});
});

describe('reset branch', () => {
	async function resetDialog(): Promise<HTMLElement> {
		repos.setTab('history');
		await settle();
		return ask('reset', { commit: repos.commits()[2] });
	}

	test('says which branch moves where, and keeps the changes unless told otherwise', async () => {
		const d = await resetDialog();
		const commit = repos.commits()[2];
		expect(words(find(d, '.dlg p')!)).toBe(`Move feature/repeat-mode back to ${commit.shortHash} ${commit.summary} . Every commit after it leaves the branch.`);
		expect(find(d, '.warn')).toBeNull();
		await press(d, 'Reset');
		expect(w.sent('reset_to').at(-1)!.args).toMatchObject({ hash: commit.hash, mode: 'mixed' });
		expect(isOpen('reset')).toBe(false);
	});

	test('a hard reset warns that uncommitted changes go too', async () => {
		const d = await resetDialog();
		await choose(field(d, 'What happens to their changes'), 'Hard: throw the later changes away');
		expect(words(find(d, '.warn')!)).toBe('A hard reset also discards your uncommitted changes. This cannot be undone from Melodic Studio.');
		await press(d, 'Reset');
		expect(w.sent('reset_to').at(-1)!.args.mode).toBe('hard');
	});

	test('the mode chosen last time does not stay', async () => {
		const d = await resetDialog();
		await choose(field(d, 'What happens to their changes'), 'Hard: throw the later changes away');
		await press(d, 'Cancel');
		await ask('reset', { commit: repos.commits()[2] });
		await press(d, 'Reset');
		expect(w.sent('reset_to').at(-1)!.args.mode).toBe('mixed');
	});
});

describe('a rejected push', () => {
	test('explains the two cases and that the force is --force-with-lease', async () => {
		const d = await ask('force-push');
		expect(words(d)).toContain('The remote has commits that feature/repeat-mode does not. If someone else pushed, cancel and pull first.');
		expect(words(d)).toContain('--force-with-lease');
	});

	test('"Force push" pushes with force; nothing was pushed before the click', async () => {
		const d = await ask('force-push');
		expect(w.sent('push')).toEqual([]);
		await press(d, 'Force push');
		expect(w.sent('push').map((c) => c.args.force)).toEqual([true]);
		expect(isOpen('force-push')).toBe(false);
	});

	test('a push the remote rejects opens this dialog', async () => {
		w.on('push', () => {
			throw appError('git', ' ! [rejected] feature/repeat-mode -> feature/repeat-mode (fetch first)');
		});
		await repos.runSync();
		await settle();
		expect(isOpen('force-push')).toBe(true);
	});
});

describe('publish repository', () => {
	test('needs a URL, then sets it as origin and pushes', async () => {
		const d = await ask('publish');
		expect(isOff(d, 'Publish')).toBe(true);
		await type(field(d, 'Remote URL'), '  git@github.com:demo/harmony.git ');
		await press(d, 'Publish');
		expect(w.sent('remote_set').at(-1)!.args.url).toBe('git@github.com:demo/harmony.git');
		const order = w.calls.map((c) => c.cmd).filter((c) => c === 'remote_set' || c === 'push');
		expect(order).toEqual(['remote_set', 'push']);
		expect(isOpen('publish')).toBe(false);
	});

	test('a push that fails keeps the dialog open', async () => {
		w.on('push', () => {
			throw appError('auth', 'Permission denied (publickey)');
		});
		const d = await ask('publish');
		await type(field(d, 'Remote URL'), 'git@github.com:demo/harmony.git');
		await press(d, 'Publish');
		expect(isOpen('publish')).toBe(true);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'Authentication failed' });
	});
});

describe('discard changes', () => {
	test('one file is named', async () => {
		const file = repos.status()!.files[1];
		const d = await ask('discard', { files: [file] });
		expect(words(find(d, '.dlg p')!)).toBe('Discard all changes to public/cover.png ?');
		expect(words(d)).toContain('Edits to tracked files cannot be recovered. New files are moved to the trash.');
	});

	test('several are counted', async () => {
		const d = await ask('discard', { files: repos.status()!.files });
		expect(words(find(d, '.dlg p')!)).toBe('Discard changes to 5 files ?');
	});

	test('Discard discards exactly those files', async () => {
		const files = repos.status()!.files.slice(1, 3);
		const d = await ask('discard', { files });
		await press(d, 'Discard');
		expect(w.sent('discard_changes').at(-1)!.args.files).toEqual(files.map((f) => ({ path: f.path, oldPath: f.oldPath })));
		expect(isOpen('discard')).toBe(false);
		expect(repos.status()!.files.map((f) => f.path)).toEqual(['docs/old-notes.md', 'src/player/repeat.ts', 'src/player/shuffle.ts']);
	});
});

describe('remove repository', () => {
	test('names it, says the disk is left alone, and removes it on the click', async () => {
		const cadence = repos.app()!.repos[1];
		const d = await ask('remove-repo', { repo: cadence });
		expect(words(find(d, '.dlg p')!)).toBe('Remove cadence from Melodic Studio? Nothing on disk is touched.');
		await press(d, 'Remove');
		expect(w.sent('repo_remove').at(-1)!.args.id).toBe(cadence.id);
		expect(repos.app()!.repos.map((r) => r.name)).toEqual(['harmony']);
		expect(isOpen('remove-repo')).toBe(false);
	});
});

describe('the worktrees are read when a branch dialog opens', () => {
	test('so a branch held elsewhere is known', async () => {
		const before = w.sent('worktree_list').length;
		await ask('delete-branch', { branch: 'main' });
		expect(w.sent('worktree_list').length).toBe(before + 1);
		expect(agents.worktrees().length).toBe(1);
	});
});
