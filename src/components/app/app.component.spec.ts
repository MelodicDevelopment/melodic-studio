import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { DialogName, Prompt, RepoStore } from '../../services/repo.store';
import type { WorkspaceStore } from '../../services/workspace.store';
import type { RepoStatus } from '../../services/backend.service';

// The shell itself: starting, the sidebar, the Claude pane beside the main pane, keys and the menu bar. What the
// main pane shows for Changes and History is in app.template.spec.ts.

// Monaco and xterm cannot run in happy-dom: the editor and the terminals stay empty, which is all the shell needs.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

let w: World;
let repos: RepoStore;
let workspace: WorkspaceStore;
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

/** The row the main pane and the Claude pane share is measured at `width`. */
async function room(el: Element, width: number): Promise<void> {
	const upper = find(el, '.upper')!;
	observers.filter((o) => o.targets.has(upper)).forEach((o) => o.report(width));
	await settle();
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
	workspace = w.get((await import('../../services/workspace.store')).WorkspaceStore);
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

function dialogOpen(name: string): boolean {
	return all(document.body, 'ml-dialog').some((d) => d.shadowRoot!.querySelector('dialog')!.id === name && d.shadowRoot!.querySelector('dialog')!.open);
}

async function key(init: KeyboardEventInit): Promise<KeyboardEvent> {
	const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	window.dispatchEvent(event);
	await settle();
	return event;
}

describe('starting', () => {
	test('a spinner until the repositories are read', async () => {
		w.on('app_status', () => new Promise(() => {}));
		const el = await app();
		expect(own(el).querySelector('.center ml-spinner')).not.toBeNull();
		expect(own(el).querySelector('.work')).toBeNull();
	});

	test('starts the repository store, shows the open repository, and carries the strip, the toolbar and every dialog', async () => {
		const el = await app();
		expect(repos.ready()).toBe(true);
		expect(own(el).querySelector('.work')).not.toBeNull();
		expect([...own(el).querySelectorAll('aside .tab')].map((t) => words(t))).toEqual(['Files', 'Changes 5', 'History', 'Agents']);
		for (const tag of ['ms-repo-tabs', 'ms-toolbar', 'ms-dialogs', 'ms-git-ops', 'ms-init-repo', 'ms-new-project', 'ms-host-dialogs', 'ms-host-work', 'ms-investigate-start', 'ms-go-to']) {
			expect(own(el).querySelector(tag), tag).not.toBeNull();
		}
	});
});

describe('with no repository', () => {
	async function welcome(change: Record<string, unknown> = {}): Promise<HTMLElement> {
		w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: '', authorEmail: '', appVersion: '0.1.0', ...change }));
		return app();
	}

	test('welcomes, and each way to begin opens its dialog', async () => {
		const el = await welcome();
		expect(words(own(el).querySelector('.welcome h1')!)).toBe('Welcome to Melodic Studio');
		expect(cards(el)).toEqual(['Open a folder', 'Clone a repository', 'New project', 'Create an empty repository']);
		expect(own(el).querySelector('.welcome .warn')).toBeNull();
		const ways: [string, DialogName, Prompt][] = [
			['Open a folder', 'add-repo', { tab: 'add' }],
			['Clone a repository', 'add-repo', { tab: 'clone' }],
			['Create an empty repository', 'add-repo', { tab: 'create' }],
			['New project', 'new-project', {}],
		];
		for (const [title, dialog, prompt] of ways) {
			await click(card(el, title));
			expect(dialogOpen(dialog), title).toBe(true);
			expect(repos.prompt(), title).toEqual(prompt);
			repos.closeDialog(dialog);
		}
	});

	test('git missing is said', async () => {
		const el = await welcome({ gitVersion: null });
		expect(words(own(el).querySelector('.welcome .warn')!)).toBe('Git was not found on this computer. Install git, then restart Melodic Studio.');
	});
});

describe('a repository that cannot be read', () => {
	test('says which one and why in git\'s words, offers to remove it (asking first), and "Try again" reads it again', async () => {
		w.on('repo_status', () => {
			throw appError('git', 'fatal: not a git repository (or any of the parent directories): .git');
		});
		const el = await app();
		expect(words(own(el).querySelector('.empty h2')!)).toBe('Cannot open harmony');
		expect(words(own(el).querySelector('.empty p')!)).toBe('fatal: not a git repository (or any of the parent directories): .git');
		expect(own(el).querySelector('.work')).toBeNull();

		await click(find(all(el, '.empty ml-button')[1], 'button'));
		expect(dialogOpen('remove-repo')).toBe(true);
		expect(repos.prompt().repo!.name).toBe('harmony');
		expect(w.sent('repo_remove')).toEqual([]);
		repos.closeDialog('remove-repo');

		w.off('repo_status');
		await click(find(all(el, '.empty ml-button')[0], 'button'));
		expect(own(el).querySelector('.work')).not.toBeNull();
	});
});

describe('the sidebar', () => {
	test('opens on Files; each tab shows its list and its main pane', async () => {
		const el = await app();
		expect([...own(el).querySelectorAll('aside .tab.on')].map((t) => words(t))).toEqual(['Files']);
		expect(own(el).querySelector('aside ms-explorer')).not.toBeNull();
		expect(own(el).querySelector('main ms-editor')).not.toBeNull();
		for (const [label, side, main] of [
			['Changes', 'ms-changes', 'ms-diff'],
			['History', 'ms-history', '.commithead'],
			['Agents', 'ms-agents', 'ms-agent-session'],
			['Files', 'ms-explorer', 'ms-editor'],
		]) {
			await click(sideTab(el, label));
			expect([...own(el).querySelectorAll('aside .tab.on')].map((t) => words(t).split(' ')[0]), label).toEqual([label]);
			expect([...own(el).querySelectorAll('aside > :not(.tabs)')].map((n) => n.localName), label).toEqual([side]);
			expect(own(el).querySelector(`main ${main}`), label).not.toBeNull();
		}
	});

	test('the Changes tab counts the changed files, and has no count with none', async () => {
		const el = await app();
		expect(words(sideTab(el, 'Changes'))).toBe('Changes 5');
		await status({ files: [] });
		expect(words(sideTab(el, 'Changes'))).toBe('Changes');
	});

	test('the commits are read when History is first opened, not before', async () => {
		const el = await app();
		expect(w.sent('history')).toEqual([]);
		await click(sideTab(el, 'History'));
		expect(w.sent('history').length).toBe(1);
	});

	test('its edge drags between 220 and 520 px, and the width is remembered', async () => {
		const el = await app();
		const aside = own(el).querySelector<HTMLElement>('aside')!;
		expect(aside.style.width).toBe('300px');
		own(el).querySelector('.resizer')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 300 }));
		window.dispatchEvent(new PointerEvent('pointermove', { clientX: 380 }));
		await settle();
		expect(aside.style.width).toBe('380px');
		window.dispatchEvent(new PointerEvent('pointermove', { clientX: 900 }));
		await settle();
		expect(aside.style.width).toBe('520px');
		window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10 }));
		window.dispatchEvent(new PointerEvent('pointerup'));
		await settle();
		expect(aside.style.width).toBe('220px');
		expect(localStorage.getItem('studio.sidebar')).toBe('220');
		// Let go: the pointer moving on changes nothing.
		window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400 }));
		await settle();
		expect(aside.style.width).toBe('220px');
	});

	test('a remembered width is used, and a double click on the edge goes back to 300', async () => {
		await start('MacIntel', () => localStorage.setItem('studio.sidebar', '410'));
		const el = await app();
		const aside = own(el).querySelector<HTMLElement>('aside')!;
		expect(aside.style.width).toBe('410px');
		own(el).querySelector('.resizer')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await settle();
		expect(aside.style.width).toBe('300px');
		expect(localStorage.getItem('studio.sidebar')).toBeNull();
	});
});

describe('the Claude pane', () => {
	test('is beside the main pane to begin with, with an edge to drag and no strip', async () => {
		const el = await app();
		expect(own(el).querySelector('.upper')!.classList.contains('side')).toBe(true);
		expect(own(el).querySelector('.upper ms-workspace')).not.toBeNull();
		expect(own(el).querySelector('.wsresizer')).not.toBeNull();
		expect(own(el).querySelector('.wsrail')).toBeNull();
	});

	test('hidden, a 28 px strip with one arrow stays at the edge, and the arrow brings the pane back', async () => {
		const el = await app();
		workspace.setView('hidden');
		await settle();
		const rail = own(el).querySelector<HTMLElement>('.wsrail')!;
		expect(rail).not.toBeNull();
		expect(rail.getAttribute('aria-label')).toBe('Show the Claude pane');
		// Nothing else on it: one icon, no words.
		expect([...rail.children].map((c) => c.localName)).toEqual(['ml-icon']);
		expect(words(rail)).toBe('');
		expect(own(el).querySelector('ms-workspace')).toBeNull();
		expect(own(el).querySelector('.wsresizer')).toBeNull();
		expect(own(el).querySelector('.upper main')!.nextElementSibling).toBe(rail);
		// happy-dom lays nothing out, so the width is read from the rule that sets it.
		const css = [...own(el).querySelectorAll('style')].map((n) => n.textContent).join('\n') + (own(el).adoptedStyleSheets ?? []).map((sheet) => [...sheet.cssRules].map((r) => r.cssText).join('\n')).join('\n');
		expect(/\.wsrail\s*\{[^}]*\}/.exec(css)?.[0] ?? '').toMatch(/width:\s*28px/);
		// Hidden is remembered for this repository only.
		expect(JSON.parse(localStorage.getItem('studio.workspace.views')!)).toEqual({ '/Users/demo/Source/harmony': 'hidden' });

		await click(rail);
		expect(workspace.view()).toBe('side');
		expect(own(el).querySelector('ms-workspace')).not.toBeNull();
		expect(own(el).querySelector('.wsrail')).toBeNull();
	});

	test('a window too narrow for both panes hides it, and it comes back when the window grows', async () => {
		const el = await app();
		// 840 for the main pane, the divider and 320 for the Claude pane make 1161.
		await room(el, 1160);
		expect(workspace.view()).toBe('side');
		expect(own(el).querySelector('ms-workspace')).toBeNull();
		expect(own(el).querySelector('.wsrail')).not.toBeNull();
		await room(el, 1161);
		expect(own(el).querySelector('ms-workspace')).not.toBeNull();
		expect(own(el).querySelector('.wsrail')).toBeNull();
	});

	test('in a window too narrow for both, the arrow shows the Claude pane alone', async () => {
		const el = await app();
		await room(el, 900);
		await click(own(el).querySelector('.wsrail'));
		expect(workspace.view()).toBe('full');
		expect(own(el).querySelector('.upper')!.classList.contains('full')).toBe(true);
		expect(own(el).querySelector<HTMLElement>('ms-workspace')!.style.width).toBe('');
	});

	test('it gets a third of the window, never taking the main pane under 840 px; its edge drags down to 360 px for the main pane, and that is remembered', async () => {
		const el = await app();
		const width = (): string => own(el).querySelector<HTMLElement>('ms-workspace')!.style.width;
		Object.defineProperty(window, 'innerWidth', { value: 1500, configurable: true });
		await room(el, 1200);
		expect(width()).toBe('359px');
		await room(el, 1500);
		expect(width()).toBe('500px');

		const edge = own(el).querySelector<HTMLElement>('.wsresizer')!;
		(edge as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
		edge.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 1000 }));
		edge.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 800 }));
		await settle();
		expect(width()).toBe('700px');
		edge.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 0 }));
		edge.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		await settle();
		expect(width()).toBe('1139px');
		expect(localStorage.getItem('studio.workspace.width')).toBe('1139');
	});

	test('a remembered width is used, and a double click on the edge goes back to a third of the window', async () => {
		await start('MacIntel', () => localStorage.setItem('studio.workspace.width', '700'));
		const el = await app();
		Object.defineProperty(window, 'innerWidth', { value: 1500, configurable: true });
		await room(el, 1500);
		expect(own(el).querySelector<HTMLElement>('ms-workspace')!.style.width).toBe('700px');
		own(el).querySelector('.wsresizer')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		await settle();
		expect(own(el).querySelector<HTMLElement>('ms-workspace')!.style.width).toBe('500px');
		expect(localStorage.getItem('studio.workspace.width')).toBeNull();
	});

	test('while it fills the window, the tab already on screen brings the main pane back; another tab is only switched to', async () => {
		const el = await app();
		workspace.setView('full');
		await settle();
		await click(sideTab(el, 'Changes'));
		expect(repos.tab()).toBe('changes');
		expect(workspace.view()).toBe('full');
		await click(sideTab(el, 'Changes'));
		expect(workspace.view()).toBe('side');
	});
});

describe('keys', () => {
	const MODS: [string, KeyboardEventInit][] = [
		['Cmd', { metaKey: true }],
		['Ctrl', { ctrlKey: true }],
	];

	test('Cmd/Ctrl+Shift+A shows the Agents page, and again goes back', async () => {
		const el = await app();
		for (const [name, mods] of MODS) {
			const event = await key({ code: 'KeyA', key: 'A', shiftKey: true, ...mods });
			expect(event.defaultPrevented, name).toBe(true);
			expect(repos.overview(), name).toBe(true);
			expect(own(el).querySelector('ms-agents-overview'), name).not.toBeNull();
			expect(own(el).querySelector('.work'), name).toBeNull();
			await key({ code: 'KeyA', key: 'A', shiftKey: true, ...mods });
			expect(repos.overview(), name).toBe(false);
			expect(own(el).querySelector('.work'), name).not.toBeNull();
		}
	});

	test('a sidebar tab leaves the Agents page; without Shift, or with Alt, the A is left alone', async () => {
		const el = await app();
		const plain = await key({ code: 'KeyA', key: 'a', metaKey: true });
		const alt = await key({ code: 'KeyA', key: 'A', metaKey: true, shiftKey: true, altKey: true });
		expect(repos.overview()).toBe(false);
		expect(plain.defaultPrevented || alt.defaultPrevented).toBe(false);

		await key({ code: 'KeyA', key: 'A', shiftKey: true, metaKey: true });
		repos.setTab('changes');
		await settle();
		expect(own(el).querySelector('ms-agents-overview')).toBeNull();
		expect(own(el).querySelector('aside ms-changes')).not.toBeNull();
	});

	test('with no repository there is no Agents page to go to', async () => {
		w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: '', authorEmail: '', appVersion: '0.1.0' }));
		await app();
		await key({ code: 'KeyA', key: 'A', shiftKey: true, metaKey: true });
		expect(repos.overview()).toBe(false);
	});

	test('Cmd/Ctrl+Shift+K hides the Claude pane, and again shows it', async () => {
		const el = await app();
		for (const [name, mods] of MODS) {
			await key({ code: 'KeyK', key: 'K', shiftKey: true, ...mods });
			expect(workspace.view(), name).toBe('hidden');
			expect(own(el).querySelector('.wsrail'), name).not.toBeNull();
			await key({ code: 'KeyK', key: 'K', shiftKey: true, ...mods });
			expect(workspace.view(), name).toBe('side');
			expect(own(el).querySelector('ms-workspace'), name).not.toBeNull();
		}
	});

	test('Cmd/Ctrl+Shift+F goes to find in files from another tab', async () => {
		const el = await app();
		const search = w.get((await import('../../services/search.store')).SearchStore);
		for (const [name, mods] of MODS) {
			await click(sideTab(el, 'History'));
			const asked = search.focusAsked();
			const event = await key({ code: 'KeyF', key: 'F', shiftKey: true, ...mods });
			expect(event.defaultPrevented, name).toBe(true);
			expect(repos.tab(), name).toBe('files');
			expect(search.focusAsked(), name).toBe(asked + 1);
			expect(own(el).querySelector('aside ms-explorer'), name).not.toBeNull();
		}
	});

	test('in the browser, Ctrl+, opens Settings and Ctrl+O the Add a repository dialog', async () => {
		await app();
		await key({ key: ',', ctrlKey: true });
		expect(dialogOpen('settings')).toBe(true);
		repos.closeDialog('settings');
		await key({ key: 'o', ctrlKey: true });
		expect(dialogOpen('add-repo')).toBe(true);
		expect(repos.prompt()).toEqual({ tab: 'add' });
	});
});

describe('the menu bar', () => {
	test('its items open their dialogs', async () => {
		await app();
		const items: [string, DialogName, Prompt][] = [
			['settings', 'settings', {}],
			['add-repo', 'add-repo', { tab: 'add' }],
			['clone-repo', 'add-repo', { tab: 'clone' }],
			['new-project', 'new-project', {}],
		];
		for (const [item, dialog, prompt] of items) {
			w.emit('menu', item);
			await settle();
			expect(dialogOpen(dialog), item).toBe(true);
			expect(repos.prompt(), item).toEqual(prompt);
			repos.closeDialog(dialog);
		}
	});
});

describe('how the shortcut for the Claude pane is shown', () => {
	async function strip(system: string): Promise<string> {
		await start(system);
		const el = await app();
		workspace.setView('hidden');
		await settle();
		return own(el).querySelector<HTMLElement>('.wsrail')!.title;
	}

	test('with ⌘ on a Mac, with Ctrl+ on Windows and Linux', async () => {
		expect(await strip('MacIntel')).toBe('Show the Claude pane (⌘Shift+K)');
		expect(await strip('Win32')).toBe('Show the Claude pane (Ctrl+Shift+K)');
		expect(await strip('Linux x86_64')).toBe('Show the Claude pane (Ctrl+Shift+K)');
	});
});
