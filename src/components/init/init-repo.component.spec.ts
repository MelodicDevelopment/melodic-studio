import { beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { FolderInfo, HostCli, InitService } from './init-repo.component';

// Monaco and xterm cannot run in happy-dom; nothing here needs either to arrive.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

const FOLDER = '/Users/demo/Source/new-idea';

let w: World;
let repos: RepoStore;
let init: InitService;
let el: HTMLElement;
/** What the pretend native side says about the folder, and about the host tools. */
let folder: FolderInfo;
let tools: HostCli[];

const GH: HostCli = { provider: 'github', name: 'GitHub', cli: 'gh', installed: true, signedIn: true, account: 'rick', hint: null };
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

async function type(target: Element, text: string): Promise<void> {
	const input = find<HTMLInputElement>(target, 'input, textarea')!;
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}


/**
 * `<ml-dialog #name>` takes its id from the attribute that starts with `#`. happy-dom's parser drops the `#`,
 * so no dialog would be known by the name it is opened by: this puts it back.
 */
const attributeNames = Element.prototype.getAttributeNames;
function dialogNames(): void {
	vi.spyOn(Element.prototype, 'getAttributeNames').mockImplementation(function (this: Element) {
		const found = attributeNames.call(this);
		return this.localName === 'ml-dialog' ? found.map((n) => (n === 'style' || n === 'class' ? n : `#${n}`)) : found;
	});
}

beforeEach(async () => {
	w = await world();
	forgetElements();
	popovers();
	dialogNames();
	folder = {
		path: FOLDER,
		name: 'new-idea',
		exists: true,
		isRepo: false,
		entries: 7,
		hasReadme: false,
		hasGitignore: false,
		detected: ['os', 'node'],
		templates: [['os', 'macOS, Windows and Linux files'], ['editors', 'Editor folders'], ['node', 'Node.js / JavaScript / TypeScript'], ['rust', 'Rust']],
		defaultBranch: 'main',
		authorName: 'Demo Author',
		authorEmail: 'demo@example.com',
	};
	tools = [GH];
	w.on('folder_inspect', () => folder);
	// The demo host answers after a real pause; the host tools are answered here.
	w.on('host_clis', () => tools);
	w.on('host_owners', (args) => (args.provider === 'azure' ? [{ id: 'Music', label: 'Music' }, { id: 'Payments', label: 'Payments' }] : [{ id: 'rick', label: 'rick (your account)' }, { id: 'melodic', label: 'melodic' }]));
	w.on('host_repo_create', (args) => ({ webUrl: `https://github.com/${String(args.owner)}/${String(args.name)}`, remoteUrl: `https://github.com/${String(args.owner)}/${String(args.name)}.git` }));
	w.on('open_url', () => undefined);
	w.on('ci_runs', () => []);
	w.on('pr_existing', () => null);
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	init = w.get((await import('./init-repo.component')).InitService);
	await repos.init();
	el = await mount('ms-init-repo');
});

function inner(): HTMLDialogElement {
	return find(el, 'ml-dialog')!.shadowRoot!.querySelector('dialog')!;
}

/**
 * Opens a folder the way the whole app does, through `InitService.open`. A dialog announces itself from inside
 * its shadow root, and happy-dom does not retarget that event to the `ml-dialog` as a browser does, so it is
 * sent once more from the `ml-dialog` itself, which is where the wizard listens for it.
 */
async function open(path = FOLDER, fresh = false): Promise<boolean> {
	const host = find(el, 'ml-dialog')!;
	let heard = false;
	const probe = (e: Event): void => void (heard ||= e.target === host);
	host.addEventListener('ml:open', probe);
	const taken = await init.open(path, fresh);
	host.removeEventListener('ml:open', probe);
	if (inner().open && !heard) {
		host.dispatchEvent(new CustomEvent('ml:open'));
	}
	await settle();
	return taken;
}

function field(label: string): HTMLElement {
	const found = all(el, 'ml-input, ml-checkbox, ml-select').find((f) => f.getAttribute('label') === label);
	if (!found) {
		throw new Error(`no field "${label}" among: ${all(el, 'ml-input, ml-checkbox, ml-select').map((f) => f.getAttribute('label')).join(' | ')}`);
	}
	return found;
}

function has(label: string): boolean {
	return all(el, 'ml-input, ml-checkbox, ml-select').some((f) => f.getAttribute('label') === label);
}

function ticked(label: string): boolean {
	return find<HTMLInputElement>(field(label), 'input')!.checked;
}

async function tick(label: string, on: boolean): Promise<void> {
	const input = find<HTMLInputElement>(field(label), 'input')!;
	input.checked = on;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

function value(label: string): string {
	return find<HTMLInputElement>(field(label), 'input')!.value;
}

/** The first step done with what it offers: the repository exists and the wizard asks where it should live. */
async function created(fresh = false): Promise<void> {
	await open(FOLDER, fresh);
	await press(el, 'Create repository');
}

async function pick(hostName: string): Promise<void> {
	await click(all(el, '.hosts .host').find((h) => words(h) === hostName)!);
}

function options(): Record<string, unknown> {
	return w.sent('repo_init').at(-1)!.args.options as Record<string, unknown>;
}

describe('opening a folder', () => {
	test('a folder that is a repository is added, and the wizard stays shut', async () => {
		folder = { ...folder, path: '/Users/demo/Source/tempo', name: 'tempo', isRepo: true };
		expect(await open('/Users/demo/Source/tempo')).toBe(true);
		expect(w.sent('repo_add').at(-1)!.args.path).toBe('/Users/demo/Source/tempo');
		expect(inner().open).toBe(false);
		expect(repos.repo()!.name).toBe('tempo');
	});

	test('a folder that is not one yet starts the wizard, and nothing is created by opening it', async () => {
		expect(await open()).toBe(true);
		expect(inner().open).toBe(true);
		expect(words(find(el, 'h3')!)).toBe('Set up a repository');
		expect(words(find(el, '.dlg p')!)).toBe(`${FOLDER} is not a git repository yet. It holds 7 items.`);
		expect(w.sent('repo_init')).toEqual([]);
		expect(w.sent('repo_add')).toEqual([]);
		expect(repos.repo()!.name).toBe('harmony');
	});

	test('an empty folder, and one that does not exist yet, are said as that', async () => {
		folder = { ...folder, entries: 0 };
		await open();
		expect(words(find(el, '.dlg p')!)).toBe(`${FOLDER} is empty.`);
		expect(has('Make a first commit')).toBe(true);
		folder = { ...folder, exists: false };
		await open();
		expect(words(find(el, '.dlg p')!)).toBe(`${FOLDER} does not exist yet and will be created.`);
	});

	test('a folder that cannot be looked at is said, and nothing opens', async () => {
		w.on('folder_inspect', () => {
			throw appError('error', 'Permission denied');
		});
		expect(await open()).toBe(false);
		expect(inner().open).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'Permission denied' });
	});
});

describe('setting it up', () => {
	test('starts from what the folder looks like', async () => {
		await open();
		expect(value('Default branch')).toBe('main');
		expect(all(el, '.chips ml-checkbox').map((c) => [c.getAttribute('label'), find<HTMLInputElement>(c, 'input')!.checked])).toEqual([
			['macOS, Windows and Linux files', true],
			['Editor folders', false],
			['Node.js / JavaScript / TypeScript', true],
			['Rust', false],
		]);
		expect(ticked('Add a README')).toBe(true);
		expect(ticked('Commit what is in the folder now')).toBe(true);
		expect(value('Commit message')).toBe('Initial commit');
		expect(has('Your name')).toBe(false);
	});

	test('"Create repository" runs git init with those choices and opens the new repository', async () => {
		await open();
		await press(el, 'Create repository');
		expect(w.sent('repo_init').length).toBe(1);
		expect(w.sent('repo_init')[0].args).toEqual({ path: FOLDER, options: { branch: 'main', gitignore: ['os', 'node'], readme: true, commit: true, message: 'Initial commit', authorName: null, authorEmail: null } });
		expect(repos.repo()!.name).toBe('new-idea');
		expect(words(find(el, 'h3')!)).toBe('Where should it live?');
	});

	test('the choices made are the ones sent', async () => {
		await open();
		const branch = find<HTMLInputElement>(field('Default branch'), 'input')!;
		branch.value = 'trunk line';
		branch.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(value('Default branch')).toBe('trunk-line');
		await tick('Rust', true);
		await tick('macOS, Windows and Linux files', false);
		await tick('Add a README', false);
		await type(field('Commit message'), 'Start');
		await press(el, 'Create repository');
		expect(options()).toMatchObject({ branch: 'trunk-line', gitignore: ['node', 'rust'], readme: false, message: 'Start' });
	});

	test('without a first commit there is no message to write', async () => {
		await open();
		await tick('Commit what is in the folder now', false);
		expect(has('Commit message')).toBe(false);
		await press(el, 'Create repository');
		expect(options().commit).toBe(false);
	});

	test('an existing README is kept: the wizard does not offer to add one', async () => {
		folder = { ...folder, hasReadme: true };
		await open();
		expect(has('Add a README')).toBe(false);
		await press(el, 'Create repository');
		expect(options().readme).toBe(false);
	});

	test('an existing .gitignore is added to, and the wizard says so', async () => {
		folder = { ...folder, hasGitignore: true };
		await open();
		expect(words(find(el, '.field .hint')!)).toBe('Added to the .gitignore that is already there.');
	});

	test('without a .gitignore nothing is said about one being there', async () => {
		await open();
		expect(find(el, '.field .hint')).toBeNull();
	});

	test('needs a branch name', async () => {
		await open();
		await type(field('Default branch'), '');
		expect(isOff(el, 'Create repository')).toBe(true);
		await press(el, 'Create repository');
		expect(w.sent('repo_init')).toEqual([]);
	});

	test('when git does not know who commits, a name and email are asked for, for this repository', async () => {
		folder = { ...folder, authorName: '', authorEmail: '' };
		await open();
		expect(words(find(el, '.warn')!)).toBe('Git does not know who you are yet. This name and email go on your commits in this repository.');
		expect(isOff(el, 'Create repository')).toBe(true);
		await type(field('Your name'), 'Rick');
		expect(isOff(el, 'Create repository')).toBe(true);
		await type(field('Email'), 'rick@example.com');
		await press(el, 'Create repository');
		expect(options()).toMatchObject({ authorName: 'Rick', authorEmail: 'rick@example.com' });
	});

	test('with no first commit nobody needs to be named', async () => {
		folder = { ...folder, authorName: '', authorEmail: '' };
		await open();
		await tick('Commit what is in the folder now', false);
		expect(has('Your name')).toBe(false);
		expect(isOff(el, 'Create repository')).toBe(false);
	});

	test('a folder git refuses (inside another repository) is said, and the wizard stays on this step', async () => {
		w.on('repo_init', () => {
			throw appError('error', `${FOLDER} is inside the repository at /Users/demo/Source`);
		});
		await open();
		await press(el, 'Create repository');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: `${FOLDER} is inside the repository at /Users/demo/Source` });
		expect(words(find(el, 'h3')!)).toBe('Set up a repository');
		expect(repos.repo()!.name).toBe('harmony');
	});

	test('Cancel closes the wizard and creates nothing', async () => {
		await open();
		await press(el, 'Cancel');
		expect(inner().open).toBe(false);
		expect(init.folder()).toBeNull();
		expect(w.sent('repo_init')).toEqual([]);
	});

	test('the next folder starts over', async () => {
		await open();
		await tick('Rust', true);
		await type(field('Commit message'), 'Mine');
		await press(el, 'Cancel');
		await open();
		expect(ticked('Rust')).toBe(false);
		expect(value('Commit message')).toBe('Initial commit');
	});
});

describe('where it should live', () => {
	test('starts on "This computer only", and Close leaves it there', async () => {
		await created();
		expect(all(el, '.hosts .host').map((h) => words(h))).toEqual(['This computer only', 'GitHub', 'Azure DevOps', 'GitLab', 'Bitbucket', 'Another host']);
		expect(all(el, '.hosts .host.on').map((h) => words(h))).toEqual(['This computer only']);
		expect(words(find(el, '.dlg .hint')!)).toBe('Nothing leaves this computer. You can publish it later from the toolbar.');
		expect(all(el, '.foot ml-button').map((b) => words(b))).toEqual(['Close']);
		await press(el, 'Close');
		expect(inner().open).toBe(false);
		expect(w.sent('host_repo_create')).toEqual([]);
		expect(w.sent('push')).toEqual([]);
	});

	test('a host whose tool is signed in: owner, name and visibility, with the folder\'s name to begin with', async () => {
		await created();
		await pick('GitHub');
		expect(words(find(el, '.dlg .hint')!)).toBe('Signed in to GitHub as rick through gh . Melodic Studio creates the repository, sets it as origin and pushes.');
		expect(w.sent('host_owners').at(-1)!.args).toEqual({ provider: 'github', org: null });
		expect(words(find(field('Owner'), '.ml-select__value')!)).toBe('rick (your account)');
		expect(value('Repository name')).toBe('new-idea');
		expect(ticked('Private')).toBe(true);
		expect(w.sent('host_repo_create')).toEqual([]);
	});

	test('"Create and push" creates the remote repository, sets it as origin and pushes: only on that click', async () => {
		await created();
		await pick('GitHub');
		await click(all(field('Owner'), '.ml-select__option').find((o) => words(o) === 'melodic')!);
		await type(field('Repository name'), 'my idea');
		expect(value('Repository name')).toBe('my-idea');
		expect(w.sent('host_repo_create')).toEqual([]);
		await press(el, 'Create and push');
		expect(w.sent('host_repo_create').map((c) => c.args)).toEqual([{ provider: 'github', name: 'my-idea', owner: 'melodic', private: true, org: null }]);
		expect(w.sent('remote_set').at(-1)!.args.url).toBe('https://github.com/melodic/my-idea.git');
		const order = w.calls.map((c) => c.cmd).filter((c) => ['host_repo_create', 'remote_set', 'push'].includes(c));
		expect(order).toEqual(['host_repo_create', 'remote_set', 'push']);
		expect(inner().open).toBe(false);
	});

	// A bug until 2026-11-23, a small one (init-repo.template.ts, the Repository name field; the branch-name fields elsewhere
	// work the same way): a space typed is turned into a dash, and the field is given the new value. When that
	// value is what the field held before ("new-idea" with its dash replaced by a space is "new-idea" again),
	// nothing changed for Melodic, so nothing is drawn again. What holds now: the field shows "new-idea", which is what
	// will be sent. Before the fix: it goes on showing "new idea".
	test('the name shown is the name that will be used, also when a dash is typed over with a space', async () => {
		await created();
		await pick('GitHub');
		await type(field('Repository name'), 'new idea');
		expect(value('Repository name')).toBe('new-idea');
	});

	test('a public repository is asked for by unticking Private', async () => {
		await created();
		await pick('GitHub');
		await tick('Private', false);
		await press(el, 'Create and push');
		expect(w.sent('host_repo_create').at(-1)!.args.private).toBe(false);
	});

	test('"Skip for now" creates nothing on the host', async () => {
		await created();
		await pick('GitHub');
		await press(el, 'Skip for now');
		expect(inner().open).toBe(false);
		expect(w.sent('host_repo_create')).toEqual([]);
		expect(w.sent('remote_set')).toEqual([]);
	});

	test('a host that refuses says why, and the wizard stays for another try', async () => {
		w.on('host_repo_create', () => {
			throw appError('error', 'Name already exists on this account');
		});
		await created();
		await pick('GitHub');
		await press(el, 'Create and push');
		expect(words(find(el, '.warn.bad')!)).toBe('Name already exists on this account');
		expect(inner().open).toBe(true);
		expect(w.sent('push')).toEqual([]);
	});

	test('a first push that fails leaves the remote set and says how to go on', async () => {
		w.on('push', () => {
			throw appError('auth', 'Permission denied (publickey)');
		});
		await created();
		await pick('GitHub');
		await press(el, 'Create and push');
		expect(words(find(el, '.warn.bad')!)).toBe('The remote was set as origin, but the first push did not go through. You can push again from the toolbar.');
		expect(inner().open).toBe(true);
	});

	test('Azure DevOps asks for the organization first, then the project', async () => {
		tools = [GH, { provider: 'azure', name: 'Azure DevOps', cli: 'az', installed: true, signedIn: true, account: null, hint: null }];
		await created();
		await pick('Azure DevOps');
		expect(w.sent('host_owners')).toEqual([]);
		expect(isOff(el, 'Find projects')).toBe(true);
		expect(isOff(el, 'Create and push')).toBe(true);
		expect(has('Private')).toBe(false);
		await type(field('Organization'), 'https://dev.azure.com/contoso');
		await press(el, 'Find projects');
		expect(w.sent('host_owners').at(-1)!.args).toEqual({ provider: 'azure', org: 'https://dev.azure.com/contoso' });
		expect(words(find(field('Project'), '.ml-select__value')!)).toBe('Music');
		await press(el, 'Create and push');
		expect(w.sent('host_repo_create').at(-1)!.args).toMatchObject({ provider: 'azure', owner: 'Music', org: 'https://dev.azure.com/contoso' });
	});
});

describe('a host whose tool cannot be used', () => {
	const SIGNED_OUT: HostCli = { ...GH, signedIn: false, account: null, hint: 'Run `gh auth login` in a terminal.' };

	test('says what would let Studio create it, and falls back to the host\'s own page and a pasted URL', async () => {
		tools = [SIGNED_OUT];
		await created();
		await pick('GitHub');
		expect(words(find(el, '.warn')!)).toBe('To create it from here: Run `gh auth login` in a terminal. Until then, create it on GitHub and paste its URL.');
		expect(w.sent('host_owners')).toEqual([]);
		expect(isOff(el, 'Add remote and push')).toBe(true);
		await press(el, 'Create it on GitHub');
		expect(w.sent('open_url').at(-1)!.args.url).toBe('https://github.com/new');
	});

	test('the pasted URL becomes origin and is pushed to; nothing is created on the host', async () => {
		tools = [SIGNED_OUT];
		await created();
		await pick('GitHub');
		await type(field('Repository URL'), ' git@github.com:rick/new-idea.git ');
		await press(el, 'Add remote and push');
		expect(w.sent('host_repo_create')).toEqual([]);
		expect(w.sent('remote_set').at(-1)!.args.url).toBe('git@github.com:rick/new-idea.git');
		expect(w.sent('push').length).toBe(1);
		expect(inner().open).toBe(false);
	});

	test('a host with no tool at all (Bitbucket) works the same way', async () => {
		await created();
		await pick('Bitbucket');
		expect(find(el, '.warn')).toBeNull();
		await press(el, 'Create it on Bitbucket');
		expect(w.sent('open_url').at(-1)!.args.url).toBe('https://bitbucket.org/repo/create');
		expect(has('Repository URL')).toBe(true);
	});

	test('"Another host" has no page to open, only the URL', async () => {
		await created();
		await pick('Another host');
		expect(words(find(el, '.dlg p.hint')!)).toBe('Create an empty repository on your git host, then paste its URL.');
		expect(all(el, '.dlg ml-button')).toEqual([]);
	});

	test('a repository with no commit yet gets the remote set, and is told to push after the first commit', async () => {
		tools = [SIGNED_OUT];
		await created();
		const status = repos.status()!;
		w.on('repo_status', () => ({ ...status, hasCommits: false }));
		await repos.refresh();
		await pick('GitHub');
		await type(field('Repository URL'), 'git@github.com:rick/new-idea.git');
		await press(el, 'Add remote and push');
		expect(w.sent('remote_set').length).toBe(1);
		expect(w.sent('push')).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Remote added', message: 'Push after your first commit.' });
	});
});

describe('a project just made by New Project', () => {
	test('is offered GitHub first', async () => {
		await created(true);
		expect(all(el, '.hosts .host.on').map((h) => words(h))).toEqual(['GitHub']);
	});

	test('the host and owner chosen are offered first the next time', async () => {
		await created(true);
		await click(all(field('Owner'), '.ml-select__option').find((o) => words(o) === 'melodic')!);
		await press(el, 'Create and push');
		expect(JSON.parse(localStorage.getItem('studio.new-project.host')!)).toEqual({ where: 'github', owner: 'melodic', org: '' });

		await created(true);
		expect(all(el, '.hosts .host.on').map((h) => words(h))).toEqual(['GitHub']);
		expect(words(find(field('Owner'), '.ml-select__value')!)).toBe('melodic');
	});

	test('a folder opened any other way starts on "This computer only" whatever was chosen before', async () => {
		localStorage.setItem('studio.new-project.host', JSON.stringify({ where: 'gitlab', owner: '', org: '' }));
		await created();
		expect(all(el, '.hosts .host.on').map((h) => words(h))).toEqual(['This computer only']);
	});
});
