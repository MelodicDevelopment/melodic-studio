/**
 * Agent sessions and worktrees. An agent is Claude Code running headless in one
 * checkout of the repository, usually a worktree on its own branch, so several
 * can work at once without touching each other or the main checkout. Reviewing
 * an agent's work is switching the app to its worktree: Changes, History and
 * Files then show that branch.
 *
 * Two kinds of session share this store. A `task` changes code (optionally as
 * several parallel attempts, each in its own worktree, compared side by side).
 * An `ask` session is a read-only chat about the code or its history: it runs
 * in the active checkout and may only use the tools listed in `ASK_TOOLS`.
 *
 * Everything here can be driven without the UI: the actions are plain async
 * methods, and `idle(id)` resolves when a session's turn has ended.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal, computed } from '@melodicdev/core/signals';
import { ToastService } from '@melodicdev/components/toast';
import { BackendService, asAppError, type AgentDone, type AgentEvent, type AgentMode, type Worktree, type WorktreeDiff } from './backend.service';
import { RepoStore } from './repo.store';
import { ExplorerStore } from './explorer.store';
import { WorkspaceStore } from './workspace.store';
import { samePath } from './agent-paths';

export interface AgentItem {
	kind: 'user' | 'text' | 'tool' | 'error';
	text: string;
	/** For a tool call: what it acted on (a path, a command). */
	detail?: string;
}

export type AgentKind = 'task' | 'ask';
/** What an `ask` session may look at: the files, or the files and the git history. */
export type AskScope = 'code' | 'history';
/** How a session stands, for lists that show many at once. */
export type AgentState = 'working' | 'failed' | 'review' | 'stopped' | 'finished';

export interface AgentSession {
	id: string;
	repoId: string;
	title: string;
	/** The checkout it works in. */
	cwd: string;
	branch: string | null;
	/** True when it has a worktree of its own (rather than working in the main checkout). */
	isolated: boolean;
	mode: AgentMode;
	/** Claude Code's session id, which carries the conversation into the next turn. */
	sessionId: string | null;
	status: 'idle' | 'running' | 'failed';
	items: AgentItem[];
	cost: number;
	updated: number;
	/** `task` changes code; `ask` only reads and answers. Sessions saved before there were kinds are tasks. */
	kind: AgentKind;
	/** Parallel attempts at the same task share a group id. */
	group: string | null;
	/** Its number within the group, from 1. */
	attempt: number;
	/** The commit its checkout was at when it started: what the compare view diffs against. */
	base: string | null;
	/** The permission rules an `ask` session runs with, which are also all the tools it has. Null for tasks. */
	tools: string[] | null;
	/** A turn ended while nobody was looking at it. */
	unread: boolean;
	/** A task turn ended and its changes have not been looked at since. */
	review: boolean;
	/** The last turn was stopped by hand. */
	stopped: boolean;
}

export interface NewTask {
	task: string;
	/** Empty to work in the checkout the app is looking at. */
	branch: string;
	mode: AgentMode;
	/** Run the task this many times in parallel (1 to 3), each in its own worktree: `branch`, `branch-2`, `branch-3`. */
	attempts?: number;
}

/** A link in an agent's answer: a place in a file, a commit, or a web address. */
export type AgentRef = { kind: 'file'; path: string; line: number | null; column: number | null } | { kind: 'commit'; hash: string } | { kind: 'url'; url: string };

const KEY = 'studio.agents';
const MAX_ITEMS = 400;
export const MAX_ATTEMPTS = 3;

/** Tool inputs worth showing beside the tool name, in order of preference. */
const DETAIL_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt'];

/**
 * Everything a read-only session can do. The rules are passed as Claude Code's allow-list in
 * `default` permission mode (anything else that needs permission is refused, as nobody is there
 * to grant it), and the tool names in them are the only built-in tools the session is given.
 */
export const ASK_TOOLS: Record<AskScope, string[]> = {
	code: ['Read', 'Grep', 'Glob'],
	history: ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git blame:*)'],
};

export const STATE_LABELS: Record<AgentState, string> = { working: 'Working', failed: 'Failed', review: 'Needs review', stopped: 'Stopped', finished: 'Finished' };

export function stateOf(s: AgentSession): AgentState {
	if (s.status === 'running') {
		return 'working';
	}
	if (s.status === 'failed') {
		return 'failed';
	}
	if (s.stopped) {
		return 'stopped';
	}
	return s.review ? 'review' : 'finished';
}

/** Whether a read-only session may look at git history as well as files. */
export function scopeOf(s: AgentSession): AskScope {
	return s.tools?.some((t) => t.startsWith('Bash(git')) ? 'history' : 'code';
}

/** A message as one line of plain text, for previews. */
export function plainSummary(text: string, max = 220): string {
	const flat = text
		.replace(/```[\s\S]*?(```|$)/g, ' ')
		.replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/gm, '')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[*_~`]+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The last thing a session said (or what went wrong), as one line. */
export function lastSaid(s: AgentSession): string {
	for (let i = s.items.length - 1; i >= 0; i--) {
		const item = s.items[i];
		if (item.kind === 'text' || item.kind === 'error') {
			return plainSummary(item.text);
		}
		if (item.kind === 'user') {
			break;
		}
	}
	return '';
}

function load(): AgentSession[] {
	try {
		const sessions = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Partial<AgentSession>[];
		return sessions
			.filter((s): s is Partial<AgentSession> & Pick<AgentSession, 'id' | 'repoId' | 'cwd'> => !!s && typeof s.id === 'string' && typeof s.repoId === 'string' && typeof s.cwd === 'string')
			.map((s) => ({
				title: '',
				branch: null,
				isolated: false,
				mode: 'acceptEdits' as AgentMode,
				sessionId: null,
				cost: 0,
				updated: 0,
				// Fields newer than the session itself.
				kind: 'task' as AgentKind,
				group: null,
				attempt: 1,
				base: null,
				tools: null,
				unread: false,
				review: false,
				stopped: false,
				...s,
				items: Array.isArray(s.items) ? s.items : [],
				// Nothing survives a restart mid-run.
				status: s.status === 'failed' ? 'failed' : 'idle',
			}));
	} catch {
		return [];
	}
}

/** A branch name from the first words of a task: "Fix the seek bug!" -> agent/fix-the-seek-bug. */
export function branchFor(task: string): string {
	const words = task
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, '')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 5);
	return words.length ? `agent/${words.join('-')}` : '';
}

/** The branch each attempt works on: `agent/x`, `agent/x-2`, `agent/x-3`. */
export function attemptBranch(branch: string, attempt: number): string {
	return attempt <= 1 ? branch : `${branch}-${attempt}`;
}

/**
 * The first message of a read-only session: the rules, then the question. The first line is the
 * tag the browser preview's demo backend recognises. Later turns send only the question.
 */
export function askPrompt(scope: AskScope, question: string): string {
	const history = scope === 'history';
	const lines = [
		history ? '[ask-history]' : '[ask-repository]',
		'You are answering a question about the code in this git repository, from inside a desktop git client. Your answer is shown as Markdown beside the code.',
		'',
		'Rules:',
		`- This is read-only. You have ${history ? 'Read, Grep and Glob, plus Bash for `git log`, `git show`, `git diff` and `git blame` only' : 'Read, Grep and Glob only'}. Do not try to change, create or delete anything, and do not offer to.`,
		'- Your working directory is the root of the repository.',
		`- Look before you answer: search and read the code${history ? ' and its history' : ''} instead of guessing. If you cannot find something, say so.`,
		'- Cite every place in the code you refer to as `path:line`, in backticks, with the path relative to the repository root and forward slashes, for example `src/services/auth.ts:42`. For a whole file give the path alone, `src/services/auth.ts`. The app turns these into links that open the file at that line, so always include the folders and only cite lines you have actually read.',
	];
	if (history) {
		lines.push(
			// Found by running it: `cd <dir>; git log`, `git -C <dir> log`, pipelines and an unquoted `--format=%h|%s` do not match the allowed rules and are refused.
			'- Every Bash command must be one plain git command that starts with exactly `git log`, `git show`, `git diff` or `git blame`, run where you are: no `cd`, no `git -C`, no pipes, no `&&` or `;`, and quotes round any argument that contains `|` or `%`. Anything else is refused. Use git\'s own options (`-n 20`, `--oneline`, `--stat`, `-- <path>`) to keep the output small.',
			'- Cite commits by their short hash in backticks, for example `a1b2c3d`, with the subject and date beside it. The app turns hashes into links to the commit.',
			'- When the question is when or why something changed, find the commit that changed it (`git log -S<text>`, `git log -G<regex>`, `git log -L<start>,<end>:<file>`, `git log --follow -- <file>` and `git blame` are the tools for that), then explain why from its message and its diff. Say plainly when the history does not record a reason.'
		);
	}
	lines.push('- Lead with the answer in a sentence or two, then the detail that supports it. Keep it short: brief paragraphs and lists, code blocks only for code that matters.', '', `Question: ${question}`);
	return lines.join('\n');
}

/** The tool names in a list of permission rules: `Bash(git log:*)` -> `Bash`. */
function toolNames(rules: string[]): string[] {
	return [...new Set(rules.map((r) => r.replace(/\(.*$/, '')))];
}

@Injectable()
export class AgentsStore {
	readonly sessions = signal<AgentSession[]>(load());
	readonly selectedId = signal<string | null>(null);
	readonly worktrees = signal<Worktree[]>([]);
	/** Claude Code's version; null when the CLI is missing, undefined until checked. */
	readonly cli = signal<string | null | undefined>(undefined);
	readonly busy = signal(false);
	/** Set while the main pane shows the box for a new question instead of a session. */
	readonly asking = signal<{ scope: AskScope; seed: string } | null>(null);
	/** The group whose attempts the main pane is comparing, if any. */
	readonly comparing = signal<string | null>(null);
	/**
	 * A history question asked from the History tab stays there: its main pane shows the question box,
	 * then the session (`id`), instead of switching to the Agents tab. `open` is false while a commit is shown instead.
	 */
	readonly historyChat = signal<{ id: string | null; open: boolean } | null>(null);
	/** `historyChat` while it belongs to the repository on screen. */
	readonly docked = computed(() => {
		const chat = this.historyChat();
		const repo = this.repos.repo()?.id;
		if (!chat || !repo) {
			return null;
		}
		return chat.id ? (this.sessions().some((s) => s.id === chat.id && s.repoId === repo) ? chat : null) : chat;
	});
	/** Bumped when a link selects a commit, so the History list can scroll to it. */
	readonly commitShown = signal(0);

	/** Sessions of the repository that is open, newest first. */
	readonly current = computed<AgentSession[]>(() => {
		const id = this.repos.repo()?.id;
		return this.sessions()
			.filter((s) => s.repoId === id)
			.sort((a, b) => b.updated - a.updated);
	});
	readonly selected = computed<AgentSession | null>(() => this.current().find((s) => s.id === this.selectedId()) ?? null);
	readonly activeWorktree = computed<Worktree | null>(() => this.worktrees().find((w) => w.active && !w.isMain) ?? null);
	/** Across every repository. */
	readonly running = computed<number>(() => this.sessions().filter((s) => s.status === 'running').length);
	/** Sessions, in any repository, that ended a turn nobody has looked at yet. */
	readonly unread = computed<number>(() => this.sessions().filter((s) => s.unread).length);

	private _listening: Promise<void> | null = null;
	/** Sessions with a Claude Code process that has not reported back yet. */
	private readonly _live = new Set<string>();
	private readonly _waiting = new Map<string, (() => void)[]>();

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
	}
	private get toast(): ToastService {
		return Injector.get(ToastService);
	}

	private fail(e: unknown): void {
		this.toast.error('That did not work', asAppError(e).message.slice(0, 400));
	}

	// ---- lifecycle ----------------------------------------------------------

	/** Subscribe to Claude Code's events, once. Everything that starts a turn waits for this. */
	private listen(): Promise<void> {
		return (this._listening ??= (async () => {
			await this.backend.listen<AgentEvent>('agent-event', (p) => this.onEvent(p));
			await this.backend.listen<AgentDone>('agent-done', (p) => this.onDone(p));
			this.backend
				.agentAvailable()
				.then((v) => this.cli.set(v))
				.catch(() => this.cli.set(null));
		})());
	}

	/** Called when anything showing agents appears (the Agents tab, the toolbar's board button). Safe to call again. */
	async init(): Promise<void> {
		await this.listen();
		await this.loadWorktrees();
	}

	async loadWorktrees(): Promise<void> {
		const id = this.repos.repo()?.id;
		if (!id) {
			this.worktrees.set([]);
			return;
		}
		try {
			const trees = await this.backend.worktrees(id);
			if (id === this.repos.repo()?.id) {
				this.worktrees.set(trees);
			}
		} catch {
			this.worktrees.set([]);
		}
	}

	private save(sessions: AgentSession[]): void {
		this.sessions.set(sessions);
		try {
			localStorage.setItem(KEY, JSON.stringify(sessions.map((s) => ({ ...s, items: s.items.slice(-MAX_ITEMS) }))));
		} catch {
			/* storage full or blocked: sessions still work until the window closes */
		}
	}

	/** `touch` false leaves "how long ago" alone: marking something as seen is not activity. */
	private update(id: string, change: (s: AgentSession) => AgentSession, touch = true): void {
		// Events for one-shot questions (AiService) share the channel; they are not sessions.
		if (!this.sessions().some((s) => s.id === id)) {
			return;
		}
		this.save(this.sessions().map((s) => (s.id === id ? { ...change(s), updated: touch ? Date.now() : s.updated } : s)));
	}

	private find(id: string): AgentSession | null {
		return this.sessions().find((s) => s.id === id) ?? null;
	}

	/** Is this session what the window is showing right now? */
	private watching(s: AgentSession): boolean {
		const docked = this.repos.tab() === 'history' && this.docked()?.open;
		if (document.visibilityState !== 'visible' || this.repos.repo()?.id !== s.repoId || (this.repos.tab() !== 'agents' && !docked) || this.asking()) {
			return false;
		}
		const comparing = this.comparing();
		return comparing ? comparing === s.group : this.selectedId() === s.id;
	}

	/**
	 * Resolves when the session's current turn has ended: at once if none is running, or
	 * after `timeout` ms (when given) if Claude Code has still not reported back.
	 */
	idle(id: string, timeout = 0): Promise<void> {
		if (!this._live.has(id)) {
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this._waiting.set(id, [...(this._waiting.get(id) ?? []), resolve]);
			if (timeout > 0) {
				setTimeout(resolve, timeout);
			}
		});
	}

	private settle(id: string): void {
		this._live.delete(id);
		const waiting = this._waiting.get(id) ?? [];
		this._waiting.delete(id);
		waiting.forEach((resolve) => resolve());
	}

	// ---- events from Claude Code ---------------------------------------------

	private onEvent({ key, event }: AgentEvent): void {
		const type = event.type as string;
		if (type === 'system') {
			this.update(key, (s) => ({ ...s, sessionId: (event.session_id as string) ?? s.sessionId }));
			return;
		}
		if (type === 'assistant') {
			const blocks = ((event.message as { content?: Record<string, unknown>[] })?.content ?? []) as Record<string, unknown>[];
			const items: AgentItem[] = [];
			for (const b of blocks) {
				if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
					items.push({ kind: 'text', text: b.text });
				} else if (b.type === 'tool_use') {
					const input = (b.input ?? {}) as Record<string, unknown>;
					const found = DETAIL_KEYS.find((k) => typeof input[k] === 'string');
					items.push({ kind: 'tool', text: String(b.name), detail: found ? String(input[found]).split('\n')[0].slice(0, 200) : undefined });
				}
			}
			if (items.length) {
				this.update(key, (s) => ({ ...s, items: [...s.items, ...items] }));
			}
			return;
		}
		if (type === 'result') {
			this.update(key, (s) => ({
				...s,
				sessionId: (event.session_id as string) ?? s.sessionId,
				// Claude Code reports the running total for the whole session, not this turn's share.
				cost: Number(event.total_cost_usd) || s.cost,
				items: event.is_error ? [...s.items, { kind: 'error', text: String(event.result ?? 'The agent stopped with an error.') }] : s.items,
			}));
		}
	}

	private onDone({ key, ok, error }: AgentDone): void {
		const session = this.find(key);
		if (!session) {
			return;
		}
		const stopped = session.status !== 'running';
		const watching = this.watching(session);
		this.update(key, (s) => ({
			...s,
			status: ok || stopped ? 'idle' : 'failed',
			items: !ok && !stopped ? [...s.items, { kind: 'error', text: error || 'Claude Code exited with an error.' }] : s.items,
			unread: !stopped && !watching,
			// A plan changes nothing, and neither does a question.
			review: s.review || (ok && !stopped && s.kind === 'task' && s.mode !== 'plan'),
		}));
		this.settle(key);
		if (!stopped && !watching) {
			this.announce(this.find(key) ?? session, ok);
		}
		if (session.repoId === this.repos.repo()?.id) {
			// Whatever it changed should show up without waiting for the next poll.
			void this.repos.refresh();
			void this.loadWorktrees();
		}
	}

	/** A turn ended somewhere the user is not looking: say so. The toolbar's board button carries the badge. */
	private announce(s: AgentSession, ok: boolean): void {
		const repo = this.repos.app()?.repos.find((r) => r.id === s.repoId);
		const where = repo && repo.id !== this.repos.repo()?.id ? ` · ${repo.name}` : '';
		const what = s.group ? `${s.title} (attempt ${s.attempt})` : s.title;
		this.toast.show({
			variant: ok ? 'success' : 'error',
			title: ok ? (s.kind === 'ask' ? 'Answer ready' : 'Agent finished') + where : `Agent failed${where}`,
			message: ok ? what : `${what}: ${lastSaid(s).slice(0, 160)}`,
			duration: 9000,
		});
	}

	// ---- sessions -----------------------------------------------------------

	/** Show a session of the open repository in the main pane. */
	select(id: string | null): void {
		const chat = this.historyChat();
		if (chat?.open && chat.id !== id) {
			this.historyChat.set(chat.id ? { ...chat, open: false } : null);
		}
		this.asking.set(null);
		this.comparing.set(null);
		this.selectedId.set(id);
		if (id) {
			this.seen(id);
			// The transcript is in the main pane, which a full-window Claude workspace would hide.
			// (Resolved here, not at load: workspace.store imports this module.)
			Injector.get(WorkspaceStore).revealMain();
		}
	}

	/** The session is on screen: it no longer counts as unread. */
	seen(id: string): void {
		if (this.find(id)?.unread) {
			this.update(id, (s) => ({ ...s, unread: false }), false);
		}
	}

	/** Make the session's repository the open one. False when it is no longer in the app. */
	private async showRepo(s: AgentSession): Promise<boolean> {
		if (this.repos.repo()?.id !== s.repoId) {
			if (!this.repos.app()?.repos.some((r) => r.id === s.repoId)) {
				this.toast.warning('Repository not found', 'This agent belongs to a repository that is no longer in Melodic Studio.');
				return false;
			}
			await this.repos.selectRepo(s.repoId);
		}
		return this.repos.repo()?.id === s.repoId;
	}

	/** Go to a session wherever it lives: switch to its repository, open the Agents tab, select it. */
	async open(id: string): Promise<boolean> {
		const s = this.find(id);
		if (!s || !(await this.showRepo(s))) {
			return false;
		}
		this.repos.setTab('agents');
		this.select(s.id);
		await this.loadWorktrees();
		return true;
	}

	private newSession(repoId: string, title: string, cwd: string, branch: string | null, extra: Partial<AgentSession>): AgentSession {
		return {
			id: crypto.randomUUID(),
			repoId,
			title: title.split('\n')[0].slice(0, 80),
			cwd,
			branch,
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
			...extra,
		};
	}

	/**
	 * Start a task: optionally make a worktree on a new branch, then run the first turn there.
	 * With `attempts` above 1 (and a branch) the same task starts in that many worktrees at once,
	 * as one group to compare afterwards.
	 */
	async start(task: NewTask): Promise<boolean> {
		const repo = this.repos.repo();
		const prompt = task.task.trim();
		if (!repo || !prompt || this.busy()) {
			return false;
		}
		this.busy.set(true);
		try {
			await this.listen();
			const branch = task.branch.trim();
			const made: { cwd: string; branch: string | null; base: string | null }[] = [];
			if (branch) {
				const wanted = Math.min(MAX_ATTEMPTS, Math.max(1, Math.floor(task.attempts ?? 1)));
				let failure: unknown = null;
				for (let n = 1; n <= wanted; n++) {
					try {
						const name = attemptBranch(branch, n);
						made.push({ cwd: await this.backend.addWorktree(repo.id, name, null), branch: name, base: null });
					} catch (e) {
						failure = e;
						break;
					}
				}
				if (!made.length) {
					throw failure;
				}
				if (failure) {
					this.fail(failure); // the attempts that did get a worktree still run
				}
				// Where each one starts from, so its work can be compared against that later.
				const trees = await this.backend.worktrees(repo.id).catch(() => [] as Worktree[]);
				for (const m of made) {
					m.base = trees.find((w) => samePath(w.path, m.cwd))?.head ?? null;
				}
			} else {
				made.push({ cwd: repo.worktree ?? repo.path, branch: this.repos.status()?.branch ?? null, base: this.repos.status()?.head ?? null });
			}
			const group = made.length > 1 ? crypto.randomUUID() : null;
			const sessions = made.map((m, i) => this.newSession(repo.id, prompt, m.cwd, m.branch, { isolated: !!branch, mode: task.mode, base: m.base, group, attempt: i + 1 }));
			this.save([...this.sessions(), ...sessions]);
			this.select(sessions[0].id);
			this.comparing.set(group);
			await Promise.all(sessions.map((s) => this.send(s.id, prompt)));
			if (branch) {
				await this.loadWorktrees();
				await this.repos.loadBranches(); // the new branches belong in the toolbar's list
			}
			return true;
		} catch (e) {
			this.fail(e);
			return false;
		} finally {
			this.busy.set(false);
		}
	}

	/** Show the box for a new read-only question (on the Agents tab), optionally with a question already in it. */
	openAsk(scope: AskScope = 'code', seed = ''): void {
		if (scope === 'history' && this.repos.tab() === 'history') {
			this.historyChat.set({ id: null, open: true });
		} else {
			this.hideHistoryChat();
			this.repos.setTab('agents');
		}
		this.comparing.set(null);
		this.selectedId.set(null);
		this.asking.set({ scope, seed });
	}

	/**
	 * Ask a question about the code (`code`) or about how it came to be (`history`). The answer
	 * arrives in a new read-only session in the checkout the app is looking at; no worktree is made.
	 */
	async ask(question: string, scope: AskScope = 'code'): Promise<boolean> {
		const repo = this.repos.repo();
		const text = question.trim();
		if (!repo || !text) {
			return false;
		}
		await this.listen();
		const session = this.newSession(repo.id, text, repo.worktree ?? repo.path, this.repos.status()?.branch ?? null, { kind: 'ask', mode: 'default', tools: ASK_TOOLS[scope], base: this.repos.status()?.head ?? null });
		this.save([...this.sessions(), session]);
		this.select(session.id);
		if (scope === 'history' && this.historyChat()?.open) {
			this.historyChat.set({ id: session.id, open: true });
		}
		await this.send(session.id, text);
		return this.find(session.id)?.status !== 'failed';
	}

	/** Run another turn in an existing session. */
	async send(id: string, prompt: string): Promise<void> {
		const session = this.find(id);
		const text = prompt.trim();
		if (!session || !text || session.status === 'running') {
			return;
		}
		await this.listen();
		this.update(id, (s) => ({ ...s, status: 'running', stopped: false, unread: false, items: [...s.items, { kind: 'user', text }] }));
		this._live.add(id);
		try {
			if (session.kind === 'ask') {
				const rules = session.tools ?? ASK_TOOLS.code;
				// The rules of the session go in once; after that Claude Code's own session remembers them.
				const wire = session.sessionId ? text : askPrompt(scopeOf(session), text);
				await this.backend.agentStart(session.repoId, session.cwd, id, wire, 'default', session.sessionId, { tools: rules, builtin: toolNames(rules), lean: true });
			} else {
				await this.backend.agentStart(session.repoId, session.cwd, id, text, session.mode, session.sessionId);
			}
		} catch (e) {
			this.update(id, (s) => ({ ...s, status: 'failed', items: [...s.items, { kind: 'error', text: asAppError(e).message }] }));
			this.settle(id);
		}
	}

	async stop(id: string): Promise<void> {
		this.update(id, (s) => ({ ...s, status: 'idle', stopped: true, items: [...s.items, { kind: 'error', text: 'Stopped.' }] }));
		await this.backend.agentStop(id).catch(() => undefined);
	}

	setMode(id: string, mode: AgentMode): void {
		this.update(id, (s) => ({ ...s, mode }), false);
	}

	/** Point the whole app at a checkout (null for the main one) and open a tab on it. */
	async view(path: string | null, tab: 'changes' | 'agents' = 'changes'): Promise<void> {
		const repo = this.repos.repo();
		if (!repo) {
			return;
		}
		try {
			await this.backend.selectWorktree(repo.id, path);
			await this.repos.switchContext(tab);
			await this.loadWorktrees();
		} catch (e) {
			this.fail(e);
		}
	}

	/** Look at what a session changed: its checkout becomes the active one, on the Changes tab. */
	async review(session: AgentSession): Promise<void> {
		if (!(await this.showRepo(session))) {
			return;
		}
		this.update(session.id, (s) => ({ ...s, review: false, unread: false }), false);
		await this.view(session.isolated ? session.cwd : null);
	}

	/**
	 * Merge a session's branch into `into`, a branch the user picked (protected branches are
	 * left to a pull request instead). The merge happens where `into` is checked out: a worktree
	 * that has it, else the main checkout, which switches to it first (refused while it has
	 * uncommitted changes). With `from`, `into` is a new branch made from `from` in the main checkout.
	 */
	async merge(session: AgentSession, into: string, from: string | null = null): Promise<boolean> {
		if (!session.branch || !into || into === session.branch || !(await this.showRepo(session))) {
			return false;
		}
		try {
			const trees = await this.backend.worktrees(session.repoId);
			const holder = from ? null : trees.find((w) => w.branch === into);
			if (holder && !holder.isMain) {
				await this.view(holder.path, 'agents');
			} else {
				await this.view(null, 'agents');
				const main = trees.find((w) => w.isMain);
				if (from) {
					if (!(await this.repos.createBranch(into, from))) {
						return false;
					}
				} else if (!holder) {
					if (main?.changes) {
						this.toast.error('The main checkout has uncommitted changes', `Commit or stash them before switching it to ${into}.`);
						return false;
					}
					await this.repos.loadBranches();
					const branch = this.repos.branches().find((b) => !b.isRemote && b.name === into);
					if (!branch || !(await this.repos.checkout(branch))) {
						return false;
					}
				}
			}
			const ok = await this.repos.merge(session.branch);
			if (ok) {
				this.update(session.id, (s) => ({ ...s, review: false }), false);
			}
			return ok;
		} catch (e) {
			this.fail(e);
			return false;
		} finally {
			await this.loadWorktrees();
			await this.repos.loadBranches();
		}
	}

	private drop(id: string): void {
		this.save(this.sessions().filter((s) => s.id !== id));
		if (this.selectedId() === id) {
			this.selectedId.set(null);
		}
	}

	/** Forget a session; optionally remove its worktree and branch as well. */
	async remove(session: AgentSession, withWorktree: boolean): Promise<void> {
		if (session.status === 'running') {
			await this.stop(session.id);
			await this.idle(session.id, 4000);
		}
		if (withWorktree && session.isolated) {
			if (!(await this.removeWorktree(session.cwd, true, session.repoId))) {
				return;
			}
		}
		this.drop(session.id);
		const group = session.group;
		if (group) {
			// One attempt left is not a comparison any more.
			const rest = this.attempts(group);
			if (rest.length === 1) {
				this.update(rest[0].id, (s) => ({ ...s, group: null, attempt: 1 }), false);
			}
			if (rest.length < 2 && this.comparing() === group) {
				this.comparing.set(null);
			}
		}
	}

	/**
	 * Remove a worktree. `force` also discards uncommitted changes in it and deletes its branch
	 * (unless `deleteBranch` says otherwise). `repoId` is for a repository other than the open one.
	 */
	async removeWorktree(path: string, force: boolean, repoId: string | null = null, deleteBranch = force): Promise<boolean> {
		const id = repoId ?? this.repos.repo()?.id;
		if (!id) {
			return false;
		}
		const open = id === this.repos.repo()?.id;
		const wasActive = open && this.worktrees().some((w) => samePath(w.path, path) && w.active);
		try {
			await this.backend.removeWorktree(id, path, force, deleteBranch);
			if (open) {
				if (wasActive) {
					await this.repos.switchContext('agents');
				}
				await this.loadWorktrees();
				// Its branch went with it; the toolbar's branch list should not go on offering it.
				await this.repos.loadBranches();
			}
			return true;
		} catch (e) {
			this.fail(e);
			return false;
		}
	}

	// ---- parallel attempts ----------------------------------------------------

	/** The sessions of one group, in attempt order. */
	attempts(group: string): AgentSession[] {
		return this.sessions()
			.filter((s) => s.group === group)
			.sort((a, b) => a.attempt - b.attempt);
	}

	/** The History tab's main pane goes back to the selected commit; the docked question can be reopened. */
	hideHistoryChat(): void {
		const chat = this.historyChat();
		if (chat?.open) {
			this.historyChat.set(chat.id && this.find(chat.id) ? { id: chat.id, open: false } : null);
			if (!chat.id) {
				this.asking.set(null);
			}
		}
	}

	/** Bring the History tab's docked question back into its main pane. */
	showHistoryChat(): void {
		const id = this.historyChat()?.id;
		if (id && this.find(id)) {
			this.select(id);
			this.historyChat.set({ id, open: true });
		}
	}

	/** Show a group's attempts side by side in the main pane. */
	compare(group: string): void {
		this.asking.set(null);
		this.comparing.set(group);
		for (const s of this.attempts(group)) {
			this.seen(s.id);
		}
	}

	/** Everything a session's checkout holds that the commit it started from does not, uncommitted and untracked work included. */
	changes(session: AgentSession): Promise<WorktreeDiff> {
		return this.backend.worktreeDiff(session.repoId, session.cwd, session.base);
	}

	/**
	 * Settle on one attempt: the others are stopped, their worktrees and branches deleted
	 * (uncommitted work included) and their sessions forgotten. The one kept becomes an ordinary agent.
	 */
	async keep(session: AgentSession): Promise<boolean> {
		const group = session.group;
		if (!group || this.busy()) {
			return false;
		}
		this.busy.set(true);
		try {
			const trees = await this.backend.worktrees(session.repoId);
			for (const other of this.attempts(group).filter((s) => s.id !== session.id)) {
				if (other.status === 'running') {
					await this.stop(other.id);
					await this.idle(other.id, 4000); // a worktree cannot go while a process still sits in it
				}
				// One that was already removed by hand has nothing left to delete.
				if (other.isolated && trees.some((w) => !w.isMain && samePath(w.path, other.cwd)) && !(await this.removeWorktree(other.cwd, true, other.repoId))) {
					return false;
				}
				this.drop(other.id);
			}
			this.update(session.id, (s) => ({ ...s, group: null, attempt: 1 }), false);
			if (this.comparing() === group) {
				this.comparing.set(null);
			}
			if (session.repoId === this.repos.repo()?.id) {
				this.selectedId.set(session.id);
			}
			return true;
		} catch (e) {
			this.fail(e);
			return false;
		} finally {
			this.busy.set(false);
		}
	}

	// ---- links in answers -----------------------------------------------------

	/** Follow a link from a session's answer. */
	async follow(session: AgentSession, ref: AgentRef): Promise<void> {
		if (ref.kind === 'url') {
			await this.backend.openUrl(ref.url).catch(() => this.toast.info('Could not open the link', ref.url));
		} else if (ref.kind === 'file') {
			await this.openFile(session, ref.path, ref.line, ref.column);
		} else {
			await this.openCommit(session, ref.hash);
		}
	}

	/** Open a repository-relative file in the Files tab, at a line when one is given. */
	async openFile(session: AgentSession, path: string, line: number | null = null, column: number | null = null): Promise<void> {
		if (!(await this.showRepo(session))) {
			return;
		}
		this.repos.setTab('files');
		const explorer = Injector.get(ExplorerStore);
		if (line) {
			await explorer.openAt(path, line, column ?? 1);
		} else {
			explorer.sync();
			explorer.open(path, true);
		}
	}

	/**
	 * Select a commit in the History tab by full or abbreviated hash, loading older history until
	 * it turns up. False when it is not on the branch that is checked out.
	 */
	async openCommit(session: AgentSession, hash: string): Promise<boolean> {
		if (!(await this.showRepo(session))) {
			return false;
		}
		const repos = this.repos;
		repos.tab.set('history');
		if (repos.compareBranch()) {
			await repos.setCompare(null); // the links point into the branch's own history
		}
		if (!repos.historyLoaded()) {
			await repos.loadHistory(true);
		}
		const find = () => repos.commits().find((c) => c.hash.startsWith(hash));
		let commit = find();
		for (let page = 0; !commit && !repos.historyEnd() && page < 50; page++) {
			const before = repos.commits().length;
			await repos.loadHistory(false);
			if (repos.commits().length === before) {
				break; // the load failed, or the repository changed under us
			}
			commit = find();
		}
		if (!commit) {
			this.toast.info('Commit not in this history', `${hash.slice(0, 10)} is not on the branch that is checked out.`);
			return false;
		}
		repos.selectCommit(commit.hash);
		this.hideHistoryChat();
		this.commitShown.set(this.commitShown() + 1);
		return true;
	}
}
