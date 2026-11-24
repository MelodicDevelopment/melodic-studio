import { beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { DialogName, Prompt, RepoStore } from '../../services/repo.store';
import type { BackendService } from '../../services/backend.service';

// What is laid out in the dialogs' template: every dialog and its heading, Add a repository (open, scan, clone,
// create) and Settings. The confirmations and the branch dialogs are in dialogs.component.spec.ts.

// Monaco and xterm cannot run in happy-dom; nothing here needs either to arrive.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

let w: World;
let repos: RepoStore;
let backend: BackendService;
let el: HTMLElement;

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
	backend = w.get((await import('../../services/backend.service')).BackendService);
	await repos.init();
	el = await mount('ms-dialogs');
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

/** A tab of an `ml-tabs` by its label. */
async function tab(root: Element, label: string): Promise<void> {
	await click(find(find(root, `ml-tab[label="${label}"]`)!, 'button'));
}

describe('every dialog', () => {
	const HEADINGS: [DialogName, string][] = [
		['add-repo', 'Add a repository'],
		['new-branch', 'New branch'],
		['rename-branch', 'Rename branch'],
		['delete-branch', 'Delete branch'],
		['new-tag', 'Create tag'],
		['reset', 'Reset branch'],
		['force-push', 'Push was rejected'],
		['publish', 'Publish repository'],
		['discard', 'Discard changes'],
		['remove-repo', 'Remove repository'],
		['settings', 'Settings'],
	];

	test('opens through RepoStore.ask, by itself, under its own heading', async () => {
		for (const [name, heading] of HEADINGS) {
			expect(isOpen(name), name).toBe(false);
			const d = await ask(name, { branch: 'main' });
			expect(isOpen(name), name).toBe(true);
			expect(words(find(d, 'h3')!)).toBe(heading);
			expect(all(el, 'ml-dialog').filter((x) => x.shadowRoot!.querySelector('dialog')!.open).length, name).toBe(1);
			repos.closeDialog(name);
		}
	});

	test('Cancel closes it and does nothing else', async () => {
		for (const [name] of HEADINGS.filter(([n]) => n !== 'settings')) {
			const d = await ask(name, { branch: 'main', files: repos.status()!.files, repo: repos.repo()! });
			const before = w.calls.length;
			await press(d, 'Cancel');
			expect(isOpen(name), name).toBe(false);
			expect(w.calls.slice(before).map((c) => c.cmd), name).toEqual([]);
		}
	});
});

describe('add a repository', () => {
	test('opens on "Open a folder", with nothing to open yet', async () => {
		const d = await ask('add-repo');
		expect(words(d)).toContain('Pick any folder on this computer.');
		expect(isOff(d, 'Open folder')).toBe(true);
	});

	test('opens on the tab it was asked for', async () => {
		const d = await ask('add-repo', { tab: 'clone' });
		expect(field(d, 'Repository URL')).toBeDefined();
		expect(button(d, 'Clone')).toBeDefined();
	});

	test('"Choose…" fills the path with the folder picked', async () => {
		const d = await ask('add-repo');
		await press(d, 'Choose…');
		expect(w.sent('pick_folder').length).toBe(1);
		expect(value(d, 'Local path')).toBe('/Users/demo/Source');
	});

	test('a folder that is a repository is added and opened', async () => {
		const d = await ask('add-repo');
		await type(field(d, 'Local path'), ' /Users/demo/Source/tempo ');
		await press(d, 'Open folder');
		expect(w.sent('folder_inspect').at(-1)!.args.path).toBe('/Users/demo/Source/tempo');
		expect(w.sent('repo_add').at(-1)!.args.path).toBe('/Users/demo/Source/tempo');
		expect(repos.repo()!.name).toBe('tempo');
		expect(isOpen('add-repo')).toBe(false);
	});

	test('a folder that is not a repository yet is not added: the setup wizard takes over', async () => {
		const { InitService } = await import('../init/init-repo.component');
		await mount('ms-init-repo');
		const d = await ask('add-repo');
		await type(field(d, 'Local path'), '/Users/demo/Source/new-idea');
		await press(d, 'Open folder');
		expect(w.sent('repo_add')).toEqual([]);
		expect(w.get(InitService).folder()!.path).toBe('/Users/demo/Source/new-idea');
		expect(isOpen('init-repo')).toBe(true);
		expect(repos.repo()!.name).toBe('harmony');
		expect(isOpen('add-repo')).toBe(false);
	});

	test('a folder that cannot be read keeps the dialog open', async () => {
		w.on('folder_inspect', () => {
			throw appError('error', 'No such folder');
		});
		const d = await ask('add-repo');
		await type(field(d, 'Local path'), '/nowhere');
		await press(d, 'Open folder');
		expect(isOpen('add-repo')).toBe(true);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'No such folder' });
	});

	test('Clone needs a URL and a folder, then clones', async () => {
		const d = await ask('add-repo');
		await tab(d, 'Clone');
		await type(field(d, 'Repository URL'), 'git@github.com:melodic-demo/tempo.git');
		expect(isOff(d, 'Clone')).toBe(true);
		await type(field(d, 'Clone into'), '/Users/demo/Source');
		await press(d, 'Clone');
		expect(w.sent('repo_clone').at(-1)!.args).toMatchObject({ url: 'git@github.com:melodic-demo/tempo.git', parent: '/Users/demo/Source' });
		expect(repos.repo()!.name).toBe('tempo');
	});

	test('"Create new" hands the new folder to the setup wizard', async () => {
		const { InitService } = await import('../init/init-repo.component');
		await mount('ms-init-repo');
		const d = await ask('add-repo');
		await tab(d, 'Create new');
		await type(field(d, 'Name'), 'new-project');
		expect(isOff(d, 'Continue')).toBe(true);
		await type(field(d, 'Create in'), '/Users/demo/Source');
		await press(d, 'Continue');
		expect(w.sent('folder_inspect').at(-1)!.args.path).toBe('/Users/demo/Source/new-project');
		expect(w.get(InitService).folder()!.name).toBe('new-project');
		expect(w.sent('repo_create')).toEqual([]);
	});

	test('opened from the tab strip\'s plus, the repository goes in a tab of its own', async () => {
		const d = await ask('add-repo', { newTab: true });
		await type(field(d, 'Local path'), '/Users/demo/Source/tempo');
		await press(d, 'Open folder');
		expect(repos.repoTabList().map((r) => r.name)).toEqual(['harmony', 'tempo']);
	});

	test('otherwise it takes the place of the one on screen', async () => {
		const d = await ask('add-repo');
		await type(field(d, 'Local path'), '/Users/demo/Source/tempo');
		await press(d, 'Open folder');
		expect(repos.repoTabList().map((r) => r.name)).toEqual(['tempo']);
	});
});

describe('scan a folder', () => {
	async function scanned(): Promise<HTMLElement> {
		const d = await ask('add-repo', { tab: 'scan' });
		await type(field(d, 'Folder'), '/Users/demo/Source/');
		await press(d, 'Scan');
		return d;
	}

	function rowsOf(d: Element): HTMLElement[] {
		return all(d, '.scan-row');
	}

	function rowOf(d: Element, name: string): HTMLElement {
		return rowsOf(d).find((r) => find(r, '.scan-name')!.firstChild!.textContent === name)!;
	}

	test('Scan is off until a folder is named', async () => {
		const d = await ask('add-repo', { tab: 'scan' });
		expect(isOff(d, 'Scan')).toBe(true);
		expect(isOff(d, 'Add')).toBe(true);
	});

	test('lists what it found under their hosts, and adds nothing', async () => {
		const d = await scanned();
		expect(w.sent('repo_scan').at(-1)!.args.root).toBe('/Users/demo/Source/');
		expect(rowsOf(d).map((r) => find(r, '.scan-name')!.firstChild!.textContent)).toEqual(['dotfiles', 'harmony', 'tempo', 'cadence', 'billing-api', 'ledger', 'site', 'scratch']);
		expect(all(d, '.scan-host').map((h) => find(h, 'ml-checkbox')!.getAttribute('label'))).toEqual(['GitHub (3)', 'Azure DevOps (3)', 'Bitbucket (1)', 'No remote (1)']);
		expect(w.sent('repo_add_many')).toEqual([]);
		expect(w.sent('repo_add')).toEqual([]);
	});

	test('nothing is ticked to begin with', async () => {
		const d = await scanned();
		expect(words(find(d, '.scan-count')!)).toBe('0 selected');
		expect(rowsOf(d).filter((r) => !r.classList.contains('added')).every((r) => !ticked(find(r, 'ml-checkbox')!))).toBe(true);
		expect(isOff(d, 'Add')).toBe(true);
	});

	test('repositories already in Studio are marked and cannot be ticked', async () => {
		const d = await scanned();
		expect(words(find(d, '.scan-head')!)).toContain('8 found, 2 already added');
		for (const name of ['harmony', 'cadence']) {
			expect(words(find(rowOf(d, name), '.scan-tag')!)).toBe('Added');
			expect(find(rowOf(d, name), 'ml-checkbox')!.hasAttribute('disabled')).toBe(true);
		}
		expect(find(rowOf(d, 'tempo'), '.scan-tag')).toBeNull();
	});

	test('ticking repositories and pressing Add adds those, and leaves the open repository open', async () => {
		const d = await scanned();
		await tick(find(rowOf(d, 'tempo'), 'ml-checkbox')!, true);
		await tick(find(rowOf(d, 'site'), 'ml-checkbox')!, true);
		expect(words(find(d, '.scan-count')!)).toBe('2 selected');
		await press(d, 'Add 2');
		expect(w.sent('repo_add_many').at(-1)!.args.paths).toEqual(['/Users/demo/Source/tempo', '/Users/demo/Source/site']);
		expect(repos.repo()!.name).toBe('harmony');
		expect(repos.app()!.repos.map((r) => r.name).sort()).toEqual(['cadence', 'harmony', 'site', 'tempo']);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Added 2 repositories' });
		expect(isOpen('add-repo')).toBe(false);
	});

	test('a host\'s box ticks everything under it that is not added yet', async () => {
		const d = await scanned();
		await tick(find(all(d, '.scan-host')[1], 'ml-checkbox')!, true);
		expect(words(find(d, '.scan-count')!)).toBe('2 selected');
		expect(ticked(find(rowOf(d, 'billing-api'), 'ml-checkbox')!)).toBe(true);
		expect(ticked(find(rowOf(d, 'ledger'), 'ml-checkbox')!)).toBe(true);
	});

	test('the box at the top ticks every new one', async () => {
		const d = await scanned();
		await tick(find(d, '.scan-head ml-checkbox')!, true);
		expect(words(find(d, '.scan-count')!)).toBe('6 selected');
		expect(button(d, 'Add 6')).toBeDefined();
	});

	test('a folder with no repositories says so', async () => {
		w.on('repo_scan', () => ({ repos: [], truncated: false }));
		const d = await scanned();
		expect(words(find(d, '.scan-none')!)).toBe('No repositories in that folder.');
	});

	test('a scan that stopped early says so', async () => {
		w.on('repo_scan', () => ({ repos: [{ path: '/big/one', name: 'one', added: false, origin: null }], truncated: true }));
		const d = await scanned();
		expect(words(find(d, '.warn')!)).toContain('the scan stopped early');
	});

	test('Enter in the folder box scans', async () => {
		const d = await ask('add-repo', { tab: 'scan' });
		await type(field(d, 'Folder'), '/Users/demo/Source');
		field(d, 'Folder').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		expect(w.sent('repo_scan').length).toBe(1);
	});

	test('what was found last time is gone when the dialog opens again', async () => {
		const d = await scanned();
		await press(d, 'Cancel');
		await ask('add-repo', { tab: 'scan' });
		expect(rowsOf(d)).toEqual([]);
	});
});

describe('settings: who commits', () => {
	function who(d: Element): string[] {
		return all(d, '.who ml-input').map((i) => `${i.getAttribute('label')}: ${find<HTMLInputElement>(i, 'input')!.value}`);
	}

	test('shows git\'s global name and email, and the repository uses them', async () => {
		const d = await ask('settings');
		expect(w.sent('identity_get').at(-1)!.args.id).toBe(repos.repo()!.id);
		expect(who(d)).toEqual(['Name: Demo Author', 'Email: demo@example.com']);
		expect(ticked(field(d, 'Use a different name and email in harmony'))).toBe(false);
		expect(words(d)).toContain("Every repository, through git's global config.");
	});

	test('Done with nothing changed writes nothing', async () => {
		const d = await ask('settings');
		await press(d, 'Done');
		expect(w.sent('identity_set')).toEqual([]);
		expect(isOpen('settings')).toBe(false);
	});

	test('a changed name is saved globally', async () => {
		const d = await ask('settings');
		await type(all(d, '.who ml-input')[0], 'Rick');
		await press(d, 'Done');
		expect(w.sent('identity_set').map((c) => c.args)).toEqual([{ id: null, identity: { name: 'Rick', email: 'demo@example.com' } }]);
		expect(repos.app()!.authorName).toBe('Rick');
	});

	test('ticking the box offers a pair for this repository, starting from the global one', async () => {
		const d = await ask('settings');
		await tick(field(d, 'Use a different name and email in harmony'), true);
		expect(who(d)).toEqual(['Name: Demo Author', 'Email: demo@example.com', 'Name: Demo Author', 'Email: demo@example.com']);
	});

	test('a different identity for the repository is saved for it alone', async () => {
		const d = await ask('settings');
		await tick(field(d, 'Use a different name and email in harmony'), true);
		await type(all(d, '.who ml-input')[3], 'work@example.com');
		await press(d, 'Done');
		expect(w.sent('identity_set').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, identity: { name: 'Demo Author', email: 'work@example.com' } }]);
	});

	test('a repository that has its own shows it, and unticking removes it', async () => {
		await backend.setIdentity(repos.repo()!.id, { name: 'Work Me', email: 'work@example.com' });
		w.calls.length = 0;
		const d = await ask('settings');
		expect(ticked(field(d, 'Use a different name and email in harmony'))).toBe(true);
		expect(who(d).slice(2)).toEqual(['Name: Work Me', 'Email: work@example.com']);
		await tick(field(d, 'Use a different name and email in harmony'), false);
		await press(d, 'Done');
		expect(w.sent('identity_set').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, identity: null }]);
	});

	test('git refusing keeps the dialog open', async () => {
		w.on('identity_set', () => {
			throw appError('git', 'error: could not lock config file');
		});
		const d = await ask('settings');
		await type(all(d, '.who ml-input')[0], 'Rick');
		await press(d, 'Done');
		expect(isOpen('settings')).toBe(true);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'error: could not lock config file' });
	});

	test('shows the versions of git and of the app', async () => {
		const d = await ask('settings');
		expect(all(d, 'dl > *').map((n) => words(n))).toEqual(['Git', '2.47.0 (demo)', 'Melodic Studio', '0.1.0']);
	});

	test('git missing is said', async () => {
		const app = repos.app()!;
		w.on('app_status', () => ({ ...app, gitVersion: null }));
		await repos.switchContext();
		const d = await ask('settings');
		expect(words(find(d, 'dd')!)).toBe('Not found on this computer');
	});
});

describe('settings: the rest', () => {
	function shown(d: Element): string[] {
		return all(d, '.pane')
			.filter((p) => p.style.display !== 'none')
			.map((p) => p.firstElementChild!.localName);
	}

	test('opens on General', async () => {
		const d = await ask('settings');
		expect(shown(d)).toEqual(['ml-select']);
	});

	test.each([
		['Editor', 'ms-editor-settings'],
		['Accounts', 'ms-accounts'],
		['Language servers', 'ms-language-servers'],
	])('the %s tab shows its section', async (label, tag) => {
		w.on('host_clis', () => []);
		const d = await ask('settings');
		await tab(d, label);
		expect(shown(d)).toEqual([tag]);
	});

	test('opens on the section it was asked for', async () => {
		const d = await ask('settings', { settingsTab: 'language-servers' });
		expect(shown(d)).toEqual(['ms-language-servers']);
	});

	test('picking an appearance applies it at once and remembers it', async () => {
		const d = await ask('settings');
		await choose(field(d, 'Appearance'), 'Light');
		expect(localStorage.getItem('studio.theme')).toBe('light');
		expect(document.documentElement.getAttribute('data-theme')).toBe('light');
		await choose(field(d, 'Appearance'), 'Dark');
		expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
	});
});
