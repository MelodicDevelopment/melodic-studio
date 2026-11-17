/**
 * Every call into the native side goes through here. In a plain browser
 * (`npm run dev` outside Tauri) the app runs against a small in-memory demo
 * so the UI stays previewable.
 */
import { Injectable } from '@melodicdev/core/injection';
import { demoListDir, demoReadFile, demoWriteFile } from './demo-files';

export function isDesktop(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isMac(): boolean {
	return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
}

export interface RepoSummary {
	id: string;
	name: string;
	path: string;
	missing: boolean;
	/** Set while the app is looking at a linked worktree instead of the main checkout. */
	worktree?: string | null;
}
/** One checkout of the repository: the main one, or a linked worktree on its own branch. */
export interface Worktree {
	path: string;
	branch: string | null;
	head: string;
	isMain: boolean;
	active: boolean;
	changes: number;
}
/** Claude Code permission modes an agent can run in. */
export type AgentMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
/** Extras for one Claude Code turn; see RunOptions in src-tauri/src/agent.rs. */
export interface AgentRunOptions {
	/** Permission rules to pre-approve, e.g. `Read`, `Bash(git log:*)`. An empty list means no tools. */
	tools?: string[];
	model?: string;
	/** One-shot question: starts fast (no MCP servers or skills) and keeps no session. */
	quick?: boolean;
}
/** One line of Claude Code's stream-json output, for the session named `key`. */
export interface AgentEvent {
	key: string;
	event: Record<string, unknown>;
}
export interface AgentDone {
	key: string;
	ok: boolean;
	error: string;
}
export interface AppStatus {
	repos: RepoSummary[];
	current: string | null;
	gitVersion: string | null;
	authorName: string;
	authorEmail: string;
	editor: string;
	appVersion: string;
}
export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';
export interface FileChange {
	path: string;
	oldPath: string | null;
	status: FileStatus;
}
/** The hosting service behind the remote, recognised from its URL. */
export interface Host {
	provider: 'github' | 'azure' | 'gitlab' | 'bitbucket' | 'other';
	name: string;
	web: string;
	issues: string | null;
	issuesLabel: string;
	pulls: string | null;
	pullsLabel: string;
}
export interface Stash {
	name: string;
	message: string;
	date: string;
}
export type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';
export interface RepoStatus {
	branch: string;
	detached: boolean;
	hasCommits: boolean;
	head: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	remote: string | null;
	remoteUrl: string | null;
	host: Host | null;
	files: FileChange[];
	mergeInProgress: boolean;
	rebaseInProgress: boolean;
	operation: Operation | null;
	stashes: Stash[];
	lastFetched: number | null;
	undo: { hash: string; summary: string; description: string } | null;
}
export interface Commit {
	hash: string;
	shortHash: string;
	authorName: string;
	authorEmail: string;
	date: string;
	parents: string[];
	refs: string[];
	summary: string;
	body: string;
	unpushed: boolean;
}
export interface Branch {
	name: string;
	isRemote: boolean;
	isCurrent: boolean;
	upstream: string | null;
	date: string;
}
export interface DiffResult {
	text: string;
	tooLarge: boolean;
}
export interface UndoneCommit {
	summary: string;
	description: string;
}
/** One row of the Files tab. `path` is repository-relative, `/` separated. */
export interface TreeEntry {
	name: string;
	path: string;
	isDir: boolean;
	ignored: boolean;
}
export interface FileContent {
	text: string;
	binary: boolean;
	tooLarge: boolean;
	size: number;
}
export type OpenTarget = 'finder' | 'editor' | 'terminal' | 'remote' | 'issues' | 'pulls' | 'new-pull' | 'commit' | 'branch';
export type ResetMode = 'soft' | 'mixed' | 'hard';
export interface AppError {
	kind: 'conflict' | 'auth' | 'git' | 'error';
	message: string;
	paths?: string[];
}

export function asAppError(e: unknown): AppError {
	if (e && typeof e === 'object' && 'kind' in e && 'message' in e) {
		return e as AppError;
	}
	return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
}

@Injectable()
export class BackendService {
	private _invoke: (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>) | null = null;
	private readonly _demo = new DemoBackend();

	async call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
		if (!isDesktop()) {
			return this._demo.call<T>(cmd, args);
		}
		if (!this._invoke) {
			const core = await import('@tauri-apps/api/core');
			this._invoke = core.invoke;
		}
		return this._invoke<T>(cmd, args);
	}

	// ---- typed surface -----------------------------------------------------
	appStatus() { return this.call<AppStatus>('app_status'); }
	addRepo(path: string) { return this.call<RepoSummary>('repo_add', { path }); }
	createRepo(parent: string, name: string, readme: boolean) { return this.call<RepoSummary>('repo_create', { parent, name, readme }); }
	cloneRepo(url: string, parent: string) { return this.call<RepoSummary>('repo_clone', { url, parent }); }
	removeRepo(id: string) { return this.call<void>('repo_remove', { id }); }
	selectRepo(id: string) { return this.call<void>('repo_select', { id }); }
	status(id: string) { return this.call<RepoStatus>('repo_status', { id }); }
	fileDiff(id: string, file: FileChange) { return this.call<DiffResult>('file_diff', { id, path: file.path, oldPath: file.oldPath, status: file.status }); }
	commit(id: string, paths: string[], summary: string, description: string, amend: boolean) { return this.call<void>('commit_changes', { id, paths, summary, description, amend }); }
	resolveFile(id: string, path: string, side: 'mine' | 'theirs') { return this.call<void>('resolve_file', { id, path, side }); }
	ignoreFile(id: string, path: string) { return this.call<void>('ignore_file', { id, path }); }
	stashSave(id: string, message: string) { return this.call<void>('stash_save', { id, message }); }
	stashPop(id: string, name: string) { return this.call<void>('stash_pop', { id, name }); }
	stashDrop(id: string, name: string) { return this.call<void>('stash_drop', { id, name }); }
	opContinue(id: string) { return this.call<void>('op_continue', { id }); }
	opAbort(id: string) { return this.call<void>('op_abort', { id }); }
	revertCommit(id: string, hash: string) { return this.call<void>('revert_commit', { id, hash }); }
	cherryPick(id: string, hash: string) { return this.call<void>('cherry_pick', { id, hash }); }
	resetTo(id: string, hash: string, mode: ResetMode) { return this.call<void>('reset_to', { id, hash, mode }); }
	checkoutCommit(id: string, hash: string) { return this.call<void>('checkout_commit', { id, hash }); }
	createTag(id: string, name: string, hash: string, push: boolean) { return this.call<void>('tag_create', { id, name, hash, push }); }
	deleteTag(id: string, name: string) { return this.call<void>('tag_delete', { id, name }); }
	rebaseOnto(id: string, onto: string) { return this.call<void>('rebase_onto', { id, onto }); }
	deleteRemoteBranch(id: string, name: string) { return this.call<void>('branch_delete_remote', { id, name }); }
	discard(id: string, files: FileChange[]) { return this.call<void>('discard_changes', { id, files: files.map((f) => ({ path: f.path, oldPath: f.oldPath })) }); }
	undoCommit(id: string) { return this.call<UndoneCommit>('undo_commit', { id }); }
	history(id: string, skip: number, limit: number) { return this.call<Commit[]>('history', { id, skip, limit }); }
	commitFiles(id: string, hash: string) { return this.call<FileChange[]>('commit_files', { id, hash }); }
	commitDiff(id: string, hash: string, file: FileChange) { return this.call<DiffResult>('commit_diff', { id, hash, path: file.path, oldPath: file.oldPath }); }
	branches(id: string) { return this.call<Branch[]>('branches', { id }); }
	createBranch(id: string, name: string, start: string | null) { return this.call<void>('branch_create', { id, name, start }); }
	checkout(id: string, name: string, isRemote: boolean) { return this.call<void>('branch_checkout', { id, name, isRemote }); }
	deleteBranch(id: string, name: string, force: boolean) { return this.call<void>('branch_delete', { id, name, force }); }
	renameBranch(id: string, from: string, to: string) { return this.call<void>('branch_rename', { id, from, to }); }
	merge(id: string, from: string) { return this.call<string>('merge_branch', { id, from }); }
	fetch(id: string) { return this.call<void>('fetch', { id }); }
	pull(id: string) { return this.call<void>('pull', { id }); }
	push(id: string, force = false) { return this.call<void>('push', { id, force }); }
	setRemote(id: string, url: string) { return this.call<void>('remote_set', { id, url }); }
	openIn(id: string, target: OpenTarget, arg: string | null = null) { return this.call<void>('open_in', { id, target, arg }); }
	setEditor(editor: string) { return this.call<void>('set_editor', { editor }); }
	pickFolder() { return this.call<string | null>('pick_folder'); }
	worktrees(id: string) { return this.call<Worktree[]>('worktree_list', { id }); }
	addWorktree(id: string, branch: string, base: string | null) { return this.call<string>('worktree_add', { id, branch, base }); }
	selectWorktree(id: string, path: string | null) { return this.call<void>('worktree_select', { id, path }); }
	removeWorktree(id: string, path: string, force: boolean, deleteBranch: boolean) { return this.call<void>('worktree_remove', { id, path, force, deleteBranch }); }
	agentAvailable() { return this.call<string | null>('agent_available'); }
	agentStart(id: string, cwd: string, key: string, prompt: string, mode: AgentMode, resume: string | null, options: AgentRunOptions | null = null) { return this.call<void>('agent_start', { id, cwd, key, prompt, mode, resume, options }); }
	agentStop(key: string) { return this.call<void>('agent_stop', { key }); }
	/** Null when no server for that language is installed (and always in the browser preview). */
	async lspStart(id: string, language: string) { return (await this.call<{ key: string; root: string; fresh: boolean } | null | undefined>('lsp_start', { id, language })) ?? null; }
	lspSend(key: string, message: unknown) { return this.call<void>('lsp_send', { key, message }); }
	lspStop(key: string) { return this.call<void>('lsp_stop', { key }); }

	/** Subscribe to an event the native side emits. Resolves to an unsubscribe function. */
	async listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
		if (!isDesktop()) {
			return this._demo.listen(event, handler as (payload: unknown) => void);
		}
		const { listen } = await import('@tauri-apps/api/event');
		return listen<T>(event, (e) => handler(e.payload));
	}
	listDir(id: string, path: string) { return this.call<TreeEntry[]>('list_dir', { id, path }); }
	readFile(id: string, path: string) { return this.call<FileContent>('read_file', { id, path }); }
	/** `root` is the checkout the text was read from; the save is refused if another one is active by now. */
	writeFile(id: string, path: string, text: string, root: string) { return this.call<void>('write_file', { id, path, text, root }); }
}

// ---- browser-only stand-in --------------------------------------------------

const DEMO_ID = '/Users/demo/Source/harmony';

const DEMO_DIFFS: Record<string, string> = {
	'src/player/queue.ts': `diff --git a/src/player/queue.ts b/src/player/queue.ts
index 3f1c2aa..9be01d4 100644
--- a/src/player/queue.ts
+++ b/src/player/queue.ts
@@ -12,9 +12,14 @@ export class Queue {
 	private _items: Track[] = [];
 	private _cursor = 0;

-	next(): Track | null {
-		this._cursor++;
-		return this._items[this._cursor] ?? null;
+	/** Advance and return the next track, wrapping when repeat is on. */
+	next(repeat = false): Track | null {
+		if (this._cursor + 1 >= this._items.length) {
+			if (!repeat) {
+				return null;
+			}
+			this._cursor = -1;
+		}
+		return this._items[++this._cursor] ?? null;
 	}

 	previous(): Track | null {
@@ -40,4 +45,8 @@ export class Queue {
 	clear(): void {
 		this._items = [];
 	}
+
+	get length(): number {
+		return this._items.length;
+	}
 }
`,
	'src/player/repeat.ts': `diff --git a/src/player/repeat.ts b/src/player/repeat.ts
new file mode 100644
index 0000000..5a2c7de
--- /dev/null
+++ b/src/player/repeat.ts
@@ -0,0 +1,7 @@
+export type RepeatMode = 'off' | 'all' | 'one';
+
+const ORDER: RepeatMode[] = ['off', 'all', 'one'];
+
+export function nextRepeatMode(mode: RepeatMode): RepeatMode {
+	return ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
+}
`,
	'docs/old-notes.md': `diff --git a/docs/old-notes.md b/docs/old-notes.md
deleted file mode 100644
index 77aa1b0..0000000
--- a/docs/old-notes.md
+++ /dev/null
@@ -1,3 +0,0 @@
-# Notes
-
-Remember to wire up repeat.
`,
	'public/cover.png': `diff --git a/public/cover.png b/public/cover.png
index 1b2c3d4..5e6f7a8 100644
Binary files a/public/cover.png and b/public/cover.png differ
`,
};

function demoCommit(n: number, summary: string, minutesAgo: number, extra: Partial<Commit> = {}): Commit {
	const hash = (n.toString(16).padStart(4, '0') + 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678').slice(0, 40);
	return {
		hash,
		shortHash: hash.slice(0, 7),
		authorName: 'Demo Author',
		authorEmail: 'demo@example.com',
		date: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
		parents: [],
		refs: [],
		summary,
		body: '',
		unpushed: false,
		...extra,
	};
}

/**
 * What the demo "AI" says to a one-shot question. Each AI feature tags its prompt with a
 * first line like `[commit-message]`; add a case here so the browser preview shows something real.
 */
function demoAnswer(prompt: string): string {
	const tag = /^\[([a-z-]+)\]/.exec(prompt)?.[1] ?? '';
	switch (tag) {
		default:
			return 'This is the browser preview, so there is no Claude here. In the desktop app the answer appears in this spot.';
	}
}

/** Nothing persists; enough behaviour to click through every screen. */
class DemoBackend {
	private repos: RepoSummary[] = [
		{ id: DEMO_ID, name: 'harmony', path: DEMO_ID, missing: false },
		{ id: '/Users/demo/Source/cadence', name: 'cadence', path: '/Users/demo/Source/cadence', missing: false },
	];
	private current: string | null = DEMO_ID;
	private editor = 'code';
	private branch = 'feature/repeat-mode';
	private branchList: Branch[] = [
		{ name: 'feature/repeat-mode', isRemote: false, isCurrent: true, upstream: 'origin/feature/repeat-mode', date: new Date(Date.now() - 3_600_000).toISOString() },
		{ name: 'main', isRemote: false, isCurrent: false, upstream: 'origin/main', date: new Date(Date.now() - 86_400_000).toISOString() },
		{ name: 'fix/seek-drift', isRemote: false, isCurrent: false, upstream: null, date: new Date(Date.now() - 4 * 86_400_000).toISOString() },
		{ name: 'origin/main', isRemote: true, isCurrent: false, upstream: null, date: new Date(Date.now() - 86_400_000).toISOString() },
		{ name: 'origin/feature/repeat-mode', isRemote: true, isCurrent: false, upstream: null, date: new Date(Date.now() - 7_200_000).toISOString() },
		{ name: 'origin/release/1.4', isRemote: true, isCurrent: false, upstream: null, date: new Date(Date.now() - 9 * 86_400_000).toISOString() },
	];
	private files: FileChange[] = [
		{ path: 'docs/old-notes.md', oldPath: null, status: 'deleted' },
		{ path: 'public/cover.png', oldPath: null, status: 'modified' },
		{ path: 'src/player/queue.ts', oldPath: null, status: 'modified' },
		{ path: 'src/player/repeat.ts', oldPath: null, status: 'untracked' },
	];
	private commits: Commit[] = [
		demoCommit(6, 'Wrap the queue when repeat is on', 55, { unpushed: true, refs: ['HEAD -> feature/repeat-mode'], body: 'The cursor resets instead of running off the end.' }),
		demoCommit(5, 'Add a repeat toggle to the transport bar', 180, { refs: ['origin/feature/repeat-mode'] }),
		demoCommit(4, 'Fix seek drift after a long pause', 1500, { refs: ['origin/main', 'main'] }),
		demoCommit(3, 'Persist volume between sessions', 3000, { refs: ['tag: v1.3.0'] }),
		demoCommit(2, 'Queue: keyboard reordering', 7000),
		demoCommit(1, 'Initial commit', 20000),
	];
	private ahead = 1;
	private behind = 0;
	private lastFetched = Date.now() - 12 * 60_000;
	private stashes: Stash[] = [];
	private stashed: FileChange[] = [];

	private worktreeList: Worktree[] = [{ path: DEMO_ID, branch: 'feature/repeat-mode', head: 'a'.repeat(40), isMain: true, active: true, changes: 4 }];
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

	listen(event: string, handler: (payload: unknown) => void): () => void {
		const set = this.listeners.get(event) ?? new Set();
		set.add(handler);
		this.listeners.set(event, set);
		return () => set.delete(handler);
	}

	private emit(event: string, payload: unknown, delay: number): void {
		setTimeout(() => this.listeners.get(event)?.forEach((h) => h(payload)), delay);
	}

	async call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
		await new Promise((r) => setTimeout(r, cmd === 'fetch' || cmd === 'pull' || cmd === 'push' || cmd === 'repo_clone' ? 700 : 40));
		return this.handle(cmd, args) as T;
	}

	private handle(cmd: string, args: Record<string, unknown>): unknown {
		const empty = this.current !== DEMO_ID;
		switch (cmd) {
			case 'app_status':
				return { repos: this.repos, current: this.current, gitVersion: '2.47.0 (demo)', authorName: 'Demo Author', authorEmail: 'demo@example.com', editor: this.editor, appVersion: '0.1.0' } satisfies AppStatus;
			case 'repo_add':
			case 'repo_create':
			case 'repo_clone': {
				const base = String(args.path ?? args.name ?? args.url ?? 'repository').replace(/\.git$/, '');
				const name = base.split(/[/:]/).filter(Boolean).pop() ?? 'repository';
				const repo = { id: `/Users/demo/Source/${name}`, name, path: `/Users/demo/Source/${name}`, missing: false };
				if (!this.repos.some((r) => r.id === repo.id)) {
					this.repos = [...this.repos, repo];
				}
				this.current = repo.id;
				return repo;
			}
			case 'repo_remove':
				this.repos = this.repos.filter((r) => r.id !== args.id);
				if (this.current === args.id) {
					this.current = this.repos[0]?.id ?? null;
				}
				return;
			case 'repo_select':
				this.current = String(args.id);
				return;
			case 'repo_status':
				return {
					branch: empty ? 'main' : this.branch,
					detached: false,
					hasCommits: true,
					head: empty ? 'e'.repeat(40) : this.commits[0]?.hash ?? null,
					upstream: empty ? null : this.branchList.find((b) => b.isCurrent)?.upstream ?? null,
					ahead: empty ? 0 : this.ahead,
					behind: empty ? 0 : this.behind,
					remote: empty ? null : 'origin',
					remoteUrl: empty ? null : 'git@github.com:demo/harmony.git',
					host: empty
						? null
						: { provider: 'github', name: 'GitHub', web: 'https://github.com/demo/harmony', issues: 'https://github.com/demo/harmony/issues', issuesLabel: 'Issues', pulls: 'https://github.com/demo/harmony/pulls', pullsLabel: 'Pull requests' },
					files: empty ? [] : this.files,
					mergeInProgress: false,
					rebaseInProgress: false,
					operation: null,
					stashes: empty ? [] : this.stashes,
					lastFetched: empty ? null : this.lastFetched,
					undo: !empty && this.commits[0]?.unpushed ? { hash: this.commits[0].hash, summary: this.commits[0].summary, description: this.commits[0].body } : null,
				} satisfies RepoStatus;
			case 'file_diff':
			case 'commit_diff':
				return { text: DEMO_DIFFS[String(args.path)] ?? '', tooLarge: false } satisfies DiffResult;
			case 'commit_changes': {
				const paths = args.paths as string[];
				this.files = this.files.filter((f) => !paths.includes(f.path));
				if (args.amend) {
					this.commits = [{ ...this.commits[0], summary: String(args.summary), body: String(args.description ?? '') }, ...this.commits.slice(1)];
					return;
				}
				this.commits = [demoCommit(this.commits.length + 1, String(args.summary), 0, { unpushed: true, body: String(args.description ?? '') }), ...this.commits];
				this.ahead++;
				return;
			}
			case 'discard_changes': {
				const paths = (args.files as { path: string }[]).map((f) => f.path);
				this.files = this.files.filter((f) => !paths.includes(f.path));
				return;
			}
			case 'ignore_file':
			case 'resolve_file':
				this.files = this.files.filter((f) => f.path !== args.path);
				return;
			case 'stash_save':
				this.stashed = this.files;
				this.files = [];
				this.stashes = [{ name: 'stash@{0}', message: `On ${this.branch}: ${String(args.message) || 'Melodic Studio stash'}`, date: new Date().toISOString() }];
				return;
			case 'stash_pop':
				this.files = this.stashed;
				this.stashes = [];
				return;
			case 'stash_drop':
				this.stashes = [];
				return;
			case 'revert_commit':
				this.commits = [demoCommit(this.commits.length + 1, `Revert "${this.commits.find((c) => c.hash === args.hash)?.summary ?? ''}"`, 0, { unpushed: true }), ...this.commits];
				this.ahead++;
				return;
			case 'reset_to': {
				const at = this.commits.findIndex((c) => c.hash === args.hash);
				this.commits = this.commits.slice(Math.max(0, at));
				this.ahead = this.commits.filter((c) => c.unpushed).length;
				return;
			}
			case 'tag_create':
				this.commits = this.commits.map((c) => (c.hash === args.hash ? { ...c, refs: [...c.refs, `tag: ${String(args.name)}`] } : c));
				return;
			case 'branch_delete_remote':
				this.branchList = this.branchList.filter((b) => b.name !== args.name);
				return;
			case 'undo_commit': {
				const [tip, ...rest] = this.commits;
				this.commits = rest;
				this.ahead = Math.max(0, this.ahead - 1);
				this.files = [{ path: 'src/player/queue.ts', oldPath: null, status: 'modified' }, ...this.files.filter((f) => f.path !== 'src/player/queue.ts')];
				return { summary: tip.summary, description: tip.body } satisfies UndoneCommit;
			}
			case 'history':
				return empty ? [] : this.commits.slice(Number(args.skip ?? 0), Number(args.skip ?? 0) + Number(args.limit ?? 100));
			case 'commit_files':
				return [
					{ path: 'src/player/queue.ts', oldPath: null, status: 'modified' },
					{ path: 'src/player/repeat.ts', oldPath: null, status: 'added' },
				] satisfies FileChange[];
			case 'branches':
				return empty ? [{ name: 'main', isRemote: false, isCurrent: true, upstream: null, date: new Date().toISOString() }] : this.branchList;
			case 'branch_create':
				this.branchList = [{ name: String(args.name), isRemote: false, isCurrent: true, upstream: null, date: new Date().toISOString() }, ...this.branchList.map((b) => ({ ...b, isCurrent: false }))];
				this.branch = String(args.name);
				return;
			case 'branch_checkout': {
				const name = args.isRemote ? String(args.name).replace(/^[^/]+\//, '') : String(args.name);
				if (!this.branchList.some((b) => !b.isRemote && b.name === name)) {
					this.branchList = [{ name, isRemote: false, isCurrent: false, upstream: String(args.name), date: new Date().toISOString() }, ...this.branchList];
				}
				this.branchList = this.branchList.map((b) => ({ ...b, isCurrent: !b.isRemote && b.name === name }));
				this.branch = name;
				return;
			}
			case 'branch_delete':
				this.branchList = this.branchList.filter((b) => b.isRemote || b.name !== args.name);
				return;
			case 'branch_rename':
				this.branchList = this.branchList.map((b) => (!b.isRemote && b.name === args.from ? { ...b, name: String(args.to) } : b));
				if (this.branch === args.from) {
					this.branch = String(args.to);
				}
				return;
			case 'merge_branch':
				this.commits = [demoCommit(this.commits.length + 1, `Merge branch '${String(args.from)}' into ${this.branch}`, 0, { unpushed: true }), ...this.commits];
				this.ahead++;
				return '';
			case 'fetch':
				this.lastFetched = Date.now();
				return;
			case 'pull':
				this.behind = 0;
				this.lastFetched = Date.now();
				return;
			case 'push':
				this.ahead = 0;
				this.commits = this.commits.map((c) => ({ ...c, unpushed: false }));
				this.branchList = this.branchList.map((b) => (b.isCurrent && !b.upstream ? { ...b, upstream: `origin/${b.name}` } : b));
				return;
			case 'set_editor':
				this.editor = String(args.editor);
				return;
			case 'worktree_list':
				return this.worktreeList;
			case 'worktree_add': {
				const path = `${DEMO_ID}.worktrees/${String(args.branch).replace(/[^\w.]+/g, '-')}`;
				this.worktreeList = [...this.worktreeList, { path, branch: String(args.branch), head: 'b'.repeat(40), isMain: false, active: false, changes: 0 }];
				return path;
			}
			case 'worktree_select': {
				const path = (args.path as string | null) ?? DEMO_ID;
				this.worktreeList = this.worktreeList.map((w) => ({ ...w, active: w.path === path }));
				this.repos = this.repos.map((r) => (r.id === args.id ? { ...r, worktree: path === DEMO_ID ? null : path } : r));
				return;
			}
			case 'worktree_remove':
				this.worktreeList = this.worktreeList.filter((w) => w.path !== args.path).map((w) => ({ ...w, active: w.isMain }));
				this.repos = this.repos.map((r) => ({ ...r, worktree: null }));
				return;
			case 'agent_available':
				return '2.1.0 (demo)';
			case 'agent_start': {
				const key = String(args.key);
				const say = (event: Record<string, unknown>, delay: number) => this.emit('agent-event', { key, event }, delay);
				if ((args.options as AgentRunOptions | null)?.quick) {
					// One-shot questions (AiService.ask): features add their own canned answers through demoAnswer().
					const text = demoAnswer(String(args.prompt));
					say({ type: 'assistant', message: { content: [{ type: 'text', text }] } }, 500);
					say({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.001 }, 600);
					this.emit('agent-done', { key, ok: true, error: '' }, 650);
					return;
				}
				say({ type: 'system', subtype: 'init', session_id: 'demo-session' }, 200);
				say({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will look at how the queue advances, then make the change.' }] } }, 700);
				say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/player/queue.ts' } }] } }, 1300);
				say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/player/queue.ts' } }] } }, 2100);
				say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done. The queue now wraps when repeat is on; review the diff in Changes.' }] } }, 2800);
				say({ type: 'result', subtype: 'success', is_error: false, session_id: 'demo-session', total_cost_usd: 0.04 }, 2900);
				this.emit('agent-done', { key, ok: true, error: '' }, 3000);
				return;
			}
			case 'agent_stop':
				return;
			case 'pick_folder':
				return '/Users/demo/Source';
			case 'list_dir':
				return empty ? [] : demoListDir(String(args.path));
			case 'read_file':
				return demoReadFile(String(args.path));
			case 'write_file':
				return demoWriteFile(String(args.path), String(args.text));
			default:
				return;
		}
	}
}
