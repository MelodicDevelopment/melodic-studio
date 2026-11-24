import { beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { InitService } from '../init/init-repo.component';
import type { ProjectTemplate } from '../../services/backend.service';

// Monaco and xterm cannot run in happy-dom; nothing here needs either to arrive.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

let w: World;
let repos: RepoStore;
let el: HTMLElement;
/** The run the pretend native side has going: settle it to end the run. */
let run: { done: (path: string) => void; fail: (error: unknown) => void } | null;
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
	run = null;
	// The demo's own run prints on timers and takes a second and a half: this one ends when the test says.
	w.on('project_create', () => new Promise((done, fail) => (run = { done, fail })));
	w.on('project_stop', () => run?.fail(appError('error', 'Stopped')));
	w.on('host_clis', () => []);
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	await repos.init();
	el = await mount('ms-new-project');
});

function inner(): HTMLDialogElement {
	return find(el, 'ml-dialog')!.shadowRoot!.querySelector('dialog')!;
}

/**
 * Opens the dialog as File > New Project does, through `RepoStore.ask`. A dialog announces itself from inside its
 * shadow root, and happy-dom does not retarget that event to the `ml-dialog` as a browser does, so it is sent
 * once more from the `ml-dialog` itself, which is where the component listens for it.
 */
async function open(): Promise<void> {
	const host = find(el, 'ml-dialog')!;
	let heard = false;
	const probe = (e: Event): void => void (heard ||= e.target === host);
	host.addEventListener('ml:open', probe);
	repos.ask('new-project');
	host.removeEventListener('ml:open', probe);
	if (!heard) {
		host.dispatchEvent(new CustomEvent('ml:open'));
	}
	await settle();
}

function field(label: string): HTMLElement {
	const found = all(el, 'ml-input, ml-checkbox, ml-select').find((f) => f.getAttribute('label') === label);
	if (!found) {
		throw new Error(`no field "${label}" among: ${all(el, 'ml-input, ml-checkbox, ml-select').map((f) => f.getAttribute('label')).join(' | ')}`);
	}
	return found;
}

function labels(): string[] {
	return all(el, '.form ml-input, .form ml-checkbox, .form ml-select').map((f) => f.getAttribute('label') ?? '');
}

function value(label: string): string {
	return find<HTMLInputElement>(field(label), 'input')!.value;
}

async function tick(label: string, on: boolean): Promise<void> {
	const input = find<HTMLInputElement>(field(label), 'input')!;
	input.checked = on;
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

function template(name: string): HTMLElement {
	return all(el, '.tpl').find((t) => find(t, 'b')!.textContent === name)!;
}

function request(): { template: string; parent: string; name: string; options: Record<string, string> } {
	return w.sent('project_create').at(-1)!.args.request as never;
}

/** A project named and started, the template's tool still running. */
async function started(name = 'my-app'): Promise<void> {
	await open();
	await type(field('Name'), name);
	await press(el, 'Create');
}

describe('the dialog', () => {
	test('opens through RepoStore.ask with the templates in their groups, the first one picked', async () => {
		await open();
		expect(inner().open).toBe(true);
		expect(all(el, '.list > *').map((n) => (n.classList.contains('group') ? `[${n.textContent}]` : find(n, 'b')!.textContent))).toEqual([
			'[Melodic]', 'Melodic JS', 'Melodic PHP',
			'[Popular]', 'Angular', 'React', 'Vue', 'Svelte', 'Next.js', 'Laravel', '.NET', 'Rust',
			'[Other]', 'Empty folder',
		]);
		expect(all(el, '.tpl.on').map((t) => find(t, 'b')!.textContent)).toEqual(['Melodic JS']);
		expect(words(find(el, '.form p')!)).toBe('Melodic JS : A Melodic app with Melodic Components, through the Melodic CLI.');
	});

	test('starts with no name, in the folder the open repository is in, and cannot create yet', async () => {
		await open();
		expect(value('Name')).toBe('');
		expect(value('Create in').replace(/\/$/, '')).toBe('/Users/demo/Source');
		expect(isOff(el, 'Create')).toBe(true);
		expect(find(el, '.where')).toBeNull();
	});

	test('shows where the project will be', async () => {
		await open();
		await type(field('Name'), 'my-app');
		expect(words(find(el, '.where')!)).toBe('/Users/demo/Source/my-app');
		expect(isOff(el, 'Create')).toBe(false);
	});

	test('says what the name may look like, for the template\'s own tool', async () => {
		await open();
		expect(field('Name').getAttribute('hint')).toBe('Use lowercase letters, digits and single dashes, starting with a letter (my-app).');
	});

	test('"Choose…" takes the folder picked', async () => {
		w.on('pick_folder', () => '/Users/demo/Projects');
		await open();
		await press(el, 'Choose…');
		expect(value('Create in')).toBe('/Users/demo/Projects');
	});

	test('says that the setup wizard comes afterwards', async () => {
		await open();
		expect(words(find(el, '.form small')!)).toBe('Afterwards the setup wizard creates the git repository and, if you like, the repository on GitHub, Azure DevOps, GitLab or Bitbucket.');
	});

	test('Cancel closes it and makes nothing', async () => {
		await open();
		await type(field('Name'), 'my-app');
		await press(el, 'Cancel');
		expect(inner().open).toBe(false);
		expect(w.sent('project_create')).toEqual([]);
	});

	test('the name typed last time is gone when it opens again', async () => {
		await open();
		await type(field('Name'), 'left-over');
		await press(el, 'Cancel');
		await open();
		expect(value('Name')).toBe('');
	});
});

describe('a template\'s options', () => {
	test('come with the template, at their defaults', async () => {
		await open();
		expect(labels()).toEqual(['Name', 'Create in', 'Monorepo (apps/ and libs/ with npm workspaces)', 'Add testing (Vitest)']);
		await type(field('Name'), 'my-app');
		await press(el, 'Create');
		expect(request()).toEqual({ template: 'melodic-js', parent: value('Create in'), name: 'my-app', options: { monorepo: 'false', app: 'web', testing: 'true' } });
		expect(Object.keys(w.sent('project_create').at(-1)!.args)).toEqual(['request']);
	});

	test('an option that depends on another shows once that one is on', async () => {
		await open();
		await tick('Monorepo (apps/ and libs/ with npm workspaces)', true);
		expect(labels()).toContain("First app's name");
		await type(field("First app's name"), 'studio');
		await type(field('Name'), 'my-app');
		await press(el, 'Create');
		expect(request().options).toEqual({ monorepo: 'true', app: 'studio', testing: 'true' });
	});

	test('another template brings its own options', async () => {
		await open();
		await click(template('.NET'));
		expect(labels()).toEqual(['Name', 'Create in', 'Kind']);
		await click(all(field('Kind'), '.ml-select__option').find((o) => words(o) === 'Console app')!);
		await type(field('Name'), 'Tool');
		await press(el, 'Create');
		expect(request()).toMatchObject({ template: 'dotnet', options: { kind: 'console' } });
	});

	test('a template with none has only the name and the folder', async () => {
		await open();
		await click(template('Empty folder'));
		expect(labels()).toEqual(['Name', 'Create in']);
	});
});

describe('a template whose tool is missing', () => {
	test('says what it needs in the list and in the form, and cannot be created', async () => {
		await open();
		expect(words(find(template('Laravel'), 'small')!)).toBe('Needs Composer');
		await click(template('Laravel'));
		expect(all(el, '.needs span').map((s) => words(s))).toEqual(['Needs Composer. Install page', 'Nothing is installed for you. Check again once it is installed.']);
		await type(field('Name'), 'shop');
		expect(isOff(el, 'Create')).toBe(true);
		await press(el, 'Create');
		expect(w.sent('project_create')).toEqual([]);
	});

	test('"Install page" opens the tool\'s own page; nothing is installed', async () => {
		w.on('plugin:opener|open_url', () => undefined);
		await open();
		await click(template('Laravel'));
		const before = w.calls.length;
		await click(all(el, '.needs a').find((a) => a.textContent === 'Install page')!);
		expect(w.calls.slice(before).map((c) => [c.cmd, c.args.url])).toEqual([['plugin:opener|open_url', 'https://getcomposer.org/download/']]);
	});

	test('"Check again" looks for the tools again, and the template can be used once its tool is there', async () => {
		let templates: ProjectTemplate[] = [];
		w.on('project_templates', () => templates);
		templates = [{ id: 'laravel', name: 'Laravel', description: 'composer create-project.', group: 'popular', icon: 'file-php', tools: [{ program: 'composer', name: 'Composer', installPage: 'https://getcomposer.org/download/', found: false }], options: [], nameRule: 'letters' }];
		await open();
		await type(field('Name'), 'shop');
		expect(isOff(el, 'Create')).toBe(true);
		templates = [{ ...templates[0], tools: [{ ...templates[0].tools[0], found: true }] }];
		await click(all(el, '.needs a').find((a) => a.textContent === 'Check again')!);
		expect(w.sent('project_templates').length).toBe(2);
		expect(find(el, '.needs')).toBeNull();
		expect(isOff(el, 'Create')).toBe(false);
	});
});

describe('creating', () => {
	test('runs the template once, on Create, and only Stop is offered meanwhile', async () => {
		await started();
		expect(w.sent('project_create').length).toBe(1);
		expect(all(el, '.foot ml-button').map((b) => words(b))).toEqual(['Stop']);
		expect(find(el, '.list')!.classList.contains('off')).toBe(true);
		expect(field('Name').hasAttribute('disabled')).toBe(true);
		expect(find(el, '.log ml-spinner')).not.toBeNull();
	});

	test('Enter in the name does the same', async () => {
		await open();
		await type(field('Name'), 'my-app');
		field('Name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		await settle();
		expect(request().name).toBe('my-app');
	});

	test('what the tool prints shows as it comes, as text', async () => {
		await started();
		w.emit('project-output', { kind: 'step', text: 'Create the project: npx @melodicdev/cli init my-app' });
		w.emit('project-output', { kind: 'out', text: '<img src=x onerror="window.pwned = true"> done' });
		await settle();
		expect(all(el, '.log > div:not(:last-child)').map((l) => [l.className, l.textContent])).toEqual([
			['step', 'Create the project: npx @melodicdev/cli init my-app'],
			['out', '<img src=x onerror="window.pwned = true"> done'],
		]);
		expect(find(el, '.log img')).toBeNull();
	});

	test('when the tool is done the dialog closes and the setup wizard takes the new folder: nothing of git happens here', async () => {
		const { InitService } = await import('../init/init-repo.component');
		const init = vi.spyOn(w.get(InitService) as InitService, 'open').mockResolvedValue(true);
		await started();
		run!.done('/Users/demo/Source/my-app');
		await settle();
		expect(inner().open).toBe(false);
		expect(init).toHaveBeenCalledWith('/Users/demo/Source/my-app', true);
		expect(w.calls.map((c) => c.cmd).filter((c) => ['repo_init', 'repo_add', 'repo_create', 'host_repo_create', 'push'].includes(c))).toEqual([]);
	});

	test('the folder and the template are offered first the next time', async () => {
		await open();
		await click(template('Rust'));
		await type(field('Create in'), '/Users/demo/Projects');
		await type(field('Name'), 'tool');
		await press(el, 'Create');
		expect(localStorage.getItem('studio.new-project.parent')).toBe('/Users/demo/Projects');
		expect(localStorage.getItem('studio.new-project.template')).toBe('rust');
		run!.fail(appError('error', 'Stopped'));
		await settle();
		await press(el, 'Cancel');
		await open();
		expect(all(el, '.tpl.on').map((t) => find(t, 'b')!.textContent)).toEqual(['Rust']);
		expect(value('Create in')).toBe('/Users/demo/Projects');
	});

	test('Stop stops the tool, and says that what it made is still there', async () => {
		await started();
		await press(el, 'Stop');
		expect(w.sent('project_stop').length).toBe(1);
		expect(words(el)).toContain('Stopped. Anything the tool had already made is still in the folder.');
		expect(all(el, '.foot ml-button').map((b) => words(b))).toEqual(['Cancel', 'Create']);
		expect(inner().open).toBe(true);
	});

	test('a tool that fails says why, and the form is there for another try', async () => {
		await started();
		run!.fail(appError('error', 'npm ERR! network timeout'));
		await settle();
		expect(words(el)).toContain('npm ERR! network timeout');
		expect(isOff(el, 'Create')).toBe(false);
		expect(field('Name').hasAttribute('disabled')).toBe(false);
	});

	// A bug until 2026-11-23, a cosmetic one: the error is put in an `<ml-alert>` (new-project.component.ts, the template),
	// and nothing registers that element: src/components.ts imports no `@melodicdev/components/alert`. The text is
	// still on screen, since an element nobody defined shows what is inside it, but as a bare line with none of
	// the alert's look. What holds now: a drawn alert. Before the fix: plain text.
	test('the failure is drawn as an alert', async () => {
		await started();
		run!.fail(appError('error', 'npm ERR! network timeout'));
		await settle();
		expect(find(el, 'ml-alert')!.shadowRoot).not.toBeNull();
	});

	test('while the tool runs the dialog cannot be closed from under it', async () => {
		await started();
		repos.closeDialog('new-project');
		const component = (el as unknown as { component: { close(): void } }).component;
		component.close();
		expect(all(el, '.foot ml-button').map((b) => words(b))).toEqual(['Stop']);
	});
});
