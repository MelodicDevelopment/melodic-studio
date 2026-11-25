import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { AgentSession, AgentsStore } from '../../services/agents.store';

// Monaco cannot run in happy-dom, and the language services reach for it as soon as the status changes.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));

const HARMONY = '/Users/demo/Source/harmony';
const CADENCE = '/Users/demo/Source/cadence';

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
/** The dialogs the component asked for, by id. */
let opened: string[];
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

/** happy-dom has no Popover API: these keep an `open` mark on the element and send the `toggle` event a browser does. */
function popovers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, (this: HTMLElement) => void>;
	const set = (el: HTMLElement, open: boolean): void => {
		if (el.hasAttribute('data-open') !== open) {
			el.toggleAttribute('data-open', open);
			el.dispatchEvent(Object.assign(new Event('toggle'), { newState: open ? 'open' : 'closed', oldState: open ? 'closed' : 'open' }));
		}
	};
	proto.showPopover = function () {
		set(this, true);
	};
	proto.hidePopover = function () {
		set(this, false);
	};
	proto.togglePopover = function () {
		set(this, !this.hasAttribute('data-open'));
	};
}

/** The app on this platform, started. `navigator.platform` is what `isMac()` reads. */
async function start(on = 'MacIntel'): Promise<void> {
	Object.defineProperty(navigator, 'platform', { value: on, configurable: true });
	w = await world();
	forgetElements();
	popovers();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	const { DialogService } = await import('@melodicdev/components/dialog');
	opened = [];
	vi.spyOn(w.get(DialogService), 'open').mockImplementation(((id: string) => void opened.push(id)) as never);
	await repos.init();
	await agents.restored;
}

beforeEach(() => start());

afterEach(() => {
	if (platform) {
		Object.defineProperty(navigator, 'platform', platform);
	}
});

/** Two repositories open side by side, the second one on screen. */
async function two(): Promise<HTMLElement> {
	await repos.openRepoTab(CADENCE);
	return mount('ms-repo-tabs');
}

/** A repository that is set up and open in no tab. */
const third = { id: '/Users/demo/Source/tempo', name: 'tempo', path: '/Users/demo/Source/tempo', missing: false, origin: null };

/** Open the plus's list. */
async function plus(el: Element): Promise<void> {
	await click(find(el, '#add-pop')!.shadowRoot!.querySelector('.ml-popover__trigger'));
}

function tabs(el: Element): HTMLElement[] {
	return all(el, '.tab:not(.pinned)');
}

function names(el: Element): string[] {
	return tabs(el).map((t) => find(t, '.name')!.textContent ?? '');
}

function tab(el: Element, name: string): HTMLElement {
	return tabs(el).find((t) => find(t, '.name')!.textContent === name)!;
}

function on(el: Element): string[] {
	return all(el, '.tab.on').map((t) => find(t, '.name')!.textContent ?? '');
}

/** An agent session as the store keeps them; `change` says how it stands. */
function session(change: Partial<AgentSession>): AgentSession {
	return {
		id: crypto.randomUUID(),
		repoId: HARMONY,
		title: 'Wrap the queue',
		cwd: HARMONY,
		branch: null,
		isolated: false,
		mode: 'acceptEdits',
		sessionId: null,
		status: 'idle',
		items: [],
		cost: 0,
		updated: Date.now(),
		kind: 'task',
		group: null,
		attempt: 1,
		base: null,
		tools: null,
		unread: false,
		review: false,
		stopped: false,
		investigation: null,
		check: null,
		brief: null,
		name: null,
		...change,
	};
}

async function key(init: KeyboardEventInit): Promise<void> {
	window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
	await settle();
}

describe('the strip', () => {
	test('is not there with one repository open', async () => {
		const el = await mount('ms-repo-tabs');
		expect(find(el, '.strip')).toBeNull();
		expect(all(el, '.tab')).toEqual([]);
	});

	test('appears with the second repository, one tab each, the one on screen marked', async () => {
		const el = await two();
		expect(names(el)).toEqual(['harmony', 'cadence']);
		expect(on(el)).toEqual(['cadence']);
		expect(tab(el, 'cadence').title).toBe(CADENCE);
	});

	test('appears in a strip that was mounted while there was only one', async () => {
		const el = await mount('ms-repo-tabs');
		await repos.openRepoTab(CADENCE);
		await settle();
		expect(names(el)).toEqual(['harmony', 'cadence']);
	});

	test('clicking a tab goes to that repository', async () => {
		const el = await two();
		await click(tab(el, 'harmony'));
		expect(w.sent('repo_select').at(-1)!.args.id).toBe(HARMONY);
		expect(repos.repo()!.name).toBe('harmony');
		expect(on(el)).toEqual(['harmony']);
		expect(names(el)).toEqual(['harmony', 'cadence']);
	});

	test('the plus lists the repositories already set up, the ones in a tab marked', async () => {
		const el = await two();
		repos.app.set({ ...repos.app()!, repos: [...repos.app()!.repos, third] });
		await plus(el);
		expect(find(el, '#add-pop')!.shadowRoot!.querySelector('.ml-popover__content')!.hasAttribute('data-open')).toBe(true);
		expect(all(el, '#add-pop .item').map((i) => [find(i, '.name')!.firstChild!.textContent, find(i, '.when')?.textContent ?? ''])).toEqual([
			['harmony', 'Open'],
			['cadence', 'Open'],
			['tempo', ''],
		]);
	});

	test('picking one from the plus opens it in a tab of its own', async () => {
		const el = await two();
		repos.app.set({ ...repos.app()!, repos: [...repos.app()!.repos, third] });
		const select = vi.spyOn(repos, 'selectRepo').mockResolvedValue();
		await plus(el);
		await click(all(el, '#add-pop .item')[2]);
		expect(select).toHaveBeenCalledWith(third.id, true);
		expect(opened).toEqual([]);
	});

	test('picking one that is already in a tab goes to that tab', async () => {
		const el = await two();
		await plus(el);
		await click(all(el, '#add-pop .item')[0]);
		await settle();
		expect(on(el)).toEqual(['harmony']);
		expect(names(el)).toEqual(['harmony', 'cadence']);
	});

	test('the plus\'s filter narrows the list, and Enter opens the first one left', async () => {
		const el = await two();
		repos.app.set({ ...repos.app()!, repos: [...repos.app()!.repos, third] });
		const select = vi.spyOn(repos, 'selectRepo').mockResolvedValue();
		await plus(el);
		const input = find<HTMLInputElement>(find(el, '#add-pop ml-input')!, 'input')!;
		input.value = 'temp';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(all(el, '#add-pop .item').map((i) => find(i, '.name')!.firstChild!.textContent)).toEqual(['tempo']);
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true }));
		expect(select).toHaveBeenCalledWith(third.id, true);
		input.value = 'nothing like it';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(find(el, '#add-pop .none')!.textContent).toBe('No repositories match.');
	});

	test('"Add repository…" under the plus\'s list opens Add a repository, for a tab of its own', async () => {
		const el = await two();
		await plus(el);
		find(el, '#add-pop ml-button')!.dispatchEvent(new CustomEvent('ml:click', { bubbles: true, composed: true }));
		await settle();
		expect(opened).toEqual(['add-repo']);
		expect(repos.prompt()).toEqual({ newTab: true });
	});

	test('a repository with an agent at work shows a spinner on its tab', async () => {
		agents.sessions.set([session({ repoId: HARMONY, status: 'running' })]);
		const el = await two();
		expect(find(tab(el, 'harmony'), 'ml-spinner')).not.toBeNull();
		expect(find(tab(el, 'cadence'), 'ml-spinner')).toBeNull();
	});
});

describe('closing a tab', () => {
	test('the cross closes that tab without going to it; the repository stays in the list', async () => {
		const el = await two();
		const before = w.sent('repo_select').length;
		await click(find(tab(el, 'harmony'), '[title="Close tab"]'));
		expect(repos.repoTabList().map((r) => r.name)).toEqual(['cadence']);
		expect(repos.repo()!.name).toBe('cadence');
		expect(w.sent('repo_select').length).toBe(before);
		expect(w.sent('repo_remove')).toEqual([]);
		expect(repos.app()!.repos.map((r) => r.name)).toEqual(['harmony', 'cadence']);
	});

	test('with one tab left the strip goes away', async () => {
		const el = await two();
		await click(find(tab(el, 'harmony'), '[title="Close tab"]'));
		expect(find(el, '.strip')).toBeNull();
	});

	test('closing the tab on screen moves to its neighbour', async () => {
		const el = await two();
		await click(find(tab(el, 'cadence'), '[title="Close tab"]'));
		expect(repos.repo()!.name).toBe('harmony');
		expect(repos.repoTabList().map((r) => r.name)).toEqual(['harmony']);
	});

	test('a middle click closes too', async () => {
		const el = await two();
		tab(el, 'harmony').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
		await settle();
		expect(repos.repoTabList().map((r) => r.name)).toEqual(['cadence']);
	});

	test('any other extra button does not', async () => {
		const el = await two();
		tab(el, 'harmony').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 2 }));
		await settle();
		expect(names(el)).toEqual(['harmony', 'cadence']);
	});
});

describe('the pinned Agents tab', () => {
	function pinned(el: Element): HTMLElement {
		return find(el, '.tab.pinned')!;
	}

	test('comes first, and cannot be closed', async () => {
		const el = await two();
		expect(find(el, '.strip')!.firstElementChild).toBe(pinned(el));
		expect(find(pinned(el), '.name')!.textContent).toBe('Agents');
		expect(find(pinned(el), 'button')).toBeNull();
	});

	test('opens the Agents page, and no repository tab is the one on screen then', async () => {
		const el = await two();
		await click(pinned(el));
		expect(repos.overview()).toBe(true);
		expect(on(el)).toEqual(['Agents']);
	});

	test('a repository tab leaves the Agents page, even the one that was on screen', async () => {
		const el = await two();
		await click(pinned(el));
		await click(tab(el, 'cadence'));
		expect(repos.overview()).toBe(false);
		expect(on(el)).toEqual(['cadence']);
	});

	test('has no count while nothing waits', async () => {
		agents.sessions.set([session({ status: 'running' }), session({})]);
		const el = await two();
		expect(find(pinned(el), '.n')).toBeNull();
	});

	test('counts what needs you in every repository: work to review, an open question, a turn that ended unseen', async () => {
		agents.sessions.set([
			session({ repoId: HARMONY, review: true }),
			session({ repoId: CADENCE, unread: true }),
			session({ repoId: CADENCE, brief: { title: 'Queue', did: 'Planned it.', needs: 'Restart the same track?', choices: [] } }),
			session({ repoId: HARMONY, status: 'running' }),
			session({ repoId: HARMONY, stopped: true }),
		]);
		const el = await two();
		const count = find(pinned(el), '.n')!;
		expect(count.textContent).toBe('3');
		expect(count.getAttribute('aria-label')).toBe('3 waiting for you');
	});

	test('the count follows the sessions', async () => {
		const waiting = session({ review: true });
		agents.sessions.set([waiting]);
		const el = await two();
		expect(find(pinned(el), '.n')!.textContent).toBe('1');
		agents.sessions.set([{ ...waiting, review: false }]);
		await settle();
		expect(find(pinned(el), '.n')).toBeNull();
	});

	test('is not dragged', async () => {
		const el = await two();
		const tab = pinned(el);
		tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10 }));
		tab.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 200 }));
		tab.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		await settle();
		expect(find(el, '.strip')!.firstElementChild).toBe(pinned(el));
		expect(names(el)).toEqual(['harmony', 'cadence']);
	});
});

describe('the shortcut for the Agents page', () => {
	test('is shown with ⌘ on a Mac', async () => {
		const el = await two();
		expect(find(el, '.tab.pinned')!.title).toBe("Every repository's agents on one page (⌘Shift+A)");
	});

	test.each(['Win32', 'Linux x86_64'])('is shown with Ctrl+ on %s', async (system) => {
		await start(system);
		const el = await two();
		expect(find(el, '.tab.pinned')!.title).toBe("Every repository's agents on one page (Ctrl+Shift+A)");
	});
});

describe('Ctrl+Tab', () => {
	test('goes to the next tab and round again', async () => {
		await two();
		await key({ key: 'Tab', ctrlKey: true });
		expect(repos.repo()!.name).toBe('harmony');
		await key({ key: 'Tab', ctrlKey: true });
		expect(repos.repo()!.name).toBe('cadence');
	});

	test('with Shift goes to the one before', async () => {
		await repos.openRepoTab(CADENCE);
		await repos.addRepo('/Users/demo/Source/tempo');
		expect(repos.repoTabList().map((r) => r.name)).toEqual(['harmony', 'tempo']);
		await repos.openRepoTab(CADENCE);
		await mount('ms-repo-tabs');
		expect(repos.repoTabList().map((r) => r.name)).toEqual(['harmony', 'tempo', 'cadence']);
		await key({ key: 'Tab', ctrlKey: true, shiftKey: true });
		expect(repos.repo()!.name).toBe('tempo');
	});

	test('is Ctrl on a Mac too: Cmd+Tab is the system\'s', async () => {
		await two();
		await key({ key: 'Tab', metaKey: true });
		expect(repos.repo()!.name).toBe('cadence');
	});

	test('does nothing while there is only one repository', async () => {
		await mount('ms-repo-tabs');
		const before = w.sent('repo_select').length;
		await key({ key: 'Tab', ctrlKey: true });
		expect(w.sent('repo_select').length).toBe(before);
	});
});

describe('dragging a tab', () => {
	/** happy-dom lays nothing out: each tab is given 100 px, side by side. */
	function layout(el: Element): void {
		vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
			const at = tabs(el).indexOf(this);
			return { left: at * 100, right: at * 100 + 100, width: 100, top: 0, bottom: 30, height: 30, x: at * 100, y: 0, toJSON: () => ({}) };
		});
		for (const t of tabs(el)) {
			(t as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
		}
	}

	async function drag(el: Element, name: string, by: number): Promise<HTMLElement> {
		const dragged = tab(el, name);
		dragged.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 50 }));
		dragged.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 50 + by }));
		return dragged;
	}

	test('past its neighbour moves it there, and is remembered', async () => {
		const el = await two();
		layout(el);
		const dragged = await drag(el, 'cadence', -120);
		expect(dragged.classList.contains('dragging')).toBe(true);
		dragged.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		await settle();
		expect(names(el)).toEqual(['cadence', 'harmony']);
		expect(JSON.parse(localStorage.getItem('studio.repo-tabs')!)).toEqual([CADENCE, HARMONY]);
	});

	// A bug until 2026-11-23 (repo-tabs.component.ts, `move`): the drag is held inside the strip, so the dragged tab's centre
	// can reach the last tab's centre but never pass it, and "past" is tested with `<`. Every tab is the same width
	// (`flex: 0 1 220px`), so a tab cannot be dragged to the last place: with two tabs the first one cannot be moved
	// at all (only the second, leftwards). What holds now: cadence, harmony. Before the fix: the order stays harmony, cadence.
	test('the first tab can be dragged to the last place', async () => {
		const el = await two();
		layout(el);
		const dragged = await drag(el, 'harmony', 120);
		dragged.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		await settle();
		expect(names(el)).toEqual(['cadence', 'harmony']);
	});

	test('the click that ends a drag does not go to the tab', async () => {
		const el = await two();
		layout(el);
		await click(tab(el, 'harmony'));
		const before = w.sent('repo_select').length;
		const dragged = await drag(el, 'cadence', -120);
		dragged.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		dragged.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();
		expect(names(el)).toEqual(['cadence', 'harmony']);
		expect(w.sent('repo_select').length).toBe(before);
		expect(repos.repo()!.name).toBe('harmony');
	});

	test('a few pixels are a click, not a drag', async () => {
		const el = await two();
		layout(el);
		const dragged = await drag(el, 'harmony', 3);
		dragged.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		await click(dragged);
		expect(names(el)).toEqual(['harmony', 'cadence']);
		expect(repos.repo()!.name).toBe('harmony');
	});

	test('a drag that is called off leaves the order', async () => {
		const el = await two();
		layout(el);
		const dragged = await drag(el, 'cadence', -120);
		dragged.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true }));
		await settle();
		expect(names(el)).toEqual(['harmony', 'cadence']);
		expect(dragged.classList.contains('dragging')).toBe(false);
	});

	test('pressing the cross does not start one', async () => {
		const el = await two();
		layout(el);
		const cross = find(tab(el, 'harmony'), '[title="Close tab"]')!;
		cross.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 50 }));
		tab(el, 'harmony').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 200 }));
		tab(el, 'harmony').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
		await settle();
		expect(names(el)).toEqual(['harmony', 'cadence']);
	});

	test('nothing in the strip uses HTML drag and drop', async () => {
		const el = await two();
		expect(all(el, '[draggable]')).toEqual([]);
	});
});
