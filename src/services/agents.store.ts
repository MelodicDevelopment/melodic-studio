/**
 * Agent sessions and worktrees. An agent is Claude Code running headless in one
 * checkout of the repository, usually a worktree on its own branch, so several
 * can work at once without touching each other or the main checkout. Reviewing
 * an agent's work is switching the app to its worktree: Changes, History and
 * Files then show that branch.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal, computed } from '@melodicdev/core/signals';
import { ToastService } from '@melodicdev/components/toast';
import { BackendService, asAppError, type AgentDone, type AgentEvent, type AgentMode, type Worktree } from './backend.service';
import { RepoStore } from './repo.store';

export interface AgentItem {
	kind: 'user' | 'text' | 'tool' | 'error';
	text: string;
	/** For a tool call: what it acted on (a path, a command). */
	detail?: string;
}

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
}

export interface NewTask {
	task: string;
	/** Empty to work in the checkout the app is looking at. */
	branch: string;
	mode: AgentMode;
}

const KEY = 'studio.agents';
const MAX_ITEMS = 400;

/** Tool inputs worth showing beside the tool name, in order of preference. */
const DETAIL_KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description', 'prompt'];

function load(): AgentSession[] {
	try {
		const sessions = JSON.parse(localStorage.getItem(KEY) ?? '[]') as AgentSession[];
		// Nothing survives a restart mid-run.
		return sessions.map((s) => ({ ...s, status: s.status === 'running' ? 'idle' : s.status }));
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

@Injectable()
export class AgentsStore {
	readonly sessions = signal<AgentSession[]>(load());
	readonly selectedId = signal<string | null>(null);
	readonly worktrees = signal<Worktree[]>([]);
	/** Claude Code's version; null when the CLI is missing, undefined until checked. */
	readonly cli = signal<string | null | undefined>(undefined);
	readonly busy = signal(false);

	/** Sessions of the repository that is open, newest first. */
	readonly current = computed<AgentSession[]>(() => {
		const id = this.repos.repo()?.id;
		return this.sessions()
			.filter((s) => s.repoId === id)
			.sort((a, b) => b.updated - a.updated);
	});
	readonly selected = computed<AgentSession | null>(() => this.current().find((s) => s.id === this.selectedId()) ?? null);
	readonly activeWorktree = computed<Worktree | null>(() => this.worktrees().find((w) => w.active && !w.isMain) ?? null);

	private _listening = false;

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

	/** Called when the Agents tab first shows. Safe to call again. */
	async init(): Promise<void> {
		if (!this._listening) {
			this._listening = true;
			await this.backend.listen<AgentEvent>('agent-event', (p) => this.onEvent(p));
			await this.backend.listen<AgentDone>('agent-done', (p) => this.onDone(p));
			this.backend
				.agentAvailable()
				.then((v) => this.cli.set(v))
				.catch(() => this.cli.set(null));
		}
		await this.loadWorktrees();
	}

	async loadWorktrees(): Promise<void> {
		const id = this.repos.repo()?.id;
		if (!id) {
			this.worktrees.set([]);
			return;
		}
		try {
			this.worktrees.set(await this.backend.worktrees(id));
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

	private update(id: string, change: (s: AgentSession) => AgentSession): void {
		this.save(this.sessions().map((s) => (s.id === id ? { ...change(s), updated: Date.now() } : s)));
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
		const session = this.sessions().find((s) => s.id === key);
		if (!session) {
			return;
		}
		const stopped = session.status !== 'running';
		this.update(key, (s) => ({
			...s,
			status: ok || stopped ? 'idle' : 'failed',
			items: !ok && !stopped ? [...s.items, { kind: 'error', text: error || 'Claude Code exited with an error.' }] : s.items,
		}));
		// Whatever it changed should show up without waiting for the next poll.
		void this.repos.refresh();
		void this.loadWorktrees();
	}

	// ---- actions ------------------------------------------------------------

	/** Start a task: optionally make a worktree on a new branch, then run the first turn there. */
	async start(task: NewTask): Promise<boolean> {
		const repo = this.repos.repo();
		const prompt = task.task.trim();
		if (!repo || !prompt || this.busy()) {
			return false;
		}
		this.busy.set(true);
		try {
			const branch = task.branch.trim();
			let cwd = repo.worktree ?? repo.path;
			if (branch) {
				cwd = await this.backend.addWorktree(repo.id, branch, null);
			}
			const session: AgentSession = {
				id: crypto.randomUUID(),
				repoId: repo.id,
				title: prompt.split('\n')[0].slice(0, 80),
				cwd,
				branch: branch || (this.repos.status()?.branch ?? null),
				isolated: !!branch,
				mode: task.mode,
				sessionId: null,
				status: 'idle',
				items: [],
				cost: 0,
				updated: Date.now(),
			};
			this.save([...this.sessions(), session]);
			this.selectedId.set(session.id);
			void this.loadWorktrees();
			await this.send(session.id, prompt);
			return true;
		} catch (e) {
			this.fail(e);
			return false;
		} finally {
			this.busy.set(false);
		}
	}

	/** Run another turn in an existing session. */
	async send(id: string, prompt: string): Promise<void> {
		const session = this.sessions().find((s) => s.id === id);
		const text = prompt.trim();
		if (!session || !text || session.status === 'running') {
			return;
		}
		this.update(id, (s) => ({ ...s, status: 'running', items: [...s.items, { kind: 'user', text }] }));
		try {
			await this.backend.agentStart(session.repoId, session.cwd, id, text, session.mode, session.sessionId);
		} catch (e) {
			this.update(id, (s) => ({ ...s, status: 'failed', items: [...s.items, { kind: 'error', text: asAppError(e).message }] }));
		}
	}

	async stop(id: string): Promise<void> {
		this.update(id, (s) => ({ ...s, status: 'idle', items: [...s.items, { kind: 'error', text: 'Stopped.' }] }));
		await this.backend.agentStop(id).catch(() => undefined);
	}

	setMode(id: string, mode: AgentMode): void {
		this.update(id, (s) => ({ ...s, mode }));
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
	review(session: AgentSession): Promise<void> {
		return this.view(session.isolated ? session.cwd : null);
	}

	/** Merge a session's branch into whatever the main checkout has checked out. */
	async merge(session: AgentSession): Promise<void> {
		if (!session.branch) {
			return;
		}
		await this.view(null, 'agents');
		await this.repos.merge(session.branch);
		await this.loadWorktrees();
	}

	/** Forget a session; optionally remove its worktree and branch as well. */
	async remove(session: AgentSession, withWorktree: boolean): Promise<void> {
		if (session.status === 'running') {
			await this.stop(session.id);
		}
		if (withWorktree && session.isolated) {
			if (!(await this.removeWorktree(session.cwd, true))) {
				return;
			}
		}
		this.save(this.sessions().filter((s) => s.id !== session.id));
		if (this.selectedId() === session.id) {
			this.selectedId.set(null);
		}
	}

	/** Remove a worktree. `force` also discards uncommitted changes in it and deletes its branch. */
	async removeWorktree(path: string, force: boolean): Promise<boolean> {
		const repo = this.repos.repo();
		if (!repo) {
			return false;
		}
		const wasActive = this.worktrees().some((w) => w.path === path && w.active);
		try {
			await this.backend.removeWorktree(repo.id, path, force, force);
			if (wasActive) {
				await this.repos.switchContext('agents');
			}
			await this.loadWorktrees();
			return true;
		} catch (e) {
			this.fail(e);
			return false;
		}
	}
}
