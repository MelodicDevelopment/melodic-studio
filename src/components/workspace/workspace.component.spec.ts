import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { LayoutNode, Pane, WorkspaceStore } from '../../services/workspace.store';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));
// xterm draws on a canvas and measures glyphs, neither of which happy-dom has: no screen ever loads here.
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => undefined), adoptXtermStyles: () => undefined, xtermTheme: () => ({}) }));

const REPO = '/Users/demo/Source/harmony';
const OTHER = '/Users/demo/Source/cadence';

let w: World;
let repos: RepoStore;
let workspace: WorkspaceStore;
let panesOf: (node: LayoutNode) => Pane[];

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

/** happy-dom has no Popover API: enough of one for `ml-popover` to open and close, and to say so. */
function popovers(): void {
	const open = new WeakSet<Element>();
	const flip = (el: HTMLElement, to: boolean): void => {
		if (open.has(el) !== to) {
			to ? open.add(el) : open.delete(el);
			el.dispatchEvent(Object.assign(new Event('toggle'), { newState: to ? 'open' : 'closed', oldState: to ? 'closed' : 'open' }));
		}
	};
	Object.assign(HTMLElement.prototype, {
		showPopover(this: HTMLElement) {
			flip(this, true);
		},
		hidePopover(this: HTMLElement) {
			flip(this, false);
		},
		togglePopover(this: HTMLElement) {
			flip(this, !open.has(this));
		},
	});
}

// happy-dom has no pointer capture: a divider takes it for the length of a drag.
(Element.prototype as { setPointerCapture?: (id: number) => void }).setPointerCapture ??= () => undefined;

beforeEach(async () => {
	forgetElements();
	popovers();
	w = await world();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	await repos.init();
	repos.setTab('changes');
	const store = await import('../../services/workspace.store');
	workspace = w.get(store.WorkspaceStore);
	panesOf = store.panesOf;
});

const pane = (id: string): Pane => ({ type: 'pane', id, tabs: [], active: null });
const ROW: LayoutNode = { type: 'split', id: 's1', dir: 'row', children: [pane('left'), pane('right')], sizes: [0.5, 0.5] };

async function shown(layout: LayoutNode): Promise<HTMLElement> {
	workspace.layouts.set({ [REPO]: layout });
	const el = await mount('ms-workspace');
	await settle();
	return el;
}

const sizes = (): number[] => (workspace.layout() as { sizes: number[] }).sizes.map((s) => Math.round(s * 100) / 100);

/** A drag of the divider between two panes, on a split that is `length` px along the way it divides. */
function dragDivider(el: HTMLElement, from: number, to: number, length = 1000, release = true): void {
	const divider = find(el, '.divider')!;
	divider.parentElement!.getBoundingClientRect = () => new DOMRect(0, 0, length, length);
	const at = (type: string, x: number): void => void divider.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: x, bubbles: true, cancelable: true }));
	at('pointerdown', from);
	at('pointermove', to);
	if (release) {
		at('pointerup', to);
	}
}

describe('the split layout', () => {
	test('draws the tree: panes side by side for a row, with a divider between them', async () => {
		const el = await shown({ type: 'split', id: 's1', dir: 'row', children: [pane('left'), { type: 'split', id: 's2', dir: 'column', children: [pane('top'), pane('bottom')], sizes: [0.3, 0.7] }], sizes: [0.6, 0.4] });
		expect(all(el, 'ms-ws-pane').map((p) => (p as HTMLElement & { paneId: string }).paneId)).toEqual(['left', 'top', 'bottom']);
		expect(all(el, '.divider').length).toBe(2);
		expect(all(el, '[data-split]').map((s) => [s.getAttribute('data-split'), s.classList.contains('row') ? 'row' : 'column'])).toEqual([
			['s1', 'row'],
			['s2', 'column'],
		]);
	});

	test('follows the store: a pane added there appears, one removed goes', async () => {
		const el = await shown(pane('only'));
		expect(all(el, 'ms-ws-pane').length).toBe(1);
		workspace.split('only', 'row');
		await settle();
		expect(all(el, 'ms-ws-pane').length).toBe(2);
		workspace.closePane(panesOf(workspace.layout()!)[1].id);
		await settle();
		expect(all(el, 'ms-ws-pane').length).toBe(1);
	});

	test('is the open repository’s own: another repository has another', async () => {
		workspace.layouts.set({ [REPO]: ROW, [OTHER]: pane('cadence-pane') });
		const el = await mount('ms-workspace');
		await settle();
		expect(all(el, 'ms-ws-pane').length).toBe(2);
		await repos.selectRepo(OTHER);
		await settle();
		expect(all(el, 'ms-ws-pane').map((p) => (p as HTMLElement & { paneId: string }).paneId)).toEqual(['cadence-pane']);
	});
});

describe('dragging a divider', () => {
	test('gives one side what it takes from the other, and the layout is kept for next time', async () => {
		const el = await shown(ROW);
		dragDivider(el, 500, 700);
		expect(sizes()).toEqual([0.7, 0.3]);
		const saved = JSON.parse(localStorage.getItem('studio.workspace.layouts')!)[REPO];
		expect(saved.sizes.map((s: number) => Math.round(s * 100) / 100)).toEqual([0.7, 0.3]);
	});

	test('never squeezes a side under a twelfth or so of the split', async () => {
		const el = await shown(ROW);
		dragDivider(el, 500, 5000);
		expect(sizes()).toEqual([0.92, 0.08]);
		dragDivider(el, 500, -5000);
		expect(sizes()).toEqual([0.08, 0.92]);
	});

	test('is not saved until the drag ends', async () => {
		const el = await shown(ROW);
		dragDivider(el, 500, 600, 1000, false);
		expect(sizes()).toEqual([0.6, 0.4]);
		expect(localStorage.getItem('studio.workspace.layouts')).toBeNull();
	});

	test('a stacked split is measured by its height', async () => {
		const el = await shown({ type: 'split', id: 's1', dir: 'column', children: [pane('top'), pane('bottom')], sizes: [0.5, 0.5] });
		dragDivider(el, 200, 100, 400);
		expect(sizes()).toEqual([0.25, 0.75]);
	});
});

describe('Cmd/Ctrl+\\', () => {
	const key = (init: KeyboardEventInit): KeyboardEvent => {
		const e = new KeyboardEvent('keydown', { key: '\\', bubbles: true, cancelable: true, ...init });
		window.dispatchEvent(e);
		return e;
	};

	test('splits the focused pane to the right, before a focused terminal can take the key', async () => {
		await shown(ROW);
		workspace.focusedPane.set('left');
		expect(key({ ctrlKey: true }).defaultPrevented).toBe(true);
		const ids = panesOf(workspace.layout()!).map((p) => p.id);
		expect(ids.length).toBe(3);
		expect(ids[0]).toBe('left');
		expect(ids[2]).toBe('right');
		// The new, empty pane has the focus.
		expect(workspace.focusedPane()).toBe(ids[1]);
	});

	test('with no pane focused it splits the first', async () => {
		await shown(ROW);
		key({ metaKey: true });
		expect(panesOf(workspace.layout()!).map((p) => p.id).slice(0, 1)).toEqual(['left']);
		expect(panesOf(workspace.layout()!).length).toBe(3);
	});

	test('with Shift or Alt, or without Cmd/Ctrl, it is some other key', async () => {
		await shown(ROW);
		expect(key({}).defaultPrevented).toBe(false);
		key({ ctrlKey: true, shiftKey: true });
		key({ ctrlKey: true, altKey: true });
		expect(panesOf(workspace.layout()!).length).toBe(2);
	});

	test('does nothing once the workspace is gone', async () => {
		const el = await shown(ROW);
		el.remove();
		await settle();
		key({ ctrlKey: true });
		expect(panesOf(workspace.layout()!).length).toBe(2);
	});
});
