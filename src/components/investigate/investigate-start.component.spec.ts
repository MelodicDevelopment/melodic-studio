import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { AgentsStore } from '../../services/agents.store';
import type { RepoStore } from '../../services/repo.store';
import type { RunStore } from '../../services/run.store';
import type { RunTarget } from '../../services/backend.service';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
let run: RunStore;

/**
 * happy-dom keeps one registry of custom elements for the whole file and Melodic never defines a name
 * twice, so without this the elements of a later test would still be the first test's classes, tied
 * to the first test's stores.
 */
function forgetElements(): void {
	const registry = customElements as unknown as Record<symbol, unknown>;
	for (const key of Object.getOwnPropertySymbols(registry)) {
		const held = registry[key];
		if (held instanceof Map) {
			held.clear();
		}
	}
}

/**
 * happy-dom's HTML parser drops the `#` of `<ml-dialog #some-name>`, and that name is what a dialog is
 * opened by (`DialogService.open('some-name')`): it is put back where `ml-dialog` looks for it.
 */
const attributeNames = Element.prototype.getAttributeNames;
Element.prototype.getAttributeNames = function (this: Element): string[] {
	const names = attributeNames.call(this);
	return this.tagName === 'ML-DIALOG' ? names.map((n) => (n !== 'style' && !n.startsWith('#') && this.getAttribute(n) === '' ? `#${n}` : n)) : names;
};

beforeEach(async () => {
	forgetElements();
	w = await world();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	await repos.init();
	repos.setTab('changes');
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	await agents.init();
	run = w.get((await import('../../services/run.store')).RunStore);
	// A turn that starts stays started: the demo's own would play out over seconds.
	w.on('agent_start', () => undefined);
});

/** Tags that mark words inside a sentence: nothing is read between them and the words around them. */
const INLINE = new Set(['B', 'I', 'EM', 'STRONG', 'CODE', 'U']);

/**
 * What a person reads under `root`, through shadow roots: text that stands together stays together,
 * the icons' glyphs are left out, and so is a dialog that is not open.
 */
function read(root: Element | ShadowRoot): string {
	const parts: string[] = [];
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			parts.push(node.textContent ?? '');
		} else if (node instanceof Element) {
			const closed = node.tagName === 'ML-DIALOG' && !node.shadowRoot?.querySelector('dialog')?.open;
			if (node.tagName !== 'STYLE' && node.tagName !== 'SCRIPT' && !closed) {
				const gap = INLINE.has(node.tagName) ? '' : ' ';
				parts.push(gap);
				if (node.shadowRoot) {
					walk(node.shadowRoot);
				}
				node.childNodes.forEach(walk);
				parts.push(gap);
			}
		} else {
			node.childNodes.forEach(walk);
		}
	};
	walk(root);
	return parts
		.join('')
		.replace(/[\uE000-\uF8FF]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function button(root: Element, label: string | RegExp): HTMLElement | null {
	return all(root, 'ml-button, button').find((b) => (typeof label === 'string' ? read(b) === label : label.test(read(b)))) ?? null;
}

/** A click on a button; an `ml-button` listens on the button inside it. */
async function press(el: Element | null): Promise<void> {
	if (!el) {
		throw new Error('nothing to press');
	}
	await click(el.tagName === 'ML-BUTTON' ? find(el, 'button') : el);
}

const disabled = (el: Element | null): boolean => !!el && el.hasAttribute('disabled');

/** Types into an `ml-input` or `ml-textarea`. */
async function type(field: Element | null, value: string): Promise<void> {
	const box = field && find<HTMLInputElement>(field, 'input, textarea');
	if (!box) {
		throw new Error('nothing to type in');
	}
	box.value = value;
	box.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
	await settle();
}

const API: RunTarget = { id: 'shop-api-https', name: 'https', group: 'Shop.Api · launch profiles', cwd: 'src/Shop.Api', argv: ['dotnet', 'run', '--launch-profile', 'https'], kind: 'run', runtime: 'dotnet', source: 'launchSettings.json' };
const TESTS: RunTarget = { id: 'shop-tests', name: 'Shop.Tests', group: 'Shop.Tests · tests', cwd: 'tests/Shop.Tests', argv: ['dotnet', 'test'], kind: 'test', runtime: 'dotnet', source: 'Shop.Tests.csproj' };

/** The box for describing a bug, opened the way the app opens it. */
async function box(output = '', targets: RunTarget[] | null = []): Promise<HTMLElement> {
	const el = await mount('ms-investigate-start');
	run.targets.set(targets);
	agents.openInvestigate(output);
	await settle();
	return el;
}

const isOpen = (el: HTMLElement): boolean => !!find<HTMLDialogElement>(find(el, 'ml-dialog')!, 'dialog')?.open;
const start = (el: HTMLElement): HTMLElement => button(el, 'Investigate')!;

describe('describing a bug to investigate', () => {
	test('is closed until asked for, and says what Claude will and will not do', async () => {
		const el = await mount('ms-investigate-start');
		expect(isOpen(el)).toBe(false);
		expect(read(el)).toBe('');
		agents.openInvestigate();
		await settle();
		expect(isOpen(el)).toBe(true);
		expect(read(el)).toContain('Investigate a bug');
		expect(read(el)).toContain('It asks before it runs anything, and your files are not touched.');
	});

	test('needs a description or terminal output: either is enough', async () => {
		const el = await box();
		expect(disabled(start(el))).toBe(true);
		await type(find(el, 'ml-textarea'), 'Guest checkout returns a 500');
		expect(disabled(start(el))).toBe(false);
		await type(find(el, 'ml-textarea'), '   ');
		expect(disabled(start(el))).toBe(true);
	});

	test('with text selected in a terminal it shows that text, as text, and can start on it alone', async () => {
		const el = await box('  fail: Unhandled exception <img src=x onerror=alert(1)>\n   at ApplyDiscount  ');
		expect(read(el)).toContain('From the terminal');
		expect(find(el, 'pre')!.textContent).toBe('fail: Unhandled exception <img src=x onerror=alert(1)>\n   at ApplyDiscount');
		expect(find(el, 'pre img')).toBeNull();
		expect(find(el, 'ml-textarea')!.getAttribute('placeholder')).toBe('Optional: anything the output below does not say');
		expect(disabled(start(el))).toBe(false);
	});

	test('offers the project’s run targets to say where it happens, or leaves that to Claude', async () => {
		const el = await box('', [API, TESTS]);
		const where = find(el, 'ml-select') as HTMLElement & { options: { value: string; label: string }[]; value: string };
		expect(where.getAttribute('label')).toBe('What it happens in');
		expect(where.options.map((o) => o.label)).toEqual(['Let Claude work it out', 'Shop.Api · https  (dotnet run --launch-profile https)', 'Shop.Tests  (dotnet test)']);
		expect(where.value).toBe(where.options[0].value);
	});

	test('has nothing to pick in a project with no run targets', async () => {
		const el = await box('', []);
		expect(find(el, 'ml-select')).toBeNull();
	});

	test('Investigate starts it in a worktree of its own, from the commit on screen, and closes the box', async () => {
		const el = await box('', [API]);
		await type(find(el, 'ml-textarea'), 'Guest checkout returns a 500');
		find(el, 'ml-select')!.dispatchEvent(new CustomEvent('ml:change', { detail: { value: API.id } }));
		await settle();
		await press(start(el));
		expect(isOpen(el)).toBe(false);
		expect(w.sent('worktree_add').map((c) => c.args)).toEqual([{ id: REPO, branch: 'investigate/guest-checkout-returns-a-500', base: repos.status()!.head }]);
		const made = agents.selected()!;
		expect(made).toMatchObject({ kind: 'investigate', isolated: true, branch: 'investigate/guest-checkout-returns-a-500', investigation: { summary: 'Guest checkout returns a 500', targetId: API.id, targetName: 'Shop.Api · https' } });
		const sent = w.sent('agent_start');
		expect(sent.length).toBe(1);
		// Never in the main checkout, and with the investigation's own rules: the target it may run is named by id.
		expect(sent[0].args.cwd).toBe(made.cwd);
		expect(sent[0].args.cwd).not.toBe(REPO);
		expect(sent[0].args.options).toMatchObject({ investigate: { target: API.id } });
		expect(String(sent[0].args.prompt)).toContain('Guest checkout returns a 500');
		expect(repos.tab()).toBe('agents');
	});

	test('started from terminal output alone, that output goes to Claude as what was seen', async () => {
		const el = await box('TypeError: Cannot read properties of null (reading tier)');
		await press(start(el));
		expect(String(w.sent('agent_start')[0].args.prompt)).toContain('TypeError: Cannot read properties of null (reading tier)');
		expect(agents.selected()!.investigation).toMatchObject({ targetId: null, targetName: null });
	});

	test('Cancel closes it and starts nothing', async () => {
		const el = await box();
		await type(find(el, 'ml-textarea'), 'Guest checkout returns a 500');
		await press(button(el, 'Cancel'));
		expect(isOpen(el)).toBe(false);
		expect(w.sent('worktree_add')).toEqual([]);
		expect(agents.sessions()).toEqual([]);
	});

	test('without Claude Code it says what is missing and makes no worktree', async () => {
		const el = await box();
		agents.cli.set(null);
		await type(find(el, 'ml-textarea'), 'Guest checkout returns a 500');
		await press(start(el));
		expect(w.sent('worktree_add')).toEqual([]);
		expect(w.toasts.map((t) => t.title)).toEqual(['Claude Code was not found']);
	});
});
