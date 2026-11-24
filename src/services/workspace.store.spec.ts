import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, world, type World } from '../test/world';
import type { BackendService, ClaudeHook, ClaudeSession } from './backend.service';
import type { RepoStore } from './repo.store';
import type { Conversation, LayoutNode, Pane, Split, WorkspaceStore } from './workspace.store';

// xterm.js needs a real page to measure in. A stand-in that keeps what was written to it and lets a test
// type into it, so the pool is tested and the terminal emulator is not.
const xterm = vi.hoisted(() => {
	interface Key {
		type: string;
		key: string;
		shiftKey?: boolean;
		ctrlKey?: boolean;
		altKey?: boolean;
		metaKey?: boolean;
		preventDefault(): void;
	}
	class FakeTerminal {
		cols = 80;
		rows = 24;
		options: Record<string, unknown>;
		/** What was written to the screen, in order. */
		written: (string | Uint8Array)[] = [];
		host: HTMLElement | null = null;
		focused = false;
		disposed = false;
		selected = '';
		/** The handler the pool gave for keys: false means xterm leaves the key alone. */
		keys: (e: Key) => boolean = () => true;
		private _data: ((data: string) => void)[] = [];
		private _resize: ((size: { cols: number; rows: number }) => void)[] = [];
		constructor(options: Record<string, unknown> = {}) {
			this.options = { ...options };
			terms.push(this);
		}
		loadAddon(): void {}
		onData(fn: (data: string) => void): void {
			this._data.push(fn);
		}
		onResize(fn: (size: { cols: number; rows: number }) => void): void {
			this._resize.push(fn);
		}
		attachCustomKeyEventHandler(fn: (e: Key) => boolean): void {
			this.keys = fn;
		}
		open(host: HTMLElement): void {
			this.host = host;
		}
		write(data: string | Uint8Array): void {
			this.written.push(data);
		}
		/** As xterm does for a key or a paste: it goes to the program. */
		input(data: string): void {
			this._data.forEach((fn) => fn(data));
		}
		paste(data: string): void {
			this.input(data);
		}
		resize(cols: number, rows: number): void {
			this.cols = cols;
			this.rows = rows;
			this._resize.forEach((fn) => fn({ cols, rows }));
		}
		focus(): void {
			this.focused = true;
		}
		blur(): void {
			this.focused = false;
		}
		dispose(): void {
			this.disposed = true;
		}
		getSelection(): string {
			return this.selected;
		}
		hasSelection(): boolean {
			return !!this.selected;
		}
		clearSelection(): void {
			this.selected = '';
		}
		/** The screen's text so far. */
		text(): string {
			const decoder = new TextDecoder();
			return this.written.map((d) => (typeof d === 'string' ? d : decoder.decode(d, { stream: true }))).join('');
		}
	}
	const terms: FakeTerminal[] = [];
	return { terms, FakeTerminal };
});

vi.mock('../shared/xterm', () => ({
	loadXterm: async () => ({ Terminal: xterm.FakeTerminal, FitAddon: class { fit(): void {} }, WebLinksAddon: class {} }),
	adoptXtermStyles: () => undefined,
	xtermTheme: () => ({ background: document.documentElement.getAttribute('data-theme') === 'dark' ? '#000000' : '#ffffff' }),
}));


// The workspace store imports the agents store, whose language service loads Monaco as soon as the Files tab is
// the one on screen. happy-dom cannot run Monaco, and nothing here needs it: it never finishes loading.
vi.mock('../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: () => Promise.resolve(), releaseMonacoStyles: () => undefined }));

type FakeTerminal = InstanceType<typeof xterm.FakeTerminal>;

let w: World;
let repos: RepoStore;
let ws: WorkspaceStore;
let backend: BackendService;
let m: typeof import('./workspace.store');
/** The element each pane was given, as its component would. */
let boxes: Map<string, HTMLElement>;
/** The native keys handed out, by the Claude session they were opened for. */
let keys: Map<string, string>;

const HARMONY = '/Users/demo/Source/harmony';
const CADENCE = '/Users/demo/Source/cadence';
const CONV_KEY = 'studio.conversations';
const LAYOUT_KEY = 'studio.workspace.layouts';
const VIEW_KEY = 'studio.workspace.view';
const VIEWS_KEY = 'studio.workspace.views';
const WIDTH_KEY = 'studio.workspace.width';

/** Lets promises, frames and timers up to `ms` from now run. */
async function tick(ms = 20): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

function size(el: HTMLElement, width: number, height: number): void {
	Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
	Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
}

/** An element with a size, as a pane on screen has. */
function box(width = 800, height = 400): HTMLElement {
	const el = document.createElement('div');
	size(el, width, height);
	document.body.append(el);
	return el;
}

/** The app started over, with `storage` as the last session left it. Programs get the keys k1, k2, ... */
async function start(storage: Record<string, string> = {}): Promise<void> {
	xterm.terms.length = 0;
	boxes = new Map();
	keys = new Map();
	w = await world();
	for (const [key, value] of Object.entries(storage)) {
		localStorage.setItem(key, value);
	}
	let n = 0;
	w.on('claude_open', (args) => {
		const key = `k${++n}`;
		keys.set(String(args.session), key);
		return key;
	});
	w.on('term_open', () => `k${++n}`);
	w.on('term_write', () => undefined);
	w.on('term_resize', () => undefined);
	w.on('term_close', () => undefined);
	backend = w.get((await import('./backend.service')).BackendService);
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	m = await import('./workspace.store');
	ws = w.get(m.WorkspaceStore);
}

/** Quit and start again with what was saved. A moment passes, as it does between two runs of the app. */
async function restart(): Promise<void> {
	const kept: Record<string, string> = {};
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i)!;
		kept[key] = localStorage.getItem(key)!;
	}
	await tick(5000);
	await start(kept);
}

function saved<T>(key: string): T {
	return JSON.parse(localStorage.getItem(key) ?? 'null') as T;
}

function panes(): Pane[] {
	return m.panesOf(ws.layout()!);
}

/** The pane a tab is in. */
function paneOf(tab: string): Pane {
	return panes().find((p) => p.tabs.includes(tab))!;
}

function splits(node: LayoutNode): Split[] {
	return node.type === 'pane' ? [] : [node, ...node.children.flatMap(splits)];
}

/** Every split has a share for each child, the shares add up to 1, and no split holds a single child. */
function wellFormed(): void {
	for (const s of splits(ws.layout()!)) {
		expect(s.children.length).toBeGreaterThan(1);
		expect(s.sizes.length).toBe(s.children.length);
		expect(s.sizes.reduce((sum, x) => sum + x, 0)).toBeCloseTo(1, 10);
		expect(s.sizes.every((x) => x > 0)).toBe(true);
	}
}

/** Put every pane of the open repository's layout on screen, as its component does when it renders. */
function onScreen(): void {
	for (const pane of panes()) {
		if (!boxes.has(pane.id)) {
			const el = box();
			boxes.set(pane.id, el);
			ws.attachPane(pane.id, el);
		}
	}
}

/** A shell tab, without a screen: enough for what is about tabs and panes. */
function shell(pane?: string): string {
	ws.newShell(pane);
	return ws.conversations().at(-1)!.id;
}

interface Running {
	id: string;
	/** The native side's name for its program. */
	key: string;
	term: FakeTerminal;
}

/** A Claude conversation in the open repository, on screen, with Claude Code running behind it. */
async function claude(options: { pane?: string; branch?: string } = {}): Promise<Running> {
	await ws.newClaude(options);
	const conv = ws.conversations().at(-1)!;
	onScreen();
	await tick();
	return { id: conv.id, key: keys.get(conv.sessionId!)!, term: xterm.terms.at(-1)! };
}

/** A conversation the user has typed into: it has a title, so it is kept. */
async function titled(prompt = 'Make the queue shuffle'): Promise<Running> {
	const c = await claude();
	hook(c.key, 'UserPromptSubmit', { text: prompt });
	hook(c.key, 'Stop', { text: 'Done.' });
	return c;
}

function hook(key: string, event: ClaudeHook['event'], extra: Partial<ClaudeHook> = {}): void {
	w.emit('claude-hook', { key, event, sessionId: null, transcriptPath: null, text: null, kind: null, toolUseId: null, description: null, subagentType: null, ...extra });
}

function outside(over: Partial<ClaudeSession> = {}): ClaudeSession {
	return { id: 'sess-1', cwd: HARMONY, branch: 'main', title: 'Flaky upload test', prompt: 'The upload test fails about one run in ten on CI. Can you find out why?', lastPrompt: 'ok, make the fix', lastSaid: 'Fixed: the test waited on a timer.', modified: 1_700_000_000_000, ...over };
}

/** An outside session brought into the workspace of `repoId`. */
async function adopted(over: Partial<ClaudeSession> = {}, repoId = HARMONY): Promise<Conversation> {
	const s = outside(over);
	await ws.adopt(repoId, s);
	return ws.conversations().find((c) => c.sessionId === s.id)!;
}

function conv(id: string): Conversation {
	return ws.get(id)!;
}

beforeEach(async () => {
	vi.useFakeTimers();
	await start();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the layout: panes and tabs', () => {
	test('a repository starts with one empty pane', async () => {
		expect(ws.layout()).toBeNull();
		const first = ws.ensureLayout()!;
		expect(first).toMatchObject({ type: 'pane', tabs: [], active: null });
		await tick(0);
		expect(ws.layout()).toEqual(first);
		// Asking again answers the same layout, not a new one.
		expect(ws.ensureLayout()).toEqual(first);
	});

	test('a new tab goes into the pane, becomes its active tab, and the pane has the focus', () => {
		const a = shell();
		const b = shell();
		expect(panes()).toMatchObject([{ tabs: [a, b], active: b }]);
		expect(ws.focusedPane()).toBe(panes()[0].id);
	});

	test('new tabs go to the focused pane', () => {
		const a = shell();
		ws.split(paneOf(a).id, 'row');
		const b = shell();
		expect(panes().map((p) => p.tabs)).toEqual([[a], [b]]);
		ws.select(a);
		const c = shell();
		expect(panes().map((p) => p.tabs)).toEqual([[a, c], [b]]);
	});

	test('a tab can be started in a pane that is named', () => {
		const a = shell();
		ws.split(paneOf(a).id, 'row');
		const b = shell(paneOf(a).id);
		expect(panes().map((p) => p.tabs)).toEqual([[a, b], []]);
	});

	test('dropping a tab on the right edge of a pane puts it in a new pane beside it, half each', () => {
		const a = shell();
		const b = shell();
		const from = paneOf(a).id;
		ws.place(b, from, 'right');
		const layout = ws.layout() as Split;
		expect(layout).toMatchObject({ type: 'split', dir: 'row', sizes: [0.5, 0.5] });
		expect(layout.children).toMatchObject([{ id: from, tabs: [a], active: a }, { tabs: [b], active: b }]);
		expect(ws.focusedPane()).toBe(paneOf(b).id);
	});

	test('the left and top edges put the new pane first, the bottom edge stacks it under', () => {
		const a = shell();
		const b = shell();
		ws.place(b, paneOf(a).id, 'left');
		expect(ws.layout()).toMatchObject({ dir: 'row', children: [{ tabs: [b] }, { tabs: [a] }] });
		ws.place(b, paneOf(a).id, 'center');
		ws.place(b, paneOf(a).id, 'top');
		expect(ws.layout()).toMatchObject({ dir: 'column', children: [{ tabs: [b] }, { tabs: [a] }] });
		ws.place(b, paneOf(a).id, 'center');
		ws.place(b, paneOf(a).id, 'bottom');
		expect(ws.layout()).toMatchObject({ dir: 'column', children: [{ tabs: [a] }, { tabs: [b] }], sizes: [0.5, 0.5] });
	});

	test('splitting in the same direction adds a neighbour that shares the split pane\'s space', () => {
		const a = shell();
		ws.split(paneOf(a).id, 'row');
		const right = panes()[1].id;
		ws.split(right, 'row');
		const layout = ws.layout() as Split;
		expect(layout.children.length).toBe(3);
		expect(layout.sizes).toEqual([0.5, 0.25, 0.25]);
		expect(layout.children[1].id).toBe(right);
		expect(ws.focusedPane()).toBe(layout.children[2].id);
		ws.split(paneOf(a).id, 'row');
		expect((ws.layout() as Split).sizes).toEqual([0.25, 0.25, 0.25, 0.25]);
		wellFormed();
	});

	test('splitting the other way nests a split in the pane\'s place', () => {
		const a = shell();
		ws.split(paneOf(a).id, 'row');
		ws.split(paneOf(a).id, 'column');
		const layout = ws.layout() as Split;
		expect(layout).toMatchObject({ dir: 'row', sizes: [0.5, 0.5] });
		expect(layout.children[0]).toMatchObject({ type: 'split', dir: 'column', sizes: [0.5, 0.5], children: [{ tabs: [a] }, { tabs: [] }] });
		expect(layout.children[1]).toMatchObject({ type: 'pane' });
	});

	test('a split pane is empty and has the focus, so what is started next lands in it', () => {
		const a = shell();
		ws.split(paneOf(a).id, 'column');
		expect(panes()[1]).toMatchObject({ tabs: [], active: null });
		expect(ws.focusedPane()).toBe(panes()[1].id);
	});

	test('moving a tab to the middle of another pane adds it there and selects it', () => {
		const a = shell();
		const b = shell();
		const c = shell();
		ws.place(c, paneOf(a).id, 'right');
		ws.place(b, paneOf(c).id, 'center');
		expect(panes()).toMatchObject([{ tabs: [a], active: a }, { tabs: [c, b], active: b }]);
	});

	test('a pane whose only tab moved away is gone, and its space goes to the others', () => {
		const a = shell();
		const b = shell();
		const c = shell();
		ws.place(b, paneOf(a).id, 'right');
		ws.place(c, paneOf(b).id, 'right');
		expect((ws.layout() as Split).sizes).toEqual([0.5, 0.25, 0.25]);
		ws.place(b, paneOf(a).id, 'center');
		const layout = ws.layout() as Split;
		expect(layout.children).toMatchObject([{ tabs: [a, b] }, { tabs: [c] }]);
		expect(layout.sizes[0]).toBeCloseTo(2 / 3, 10);
		expect(layout.sizes[1]).toBeCloseTo(1 / 3, 10);
		wellFormed();
	});

	test('a split left with one pane becomes that pane', () => {
		const a = shell();
		const b = shell();
		ws.place(b, paneOf(a).id, 'right');
		ws.place(b, paneOf(a).id, 'center');
		expect(ws.layout()).toMatchObject({ type: 'pane', tabs: [a, b], active: b });
	});

	test('the tab left behind in a pane is the one before the tab that moved', () => {
		const a = shell();
		const b = shell();
		const c = shell();
		ws.select(b);
		ws.place(b, paneOf(a).id, 'bottom');
		expect(paneOf(a)).toMatchObject({ tabs: [a, c], active: a });
	});

	test('dropping a tab on the middle of its own pane only selects it', () => {
		const a = shell();
		const b = shell();
		const before = ws.layout();
		ws.place(a, paneOf(a).id, 'center');
		expect(ws.layout()).toEqual({ ...before, active: a });
	});

	test('a pane\'s only tab cannot be split away from itself', () => {
		const a = shell();
		const before = ws.layout();
		ws.place(a, paneOf(a).id, 'right');
		expect(ws.layout()).toEqual(before);
	});

	test('one of several tabs can be split off its own pane', () => {
		const a = shell();
		const b = shell();
		ws.place(b, paneOf(b).id, 'bottom');
		expect(ws.layout()).toMatchObject({ dir: 'column', children: [{ tabs: [a] }, { tabs: [b] }] });
	});

	test('a tab placed on a pane that is not there lands in the first pane', () => {
		const a = shell();
		const b = shell();
		ws.place(b, paneOf(a).id, 'right');
		ws.place(b, 'no-such-pane', 'bottom');
		expect(ws.layout()).toMatchObject({ type: 'pane', tabs: [a, b], active: b });
	});

	test('closing a pane moves its tabs to the pane before it', () => {
		const a = shell();
		const b = shell();
		const c = shell();
		ws.place(b, paneOf(a).id, 'right');
		ws.place(c, paneOf(b).id, 'center');
		ws.closePane(paneOf(b).id);
		expect(ws.layout()).toMatchObject({ type: 'pane', tabs: [a, b, c], active: a });
		expect(ws.focusedPane()).toBe(paneOf(a).id);
	});

	test('closing the first pane moves its tabs to the next', () => {
		const a = shell();
		const b = shell();
		ws.place(b, paneOf(a).id, 'right');
		ws.closePane(paneOf(a).id);
		expect(ws.layout()).toMatchObject({ type: 'pane', tabs: [b, a], active: b });
	});

	test('tabs moved into an empty pane keep their active one', () => {
		const a = shell();
		const b = shell();
		ws.select(a);
		ws.split(paneOf(a).id, 'row');
		const empty = panes()[1].id;
		ws.closePane(paneOf(a).id);
		expect(ws.layout()).toMatchObject({ type: 'pane', id: empty, tabs: [a, b], active: a });
	});

	test('the last pane cannot be closed, nor one that is not there', () => {
		const a = shell();
		const before = ws.layout();
		ws.closePane(paneOf(a).id);
		ws.closePane('no-such-pane');
		expect(ws.layout()).toEqual(before);
	});

	test('selecting a tab makes it its pane\'s active tab and gives that pane the focus', () => {
		const a = shell();
		const b = shell();
		const c = shell();
		ws.place(c, paneOf(a).id, 'right');
		ws.select(a);
		expect(paneOf(a).active).toBe(a);
		expect(ws.focusedPane()).toBe(paneOf(a).id);
		expect(paneOf(c).active).toBe(c);
		expect(paneOf(b).tabs).toEqual([a, b]);
	});

	test('selecting a tab that is in no pane changes nothing', () => {
		shell();
		const before = ws.layout();
		ws.select('no-such-tab');
		expect(ws.layout()).toEqual(before);
	});

	test('closing the active tab selects the one before it and keeps the pane', () => {
		const a = shell();
		const b = shell();
		const c = shell();
		ws.select(b);
		ws.close(b);
		expect(panes()).toMatchObject([{ tabs: [a, c], active: a }]);
		ws.close(a);
		expect(panes()).toMatchObject([{ tabs: [c], active: c }]);
		ws.close(c);
		expect(panes()).toMatchObject([{ tabs: [], active: null }]);
	});

	test('a tab is closed in its own repository\'s layout, whichever repository is on screen', async () => {
		const a = shell();
		const b = shell();
		await repos.selectRepo(CADENCE);
		ws.close(a);
		await repos.selectRepo(HARMONY);
		expect(panes()).toMatchObject([{ tabs: [b] }]);
	});

	test('closing a tab that is not active leaves the active one', () => {
		const a = shell();
		const b = shell();
		ws.close(a);
		expect(panes()).toMatchObject([{ tabs: [b], active: b }]);
	});

	test('new shares are taken as given', () => {
		const a = shell();
		ws.split(paneOf(a).id, 'row');
		ws.resize(ws.layout()!.id, [0.3, 0.7]);
		expect((ws.layout() as Split).sizes).toEqual([0.3, 0.7]);
		ws.resize('no-such-split', [0.9, 0.1]);
		expect((ws.layout() as Split).sizes).toEqual([0.3, 0.7]);
	});

	test('the shares of every split add up to 1 through splits, moves and closes', () => {
		const [a, b, c, d, e] = [shell(), shell(), shell(), shell(), shell()];
		const steps: (() => void)[] = [
			() => ws.place(b, paneOf(a).id, 'right'),
			() => ws.place(c, paneOf(b).id, 'right'),
			() => ws.place(d, paneOf(a).id, 'bottom'),
			() => ws.split(paneOf(c).id, 'row'),
			() => ws.resize(ws.layout()!.id, [0.1, 0.2, 0.3, 0.4]),
			() => ws.place(e, paneOf(b).id, 'top'),
			() => ws.place(c, paneOf(a).id, 'center'),
			() => ws.closePane(paneOf(b).id),
			() => ws.split(paneOf(d).id, 'column'),
			() => ws.place(e, paneOf(d).id, 'left'),
			() => ws.close(d),
			() => ws.closePane(paneOf(e).id),
			() => ws.place(a, paneOf(e).id, 'center'),
		];
		for (const step of steps) {
			step();
			wellFormed();
		}
		// Nothing was lost on the way.
		expect(panes().flatMap((p) => p.tabs).sort()).toEqual([a, b, c, e].sort());
		for (const pane of panes()) {
			expect(pane.active === null || pane.tabs.includes(pane.active)).toBe(true);
		}
	});

	test('the corner pane is the one at the top right', () => {
		const pane = (id: string): Pane => ({ type: 'pane', id, tabs: [], active: null });
		const split = (dir: 'row' | 'column', ...children: LayoutNode[]): Split => ({ type: 'split', id: `s-${children.map((c) => c.id).join('')}`, dir, children, sizes: children.map(() => 1 / children.length) });
		expect(m.cornerPane(pane('a')).id).toBe('a');
		expect(m.cornerPane(split('row', pane('a'), pane('b'), pane('c'))).id).toBe('c');
		expect(m.cornerPane(split('column', pane('a'), pane('b'))).id).toBe('a');
		expect(m.cornerPane(split('row', pane('a'), split('column', pane('b'), pane('c')))).id).toBe('b');
		expect(m.cornerPane(split('column', split('row', pane('a'), pane('b')), pane('c'))).id).toBe('b');
	});

	test('the corner follows the layout as it is split', () => {
		const a = shell();
		expect(m.cornerPane(ws.layout()!).id).toBe(paneOf(a).id);
		ws.split(paneOf(a).id, 'row');
		const right = panes()[1].id;
		expect(m.cornerPane(ws.layout()!).id).toBe(right);
		ws.split(right, 'column');
		expect(m.cornerPane(ws.layout()!).id).toBe(right);
		ws.place(a, right, 'top');
		expect(m.cornerPane(ws.layout()!).id).toBe(paneOf(a).id);
	});

	test('panes are listed in reading order', () => {
		const pane = (id: string): Pane => ({ type: 'pane', id, tabs: [], active: null });
		const tree: Split = {
			type: 'split',
			id: 's1',
			dir: 'row',
			sizes: [0.5, 0.5],
			children: [{ type: 'split', id: 's2', dir: 'column', sizes: [0.5, 0.5], children: [pane('a'), pane('b')] }, { type: 'split', id: 's3', dir: 'column', sizes: [0.5, 0.5], children: [pane('c'), pane('d')] }],
		};
		expect(m.panesOf(tree).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(m.panesOf(pane('x')).map((p) => p.id)).toEqual(['x']);
	});

	test('with no repository open there is no layout and nothing to start', async () => {
		w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: '', authorEmail: '', appVersion: '0' }));
		await repos.switchContext();
		expect(ws.ensureLayout()).toBeNull();
		ws.newShell();
		await ws.newClaude();
		ws.setView('full');
		expect(ws.conversations()).toEqual([]);
		expect(ws.layouts()).toEqual({});
		expect(localStorage.getItem(VIEWS_KEY)).toBeNull();
	});
});

describe('one layout per repository', () => {
	test('another repository has a layout of its own', async () => {
		const a = shell();
		ws.split(paneOf(a).id, 'row');
		await repos.selectRepo(CADENCE);
		expect(ws.layout()).toBeNull();
		ws.ensureLayout();
		await tick(0);
		expect(panes()).toMatchObject([{ tabs: [] }]);
		const b = shell();
		expect(panes().map((p) => p.tabs)).toEqual([[b]]);
		expect(conv(b)).toMatchObject({ repoId: CADENCE, cwd: CADENCE, title: 'cadence' });
		await repos.selectRepo(HARMONY);
		expect(panes().map((p) => p.tabs)).toEqual([[a], []]);
	});

	test('layouts are saved by repository as they change', async () => {
		const a = (await adopted()).id;
		ws.split(paneOf(a).id, 'column');
		expect(saved<Record<string, LayoutNode>>(LAYOUT_KEY)[HARMONY]).toMatchObject({ type: 'split', dir: 'column', children: [{ tabs: [a] }, { tabs: [] }] });
		await repos.selectRepo(CADENCE);
		const b = (await adopted({ id: 'sess-2', cwd: CADENCE }, CADENCE)).id;
		const all = saved<Record<string, LayoutNode>>(LAYOUT_KEY);
		expect(Object.keys(all).sort()).toEqual([CADENCE, HARMONY].sort());
		expect(all[CADENCE]).toMatchObject({ type: 'pane', tabs: [b] });
	});

	test('dragging a divider is saved when the drag ends, not on every move', () => {
		const a = shell();
		ws.split(paneOf(a).id, 'row');
		ws.resize(ws.layout()!.id, [0.3, 0.7]);
		expect((saved<Record<string, LayoutNode>>(LAYOUT_KEY)[HARMONY] as Split).sizes).toEqual([0.5, 0.5]);
		ws.saveLayouts();
		expect((saved<Record<string, LayoutNode>>(LAYOUT_KEY)[HARMONY] as Split).sizes).toEqual([0.3, 0.7]);
	});

	test('the layout comes back after a restart with its conversations in their panes', async () => {
		const a = (await adopted({ id: 'sess-1' })).id;
		const b = (await adopted({ id: 'sess-2' })).id;
		ws.place(b, paneOf(a).id, 'right');
		ws.resize(ws.layout()!.id, [0.3, 0.7]);
		ws.saveLayouts();
		await restart();
		expect(ws.layout()).toBeNull();
		const layout = ws.ensureLayout()!;
		expect(layout).toMatchObject({ type: 'split', dir: 'row', sizes: [0.3, 0.7], children: [{ tabs: [a], active: a }, { tabs: [b], active: b }] });
	});

	test('shells are not saved: neither as conversations nor as tabs of a saved layout', async () => {
		const a = (await adopted()).id;
		const s = shell();
		ws.select(s);
		expect(paneOf(a)).toMatchObject({ tabs: [a, s], active: s });
		expect(saved<Conversation[]>(CONV_KEY).map((c) => c.id)).toEqual([a]);
		expect(saved<Record<string, LayoutNode>>(LAYOUT_KEY)[HARMONY]).toMatchObject({ tabs: [a], active: a });
		await restart();
		expect(ws.conversations().map((c) => c.id)).toEqual([a]);
		expect(ws.ensureLayout()).toMatchObject({ type: 'pane', tabs: [a], active: a });
	});

	test('a saved tab whose conversation is gone is dropped from the layout', async () => {
		const a = (await adopted({ id: 'sess-1' })).id;
		const b = (await adopted({ id: 'sess-2' })).id;
		const kept = saved<Conversation[]>(CONV_KEY).filter((c) => c.id === a);
		localStorage.setItem(CONV_KEY, JSON.stringify(kept));
		await restart();
		expect(ws.ensureLayout()).toMatchObject({ type: 'pane', tabs: [a], active: a });
		expect(ws.get(b)).toBeNull();
	});

	test('saved layouts that are not JSON are ignored', async () => {
		await start({ [LAYOUT_KEY]: '{oops' });
		expect(ws.ensureLayout()).toMatchObject({ type: 'pane', tabs: [] });
		const a = shell();
		expect(panes()).toMatchObject([{ tabs: [a] }]);
	});

	// A bug until 2026-11-23, low severity (src/services/workspace.store.ts): the saved views, the width and the
	// other stores' keys are read defensively; the saved layouts are taken as they parse. The app never writes
	// anything but an object here, so this needs storage damaged from outside.
	// What holds now: ignored, the repository starts with one empty pane.
	// Before the fix: `ensureLayout` throws a TypeError (`null[repo.id]`), on every render of the workspace.
	test('saved layouts that are JSON but not what was saved are ignored', async () => {
		await start({ [LAYOUT_KEY]: 'null' });
		let layout: LayoutNode | null = null;
		expect(() => (layout = ws.ensureLayout())).not.toThrow();
		expect(layout).toMatchObject({ type: 'pane', tabs: [] });
	});

	test('a conversation saved for one repository does not show up in another\'s layout', async () => {
		const a = (await adopted()).id;
		await restart();
		await repos.selectRepo(CADENCE);
		expect(ws.ensureLayout()).toMatchObject({ type: 'pane', tabs: [] });
		await repos.selectRepo(HARMONY);
		expect(ws.ensureLayout()).toMatchObject({ tabs: [a] });
	});
});

describe('the view, per repository', () => {
	test('the workspace starts beside the main pane', () => {
		expect(ws.view()).toBe('side');
		expect(ws.shown()).toBe('side');
	});

	test('a repository with no view of its own starts with the old shared one', async () => {
		await start({ [VIEW_KEY]: JSON.stringify('hidden') });
		expect(ws.view()).toBe('hidden');
		await repos.selectRepo(CADENCE);
		expect(ws.view()).toBe('hidden');
	});

	test('each repository keeps its own view, and changing one never changes another', async () => {
		ws.setView('hidden');
		expect(saved(VIEWS_KEY)).toEqual({ [HARMONY]: 'hidden' });
		await repos.selectRepo(CADENCE);
		expect(ws.view()).toBe('side');
		ws.setView('full');
		expect(saved(VIEWS_KEY)).toEqual({ [HARMONY]: 'hidden', [CADENCE]: 'full' });
		await repos.selectRepo(HARMONY);
		expect(ws.view()).toBe('hidden');
		// The old shared value is not written any more.
		expect(localStorage.getItem(VIEW_KEY)).toBeNull();
	});

	test('the views come back after a restart, over the old shared value', async () => {
		await start({ [VIEW_KEY]: JSON.stringify('hidden'), [VIEWS_KEY]: JSON.stringify({ [HARMONY]: 'full' }) });
		expect(ws.view()).toBe('full');
		await repos.selectRepo(CADENCE);
		expect(ws.view()).toBe('hidden');
	});

	test('damaged saved views are ignored', async () => {
		await start({ [VIEW_KEY]: 'hidden', [VIEWS_KEY]: '{oops' });
		expect(ws.view()).toBe('side');
		await start({ [VIEW_KEY]: JSON.stringify('sideways'), [VIEWS_KEY]: JSON.stringify({ [HARMONY]: 'huge', [CADENCE]: 'full' }) });
		expect(ws.view()).toBe('side');
		await repos.selectRepo(CADENCE);
		expect(ws.view()).toBe('full');
		await start({ [VIEWS_KEY]: 'null' });
		expect(ws.view()).toBe('side');
	});

	test('toggle hides the workspace and brings it back beside the main pane', () => {
		ws.toggle();
		expect(ws.view()).toBe('hidden');
		ws.toggle();
		expect(ws.view()).toBe('side');
		ws.setView('full');
		ws.toggle();
		expect(ws.view()).toBe('hidden');
	});

	test('something opened in the main pane brings it back when the workspace fills the window', () => {
		ws.setView('full');
		ws.revealMain();
		expect(ws.view()).toBe('side');
		ws.revealMain();
		expect(ws.view()).toBe('side');
		ws.setView('hidden');
		ws.revealMain();
		expect(ws.view()).toBe('hidden');
	});

	test('starting something shows a hidden workspace', () => {
		ws.setView('hidden');
		shell();
		expect(ws.view()).toBe('side');
	});

	test('starting something leaves a workspace that fills the window as it is', () => {
		ws.setView('full');
		shell();
		expect(ws.view()).toBe('full');
	});

	test('the folder on screen is named for labels', async () => {
		expect(ws.checkoutName()).toBe('harmony');
		const tree = await backend.addWorktree(HARMONY, 'agent/shuffle', null);
		await backend.selectWorktree(HARMONY, tree);
		await repos.switchContext();
		expect(ws.checkoutName()).toBe('agent-shuffle');
	});
});

describe('room beside the main pane', () => {
	// The main pane keeps 840 px, the divider is 1 px, and a Claude pane under 320 px is not shown.
	const ENOUGH = 840 + 1 + 320;

	test('until the shell has measured, the workspace is taken to fit', () => {
		expect(ws.fits()).toBe(true);
		expect(ws.shown()).toBe('side');
		expect(ws.width()).toBe(320);
	});

	test('the Claude pane gets a third of the window', () => {
		ws.setRoom(1600, 1800);
		expect(ws.width()).toBe(600);
		expect(ws.shown()).toBe('side');
	});

	test('a third of the window never takes the main pane under its floor', () => {
		ws.setRoom(1300, 1800);
		expect(ws.width()).toBe(1300 - 840 - 1);
	});

	test('the Claude pane is never narrower than a usable terminal', () => {
		ws.setRoom(1300, 900);
		expect(ws.width()).toBe(320);
	});

	test('when both do not fit the workspace is not shown, though its view stays', () => {
		ws.setRoom(ENOUGH - 1, 1400);
		expect(ws.fits()).toBe(false);
		expect(ws.view()).toBe('side');
		expect(ws.shown()).toBe('hidden');
		expect(saved(VIEWS_KEY)).toBeNull();
	});

	test('it comes back by itself when the window grows', () => {
		ws.setRoom(ENOUGH - 1, 1400);
		ws.setRoom(ENOUGH, 1400);
		expect(ws.fits()).toBe(true);
		expect(ws.shown()).toBe('side');
		expect(ws.width()).toBe(320);
	});

	test('a workspace that fills the window, or is hidden, is not changed by a narrow window', () => {
		ws.setRoom(900, 1100);
		ws.setView('full');
		expect(ws.shown()).toBe('full');
		ws.setView('hidden');
		expect(ws.shown()).toBe('hidden');
		ws.setRoom(1600, 1800);
		expect(ws.shown()).toBe('hidden');
	});

	test('with no room beside the main pane, showing the workspace shows it alone', () => {
		ws.setRoom(900, 1100);
		expect(ws.shown()).toBe('hidden');
		ws.toggle();
		expect(ws.view()).toBe('full');
		expect(ws.shown()).toBe('full');
		ws.toggle();
		expect(ws.shown()).toBe('hidden');
	});

	test('with no room beside the main pane, a new conversation shows the workspace alone', async () => {
		ws.setRoom(900, 1100);
		await ws.newClaude();
		expect(ws.shown()).toBe('full');
	});

	test('opening a conversation in a window with no room shows the workspace alone too', async () => {
		const a = shell();
		ws.setView('hidden');
		ws.setRoom(900, 1100);
		await ws.open(a);
		expect(ws.shown()).toBe('full');
	});

	test('dragging the edge may take the main pane lower than its floor, down to the drag floor', () => {
		ws.setRoom(1600, 1800);
		ws.setWidth(900);
		expect(ws.width()).toBe(900);
		ws.setWidth(5000);
		expect(ws.width()).toBe(1600 - 360 - 1);
		ws.setWidth(10);
		expect(ws.width()).toBe(320);
		ws.setWidth(700.4);
		expect(ws.width()).toBe(700);
	});

	test('what is kept of a drag is what the pane really got', () => {
		ws.setRoom(1600, 1800);
		ws.setWidth(5000);
		ws.setRoom(3000, 3200);
		expect(ws.width()).toBe(1600 - 360 - 1);
	});

	test('the dragged width is remembered when the drag ends', async () => {
		ws.setRoom(1600, 1800);
		ws.setWidth(900);
		expect(localStorage.getItem(WIDTH_KEY)).toBeNull();
		ws.saveWidth();
		expect(saved(WIDTH_KEY)).toBe(900);
		await restart();
		ws.setRoom(1600, 1800);
		expect(ws.width()).toBe(900);
	});

	test('the width is shared by every repository', async () => {
		ws.setRoom(1600, 1800);
		ws.setWidth(900);
		await repos.selectRepo(CADENCE);
		expect(ws.width()).toBe(900);
	});

	test('the drag floor keeps applying to a remembered drag when the window shrinks', () => {
		ws.setRoom(1600, 1800);
		ws.setWidth(900);
		ws.setRoom(1000, 1200);
		// 360 for the main pane and the divider leave 639; without a drag this window would have no Claude pane.
		expect(ws.width()).toBe(639);
		expect(ws.shown()).toBe('side');
		ws.setRoom(1600, 1800);
		expect(ws.width()).toBe(900);
	});

	test('once dragged, the pane stays on screen while the drag floor and a usable pane still fit', () => {
		ws.setRoom(1600, 1800);
		ws.setWidth(900);
		ws.setRoom(360 + 1 + 320, 900);
		expect(ws.shown()).toBe('side');
		expect(ws.width()).toBe(320);
		ws.setRoom(360 + 1 + 319, 900);
		expect(ws.shown()).toBe('hidden');
	});

	test('double-clicking the edge goes back to a third of the window and the main pane\'s own floor', () => {
		ws.setRoom(1600, 1800);
		ws.setWidth(900);
		ws.saveWidth();
		ws.setRoom(1000, 1200);
		expect(ws.shown()).toBe('side');
		ws.resetWidth();
		expect(localStorage.getItem(WIDTH_KEY)).toBeNull();
		expect(ws.shown()).toBe('hidden');
		ws.setRoom(1600, 1800);
		expect(ws.width()).toBe(600);
	});

	test('a remembered width decides whether both fit from the start', async () => {
		await start({ [WIDTH_KEY]: '500' });
		ws.setRoom(1000, 1200);
		expect(ws.shown()).toBe('side');
		expect(ws.width()).toBe(500);
	});

	test('a saved width that is too small or not a number is put right', async () => {
		await start({ [WIDTH_KEY]: '100' });
		ws.setRoom(1600, 1800);
		expect(ws.width()).toBe(320);
		for (const broken of ['wide', '"wide"', '-40', '0', 'null']) {
			await start({ [WIDTH_KEY]: broken });
			ws.setRoom(1600, 1800);
			expect(ws.width()).toBe(600);
			ws.setRoom(1000, 1200);
			expect(ws.shown()).toBe('hidden');
		}
	});

	test('a drag before the shell has measured is kept within a usable width', () => {
		ws.setWidth(500);
		expect(ws.width()).toBe(500);
		ws.setWidth(50);
		expect(ws.width()).toBe(320);
	});
});

describe('starting a Claude conversation', () => {
	test('it is the user\'s claude in the checkout on screen, with a session id from the window', async () => {
		const c = await claude();
		const made = conv(c.id);
		expect(made).toMatchObject({ kind: 'claude', repoId: HARMONY, cwd: HARMONY, branch: repos.status()!.branch, title: 'New conversation', titled: false, unread: false, subagents: [] });
		expect(made.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
		expect(w.sent('claude_open').map((x) => x.args)).toEqual([{ id: HARMONY, cwd: HARMONY, session: made.sessionId, resume: false, cols: 80, rows: 24 }]);
		expect(paneOf(c.id).active).toBe(c.id);
	});

	test('it is starting until the program is up, then at the prompt, with no hook needed to say so', async () => {
		await ws.newClaude();
		const id = ws.conversations()[0].id;
		expect(conv(id).state).toBe('starting');
		onScreen();
		await tick();
		expect(conv(id).state).toBe('idle');
	});

	test('every conversation has a session of its own', async () => {
		const a = await claude();
		const b = await claude();
		expect(conv(a.id).sessionId).not.toBe(conv(b.id).sessionId);
		expect(a.key).not.toBe(b.key);
	});

	test('the program is started once its pane has a size', async () => {
		await ws.newClaude();
		const el = box(0, 0);
		ws.attachPane(panes()[0].id, el);
		await tick();
		expect(w.sent('claude_open')).toEqual([]);
		expect(ws.conversations()[0].state).toBe('starting');
		size(el, 800, 400);
		ws.showAll();
		await tick();
		expect(w.sent('claude_open').length).toBe(1);
		expect(el.querySelector('.screen')).toBe(xterm.terms[0].host);
	});

	// A bug until 2026-11-23 (src/services/workspace.store.ts, and src/services/screens.ts which has no guard
	// either): `showPane` starts the program of a `starting` conversation whenever the pool says it has not started,
	// and the pool says so until the native side has answered with the key. `showPane` runs again a frame after a tab
	// is placed, 60 ms after a pane is resized, when a tab is selected or the view changes, so an open call that is
	// still under way then is sent again.
	// What holds now: one `claude_open` per conversation.
	// Before the fix: one more for every `showPane` until the first answers. Two Claude Code processes with the same session
	// id then write to one screen, and only the last key is kept, so the first process is never closed.
	test('a pane shown again while Claude Code is still starting does not start it twice', async () => {
		const answers: ((key: string) => void)[] = [];
		w.on('claude_open', () => new Promise<string>((resolve) => answers.push(resolve)));
		await ws.newClaude();
		ws.attachPane(panes()[0].id, box());
		await tick(0);
		const first = w.sent('claude_open').length;
		// As the frame after a tab was placed does, and the pane's resize observer.
		ws.showAll();
		await tick(0);
		answers.forEach((answer, i) => answer(`slow-${i}`));
		await tick();
		expect(first).toBe(1);
		expect(w.sent('claude_open').length).toBe(1);
	});

	test('showing its pane again does not start it twice', async () => {
		await claude();
		ws.showAll();
		ws.focusActive();
		await tick();
		expect(w.sent('claude_open').length).toBe(1);
		expect(xterm.terms.length).toBe(1);
	});

	test('with a branch it gets a new worktree on that branch and runs there', async () => {
		const c = await claude({ branch: ' agent/try-shuffle ' });
		expect(w.sent('worktree_add').map((x) => x.args)).toEqual([{ id: HARMONY, branch: 'agent/try-shuffle', base: null }]);
		const made = conv(c.id);
		expect(made.branch).toBe('agent/try-shuffle');
		expect(made.cwd).not.toBe(HARMONY);
		expect(w.sent('claude_open')[0].args).toMatchObject({ id: HARMONY, cwd: made.cwd, resume: false });
	});

	test('a blank branch means the checkout on screen', async () => {
		const c = await claude({ branch: '   ' });
		expect(w.sent('worktree_add')).toEqual([]);
		expect(conv(c.id).cwd).toBe(HARMONY);
	});

	test('a worktree that cannot be made is said and no conversation starts', async () => {
		w.on('worktree_add', () => { throw appError('git', "fatal: 'agent/x' is already checked out"); });
		await ws.newClaude({ branch: 'agent/x' });
		expect(ws.conversations()).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: "fatal: 'agent/x' is already checked out" });
	});

	test('with a worktree on screen it runs in the worktree', async () => {
		const tree = await backend.addWorktree(HARMONY, 'agent/shuffle', null);
		await backend.selectWorktree(HARMONY, tree);
		await repos.switchContext();
		const c = await claude();
		expect(conv(c.id).cwd).toBe(tree);
		expect(w.sent('claude_open')[0].args.cwd).toBe(tree);
	});

	test('a Claude that cannot start is said, on its screen too, and the tab stays', async () => {
		w.on('claude_open', () => { throw appError('error', 'claude was not found on PATH'); });
		await ws.newClaude();
		const id = ws.conversations()[0].id;
		onScreen();
		await tick();
		expect(conv(id).state).toBe('ended');
		expect(paneOf(id).tabs).toEqual([id]);
		expect(xterm.terms[0].text()).toContain('claude was not found on PATH');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'claude was not found on PATH' });
	});

	test('a pane that has left the page starts nothing until it is back', async () => {
		ws.ensureLayout();
		await tick(0);
		const pane = panes()[0].id;
		const el = box();
		ws.attachPane(pane, el);
		ws.detachPane(pane, el);
		await ws.newClaude();
		await tick();
		expect(w.sent('claude_open')).toEqual([]);
		ws.attachPane(pane, box());
		await tick();
		expect(w.sent('claude_open').length).toBe(1);
	});

	test('the old element of a rebuilt pane leaving does not take the new one away', async () => {
		ws.ensureLayout();
		await tick(0);
		const pane = panes()[0].id;
		const old = box();
		const rebuilt = box();
		ws.attachPane(pane, old);
		ws.attachPane(pane, rebuilt);
		ws.detachPane(pane, old);
		await ws.newClaude();
		await tick();
		expect(w.sent('claude_open').length).toBe(1);
		expect(rebuilt.querySelector('.screen')).toBe(xterm.terms[0].host);
	});

	test('a screen moves with its tab to another pane and the program keeps running', async () => {
		const a = await claude();
		const b = await claude();
		ws.place(b.id, paneOf(a.id).id, 'right');
		onScreen();
		await tick();
		expect(boxes.get(paneOf(b.id).id)!.querySelector('.screen')).toBe(b.term.host);
		expect(w.sent('claude_open').length).toBe(2);
		expect(w.sent('term_close')).toEqual([]);
		expect(xterm.terms.length).toBe(2);
		// The pane it left shows the tab that stayed.
		expect(a.term.host!.hidden).toBe(false);
		expect(boxes.get(paneOf(a.id).id)!.contains(a.term.host)).toBe(true);
	});

	test('a conversation behind another tab is started when its tab is first shown', async () => {
		await ws.newClaude();
		await ws.newClaude();
		const [first, second] = ws.conversations();
		onScreen();
		await tick();
		expect(w.sent('claude_open').map((x) => x.args.session)).toEqual([second.sessionId]);
		expect(conv(first.id).state).toBe('starting');
		ws.select(first.id);
		await tick();
		expect(w.sent('claude_open').map((x) => x.args.session)).toEqual([second.sessionId, first.sessionId]);
		expect(conv(first.id).state).toBe('idle');
	});

	test('a conversation closed before its screen was ready starts nothing', async () => {
		await ws.newClaude();
		const id = ws.conversations()[0].id;
		onScreen();
		ws.close(id);
		await tick();
		expect(w.sent('claude_open')).toEqual([]);
		expect(xterm.terms.every((t) => t.disposed)).toBe(true);
	});
});

describe('shells in the workspace', () => {
	test('a shell is the user\'s own, in the checkout on screen, named after the folder', async () => {
		ws.newShell();
		onScreen();
		await tick();
		expect(w.sent('term_open').map((x) => x.args)).toEqual([{ id: HARMONY, cols: 80, rows: 24, at: null }]);
		expect(ws.conversations()).toMatchObject([{ kind: 'shell', repoId: HARMONY, cwd: HARMONY, title: 'harmony', sessionId: null, state: 'idle' }]);
		expect(w.sent('claude_open')).toEqual([]);
	});

	test('further shells are numbered', () => {
		shell();
		shell();
		shell();
		expect(ws.conversations().map((c) => c.title)).toEqual(['harmony', 'harmony 2', 'harmony 3']);
	});

	test('closing a shell ends it and nothing of it is kept', async () => {
		ws.newShell();
		const id = ws.conversations()[0].id;
		onScreen();
		await tick();
		ws.close(id);
		await tick();
		expect(w.sent('term_close').map((x) => x.args)).toEqual([{ key: 'k1' }]);
		expect(ws.conversations()).toEqual([]);
		expect(xterm.terms[0].disposed).toBe(true);
		expect(saved(CONV_KEY)).toEqual([]);
	});

	test('a shell that exits takes its tab along', async () => {
		ws.newShell();
		onScreen();
		await tick();
		w.emit('term-exit', { key: 'k1', code: 0 });
		expect(ws.conversations()).toEqual([]);
		expect(panes()[0].tabs).toEqual([]);
	});

	test('a shell that fails right after starting keeps its tab to say why', async () => {
		ws.newShell();
		const id = ws.conversations()[0].id;
		onScreen();
		await tick();
		w.emit('term-exit', { key: 'k1', code: 126 });
		expect(conv(id).state).toBe('ended');
		expect(paneOf(id).tabs).toEqual([id]);
		expect(xterm.terms[0].text()).toContain('[The shell ended with exit code 126]');
	});

	test('a shell that cannot start is said and its tab stays, ended', async () => {
		w.on('term_open', () => { throw appError('error', 'no pty'); });
		ws.newShell();
		const id = ws.conversations()[0].id;
		onScreen();
		await tick();
		expect(conv(id).state).toBe('ended');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'no pty' });
	});

	test('a shell cannot be resumed', async () => {
		ws.newShell();
		const id = ws.conversations()[0].id;
		onScreen();
		await tick();
		w.emit('term-exit', { key: 'k1', code: 126 });
		ws.resume(id);
		await tick();
		expect(conv(id).state).toBe('ended');
		expect(w.sent('term_open').length).toBe(1);
	});
});

describe('what Claude Code\'s hooks say', () => {
	test('a prompt means Claude is working, and the first one becomes the title', async () => {
		const c = await claude();
		hook(c.key, 'UserPromptSubmit', { text: '  Make the queue shuffle when repeat is on  ' });
		expect(conv(c.id)).toMatchObject({ state: 'working', title: 'Make the queue shuffle when repeat is on', titled: true, prompt: 'Make the queue shuffle when repeat is on', lastSaid: 'Make the queue shuffle when repeat is on' });
		expect(ws.working()).toBe(1);
	});

	test('a long first prompt is cut short for the tab and kept longer beside it', async () => {
		const c = await claude();
		const text = 'Please look at how the upload test is written, because it fails about one run in ten on CI and I would like to know why before the release goes out';
		hook(c.key, 'UserPromptSubmit', { text });
		const made = conv(c.id);
		expect(made.title.length).toBeLessThanOrEqual(48);
		expect(made.title.endsWith('…')).toBe(true);
		expect(text.startsWith(made.title.slice(0, -1))).toBe(true);
		expect(made.prompt).toBe(text);
	});

	test('later prompts leave the title alone', async () => {
		const c = await claude();
		hook(c.key, 'UserPromptSubmit', { text: 'First things first' });
		hook(c.key, 'Stop', { text: 'Done.' });
		hook(c.key, 'UserPromptSubmit', { text: 'Now something else' });
		expect(conv(c.id)).toMatchObject({ title: 'First things first', prompt: 'First things first', lastSaid: 'Now something else', state: 'working' });
	});

	test('a notice Claude Code submits itself is not the user\'s words', async () => {
		const c = await claude();
		hook(c.key, 'UserPromptSubmit', { text: '<task-notification>background task finished</task-notification>' });
		expect(conv(c.id)).toMatchObject({ state: 'working', title: 'New conversation', titled: false, lastSaid: '' });
		hook(c.key, 'UserPromptSubmit', { text: null });
		expect(conv(c.id).titled).toBe(false);
	});

	test('the end of a turn is the prompt again, with Claude\'s last answer', async () => {
		const c = await claude();
		hook(c.key, 'UserPromptSubmit', { text: 'Fix it' });
		hook(c.key, 'Stop', { text: 'Fixed: the test waited on a **timer**.' });
		expect(conv(c.id)).toMatchObject({ state: 'idle', waitingFor: null, lastSaid: 'Fixed: the test waited on a timer.' });
		expect(ws.working()).toBe(0);
	});

	test('a subagent starting is listed as running, and Claude is working', async () => {
		const c = await claude();
		hook(c.key, 'PreToolUse', { toolUseId: 'toolu_1', description: 'Look around the code', subagentType: 'Explore' });
		expect(conv(c.id).state).toBe('working');
		expect(conv(c.id).subagents).toMatchObject([{ id: 'toolu_1', description: 'Look around the code', type: 'Explore', running: true, ended: null }]);
	});

	test('a subagent finishing is marked ended, and only that one', async () => {
		const c = await claude();
		hook(c.key, 'PreToolUse', { toolUseId: 'toolu_1', description: 'One' });
		hook(c.key, 'PreToolUse', { toolUseId: 'toolu_2', description: 'Two' });
		await tick(1500);
		hook(c.key, 'PostToolUse', { toolUseId: 'toolu_1' });
		const [one, two] = conv(c.id).subagents;
		expect(one.running).toBe(false);
		expect(one.ended! - one.started).toBeGreaterThanOrEqual(1500);
		expect(two).toMatchObject({ running: true, ended: null });
		expect(conv(c.id).state).toBe('working');
	});

	test('the same subagent reported twice is listed once, and one with no description still has a name', async () => {
		const c = await claude();
		hook(c.key, 'PreToolUse', { toolUseId: 'toolu_1' });
		hook(c.key, 'PreToolUse', { toolUseId: 'toolu_1' });
		expect(conv(c.id).subagents).toMatchObject([{ id: 'toolu_1', description: 'Subagent', type: null }]);
	});

	test('only the latest subagents are kept', async () => {
		const c = await claude();
		for (let i = 1; i <= 35; i++) {
			hook(c.key, 'PreToolUse', { toolUseId: `toolu_${i}` });
		}
		const kept = conv(c.id).subagents.map((s) => s.id);
		expect(kept.length).toBe(30);
		expect(kept[0]).toBe('toolu_6');
		expect(kept.at(-1)).toBe('toolu_35');
	});

	test('a notification means Claude is waiting for the user, and says for what', async () => {
		const c = await claude();
		hook(c.key, 'UserPromptSubmit', { text: 'Edit the README' });
		hook(c.key, 'Notification', { kind: 'permission_prompt', text: 'Claude needs your permission to use Edit' });
		expect(conv(c.id)).toMatchObject({ state: 'waiting', waitingFor: 'Claude needs your permission to use Edit' });
		expect(ws.waiting().map((x) => x.id)).toEqual([c.id]);
		expect(ws.working()).toBe(0);
	});

	test('a notification with no text still says Claude is waiting', async () => {
		const c = await claude();
		hook(c.key, 'Notification', { kind: 'elicitation_dialog' });
		expect(conv(c.id)).toMatchObject({ state: 'waiting', waitingFor: 'Claude is waiting for you' });
	});

	test('the idle reminder after a minute at the prompt is not news', async () => {
		const c = await titled();
		vi.spyOn(document, 'hasFocus').mockReturnValue(false);
		const toasts = w.toasts.length;
		hook(c.key, 'Notification', { kind: 'idle_prompt', text: 'Claude is waiting for your input' });
		expect(conv(c.id)).toMatchObject({ state: 'idle', waitingFor: null, unread: false });
		expect(ws.waiting()).toEqual([]);
		expect(w.toasts.length).toBe(toasts);
	});

	test('typing while Claude waits means it is on its way again', async () => {
		const c = await claude();
		hook(c.key, 'Notification', { kind: 'permission_prompt', text: 'Claude needs your permission to use Bash' });
		c.term.input('1');
		expect(conv(c.id)).toMatchObject({ state: 'working', waitingFor: null });
	});

	test('typing at the prompt does not make Claude working', async () => {
		const c = await claude();
		c.term.input('h');
		expect(conv(c.id).state).toBe('idle');
	});

	test('the end of a turn clears what Claude was waiting for', async () => {
		const c = await claude();
		hook(c.key, 'Notification', { kind: 'permission_prompt', text: 'Claude needs your permission to use Bash' });
		hook(c.key, 'Stop', { text: 'Left it alone.' });
		expect(conv(c.id)).toMatchObject({ state: 'idle', waitingFor: null });
		expect(ws.waiting()).toEqual([]);
	});

	test('a hook reports on its own conversation only', async () => {
		const a = await claude();
		const b = await claude();
		hook(a.key, 'UserPromptSubmit', { text: 'For the first' });
		expect(conv(a.id).state).toBe('working');
		expect(conv(b.id)).toMatchObject({ state: 'idle', title: 'New conversation' });
	});

	test('a session id that changed (after /clear) is the one to resume', async () => {
		const c = await claude();
		hook(c.key, 'UserPromptSubmit', { text: 'Hello', sessionId: 'after-clear' });
		expect(conv(c.id).sessionId).toBe('after-clear');
		expect(saved<Conversation[]>(CONV_KEY)).toMatchObject([{ id: c.id, sessionId: 'after-clear' }]);
		// Further hooks still find the conversation by its terminal.
		hook(c.key, 'Stop', { text: 'Hi.', sessionId: 'after-clear' });
		expect(conv(c.id).state).toBe('idle');
	});

	test('a cleared session starts with no subagents', async () => {
		const c = await claude();
		hook(c.key, 'PreToolUse', { toolUseId: 'toolu_1' });
		hook(c.key, 'SessionStart', { kind: 'clear', sessionId: 'after-clear' });
		expect(conv(c.id).subagents).toEqual([]);
	});

	test('a hook that beats the answer to the open call is applied once the key is known', async () => {
		w.on('claude_open', () => {
			hook('early', 'UserPromptSubmit', { text: 'Typed at once' });
			return 'early';
		});
		await ws.newClaude();
		const id = ws.conversations()[0].id;
		onScreen();
		await tick();
		expect(conv(id).titled).toBe(false);
		await tick(200);
		expect(conv(id)).toMatchObject({ state: 'working', title: 'Typed at once' });
	});

	test('a hook for a terminal nobody has is given up on after a moment', async () => {
		ws.ensureLayout();
		hook('late', 'Notification', { kind: 'permission_prompt', text: 'Ghost' });
		await tick(1100);
		// A conversation that gets that key afterwards is not told what was meant for nobody.
		w.on('claude_open', () => 'late');
		await ws.newClaude();
		const id = ws.conversations()[0].id;
		onScreen();
		await tick(2000);
		expect(conv(id)).toMatchObject({ state: 'idle', waitingFor: null });
		expect(w.toasts).toEqual([]);
	});

	test('hooks for a conversation that was closed change nothing', async () => {
		const c = await titled();
		ws.close(c.id);
		hook(c.key, 'UserPromptSubmit', { text: 'Too late' });
		await tick(2000);
		expect(conv(c.id)).toMatchObject({ state: 'saved', lastSaid: 'Done.' });
	});
});

describe('seen and unseen', () => {
	test('what happens in a conversation on screen is not marked unread and not announced', async () => {
		const c = await claude();
		hook(c.key, 'UserPromptSubmit', { text: 'Go' });
		hook(c.key, 'Notification', { kind: 'permission_prompt', text: 'Claude needs your permission to use Bash' });
		hook(c.key, 'Stop', { text: 'Done.' });
		expect(ws.isVisible(c.id)).toBe(true);
		expect(conv(c.id).unread).toBe(false);
		expect(ws.unread()).toBe(0);
		expect(w.toasts).toEqual([]);
	});

	test('Claude asking while the window is not in front is marked unread and announced', async () => {
		const c = await titled('Edit the README');
		vi.spyOn(document, 'hasFocus').mockReturnValue(false);
		hook(c.key, 'Notification', { kind: 'permission_prompt', text: 'Claude needs your permission to use Edit' });
		expect(ws.isVisible(c.id)).toBe(false);
		expect(conv(c.id).unread).toBe(true);
		expect(ws.unread()).toBe(1);
		expect(w.toasts).toEqual([{ kind: 'warning', title: 'Claude needs you', message: 'Edit the README: Claude needs your permission to use Edit' }]);
	});

	test('a minimised window sees nothing either', async () => {
		const c = await titled('Edit the README');
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		hook(c.key, 'Notification', { kind: 'permission_prompt', text: 'Claude needs your permission to use Edit' });
		expect(conv(c.id).unread).toBe(true);
		expect(w.toasts.length).toBe(1);
	});

	test('a turn ending while the workspace is hidden is marked unread and announced', async () => {
		const c = await titled('Fix the test');
		ws.setView('hidden');
		hook(c.key, 'UserPromptSubmit', { text: 'And the other one' });
		expect(w.toasts).toEqual([]);
		hook(c.key, 'Stop', { text: 'Both pass now.' });
		expect(conv(c.id).unread).toBe(true);
		expect(w.toasts).toEqual([{ kind: 'success', title: 'Claude finished', message: 'Fix the test: Both pass now.' }]);
	});

	test('a turn ending in a tab behind another is unread until the tab is selected', async () => {
		const a = await titled();
		const b = await claude();
		expect(paneOf(a.id).active).toBe(b.id);
		hook(a.key, 'UserPromptSubmit', { text: 'More' });
		hook(a.key, 'Stop', { text: 'More done.' });
		expect(conv(a.id).unread).toBe(true);
		expect(conv(b.id).unread).toBe(false);
		ws.select(a.id);
		expect(conv(a.id).unread).toBe(false);
		expect(ws.unread()).toBe(0);
	});

	test('a stop for a conversation already at the prompt is not announced again', async () => {
		const c = await titled();
		ws.setView('hidden');
		hook(c.key, 'Stop', { text: 'Done.' });
		expect(conv(c.id).unread).toBe(false);
		expect(w.toasts).toEqual([]);
	});

	test('a conversation of another repository is announced with the repository\'s name', async () => {
		const c = await titled('Fix the test');
		await repos.selectRepo(CADENCE);
		hook(c.key, 'UserPromptSubmit', { text: 'Again' });
		hook(c.key, 'Stop', { text: 'Passing.' });
		expect(conv(c.id).unread).toBe(true);
		expect(w.toasts).toEqual([{ kind: 'success', title: 'Claude finished · harmony', message: 'Fix the test: Passing.' }]);
	});

	test('showing the workspace marks what is on screen as seen', async () => {
		const c = await titled();
		ws.setView('hidden');
		hook(c.key, 'UserPromptSubmit', { text: 'More' });
		hook(c.key, 'Stop', { text: 'More done.' });
		expect(ws.unread()).toBe(1);
		ws.toggle();
		expect(ws.unread()).toBe(0);
	});

	test('the window growing wide enough for the workspace marks what is on screen as seen', async () => {
		const c = await titled();
		ws.setRoom(900, 1100);
		hook(c.key, 'UserPromptSubmit', { text: 'More' });
		hook(c.key, 'Stop', { text: 'More done.' });
		expect(conv(c.id).unread).toBe(true);
		ws.setRoom(1600, 1800);
		expect(conv(c.id).unread).toBe(false);
	});

	test('a tab behind another stays unread when the workspace is shown', async () => {
		const a = await titled();
		await claude();
		ws.setView('hidden');
		hook(a.key, 'UserPromptSubmit', { text: 'More' });
		hook(a.key, 'Stop', { text: 'More done.' });
		ws.setView('side');
		expect(conv(a.id).unread).toBe(true);
	});

	test('opening a conversation from elsewhere goes to its repository, shows the workspace and marks it seen', async () => {
		const c = await titled();
		ws.setView('hidden');
		await repos.selectRepo(CADENCE);
		hook(c.key, 'Notification', { kind: 'permission_prompt', text: 'Claude needs your permission to use Bash' });
		expect(conv(c.id).unread).toBe(true);
		await ws.open(c.id);
		expect(repos.repo()!.id).toBe(HARMONY);
		expect(ws.shown()).toBe('side');
		expect(conv(c.id).unread).toBe(false);
		expect(paneOf(c.id).active).toBe(c.id);
		// Still Claude's question to answer: only looking at it does not settle it.
		expect(conv(c.id).state).toBe('waiting');
	});

	test('opening a conversation that is not there does nothing', async () => {
		await ws.open('no-such-conversation');
		expect(w.sent('repo_select')).toEqual([]);
		expect(ws.layouts()).toEqual({});
	});
});

describe('saved conversations', () => {
	test('a conversation nobody typed into is not saved', async () => {
		await claude();
		expect(saved(CONV_KEY)).toEqual([]);
	});

	test('once it has a prompt it is saved with what resumes it', async () => {
		const c = await titled('Make the queue shuffle');
		expect(saved<Conversation[]>(CONV_KEY)).toMatchObject([{ id: c.id, kind: 'claude', repoId: HARMONY, cwd: HARMONY, title: 'Make the queue shuffle', sessionId: conv(c.id).sessionId, lastSaid: 'Done.' }]);
	});

	test('closing its tab ends Claude Code and keeps the conversation, saved', async () => {
		const c = await titled();
		hook(c.key, 'PreToolUse', { toolUseId: 'toolu_1' });
		hook(c.key, 'Notification', { kind: 'permission_prompt', text: 'Claude needs your permission to use Bash' });
		ws.close(c.id);
		await tick();
		expect(w.sent('term_close').map((x) => x.args)).toEqual([{ key: c.key }]);
		expect(conv(c.id)).toMatchObject({ state: 'saved', waitingFor: null, subagents: [{ id: 'toolu_1', running: false }] });
		expect(panes().flatMap((p) => p.tabs)).toEqual([]);
		expect(saved<Conversation[]>(CONV_KEY).map((x) => x.id)).toEqual([c.id]);
		expect(ws.waiting()).toEqual([]);
	});

	test('closing a conversation nobody typed into drops it', async () => {
		const c = await claude();
		ws.close(c.id);
		expect(ws.conversations()).toEqual([]);
	});

	test('forgetting a conversation drops it from the list and from what is saved', async () => {
		const c = await titled();
		ws.close(c.id, true);
		expect(ws.conversations()).toEqual([]);
		expect(saved(CONV_KEY)).toEqual([]);
		expect(panes().flatMap((p) => p.tabs)).toEqual([]);
	});

	test('leaving Claude Code closes the tab, and a conversation with a title stays saved', async () => {
		const c = await titled();
		w.emit('term-exit', { key: c.key, code: 0 });
		expect(conv(c.id).state).toBe('saved');
		expect(panes().flatMap((p) => p.tabs)).toEqual([]);
		const untyped = await claude();
		w.emit('term-exit', { key: untyped.key, code: 0 });
		expect(ws.get(untyped.id)).toBeNull();
	});

	test('a Claude Code that fails right after starting keeps its tab to say why', async () => {
		const c = await claude();
		hook(c.key, 'PreToolUse', { toolUseId: 'toolu_1' });
		hook(c.key, 'Notification', { kind: 'permission_prompt', text: 'x' });
		w.emit('term-exit', { key: c.key, code: 1 });
		expect(conv(c.id)).toMatchObject({ state: 'ended', waitingFor: null, subagents: [{ running: false }] });
		expect(conv(c.id).subagents[0].ended).not.toBeNull();
		expect(paneOf(c.id).tabs).toEqual([c.id]);
		expect(c.term.text()).toContain('[Claude Code ended with exit code 1]');
	});

	test('a Claude Code that ran a while and ends with an error closes like any other', async () => {
		const c = await titled();
		await tick(3001);
		w.emit('term-exit', { key: c.key, code: 1 });
		expect(conv(c.id).state).toBe('saved');
		expect(panes().flatMap((p) => p.tabs)).toEqual([]);
	});

	test('after a restart conversations come back saved, and nothing starts by itself', async () => {
		const c = await titled('Make the queue shuffle');
		const session = conv(c.id).sessionId;
		hook(c.key, 'PreToolUse', { toolUseId: 'toolu_1' });
		hook(c.key, 'UserPromptSubmit', { text: 'And then?' });
		await restart();
		expect(ws.conversations()).toMatchObject([{ id: c.id, state: 'saved', title: 'Make the queue shuffle', sessionId: session, waitingFor: null, unread: false, subagents: [{ id: 'toolu_1', running: false }] }]);
		ws.ensureLayout();
		await tick(0);
		onScreen();
		ws.showAll();
		ws.select(c.id);
		await ws.open(c.id);
		ws.setView('full');
		await tick(1000);
		expect(w.sent('claude_open')).toEqual([]);
		expect(xterm.terms).toEqual([]);
		expect(conv(c.id).state).toBe('saved');
	});

	test('resume continues the saved session, and only then', async () => {
		const c = await titled();
		const session = conv(c.id).sessionId;
		await restart();
		ws.ensureLayout();
		await tick(0);
		onScreen();
		ws.resume(c.id);
		expect(conv(c.id).state).toBe('starting');
		await tick();
		expect(w.sent('claude_open').map((x) => x.args)).toEqual([{ id: HARMONY, cwd: HARMONY, session, resume: true, cols: 80, rows: 24 }]);
		expect(conv(c.id).state).toBe('idle');
		// Its hooks are heard again.
		hook(keys.get(session!)!, 'UserPromptSubmit', { text: 'Carry on' });
		expect(conv(c.id)).toMatchObject({ state: 'working', title: 'Make the queue shuffle' });
	});

	test('a conversation whose tab was closed is resumed in a tab again', async () => {
		const c = await titled();
		const session = conv(c.id).sessionId;
		ws.close(c.id);
		ws.resume(c.id);
		await tick();
		onScreen();
		await tick();
		expect(paneOf(c.id).active).toBe(c.id);
		expect(w.sent('claude_open').map((x) => x.args.resume)).toEqual([false, true]);
		expect(w.sent('claude_open')[1].args.session).toBe(session);
		expect(conv(c.id).state).toBe('idle');
	});

	test('a conversation that ended can be started again on the same screen', async () => {
		const c = await titled();
		w.emit('term-exit', { key: c.key, code: 1 });
		expect(conv(c.id).state).toBe('ended');
		ws.resume(c.id);
		await tick();
		expect(w.sent('claude_open').map((x) => x.args.resume)).toEqual([false, true]);
		expect(conv(c.id).state).toBe('idle');
		expect(xterm.terms.length).toBe(1);
		expect(c.term.text()).toContain('[Claude Code ended with exit code 1]');
	});

	test('resuming a conversation that is running does nothing', async () => {
		const c = await titled();
		ws.resume(c.id);
		ws.resume('no-such-conversation');
		await tick();
		expect(w.sent('claude_open').length).toBe(1);
		expect(conv(c.id).state).toBe('idle');
	});

	test('a resume that fails goes back to saved, to be tried again', async () => {
		const c = await titled();
		ws.close(c.id);
		w.on('claude_open', () => { throw appError('error', 'No conversation found with that session id'); });
		ws.resume(c.id);
		await tick();
		onScreen();
		await tick();
		expect(conv(c.id).state).toBe('saved');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'No conversation found with that session id' });
		w.on('claude_open', () => 'second-try');
		ws.resume(c.id);
		await tick();
		expect(conv(c.id).state).toBe('idle');
		hook('second-try', 'UserPromptSubmit', { text: 'Carry on' });
		expect(conv(c.id).state).toBe('working');
	});

	test('a conversation in another repository is resumed there', async () => {
		const c = await titled();
		ws.close(c.id);
		await repos.selectRepo(CADENCE);
		ws.resume(c.id);
		await tick();
		expect(repos.repo()!.id).toBe(HARMONY);
		expect(paneOf(c.id).active).toBe(c.id);
	});

	test('saved entries that could not be resumed are not loaded', async () => {
		const good = { id: 'c-good', kind: 'claude', repoId: HARMONY, cwd: HARMONY, branch: 'main', title: 'Kept', titled: true, sessionId: 'sess-good', state: 'working', waitingFor: 'x', lastSaid: '', subagents: [], created: 1, updated: 1, unread: true };
		const entries = [good, { ...good, id: 'c-shell', kind: 'shell', sessionId: null }, { ...good, id: 'c-no-session', sessionId: null }, null];
		await start({ [CONV_KEY]: JSON.stringify(entries) });
		expect(ws.conversations()).toMatchObject([{ id: 'c-good', state: 'saved', waitingFor: null, unread: false }]);
	});

	test('a saved entry from before subagents were kept is loaded all the same', async () => {
		const old = { id: 'c-old', kind: 'claude', repoId: HARMONY, cwd: HARMONY, branch: 'main', title: 'Old', titled: true, sessionId: 'sess-old', state: 'idle', waitingFor: null, lastSaid: '', created: 1, updated: 1, unread: false };
		await start({ [CONV_KEY]: JSON.stringify([old]) });
		expect(ws.conversations()).toMatchObject([{ id: 'c-old', state: 'saved', subagents: [] }]);
	});

	test('saved conversations that are not JSON are ignored', async () => {
		await start({ [CONV_KEY]: '{not json' });
		expect(ws.conversations()).toEqual([]);
		const c = await titled();
		expect(saved<Conversation[]>(CONV_KEY).map((x) => x.id)).toEqual([c.id]);
	});

	// A bug until 2026-11-23, low severity (src/services/workspace.store.ts): as with the layouts above, what is under
	// the key is taken as a list when it parses. The app never writes anything else, so this needs damaged storage.
	// What holds now: ignored, no conversations.
	// Before the fix: the store cannot be made at all (`null.filter` in a field initialiser), so everything that asks for
	// the WorkspaceStore throws.
	test('saved conversations that are JSON but not a list are ignored', async () => {
		let failure: unknown = null;
		await start({ [CONV_KEY]: 'null' }).catch((e: unknown) => (failure = e));
		expect(failure).toBeNull();
		expect(ws.conversations()).toEqual([]);
	});

	test('only the most recent conversations are kept in storage', async () => {
		for (let i = 0; i < 62; i++) {
			await adopted({ id: `sess-${i}`, modified: 1_700_000_000_000 + i * 1000 });
		}
		const kept = saved<Conversation[]>(CONV_KEY);
		expect(kept.length).toBe(60);
		expect(kept[0].sessionId).toBe('sess-61');
		expect(kept.some((c) => c.sessionId === 'sess-0' || c.sessionId === 'sess-1')).toBe(false);
	});
});

describe('sessions started outside the app', () => {
	test('a repository\'s outside sessions are read from the native side', async () => {
		const found = [outside({ id: 'sess-1' }), outside({ id: 'sess-2', title: null })];
		w.on('claude_sessions', () => found);
		await ws.loadElsewhere(HARMONY);
		expect(w.sent('claude_sessions').map((x) => x.args)).toEqual([{ id: HARMONY }]);
		expect(ws.elsewhere()[HARMONY]).toEqual(found);
		expect(ws.elsewhereIn(HARMONY)).toEqual(found);
		expect(ws.elsewhereIn(CADENCE)).toEqual([]);
	});

	test('a read that fails shows none and says nothing', async () => {
		w.on('claude_sessions', () => [outside()]);
		await ws.loadElsewhere(HARMONY);
		w.on('claude_sessions', () => { throw appError('error', 'no such repository'); });
		await ws.loadElsewhere(HARMONY);
		expect(ws.elsewhereIn(HARMONY)).toEqual([]);
		expect(w.toasts).toEqual([]);
	});

	test('adopting one makes a saved conversation in a tab, and runs nothing', async () => {
		const s = outside();
		await ws.adopt(HARMONY, s);
		onScreen();
		await tick(1000);
		const made = ws.conversations()[0];
		expect(made).toMatchObject({ kind: 'claude', repoId: HARMONY, cwd: s.cwd, branch: 'main', title: 'Flaky upload test', titled: true, prompt: s.prompt, outside: true, sessionId: 'sess-1', state: 'saved', lastSaid: s.lastSaid, created: s.modified, updated: s.modified, unread: false });
		expect(paneOf(made.id).active).toBe(made.id);
		expect(w.sent('claude_open')).toEqual([]);
		expect(xterm.terms).toEqual([]);
	});

	test('one with no title of its own is named after its first prompt', async () => {
		const made = await adopted({ title: null, lastSaid: null });
		expect(made.title.length).toBeLessThanOrEqual(48);
		expect(made.title.startsWith('The upload test fails')).toBe(true);
		expect(made.lastSaid).toBe('');
	});

	test('an adopted session is one of ours and no longer listed as outside', async () => {
		w.on('claude_sessions', () => [outside({ id: 'sess-1' }), outside({ id: 'sess-2' })]);
		await ws.loadElsewhere(HARMONY);
		await adopted({ id: 'sess-1' });
		expect(ws.elsewhereIn(HARMONY).map((s) => s.id)).toEqual(['sess-2']);
	});

	test('adopting the same session again opens the conversation it already is', async () => {
		const first = await adopted();
		const other = shell();
		expect(paneOf(first.id).active).toBe(other);
		await ws.adopt(HARMONY, outside());
		expect(ws.conversations().filter((c) => c.kind === 'claude').length).toBe(1);
		expect(paneOf(first.id).active).toBe(first.id);
	});

	test('only the Resume click runs claude --resume, in the session\'s own folder', async () => {
		const tree = `${HARMONY}.worktrees/agent-shuffle`;
		const made = await adopted({ cwd: tree, branch: 'agent/shuffle' });
		onScreen();
		await tick(1000);
		expect(w.sent('claude_open')).toEqual([]);
		ws.resume(made.id);
		await tick();
		expect(w.sent('claude_open').map((x) => x.args)).toEqual([{ id: HARMONY, cwd: tree, session: 'sess-1', resume: true, cols: 80, rows: 24 }]);
		// Resumed here, it is no longer one that may still be open in a terminal.
		expect(conv(made.id)).toMatchObject({ outside: false, state: 'idle' });
	});

	test('a session of another repository is adopted there', async () => {
		const made = await adopted({ cwd: CADENCE }, CADENCE);
		expect(w.sent('repo_select').map((x) => x.args)).toEqual([{ id: CADENCE }]);
		expect(repos.repo()!.id).toBe(CADENCE);
		expect(made.repoId).toBe(CADENCE);
		expect(paneOf(made.id).active).toBe(made.id);
		expect(ws.layouts()[HARMONY]).toBeUndefined();
	});

	test('an adopted session is kept over a restart, still marked as started outside', async () => {
		const made = await adopted();
		await restart();
		expect(ws.conversations()).toMatchObject([{ id: made.id, outside: true, state: 'saved', sessionId: 'sess-1' }]);
		expect(w.sent('claude_open')).toEqual([]);
	});

	test('adopting into another repository leaves this repository\'s view as it was', async () => {
		ws.setView('hidden');
		await adopted({ cwd: CADENCE }, CADENCE);
		expect(ws.shown()).toBe('side');
		expect(saved(VIEWS_KEY)).toEqual({ [HARMONY]: 'hidden' });
	});

	test('adopting shows a hidden workspace', async () => {
		ws.setView('hidden');
		await adopted();
		expect(ws.shown()).toBe('side');
	});
});
