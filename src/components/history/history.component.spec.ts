import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { Commit, RepoStatus } from '../../services/backend.service';

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
});

/** The History tab on screen, with its commits read. */
async function history(): Promise<HTMLElement> {
	repos.setTab('history');
	await settle();
	return mount('ms-history');
}

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

function summaries(el: Element): string[] {
	return all(el, '.commit .summary').map((s) => s.textContent ?? '');
}

function commit(el: Element, summary: string): HTMLElement {
	return all(el, '.commit').find((c) => find(c, '.summary')!.textContent === summary)!;
}

async function rightClick(target: Element): Promise<void> {
	target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 40, clientY: 60 }));
	await settle();
}

function menu(el: Element): string[] {
	return all(el, '.ctx .ctx-item').map((i) => words(i));
}

function compareBox(el: Element): HTMLInputElement {
	return find<HTMLInputElement>(el, '.compare input')!;
}

/** Focus in the compare box, which swaps the commits for the branches to pick from. */
async function pick(el: Element): Promise<void> {
	compareBox(el).dispatchEvent(new FocusEvent('focus'));
	await settle();
}

async function key(target: EventTarget, name: string): Promise<void> {
	target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, composed: true, cancelable: true }));
	await settle();
}

/** The comparison with `branch`, picked from the list. */
async function compare(el: Element, branch: string): Promise<void> {
	await pick(el);
	await click(all(el, '.branch').find((b) => find(b, '.name')!.textContent === branch)!);
}

describe('the list', () => {
	test('a spinner until the commits are read', async () => {
		const el = await mount('ms-history');
		expect(find(el, 'ml-spinner')).not.toBeNull();
		expect(all(el, '.commit')).toEqual([]);
	});

	test('the commits, newest first, with who made them', async () => {
		const el = await history();
		expect(summaries(el)).toEqual([
			'Wrap the queue when repeat is on',
			'Add a repeat toggle to the transport bar',
			'Fix seek drift after a long pause',
			'Persist volume between sessions',
			'Queue: keyboard reordering',
			'Initial commit',
		]);
		expect(words(commit(el, 'Initial commit'))).toContain('Demo Author ·');
	});

	test('a commit that is not pushed yet is marked, a pushed one is not', async () => {
		const el = await history();
		expect(find(commit(el, 'Wrap the queue when repeat is on'), '[title="Not pushed yet"]')).not.toBeNull();
		expect(find(commit(el, 'Initial commit'), '[title="Not pushed yet"]')).toBeNull();
	});

	test('a tag shows on its commit', async () => {
		const el = await history();
		expect(all(el, '.commit ml-badge').map((b) => [b.textContent, find(b.closest('.commit')!, '.summary')!.textContent])).toEqual([['v1.3.0', 'Persist volume between sessions']]);
	});

	test('the newest commit is selected to begin with', async () => {
		const el = await history();
		expect(all(el, '.commit.sel').map((c) => find(c, '.summary')!.textContent)).toEqual(['Wrap the queue when repeat is on']);
	});

	test('clicking a commit selects it and reads its files', async () => {
		const el = await history();
		const hash = repos.commits()[2].hash;
		await click(commit(el, 'Fix seek drift after a long pause'));
		expect(repos.selectedHash()).toBe(hash);
		expect(w.sent('commit_files').at(-1)!.args.hash).toBe(hash);
		expect(all(el, '.commit.sel').map((c) => find(c, '.summary')!.textContent)).toEqual(['Fix seek drift after a long pause']);
	});

	test('a repository without commits says so', async () => {
		w.on('history', () => []);
		const el = await history();
		expect(words(el)).toBe('No commits yet.');
	});

	test('"Load more" only while there may be more, and it asks for the next page', async () => {
		const el = await history();
		expect(find(el, '.more')).toBeNull();

		const page = (from: number): Commit[] => Array.from({ length: 100 }, (_, i) => ({ ...repos.commits()[0], hash: `${from + i}`.padStart(40, '0'), summary: `Commit ${from + i}` }));
		w.on('history', (args) => (args.skip === 0 ? page(0) : page(100).slice(0, 5)));
		await repos.loadHistory(true);
		await settle();
		expect(all(el, '.commit').length).toBe(100);
		await click(find(find(el, '.more ml-button')!, 'button'));
		expect(w.sent('history').at(-1)!.args).toMatchObject({ skip: 100, limit: 100 });
		expect(all(el, '.commit').length).toBe(105);
		expect(find(el, '.more')).toBeNull();
	});
});

describe('one file\'s history', () => {
	test('names the file, and its cross goes back to every commit', async () => {
		const el = await history();
		await repos.showFileHistory('src/player/queue.ts');
		await settle();
		expect(w.sent('history').at(-1)!.args.path).toBe('src/player/queue.ts');
		expect(find(el, '.chosen .name')!.textContent).toBe('src/player/queue.ts');
		expect(summaries(el).length).toBe(2);

		await click(find(el, '[title="Show every commit"]'));
		expect(repos.historyPath()).toBeNull();
		expect(w.sent('history').at(-1)!.args.path).toBeNull();
		expect(summaries(el).length).toBe(6);
	});

	test('a file no commit touched says so, and can still be left', async () => {
		const el = await history();
		w.on('history', (args) => (args.path ? [] : repos.commits()));
		await repos.showFileHistory('src/new.ts');
		await settle();
		expect(words(el)).toContain('No commits touched this file yet.');
		expect(find(el, '[title="Show every commit"]')).not.toBeNull();
	});
});

describe('the right-click menu', () => {
	test('a pushed commit of this branch', async () => {
		const el = await history();
		await rightClick(commit(el, 'Fix seek drift after a long pause'));
		expect(menu(el)).toEqual([
			'Revert changes in commit',
			'Edit commit message…',
			'Squash, reorder or drop from here…',
			'Create branch from commit…',
			'Create tag…',
			'Checkout commit',
			'Reset branch to this commit…',
			'View on GitHub',
			'Copy SHA',
		]);
	});

	test('a commit that is not pushed has no page on the host', async () => {
		const el = await history();
		await rightClick(commit(el, 'Wrap the queue when repeat is on'));
		expect(menu(el)).not.toContain('View on GitHub');
	});

	test('a host we do not know has no "View on"', async () => {
		await status({ host: { ...repos.status()!.host!, provider: 'other', name: 'git.example.com' } });
		const el = await history();
		await rightClick(commit(el, 'Initial commit'));
		expect(menu(el).some((m) => m.startsWith('View on'))).toBe(false);
	});

	test('right-clicking a commit selects it', async () => {
		const el = await history();
		await rightClick(commit(el, 'Queue: keyboard reordering'));
		expect(repos.selectedCommit()!.summary).toBe('Queue: keyboard reordering');
	});

	test('a tagged commit can have its tag deleted', async () => {
		const el = await history();
		await rightClick(commit(el, 'Persist volume between sessions'));
		expect(menu(el)).toContain('Delete tag v1.3.0');
		await click(named(el, '.ctx-item', 'Delete tag v1.3.0'));
		expect(w.sent('tag_delete').at(-1)!.args.name).toBe('v1.3.0');
	});

	test('Revert makes the reverting commit', async () => {
		const el = await history();
		const hash = repos.commits()[1].hash;
		await rightClick(commit(el, 'Add a repeat toggle to the transport bar'));
		await click(named(el, '.ctx-item', 'Revert changes in commit'));
		expect(w.sent('revert_commit').at(-1)!.args.hash).toBe(hash);
		expect(summaries(el)[0]).toBe('Revert "Add a repeat toggle to the transport bar"');
	});

	test('Checkout commit checks that commit out', async () => {
		const el = await history();
		const hash = repos.commits()[3].hash;
		await rightClick(commit(el, 'Persist volume between sessions'));
		await click(named(el, '.ctx-item', 'Checkout commit'));
		expect(w.sent('checkout_commit').at(-1)!.args.hash).toBe(hash);
	});

	test('View on the host opens the commit\'s page', async () => {
		const el = await history();
		const hash = repos.commits()[2].hash;
		await rightClick(commit(el, 'Fix seek drift after a long pause'));
		await click(named(el, '.ctx-item', 'View on GitHub'));
		expect(w.sent('open_in').at(-1)!.args).toMatchObject({ target: 'commit', arg: hash });
	});

	test('Copy SHA puts the whole hash on the clipboard', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const el = await history();
		await rightClick(commit(el, 'Initial commit'));
		await click(named(el, '.ctx-item', 'Copy SHA'));
		expect(writeText).toHaveBeenCalledWith(repos.commits().at(-1)!.hash);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'SHA copied' });
	});

	test.each([
		['Create branch from commit…', 'new-branch'],
		['Create tag…', 'new-tag'],
		['Reset branch to this commit…', 'reset'],
	])('"%s" opens its dialog about that commit', async (label, dialog) => {
		const el = await history();
		await rightClick(commit(el, 'Queue: keyboard reordering'));
		await click(named(el, '.ctx-item', label));
		expect(opened).toEqual([dialog]);
		expect(repos.prompt().commit!.summary).toBe('Queue: keyboard reordering');
	});

	test('"Edit commit message" opens the interactive rebase from the commit\'s parent, with it set to reword', async () => {
		const parent = 'p'.repeat(40);
		const el = await history();
		const commits = repos.commits();
		w.on('history', () => [{ ...commits[0], parents: [parent] }, ...commits.slice(1)]);
		await repos.loadHistory(true);
		await settle();
		const tip = repos.commits()[0];
		await rightClick(commit(el, tip.summary));
		await click(named(el, '.ctx-item', 'Edit commit message…'));
		expect(opened).toEqual(['rebase-interactive']);
		expect(repos.prompt()).toMatchObject({ upstream: parent, hashes: [tip.hash] });
	});

	test('"Squash, reorder or drop" opens the same dialog with nothing preset; the first commit rebases the whole branch', async () => {
		const el = await history();
		await rightClick(commit(el, 'Initial commit'));
		await click(named(el, '.ctx-item', 'Squash, reorder or drop from here…'));
		expect(opened).toEqual(['rebase-interactive']);
		expect(repos.prompt().upstream).toBeNull();
		expect(repos.prompt().hashes).toBeUndefined();
	});

	test('history is not rewritten in the middle of a merge', async () => {
		await status({ operation: 'merge', mergeInProgress: true });
		const el = await history();
		await rightClick(commit(el, 'Initial commit'));
		await click(named(el, '.ctx-item', 'Edit commit message…'));
		await rightClick(commit(el, 'Initial commit'));
		await click(named(el, '.ctx-item', 'Squash, reorder or drop from here…'));
		expect(opened).toEqual([]);
	});

	test('a click anywhere else closes it', async () => {
		const el = await history();
		await rightClick(commit(el, 'Initial commit'));
		expect(find(el, '.ctx')).not.toBeNull();
		window.dispatchEvent(new MouseEvent('click'));
		await settle();
		expect(find(el, '.ctx')).toBeNull();
	});
});

describe('picking a branch to compare with', () => {
	test('the box lists the default branch first, then the others', async () => {
		const el = await history();
		await pick(el);
		expect(all(el, '.list > *').map((n) => (n.classList.contains('group') ? `[${n.textContent}]` : find(n, '.name')!.textContent))).toEqual(['[Default branch]', 'main', '[Other branches]', 'fix/seek-drift', 'origin/release/1.4']);
		expect(all(el, '.commit')).toEqual([]);
	});

	test('the current branch, its upstream and remote copies of local branches are left out', async () => {
		const el = await history();
		await pick(el);
		const names = all(el, '.branch .name').map((n) => n.textContent);
		expect(names).not.toContain('feature/repeat-mode');
		expect(names).not.toContain('origin/feature/repeat-mode');
		expect(names).not.toContain('origin/main');
	});

	test('each branch says how far behind and ahead of it this one is', async () => {
		const el = await history();
		await pick(el);
		expect(w.sent('compare_counts').at(-1)!.args.branches).toEqual(['main', 'fix/seek-drift', 'origin/release/1.4']);
		expect(all(el, '.branch').map((b) => find(b, '.counts')!.title)).toEqual(['2 behind, 1 ahead', '1 behind, 1 ahead', '3 behind, 1 ahead']);
	});

	test('typing narrows the list', async () => {
		const el = await history();
		await pick(el);
		compareBox(el).value = 'SEEK';
		compareBox(el).dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(all(el, '.branch .name').map((n) => n.textContent)).toEqual(['fix/seek-drift']);
		expect(words(find(el, '.group')!)).toBe('Branches');
	});

	test('nothing matching says so', async () => {
		const el = await history();
		await pick(el);
		compareBox(el).value = 'zzz';
		compareBox(el).dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(words(find(el, '.none')!)).toBe('No branches match.');
	});

	test('a repository with one branch has nothing to compare with', async () => {
		w.on('branches', () => [{ name: 'main', isRemote: false, isCurrent: true, upstream: null, published: null, date: new Date().toISOString() }]);
		await repos.loadBranches();
		const el = await history();
		await pick(el);
		expect(words(find(el, '.none')!)).toBe('There is no other branch to compare with.');
	});

	test('Enter takes the first branch', async () => {
		const el = await history();
		await pick(el);
		await key(compareBox(el), 'Enter');
		expect(repos.compareBranch()).toBe('main');
	});

	test('the arrow keys move down the list and Enter takes that branch', async () => {
		const el = await history();
		await pick(el);
		await key(compareBox(el), 'ArrowDown');
		await key(compareBox(el), 'ArrowDown');
		await key(compareBox(el), 'ArrowDown');
		await key(compareBox(el), 'ArrowUp');
		await key(compareBox(el), 'Enter');
		expect(repos.compareBranch()).toBe('fix/seek-drift');
	});

	// A bug until 2026-11-23 (history.component.ts, onKey): the arrow keys set `_hl`, which Melodic does not watch (a name
	// starting with `_`), and `picking = true`, which it already is while the list shows, so nothing renders again.
	// What holds now: the highlight moves to the second branch. Before the fix: it stays on the first, while Enter takes the second.
	test('the arrow keys move the highlight a person sees', async () => {
		const el = await history();
		await pick(el);
		expect(find(el, '.branch.hl .name')!.textContent).toBe('main');
		await key(compareBox(el), 'ArrowDown');
		expect(find(el, '.branch.hl .name')!.textContent).toBe('fix/seek-drift');
	});

	test('leaving the box brings the commits back', async () => {
		const el = await history();
		await pick(el);
		compareBox(el).dispatchEvent(new FocusEvent('blur'));
		await settle();
		expect(all(el, '.branch')).toEqual([]);
		expect(all(el, '.commit').length).toBe(6);
	});
});

describe('comparing with a branch', () => {
	test('shows what the other branch has, and how many each way', async () => {
		const el = await history();
		await compare(el, 'main');
		expect(w.sent('compare_history').at(-1)!.args).toMatchObject({ branch: 'main', ahead: false });
		expect(find(el, '.chosen .name')!.textContent).toBe('main');
		expect(all(el, '.sides button').map((b) => [b.textContent, b.classList.contains('on')])).toEqual([['Behind (2)', true], ['Ahead (1)', false]]);
		expect(summaries(el)).toEqual(['Bump dependencies on main', 'Tidy the settings page']);
	});

	test('Ahead lists what only this branch has, and offers no merge', async () => {
		const el = await history();
		await compare(el, 'main');
		await click(all(el, '.sides button')[1]);
		expect(w.sent('compare_history').at(-1)!.args).toMatchObject({ branch: 'main', ahead: true });
		expect(summaries(el)).toEqual(['Wrap the queue when repeat is on']);
		expect(find(el, '.merge')).toBeNull();
	});

	test('the merge button says where the commits go, and merges', async () => {
		const el = await history();
		await compare(el, 'main');
		const button = find(el, '.merge ml-button')!;
		expect(words(button)).toBe('Merge into feature/repeat-mode');
		expect(words(find(el, '.merge small')!)).toBe('Brings 2 commits from main into feature/repeat-mode.');
		await click(find(button, 'button'));
		expect(w.sent('merge_branch').at(-1)!.args.from).toBe('main');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Merged main' });
		// Nothing is left to bring in, so there is nothing to merge.
		expect(find(el, '.merge')).toBeNull();
		expect(words(find(el, '.none')!)).toBe('feature/repeat-mode already has every commit on main.');
	});

	test.each([
		['Squash and merge…', 'merge-branch', { branch: 'main', squash: true }],
		['Cherry-pick…', 'cherry-pick', { branch: 'main' }],
		['Rebase…', 'merge-branch', { branch: 'main', rebase: true }],
	])('"%s" opens its dialog for that branch', async (label, dialog, prompt) => {
		const el = await history();
		await compare(el, 'main');
		await click(named(el, '.ways a', label));
		expect(opened).toEqual([dialog]);
		expect(repos.prompt()).toEqual(prompt);
		expect(w.sent('merge_branch')).toEqual([]);
	});

	test('on a detached HEAD there is nothing to merge into', async () => {
		await status({ detached: true });
		const el = await history();
		await compare(el, 'main');
		expect(find<HTMLButtonElement>(find(el, '.merge ml-button')!, 'button')!.disabled).toBe(true);
		expect(words(find(el, '.merge small')!)).toBe('Check out a branch to merge into it.');
		expect(find(el, '.ways')).toBeNull();
	});

	test('a commit of the other branch can be cherry-picked, not reverted or reset to', async () => {
		const el = await history();
		await compare(el, 'main');
		const hash = repos.compareCommits()[1].hash;
		await rightClick(commit(el, 'Tidy the settings page'));
		expect(menu(el)).toEqual(['Cherry-pick onto feature/repeat-mode', 'Cherry-pick several…', 'Create branch from commit…', 'Create tag…', 'Checkout commit', 'View on GitHub', 'Copy SHA']);
		await click(named(el, '.ctx-item', 'Cherry-pick onto feature/repeat-mode'));
		expect(w.sent('cherry_pick').at(-1)!.args.hashes).toEqual([hash]);
	});

	test('"Cherry-pick several" opens the dialog with that commit ticked', async () => {
		const el = await history();
		await compare(el, 'main');
		const hash = repos.compareCommits()[0].hash;
		await rightClick(commit(el, 'Bump dependencies on main'));
		await click(named(el, '.ctx-item', 'Cherry-pick several…'));
		expect(opened).toEqual(['cherry-pick']);
		expect(repos.prompt()).toEqual({ branch: 'main', hashes: [hash] });
	});

	test('nothing is cherry-picked in the middle of another operation', async () => {
		await status({ operation: 'rebase', rebaseInProgress: true });
		const el = await history();
		await compare(el, 'main');
		await rightClick(commit(el, 'Tidy the settings page'));
		await click(named(el, '.ctx-item', 'Cherry-pick onto feature/repeat-mode'));
		expect(w.sent('cherry_pick')).toEqual([]);
	});

	test('on the Ahead side the commits are this branch\'s own again', async () => {
		const el = await history();
		await compare(el, 'main');
		await click(all(el, '.sides button')[1]);
		await rightClick(commit(el, 'Wrap the queue when repeat is on'));
		expect(menu(el)).toContain('Revert changes in commit');
		expect(menu(el)).not.toContain('Cherry-pick several…');
	});

	test('the cross stops comparing', async () => {
		const el = await history();
		await compare(el, 'main');
		await click(find(el, '[title="Stop comparing (Esc)"]'));
		expect(repos.compareBranch()).toBeNull();
		expect(summaries(el).length).toBe(6);
	});

	test('Esc stops comparing', async () => {
		const el = await history();
		await compare(el, 'main');
		await key(window, 'Escape');
		expect(repos.compareBranch()).toBeNull();
	});

	test('Esc typed in a field elsewhere does not', async () => {
		const el = await history();
		await compare(el, 'main');
		const field = document.createElement('input');
		document.body.append(field);
		await key(field, 'Escape');
		expect(repos.compareBranch()).toBe('main');
	});

	test('Esc while the menu is open leaves the comparison', async () => {
		const el = await history();
		await compare(el, 'main');
		await rightClick(commit(el, 'Tidy the settings page'));
		await key(window, 'Escape');
		expect(repos.compareBranch()).toBe('main');
	});
});
