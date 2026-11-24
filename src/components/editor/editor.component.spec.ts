import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { ExplorerStore } from '../../services/explorer.store';

// Monaco cannot run in happy-dom, so it never arrives here. What is tested is everything around the editor:
// the tabs, the header, the bars that ask, and what is said for a file that cannot be shown as text.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));

const HARMONY = '/Users/demo/Source/harmony';

let w: World;
let repos: RepoStore;
let explorer: ExplorerStore;
let el: HTMLElement;
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

/** The app on this platform (`navigator.platform` is what `isMac()` reads), with the editor on screen. */
async function start(on = 'MacIntel'): Promise<void> {
	Object.defineProperty(navigator, 'platform', { value: on, configurable: true });
	w = await world();
	forgetElements();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	explorer = w.get((await import('../../services/explorer.store')).ExplorerStore);
	await repos.init();
	el = await mount('ms-editor');
}

beforeEach(() => start());

afterEach(() => {
	if (platform) {
		Object.defineProperty(navigator, 'platform', platform);
	}
});

/** A file clicked in the tree (`keep`: double-clicked), and read. */
async function open(path: string, keep = false): Promise<void> {
	explorer.open(path, keep);
	await settle();
}

/** The file has edits that are not saved. Typing happens in Monaco, so the tab is marked directly. */
async function edited(path: string): Promise<void> {
	explorer.tabs.set(explorer.tabs().map((t) => (t.path === path ? { ...t, dirty: true } : t)));
	await settle();
}

function tabs(): HTMLElement[] {
	return all(el, '.filetab');
}

function tab(name: string): HTMLElement {
	return tabs().find((t) => find(t, 'span')!.textContent === name)!;
}

function names(): string[] {
	return tabs().map((t) => find(t, 'span')!.textContent ?? '');
}

function button(root: Element, label: string): HTMLButtonElement {
	return find<HTMLButtonElement>(all(root, 'ml-button').find((b) => words(b) === label)!, 'button')!;
}

function buttons(root: Element): string[] {
	return all(root, 'ml-button').map((b) => words(b));
}

function said(): string {
	return words(find(el, '.body .state')!);
}

describe('with no file open', () => {
	test('it says to pick one, and has no tabs or header', () => {
		expect(said()).toBe('Pick a file on the left to view or edit it.');
		expect(find(el, '.filetabs')).toBeNull();
		expect(find(el, '.filehead')).toBeNull();
	});
});

describe('the tabs', () => {
	test('a file clicked in the tree opens as a preview tab, named by its file, with its full path on hover', async () => {
		await open('src/player/queue.ts');
		expect(w.sent('read_file').at(-1)!.args).toMatchObject({ id: HARMONY, path: 'src/player/queue.ts' });
		expect(names()).toEqual(['queue.ts']);
		expect(tab('queue.ts').classList.contains('preview')).toBe(true);
		expect(tab('queue.ts').classList.contains('on')).toBe(true);
		expect(tab('queue.ts').title).toBe(`${HARMONY}/src/player/queue.ts`);
	});

	test('the next file clicked takes the preview tab\'s place', async () => {
		await open('src/player/queue.ts');
		await open('src/player/repeat.ts');
		expect(names()).toEqual(['repeat.ts']);
	});

	test('a double click on the tab keeps it, and the next file gets a tab of its own', async () => {
		await open('src/player/queue.ts');
		tab('queue.ts').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await settle();
		expect(tab('queue.ts').classList.contains('preview')).toBe(false);
		await open('src/player/repeat.ts');
		expect(names()).toEqual(['queue.ts', 'repeat.ts']);
		expect(tabs().map((t) => t.classList.contains('on'))).toEqual([false, true]);
	});

	test('a file with unsaved edits is not replaced by the next preview', async () => {
		await open('src/player/queue.ts');
		await edited('src/player/queue.ts');
		await open('src/player/repeat.ts');
		expect(names()).toEqual(['queue.ts', 'repeat.ts']);
	});

	test('clicking a tab shows that file, without reading it again', async () => {
		await open('src/player/queue.ts', true);
		await open('src/player/repeat.ts', true);
		const reads = w.sent('read_file').length;
		await click(tab('queue.ts'));
		expect(explorer.active()).toBe('src/player/queue.ts');
		expect(words(find(el, '.filehead .path')!)).toBe('src/player/ queue.ts');
		expect(w.sent('read_file').length).toBe(reads);
	});

	test('the cross closes a tab and shows its neighbour', async () => {
		await open('src/player/queue.ts', true);
		await open('src/player/repeat.ts', true);
		expect(find(tab('repeat.ts'), 'button')!.title).toBe('Close tab');
		await click(find(tab('repeat.ts'), 'button'));
		expect(names()).toEqual(['queue.ts']);
		expect(explorer.active()).toBe('src/player/queue.ts');
		await click(find(tab('queue.ts'), 'button'));
		expect(find(el, '.filetabs')).toBeNull();
		expect(said()).toBe('Pick a file on the left to view or edit it.');
	});

	test('closing a tab does not first switch to it', async () => {
		await open('src/player/queue.ts', true);
		await open('src/player/repeat.ts', true);
		await click(find(tab('queue.ts'), 'button'));
		expect(names()).toEqual(['repeat.ts']);
		expect(explorer.active()).toBe('src/player/repeat.ts');
	});
});

describe('the header', () => {
	test('names the file with its folder', async () => {
		await open('src/player/track.ts');
		expect(words(find(el, '.filehead .path')!)).toBe('src/player/ track.ts');
		expect(find(el, '.filehead ms-lsp-status')).not.toBeNull();
	});

	test('a file with nothing changed has no Save and no "View changes"', async () => {
		await open('src/player/track.ts');
		expect(buttons(find(el, '.filehead')!)).toEqual([]);
		expect(find(el, '.filehead .hint')).toBeNull();
	});

	test('a file that has uncommitted changes offers its diff in the Changes tab', async () => {
		await open('src/player/queue.ts');
		expect(buttons(find(el, '.filehead')!)).toEqual(['View changes']);
		await click(button(find(el, '.filehead')!, 'View changes'));
		expect(repos.tab()).toBe('changes');
		expect(repos.selectedPath()).toBe('src/player/queue.ts');
	});

	test('unsaved edits are said, and Save saves that file', async () => {
		const save = vi.spyOn(explorer, 'save').mockResolvedValue(true);
		await open('src/player/track.ts');
		await edited('src/player/track.ts');
		expect(find(el, '.filehead .hint')!.textContent).toBe('Unsaved · ⌘S');
		expect(tab('track.ts').classList.contains('dirty')).toBe(true);
		await click(button(find(el, '.filehead')!, 'Save'));
		expect(save).toHaveBeenCalledWith('src/player/track.ts');
	});

	test.each(['Win32', 'Linux x86_64'])('on %s the save shortcut is written Ctrl+S', async (system) => {
		await start(system);
		await open('src/player/track.ts');
		await edited('src/player/track.ts');
		expect(find(el, '.filehead .hint')!.textContent).toBe('Unsaved · Ctrl+S');
	});
});

describe('closing a file with unsaved edits', () => {
	async function asked(): Promise<HTMLElement> {
		await open('src/player/track.ts', true);
		await edited('src/player/track.ts');
		expect(find(tab('track.ts'), 'button')!.title).toBe('Close (unsaved changes)');
		await click(find(tab('track.ts'), 'button'));
		return find<HTMLElement>(el, '.notice')!;
	}

	test('asks first, and the tab stays', async () => {
		const bar = await asked();
		expect(words(find(bar, '.grow')!)).toBe('track.ts has unsaved changes.');
		expect(buttons(bar)).toEqual(['Save', "Don't save", 'Cancel']);
		expect(names()).toEqual(['track.ts']);
	});

	test('"Don\'t save" closes it without writing anything', async () => {
		const bar = await asked();
		await click(button(bar, "Don't save"));
		expect(names()).toEqual([]);
		expect(find(el, '.notice')).toBeNull();
		expect(w.sent('write_file')).toEqual([]);
	});

	test('Cancel keeps the file open with its edits', async () => {
		const bar = await asked();
		await click(button(bar, 'Cancel'));
		expect(find(el, '.notice')).toBeNull();
		expect(names()).toEqual(['track.ts']);
		expect(explorer.tabs()[0].dirty).toBe(true);
	});

	test('Save saves, then closes', async () => {
		const saveAndClose = vi.spyOn(explorer, 'saveAndClose').mockResolvedValue();
		const bar = await asked();
		await click(button(bar, 'Save'));
		expect(saveAndClose).toHaveBeenCalledWith('src/player/track.ts');
	});

	test('the question is about the file it names, which comes on screen', async () => {
		await open('src/player/track.ts', true);
		await edited('src/player/track.ts');
		await open('src/player/repeat.ts', true);
		await click(find(tab('track.ts'), 'button'));
		expect(explorer.active()).toBe('src/player/track.ts');
		expect(words(find(el, '.notice .grow')!)).toBe('track.ts has unsaved changes.');
	});
});

describe('a file that changed on disk since it was opened', () => {
	async function conflict(): Promise<HTMLElement> {
		await open('src/player/track.ts', true);
		await edited('src/player/track.ts');
		explorer.notice.set({ path: 'src/player/track.ts', kind: 'conflict' });
		await settle();
		return find<HTMLElement>(el, '.notice')!;
	}

	test('is not overwritten without asking', async () => {
		const bar = await conflict();
		expect(words(find(bar, '.grow')!)).toBe('track.ts changed on disk since you opened it.');
		expect(buttons(bar)).toEqual(['Overwrite', 'Reload from disk', 'Cancel']);
		expect(w.sent('write_file')).toEqual([]);
	});

	test('Overwrite saves over what is on disk', async () => {
		const save = vi.spyOn(explorer, 'save').mockResolvedValue(true);
		const bar = await conflict();
		await click(button(bar, 'Overwrite'));
		expect(save).toHaveBeenCalledWith('src/player/track.ts', true);
	});

	test('"Reload from disk" reads the file again and drops the edits', async () => {
		const bar = await conflict();
		const reads = w.sent('read_file').length;
		await click(button(bar, 'Reload from disk'));
		expect(w.sent('read_file').length).toBe(reads + 1);
		expect(explorer.tabs()[0].dirty).toBe(false);
		expect(find(el, '.notice')).toBeNull();
		expect(w.sent('write_file')).toEqual([]);
	});
});

describe('a file that cannot be shown as text', () => {
	test('a binary file says so', async () => {
		await open('public/cover.png');
		expect(said()).toBe('Binary file. There is nothing to show as text.');
		expect(find(el, '.host')!.classList.contains('off')).toBe(true);
	});

	test('a file too large to open says so', async () => {
		w.on('read_file', () => ({ text: '', binary: false, tooLarge: true, size: 80_000_000 }));
		await open('dist/bundle.js');
		expect(said()).toBe('This file is too large to open here.');
	});

	test('a file that is gone says so', async () => {
		w.on('read_file', () => {
			throw appError('error', 'src/gone.ts no longer exists');
		});
		await open('src/gone.ts');
		expect(said()).toBe('This file no longer exists.');
		expect(w.toasts).toEqual([]);
	});

	test('while a file is being read there is a spinner', async () => {
		w.on('read_file', () => new Promise(() => {}));
		await open('src/main.ts');
		expect(find(el, '.body .state ml-spinner')).not.toBeNull();
		expect(names()).toEqual(['main.ts']);
	});

	test('until the editor itself has loaded, a text file shows a spinner, not an empty pane', async () => {
		await open('src/main.ts');
		expect(explorer.activeTab()!.kind).toBe('text');
		expect(find(el, '.body .state ml-spinner')).not.toBeNull();
		expect(find(el, '.host')!.classList.contains('off')).toBe(true);
	});
});

describe('what is open belongs to the checkout', () => {
	test('another repository has its own tabs, and these are back on return', async () => {
		await open('src/player/queue.ts', true);
		await repos.selectRepo('/Users/demo/Source/cadence', true);
		explorer.sync();
		await settle();
		expect(names()).toEqual([]);
		await repos.selectRepo(HARMONY);
		explorer.sync();
		await settle();
		expect(names()).toEqual(['queue.ts']);
	});
});
