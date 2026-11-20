/**
 * Agent sessions and worktrees. An agent is Claude Code running headless in one
 * checkout of the repository, usually a worktree on its own branch, so several
 * can work at once without touching each other or the main checkout. Reviewing
 * an agent's work is switching the app to its worktree: Changes, History and
 * Files then show that branch.
 *
 * Three kinds of session share this store. A `task` changes code (optionally as
 * several parallel attempts, each in its own worktree, compared side by side).
 * An `ask` session is a read-only chat about the code or its history: it runs
 * in the active checkout and may only use the tools listed in `ASK_TOOLS`.
 * An `investigate` session reproduces a failure in a worktree of its own: it may
 * edit and build there, but running the app, sending it a request and running
 * tests go through Studio's own tools, which ask the user here first. It ends
 * in a report (cause, path, evidence, fix) and a recording to replay.
 *
 * Everything here can be driven without the UI: the actions are plain async
 * methods, and `idle(id)` resolves when a session's turn has ended.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal, computed } from '@melodicdev/core/signals';
import { ToastService } from '@melodicdev/components/toast';
import { DialogService } from '@melodicdev/components/dialog';
import { BackendService, asAppError, isDesktop, type AgentDone, type AgentEvent, type AgentMode, type InvestigateApproval, type InvestigateProgress, type InvestigateStarted, type RunTarget, type Worktree, type WorktreeDiff } from './backend.service';
import { RepoStore } from './repo.store';
import { ExplorerStore } from './explorer.store';
import { WorkspaceStore } from './workspace.store';
import { samePath } from './agent-paths';
import { prepareImage, type Attachment } from './agent-images';
import { IMAGE_TYPES, MAX_IMAGES } from '../shared/images';
import { TerminalStore } from './terminal.store';
import { INVESTIGATE_BUILTIN, INVESTIGATE_RULES, fixProblemsPrompt, investigateCleanup, investigateFollowUp, investigatePrompt, parseInvestigation, type InvestigationReport } from './ai-prompts';
import { LspService, type Impact, type Problem } from './lsp.service';
import { changesSince, languageOf } from './lsp/protocol';
import { leftoverRecording } from '../shared/replay';
import type { SpottedError } from '../shared/error-spotting';

export interface AgentItem {
	kind: 'user' | 'text' | 'tool' | 'error';
	text: string;
	/** For a tool call: what it acted on (a path, a command). */
	detail?: string;
	/** For a message of the user's: the images sent with it, by their names in the session's folder. */
	images?: string[];
}

export type AgentKind = 'task' | 'ask' | 'investigate';
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
	/** What an `investigate` session is looking into and how far it has got. Null for the other kinds. */
	investigation: Investigation | null;
	/** What the language servers made of the files a task changed, as of its last turn. Null: not looked at. */
	check: WorkCheck | null;
}

/** The language servers' verdict on what a task changed; see `CheckResult`. `problems` hold compiler output: text only. */
export interface WorkCheck {
	state: 'checking' | 'done';
	/** Errors that were not there at the commit the task started from. */
	problems: Problem[];
	/** How many errors those files had before, and still have. */
	known: number;
	/** What it changed that files it did not touch use. */
	impact: Impact[];
	/** The servers that looked, by their names for people. */
	servers: string[];
	/** How many changed files they were shown, and how many files that use them. */
	files: number;
	users: number;
	/** False when a server was still working when the time ran out. */
	finished: boolean;
}

/** More changed files than this and only the first ones are checked. */
const MAX_CHECKED = 60;
const CHECK_KEY = 'studio.agents.check';

/** The state of one investigation. `summary` and everything in `approval` and `report` come from the program or from Claude: text only. */
export interface Investigation {
	/** The failure in one line. */
	summary: string;
	/** What the user wrote about it, if anything. */
	description: string;
	targetId: string | null;
	/** The target as the toolbar names it ("Shop.Api · https"), for the cards and "Always allow". */
	targetName: string | null;
	/** The port its copy of the app runs on, once it has been started. */
	port: number | null;
	/** The checklist step Claude is on, 1 to 6; 0 before it has said. */
	step: number;
	/** What Claude said under each step, by step number. */
	details: Record<string, string>;
	thinking: string;
	/** Claude wants to run something and is waiting for the answer. */
	approval: InvestigateApproval | null;
	/** How many times it has run the app or the tests. */
	runs: number;
	started: number;
	ended: number | null;
	report: InvestigationReport | null;
	/** Files that still hold recording code after Claude said it was done. The fix is not offered while there are any. */
	leftover: string[];
	/** How many times Claude has been sent back to remove recording. */
	cleanups: number;
	/** The worktree is being checked for leftover recording. */
	checking: boolean;
	/** The terminal tab of the app it started, while that tab is open. */
	tab: string | null;
}

/** What Investigate is started with: a spotted error, text from a terminal, a description, or any mix. */
export interface InvestigateRequest {
	description: string;
	/** A spotted error, or `{ text }` alone for output the user selected. */
	error: (Partial<SpottedError> & { text: string }) | null;
	target: RunTarget | null;
	/** The command Studio ran and how it ended, when the failure came from a run. */
	command: string | null;
	exitCode: number | null;
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
/** "Always allow for <target>": the targets, by repository, whose investigations run without asking. */
const ALLOW_KEY = 'studio.investigate.allow';
/** How many times an investigation is sent back to remove leftover recording before its report is shown without a fix. */
const MAX_CLEANUPS = 2;
/** While a turn streams, its session is written at most this often; when the turn ends, at once. */
const SAVE_EVERY_MS = 500;
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
	// An investigation that has asked to run something is waiting on the user, though its turn is still going.
	if (s.investigation?.approval) {
		return 'review';
	}
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

/** A session's state in words. Investigations have their own: they wait for an OK and end in a cause, not a diff to review. */
export function stateLabel(s: AgentSession): string {
	const state = stateOf(s);
	const i = s.investigation;
	if (s.kind !== 'investigate' || !i) {
		return STATE_LABELS[state];
	}
	switch (state) {
		case 'working':
			return i.checking ? 'Checking the fix' : 'Investigating';
		case 'review':
			return 'Waiting for you';
		case 'finished':
			return !i.report ? 'Finished' : !i.report.found ? 'No cause found' : i.leftover.length ? 'Cause found' : 'Cause found · fix ready';
		default:
			return STATE_LABELS[state];
	}
}

/** The branch an investigation works on: "NullReferenceException in ApplyDiscount" -> investigate/nullreferenceexception-in-applydiscount. */
export function investigateBranch(summary: string): string {
	const words = summary
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, ' ')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 5);
	return `investigate/${words.join('-').slice(0, 60).replace(/-+$/, '') || 'bug'}`;
}

function loadAllowed(): Record<string, string[]> {
	try {
		const v = JSON.parse(localStorage.getItem(ALLOW_KEY) ?? '{}');
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string[]>) : {};
	} catch {
		return {};
	}
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

/** What versions before 0.6 kept in browser storage: moved to files once (`AgentsStore.restore`), then removed. */
function legacy(): unknown[] {
	try {
		const sessions = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
		return Array.isArray(sessions) ? sessions : [];
	} catch {
		return [];
	}
}

/** Saved sessions as the app uses them: fields newer than a session filled in, and nothing left "running". */
function revive(saved: unknown[]): AgentSession[] {
	try {
		const sessions = saved as Partial<AgentSession>[];
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
				// A check does not outlive the app either. One saved before it knew what was new is not shown as if it did.
				check: s.check?.state === 'done' && Array.isArray(s.check.impact) ? s.check : null,
				items: Array.isArray(s.items) ? s.items : [],
				// Nothing survives a restart mid-run.
				status: s.status === 'failed' ? 'failed' : 'idle',
				// Neither does a question Claude was waiting on, or the app it had running.
				investigation: s.investigation ? { ...s.investigation, approval: null, checking: false, tab: null } : null,
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

function readCheckSetting(): boolean {
	try {
		return localStorage.getItem(CHECK_KEY) !== 'off';
	} catch {
		return true;
	}
}

@Injectable()
export class AgentsStore {
	/** Empty until `restored` resolves: the sessions are read from files in the app's data folder. */
	readonly sessions = signal<AgentSession[]>([]);
	readonly selectedId = signal<string | null>(null);
	readonly worktrees = signal<Worktree[]>([]);
	/** Claude Code's version; null when the CLI is missing, undefined until checked. */
	readonly cli = signal<string | null | undefined>(undefined);
	readonly busy = signal(false);
	/** Set while the main pane shows the box for a new question instead of a session. */
	readonly asking = signal<{ scope: AskScope; seed: string } | null>(null);
	/** What the Agents tab lists: the open repository's sessions and conversations, or every repository's. Kept here because the tab is rebuilt on every switch. */
	readonly listScope = signal<'repo' | 'all'>('repo');
	/** Whether the Agents tab's Worktrees section is unfolded. */
	readonly treesShown = signal(false);
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
	/** The investigation whose recorded run the main pane is replaying, if any. */
	readonly replaying = signal<string | null>(null);
	/** The box for describing a bug to investigate is open, with this terminal output (possibly none) to go with it. */
	readonly investigateDraft = signal<{ output: string } | null>(null);
	private readonly _allowed = signal<Record<string, string[]>>(loadAllowed());

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
	/** Images waiting in a session's composer, by session. In memory only, like the text beside them, but they outlive the pane (rebuilt on a tab switch). */
	readonly attached = signal<Record<string, Attachment[]>>({});
	/** Images being made ready, by session. */
	readonly attaching = signal<Record<string, number>>({});
	/** The images of the transcript on screen as `data:` addresses ('' for one whose file is gone). One session's at a time. */
	private readonly _shots = new Map<string, string>();
	private _shotsOf: string | null = null;
	private readonly _shotsLoading = new Set<string>();
	private readonly _shotsSeen = signal(0);

	/** Sessions changed since they were last written, each with the timer that will write it. */
	private readonly _unsaved = new Map<string, number>();
	/** Sessions being written right now: one write per session at a time, since async commands can overtake each other. */
	private readonly _writing = new Map<string, Promise<void>>();
	/** Changed again while being written. */
	private readonly _again = new Set<string>();
	/** The last write failed and the user has been told; said again only after one succeeds in between. */
	private _saveFailed = false;
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
			await this.backend.listen<InvestigateApproval>('investigate-approval', (p) => this.onApproval(p));
			await this.backend.listen<InvestigateProgress>('investigate-progress', (p) => this.onProgress(p));
			this.backend
				.agentAvailable()
				.then((v) => this.cli.set(v))
				.catch(() => this.cli.set(null));
		})());
	}

	/** Called when anything showing agents appears (the Agents tab, the toolbar's board button). Safe to call again. */
	async init(): Promise<void> {
		await this.restored;
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
				this.settleReviews(id, trees);
			}
		} catch {
			this.worktrees.set([]);
		}
	}

	/**
	 * A task with a worktree of its own needs the user until its work is dealt with, not until they
	 * have looked at it. That is: merged from here (`merge`), marked done (`markDone`), or, seen in the
	 * list of worktrees, the worktree is gone, or it is clean and either made no commit or its commit
	 * is already in the main checkout's branch or the remote's default branch (`Worktree.landed`).
	 */
	private settleReviews(repoId: string, trees: Worktree[]): void {
		if (!trees.length) {
			return;
		}
		const settled = this.sessions().filter((s) => {
			if (s.repoId !== repoId || !s.review || !s.isolated || s.status === 'running') {
				return false;
			}
			const tree = trees.find((w) => samePath(w.path, s.cwd));
			return !tree || (tree.changes === 0 && (tree.head === s.base || tree.landed));
		});
		for (const s of settled) {
			this.update(s.id, (x) => ({ ...x, review: false }), false);
		}
	}

	/** The user says a session needs nothing more from them. Its worktree and branch stay as they are. */
	markDone(id: string): void {
		this.update(id, (s) => ({ ...s, review: false, unread: false }), false);
	}

	/**
	 * The new list of sessions. Whatever differs from the old one is written to its file: at once
	 * when the session is not mid-turn (a turn ended, a session was made, removed or marked),
	 * otherwise within `SAVE_EVERY_MS`, so a stream of events is a write every half second at most.
	 */
	private save(sessions: AgentSession[]): void {
		const before = new Map(this.sessions().map((s) => [s.id, s]));
		this.sessions.set(sessions);
		for (const s of sessions) {
			if (before.get(s.id) !== s) {
				this.persist(s.id, s.status === 'running' ? SAVE_EVERY_MS : 0);
			}
			before.delete(s.id);
		}
		for (const id of before.keys()) {
			this.persist(id, 0); // removed: its file goes
		}
	}

	/** Write a session within `delay` ms. A write already waiting is brought forward, never pushed back. */
	private persist(id: string, delay: number): void {
		if (delay === 0) {
			void this.write(id);
		} else if (!this._unsaved.has(id)) {
			this._unsaved.set(id, window.setTimeout(() => void this.write(id), delay));
		}
	}

	/** One session to its file, as it is now (or its file removed when the session is gone). */
	private write(id: string): Promise<void> {
		window.clearTimeout(this._unsaved.get(id));
		this._unsaved.delete(id);
		const running = this._writing.get(id);
		if (running) {
			this._again.add(id);
			return running;
		}
		const run = (async () => {
			do {
				this._again.delete(id);
				const session = this.find(id);
				try {
					await this.backend.agentSessionSave(id, session ? JSON.stringify(session) : null);
					this._saveFailed = false;
				} catch (e) {
					// Nothing fails silently: the session is still in the window, and the next change tries again.
					if (!this._saveFailed) {
						this._saveFailed = true;
						this.toast.show({ variant: 'error', title: 'Agent history is not being saved', message: `${asAppError(e).message.slice(0, 300)} The sessions stay here until the app closes; they are written again as soon as that works.`, duration: 0 });
					}
				}
			} while (this._again.has(id));
		})().finally(() => this._writing.delete(id));
		this._writing.set(id, run);
		return run;
	}

	/** Everything not yet written, now: before the window goes, and for scripts that want to look at the files. */
	async flush(): Promise<void> {
		await Promise.all([...this._unsaved.keys()].map((id) => this.write(id)));
		await Promise.all([...this._writing.values()]);
	}

	/**
	 * Read the saved sessions, once. What an earlier version kept in browser storage is moved to
	 * files the first time, and only removed from there when every one of them was written.
	 */
	private async restore(): Promise<void> {
		// The window going away (closed, reloaded) takes what was not written yet: at most half a second of a turn.
		window.addEventListener('pagehide', () => void this.flush());
		window.addEventListener('beforeunload', () => void this.flush());
		const saved: unknown[] = [];
		const unreadable: string[] = [];
		try {
			const stored = await this.backend.agentSessionsLoad();
			unreadable.push(...stored.unreadable);
			for (const text of stored.sessions) {
				try {
					saved.push(JSON.parse(text));
				} catch {
					unreadable.push('a session file that is not JSON');
				}
			}
		} catch (e) {
			this.toast.show({ variant: 'error', title: 'Agent history could not be read', message: asAppError(e).message.slice(0, 300), duration: 0 });
		}
		const have = new Set(saved.map((s) => (s as { id?: unknown } | null)?.id));
		const old = isDesktop() ? legacy() : [];
		const moving = revive(old.filter((s) => !have.has((s as { id?: unknown } | null)?.id)));
		// A session started while this was reading is newer than anything read.
		const started = this.sessions();
		const read = [...revive(saved), ...moving].filter((s) => !started.some((x) => x.id === s.id));
		this.sessions.set([...read, ...started]);
		if (unreadable.length) {
			this.toast.show({ variant: 'warning', title: `${unreadable.length} saved agent session${unreadable.length === 1 ? '' : 's'} could not be read`, message: `${unreadable.slice(0, 3).join(', ')}. The file${unreadable.length === 1 ? ' is' : 's are'} left where ${unreadable.length === 1 ? 'it is' : 'they are'}.`, duration: 0 });
		}
		if (old.length) {
			await Promise.all(moving.map((s) => this.write(s.id)));
			if (!this._saveFailed) {
				try {
					localStorage.removeItem(KEY);
				} catch {
					/* blocked storage */
				}
			}
		}
	}

	/** Resolves when the saved sessions are in `sessions`. */
	readonly restored: Promise<void> = this.restore();

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
		if (session.kind === 'investigate') {
			// Its answer is read and its worktree checked for leftover recording before anything is announced.
			void this.conclude(key, ok && !stopped);
		} else if (!stopped && !watching) {
			this.announce(this.find(key) ?? session, ok);
		}
		if (ok && !stopped && session.kind === 'task' && session.mode !== 'plan') {
			void this.checkWork(key);
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
			title: ok ? (s.kind === 'ask' ? 'Answer ready' : s.kind === 'investigate' ? (s.investigation?.report?.found ? 'Cause found' : 'Investigation finished') : 'Agent finished') + where : `${s.kind === 'investigate' ? 'Investigation' : 'Agent'} failed${where}`,
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
		this.replaying.set(null);
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
			investigation: null,
			check: null,
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

	// ---- images with a message ---------------------------------------------

	/** Put images in a session's composer: pasted, dropped or picked. Each is made ready (smaller, if it must be) first. */
	async attach(id: string, files: Blob[]): Promise<void> {
		const room = MAX_IMAGES - (this.attached()[id]?.length ?? 0) - (this.attaching()[id] ?? 0);
		if (files.length > room) {
			this.toast.info(`A message takes ${MAX_IMAGES} images at most`, room > 0 ? `Only the first ${room === 1 ? 'one was' : `${room} were`} added.` : 'Send these first.');
		}
		const taken = files.slice(0, Math.max(0, room));
		if (!taken.length) {
			return;
		}
		const count = (by: number): void => this.attaching.set({ ...this.attaching(), [id]: Math.max(0, (this.attaching()[id] ?? 0) + by) });
		count(taken.length);
		for (const file of taken) {
			try {
				const image = await prepareImage(file);
				this.attached.set({ ...this.attached(), [id]: [...(this.attached()[id] ?? []), image] });
			} catch (e) {
				this.toast.error('That image was not added', e instanceof Error ? e.message : asAppError(e).message);
			}
			count(-1);
		}
	}

	/** Image files dropped on the window from outside, by path: the native side reads them. */
	async attachFiles(id: string, paths: string[]): Promise<void> {
		const files: Blob[] = [];
		for (const path of paths) {
			try {
				const { mediaType, data } = await this.backend.agentImageFile(path);
				files.push(await (await fetch(`data:${mediaType};base64,${data}`)).blob());
			} catch (e) {
				this.toast.error('That file was not added', asAppError(e).message);
			}
		}
		await this.attach(id, files);
	}

	detach(id: string, name: string): void {
		this.attached.set({ ...this.attached(), [id]: (this.attached()[id] ?? []).filter((a) => a.name !== name) });
	}

	/** Hand over what is in a session's composer, which is then empty. */
	takeAttached(id: string): Attachment[] {
		const images = this.attached()[id] ?? [];
		if (images.length) {
			this.attached.set({ ...this.attached(), [id]: [] });
		}
		return images;
	}

	/**
	 * An image of a transcript as an address for an `<img>`: null while it is being read, '' when its
	 * file is gone. Only the session on screen is kept: asking for another session's lets the last one's go.
	 */
	shot(id: string, name: string): string | null {
		this._shotsSeen();
		if (this._shotsOf !== id) {
			this._shotsOf = id;
			this._shots.clear();
		}
		const known = this._shots.get(name);
		if (known !== undefined) {
			return known;
		}
		const key = `${id}/${name}`;
		if (!this._shotsLoading.has(key)) {
			this._shotsLoading.add(key);
			const type = Object.keys(IMAGE_TYPES).find((t) => name.endsWith(`.${IMAGE_TYPES[t]}`)) ?? 'image/png';
			void this.backend
				.agentImageRead(id, name)
				.then(
					(data) => `data:${type};base64,${data}`,
					() => ''
				)
				.then((url) => {
					this._shotsLoading.delete(key);
					if (this._shotsOf === id) {
						this._shots.set(name, url);
						this._shotsSeen.set(this._shotsSeen() + 1);
					}
				});
		}
		return null;
	}

	/**
	 * Run another turn in an existing session. `shown` is what the transcript says was sent, when that is not
	 * the prompt itself; `raw` sends the prompt as it is (an investigation otherwise wraps a follow-up in its rules).
	 * `images` go with the message: they are saved in the session's folder first, and the native side reads them there.
	 */
	async send(id: string, prompt: string, options: { shown?: string; raw?: boolean; images?: Attachment[] } = {}): Promise<void> {
		const session = this.find(id);
		const text = prompt.trim();
		const images = options.images ?? [];
		if (!session || (!text && !images.length) || session.status === 'running') {
			return;
		}
		await this.listen();
		const names = images.map((a) => a.name);
		const sent: AgentItem = { kind: 'user', text: options.shown ?? text, ...(names.length ? { images: names } : {}) };
		// What the language servers said is about the files as they were; the turn changes them.
		this.update(id, (s) => ({ ...s, status: 'running', stopped: false, unread: false, check: null, items: [...s.items, sent] }));
		this._live.add(id);
		try {
			for (const image of images) {
				await this.backend.agentImageSave(id, image.name, image.data);
				if (this._shotsOf === id) {
					this._shots.set(image.name, image.url); // on screen already: no need to read it back
				}
			}
			if (session.kind === 'investigate') {
				const i = session.investigation;
				// Claude may run and record again, so the report it gave before does not stand until it answers.
				this.patch(id, { ended: null, approval: null });
				const wire = options.raw || !session.sessionId ? text : investigateFollowUp(text);
				await this.backend.agentStart(session.repoId, session.cwd, id, wire, 'acceptEdits', session.sessionId, { tools: INVESTIGATE_RULES, builtin: INVESTIGATE_BUILTIN, investigate: { target: i?.targetId ?? null }, images: names });
			} else if (session.kind === 'ask') {
				const rules = session.tools ?? ASK_TOOLS.code;
				// The rules of the session go in once; after that Claude Code's own session remembers them.
				const wire = session.sessionId ? text : askPrompt(scopeOf(session), text);
				await this.backend.agentStart(session.repoId, session.cwd, id, wire, 'default', session.sessionId, { tools: rules, builtin: toolNames(rules), lean: true, images: names });
			} else {
				await this.backend.agentStart(session.repoId, session.cwd, id, text, session.mode, session.sessionId, names.length ? { images: names } : null);
			}
		} catch (e) {
			this.update(id, (s) => ({ ...s, status: 'failed', items: [...s.items, { kind: 'error', text: asAppError(e).message }] }));
			this.settle(id);
		}
	}

	async stop(id: string): Promise<void> {
		this.update(id, (s) => ({ ...s, status: 'idle', stopped: true, items: [...s.items, { kind: 'error', text: 'Stopped.' }] }));
		this.patch(id, { approval: null, checking: false });
		await this.backend.agentStop(id).catch(() => undefined);
	}

	setMode(id: string, mode: AgentMode): void {
		this.update(id, (s) => ({ ...s, mode }), false);
	}

	/** Point the whole app at a checkout (null for the main one) and open a tab on it. */
	async view(path: string | null, tab: 'changes' | 'agents' | 'files' = 'changes'): Promise<void> {
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
		// Looking is not finishing: work in a worktree of its own waits until it is merged or marked done
		// (`settleReviews`). In the user's own checkout there is no such step, so having looked is all there is.
		this.update(session.id, (s) => ({ ...s, review: s.review && s.isolated, unread: false }), false);
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
		if (session.kind === 'investigate') {
			// The app it started must be gone before its worktree can be.
			const tab = this.find(session.id)?.investigation?.tab;
			if (tab) {
				Injector.get(TerminalStore).close(tab);
			}
			await this.backend.investigateClose(session.id).catch(() => undefined);
			if (this.replaying() === session.id) {
				this.replaying.set(null);
			}
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

	// ---- investigations ---------------------------------------------------------

	private patch(id: string, change: Partial<Investigation>, touch = false): void {
		this.update(id, (s) => (s.investigation ? { ...s, investigation: { ...s.investigation, ...change } } : s), touch);
	}

	/** Show the box for describing a bug to investigate, with terminal output (the selection, usually) to go with it. */
	openInvestigate(output = ''): void {
		this.investigateDraft.set({ output: output.trim().slice(0, 8000) });
		Injector.get(DialogService).open('investigate-start' as Parameters<DialogService['open']>[0]);
	}

	/** A branch name nothing uses yet: `investigate/x`, `investigate/x-2`, ... */
	private freeBranch(wanted: string, trees: Worktree[]): string {
		const taken = new Set([...this.repos.branches().filter((b) => !b.isRemote).map((b) => b.name), ...trees.map((w) => w.branch ?? '')]);
		for (let n = 1; n < 50; n++) {
			const name = n === 1 ? wanted : `${wanted}-${n}`;
			if (!taken.has(name)) {
				return name;
			}
		}
		return `${wanted}-${Date.now().toString(36)}`;
	}

	/**
	 * Start an investigation: a worktree on `investigate/<what>` from the commit the checkout on screen is at,
	 * and a session there whose first message carries the failure, the rules and the recording format.
	 * The user's own checkout is not touched.
	 */
	async investigate(request: InvestigateRequest): Promise<boolean> {
		const repo = this.repos.repo();
		const error = request.error;
		const summary = (error?.summary || plainSummary(request.description, 120) || plainSummary(error?.text ?? '', 120)).trim();
		if (!repo || !summary || this.busy()) {
			return false;
		}
		if (this.cli() === null) {
			this.toast.error('Claude Code was not found', 'Install it and make sure `claude` runs in a terminal, then try again.');
			return false;
		}
		this.busy.set(true);
		try {
			await this.listen();
			const [targets, before] = await Promise.all([this.backend.targets(repo.id).catch(() => [] as RunTarget[]), this.backend.worktrees(repo.id).catch(() => [] as Worktree[])]);
			await this.repos.loadBranches();
			// "NullReferenceException in ApplyDiscount" when the crash names a function; compiler-made names (`<anonymous>`) say nothing.
			const fn = error?.frames?.[0]?.fn?.split(/[.:]+/).pop() ?? '';
			const named = error?.type && /^[\w$]+$/.test(fn) ? `${error.type} in ${fn}` : error?.type && error.message ? `${error.type} ${error.message}` : summary;
			const branch = this.freeBranch(investigateBranch(named), before);
			// From the commit on screen, so the code Claude reads is the code that failed.
			const cwd = await this.backend.addWorktree(repo.id, branch, this.repos.status()?.head ?? null);
			const base = (await this.backend.worktrees(repo.id).catch(() => [] as Worktree[])).find((w) => samePath(w.path, cwd))?.head ?? null;
			const target = request.target;
			const project = target?.group.split(' · ')[0] ?? '';
			const investigation: Investigation = {
				summary,
				description: request.description.trim(),
				targetId: target?.id ?? null,
				targetName: target ? (project === target.source || project === target.name ? target.name : `${project} · ${target.name}`) : null,
				port: null,
				step: 0,
				details: {},
				thinking: '',
				approval: null,
				runs: 0,
				started: Date.now(),
				ended: null,
				report: null,
				leftover: [],
				cleanups: 0,
				checking: false,
				tab: null,
			};
			const session = this.newSession(repo.id, summary, cwd, branch, { kind: 'investigate', isolated: true, mode: 'acceptEdits', base, investigation });
			this.save([...this.sessions(), session]);
			this.repos.setTab('agents');
			this.select(session.id);
			const prompt = investigatePrompt({
				description: request.description,
				summary: error?.summary ?? '',
				output: error?.text ?? '',
				frames: (error?.frames ?? []).slice(0, 12).map((f) => `${f.file}:${f.line}${f.fn ? ` ${f.fn}` : ''}`),
				command: request.command,
				exitCode: request.exitCode,
				targetId: target?.id ?? null,
				targets: targets.map((t) => ({ id: t.id, kind: t.kind, command: t.argv.join(' '), cwd: t.cwd })),
				runtime: target?.runtime ?? (error?.runtime && error.runtime !== 'unknown' ? error.runtime : null),
				branch,
			});
			await this.send(session.id, prompt, { shown: `Investigate: ${request.description.trim() || summary}`, raw: true });
			await this.loadWorktrees();
			await this.repos.loadBranches();
			return this.find(session.id)?.status !== 'failed';
		} catch (e) {
			this.fail(e);
			return false;
		} finally {
			this.busy.set(false);
		}
	}

	private onProgress({ key, step, detail, thinking }: InvestigateProgress): void {
		const i = this.find(key)?.investigation;
		if (!i) {
			return;
		}
		const at = Math.max(1, Math.min(6, Math.round(step) || 1));
		this.patch(key, { step: at, details: detail ? { ...i.details, [String(at)]: detail } : i.details, thinking: thinking ?? i.thinking }, true);
	}

	/** What "Always allow" is remembered under: the investigation's target, in its repository. */
	private allowKey(s: AgentSession): string {
		return s.investigation?.targetName ?? '';
	}

	alwaysAllowed(s: AgentSession): boolean {
		return (this._allowed()[s.repoId] ?? []).includes(this.allowKey(s));
	}

	private onApproval(approval: InvestigateApproval): void {
		const s = this.find(approval.key);
		if (!s?.investigation) {
			// Not a session of ours any more: nothing runs for it.
			void this.backend.investigateAnswer(approval.request, false).catch(() => undefined);
			return;
		}
		this.patch(approval.key, { approval }, true);
		if (this.alwaysAllowed(s)) {
			void this.allow(s.id);
			return;
		}
		if (!this.watching(s)) {
			this.update(s.id, (x) => ({ ...x, unread: true }), false);
			const repo = this.repos.app()?.repos.find((r) => r.id === s.repoId);
			this.toast.show({ variant: 'info', title: `Claude is waiting for your OK${repo && repo.id !== this.repos.repo()?.id ? ` · ${repo.name}` : ''}`, message: s.title, duration: 9000 });
		}
	}

	/** Allow what the investigation asked to run. With `always`, everything it asks for this target from now on, too. */
	async allow(id: string, always = false): Promise<void> {
		const s = this.find(id);
		const approval = s?.investigation?.approval;
		if (!s || !approval) {
			return;
		}
		if (always && !this.alwaysAllowed(s)) {
			const next = { ...this._allowed(), [s.repoId]: [...(this._allowed()[s.repoId] ?? []), this.allowKey(s)] };
			this._allowed.set(next);
			try {
				localStorage.setItem(ALLOW_KEY, JSON.stringify(next));
			} catch {
				/* it will ask again next time */
			}
		}
		this.patch(id, { approval: null });
		try {
			if (approval.tool === 'http_request') {
				await this.backend.investigateAnswer(approval.request, true);
				return;
			}
			// It runs on a pty of its own, shown as a tab of the terminal panel so its output can be watched.
			const terminals = Injector.get(TerminalStore);
			const old = s.investigation?.tab;
			if (old) {
				terminals.close(old);
			}
			const what = approval.project ?? approval.target ?? (approval.tool === 'run_tests' ? 'tests' : 'app');
			let port: number | null = null;
			const tab = await terminals.addProgram({
				repoId: s.repoId,
				title: `Investigation · ${what}${approval.port ? ` :${approval.port}` : ''}`,
				cwd: s.cwd,
				kind: 'investigation',
				reveal: true,
				open: async (cols, rows) => {
					const started: InvestigateStarted = await this.backend.investigateStart(approval.request, cols, rows);
					port = started.port;
					return { key: started.key, command: started.command };
				},
			});
			const now = this.find(id)?.investigation;
			this.patch(id, { tab, port: port ?? now?.port ?? null, runs: (now?.runs ?? 0) + 1 });
		} catch (e) {
			this.fail(e);
			// Claude is told, rather than left waiting for a run that never started.
			void this.backend.investigateAnswer(approval.request, false).catch(() => undefined);
		}
	}

	/** "Don't run": Claude is told no and carries on without it. */
	async deny(id: string): Promise<void> {
		const approval = this.find(id)?.investigation?.approval;
		if (approval) {
			this.patch(id, { approval: null });
			await this.backend.investigateAnswer(approval.request, false).catch(() => undefined);
		}
	}

	/**
	 * An investigation's turn has ended: read its report, then check its worktree for recording that is still
	 * there. If any is, Claude is sent back to remove it (twice at most); the fix is never offered with recording in it.
	 */
	private async conclude(id: string, ok: boolean): Promise<void> {
		const session = this.find(id);
		if (!session?.investigation) {
			return;
		}
		if (!ok) {
			this.patch(id, { approval: null, checking: false, ended: Date.now() });
			return;
		}
		let answer = '';
		for (let i = session.items.length - 1; i >= 0 && session.items[i].kind !== 'user'; i--) {
			if (session.items[i].kind === 'text') {
				answer = session.items[i].text;
				break;
			}
		}
		const report = (answer && parseInvestigation(answer)) || session.investigation.report;
		this.patch(id, { approval: null, checking: true, report });
		let leftover: string[] = [];
		try {
			leftover = leftoverRecording((await this.changes(session)).files);
		} catch {
			/* the worktree is gone or unreadable: there is nothing to offer either way */
		}
		const now = this.find(id);
		if (!now?.investigation || now.status === 'running') {
			return;
		}
		if (leftover.length && now.investigation.cleanups < MAX_CLEANUPS) {
			this.patch(id, { checking: false, leftover, cleanups: now.investigation.cleanups + 1 });
			await this.send(id, investigateCleanup(leftover), { shown: 'The recording is still in the code. Asked Claude to remove it before the fix is shown.', raw: true });
			return;
		}
		this.patch(id, { checking: false, leftover, ended: Date.now() }, true);
		const done = this.find(id);
		if (done && !this.watching(done)) {
			this.update(id, (s) => ({ ...s, unread: true }), false);
			this.announce(done, true);
		}
		if (session.repoId === this.repos.repo()?.id) {
			void this.loadWorktrees();
		}
	}

	/**
	 * Accept fix, first half: commit what the investigation changed, in its worktree, as the user and with
	 * their message. (The second half is the ordinary merge.) Refused on the native side while recording is left.
	 */
	async commitFix(session: AgentSession, summary: string, description = ''): Promise<boolean> {
		try {
			await this.backend.investigateCommit(session.repoId, session.cwd, summary, description);
			await this.loadWorktrees();
			return true;
		} catch (e) {
			this.fail(e);
			return false;
		}
	}

	/** Discard: the investigation, its worktree and its branch all go. Nothing of it ever reached the user's checkout. */
	async discard(session: AgentSession): Promise<void> {
		await this.remove(session, true);
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

	// ---- the language servers' look at a task's changes -------------------------------

	/** Settings: look at an agent's changed files with the language servers when its turn ends. */
	readonly checksOn = signal(readCheckSetting());

	setChecks(on: boolean): void {
		this.checksOn.set(on);
		try {
			localStorage.setItem(CHECK_KEY, on ? 'on' : 'off');
		} catch {
			/* private mode: it holds for this run */
		}
	}

	private readonly _checkRuns = new Map<string, number>();

	/**
	 * A task's turn has ended: ask the language servers installed for the files it changed, in its own
	 * checkout, which errors are new since the commit it started from and where what it touched is used.
	 * Nothing is sent to the agent by this; `fixProblems` does that, on a click.
	 */
	async checkWork(id: string): Promise<void> {
		const session = this.find(id);
		if (!session || session.kind !== 'task' || !this.checksOn()) {
			return;
		}
		const run = (this._checkRuns.get(id) ?? 0) + 1;
		this._checkRuns.set(id, run);
		// Another turn has started, or a later check has: this one's answer is about files that have moved on.
		const stale = (): boolean => this._checkRuns.get(id) !== run || this.find(id)?.status === 'running';
		try {
			const diff = await this.changes(session);
			// A server already running in that checkout may not watch the disk itself: these are the files that moved.
			Injector.get(LspService).changed(session.cwd, changesSince(diff.files));
			const changed = diff.files.filter((f) => languageOf(f.path) !== null).slice(0, MAX_CHECKED);
			if (!changed.length || stale()) {
				return;
			}
			this.update(id, (s) => ({ ...s, check: { state: 'checking', problems: [], known: 0, impact: [], servers: [], files: 0, users: 0, finished: true } }), false);
			const result = await Injector.get(LspService).check(session.repoId, session.cwd, changed, diff.base);
			if (stale()) {
				return;
			}
			// No server installed for any of them: there is nothing to say.
			this.update(id, (s) => ({ ...s, check: result.servers.length ? { state: 'done', ...result } : null }), false);
		} catch {
			// The worktree is gone, or a server would not start (which it has said itself).
			if (!stale()) {
				this.update(id, (s) => ({ ...s, check: null }), false);
			}
		}
	}

	/** Hand the errors the language servers found back to the agent, as its next turn. */
	async fixProblems(id: string): Promise<void> {
		const found = this.find(id)?.check?.problems ?? [];
		if (found.length) {
			await this.send(id, fixProblemsPrompt(found), { shown: `Asked Claude to fix the ${found.length === 1 ? 'error' : `${found.length} errors`} its change brought, as the language server reports ${found.length === 1 ? 'it' : 'them'}.` });
		}
	}

	/** Open a place the check names: the session's checkout becomes the active one, on the Files tab. */
	async openPlace(session: AgentSession, path: string, line: number, column = 1): Promise<void> {
		if (!(await this.showRepo(session))) {
			return;
		}
		await this.view(session.isolated ? session.cwd : null, 'files');
		await Injector.get(ExplorerStore).openAt(path, line, column);
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
		Injector.get(WorkspaceStore).revealMain();
		this.commitShown.set(this.commitShown() + 1);
		return true;
	}
}
