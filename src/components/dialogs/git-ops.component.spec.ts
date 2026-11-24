import { beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { DialogName, Prompt, RepoStore } from '../../services/repo.store';
import type { Commit, RepoStatus } from '../../services/backend.service';

// Monaco and xterm cannot run in happy-dom; nothing here needs either to arrive.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

let w: World;
let repos: RepoStore;
/** The demo's commits, newest first. */
let commits: Commit[];

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
	await repos.init();
	await repos.loadHistory(true);
	commits = repos.commits();
	await mount('ms-git-ops');
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

async function type(target: Element, text: string): Promise<void> {
	const input = find<HTMLInputElement>(target, 'input, textarea')!;
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
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

/** Ticks a plain checkbox of the cherry-pick list. */
async function check(input: HTMLInputElement, on: boolean): Promise<void> {
	input.checked = on;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

describe('bring in a branch', () => {
	function mode(d: Element): string {
		return all(d, '.mode')
			.filter((m) => m.getAttribute('aria-checked') === 'true')
			.map((m) => find(m, 'b')!.textContent)
			.join();
	}

	test('names the branch and counts what it brings', async () => {
		const d = await ask('merge-branch', { branch: 'main' });
		expect(words(find(d, 'h3')!)).toBe('Bring in main');
		expect(w.sent('compare_history').at(-1)!.args).toMatchObject({ branch: 'main', ahead: false });
		expect(words(find(d, '.dlg p')!)).toBe('main has 2 commits that feature/repeat-mode does not.');
	});

	test('a branch with nothing new says so', async () => {
		const d = await ask('merge-branch', { branch: 'origin/feature/repeat-mode' });
		expect(words(find(d, '.dlg p')!)).toBe('feature/repeat-mode already has every commit on origin/feature/repeat-mode .');
	});

	test('opens on Merge, or on the way it was asked for', async () => {
		const d = await ask('merge-branch', { branch: 'main' });
		expect(mode(d)).toBe('Merge');
		await press(d, 'Cancel');
		await ask('merge-branch', { branch: 'main', squash: true });
		expect(mode(d)).toBe('Squash and merge');
		await press(d, 'Cancel');
		await ask('merge-branch', { branch: 'main', rebase: true });
		expect(mode(d)).toBe('Rebase');
	});

	test('Merge merges the branch and closes', async () => {
		const d = await ask('merge-branch', { branch: 'main' });
		await press(d, 'Merge');
		expect(w.sent('merge_branch').at(-1)!.args.from).toBe('main');
		expect(isOpen('merge-branch')).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Merged main' });
	});

	test('uncommitted changes are warned about; a clean tree is not', async () => {
		const d = await ask('merge-branch', { branch: 'main' });
		expect(words(find(d, '.warn')!)).toBe('You have uncommitted changes. Git may refuse until they are committed or stashed.');
		await press(d, 'Cancel');
		await status({ files: [] });
		await ask('merge-branch', { branch: 'main' });
		expect(find(d, '.warn')).toBeNull();
	});

	test('on a detached HEAD nothing can be merged', async () => {
		await status({ detached: true });
		const d = await ask('merge-branch', { branch: 'main' });
		expect(isOff(d, 'Merge')).toBe(true);
	});

	test('"Cherry-pick them" leaves this dialog for the cherry-pick one, with the same branch', async () => {
		const d = await ask('merge-branch', { branch: 'main' });
		await click(all(d, '.note a').find((a) => words(a).includes('Cherry-pick them'))!);
		expect(isOpen('merge-branch')).toBe(false);
		expect(isOpen('cherry-pick')).toBe(true);
		expect(repos.prompt()).toEqual({ branch: 'main' });
		expect(w.sent('merge_branch')).toEqual([]);
	});
});

describe('squash and merge', () => {
	async function squash(): Promise<HTMLElement> {
		const d = await ask('merge-branch', { branch: 'main' });
		await click(all(d, '.mode')[1]);
		return d;
	}

	test('offers a message: a summary, and the commits it folds, oldest first', async () => {
		const d = await squash();
		expect(find<HTMLInputElement>(field(d, 'Commit message'), 'input')!.value).toBe('Squash merge main into feature/repeat-mode');
		expect(find<HTMLTextAreaElement>(find(d, '.squash-msg ml-textarea')!, 'textarea')!.value).toBe('* Tidy the settings page\n* Bump dependencies on main');
	});

	test('makes one commit with that message', async () => {
		const d = await squash();
		await type(field(d, 'Commit message'), 'Bring main up to date');
		await press(d, 'Squash and merge');
		expect(w.sent('merge_squash').at(-1)!.args).toMatchObject({ from: 'main', message: 'Bring main up to date\n\n* Tidy the settings page\n* Bump dependencies on main' });
		expect(w.sent('merge_branch')).toEqual([]);
		expect(isOpen('merge-branch')).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Squashed main into one commit' });
	});

	test('with the description cleared the message is the summary alone', async () => {
		const d = await squash();
		await type(find(d, '.squash-msg ml-textarea')!, '  ');
		await press(d, 'Squash and merge');
		expect(w.sent('merge_squash').at(-1)!.args.message).toBe('Squash merge main into feature/repeat-mode');
	});

	test('needs a summary', async () => {
		const d = await squash();
		await type(field(d, 'Commit message'), '   ');
		expect(isOff(d, 'Squash and merge')).toBe(true);
		await press(d, 'Squash and merge');
		expect(w.sent('merge_squash')).toEqual([]);
	});

	test('is off when the branch brings nothing', async () => {
		const d = await ask('merge-branch', { branch: 'origin/feature/repeat-mode', squash: true });
		expect(isOff(d, 'Squash and merge')).toBe(true);
	});

	test('on conflicts the message waits in the commit form, on the Changes tab', async () => {
		w.on('merge_squash', () => {
			throw appError('conflict', 'CONFLICT (content): Merge conflict in src/player/queue.ts', ['src/player/queue.ts']);
		});
		repos.setTab('history');
		const d = await squash();
		await type(field(d, 'Commit message'), 'Bring main up to date');
		await press(d, 'Squash and merge');
		expect(repos.summary()).toBe('Bring main up to date');
		expect(repos.description()).toBe('* Tidy the settings page\n* Bump dependencies on main');
		expect(repos.tab()).toBe('changes');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'warning', title: 'Merge conflicts' });
	});
});

describe('rebase onto a branch', () => {
	test('says a pushed branch will need a force push, and rebases', async () => {
		const d = await ask('merge-branch', { branch: 'main', rebase: true });
		expect(words(d)).toContain('A branch that is already pushed will need a force push afterwards.');
		await press(d, 'Rebase');
		expect(w.sent('rebase_onto').at(-1)!.args.onto).toBe('main');
		expect(w.sent('push')).toEqual([]);
		expect(isOpen('merge-branch')).toBe(false);
	});

	test('"Choose, reorder or squash the commits first" goes to the editor, onto the same branch', async () => {
		const d = await ask('merge-branch', { branch: 'main', rebase: true });
		await click(all(d, '.note a').find((a) => words(a).startsWith('Choose, reorder or squash'))!);
		expect(isOpen('merge-branch')).toBe(false);
		expect(isOpen('rebase-interactive')).toBe(true);
		expect(repos.prompt()).toEqual({ branch: 'main', upstream: 'main' });
		expect(w.sent('rebase_onto')).toEqual([]);
	});
});

describe('cherry-pick', () => {
	function list(d: Element): string[] {
		return all(d, '.pickrow:not(.head) .sum').map((s) => s.textContent ?? '');
	}

	function boxes(d: Element): HTMLInputElement[] {
		return all<HTMLInputElement>(d, '.pickrow:not(.head) input');
	}

	test('lists what the branch has, newest first, with nothing ticked', async () => {
		const d = await ask('cherry-pick', { branch: 'origin/release/1.4' });
		expect(words(find(d, 'h3')!)).toBe('Cherry-pick from origin/release/1.4');
		expect(list(d)).toEqual(['Bump dependencies on origin/release/1.4', 'Tidy the settings page', 'Release notes']);
		expect(boxes(d).some((b) => b.checked)).toBe(false);
		expect(isOff(d, 'Cherry-pick')).toBe(true);
	});

	test('the ticked commits are copied oldest first, in one go', async () => {
		const d = await ask('cherry-pick', { branch: 'origin/release/1.4' });
		const incoming = await repos.incoming('origin/release/1.4');
		await check(boxes(d)[0], true);
		await check(boxes(d)[2], true);
		await press(d, 'Cherry-pick 2 commits');
		expect(w.sent('cherry_pick').length).toBe(1);
		expect(w.sent('cherry_pick')[0].args.hashes).toEqual([incoming[2].hash, incoming[0].hash]);
		expect(isOpen('cherry-pick')).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Cherry-picked 2 commits' });
	});

	test('the box at the top ticks them all, and they still go oldest first', async () => {
		const d = await ask('cherry-pick', { branch: 'origin/release/1.4' });
		const incoming = await repos.incoming('origin/release/1.4');
		await check(find<HTMLInputElement>(d, '.pickrow.head input')!, true);
		expect(boxes(d).every((b) => b.checked)).toBe(true);
		await press(d, 'Cherry-pick 3 commits');
		expect(w.sent('cherry_pick')[0].args.hashes).toEqual([...incoming].reverse().map((c) => c.hash));
	});

	test('unticking one takes it out', async () => {
		const d = await ask('cherry-pick', { branch: 'origin/release/1.4' });
		const incoming = await repos.incoming('origin/release/1.4');
		await check(find<HTMLInputElement>(d, '.pickrow.head input')!, true);
		await check(boxes(d)[1], false);
		await press(d, 'Cherry-pick 2 commits');
		expect(w.sent('cherry_pick')[0].args.hashes).toEqual([incoming[2].hash, incoming[0].hash]);
	});

	test('a commit it was opened for starts ticked', async () => {
		const incoming = await repos.incoming('main');
		const d = await ask('cherry-pick', { branch: 'main', hashes: [incoming[1].hash] });
		expect(boxes(d).map((b) => b.checked)).toEqual([false, true]);
		expect(button(d, 'Cherry-pick 1 commit')).toBeDefined();
	});

	test('one commit is said as one', async () => {
		const incoming = await repos.incoming('main');
		const d = await ask('cherry-pick', { branch: 'main', hashes: [incoming[0].hash] });
		await press(d, 'Cherry-pick 1 commit');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Commit cherry-picked' });
	});

	test('a branch with nothing new has nothing to pick', async () => {
		const d = await ask('cherry-pick', { branch: 'origin/feature/repeat-mode' });
		expect(words(find(d, '.note')!)).toBe('feature/repeat-mode already has every commit on origin/feature/repeat-mode.');
		expect(isOff(d, 'Cherry-pick')).toBe(true);
	});

	test('on a detached HEAD nothing can be picked', async () => {
		await status({ detached: true });
		const incoming = await repos.incoming('main');
		const d = await ask('cherry-pick', { branch: 'main', hashes: [incoming[0].hash] });
		expect(isOff(d, 'Cherry-pick 1 commit')).toBe(true);
	});
});

describe('rewrite history', () => {
	/** The editor on the four newest commits: three of them pushed, the newest not. */
	async function editor(prompt: Prompt = {}): Promise<HTMLElement> {
		return ask('rebase-interactive', { upstream: commits[4].hash, commit: commits[3], ...prompt });
	}

	function rows(d: Element): HTMLElement[] {
		return all(d, '.rebase .row');
	}

	function order(d: Element): string[] {
		return rows(d).map((r) => find(r, '.sum')!.textContent ?? '');
	}

	function actions(d: Element): string[] {
		return rows(d).map((r) => words(find(find(r, 'ml-select')!, '.ml-select__value')!));
	}

	async function act(d: Element, at: number, action: string): Promise<void> {
		await choose(find(rows(d)[at], 'ml-select')!, action);
	}

	function problems(d: Element): string[] {
		return all(d, '.warn').map((p) => words(p));
	}

	const SUMMARIES = ['Persist volume between sessions', 'Fix seek drift after a long pause', 'Add a repeat toggle to the transport bar', 'Wrap the queue when repeat is on'];

	test('lists the commits after the starting point, oldest at the top, each one picked', async () => {
		const d = await editor();
		expect(w.sent('rebase_plan').at(-1)!.args.upstream).toBe(commits[4].hash);
		expect(words(find(d, 'h3')!)).toBe('Rewrite history');
		expect(order(d)).toEqual(SUMMARIES);
		expect(actions(d)).toEqual(['Pick', 'Pick', 'Pick', 'Pick']);
		expect(all(d, '.msg')).toEqual([]);
	});

	test('with nothing changed there is nothing to rewrite', async () => {
		const d = await editor();
		expect(isOff(d, 'Rewrite history')).toBe(true);
		await press(d, 'Rewrite history');
		expect(w.sent('rebase_interactive')).toEqual([]);
	});

	test('commits already pushed are marked, and the force push they mean is said', async () => {
		const d = await editor();
		expect(rows(d).map((r) => !!find(r, '[title="Already pushed"]'))).toEqual([true, true, true, false]);
		expect(problems(d)).toEqual(['3 commits here are already pushed. Rewriting them means a force push, and anyone who built on them has to recover.']);
	});

	test('one pushed commit is said as one; none, not at all', async () => {
		const d = await ask('rebase-interactive', { upstream: commits[2].hash });
		expect(problems(d)).toEqual(['1 commit here is already pushed. Rewriting it means a force push, and anyone who built on it has to recover.']);
		await press(d, 'Cancel');
		await ask('rebase-interactive', { upstream: commits[1].hash });
		expect(order(d)).toEqual(['Wrap the queue when repeat is on']);
		expect(problems(d)).toEqual([]);
	});

	test('"Edit commit message" opens with that commit set to reword, its whole message in a box', async () => {
		const d = await editor({ hashes: [commits[0].hash] });
		expect(actions(d)).toEqual(['Pick', 'Pick', 'Pick', 'Reword']);
		expect(all(d, '.msg ml-textarea').map((t) => find<HTMLTextAreaElement>(t, 'textarea')!.value)).toEqual(['Wrap the queue when repeat is on\n\nThe cursor resets instead of running off the end.']);
		expect(isOff(d, 'Rewrite history')).toBe(false);
	});

	test('a reworded commit is sent with its new message, the others as they are', async () => {
		const d = await editor({ hashes: [commits[0].hash] });
		await type(find(d, '.msg ml-textarea')!, 'Wrap the queue on repeat');
		await press(d, 'Rewrite history');
		const sent = w.sent('rebase_interactive').at(-1)!.args;
		expect(sent.upstream).toBe(commits[4].hash);
		expect(sent.steps).toEqual([
			{ hash: commits[3].hash, action: 'pick', message: null },
			{ hash: commits[2].hash, action: 'pick', message: null },
			{ hash: commits[1].hash, action: 'pick', message: null },
			{ hash: commits[0].hash, action: 'reword', message: 'Wrap the queue on repeat' },
		]);
		expect(isOpen('rebase-interactive')).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'History rewritten' });
	});

	test('a reworded commit needs a message', async () => {
		const d = await editor({ hashes: [commits[0].hash] });
		await type(find(d, '.msg ml-textarea')!, '  ');
		expect(problems(d)).toContain('Every reworded or squashed commit needs a message.');
		expect(isOff(d, 'Rewrite history')).toBe(true);
	});

	test.each(['Squash', 'Fixup'])('the first kept commit cannot be set to %s', async (action) => {
		const d = await editor();
		await act(d, 0, action);
		expect(problems(d)).toContain(`The first kept commit (${commits[3].shortHash}) cannot be squashed or fixed up: there is nothing above it to fold into.`);
		expect(isOff(d, 'Rewrite history')).toBe(true);
		await press(d, 'Rewrite history');
		expect(w.sent('rebase_interactive')).toEqual([]);
	});

	test('with the first one dropped, the next is the first kept one', async () => {
		const d = await editor();
		await act(d, 0, 'Drop');
		expect(isOff(d, 'Rewrite history')).toBe(false);
		await act(d, 1, 'Squash');
		expect(problems(d)).toContain(`The first kept commit (${commits[2].shortHash}) cannot be squashed or fixed up: there is nothing above it to fold into.`);
		expect(isOff(d, 'Rewrite history')).toBe(true);
	});

	test('a squash says what it folds into, and the commit above gets both messages to edit', async () => {
		const d = await editor();
		await act(d, 3, 'Squash');
		expect(words(find(rows(d)[3], '.into')!)).toBe(`into ${commits[1].shortHash}`);
		const box = find<HTMLTextAreaElement>(find(d, '.msg ml-textarea')!, 'textarea')!;
		expect(box.value).toBe('Add a repeat toggle to the transport bar\n\nWrap the queue when repeat is on\n\nThe cursor resets instead of running off the end.');
		expect(find(d, '.msg')!.previousElementSibling).toBe(rows(d)[2]);

		await press(d, 'Rewrite history');
		expect(w.sent('rebase_interactive').at(-1)!.args.steps).toEqual([
			{ hash: commits[3].hash, action: 'pick', message: null },
			{ hash: commits[2].hash, action: 'pick', message: null },
			{ hash: commits[1].hash, action: 'pick', message: box.value },
			{ hash: commits[0].hash, action: 'squash', message: null },
		]);
	});

	test('a fixup folds in without a message to edit', async () => {
		const d = await editor();
		await act(d, 3, 'Fixup');
		expect(words(find(rows(d)[3], '.into')!)).toBe(`into ${commits[1].shortHash}`);
		expect(all(d, '.msg')).toEqual([]);
		await press(d, 'Rewrite history');
		expect((w.sent('rebase_interactive').at(-1)!.args.steps as { action: string; message: string | null }[]).map((s) => [s.action, s.message])).toEqual([['pick', null], ['pick', null], ['pick', null], ['fixup', null]]);
	});

	test('a squash folds into the nearest kept commit above, past a dropped one', async () => {
		const d = await editor();
		await act(d, 2, 'Drop');
		await act(d, 3, 'Squash');
		expect(words(find(rows(d)[3], '.into')!)).toBe(`into ${commits[2].shortHash}`);
		expect(find(d, '.msg')!.previousElementSibling).toBe(rows(d)[1]);
	});

	test('the arrows move a commit; the ends cannot move further', async () => {
		const d = await editor();
		expect(find<HTMLButtonElement>(rows(d)[0], '[title="Move up"]')!.disabled).toBe(true);
		expect(find<HTMLButtonElement>(rows(d)[3], '[title="Move down"]')!.disabled).toBe(true);
		await click(find(rows(d)[3], '[title="Move up"]'));
		await click(find(rows(d)[0], '[title="Move down"]'));
		expect(order(d)).toEqual([SUMMARIES[1], SUMMARIES[0], SUMMARIES[3], SUMMARIES[2]]);
		expect(isOff(d, 'Rewrite history')).toBe(false);
		await press(d, 'Rewrite history');
		expect((w.sent('rebase_interactive').at(-1)!.args.steps as { hash: string }[]).map((s) => s.hash)).toEqual([commits[2].hash, commits[3].hash, commits[0].hash, commits[1].hash]);
	});

	test('a row is dragged by its grip with pointer events', async () => {
		const d = await editor();
		// happy-dom lays nothing out: every row is given 30 px, one under the other.
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
			const at = rows(d).indexOf(this);
			return { top: at * 30, height: 30, bottom: at * 30 + 30, left: 0, right: 0, width: 0, x: 0, y: at * 30, toJSON: () => ({}) };
		});
		const grip = find(rows(d)[3], '.grip')!;
		(grip as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
		grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientY: 100 }));
		await settle();
		expect(rows(d)[3].classList.contains('dragging')).toBe(true);
		grip.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientY: 35 }));
		grip.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		await settle();
		expect(order(d)).toEqual([SUMMARIES[0], SUMMARIES[3], SUMMARIES[1], SUMMARIES[2]]);
		expect(all(d, '.row.dragging')).toEqual([]);
		expect(all(d, '[draggable]')).toEqual([]);
	});

	test('dropping every commit is warned about', async () => {
		const d = await ask('rebase-interactive', { upstream: commits[1].hash });
		await act(d, 0, 'Drop');
		expect(problems(d)).toContain('Every commit is dropped: feature/repeat-mode ends up where the starting point is.');
	});

	test('a merge among the commits is refused', async () => {
		const plan = [...commits.slice(0, 2)].reverse();
		w.on('rebase_plan', () => [plan[0], { ...plan[1], parents: ['a'.repeat(40), 'b'.repeat(40)] }]);
		const d = await editor({ hashes: [commits[0].hash] });
		expect(problems(d)).toContain('These commits include a merge, which an interactive rebase would flatten. Start after the merge.');
		expect(isOff(d, 'Rewrite history')).toBe(true);
	});

	test('the whole branch can be listed, from its first commit', async () => {
		w.on('rebase_plan', (args) => (args.upstream === null ? [...commits].reverse() : []));
		const d = await ask('rebase-interactive', { upstream: null });
		expect(words(find(d, '.dlg p')!)).toContain('Every commit of feature/repeat-mode , oldest at the top.');
		expect(order(d)[0]).toBe('Initial commit');
		expect(order(d).length).toBe(6);
	});

	test('uncommitted changes are said to be stashed and put back', async () => {
		const d = await editor();
		expect(words(d)).toContain('Your uncommitted changes are stashed for the rebase and put back afterwards.');
		expect(words(d)).toContain('If a commit conflicts, the rebase stops there');
	});

	test('nothing to replay says so', async () => {
		w.on('rebase_plan', () => []);
		const d = await editor();
		expect(words(find(d, '.note')!)).toBe('There are no commits to replay.');
		expect(isOff(d, 'Rewrite history')).toBe(true);
	});

	test('git refusing the list closes the dialog and says why', async () => {
		w.on('rebase_plan', () => {
			throw appError('git', 'fatal: bad revision');
		});
		await editor();
		expect(isOpen('rebase-interactive')).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'fatal: bad revision' });
	});

	test('the rows start over each time it opens', async () => {
		const d = await editor();
		await act(d, 3, 'Drop');
		await press(d, 'Cancel');
		await editor();
		expect(actions(d)).toEqual(['Pick', 'Pick', 'Pick', 'Pick']);
	});
});

describe('rebase onto a branch, choosing the commits', () => {
	test('is a rebase even with every commit picked', async () => {
		w.on('rebase_plan', () => [commits[0]]);
		const d = await ask('rebase-interactive', { branch: 'main', upstream: 'main' });
		expect(words(find(d, 'h3')!)).toBe('Rebase feature/repeat-mode onto main');
		expect(words(find(d, '.dlg p')!)).toContain('Replays these commits of feature/repeat-mode on top of main , top to bottom.');
		expect(isOff(d, 'Rebase')).toBe(false);
		await press(d, 'Rebase');
		expect(w.sent('rebase_interactive').at(-1)!.args).toEqual({ id: repos.repo()!.id, upstream: 'main', steps: [{ hash: commits[0].hash, action: 'pick', message: null }] });
	});

	test('with nothing to replay it says what the branch lacks', async () => {
		w.on('rebase_plan', () => []);
		const d = await ask('rebase-interactive', { branch: 'main', upstream: 'main' });
		expect(words(find(d, '.note')!)).toBe('There are no commits to replay: feature/repeat-mode has nothing that main lacks.');
	});
});
