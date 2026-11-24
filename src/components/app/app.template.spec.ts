import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { RepoStatus } from '../../services/backend.service';

// What the shell's template lays out in the main pane for the Changes and History tabs. The shell itself
// (sidebar, Claude pane, keys) is in app.component.spec.ts.

// Monaco and xterm cannot run in happy-dom: the editor and the terminals stay empty, which is all the shell needs.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

let w: World;
let repos: RepoStore;
/** What each ResizeObserver made in the test watches, and how to tell it a width. */
let observers: { targets: Set<Element>; report: (width: number) => void }[];
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

/** happy-dom has no Popover API (the toolbar's menus and every `ml-select` use it). */
function popovers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, (this: HTMLElement) => void>;
	proto.showPopover = proto.hidePopover = proto.togglePopover = function () {};
}

/**
 * `<ml-dialog #name>` takes its id from the attribute that starts with `#`. happy-dom's parser drops the `#`,
 * so no dialog would be known by the name `RepoStore.ask` opens it by: this puts it back.
 */
const attributeNames = Element.prototype.getAttributeNames;
function dialogNames(): void {
	vi.spyOn(Element.prototype, 'getAttributeNames').mockImplementation(function (this: Element) {
		const found = attributeNames.call(this);
		return this.localName === 'ml-dialog' ? found.map((n) => (n === 'style' || n === 'class' ? n : `#${n}`)) : found;
	});
}

/**
 * The app hangs listeners on the window and starts timers (the status poll, the menu's keys), and nothing takes
 * them down: there is one window for the whole file. Those of one test are removed after it, so an earlier
 * test's app does not answer a later test's keys.
 */
const addListener = window.addEventListener.bind(window);
const startInterval = window.setInterval.bind(window);
let hung: (() => void)[] = [];
function tidy(): void {
	vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: EventListener, options?: boolean | AddEventListenerOptions) => {
		addListener(type, listener, options);
		hung.push(() => window.removeEventListener(type, listener, options));
	}) as typeof window.addEventListener);
	vi.spyOn(window, 'setInterval').mockImplementation(((run: () => void, ms?: number) => {
		const id = startInterval(run, ms);
		hung.push(() => window.clearInterval(id));
		return id;
	}) as typeof window.setInterval);
}

/** happy-dom's ResizeObserver never reports: this one is told a width by the test (`room`). */
function resizes(): void {
	observers = [];
	vi.stubGlobal(
		'ResizeObserver',
		class {
			private readonly _entry: (typeof observers)[number];
			constructor(callback: (entries: unknown[]) => void) {
				this._entry = { targets: new Set(), report: (width) => callback([{ contentRect: { width } }]) };
				observers.push(this._entry);
			}
			observe(target: Element): void {
				this._entry.targets.add(target);
			}
			unobserve(target: Element): void {
				this._entry.targets.delete(target);
			}
			disconnect(): void {
				this._entry.targets.clear();
			}
		},
	);
}

/**
 * The app on this platform, with nothing started yet: `ms-app` starts the stores itself. `seed` puts what an
 * earlier run of the app would have left in storage, before any store reads it.
 */
async function start(on = 'MacIntel', seed: () => void = () => {}): Promise<void> {
	Object.defineProperty(navigator, 'platform', { value: on, configurable: true });
	w = await world();
	seed();
	tidy();
	forgetElements();
	popovers();
	dialogNames();
	resizes();
	// The demo host answers after a real pause; these are answered here.
	w.on('ci_runs', () => []);
	w.on('pr_existing', () => null);
	w.on('host_clis', () => []);
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
}

beforeEach(() => start());

afterEach(() => {
	hung.forEach((undo) => undo());
	hung = [];
	vi.unstubAllGlobals();
	if (platform) {
		Object.defineProperty(navigator, 'platform', platform);
	}
});

async function app(): Promise<HTMLElement> {
	const el = await mount('ms-app');
	await settle();
	return el;
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
	return out.replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
}

/** The app shell's own shadow root: what it draws itself, not what its children draw. */
function own(el: Element): ShadowRoot {
	return el.shadowRoot!;
}

function sideTab(el: Element, label: string): HTMLElement {
	return [...own(el).querySelectorAll<HTMLElement>('aside .tab')].find((t) => words(t).startsWith(label))!;
}

function card(el: Element, title: string): HTMLButtonElement {
	return [...own(el).querySelectorAll<HTMLButtonElement>('.card')].find((c) => words(c.querySelector('b')!) === title)!;
}

function cards(el: Element): string[] {
	return [...own(el).querySelectorAll('.card b')].map((b) => words(b));
}

describe('the Changes pane', () => {
	async function changes(): Promise<HTMLElement> {
		const el = await app();
		await click(sideTab(el, 'Changes'));
		return el;
	}

	test('heads the diff with the file, what happened to it and its line counts', async () => {
		const el = await changes();
		repos.selectFile('src/player/queue.ts');
		await settle();
		const head = own(el).querySelector('.filehead')!;
		expect(head.querySelector<HTMLElement>('.mark')!.title).toBe('Modified');
		expect(words(head.querySelector('.path')!)).toBe('src/player/ queue.ts');
		const diff = repos.diff()!;
		expect([...head.querySelectorAll('.stat')].map((s) => s.textContent)).toEqual([`+${diff.added}`, `−${diff.removed}`]);
		expect(find<HTMLElement & { diff: unknown }>(el, 'main ms-diff')!.diff).toBe(diff);
	});

	test('a file with no lines changed says why: renamed (with where it came from), or new and empty', async () => {
		const el = await changes();
		w.on('file_diff', () => ({ text: '', tooLarge: false }));
		await status({ files: [{ path: 'src/new-name.ts', oldPath: 'src/old-name.ts', status: 'renamed' }] });
		expect(words(own(el).querySelector('.filehead .path')!)).toBe('src/old-name.ts → src/ new-name.ts');
		expect(words(find(el, 'main ms-diff')!)).toBe('Renamed without changes.');
		await status({ files: [{ path: 'notes.txt', oldPath: null, status: 'untracked' }] });
		expect(words(find(el, 'main ms-diff')!)).toBe('This file is empty.');
	});

	test('a conflicted file offers a resolution instead of an explanation', async () => {
		const el = await changes();
		repos.selectFile('src/player/shuffle.ts');
		await settle();
		expect(words(own(el).querySelector('.filehead ml-button')!)).toBe('Propose a resolution');
		repos.selectFile('src/player/queue.ts');
		await settle();
		expect(words(own(el).querySelector('.filehead ml-button')!)).toBe('Explain');
	});

	test('no tabs until a file is pinned; then it is a tab, and the file picked in the list beside it is a preview', async () => {
		const el = await changes();
		expect(own(el).querySelector('.filetabs')).toBeNull();
		repos.openTab('public/cover.png');
		repos.selectFile('src/player/queue.ts');
		await settle();
		const tabs = [...own(el).querySelectorAll<HTMLElement>('.filetab')];
		expect(tabs.map((t) => [words(t), t.classList.contains('on'), t.classList.contains('preview')])).toEqual([
			['cover.png', false, false],
			['queue.ts', true, true],
		]);
		expect(tabs[0].querySelector('[title="Close tab"]')).not.toBeNull();
		expect(tabs[1].querySelector('[title="Close tab"]')).toBeNull();
	});

	test('a double click pins the preview; clicking a tab shows its file; the cross closes it', async () => {
		const el = await changes();
		repos.openTab('public/cover.png');
		repos.selectFile('src/player/queue.ts');
		await settle();
		const tab = (name: string): HTMLElement => [...own(el).querySelectorAll<HTMLElement>('.filetab')].find((t) => words(t) === name)!;
		tab('queue.ts').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await settle();
		expect(repos.openTabs()).toEqual(['public/cover.png', 'src/player/queue.ts']);

		await click(tab('cover.png'));
		expect(repos.selectedPath()).toBe('public/cover.png');

		await click(tab('cover.png').querySelector('[title="Close tab"]'));
		expect(repos.openTabs()).toEqual(['src/player/queue.ts']);
		expect(repos.selectedPath()).toBe('src/player/queue.ts');
	});
});

describe('with no local changes', () => {
	async function clean(change: Partial<RepoStatus> = {}): Promise<HTMLElement> {
		const el = await app();
		await status({ files: [], ...change });
		await click(sideTab(el, 'Changes'));
		return el;
	}

	test('says so and offers what to do next', async () => {
		const el = await clean();
		expect(words(own(el).querySelector('.empty h2')!)).toBe('No local changes');
		expect(cards(el)).toEqual(expect.arrayContaining(['Push origin', 'Browse the files', 'Show in file manager', 'Open in terminal', 'View on GitHub', 'Issues', 'Create a pull request']));
	});

	test('commits waiting to be pushed come first, and the card pushes them', async () => {
		const el = await clean();
		const push = card(el, 'Push origin');
		expect(own(el).querySelector('.card')).toBe(push);
		expect(words(push.querySelector('small')!)).toBe('1 commit waiting to be pushed');
		await click(push);
		expect(w.sent('push').at(-1)!.args).toMatchObject({ force: false });
	});

	test('commits to bring in are offered as a pull; level with the remote there is no sync card', async () => {
		const el = await clean({ ahead: 0, behind: 2 });
		expect(words(card(el, 'Pull origin').querySelector('small')!)).toBe('2 commits to bring in');
		await click(card(el, 'Pull origin'));
		expect(w.sent('pull').length).toBe(1);
		await status({ files: [], ahead: 0, behind: 0 });
		expect(cards(el).some((title) => /^(Push|Pull|Fetch|Publish)/.test(title))).toBe(false);
	});

	test('the other cards open the repository where they say', async () => {
		const el = await clean();
		for (const [title, target] of [
			['Show in file manager', 'finder'],
			['Open in terminal', 'terminal'],
			['View on GitHub', 'remote'],
		]) {
			await click(card(el, title));
			expect(w.sent('open_in').at(-1)!.args, title).toMatchObject({ target });
		}
		await click(card(el, 'Browse the files'));
		expect(repos.tab()).toBe('files');
	});

	test('no pull request is offered from the default branch, a branch that is not pushed, or a detached HEAD', async () => {
		const el = await clean({ branch: 'main' });
		expect(cards(el)).not.toContain('Create a pull request');
		await status({ files: [], upstream: null });
		expect(cards(el)).not.toContain('Create a pull request');
		await status({ files: [], detached: true });
		expect(cards(el)).not.toContain('Create a pull request');
	});

	test('a repository with no host has no host cards; a host we do not know is "the web"', async () => {
		const el = await clean({ host: null });
		expect(cards(el).some((title) => title.startsWith('View on') || title === 'Issues')).toBe(false);
		await status({ files: [], host: { provider: 'other', name: 'git.example.com', web: 'https://git.example.com/demo/harmony', issues: null, issuesLabel: 'Issues', pulls: null, pullsLabel: 'Pull requests' } });
		expect(cards(el)).toContain('View on the web');
		expect(cards(el)).not.toContain('Issues');
	});
});

describe('the History pane', () => {
	async function history(): Promise<HTMLElement> {
		const el = await app();
		await click(sideTab(el, 'History'));
		return el;
	}

	test('heads the commit with its message, who, when, and that it is not pushed', async () => {
		const el = await history();
		const head = own(el).querySelector('.commithead')!;
		expect(words(head.querySelector('h2')!)).toBe('Wrap the queue when repeat is on');
		expect(head.querySelector('pre')!.textContent).toBe('The cursor resets instead of running off the end.');
		expect(words(head.querySelector('.meta')!)).toContain('Demo Author');
		expect(words(head.querySelector('.hash')!)).toBe(repos.commits()[0].shortHash);
		expect(words(head.querySelector('.meta')!)).toContain('2 changed files');
		expect([...head.querySelectorAll('ml-badge')].map((b) => words(b))).toEqual(['Not pushed', 'feature/repeat-mode']);
	});

	test('a pushed commit shows its branches and tags, and no "Not pushed"', async () => {
		const el = await history();
		repos.selectCommit(repos.commits()[3].hash);
		await settle();
		expect([...own(el).querySelectorAll('.commithead ml-badge')].map((b) => words(b))).toEqual(['v1.3.0']);
		expect(own(el).querySelector('.commithead pre')).toBeNull();
	});

	test('the short hash copies the whole one', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		const el = await history();
		await click(own(el).querySelector('.commithead .hash'));
		expect(writeText).toHaveBeenCalledWith(repos.commits()[0].hash);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Commit hash copied' });
	});

	test('lists the commit\'s files; the first one\'s diff shows, and clicking another shows that', async () => {
		const el = await history();
		const rows = [...own(el).querySelectorAll<HTMLElement>('.files .row')];
		expect(rows.map((r) => words(r.querySelector('.path')!))).toEqual(['src/player/ queue.ts', 'src/player/ repeat.ts']);
		expect(rows.map((r) => r.querySelector<HTMLElement>('.mark')!.title)).toEqual(['Modified', 'New']);
		expect(rows[0].classList.contains('sel')).toBe(true);
		await click(rows[1]);
		expect(w.sent('commit_diff').at(-1)!.args).toMatchObject({ hash: repos.commits()[0].hash, path: 'src/player/repeat.ts' });
		expect(words(own(el).querySelector('.diffcol .filehead .path')!)).toBe('src/player/ repeat.ts');
	});

	test('a commit that changed no files says so', async () => {
		w.on('commit_files', () => []);
		const el = await history();
		expect(words(own(el).querySelector('.diffcol .empty')!)).toBe('This commit changed no files.');
	});

	test('a repository without commits says so', async () => {
		w.on('history', () => []);
		const el = await history();
		expect(words(own(el).querySelector('main .empty h2')!)).toBe('No commits yet');
	});
});
