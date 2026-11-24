import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { ExplorerStore } from '../../services/explorer.store';

// Monaco cannot run in happy-dom: a file opened from the tree gets its tab, and no editor.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

const HARMONY = '/Users/demo/Source/harmony';

let w: World;
let repos: RepoStore;
let explorer: ExplorerStore;
let el: HTMLElement;
/** The dialogs the component asked for, by id; the last one is the one that is open. */
let opened: string[];
let open: MockInstance<ExplorerStore['open']>;
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

/** The app on this platform (`navigator.platform` is what `isMac()` and `isWindows()` read), with the tree on screen. */
async function start(on = 'MacIntel'): Promise<void> {
	Object.defineProperty(navigator, 'platform', { value: on, configurable: true });
	w = await world();
	forgetElements();
	// One turn later, as a frame is: after the render that the same click asked for.
	vi.stubGlobal('requestAnimationFrame', (run: () => void) => (setTimeout(run, 0), 0));
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	explorer = w.get((await import('../../services/explorer.store')).ExplorerStore);
	const { DialogService } = await import('@melodicdev/components/dialog');
	opened = [];
	vi.spyOn(w.get(DialogService), 'open').mockImplementation(((id: string) => void opened.push(id)) as never);
	vi.spyOn(w.get(DialogService), 'close').mockImplementation(() => {});
	open = vi.spyOn(explorer, 'open');
	await repos.init();
	el = await mount('ms-explorer');
	await settle();
}

beforeEach(() => start());

afterEach(() => {
	vi.unstubAllGlobals();
	if (platform) {
		Object.defineProperty(navigator, 'platform', platform);
	}
});

function rows(): HTMLElement[] {
	return all(el, '.list .row[data-path]');
}

function names(): string[] {
	return rows().map((r) => find(r, '.name')?.textContent ?? '');
}

function row(path: string): HTMLElement {
	const found = rows().find((r) => r.dataset.path === path);
	if (!found) {
		throw new Error(`no row for ${path} among ${rows().map((r) => r.dataset.path).join(', ')}`);
	}
	return found;
}

function selected(): string[] {
	return [...explorer.selected()];
}

/** Opens the folders down to `dir`. */
async function expand(...dirs: string[]): Promise<void> {
	for (const dir of dirs) {
		await click(row(dir));
	}
}

async function rightClick(target: Element): Promise<void> {
	target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true, clientX: 40, clientY: 60 }));
	await settle();
}

function menu(): string[] {
	return all(el, '.ctx .ctx-item').map((i) => words(i));
}

async function pick(label: string | RegExp): Promise<void> {
	const item = all(el, '.ctx .ctx-item').find((i) => (typeof label === 'string' ? words(i).startsWith(label) : label.test(words(i))));
	if (!item) {
		throw new Error(`no menu item "${String(label)}" among: ${menu().join(' | ')}`);
	}
	await click(item);
}

async function key(name: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
	const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
	find(el, '.list')!.dispatchEvent(event);
	await settle();
	return event;
}

function edit(): HTMLInputElement | null {
	return find<HTMLInputElement>(el, 'input.edit');
}

/** Types a name into the box in the tree and presses a key in it. */
async function typeName(value: string, then: 'Enter' | 'Escape' = 'Enter'): Promise<void> {
	const input = edit()!;
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
	edit()!.dispatchEvent(new KeyboardEvent('keydown', { key: then, bubbles: true, cancelable: true }));
	await settle();
}

/** The dialog known by `name`: happy-dom drops the `#` of `<ml-dialog #name>`, so it is found by the attribute that is left. */
function dialog(name: string): HTMLElement {
	return find(el, `ml-dialog[${name}]`)!;
}

async function press(root: Element, label: string): Promise<void> {
	await click(find(all(root, 'ml-button').find((b) => words(b) === label)!, 'button'));
}

describe('the tree', () => {
	test('names the repository and lists its root, folders first', () => {
		expect(words(find(el, '.head .grow')!)).toBe('harmony');
		expect(names()).toEqual(['dist', 'docs', 'node_modules', 'public', 'src', '.gitignore', 'debug.log', 'package.json', 'README.md']);
		expect(w.sent('list_dir')[0].args).toMatchObject({ id: HARMONY, path: '' });
	});

	test('what .gitignore leaves out is listed, dimmed', () => {
		expect(rows().filter((r) => r.classList.contains('ignored')).map((r) => r.dataset.path)).toEqual(['dist', 'node_modules', 'debug.log']);
	});

	test('a folder opens on a click, reading its entries then, and closes on the next', async () => {
		const before = w.sent('list_dir').length;
		await click(row('src'));
		expect(w.sent('list_dir').at(-1)!.args.path).toBe('src');
		expect(w.sent('list_dir').length).toBe(before + 1);
		expect(names()).toEqual(expect.arrayContaining(['player', 'styles', 'main.ts']));
		expect(rows().indexOf(row('src/player'))).toBe(rows().indexOf(row('src')) + 1);
		await click(row('src'));
		expect(names()).not.toContain('main.ts');
	});

	test('a file changed since the last commit carries git\'s mark; a folder with changes below it a dot', async () => {
		await expand('src', 'src/player');
		expect(find(row('src/player/queue.ts'), '.mark')!.title).toBe('Modified');
		expect(find(row('src/player/repeat.ts'), '.mark')!.title).toBe('New');
		expect(find(row('src/player/track.ts'), '.mark')).toBeNull();
		expect(find(row('src'), '.dot')!.title).toBe('Contains changes');
		expect(find(row('src/player'), '.dot')).not.toBeNull();
		expect(find(row('public'), '.dot')).not.toBeNull();
		// docs only holds a deleted file, which is not in the tree.
		expect(find(row('docs'), '.dot')).toBeNull();
		expect(find(row('dist'), '.dot')).toBeNull();
	});

	test('the marks follow the status', async () => {
		await expand('src', 'src/player');
		const status = repos.status()!;
		w.on('repo_status', () => ({ ...status, files: [] }));
		await repos.refresh();
		await settle();
		expect(all(el, '.list .mark, .list .dot')).toEqual([]);
	});

	test('a click on a file opens it as a preview and selects it; a double click keeps its tab', async () => {
		await click(row('README.md'));
		expect(open).toHaveBeenLastCalledWith('README.md', false);
		expect(selected()).toEqual(['README.md']);
		expect(row('README.md').classList.contains('sel')).toBe(true);
		expect(explorer.preview()).toBe('README.md');
		row('README.md').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await settle();
		expect(open).toHaveBeenLastCalledWith('README.md', true);
		expect(explorer.preview()).toBeNull();
	});

	test('with nothing selected, the file on screen is the one marked', async () => {
		await click(row('README.md'));
		explorer.select([]);
		await settle();
		expect(rows().filter((r) => r.classList.contains('sel')).map((r) => r.dataset.path)).toEqual(['README.md']);
	});

	test('an empty repository says so, and that files can be dropped in', async () => {
		w.on('list_dir', () => []);
		await explorer.rescan();
		await settle();
		expect(words(find(el, '.list .note')!)).toBe('This repository has no files yet. Drop files here to add them.');
	});

	test('a file name is shown as text', async () => {
		w.on('list_dir', () => [{ name: '<img src=x onerror="window.pwned = true">.md', path: '<img src=x onerror="window.pwned = true">.md', isDir: false, ignored: false }]);
		await explorer.rescan();
		await settle();
		expect(names()).toEqual(['<img src=x onerror="window.pwned = true">.md']);
		expect(find(el, '.list img')).toBeNull();
	});

	test('the window coming back reads the open folders again', async () => {
		// Without the fetch that focus can start: what it brings is a second status, and a second read.
		repos.setAutoFetch(false);
		await click(row('src'));
		const before = w.sent('list_dir').length;
		window.dispatchEvent(new Event('focus'));
		await settle();
		expect(w.sent('list_dir').slice(before).map((c) => c.args.path).sort()).toEqual(['', 'src']);
	});

	test('while find in files has text, its results take the tree\'s place', async () => {
		const search = w.get((await import('../../services/search.store')).SearchStore);
		expect(find(el, '.list')!.classList.contains('away')).toBe(false);
		search.query.set('Queue');
		await settle();
		expect(find(el, '.list')!.classList.contains('away')).toBe(true);
		expect(find(el, 'ms-find-in-files')!.classList.contains('on')).toBe(true);
	});
});

describe('selecting', () => {
	test('Cmd-click or Ctrl-click adds a row to the selection, or takes it out, without opening it', async () => {
		for (const mods of [{ metaKey: true }, { ctrlKey: true }]) {
			await click(row('README.md'));
			open.mockClear();
			row('package.json').dispatchEvent(new MouseEvent('click', { bubbles: true, ...mods }));
			await settle();
			expect(selected()).toEqual(['README.md', 'package.json']);
			expect(open).not.toHaveBeenCalled();
			row('README.md').dispatchEvent(new MouseEvent('click', { bubbles: true, ...mods }));
			await settle();
			expect(selected()).toEqual(['package.json']);
		}
	});

	test('Shift-click selects everything between, as the rows are on screen', async () => {
		await click(row('.gitignore'));
		row('README.md').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
		await settle();
		expect(selected()).toEqual(['.gitignore', 'debug.log', 'package.json', 'README.md']);
	});

	test('a click on the empty space below the rows clears the selection', async () => {
		await click(row('README.md'));
		await click(find(el, '.list'));
		expect(selected()).toEqual([]);
	});

	test('the arrows walk the rows, open and close a folder; Esc clears', async () => {
		await click(row('public'));
		await click(row('public'));
		expect(selected()).toEqual(['public']);
		await key('ArrowRight');
		expect(explorer.expanded().has('public')).toBe(true);
		await key('ArrowDown');
		expect(selected()).toEqual(['public/cover.png']);
		await key('ArrowUp');
		await key('ArrowLeft');
		expect(explorer.expanded().has('public')).toBe(false);
		await key('ArrowUp');
		expect(selected()).toEqual(['node_modules']);
		await key('Escape');
		expect(selected()).toEqual([]);
	});
});

describe('the buttons above the tree', () => {
	test('the magnifier opens "Go to", and names both shortcuts the Mac way', async () => {
		const goTo = await mount('ms-go-to');
		const button = find(el, '.head button[title^="Go to a file"]')!;
		expect(button.title).toBe('Go to a file by name (⌘P), or a symbol (⌘T)');
		await click(button);
		expect(find(goTo, '.box input')).not.toBeNull();
	});

	test.each(['Win32', 'Linux x86_64'])('on %s the shortcuts are written with Ctrl', async (system) => {
		await start(system);
		expect(find(el, '.head button[title^="Go to a file"]')!.title).toBe('Go to a file by name (Ctrl+P), or a symbol (Ctrl+T)');
	});

	test('"Refresh" reads the tree again', async () => {
		const before = w.sent('list_dir').length;
		await click(find(el, '.head [title="Refresh"]'));
		expect(w.sent('list_dir').length).toBe(before + 1);
	});

	test('"Collapse all folders" closes every folder', async () => {
		await expand('src', 'src/player');
		await click(find(el, '.head [title="Collapse all folders"]'));
		expect(names()).toEqual(['dist', 'docs', 'node_modules', 'public', 'src', '.gitignore', 'debug.log', 'package.json', 'README.md']);
	});
});

describe('a new file or folder', () => {
	test('"New file" asks for a name in the tree; Enter creates it at the root and opens it', async () => {
		await click(find(el, '.head [title="New file"]'));
		expect(edit()!.placeholder).toBe('File name');
		expect(el.shadowRoot!.activeElement).toBe(edit());
		await typeName('  notes.md ');
		expect(w.sent('files_create').at(-1)!.args).toEqual({ id: HARMONY, root: HARMONY, dir: '', name: 'notes.md', isDir: false });
		expect(names()).toContain('notes.md');
		expect(open).toHaveBeenLastCalledWith('notes.md', true);
		expect(edit()).toBeNull();
	});

	test('with a folder selected it goes in that folder, which opens', async () => {
		await click(row('docs'));
		await click(row('docs'));
		await click(find(el, '.head [title="New folder"]'));
		expect(edit()!.placeholder).toBe('Folder name');
		expect(explorer.expanded().has('docs')).toBe(true);
		await typeName('drafts');
		expect(w.sent('files_create').at(-1)!.args).toMatchObject({ dir: 'docs', name: 'drafts', isDir: true });
		expect(rows().map((r) => r.dataset.path)).toContain('docs/drafts');
		expect(open).not.toHaveBeenCalledWith('docs/drafts', true);
	});

	test('with a file selected it goes beside that file', async () => {
		await expand('src');
		await click(row('src/main.ts'));
		await click(find(el, '.head [title="New file"]'));
		await typeName('util.ts');
		expect(w.sent('files_create').at(-1)!.args).toMatchObject({ dir: 'src', name: 'util.ts' });
	});

	test('Esc, or no name, creates nothing', async () => {
		await click(find(el, '.head [title="New file"]'));
		await typeName('half-typed', 'Escape');
		expect(edit()).toBeNull();
		await click(find(el, '.head [title="New file"]'));
		await typeName('   ');
		expect(w.sent('files_create')).toEqual([]);
	});

	test('a name that is taken is refused, and nothing is replaced', async () => {
		await click(find(el, '.head [title="New file"]'));
		await typeName('README.md');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'README.md already exists' });
		expect(names().filter((n) => n === 'README.md').length).toBe(1);
	});
});

describe('the menu on a file', () => {
	test('a file with no changes', async () => {
		await rightClick(row('README.md'));
		expect(menu()).toEqual(['Open in new tab', 'View file history', 'Rename… ↩', 'Duplicate', 'Move to Trash… ⌘⌫', 'Reveal in Finder', 'Open in terminal', 'Copy path', 'Copy relative path']);
		expect(selected()).toEqual(['README.md']);
	});

	test('a changed file can also be viewed in Changes and discarded', async () => {
		await expand('src', 'src/player');
		await rightClick(row('src/player/queue.ts'));
		expect(menu()).toEqual(expect.arrayContaining(['View changes', 'Discard changes…']));
		expect(menu()).not.toContain('Add to .gitignore');
	});

	test('a new file can also be added to .gitignore', async () => {
		await expand('src', 'src/player');
		await rightClick(row('src/player/repeat.ts'));
		expect(menu()).toContain('Add to .gitignore');
		await pick('Add to .gitignore');
		expect(w.sent('ignore_file').at(-1)!.args.path).toBe('src/player/repeat.ts');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'src/player/repeat.ts added to .gitignore' });
	});

	test('"Open in new tab" gives the file a tab of its own', async () => {
		await rightClick(row('README.md'));
		await pick('Open in new tab');
		expect(open).toHaveBeenLastCalledWith('README.md', true);
		expect(menu()).toEqual([]);
	});

	test('"View changes" goes to the file\'s diff in the Changes tab', async () => {
		await expand('public');
		await rightClick(row('public/cover.png'));
		await pick('View changes');
		expect(repos.tab()).toBe('changes');
		expect(repos.selectedPath()).toBe('public/cover.png');
	});

	test('"View file history" shows the commits that touched it', async () => {
		await rightClick(row('README.md'));
		await pick('View file history');
		await settle();
		expect(repos.historyPath()).toBe('README.md');
		expect(repos.tab()).toBe('history');
		expect(w.sent('history').at(-1)!.args.path).toBe('README.md');
	});

	test('"Discard changes" asks first, about that file', async () => {
		await expand('public');
		await rightClick(row('public/cover.png'));
		await pick('Discard changes…');
		expect(opened).toEqual(['discard']);
		expect(repos.prompt().files!.map((f) => f.path)).toEqual(['public/cover.png']);
		expect(w.sent('discard_changes')).toEqual([]);
	});

	test('"Duplicate" makes a copy beside it and selects the copy', async () => {
		await rightClick(row('README.md'));
		await pick('Duplicate');
		expect(w.sent('files_duplicate').at(-1)!.args).toEqual({ id: HARMONY, root: HARMONY, path: 'README.md' });
		expect(names()).toContain('README copy.md');
		expect(selected()).toEqual(['README copy.md']);
	});

	test('"Reveal" shows it in the file manager', async () => {
		await rightClick(row('README.md'));
		await pick('Reveal in Finder');
		expect(w.sent('open_in').at(-1)!.args).toMatchObject({ target: 'reveal', arg: 'README.md' });
	});

	test('"Open in terminal" starts a terminal in the file\'s folder', async () => {
		const { TerminalStore } = await import('../../services/terminal.store');
		const add = vi.spyOn(w.get(TerminalStore), 'add').mockResolvedValue();
		await expand('src');
		await rightClick(row('src/main.ts'));
		await pick('Open in terminal');
		expect(add).toHaveBeenCalledWith('src');
	});

	test('"Copy path" copies the absolute path; "Copy relative path" the one inside the repository', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		await expand('src');
		await rightClick(row('src/main.ts'));
		await pick(/^Copy path$/);
		expect(writeText).toHaveBeenLastCalledWith(`${HARMONY}/src/main.ts`);
		await rightClick(row('src/main.ts'));
		await pick('Copy relative path');
		expect(writeText).toHaveBeenLastCalledWith('src/main.ts');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Path copied' });
	});

	test('a click elsewhere closes it', async () => {
		await rightClick(row('README.md'));
		window.dispatchEvent(new MouseEvent('click'));
		await settle();
		expect(menu()).toEqual([]);
	});
});

describe('the menu on a folder, and below the rows', () => {
	test('a folder can be opened, added to, renamed, removed, and ignored', async () => {
		await rightClick(row('docs'));
		expect(menu()).toEqual(['Expand', 'New file…', 'New folder…', 'Rename… ↩', 'Duplicate', 'Move to Trash… ⌘⌫', 'Reveal in Finder', 'Open in terminal', 'Copy path', 'Copy relative path', 'Add folder to .gitignore']);
		await pick('Expand');
		expect(explorer.expanded().has('docs')).toBe(true);
		await rightClick(row('docs'));
		expect(menu()[0]).toBe('Collapse');
	});

	test('"New file…" on a folder asks for the name inside it', async () => {
		await rightClick(row('docs'));
		await pick('New file…');
		await typeName('todo.md');
		expect(w.sent('files_create').at(-1)!.args).toMatchObject({ dir: 'docs', name: 'todo.md', isDir: false });
	});

	test('a folder .gitignore already leaves out is not offered again', async () => {
		await rightClick(row('dist'));
		expect(menu()).not.toContain('Add folder to .gitignore');
	});

	test('the empty space is the repository\'s root', async () => {
		await rightClick(find(el, '.list')!);
		expect(menu()).toEqual(['New file…', 'New folder…', 'Reveal in Finder', 'Open in terminal', 'Copy path']);
		await pick('New folder…');
		await typeName('scripts');
		expect(w.sent('files_create').at(-1)!.args).toMatchObject({ dir: '', name: 'scripts', isDir: true });
	});

	test('"Open in terminal" on the root starts in the checkout itself', async () => {
		const { TerminalStore } = await import('../../services/terminal.store');
		const add = vi.spyOn(w.get(TerminalStore), 'add').mockResolvedValue();
		await rightClick(find(el, '.list')!);
		await pick('Open in terminal');
		expect(add).toHaveBeenCalledWith(null);
	});
});

describe('the menu on several rows', () => {
	async function three(): Promise<void> {
		await expand('public');
		await click(row('public/cover.png'));
		row('package.json').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
		row('README.md').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
		await settle();
		await rightClick(row('package.json'));
	}

	test('acts on all of them', async () => {
		await three();
		expect(menu()).toEqual(['Reveal in Finder', 'Discard changes (1)…', 'Copy paths', 'Copy relative paths', 'Move 3 items to Trash… ⌘⌫']);
	});

	test('"Copy relative paths" copies one per line, in the order on screen', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		await three();
		await pick('Copy relative paths');
		expect(writeText).toHaveBeenCalledWith('public/cover.png\npackage.json\nREADME.md');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: '3 paths copied' });
	});

	test('a right-click on a row outside the selection is about that row alone', async () => {
		await click(row('README.md'));
		row('package.json').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
		await settle();
		await rightClick(row('.gitignore'));
		expect(selected()).toEqual(['.gitignore']);
		expect(menu()).toContain('Rename… ↩');
	});
});

describe('renaming', () => {
	async function rename(path: string): Promise<void> {
		await rightClick(row(path));
		await pick('Rename…');
	}

	test('the name is edited in place, and Enter moves the file to its new name', async () => {
		await rename('README.md');
		expect(edit()!.value).toBe('README.md');
		await typeName('READ.md');
		expect(w.sent('files_move').at(-1)!.args).toEqual({ id: HARMONY, root: HARMONY, paths: ['README.md'], to: '', rename: 'READ.md', onConflict: 'ask' });
		expect(names()).toContain('READ.md');
		expect(names()).not.toContain('README.md');
	});

	test('an open tab follows the file to its new name', async () => {
		await click(row('README.md'));
		await rename('README.md');
		await typeName('READ.md');
		expect(explorer.tabs().map((t) => t.path)).toEqual(['READ.md']);
		expect(explorer.active()).toBe('READ.md');
	});

	test('the same name, or Esc, changes nothing', async () => {
		await rename('README.md');
		await typeName('README.md');
		await rename('README.md');
		await typeName('Other.md', 'Escape');
		expect(w.sent('files_move')).toEqual([]);
	});

	test('a name that is taken is asked about first: nothing is replaced without an answer', async () => {
		await rename('README.md');
		await typeName('package.json');
		expect(w.sent('files_move').map((c) => c.args.onConflict)).toEqual(['ask']);
		expect(opened).toEqual(['files-conflict']);
		const asking = dialog('files-conflict');
		expect(words(find(asking, '.dlg')!)).toBe('package.json already exists in the repository root. Replacing moves the existing one to the Trash.');
		expect(all(asking, 'ml-button').map((b) => words(b))).toEqual(['Cancel', 'Skip', 'Keep both', 'Replace']);
		expect(names()).toEqual(expect.arrayContaining(['README.md', 'package.json']));
	});

	test.each([
		['Replace', 'replace'],
		['Keep both', 'keep-both'],
		['Skip', 'skip'],
	])('"%s" does it that way', async (label, how) => {
		await rename('README.md');
		await typeName('package.json');
		await press(dialog('files-conflict'), label);
		expect(w.sent('files_move').map((c) => c.args.onConflict)).toEqual(['ask', how]);
	});

	test('Cancel leaves both files as they were', async () => {
		await rename('README.md');
		await typeName('package.json');
		await press(dialog('files-conflict'), 'Cancel');
		expect(w.sent('files_move').length).toBe(1);
		expect(names()).toEqual(expect.arrayContaining(['README.md', 'package.json']));
	});

	test('on a Mac, Enter on the selected row renames it', async () => {
		await click(row('README.md'));
		await key('Enter');
		expect(edit()!.value).toBe('README.md');
	});

	test('off the Mac it is F2, and Enter opens the file', async () => {
		await start('Win32');
		await click(row('README.md'));
		open.mockClear();
		await key('Enter');
		expect(edit()).toBeNull();
		expect(open).toHaveBeenLastCalledWith('README.md', true);
		await key('F2');
		expect(edit()!.value).toBe('README.md');
	});
});

describe('moving to the trash', () => {
	test('asks first, naming the file and saying it can be got back', async () => {
		await rightClick(row('README.md'));
		await pick('Move to Trash…');
		expect(opened).toEqual(['files-delete']);
		expect(words(find(dialog('files-delete'), '.dlg')!)).toBe('Move README.md to the Trash? You can get it back from the Trash.');
		expect(w.sent('files_trash')).toEqual([]);
	});

	test('the confirm button trashes it and says so; its tab closes', async () => {
		await click(row('README.md'));
		await rightClick(row('README.md'));
		await pick('Move to Trash…');
		await press(dialog('files-delete'), 'Move to Trash');
		expect(w.sent('files_trash').at(-1)!.args).toEqual({ id: HARMONY, root: HARMONY, paths: ['README.md'] });
		expect(names()).not.toContain('README.md');
		expect(explorer.tabs()).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'README.md moved to the Trash' });
	});

	test('Cancel trashes nothing', async () => {
		await rightClick(row('README.md'));
		await pick('Move to Trash…');
		await press(dialog('files-delete'), 'Cancel');
		expect(w.sent('files_trash')).toEqual([]);
		expect(names()).toContain('README.md');
	});

	test('several are listed, and go together', async () => {
		await click(row('README.md'));
		row('package.json').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
		await settle();
		await key('Delete');
		expect(words(find(dialog('files-delete'), '.dlg p')!)).toBe('Move 2 items to the Trash?');
		expect(all(dialog('files-delete'), 'li').map((li) => li.textContent)).toEqual(['package.json', 'README.md']);
		await press(dialog('files-delete'), 'Move to Trash');
		expect(w.sent('files_trash').at(-1)!.args.paths).toEqual(['package.json', 'README.md']);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: '2 items moved to the Trash' });
	});

	test('unsaved edits in a file that would go are warned about', async () => {
		await click(row('README.md'));
		explorer.tabs.set(explorer.tabs().map((t) => ({ ...t, dirty: true })));
		await rightClick(row('README.md'));
		await pick('Move to Trash…');
		expect(words(find(dialog('files-delete'), '.dlg')!)).toContain('Unsaved edits in README.md will be lost.');
	});

	test('Delete, Cmd+Backspace and Ctrl+Backspace ask about the selected row; Backspace alone does nothing', async () => {
		await click(row('README.md'));
		await key('Backspace');
		expect(opened).toEqual([]);
		const keys: [string, KeyboardEventInit][] = [
			['Delete', {}],
			['Backspace', { metaKey: true }],
			['Backspace', { ctrlKey: true }],
		];
		for (const [name, mods] of keys) {
			opened.length = 0;
			const event = await key(name, mods);
			expect(event.defaultPrevented).toBe(true);
			expect(opened).toEqual(['files-delete']);
			await press(dialog('files-delete'), 'Cancel');
		}
		expect(w.sent('files_trash')).toEqual([]);
	});

	test('on Windows it is the Recycle Bin, with Delete as its key', async () => {
		await start('Win32');
		await rightClick(row('README.md'));
		expect(menu()).toEqual(expect.arrayContaining(['Move to Recycle Bin… Delete', 'Show in File Explorer', 'Rename… F2']));
		await pick('Move to Recycle Bin…');
		expect(words(find(dialog('files-delete'), 'h3')!)).toBe('Move to Recycle Bin');
	});

	test('on Linux the folder is shown "in file manager"', async () => {
		await start('Linux x86_64');
		await rightClick(row('README.md'));
		expect(menu()).toEqual(expect.arrayContaining(['Show in file manager', 'Move to Trash… Delete']));
	});
});

describe('dragging rows inside the tree', () => {
	/** happy-dom lays nothing out: the list is given a box, and the row "under the pointer" is named by the test. */
	function under(target: Element | null): void {
		const list = find(el, '.list')!;
		list.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 600, width: 300, height: 600, x: 0, y: 0, toJSON: () => ({}) });
		(el.shadowRoot as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => target;
	}

	async function drag(path: string, onto: Element | null): Promise<void> {
		row(path).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
		under(onto);
		window.dispatchEvent(new PointerEvent('pointermove', { clientX: 60, clientY: 80 }));
		await settle();
	}

	test('a file dragged onto a folder is moved into it, asking before anything is replaced', async () => {
		await drag('README.md', row('docs'));
		expect(row('README.md').classList.contains('dragging')).toBe(true);
		expect(row('docs').classList.contains('drop')).toBe(true);
		window.dispatchEvent(new PointerEvent('pointerup'));
		await settle();
		expect(w.sent('files_move').at(-1)!.args).toEqual({ id: HARMONY, root: HARMONY, paths: ['README.md'], to: 'docs', rename: null, onConflict: 'ask' });
		expect(rows().map((r) => r.dataset.path)).toContain('docs/README.md');
	});

	test('dropped on a file, it goes to that file\'s folder', async () => {
		await expand('docs');
		await drag('README.md', row('docs/shortcuts.md'));
		window.dispatchEvent(new PointerEvent('pointerup'));
		await settle();
		expect(w.sent('files_move').at(-1)!.args.to).toBe('docs');
	});

	test('dropped where it already is, nothing moves', async () => {
		await drag('README.md', row('package.json'));
		window.dispatchEvent(new PointerEvent('pointerup'));
		await settle();
		expect(w.sent('files_move')).toEqual([]);
	});

	test('a folder cannot be dropped into itself', async () => {
		await expand('src');
		await drag('src', row('src/player'));
		window.dispatchEvent(new PointerEvent('pointerup'));
		await settle();
		expect(w.sent('files_move')).toEqual([]);
	});

	test('the selection is dragged together', async () => {
		await click(row('README.md'));
		row('package.json').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
		await settle();
		await drag('README.md', row('docs'));
		window.dispatchEvent(new PointerEvent('pointerup'));
		await settle();
		expect(w.sent('files_move').at(-1)!.args.paths).toEqual(['package.json', 'README.md']);
	});

	test('a few pixels are a click, not a drag', async () => {
		row('README.md').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
		under(row('docs'));
		window.dispatchEvent(new PointerEvent('pointermove', { clientX: 22, clientY: 21 }));
		window.dispatchEvent(new PointerEvent('pointerup'));
		await settle();
		expect(w.sent('files_move')).toEqual([]);
	});

	test('the click that ends a drag does not open the file', async () => {
		await drag('README.md', row('package.json'));
		window.dispatchEvent(new PointerEvent('pointerup'));
		open.mockClear();
		row('README.md').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(open).not.toHaveBeenCalled();
	});

	test('the rows do not use HTML drag and drop', () => {
		expect(all(el, '[draggable]')).toEqual([]);
	});
});

describe('files dropped from outside (the browser preview)', () => {
	function dropEvent(type: string, files: string[]): Event {
		return Object.assign(new Event(type, { bubbles: true, cancelable: true }), { clientX: 60, clientY: 80, dataTransfer: { types: ['Files'], files: files.map((name) => ({ name })) } });
	}

	function under(target: Element | null): void {
		const list = find(el, '.list')!;
		list.getBoundingClientRect = () => ({ left: 0, right: 300, top: 0, bottom: 600, width: 300, height: 600, x: 0, y: 0, toJSON: () => ({}) });
		(el.shadowRoot as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => target;
	}

	test('are copied into the folder under the drop, and it says so', async () => {
		under(row('docs'));
		find(el, '.list')!.dispatchEvent(dropEvent('drop', ['sketch.png']));
		await settle();
		expect(w.sent('files_import').at(-1)!.args).toEqual({ id: HARMONY, root: HARMONY, sources: ['/Users/demo/Desktop/sketch.png'], to: 'docs', onConflict: 'ask' });
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Added sketch.png' });
		expect(rows().map((r) => r.dataset.path)).toContain('docs/sketch.png');
	});

	test('a name that is taken is asked about, and nothing is written until answered', async () => {
		under(null);
		find(el, '.list')!.dispatchEvent(dropEvent('drop', ['README.md']));
		await settle();
		expect(opened).toEqual(['files-conflict']);
		expect(w.sent('files_import').map((c) => c.args.onConflict)).toEqual(['ask']);
		await press(dialog('files-conflict'), 'Keep both');
		expect(w.sent('files_import').map((c) => c.args.onConflict)).toEqual(['ask', 'keep-both']);
		expect(names()).toEqual(expect.arrayContaining(['README.md', 'README 2.md']));
	});

	test('the folder a drop would land in is shown while dragging over', async () => {
		under(row('docs'));
		const over = dropEvent('dragover', []);
		find(el, '.list')!.dispatchEvent(over);
		await settle();
		expect(over.defaultPrevented).toBe(true);
		expect(row('docs').classList.contains('drop')).toBe(true);
		find(el, '.list')!.dispatchEvent(new Event('dragleave', { bubbles: true }));
		await settle();
		expect(row('docs').classList.contains('drop')).toBe(false);
	});
});

describe('an operation the native side refuses', () => {
	test('is said, and the tree is as it was', async () => {
		w.on('files_trash', () => {
			throw appError('error', 'README.md is open in another program');
		});
		await rightClick(row('README.md'));
		await pick('Move to Trash…');
		await press(dialog('files-delete'), 'Move to Trash');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'README.md is open in another program' });
		expect(names()).toContain('README.md');
	});
});
