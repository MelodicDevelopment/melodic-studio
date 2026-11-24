/**
 * The Claude workspace: interactive Claude Code conversations and plain shells,
 * arranged in split panes with tabs, one layout per repository.
 *
 * A conversation is the user's own `claude` CLI on a pty (ScreenPool draws it),
 * so everything Claude Code does works as in any terminal. What a terminal
 * cannot tell us (working, waiting for the user, finished, which subagents are
 * running) comes from Claude Code's hooks as `claude-hook` events
 * (src-tauri/src/conversation.rs).
 *
 * Conversations are saved (not shells): after a restart they come back as
 * "saved" and continue with `claude --resume <session id>` when asked.
 *
 * The layout is a tree: a split holds panes or further splits side by side
 * (`row`) or stacked (`column`), with a share of the space each; a pane holds
 * tabs, each one a conversation or shell id.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { computed, signal } from '@melodicdev/core/signals';
import { ToastService } from '@melodicdev/components/toast';
import { BackendService, type ClaudeHook, type ClaudeSession } from './backend.service';
import { RepoStore } from './repo.store';
import { ScreenPool } from './screens';
import { FAILED_START_MS, folderName } from './terminal.store';
import { plainSummary } from './agents.store';
import { MIN_SIDE_W, sideFits, sideWidth } from '../shared/pane-room';

export type ConvKind = 'claude' | 'shell';
/**
 * starting: the program is on its way. working: Claude is on a turn. waiting: Claude asked for permission or input.
 * idle: at the prompt. ended: the program ended (the screen stays). saved: not running; a conversation can resume.
 */
export type ConvState = 'starting' | 'working' | 'waiting' | 'idle' | 'ended' | 'saved';

export interface Subagent {
	/** The tool call that started it. */
	id: string;
	description: string;
	type: string | null;
	running: boolean;
	started: number;
	ended: number | null;
}

export interface Conversation {
	id: string;
	kind: ConvKind;
	repoId: string;
	/** The checkout it runs in. */
	cwd: string;
	branch: string | null;
	title: string;
	/** The title came from the first prompt (or the user); later prompts leave it alone. */
	titled: boolean;
	/** The first prompt, longer than the title (which tabs have to keep short). */
	prompt?: string;
	/** Started outside the app (a terminal) and not resumed here yet: it may still be open there. */
	outside?: boolean;
	/** Claude Code's session id: what `--resume` continues. Changes on /clear. */
	sessionId: string | null;
	state: ConvState;
	/** What Claude is waiting for, while `waiting`. */
	waitingFor: string | null;
	/** Claude's last answer, or the last prompt while working. */
	lastSaid: string;
	subagents: Subagent[];
	created: number;
	updated: number;
	/** Something happened while it was not on screen. */
	unread: boolean;
}

export type Pane = { type: 'pane'; id: string; tabs: string[]; active: string | null };
export type Split = { type: 'split'; id: string; dir: 'row' | 'column'; children: LayoutNode[]; sizes: number[] };
export type LayoutNode = Pane | Split;
/** Where a dragged tab lands on a pane: in it, or in a new pane on one side. */
export type Drop = 'center' | 'left' | 'right' | 'top' | 'bottom';

/** hidden: only the main pane. side: main pane and workspace side by side. full: the workspace alone. */
export type WorkspaceView = 'hidden' | 'side' | 'full';

const CONV_KEY = 'studio.conversations';
const LAYOUT_KEY = 'studio.workspace.layouts';
/** The one view every repository shared before each got its own; still what a repository starts with. */
const VIEW_KEY = 'studio.workspace.view';
const VIEWS_KEY = 'studio.workspace.views';
const WIDTH_KEY = 'studio.workspace.width';
const MAX_SUBAGENTS = 30;
const MAX_SAVED = 60;

function read<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

function write(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* blocked storage */
	}
}

let seq = 0;
function newId(prefix: string): string {
	return `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;
}

function emptyPane(): Pane {
	return { type: 'pane', id: newId('p'), tabs: [], active: null };
}

/** The pane in the top right corner: the one that carries the workspace's own buttons (fill the window, hide). */
export function cornerPane(node: LayoutNode): Pane {
	while (node.type === 'split') {
		node = node.dir === 'row' ? node.children[node.children.length - 1] : node.children[0];
	}
	return node;
}

/** Every pane in a layout, in reading order. */
export function panesOf(node: LayoutNode): Pane[] {
	return node.type === 'pane' ? [node] : node.children.flatMap(panesOf);
}

function mapNode(node: LayoutNode, fn: (n: LayoutNode) => LayoutNode | null): LayoutNode | null {
	const mapped = fn(node);
	if (!mapped || mapped.type === 'pane') {
		return mapped;
	}
	const kept: { child: LayoutNode; size: number }[] = [];
	mapped.children.forEach((child, i) => {
		const c = mapNode(child, fn);
		if (c) {
			kept.push({ child: c, size: mapped.sizes[i] ?? 1 });
		}
	});
	if (!kept.length) {
		return null;
	}
	if (kept.length === 1) {
		return kept[0].child;
	}
	const total = kept.reduce((sum, k) => sum + k.size, 0) || 1;
	return { ...mapped, children: kept.map((k) => k.child), sizes: kept.map((k) => k.size / total) };
}

/** Parse what was saved, dropping tabs that no longer exist. */
function restoreLayout(node: LayoutNode | undefined, known: Set<string>): LayoutNode {
	if (!node) {
		return emptyPane();
	}
	const fixed = mapNode(node, (n) => {
		if (n.type === 'pane') {
			const tabs = n.tabs.filter((t) => known.has(t));
			return { ...n, tabs, active: tabs.includes(n.active ?? '') ? n.active : (tabs[0] ?? null) };
		}
		return n;
	});
	return fixed ?? emptyPane();
}

function asView(value: unknown): WorkspaceView | null {
	return value === 'hidden' || value === 'side' || value === 'full' ? value : null;
}

/** A width the user dragged the workspace to, if they ever did. */
function savedWidth(): number | null {
	const w = Number(read<unknown>(WIDTH_KEY, null));
	return Number.isFinite(w) && w > 0 ? Math.max(MIN_SIDE_W, Math.round(w)) : null;
}

function savedViews(): Record<string, WorkspaceView> {
	const out: Record<string, WorkspaceView> = {};
	for (const [repoId, value] of Object.entries(read<Record<string, unknown>>(VIEWS_KEY, {}) ?? {})) {
		const view = asView(value);
		if (view) {
			out[repoId] = view;
		}
	}
	return out;
}

/** The layouts as saved, by repository. Anything under the key that is not such a record counts as nothing saved. */
function savedLayouts(): Record<string, LayoutNode> {
	const saved = read<unknown>(LAYOUT_KEY, {});
	return saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, LayoutNode>) : {};
}

function loadConversations(): Conversation[] {
	const saved = read<unknown>(CONV_KEY, []);
	return (Array.isArray(saved) ? (saved as Conversation[]) : [])
		.filter((c) => c && c.kind === 'claude' && c.sessionId)
		.map((c) => ({ ...c, state: 'saved' as ConvState, waitingFor: null, unread: false, subagents: (c.subagents ?? []).map((s) => ({ ...s, running: false })) }));
}

@Injectable()
export class WorkspaceStore {
	readonly conversations = signal<Conversation[]>(loadConversations());
	readonly layouts = signal<Record<string, LayoutNode>>({});
	private readonly _views = signal<Record<string, WorkspaceView>>(savedViews());
	private readonly _firstView = asView(read<unknown>(VIEW_KEY, 'side')) ?? 'side';
	/** The open repository's view: each repository tab keeps its own. */
	readonly view = computed<WorkspaceView>(() => this._views()[this.repos.repo()?.id ?? ''] ?? this._firstView);
	/** The width the user dragged the pane to; null until they do (a third of the window). */
	private readonly _dragged = signal<number | null>(savedWidth());
	/** The width the main pane and this one share, and the window's, as the app shell last measured them. */
	private readonly _room = signal<{ room: number; window: number } | null>(null);
	/** Whether the window is wide enough for the workspace beside the main pane (see shared/pane-room.ts). */
	readonly fits = computed(() => {
		const r = this._room();
		return !r || sideFits(r.room, this._dragged());
	});
	/** What is on screen: `side` gives way to the main pane while the window is too narrow for both. */
	readonly shown = computed<WorkspaceView>(() => (this.view() === 'side' && !this.fits() ? 'hidden' : this.view()));
	/** The workspace's width beside the main pane, which always keeps its floor. */
	readonly width = computed(() => {
		const r = this._room();
		return r ? sideWidth(this._dragged(), r.room, r.window) : (this._dragged() ?? MIN_SIDE_W);
	});
	/** The pane new tabs go to and keys act on. */
	readonly focusedPane = signal<string | null>(null);
	/** A tab being dragged, and where it would land. */
	readonly dragging = signal<{ tab: string; pane: string | null; drop: Drop | null } | null>(null);

	/** The open repository's layout. */
	readonly layout = computed<LayoutNode | null>(() => {
		const repo = this.repos.repo();
		return repo ? (this.layouts()[repo.id] ?? null) : null;
	});
	/** Conversations that need the user: asking for permission or input. */
	readonly waiting = computed(() => this.conversations().filter((c) => c.state === 'waiting'));
	readonly unread = computed(() => this.conversations().filter((c) => c.unread).length);
	readonly working = computed(() => this.conversations().filter((c) => c.state === 'working').length);

	/** Claude Code sessions started outside the app, by repository (read from Claude Code's transcripts). */
	readonly elsewhere = signal<Record<string, ClaudeSession[]>>({});

	private readonly _savedLayouts = savedLayouts();
	/** Conversation id -> screen id in the pool. */
	private readonly _screens = new Map<string, string>();
	/** Native terminal key -> conversation id. */
	private readonly _keys = new Map<string, string>();
	private readonly _containers = new Map<string, HTMLElement>();
	private _listening: Promise<void> | null = null;

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
	}
	private get pool(): ScreenPool {
		return Injector.get(ScreenPool);
	}
	private get toast(): ToastService {
		return Injector.get(ToastService);
	}

	/** The folder name of the checkout on screen, for labels. */
	checkoutName(): string {
		const repo = this.repos.repo();
		return repo ? folderName(repo.worktree ?? repo.path) : '';
	}

	get(id: string): Conversation | null {
		return this.conversations().find((c) => c.id === id) ?? null;
	}

	/** Make sure the open repository has a layout, starting hook events on first use. */
	ensureLayout(): LayoutNode | null {
		const repo = this.repos.repo();
		if (!repo) {
			return null;
		}
		void (this._listening ??= this.listen());
		const have = this.layouts()[repo.id];
		if (have) {
			return have;
		}
		const known = new Set(this.conversations().filter((c) => c.repoId === repo.id).map((c) => c.id));
		const layout = restoreLayout(this._savedLayouts[repo.id], known);
		// Not inside the render that asked: a signal set while rendering would render again at once.
		queueMicrotask(() => {
			if (!this.layouts()[repo.id]) {
				this.layouts.set({ ...this.layouts(), [repo.id]: layout });
			}
		});
		return layout;
	}

	// ---- view ---------------------------------------------------------------

	setView(view: WorkspaceView): void {
		const repo = this.repos.repo();
		if (!repo) {
			return;
		}
		this._views.set({ ...this._views(), [repo.id]: view });
		write(VIEWS_KEY, this._views());
		if (this.shown() !== 'hidden') {
			this.markSeen();
			requestAnimationFrame(() => this.focusActive());
		}
	}

	toggle(): void {
		if (this.shown() === 'hidden') {
			this.reveal();
		} else {
			this.setView('hidden');
		}
	}

	/** Put the workspace on screen: beside the main pane, or alone when the window has no room for both. */
	private reveal(): void {
		if (this.shown() === 'hidden') {
			this.setView(this.fits() ? 'side' : 'full');
		}
	}

	/** The app shell reports the width the two panes share, whenever it changes. */
	setRoom(room: number, windowWidth: number): void {
		const was = this.shown();
		const r = this._room();
		if (!r || r.room !== room || r.window !== windowWidth) {
			this._room.set({ room, window: windowWidth });
		}
		// The window grew and the workspace is back beside the main pane.
		if (was === 'hidden' && this.shown() !== 'hidden') {
			this.markSeen();
		}
	}

	/** Something was opened in the main pane (a file clicked): bring it back on screen if the workspace fills the window. */
	revealMain(): void {
		if (this.view() === 'full') {
			this.setView('side');
		}
	}

	/** Dragging the edge. What is kept is what the pane really got, so a drag past the main pane's drag floor (`MIN_MAIN_DRAG_W`) is not remembered. */
	setWidth(width: number): void {
		const r = this._room();
		this._dragged.set(r ? sideWidth(Math.round(width), r.room, r.window) : Math.max(MIN_SIDE_W, Math.round(width)));
	}

	saveWidth(): void {
		write(WIDTH_KEY, this._dragged());
	}

	/** Back to a third of the window. */
	resetWidth(): void {
		this._dragged.set(null);
		try {
			localStorage.removeItem(WIDTH_KEY);
		} catch {
			/* blocked storage */
		}
	}

	// ---- starting things ----------------------------------------------------

	/**
	 * A new Claude conversation in the open repository: in the checkout on screen,
	 * or with `branch`, in a new worktree on that branch.
	 */
	async newClaude(options: { pane?: string; branch?: string } = {}): Promise<void> {
		const repo = this.repos.repo();
		if (!repo) {
			return;
		}
		let cwd = repo.worktree ?? repo.path;
		let branch = this.repos.status()?.branch ?? null;
		const wanted = options.branch?.trim();
		if (wanted) {
			try {
				cwd = await this.backend.addWorktree(repo.id, wanted, null);
				branch = wanted;
				void this.repos.loadBranches();
			} catch (e) {
				this.repos.fail(e);
				return;
			}
		}
		const now = Date.now();
		const conv: Conversation = {
			id: newId('c'),
			kind: 'claude',
			repoId: repo.id,
			cwd,
			branch,
			title: 'New conversation',
			titled: false,
			sessionId: crypto.randomUUID(),
			state: 'starting',
			waitingFor: null,
			lastSaid: '',
			subagents: [],
			created: now,
			updated: now,
			unread: false,
		};
		this.addTab(conv, options.pane);
	}

	// ---- sessions started outside the app --------------------------------------

	/** Read a repository's Claude Code sessions from its transcripts again (cheap: Rust keeps what it read). */
	async loadElsewhere(repoId: string): Promise<void> {
		try {
			const found = await this.backend.claudeSessions(repoId);
			this.elsewhere.set({ ...this.elsewhere(), [repoId]: found });
		} catch {
			// A repository that is gone, or no Claude Code data: nothing to show (and nothing to ask again for).
			this.elsewhere.set({ ...this.elsewhere(), [repoId]: [] });
		}
	}

	/** A repository's outside sessions that are not one of our conversations already. */
	elsewhereIn(repoId: string): ClaudeSession[] {
		const ours = new Set(this.conversations().map((c) => c.sessionId));
		return (this.elsewhere()[repoId] ?? []).filter((s) => !ours.has(s.id));
	}

	/**
	 * Bring an outside session into the workspace as a saved conversation: a tab that offers
	 * to continue it with `claude --resume`. Nothing runs until the user says so there.
	 */
	async adopt(repoId: string, s: ClaudeSession): Promise<void> {
		const known = this.conversations().find((c) => c.sessionId === s.id);
		if (known) {
			return this.open(known.id);
		}
		if (this.repos.repo()?.id !== repoId) {
			await this.repos.selectRepo(repoId);
		}
		const conv: Conversation = {
			id: newId('c'),
			kind: 'claude',
			repoId,
			cwd: s.cwd,
			branch: s.branch,
			title: s.title ?? plainSummary(s.prompt, 48),
			titled: true,
			prompt: s.prompt,
			outside: true,
			sessionId: s.id,
			state: 'saved',
			waitingFor: null,
			lastSaid: s.lastSaid ?? '',
			subagents: [],
			created: s.modified,
			updated: s.modified,
			unread: false,
		};
		this.addTab(conv);
		this.select(conv.id);
	}

	/** A plain shell in the checkout on screen. */
	newShell(pane?: string): void {
		const repo = this.repos.repo();
		if (!repo) {
			return;
		}
		const cwd = repo.worktree ?? repo.path;
		const taken = new Set(this.conversations().filter((c) => c.kind === 'shell').map((c) => c.title));
		let title = folderName(cwd);
		for (let n = 2; taken.has(title); n++) {
			title = `${folderName(cwd)} ${n}`;
		}
		const now = Date.now();
		this.addTab(
			{ id: newId('t'), kind: 'shell', repoId: repo.id, cwd, branch: this.repos.status()?.branch ?? null, title, titled: true, sessionId: null, state: 'starting', waitingFor: null, lastSaid: '', subagents: [], created: now, updated: now, unread: false },
			pane,
		);
	}

	/** Continue a saved conversation where it left off. */
	resume(id: string): void {
		const conv = this.get(id);
		if (!conv || conv.kind !== 'claude' || (conv.state !== 'saved' && conv.state !== 'ended')) {
			return;
		}
		const screen = this._screens.get(id);
		if (screen) {
			this.pool.reset(screen);
		}
		this.patch(id, { state: 'starting', outside: false });
		this.open(id);
	}

	private addTab(conv: Conversation, pane?: string): void {
		this.conversations.set([...this.conversations(), conv]);
		this.save();
		this.reveal();
		this.place(conv.id, pane ?? this.targetPane(), 'center');
	}

	/** The pane new tabs go to: the focused one, else the first. */
	private targetPane(): string {
		const layout = this.ensureLayout();
		const panes = layout ? panesOf(layout) : [];
		const focused = panes.find((p) => p.id === this.focusedPane());
		return (focused ?? panes[0]).id;
	}

	// ---- tabs and panes -----------------------------------------------------

	/** Show a conversation: switch to its repository, open the workspace, select its tab (adding it back when closed). */
	async open(id: string): Promise<void> {
		const conv = this.get(id);
		if (!conv) {
			return;
		}
		if (this.repos.repo()?.id !== conv.repoId) {
			await this.repos.selectRepo(conv.repoId);
		}
		this.reveal();
		const layout = this.ensureLayout();
		const pane = layout && panesOf(layout).find((p) => p.tabs.includes(id));
		if (pane) {
			this.select(id);
		} else {
			this.place(id, this.targetPane(), 'center');
		}
	}

	select(id: string): void {
		const layout = this.layout();
		const pane = layout && panesOf(layout).find((p) => p.tabs.includes(id));
		if (!pane) {
			return;
		}
		this.updatePane(pane.id, (p) => ({ ...p, active: id }));
		this.focusedPane.set(pane.id);
		this.patch(id, { unread: false });
		requestAnimationFrame(() => {
			this.showPane(pane.id);
			this.pool.focus(this._screens.get(id) ?? '');
		});
	}

	/**
	 * Close a tab. A shell ends. A Claude conversation ends too but is kept (saved), so it can
	 * be resumed from the Agents tab; `forget` drops it from the list as well.
	 */
	close(id: string, forget = false): void {
		const conv = this.get(id);
		if (!conv) {
			return;
		}
		const screen = this._screens.get(id);
		if (screen) {
			this.pool.close(screen);
			this._screens.delete(id);
		}
		for (const [key, c] of this._keys) {
			if (c === id) {
				this._keys.delete(key);
			}
		}
		this.removeFromLayouts(id);
		if (conv.kind === 'shell' || forget || !conv.titled) {
			// A conversation nobody typed into has nothing to resume.
			this.conversations.set(this.conversations().filter((c) => c.id !== id));
		} else {
			this.patch(id, { state: 'saved', waitingFor: null, subagents: conv.subagents.map((s) => ({ ...s, running: false })) });
		}
		this.save();
	}

	/** Put a tab into `pane`, or into a new pane on one side of it. Moves it when it is somewhere else already. */
	place(id: string, pane: string, drop: Drop): void {
		const repo = this.repos.repo();
		const layout = this.ensureLayout();
		if (!repo || !layout) {
			return;
		}
		const source = panesOf(layout).find((p) => p.tabs.includes(id));
		if (source && source.id === pane && (drop === 'center' || source.tabs.length === 1)) {
			this.select(id);
			return;
		}
		// Out of where it was first; an emptied pane goes, unless it is the target or the last one.
		let next: LayoutNode | null = mapNode(layout, (n) => {
			if (n.type !== 'pane' || !n.tabs.includes(id)) {
				return n;
			}
			const tabs = n.tabs.filter((t) => t !== id);
			if (!tabs.length && n.id !== pane) {
				return null;
			}
			return { ...n, tabs, active: n.active === id ? (tabs[Math.max(0, n.tabs.indexOf(id) - 1)] ?? null) : n.active };
		});
		next ??= emptyPane();
		if (!panesOf(next).some((p) => p.id === pane)) {
			pane = panesOf(next)[0].id;
			drop = 'center';
		}
		let target = pane;
		if (drop === 'center') {
			next = mapNode(next, (n) => (n.type === 'pane' && n.id === pane ? { ...n, tabs: [...n.tabs, id], active: id } : n))!;
		} else {
			const fresh: Pane = { type: 'pane', id: newId('p'), tabs: [id], active: id };
			target = fresh.id;
			next = this.splitAt(next, pane, fresh, drop);
		}
		this.setLayout(repo.id, next);
		this.focusedPane.set(target);
		this.patch(id, { unread: false });
		requestAnimationFrame(() => {
			this.showAll();
			this.pool.focus(this._screens.get(id) ?? '');
		});
	}

	/** An empty pane beside `pane`, to start something in. */
	split(pane: string, dir: 'row' | 'column'): void {
		const repo = this.repos.repo();
		const layout = this.ensureLayout();
		if (!repo || !layout) {
			return;
		}
		const fresh = emptyPane();
		this.setLayout(repo.id, this.splitAt(layout, pane, fresh, dir === 'row' ? 'right' : 'bottom'));
		this.focusedPane.set(fresh.id);
		requestAnimationFrame(() => this.showAll());
	}

	/** Close a pane; its tabs move to its neighbour. */
	closePane(pane: string): void {
		const repo = this.repos.repo();
		const layout = this.layout();
		if (!repo || !layout) {
			return;
		}
		const panes = panesOf(layout);
		const gone = panes.find((p) => p.id === pane);
		if (!gone || panes.length < 2) {
			return;
		}
		const at = panes.indexOf(gone);
		const heir = panes[at > 0 ? at - 1 : 1];
		const next = mapNode(layout, (n) => {
			if (n.type !== 'pane') {
				return n;
			}
			if (n.id === pane) {
				return null;
			}
			return n.id === heir.id ? { ...n, tabs: [...n.tabs, ...gone.tabs], active: n.active ?? gone.active } : n;
		});
		this.setLayout(repo.id, next ?? emptyPane());
		this.focusedPane.set(heir.id);
		requestAnimationFrame(() => this.showAll());
	}

	/** New sizes (shares that add up to 1) for the children of a split. */
	resize(split: string, sizes: number[]): void {
		const repo = this.repos.repo();
		const layout = this.layout();
		if (!repo || !layout) {
			return;
		}
		this.setLayout(repo.id, mapNode(layout, (n) => (n.type === 'split' && n.id === split ? { ...n, sizes } : n))!, false);
	}

	saveLayouts(): void {
		write(LAYOUT_KEY, this.persistable());
	}

	private splitAt(layout: LayoutNode, pane: string, fresh: Pane, drop: Exclude<Drop, 'center'>): LayoutNode {
		const dir = drop === 'left' || drop === 'right' ? 'row' : 'column';
		const before = drop === 'left' || drop === 'top';
		const insert = (node: LayoutNode): LayoutNode => {
			if (node.type === 'pane') {
				if (node.id !== pane) {
					return node;
				}
				return { type: 'split', id: newId('s'), dir, children: before ? [fresh, node] : [node, fresh], sizes: [0.5, 0.5] };
			}
			const at = node.children.findIndex((c) => c.type === 'pane' && c.id === pane);
			if (at >= 0 && node.dir === dir) {
				// Same direction: a new sibling sharing the space of the pane it splits.
				const children = [...node.children];
				const sizes = [...node.sizes];
				const half = (sizes[at] ?? 1 / children.length) / 2;
				sizes[at] = half;
				children.splice(before ? at : at + 1, 0, fresh);
				sizes.splice(before ? at : at + 1, 0, half);
				return { ...node, children, sizes };
			}
			return { ...node, children: node.children.map(insert) };
		};
		return insert(layout);
	}

	private updatePane(pane: string, fn: (p: Pane) => Pane): void {
		const repo = this.repos.repo();
		const layout = this.layout();
		if (repo && layout) {
			this.setLayout(repo.id, mapNode(layout, (n) => (n.type === 'pane' && n.id === pane ? fn(n) : n))!);
		}
	}

	private removeFromLayouts(id: string): void {
		const all = { ...this.layouts() };
		for (const [repoId, layout] of Object.entries(all)) {
			if (!panesOf(layout).some((p) => p.tabs.includes(id))) {
				continue;
			}
			all[repoId] =
				mapNode(layout, (n) => {
					if (n.type !== 'pane' || !n.tabs.includes(id)) {
						return n;
					}
					const tabs = n.tabs.filter((t) => t !== id);
					return { ...n, tabs, active: n.active === id ? (tabs[Math.max(0, n.tabs.indexOf(id) - 1)] ?? null) : n.active };
				}) ?? emptyPane();
		}
		this.layouts.set(all);
		this.saveLayouts();
		requestAnimationFrame(() => this.showAll());
	}

	private setLayout(repoId: string, layout: LayoutNode, persist = true): void {
		this.layouts.set({ ...this.layouts(), [repoId]: layout });
		if (persist) {
			this.saveLayouts();
		}
	}

	/** Layouts without shells, which do not survive a restart. */
	private persistable(): Record<string, LayoutNode> {
		const keep = new Set(this.conversations().filter((c) => c.kind === 'claude').map((c) => c.id));
		const out: Record<string, LayoutNode> = { ...this._savedLayouts };
		for (const [repoId, layout] of Object.entries(this.layouts())) {
			out[repoId] = restoreLayout(layout, keep);
		}
		return out;
	}

	// ---- screens in panes ---------------------------------------------------

	/** A pane's element for screens, while its component is in the page. */
	attachPane(pane: string, container: HTMLElement): void {
		this._containers.set(pane, container);
		this.showPane(pane);
	}

	detachPane(pane: string, container: HTMLElement): void {
		if (this._containers.get(pane) === container) {
			this._containers.delete(pane);
		}
	}

	showAll(): void {
		const layout = this.layout();
		if (layout) {
			panesOf(layout).forEach((p) => this.showPane(p.id));
		}
	}

	/** Show a pane's active tab in it, creating and starting its program when it has none yet. */
	showPane(paneId: string): void {
		const container = this._containers.get(paneId);
		const layout = this.layout();
		const pane = layout && panesOf(layout).find((p) => p.id === paneId);
		if (!container || !pane) {
			return;
		}
		const conv = pane.active ? this.get(pane.active) : null;
		if (!conv) {
			for (const child of Array.from(container.children)) {
				if (child instanceof HTMLElement && child.classList.contains('screen')) {
					child.hidden = true;
				}
			}
			return;
		}
		if (conv.state === 'saved') {
			// Shown with a Resume button instead; nothing starts by itself after a restart.
			const screen = this._screens.get(conv.id);
			if (screen) {
				this.pool.hide(screen);
			}
			return;
		}
		const screen = this._screens.get(conv.id);
		if (!screen) {
			void this.createScreen(conv.id, paneId);
			return;
		}
		const shown = this.pool.show(screen, container);
		if (shown && !this.pool.started(screen) && conv.state === 'starting') {
			void this.startProgram(conv.id, screen);
		}
	}

	focusActive(): void {
		const layout = this.layout();
		const pane = layout && (panesOf(layout).find((p) => p.id === this.focusedPane()) ?? panesOf(layout)[0]);
		if (pane?.active) {
			this.showPane(pane.id);
			this.pool.focus(this._screens.get(pane.active) ?? '');
		}
	}

	private _creating = new Set<string>();

	private async createScreen(id: string, pane: string): Promise<void> {
		if (this._creating.has(id)) {
			return;
		}
		this._creating.add(id);
		try {
			const screen = await this.pool.create({
				exit: (code, ranFor) => this.exited(id, code, ranFor),
				claude: this.get(id)?.kind === 'claude',
				input: () => {
					const c = this.get(id);
					// Answering a permission question (or anything typed while asked) means Claude is on its way again.
					if (c?.state === 'waiting') {
						this.patch(id, { state: 'working', waitingFor: null });
					}
				},
			});
			if (!this.get(id)) {
				this.pool.close(screen);
				return;
			}
			this._screens.set(id, screen);
			this.showPane(pane);
			if (this.focusedPane() === pane) {
				this.pool.focus(screen);
			}
		} catch (e) {
			this.repos.fail(e);
		} finally {
			this._creating.delete(id);
		}
	}

	/** Conversations whose program is being started. A pane is shown again and again meanwhile, and each time would start it once more. */
	private readonly _startingUp = new Set<string>();

	private async startProgram(id: string, screen: string): Promise<void> {
		const conv = this.get(id);
		if (!conv || this._startingUp.has(id)) {
			return;
		}
		this._startingUp.add(id);
		const resume = conv.kind === 'claude' && conv.titled;
		try {
			await this.pool.start(screen, async (cols, rows) => {
				const key = conv.kind === 'claude' ? await this.backend.claudeOpen(conv.repoId, conv.cwd, conv.sessionId!, resume, cols, rows) : await this.backend.termOpen(conv.repoId, cols, rows);
				this._keys.set(key, id);
				return key;
			});
			const now = this.get(id);
			if (now?.state === 'starting') {
				this.patch(id, { state: 'idle' });
			}
		} catch (e) {
			this.patch(id, { state: conv.kind === 'claude' && conv.titled ? 'saved' : 'ended' });
			this.pool.note(screen, String((e as { message?: string })?.message ?? e));
			this.repos.fail(e);
		} finally {
			this._startingUp.delete(id);
		}
	}

	private exited(id: string, code: number | null, ranFor: number): void {
		const conv = this.get(id);
		if (!conv) {
			return;
		}
		const screen = this._screens.get(id);
		if (conv.kind === 'shell') {
			if (!code || ranFor > FAILED_START_MS) {
				this.close(id);
			} else {
				this.patch(id, { state: 'ended' });
				if (screen) {
					this.pool.note(screen, `[The shell ended with exit code ${code}]`);
				}
			}
			return;
		}
		if (!code || ranFor > FAILED_START_MS) {
			// Exiting Claude Code (/exit, Ctrl+D twice) closes the tab; a titled conversation stays saved and resumable.
			this.close(id);
			return;
		}
		this.patch(id, { state: 'ended', waitingFor: null, subagents: conv.subagents.map((s) => (s.running ? { ...s, running: false, ended: Date.now() } : s)) });
		if (screen) {
			this.pool.note(screen, `[Claude Code ended with exit code ${code}]`);
		}
		this.save();
	}

	// ---- what Claude Code's hooks say ---------------------------------------

	private async listen(): Promise<void> {
		await this.backend.listen<ClaudeHook>('claude-hook', (e) => this.hook(e, 0));
	}

	private hook(e: ClaudeHook, tries: number): void {
		const id = this._keys.get(e.key);
		if (!id) {
			// The hook can beat the answer to `claudeOpen` by a moment.
			if (tries < 5) {
				setTimeout(() => this.hook(e, tries + 1), 200);
			}
			return;
		}
		const conv = this.get(id);
		if (!conv) {
			return;
		}
		const now = Date.now();
		const changes: Partial<Conversation> = { updated: now };
		if (e.sessionId && e.sessionId !== conv.sessionId) {
			changes.sessionId = e.sessionId;
		}
		switch (e.event) {
			case 'SessionStart':
				if (conv.state === 'starting') {
					changes.state = 'idle';
				}
				if (e.kind === 'clear') {
					changes.subagents = [];
				}
				break;
			case 'UserPromptSubmit': {
				changes.state = 'working';
				changes.waitingFor = null;
				const prompt = (e.text ?? '').trim();
				// Claude Code also "submits" notices of its own (a background task finished): not the user's words.
				if (prompt && !prompt.startsWith('<')) {
					changes.lastSaid = plainSummary(prompt, 200);
					if (!conv.titled) {
						changes.title = plainSummary(prompt, 48);
						changes.prompt = plainSummary(prompt, 600);
						changes.titled = true;
					}
				}
				break;
			}
			case 'PreToolUse':
				changes.state = 'working';
				if (e.toolUseId && !conv.subagents.some((s) => s.id === e.toolUseId)) {
					changes.subagents = [...conv.subagents, { id: e.toolUseId, description: e.description ?? 'Subagent', type: e.subagentType, running: true, started: now, ended: null }].slice(-MAX_SUBAGENTS);
				}
				break;
			case 'PostToolUse':
				changes.subagents = conv.subagents.map((s) => (s.id === e.toolUseId ? { ...s, running: false, ended: now } : s));
				break;
			case 'Notification':
				// "Waiting for your input" after a minute at the prompt is not news: Stop already said the turn ended.
				if (e.kind !== 'idle_prompt') {
					changes.state = 'waiting';
					changes.waitingFor = e.text ?? 'Claude is waiting for you';
				}
				break;
			case 'Stop':
				changes.state = 'idle';
				changes.waitingFor = null;
				if (e.text) {
					changes.lastSaid = plainSummary(e.text, 400);
				}
				break;
			case 'SessionEnd':
				break;
		}
		const visible = this.isVisible(id);
		if ((changes.state === 'waiting' || (e.event === 'Stop' && conv.state !== 'idle')) && !visible) {
			changes.unread = true;
			this.announce({ ...conv, ...changes });
		}
		this.patch(id, changes);
		if (e.event === 'UserPromptSubmit' || e.event === 'Stop' || e.event === 'SessionStart') {
			this.save();
		}
	}

	/** Whether a conversation is on screen right now (and the window has the user's attention). */
	isVisible(id: string): boolean {
		if (this.shown() === 'hidden' || (typeof document !== 'undefined' && (document.hidden || !document.hasFocus()))) {
			return false;
		}
		const layout = this.layout();
		return !!layout && panesOf(layout).some((p) => p.active === id);
	}

	private announce(conv: Conversation): void {
		const repo = this.repos.app()?.repos.find((r) => r.id === conv.repoId);
		const where = repo && repo.id !== this.repos.repo()?.id ? ` · ${repo.name}` : '';
		const waiting = conv.state === 'waiting';
		this.toast.show({
			variant: waiting ? 'warning' : 'success',
			title: (waiting ? 'Claude needs you' : 'Claude finished') + where,
			message: `${conv.title}: ${(waiting ? conv.waitingFor : conv.lastSaid)?.slice(0, 160) ?? ''}`,
			duration: 9000,
		});
	}

	/** What is on screen has been seen. */
	markSeen(): void {
		const layout = this.layout();
		if (!layout) {
			return;
		}
		const shown = new Set(panesOf(layout).map((p) => p.active));
		if (this.conversations().some((c) => c.unread && shown.has(c.id))) {
			this.conversations.set(this.conversations().map((c) => (c.unread && shown.has(c.id) ? { ...c, unread: false } : c)));
		}
	}

	// ---- state --------------------------------------------------------------

	private patch(id: string, changes: Partial<Conversation>): void {
		this.conversations.set(this.conversations().map((c) => (c.id === id ? { ...c, ...changes } : c)));
	}

	private save(): void {
		const saved = this.conversations()
			.filter((c) => c.kind === 'claude' && c.titled && c.sessionId)
			.sort((a, b) => b.updated - a.updated)
			.slice(0, MAX_SAVED)
			.map((c) => ({ ...c, unread: false }));
		write(CONV_KEY, saved);
	}
}

/** For templates outside the workspace (the toolbar button). */
export function workspace(): WorkspaceStore {
	return Injector.get(WorkspaceStore);
}
