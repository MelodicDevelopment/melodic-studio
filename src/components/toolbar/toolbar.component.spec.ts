import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount, text } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { AgentsStore } from '../../services/agents.store';
import type { CiRun, RepoStatus } from '../../services/backend.service';

// Monaco and xterm cannot run in happy-dom; nothing here needs either to arrive.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
/** The dialogs the component asked for, by id. */
let opened: string[];
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

/** happy-dom has no Popover API: these keep an `open` mark on the element and send the `toggle` event a browser does. */
function popovers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, (this: HTMLElement) => void>;
	const set = (el: HTMLElement, open: boolean): void => {
		if (el.hasAttribute('data-open') !== open) {
			el.toggleAttribute('data-open', open);
			el.dispatchEvent(Object.assign(new Event('toggle'), { newState: open ? 'open' : 'closed', oldState: open ? 'closed' : 'open' }));
		}
	};
	proto.showPopover = function () {
		set(this, true);
	};
	proto.hidePopover = function () {
		set(this, false);
	};
	proto.togglePopover = function () {
		set(this, !this.hasAttribute('data-open'));
	};
}

/** The app on this platform, started. `navigator.platform` is what `isMac()` and `isWindows()` read. */
async function start(on = 'MacIntel'): Promise<void> {
	Object.defineProperty(navigator, 'platform', { value: on, configurable: true });
	w = await world();
	forgetElements();
	popovers();
	// The demo host answers after a real pause; the checks are answered here.
	w.on('ci_runs', () => []);
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	const { DialogService } = await import('@melodicdev/components/dialog');
	opened = [];
	vi.spyOn(w.get(DialogService), 'open').mockImplementation(((id: string) => void opened.push(id)) as never);
	await repos.init();
}

beforeEach(() => start());

afterEach(() => {
	if (platform) {
		Object.defineProperty(navigator, 'platform', platform);
	}
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

/**
 * Opens (or closes) one of the toolbar's dropdowns. The click goes to the popover's own trigger wrapper:
 * happy-dom does not carry a click on slotted content through the slot's ancestors, as a browser does.
 */
async function toggle(el: Element, id: string): Promise<void> {
	await click(find(el, `#${id}`)!.shadowRoot!.querySelector('.ml-popover__trigger'));
}

function isOpen(el: Element, id: string): boolean {
	return find(el, `#${id}`)!.shadowRoot!.querySelector('.ml-popover__content')!.hasAttribute('data-open');
}

function row(el: Element, pop: string, name: string): HTMLElement {
	return all(el, `#${pop} .item`).find((i) => find(i, '.name')!.firstChild!.textContent === name)!;
}

async function type(field: Element | null, value: string): Promise<void> {
	const input = find<HTMLInputElement>(field!, 'input')!;
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}

async function rightClick(target: Element): Promise<void> {
	target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 40, clientY: 60 }));
	await settle();
}

function menu(el: Element): string[] {
	return all(el, '.ctx .ctx-item').map((i) => words(i));
}

/** A worktree of the open repository on `branch`, as the list of checkouts reports it. */
async function worktree(branch: string): Promise<string> {
	const path = await w.get((await import('../../services/backend.service')).BackendService).addWorktree(repos.repo()!.id, branch, null);
	await agents.loadWorktrees();
	await repos.loadBranches();
	return path;
}

describe('the repository dropdown', () => {
	test('the button names the open repository', async () => {
		const el = await mount('ms-toolbar');
		expect(words(find(el, '#repo-pop button.seg')!)).toBe('Current repository harmony');
	});

	test('with no repository it says None, and has no branch or sync button', async () => {
		w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: '', authorEmail: '', appVersion: '0.1.0' }));
		await repos.switchContext();
		const el = await mount('ms-toolbar');
		expect(words(find(el, '#repo-pop button.seg')!)).toBe('Current repository None');
		expect(words(find(el, '#repo-pop .none')!)).toBe('No repositories yet.');
		expect(find(el, '#branch-pop')).toBeNull();
		expect(find(el, '.sync')).toBeNull();
	});

	test('repositories are listed under their host, then their owner', async () => {
		const el = await mount('ms-toolbar');
		expect(all(el, '#repo-pop .list > *').map((n) => words(n))).toEqual(['GitHub 1', 'melodic-demo 1', 'harmony /Users/demo/Source/harmony', 'Azure DevOps 1', 'contoso/Music 1', 'cadence /Users/demo/Source/cadence']);
	});

	test('opening it puts the cursor in the filter', async () => {
		vi.stubGlobal('requestAnimationFrame', (run: () => void) => (run(), 0));
		const el = await mount('ms-toolbar');
		await toggle(el, 'repo-pop');
		expect(isOpen(el, 'repo-pop')).toBe(true);
		const input = find(find(el, '#repo-pop ml-input')!, 'input');
		expect(find(el, '#repo-pop ml-input')!.shadowRoot!.activeElement).toBe(input);
		vi.unstubAllGlobals();
	});

	test('the filter narrows by name or path', async () => {
		const el = await mount('ms-toolbar');
		await type(find(el, '#repo-pop ml-input'), 'CAD');
		expect(all(el, '#repo-pop .item .name').map((n) => n.firstChild!.textContent)).toEqual(['cadence']);
		await type(find(el, '#repo-pop ml-input'), 'nothing-like-it');
		expect(words(find(el, '#repo-pop .none')!)).toBe('No repositories match.');
	});

	test('a group folds, and stays folded the next time', async () => {
		const el = await mount('ms-toolbar');
		await click(named(el, '#repo-pop .grp', 'GitHub 1'));
		expect(all(el, '#repo-pop .item .name').map((n) => n.firstChild!.textContent)).toEqual(['cadence']);
		expect(JSON.parse(localStorage.getItem('studio.repo-groups.collapsed')!)).toEqual(['github']);

		el.remove();
		const again = await mount('ms-toolbar');
		expect(all(again, '#repo-pop .item .name').map((n) => n.firstChild!.textContent)).toEqual(['cadence']);
	});

	test('filtering shows everything, folded or not, and does not fold', async () => {
		const el = await mount('ms-toolbar');
		await click(named(el, '#repo-pop .grp', 'GitHub 1'));
		await type(find(el, '#repo-pop ml-input'), 'harm');
		expect(all(el, '#repo-pop .item .name').map((n) => n.firstChild!.textContent)).toEqual(['harmony']);
		await click(named(el, '#repo-pop .grp', 'GitHub 1'));
		expect(all(el, '#repo-pop .item').length).toBe(1);
	});

	test('picking a repository switches to it in this tab and closes the list', async () => {
		const el = await mount('ms-toolbar');
		await toggle(el, 'repo-pop');
		await click(row(el, 'repo-pop', 'cadence'));
		expect(w.sent('repo_select').at(-1)!.args.id).toBe('/Users/demo/Source/cadence');
		expect(repos.repo()!.name).toBe('cadence');
		expect(repos.repoTabList().map((r) => r.name)).toEqual(['cadence']);
		expect(isOpen(el, 'repo-pop')).toBe(false);
		expect(words(find(el, '#repo-pop button.seg')!)).toBe('Current repository cadence');
	});

	test.each([
		['Cmd', { metaKey: true }],
		['Ctrl', { ctrlKey: true }],
	])('%s-click opens it in a tab of its own', async (_name, mods) => {
		const el = await mount('ms-toolbar');
		row(el, 'repo-pop', 'cadence').dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, ...mods }));
		await settle();
		expect(repos.repoTabList().map((r) => r.name)).toEqual(['harmony', 'cadence']);
		expect(repos.repo()!.name).toBe('cadence');
	});

	test('"Open in a new tab" on a row does the same; the open repository has no such button', async () => {
		const el = await mount('ms-toolbar');
		expect(find(row(el, 'repo-pop', 'harmony'), '[title="Open in a new tab"]')).toBeNull();
		await click(find(row(el, 'repo-pop', 'cadence'), '[title="Open in a new tab"]'));
		expect(repos.repoTabList().map((r) => r.name)).toEqual(['harmony', 'cadence']);
	});

	test('the cross on a row asks before removing, and does not switch to it', async () => {
		const el = await mount('ms-toolbar');
		await click(find(row(el, 'repo-pop', 'cadence'), '[title="Remove from Melodic Studio"]'));
		expect(opened).toEqual(['remove-repo']);
		expect(repos.prompt().repo!.name).toBe('cadence');
		expect(w.sent('repo_remove')).toEqual([]);
		expect(w.sent('repo_select')).toEqual([]);
	});

	test('a repository whose folder is gone says so', async () => {
		const app = repos.app()!;
		w.on('app_status', () => ({ ...app, repos: app.repos.map((r) => (r.name === 'cadence' ? { ...r, missing: true } : r)) }));
		await repos.switchContext();
		const el = await mount('ms-toolbar');
		expect(words(row(el, 'repo-pop', 'cadence'))).toBe('cadence Folder not found');
		expect(find(row(el, 'repo-pop', 'cadence'), '[title="Open in a new tab"]')).toBeNull();
	});

	test('"Add repository" opens the dialog', async () => {
		const el = await mount('ms-toolbar');
		await click(find(named(el, '#repo-pop ml-button', 'Add repository…')!, 'button'));
		expect(opened).toEqual(['add-repo']);
	});
});

describe('the branch dropdown', () => {
	function branches(el: Element): string[] {
		return all(el, '#branch-pop .list > *').map((n) => (n.classList.contains('group') ? `[${n.textContent}]` : find(n, '.name')!.textContent!));
	}

	test('the button names the checked-out branch', async () => {
		const el = await mount('ms-toolbar');
		expect(words(find(el, '#branch-pop button.seg')!)).toBe('Current branch feature/repeat-mode');
		expect(find(el, '.back')).toBeNull();
	});

	test('a detached HEAD is said', async () => {
		await status({ detached: true, branch: 'a1b2c3d' });
		const el = await mount('ms-toolbar');
		expect(words(find(el, '#branch-pop button.seg')!)).toBe('Detached HEAD a1b2c3d');
	});

	test('local branches, then the remote ones nothing local tracks', async () => {
		const el = await mount('ms-toolbar');
		expect(branches(el)).toEqual(['[Local branches]', 'feature/repeat-mode', 'main', 'fix/seek-drift', '[Remote branches]', 'origin/release/1.4']);
	});

	test('a branch that is on the remote carries a cloud; one that is only local does not', async () => {
		const el = await mount('ms-toolbar');
		expect(find(row(el, 'branch-pop', 'main'), '.pub')!.title).toBe('On the remote as origin/main');
		expect(find(row(el, 'branch-pop', 'feature/repeat-mode'), '.pub')!.title).toBe('On the remote as origin/feature/repeat-mode');
		expect(find(row(el, 'branch-pop', 'fix/seek-drift'), '.pub')).toBeNull();
	});

	test('a branch made from origin/main tracks it but is not on the remote: no cloud', async () => {
		const list = repos.branches();
		w.on('branches', () => [...list, { name: 'spike', isRemote: false, isCurrent: false, upstream: 'origin/main', published: null, date: new Date().toISOString() }]);
		await repos.loadBranches();
		const el = await mount('ms-toolbar');
		expect(find(row(el, 'branch-pop', 'spike'), '.pub')).toBeNull();
	});

	test('opening it reads the branches and the worktrees again', async () => {
		const el = await mount('ms-toolbar');
		const before = [w.sent('branches').length, w.sent('worktree_list').length];
		await toggle(el, 'branch-pop');
		expect([w.sent('branches').length, w.sent('worktree_list').length]).toEqual([before[0] + 1, before[1] + 1]);
	});

	test('the filter narrows both groups', async () => {
		const el = await mount('ms-toolbar');
		await type(find(el, '#branch-pop ml-input'), 'RELEASE');
		expect(branches(el)).toEqual(['[Remote branches]', 'origin/release/1.4']);
		await type(find(el, '#branch-pop ml-input'), 'zzz');
		expect(words(find(el, '#branch-pop .none')!)).toBe('No branches match.');
	});

	test('picking a branch checks it out and closes the list', async () => {
		const el = await mount('ms-toolbar');
		await toggle(el, 'branch-pop');
		await click(row(el, 'branch-pop', 'main'));
		expect(w.sent('branch_checkout').at(-1)!.args).toMatchObject({ name: 'main', isRemote: false });
		expect(isOpen(el, 'branch-pop')).toBe(false);
	});

	test('picking a remote branch checks it out as a remote one', async () => {
		const el = await mount('ms-toolbar');
		await click(row(el, 'branch-pop', 'origin/release/1.4'));
		expect(w.sent('branch_checkout').at(-1)!.args).toMatchObject({ name: 'origin/release/1.4', isRemote: true });
	});

	test('picking the branch already checked out does nothing', async () => {
		const el = await mount('ms-toolbar');
		await click(row(el, 'branch-pop', 'feature/repeat-mode'));
		expect(w.sent('branch_checkout')).toEqual([]);
	});

	test('a branch another worktree holds is not checked out: picking it goes to that worktree', async () => {
		const path = await worktree('agent/fix-queue');
		const el = await mount('ms-toolbar');
		expect(words(find(row(el, 'branch-pop', 'agent/fix-queue'), '.when')!)).toBe('worktree');
		await click(row(el, 'branch-pop', 'agent/fix-queue'));
		expect(w.sent('branch_checkout')).toEqual([]);
		expect(w.sent('worktree_select').at(-1)!.args.path).toBe(path);
	});

	test.each([
		['Merge into current branch', 'merge-branch', { branch: 'main' }],
		['Rebase current branch onto this one', 'merge-branch', { branch: 'main', rebase: true }],
		['Rename', 'rename-branch', { branch: 'main' }],
		['Delete', 'delete-branch', { branch: 'main' }],
	])('"%s" on a row opens its dialog and checks nothing out', async (title, dialog, prompt) => {
		const el = await mount('ms-toolbar');
		await click(find(row(el, 'branch-pop', 'main'), `[title="${title}"]`));
		expect(opened).toEqual([dialog]);
		expect(repos.prompt()).toEqual(prompt);
		expect(w.sent('branch_checkout')).toEqual([]);
	});

	test('the checked-out branch can be renamed, not merged into itself or deleted from its row', async () => {
		const el = await mount('ms-toolbar');
		expect(all(row(el, 'branch-pop', 'feature/repeat-mode'), '.acts button').map((b) => b.title)).toEqual(['Rename']);
	});

	test('a remote branch can be merged or deleted on the remote', async () => {
		const el = await mount('ms-toolbar');
		const remote = row(el, 'branch-pop', 'origin/release/1.4');
		expect(all(remote, '.acts button').map((b) => b.title)).toEqual(['Merge into current branch', 'Delete on the remote']);
		await click(find(remote, '[title="Delete on the remote"]'));
		expect(opened).toEqual(['delete-branch']);
		expect(repos.prompt()).toEqual({ branch: 'origin/release/1.4', remote: true });
	});

	test('"New branch" opens the dialog', async () => {
		const el = await mount('ms-toolbar');
		await click(find(named(el, '#branch-pop ml-button', 'New branch…')!, 'button'));
		expect(opened).toEqual(['new-branch']);
	});

	test('the button is off while a checkout runs', async () => {
		const el = await mount('ms-toolbar');
		repos.busy.set('checkout');
		await settle();
		expect(find<HTMLButtonElement>(el, '#branch-pop button.seg')!.disabled).toBe(true);
	});
});

describe('a worktree on screen', () => {
	test('the branch segment reads "Worktree", with "Back to main" beside it', async () => {
		const path = await worktree('agent/fix-queue');
		await agents.view(path);
		const el = await mount('ms-toolbar');
		const seg = find(el, '#branch-pop button.seg')!;
		expect(words(seg)).toContain('Worktree');
		expect(words(seg)).not.toContain('Current branch');
		expect(seg.title).toContain(path);
		expect(words(find(el, '.back')!)).toBe('Back to main');
	});

	test('"Back to main" returns to the main checkout', async () => {
		const path = await worktree('agent/fix-queue');
		await agents.view(path);
		const el = await mount('ms-toolbar');
		await click(find(el, '.back'));
		expect(w.sent('worktree_select').at(-1)!.args.path).toBeNull();
		expect(repos.repo()!.worktree ?? null).toBeNull();
		expect(find(el, '.back')).toBeNull();
		expect(words(find(el, '#branch-pop button.seg')!)).toContain('Current branch');
	});

	test('the main checkout holding a branch is said on that branch\'s row, and picking it goes back', async () => {
		const path = await worktree('agent/fix-queue');
		await agents.view(path);
		// In the worktree, its own branch is the current one and the main checkout's is held elsewhere.
		const list = repos.branches();
		w.on('branches', () => list.map((b) => ({ ...b, isCurrent: b.name === 'agent/fix-queue' })));
		await repos.loadBranches();
		const el = await mount('ms-toolbar');
		expect(words(find(row(el, 'branch-pop', 'feature/repeat-mode'), '.when')!)).toBe('main checkout');
		await click(row(el, 'branch-pop', 'feature/repeat-mode'));
		expect(w.sent('worktree_select').at(-1)!.args.path).toBeNull();
		expect(w.sent('branch_checkout')).toEqual([]);
	});
});

describe('the sync button', () => {
	function sync(el: Element): HTMLButtonElement {
		return find<HTMLButtonElement>(el, 'button.sync')!;
	}

	test('with commits to push it pushes, and counts them', async () => {
		const el = await mount('ms-toolbar');
		expect(words(sync(el))).toBe('Push origin Last fetched 12 min ago 1');
		await click(sync(el));
		expect(w.sent('push').at(-1)!.args).toMatchObject({ force: false });
		expect(words(sync(el))).toContain('Fetch origin');
	});

	test('behind the remote it pulls', async () => {
		await status({ ahead: 0, behind: 3 });
		const el = await mount('ms-toolbar');
		expect(words(sync(el))).toBe('Pull origin Last fetched 12 min ago 3');
		await click(sync(el));
		expect(w.sent('pull').length).toBe(1);
		expect(w.sent('push')).toEqual([]);
	});

	test('behind and ahead: the pull comes first, both counts show', async () => {
		await status({ ahead: 2, behind: 3 });
		const el = await mount('ms-toolbar');
		expect(words(sync(el))).toBe('Pull origin Last fetched 12 min ago 2 3');
	});

	test('level with the remote it fetches', async () => {
		await status({ ahead: 0, behind: 0, lastFetched: null });
		const el = await mount('ms-toolbar');
		expect(words(sync(el))).toBe('Fetch origin Never fetched');
		await click(sync(el));
		expect(w.sent('fetch').length).toBe(1);
	});

	test('a branch with no upstream is published by pushing it', async () => {
		await status({ upstream: null, ahead: 0 });
		const el = await mount('ms-toolbar');
		expect(words(sync(el))).toBe('Publish branch Push this branch to origin');
		await click(sync(el));
		expect(w.sent('push').at(-1)!.args).toMatchObject({ force: false });
	});

	test('a repository with no remote opens the publish dialog and pushes nothing', async () => {
		await status({ remote: null, upstream: null, host: null });
		const el = await mount('ms-toolbar');
		expect(words(sync(el))).toBe('Publish repository Add a remote to push to');
		await click(sync(el));
		expect(opened).toEqual(['publish']);
		expect(w.sent('push')).toEqual([]);
	});

	test('it is off while something else runs', async () => {
		const el = await mount('ms-toolbar');
		repos.busy.set('commit');
		await settle();
		expect(sync(el).disabled).toBe(true);
	});

	test('while pushing it says so', async () => {
		const el = await mount('ms-toolbar');
		repos.busy.set('push');
		await settle();
		expect(words(sync(el))).toContain('Pushing…');
		expect(find(sync(el), 'ml-spinner')).not.toBeNull();
	});
});

describe('force push', () => {
	test('is offered only after the remote rejects a push, and never sent by the push itself', async () => {
		const el = await mount('ms-toolbar');
		expect(text(el)).not.toMatch(/force/i);
		w.on('push', () => {
			throw appError('git', ' ! [rejected]        main -> main (non-fast-forward)');
		});
		await click(find(el, 'button.sync'));
		expect(opened).toEqual(['force-push']);
		expect(w.sent('push').map((c) => c.args.force)).toEqual([false]);
		expect(w.toasts).toEqual([]);
	});

	test('any other push failure is only said', async () => {
		const el = await mount('ms-toolbar');
		w.on('push', () => {
			throw appError('git', 'remote: Repository not found.');
		});
		await click(find(el, 'button.sync'));
		expect(opened).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'remote: Repository not found.' });
	});
});

describe('the host menu', () => {
	function items(el: Element): string[] {
		return all(el, '#host-pop .list > *').map((n) => (n.classList.contains('group') ? `[${words(n)}]` : words(n)));
	}

	test('lists the host\'s pages and what Studio does with them', async () => {
		const el = await mount('ms-toolbar');
		expect(items(el)).toEqual(['[GitHub]', 'Repository', 'Issues', 'Pull requests', 'New pull request for feature/repeat-mode', '[In Melodic Studio]', 'Browse issues…', 'Browse pull requests…', 'Create pull request…', 'Jira issues…']);
	});

	test.each([
		['Repository', 'remote'],
		['Issues', 'issues'],
		['Pull requests', 'pulls'],
		['New pull request for feature/repeat-mode', 'new-pull'],
	])('"%s" opens that page in the browser', async (label, target) => {
		const el = await mount('ms-toolbar');
		await click(named(el, '#host-pop .item', label));
		expect(w.sent('open_in').at(-1)!.args).toMatchObject({ target, arg: null });
	});

	test('a branch that is not on the remote has no "new pull request" page', async () => {
		await status({ upstream: null });
		const el = await mount('ms-toolbar');
		expect(items(el).some((i) => i.startsWith('New pull request'))).toBe(false);
	});

	test('on a detached HEAD no pull request can be made', async () => {
		await status({ detached: true });
		const el = await mount('ms-toolbar');
		expect(items(el)).not.toContain('Create pull request…');
		expect(items(el).some((i) => i.startsWith('New pull request'))).toBe(false);
	});

	test('Azure DevOps uses its own words', async () => {
		await status({ host: { provider: 'azure', name: 'Azure DevOps', web: 'https://dev.azure.com/contoso/Music', issues: 'https://dev.azure.com/contoso/Music/_workitems', issuesLabel: 'Work items', pulls: 'https://dev.azure.com/contoso/Music/_git/cadence/pullrequests', pullsLabel: 'Pull requests' } });
		const el = await mount('ms-toolbar');
		expect(items(el)).toContain('Work items');
		expect(items(el)).toContain('Browse work items…');
	});

	test('a repository with no host has no host button', async () => {
		await status({ host: null });
		const el = await mount('ms-toolbar');
		expect(find(el, '#host-pop')).toBeNull();
	});

	test('"Browse pull requests" and "Jira issues" open their dialogs', async () => {
		w.on('pr_list', () => []);
		w.on('jira_issues', () => []);
		const el = await mount('ms-toolbar');
		await click(named(el, '#host-pop .item', 'Browse pull requests…'));
		await click(named(el, '#host-pop .item', 'Jira issues…'));
		expect(opened).toEqual(['host-pulls', 'host-jira']);
	});
});

describe('the branch\'s checks', () => {
	const run = (change: Partial<CiRun>): CiRun => ({ id: '9001', name: 'CI', title: 'Wrap the queue', state: 'fail', url: 'https://github.com/demo/harmony/actions/runs/9001', created: new Date().toISOString(), branch: 'feature/repeat-mode', definition: null, ...change });

	async function withRuns(runs: CiRun[]): Promise<HTMLElement> {
		w.on('ci_runs', () => runs);
		const el = await mount('ms-toolbar');
		await settle();
		return el;
	}

	test('are asked for the branch on screen', async () => {
		await withRuns([]);
		expect(w.sent('ci_runs').at(-1)!.args.branch).toBe('feature/repeat-mode');
	});

	test('with none, the host button only opens the host', async () => {
		const el = await withRuns([]);
		expect(find(el, '#host-pop button.tool')!.title).toBe('Open on GitHub');
		expect(find(el, '#host-pop .run')).toBeNull();
	});

	test('a failed run shows on the host button and at the top of its menu', async () => {
		const el = await withRuns([run({}), run({ id: '9000', name: 'Release', title: 'v1.4.0', state: 'pass' })]);
		expect(find(el, '#host-pop button.tool')!.title).toBe('GitHub: checks failed on feature/repeat-mode');
		expect(words(find(el, '#host-pop .group')!)).toBe('Checks on feature/repeat-mode');
		expect(all(el, '#host-pop .run .name').map((n) => n.firstChild!.textContent)).toEqual(['CI', 'Release']);
	});

	test('every run passing reads as passed; one still going as running', async () => {
		const passed = await withRuns([run({ state: 'pass' })]);
		expect(find(passed, '#host-pop button.tool')!.title).toBe('GitHub: checks passed on feature/repeat-mode');
		passed.remove();
		w.on('ci_runs', () => [run({ state: 'pending' }), run({ id: '2', name: 'Lint', state: 'pass' })]);
		await w.get((await import('../../services/host-work.store')).HostWorkStore).loadRuns();
		const running = await mount('ms-toolbar');
		expect(find(running, '#host-pop button.tool')!.title).toBe('GitHub: checks running on feature/repeat-mode');
	});

	test('only a failed run can be run again, and that happens on the click', async () => {
		const el = await withRuns([run({}), run({ id: '9000', name: 'Release', state: 'pass' })]);
		const [failed, passed] = all(el, '#host-pop .run');
		expect(find(passed, '[title="Run the failed jobs again"]')).toBeNull();
		expect(w.sent('ci_rerun')).toEqual([]);
		w.on('ci_rerun', () => undefined);
		await click(find(failed, '[title="Run the failed jobs again"]'));
		expect(w.sent('ci_rerun').at(-1)!.args).toMatchObject({ run: '9001', branch: 'feature/repeat-mode' });
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'CI started again' });
	});

	test('a run opens on the host', async () => {
		w.on('host_open', () => undefined);
		const el = await withRuns([run({})]);
		await click(find(el, '#host-pop .run [title="Open on GitHub"]'));
		expect(w.sent('host_open').at(-1)!.args.url).toBe('https://github.com/demo/harmony/actions/runs/9001');
	});

	test('"Look again" asks for the runs again', async () => {
		const el = await withRuns([run({})]);
		const before = w.sent('ci_runs').length;
		await click(named(el, '#host-pop .item', 'Look again'));
		expect(w.sent('ci_runs').length).toBe(before + 1);
	});

	test('a branch that is not on the remote has no checks to ask for', async () => {
		await status({ upstream: null });
		const before = w.sent('ci_runs').length;
		await mount('ms-toolbar');
		await settle();
		expect(w.sent('ci_runs').length).toBe(before);
	});
});

describe('right-clicking the repository', () => {
	test('the open one: copy, its pages, remove', async () => {
		const el = await mount('ms-toolbar');
		await rightClick(find(el, '#repo-pop button.seg')!);
		expect(menu(el)).toEqual(['Copy repo name', 'Copy repo path', 'View on GitHub', 'Open in terminal', 'Reveal in Finder', 'Remove…']);
		expect(find(el, '.ctx')!.hasAttribute('data-open')).toBe(true);
	});

	test('another one in the list can also be opened in a tab, and is viewed "in browser"', async () => {
		const el = await mount('ms-toolbar');
		await rightClick(row(el, 'repo-pop', 'cadence'));
		expect(menu(el)).toEqual(['Copy repo name', 'Copy repo path', 'Open in a new tab', 'View in browser', 'Open in terminal', 'Reveal in Finder', 'Remove…']);
		await click(named(el, '.ctx-item', 'Open in terminal'));
		expect(w.sent('open_in').at(-1)!.args).toMatchObject({ id: '/Users/demo/Source/cadence', target: 'terminal' });
	});

	test('a repository whose folder is gone can only be copied or removed', async () => {
		const app = repos.app()!;
		w.on('app_status', () => ({ ...app, repos: app.repos.map((r) => (r.name === 'cadence' ? { ...r, missing: true } : r)) }));
		await repos.switchContext();
		const el = await mount('ms-toolbar');
		await rightClick(row(el, 'repo-pop', 'cadence'));
		expect(menu(el)).toEqual(['Copy repo name', 'Copy repo path', 'Remove…']);
	});

	test('"Open in a new tab" opens it beside the current one', async () => {
		const el = await mount('ms-toolbar');
		await rightClick(row(el, 'repo-pop', 'cadence'));
		await click(named(el, '.ctx-item', 'Open in a new tab'));
		expect(repos.repoTabList().map((r) => r.name)).toEqual(['harmony', 'cadence']);
	});

	test('"Reveal" shows the folder in the file manager', async () => {
		const el = await mount('ms-toolbar');
		await rightClick(find(el, '#repo-pop button.seg')!);
		await click(named(el, '.ctx-item', 'Reveal in Finder'));
		expect(w.sent('open_in').at(-1)!.args).toMatchObject({ id: '/Users/demo/Source/harmony', target: 'finder' });
	});

	test('"Copy repo path" copies the path', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const el = await mount('ms-toolbar');
		await rightClick(find(el, '#repo-pop button.seg')!);
		await click(named(el, '.ctx-item', 'Copy repo path'));
		expect(writeText).toHaveBeenCalledWith('/Users/demo/Source/harmony');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Path copied' });
	});

	test('"Remove" asks first and closes the list it was opened over', async () => {
		const el = await mount('ms-toolbar');
		await toggle(el, 'repo-pop');
		await rightClick(row(el, 'repo-pop', 'cadence'));
		await click(named(el, '.ctx-item', 'Remove…'));
		expect(opened).toEqual(['remove-repo']);
		expect(repos.prompt().repo!.name).toBe('cadence');
		expect(isOpen(el, 'repo-pop')).toBe(false);
		expect(w.sent('repo_remove')).toEqual([]);
	});

	test('Esc closes the menu', async () => {
		const el = await mount('ms-toolbar');
		await rightClick(find(el, '#repo-pop button.seg')!);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		expect(menu(el)).toEqual([]);
		expect(find(el, '.ctx')!.hasAttribute('data-open')).toBe(false);
	});
});

describe('right-clicking a branch', () => {
	test('the checked-out branch: rename, copy, its page, delete', async () => {
		const el = await mount('ms-toolbar');
		await rightClick(find(el, '#branch-pop button.seg')!);
		expect(menu(el)).toEqual(['Rename…', 'Copy branch name', 'View branch on GitHub', 'Delete…']);
	});

	test('"View branch" opens it under its name on the remote', async () => {
		const el = await mount('ms-toolbar');
		await rightClick(find(el, '#branch-pop button.seg')!);
		await click(named(el, '.ctx-item', 'View branch on GitHub'));
		expect(w.sent('open_in').at(-1)!.args).toMatchObject({ target: 'branch', arg: 'feature/repeat-mode' });
	});

	test('a branch that is only local has no page on the host', async () => {
		const el = await mount('ms-toolbar');
		await rightClick(row(el, 'branch-pop', 'fix/seek-drift'));
		expect(menu(el)).toEqual(['Rename…', 'Copy branch name', 'Delete…']);
	});

	test('a remote branch cannot be renamed, and is deleted on the remote', async () => {
		const el = await mount('ms-toolbar');
		await rightClick(row(el, 'branch-pop', 'origin/release/1.4'));
		expect(menu(el)).toEqual(['Copy branch name', 'View branch on GitHub', 'Delete on the remote…']);
		await click(named(el, '.ctx-item', 'Delete on the remote…'));
		expect(opened).toEqual(['delete-branch']);
		expect(repos.prompt()).toEqual({ branch: 'origin/release/1.4', remote: true });
	});

	test('"Delete" asks first, about that branch', async () => {
		const el = await mount('ms-toolbar');
		await rightClick(row(el, 'branch-pop', 'fix/seek-drift'));
		await click(named(el, '.ctx-item', 'Delete…'));
		expect(opened).toEqual(['delete-branch']);
		expect(repos.prompt()).toEqual({ branch: 'fix/seek-drift' });
		expect(w.sent('branch_delete')).toEqual([]);
	});

	test('the only branch cannot be deleted', async () => {
		w.on('branches', () => [{ name: 'feature/repeat-mode', isRemote: false, isCurrent: true, upstream: null, published: null, date: new Date().toISOString() }]);
		await repos.loadBranches();
		const el = await mount('ms-toolbar');
		await rightClick(find(el, '#branch-pop button.seg')!);
		expect(menu(el)).toEqual(['Rename…', 'Copy branch name']);
	});

	test('a detached HEAD has no branch menu', async () => {
		await status({ detached: true });
		const el = await mount('ms-toolbar');
		await rightClick(find(el, '#branch-pop button.seg')!);
		expect(menu(el)).toEqual([]);
	});
});

describe('the buttons on the right', () => {
	test('Settings opens the settings dialog', async () => {
		const el = await mount('ms-toolbar');
		await click(find(el, 'button[title="Settings"]'));
		expect(opened).toEqual(['settings']);
	});

	test('the terminal button shows and hides the panel, and names Ctrl+` on every system', async () => {
		const el = await mount('ms-toolbar');
		const { terminals } = await import('../../services/terminal.store');
		const button = find(el, 'button[title^="Terminal"]')!;
		expect(button.title).toBe('Terminal (Ctrl+`)');
		expect(terminals().open()).toBe(false);
		await click(button);
		expect(terminals().open()).toBe(true);
		await click(button);
		expect(terminals().open()).toBe(false);
	});
});

describe('on other systems', () => {
	test.each([
		['Win32', 'Show in File Explorer'],
		['Linux x86_64', 'Show in file manager'],
	])('on %s the folder is shown with the system\'s own words', async (system, label) => {
		await start(system);
		const el = await mount('ms-toolbar');
		await rightClick(find(el, '#repo-pop button.seg')!);
		expect(menu(el)).toContain(label);
		expect(menu(el)).not.toContain('Reveal in Finder');
	});

	test('the terminal shortcut is still Ctrl+`', async () => {
		await start('Win32');
		const el = await mount('ms-toolbar');
		expect(find(el, 'button[title^="Terminal"]')!.title).toBe('Terminal (Ctrl+`)');
	});
});

describe('room for the traffic lights', () => {
	test('none in a browser, where there is no overlay title bar', async () => {
		const el = await mount('ms-toolbar');
		expect(find(el, '.bar')!.classList.contains('mac')).toBe(false);
	});
});
