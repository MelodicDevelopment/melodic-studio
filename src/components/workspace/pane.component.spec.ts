import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { Conversation, LayoutNode, Pane, WorkspaceStore } from '../../services/workspace.store';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));
// xterm draws on a canvas and measures glyphs, neither of which happy-dom has: no screen ever loads here.
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => undefined), adoptXtermStyles: () => undefined, xtermTheme: () => ({}) }));

const REPO = '/Users/demo/Source/harmony';

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

function conversation(over: Partial<Conversation> = {}): Conversation {
	const id = over.id ?? 'c1';
	return { id, kind: 'claude', repoId: REPO, cwd: REPO, branch: 'feature/repeat-mode', title: 'Why is the upload test flaky', titled: true, sessionId: `claude-${id}`, state: 'idle', waitingFor: null, lastSaid: '', subagents: [], created: Date.now(), updated: Date.now(), unread: false, ...over };
}

const pane = (id: string, tabs: string[] = [], active: string | null = tabs[0] ?? null): Pane => ({ type: 'pane', id, tabs, active });

/** The Claude workspace with this layout and these conversations in it. */
async function shown(layout: LayoutNode, conversations: Conversation[] = []): Promise<HTMLElement> {
	workspace.conversations.set(conversations);
	workspace.layouts.set({ [REPO]: layout });
	const el = await mount('ms-workspace');
	await settle();
	return el;
}

/** Every pane on screen, in reading order. */
const panes = (el: HTMLElement): HTMLElement[] => all(el, 'ms-ws-pane');
/** The buttons of a pane's one row, by what they are called. */
const tools = (p: HTMLElement): string[] => all(p, '.head > button, .head > ml-popover > button').map((b) => b.getAttribute('aria-label') ?? '');
const tool = (p: HTMLElement, name: string): HTMLElement => all(p, '.head button').find((b) => b.getAttribute('aria-label') === name)!;
const tabs = (p: HTMLElement): HTMLElement[] => all(p, '.tabs > div');
const tabNames = (p: HTMLElement): string[] => tabs(p).map((t) => read(t));
const layout = (): LayoutNode => workspace.layout()!;
const paneOf = (id: string): Pane => panesOf(layout()).find((p) => p.tabs.includes(id))!;

/** A press and release on a tab without moving: a click, as the pane reads its pointer events. */
async function pick(tab: HTMLElement): Promise<void> {
	tab.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, bubbles: true, composed: true }));
	window.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 10, clientY: 10 }));
	await settle();
}

describe('a pane’s row of buttons', () => {
	test('carries every button of the workspace, each one visible: there is no bar of its own', async () => {
		const el = await shown(pane('p1'));
		expect(tools(panes(el)[0])).toEqual(['New Claude conversation', 'More ways to start', 'Split right', 'Split down', 'Fill the window', 'Hide the Claude pane']);
		// The workspace around the panes has no button of its own.
		expect(el.shadowRoot!.querySelectorAll('button').length).toBe(0);
	});

	test('with several panes each can be closed, and only the top right one has fill and hide', async () => {
		const el = await shown({ type: 'split', id: 's1', dir: 'row', children: [pane('left'), pane('right')], sizes: [0.5, 0.5] });
		const [left, right] = panes(el);
		expect(tools(left)).toEqual(['New Claude conversation', 'More ways to start', 'Split right', 'Split down', 'Close this pane']);
		expect(tools(right)).toEqual(['New Claude conversation', 'More ways to start', 'Split right', 'Split down', 'Close this pane', 'Fill the window', 'Hide the Claude pane']);
	});

	test('stacked panes: the top one is the corner', async () => {
		const el = await shown({ type: 'split', id: 's1', dir: 'column', children: [pane('top'), pane('bottom')], sizes: [0.5, 0.5] });
		const [top, bottom] = panes(el);
		expect(tools(top)).toContain('Hide the Claude pane');
		expect(tools(bottom)).not.toContain('Hide the Claude pane');
	});

	test('the plus starts a new Claude conversation in that pane, in the checkout on screen', async () => {
		const el = await shown({ type: 'split', id: 's1', dir: 'row', children: [pane('left'), pane('right')], sizes: [0.5, 0.5] });
		await click(tool(panes(el)[1], 'New Claude conversation'));
		const [made] = workspace.conversations();
		expect(made).toMatchObject({ kind: 'claude', repoId: REPO, cwd: REPO, state: 'starting', title: 'New conversation' });
		// A session id of ours, so it can be continued later.
		expect(made.sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(paneOf(made.id).id).toBe('right');
		expect(tabNames(panes(el)[1])).toEqual(['New conversation']);
		expect(tabNames(panes(el)[0])).toEqual([]);
		expect(w.sent('worktree_add')).toEqual([]);
	});

	test('the plus says where the conversation would run', async () => {
		const el = await shown(pane('p1'));
		expect(tool(panes(el)[0], 'New Claude conversation').title).toBe('New Claude conversation in harmony');
	});

	test('Split right puts an empty pane beside it; Split down, one under it', async () => {
		const el = await shown(pane('p1', ['c1']), [conversation()]);
		await click(tool(panes(el)[0], 'Split right'));
		expect(layout()).toMatchObject({ type: 'split', dir: 'row', children: [{ id: 'p1', tabs: ['c1'] }, { tabs: [] }] });
		expect(panes(el).length).toBe(2);
		expect(read(panes(el)[1])).toContain('New Claude conversation');
		await click(tool(panes(el)[0], 'Split down'));
		expect(panesOf(layout()).length).toBe(3);
		expect((layout() as { children: LayoutNode[] }).children[0]).toMatchObject({ type: 'split', dir: 'column' });
	});

	test('closing a pane moves its tabs next door, and nothing in them ends', async () => {
		const el = await shown({ type: 'split', id: 's1', dir: 'row', children: [pane('left', ['c1']), pane('right', ['c2'])], sizes: [0.5, 0.5] }, [conversation({ id: 'c1', title: 'First' }), conversation({ id: 'c2', title: 'Second' })]);
		await click(tool(panes(el)[1], 'Close this pane'));
		expect(panes(el).length).toBe(1);
		expect(tabNames(panes(el)[0])).toEqual(['First', 'Second']);
		expect(workspace.conversations().map((c) => c.state)).toEqual(['idle', 'idle']);
		expect(tools(panes(el)[0])).not.toContain('Close this pane');
	});

	test('fill the window shows the workspace alone, and the same button brings the files back', async () => {
		const el = await shown(pane('p1'));
		await click(tool(panes(el)[0], 'Fill the window'));
		expect(workspace.view()).toBe('full');
		expect(tools(panes(el)[0])).toContain('Show the files');
		await click(tool(panes(el)[0], 'Show the files'));
		expect(workspace.view()).toBe('side');
	});

	test('hide puts the pane away and leaves its conversations as they are', async () => {
		const el = await shown(pane('p1', ['c1']), [conversation({ state: 'working' })]);
		expect(tool(panes(el)[0], 'Hide the Claude pane').title).toContain('Conversations keep running.');
		await click(tool(panes(el)[0], 'Hide the Claude pane'));
		expect(workspace.view()).toBe('hidden');
		expect(workspace.conversations()[0].state).toBe('working');
		expect(JSON.parse(localStorage.getItem('studio.workspace.views')!)).toEqual({ [REPO]: 'hidden' });
	});
});

describe('the menu beside the plus', () => {
	const menu = (p: HTMLElement): HTMLElement => find(p, 'ml-popover')!;

	test('starts a conversation in a new worktree on the branch typed, with spaces made hyphens', async () => {
		const el = await shown(pane('p1'));
		const form = find(menu(panes(el)[0]), 'form')!;
		const input = find<HTMLInputElement>(form, 'input')!;
		const start = find<HTMLButtonElement>(form, 'button[type=submit]')!;
		expect(read(form)).toContain('New conversation in a new worktree');
		expect(start.disabled).toBe(true);
		input.value = 'fix seek drift';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect(input.value).toBe('fix-seek-drift');
		expect(start.disabled).toBe(false);
		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(w.sent('worktree_add').map((c) => c.args)).toEqual([{ id: REPO, branch: 'fix-seek-drift', base: null }]);
		const [made] = workspace.conversations();
		expect(made).toMatchObject({ kind: 'claude', branch: 'fix-seek-drift', state: 'starting' });
		expect(made.cwd).not.toBe(REPO);
		expect(paneOf(made.id).id).toBe('p1');
		// The box is empty for the next one.
		expect(find<HTMLInputElement>(form, 'input')!.value).toBe('');
	});

	test('an empty branch starts nothing', async () => {
		const el = await shown(pane('p1'));
		find(menu(panes(el)[0]), 'form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(w.sent('worktree_add')).toEqual([]);
		expect(workspace.conversations()).toEqual([]);
	});

	test('a worktree that cannot be made starts no conversation', async () => {
		w.on('worktree_add', () => {
			throw { kind: 'git', message: "a branch named 'main' already exists", paths: [] };
		});
		const el = await shown(pane('p1'));
		const form = find(menu(panes(el)[0]), 'form')!;
		find<HTMLInputElement>(form, 'input')!.value = 'main';
		find(form, 'input')!.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(workspace.conversations()).toEqual([]);
	});

	test('New terminal opens your shell in the same pane, named after the folder', async () => {
		const el = await shown(pane('p1'));
		const terminal = (): HTMLElement => all(menu(panes(el)[0]), 'button').find((b) => read(b) === 'New terminal')!;
		await click(terminal());
		await click(terminal());
		expect(workspace.conversations().map((c) => [c.kind, c.title, c.cwd])).toEqual([
			['shell', 'harmony', REPO],
			['shell', 'harmony 2', REPO],
		]);
		expect(tabNames(panes(el)[0])).toEqual(['harmony', 'harmony 2']);
	});
});

describe('an empty pane', () => {
	test('offers a conversation or a terminal, and says where they would run', async () => {
		const el = await shown(pane('p1'));
		expect(read(find(panes(el)[0], '.start')!)).toBe("New Claude conversation Claude Code in harmony New terminal Your shell, in the same folder Drag a tab here from another pane, or onto a pane's edge to split it.");
	});

	test('either starts in that pane, and the offer gives way to it', async () => {
		const el = await shown(pane('p1'));
		await click(all(panes(el)[0], '.start button')[1]);
		expect(workspace.conversations().map((c) => c.kind)).toEqual(['shell']);
		expect(find(panes(el)[0], '.start')).toBeNull();
		expect(tabNames(panes(el)[0])).toEqual(['harmony']);
	});

	test('the workspace makes one for a repository that has no layout yet', async () => {
		const el = await mount('ms-workspace');
		await settle();
		expect(panes(el).length).toBe(1);
		expect(read(panes(el)[0])).toContain('New Claude conversation');
		expect(workspace.layout()).toMatchObject({ type: 'pane', tabs: [] });
	});
});

describe('tabs', () => {
	const two = (): Promise<HTMLElement> => shown(pane('p1', ['c1', 'c2'], 'c1'), [conversation({ id: 'c1', title: 'First' }), conversation({ id: 'c2', title: 'Second', unread: true, state: 'waiting', waitingFor: 'Claude needs your permission to use Bash' })]);

	test('are the conversations and terminals of the pane, each saying how it stands', async () => {
		const el = await two();
		expect(tabNames(panes(el)[0])).toEqual(['First', 'Second']);
		expect(tabs(panes(el)[0]).map((t) => find(t, 'span[title]')?.title)).toEqual(['Ready', 'Needs you']);
	});

	test('a click shows that tab, and what happened in it counts as seen', async () => {
		const el = await two();
		await pick(tabs(panes(el)[0])[1]);
		expect(paneOf('c2').active).toBe('c2');
		expect(workspace.get('c2')!.unread).toBe(false);
	});

	test('the tab on screen says what Claude is waiting for, as text', async () => {
		const el = await shown(pane('p1', ['c1']), [conversation({ state: 'waiting', waitingFor: 'Allow <b>Bash</b>: rm -rf build?' })]);
		expect(read(panes(el)[0])).toContain('Allow <b>Bash</b>: rm -rf build?');
		expect(find(panes(el)[0], 'b')).toBeNull();
	});

	test('closing a conversation keeps it, saved, to be resumed later', async () => {
		const el = await two();
		const close = find(tabs(panes(el)[0])[0], 'button')!;
		expect(close.title).toBe('Close (the conversation is kept and can be resumed)');
		await click(close);
		expect(tabNames(panes(el)[0])).toEqual(['Second']);
		expect(workspace.get('c1')).toMatchObject({ state: 'saved' });
		// Closing it did not select it first.
		expect(paneOf('c2').active).toBe('c2');
	});

	test('closing a terminal ends it for good', async () => {
		const el = await shown(pane('p1', ['t1']), [conversation({ id: 't1', kind: 'shell', title: 'harmony', sessionId: null })]);
		const close = find(tabs(panes(el)[0])[0], 'button')!;
		expect(close.title).toBe('Close terminal');
		await click(close);
		expect(workspace.conversations()).toEqual([]);
	});

	test('a middle click closes a tab', async () => {
		const el = await two();
		tabs(panes(el)[0])[1].dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
		await settle();
		expect(tabNames(panes(el)[0])).toEqual(['First']);
	});

	test('a conversation nobody typed into has nothing to resume: closing it forgets it', async () => {
		const el = await shown(pane('p1', ['c1']), [conversation({ title: 'New conversation', titled: false, state: 'idle' })]);
		await click(find(tabs(panes(el)[0])[0], 'button'));
		expect(workspace.conversations()).toEqual([]);
	});
});

describe('a saved conversation', () => {
	test('shows what it was about and what Claude last said, and resumes only on a click', async () => {
		const el = await shown(pane('p1', ['c1']), [conversation({ state: 'saved', prompt: 'The upload test fails about one run in ten. Why?', lastSaid: 'It waited on a timer instead of the upload.' })]);
		const said = read(find(panes(el)[0], '.start')!);
		expect(said).toContain('The upload test fails about one run in ten. Why?');
		expect(said).toContain('It waited on a timer instead of the upload.');
		expect(said).toContain(`Continues it with claude --resume in ${REPO}`);
		expect(w.sent('claude_open')).toEqual([]);
		expect(workspace.get('c1')!.state).toBe('saved');
		await press(button(panes(el)[0], 'Resume conversation'));
		expect(workspace.get('c1')!.state).toBe('starting');
		expect(find(panes(el)[0], '.start')).toBeNull();
	});

	test('one started in a terminal a moment ago warns that it may still be open there', async () => {
		const el = await shown(pane('p1', ['c1']), [conversation({ state: 'saved', outside: true, updated: Date.now() - 2 * 60_000 })]);
		expect(read(panes(el)[0])).toContain('it may still be open in a terminal. Close it there first, or the two will write to the same conversation.');
	});

	test('one started in a terminal long ago only says so', async () => {
		const el = await shown(pane('p1', ['c1']), [conversation({ state: 'saved', outside: true, updated: Date.now() - 3 * 3_600_000 })]);
		expect(read(panes(el)[0])).toContain('Started outside Melodic Studio, last active 3 hours ago.');
		expect(read(panes(el)[0])).not.toContain('may still be open');
	});

	test('what Claude and the user wrote is text', async () => {
		const el = await shown(pane('p1', ['c1']), [conversation({ state: 'saved', title: '<img src=x onerror=alert(1)>', lastSaid: '<script>alert(2)</script>' })]);
		expect(all(el, 'img, script').length).toBe(0);
		expect(read(panes(el)[0])).toContain('<script>alert(2)</script>');
	});
});

describe('dragging a tab', () => {
	/** Two panes side by side, each given a place on the page (happy-dom lays nothing out). */
	async function sideBySide(): Promise<HTMLElement> {
		const el = await shown({ type: 'split', id: 's1', dir: 'row', children: [pane('left', ['c1', 'c2'], 'c1'), pane('right', ['c3'])], sizes: [0.5, 0.5] }, [conversation({ id: 'c1', title: 'First' }), conversation({ id: 'c2', title: 'Second' }), conversation({ id: 'c3', title: 'Third' })]);
		const [left, right] = panes(el);
		left.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
		right.getBoundingClientRect = () => new DOMRect(400, 0, 400, 300);
		return el;
	}
	const drag = async (tab: HTMLElement, x: number, y: number, release = true): Promise<void> => {
		tab.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 20, clientY: 10, bubbles: true, composed: true }));
		window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }));
		await settle();
		if (release) {
			window.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y }));
			await settle();
		}
	};

	test('onto the middle of another pane moves it there', async () => {
		const el = await sideBySide();
		await drag(tabs(panes(el)[0])[1], 600, 150);
		expect(tabNames(panes(el)[0])).toEqual(['First']);
		expect(tabNames(panes(el)[1])).toEqual(['Third', 'Second']);
		expect(paneOf('c2').active).toBe('c2');
	});

	test('onto a pane’s edge splits that pane', async () => {
		const el = await sideBySide();
		await drag(tabs(panes(el)[0])[1], 790, 150);
		expect(panesOf(layout()).map((p) => p.tabs)).toEqual([['c1'], ['c3'], ['c2']]);
		expect(panes(el).length).toBe(3);
	});

	test('onto a pane’s tab row always adds to it, however near the edge', async () => {
		const el = await sideBySide();
		await drag(tabs(panes(el)[0])[1], 795, 10);
		expect(panesOf(layout()).map((p) => p.tabs)).toEqual([['c1'], ['c3', 'c2']]);
	});

	test('shows where it would land while it is held', async () => {
		const el = await sideBySide();
		await drag(tabs(panes(el)[0])[1], 790, 150, false);
		expect(workspace.dragging()).toEqual({ tab: 'c2', pane: 'right', drop: 'right' });
		window.dispatchEvent(new MouseEvent('pointercancel'));
		await settle();
		expect(workspace.dragging()).toBeNull();
		// Let go of nowhere: it stays where it was.
		expect(tabNames(panes(el)[0])).toEqual(['First', 'Second']);
	});

	test('a press that barely moves is a click, not a drag', async () => {
		const el = await sideBySide();
		const tab = tabs(panes(el)[0])[1];
		tab.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 20, clientY: 10, bubbles: true, composed: true }));
		window.dispatchEvent(new MouseEvent('pointermove', { clientX: 22, clientY: 11 }));
		window.dispatchEvent(new MouseEvent('pointerup', { clientX: 22, clientY: 11 }));
		await settle();
		expect(workspace.dragging()).toBeNull();
		expect(paneOf('c2')).toMatchObject({ id: 'left', active: 'c2' });
	});

	test('a pane emptied by the drag goes away', async () => {
		const el = await sideBySide();
		await drag(tabs(panes(el)[1])[0], 200, 150);
		expect(panes(el).length).toBe(1);
		expect(tabNames(panes(el)[0])).toEqual(['First', 'Second', 'Third']);
	});
});
