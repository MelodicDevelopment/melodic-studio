/**
 * Every call into the native side goes through here. In a plain browser
 * (`npm run dev` outside Tauri) the app runs against a small in-memory demo
 * so the UI stays previewable.
 */
import { Injectable } from '@melodicdev/core/injection';
import { demoListDir, demoReadFile, demoWriteFile } from './demo-files';
import { demoTerminal } from './demo-terminal';
import { demoHost, demoPullRequestAnswer } from './demo-host';

export function isDesktop(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function isMac(): boolean {
	return typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
}

export function isWindows(): boolean {
	return typeof navigator !== 'undefined' && /Win(dows|32|64)/i.test(navigator.platform || navigator.userAgent);
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
	/** Starts as fast as `quick`, but keeps the session so later turns can resume it. */
	lean?: boolean;
	/** The only built-in tools Claude can see (`Read`, `Grep`); leave out for the usual set. */
	builtin?: string[];
}
/** One file a checkout changed since a commit, with its own unified diff. */
export interface ChangedFile extends FileChange {
	diff: string;
}
/** Everything a checkout holds that `base` does not: commits since, uncommitted edits, untracked files. */
export interface WorktreeDiff {
	base: string;
	head: string;
	files: ChangedFile[];
	/** Some diffs were left out; the file list is still complete. */
	tooLarge: boolean;
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
	appVersion: string;
}
/** Who commits: git's user.name and user.email at one level of its config. */
export interface Identity {
	name: string;
	email: string;
}
export interface Identities {
	global: Identity;
	/** The repository's own identity, when it overrides the global one. */
	repo: Identity | null;
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
export type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'squash';
export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop';
/** One line of an interactive rebase. `message` replaces the message of the commit a pick/reword starts (with the squash/fixup lines after it). */
export interface RebaseStep {
	hash: string;
	action: RebaseAction;
	message: string | null;
}
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
	/** The remote's default branch (no remote prefix), when known. */
	defaultBranch: string | null;
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
/** How the current branch stands against another: commits only it has (`ahead`) and only the other has (`behind`). */
export interface BranchCompare {
	name: string;
	ahead: number;
	behind: number;
}
export interface DiffResult {
	text: string;
	tooLarge: boolean;
}
export interface UndoneCommit {
	summary: string;
	description: string;
}
/** A diff prepared for a prompt: capped, with a note in `text` wherever something was left out. */
export interface AiDiff {
	text: string;
	truncated: boolean;
	/** Subjects of the latest commits, newest first. */
	recent: string[];
}
/** Everything a push would send: `base`..`head`, measured against `against` (the upstream, or the default branch). */
export interface PushDiff {
	/** The diff with new-file line numbers written in, capped. */
	text: string;
	truncated: boolean;
	base: string;
	head: string;
	against: string;
	commits: { hash: string; summary: string }[];
	files: FileChange[];
}
/** A conflicted file as it sits in the working tree, markers included. */
export interface ConflictFile {
	text: string;
	binary: boolean;
	tooLarge: boolean;
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
/** The command-line tool that serves the remote's host (gh, az, glab) and whether it can be used right now. */
export interface HostCliStatus {
	provider: Host['provider'];
	hostName: string;
	issuesLabel: string;
	pullsLabel: string;
	tool: 'gh' | 'az' | 'glab' | null;
	installed: boolean;
	/** Installed, complete and signed in. */
	signedIn: boolean;
	/** What to install or run when it cannot be used. */
	hint: string | null;
}
/** An issue (GitHub, GitLab) or work item (Azure DevOps). `body` is untrusted text: show it as text, never as HTML. */
export interface HostIssue {
	id: string;
	title: string;
	body: string;
	url: string;
	labels: string[];
	assignee: string | null;
	state: string;
	updated: string;
	/** `issue`, or the work item type (Bug, Task, User Story). */
	kind: string;
}
export interface PrContext {
	/** Empty on a detached HEAD. */
	branch: string;
	base: string;
	bases: string[];
	/** The branch is on the remote under its own name. */
	onRemote: boolean;
	unpushed: number;
}
export interface PrChanges {
	count: number;
	subjects: string[];
	log: string;
	stat: string;
}
export interface PullRequestRef {
	id: string;
	title: string;
	url: string;
}
/** The host's "new pull request" page, and how much of the draft its address carries. */
export interface PrWebUrl {
	url: string;
	title: boolean;
	body: boolean;
}
/** One host's command-line tool, for creating a repository before any exists locally. */
export interface HostCli {
	provider: 'github' | 'azure' | 'gitlab';
	name: string;
	cli: string;
	installed: boolean;
	signedIn: boolean;
	account: string | null;
	hint: string | null;
}
/** Where a new repository can go: an account, organization, group or Azure DevOps project. */
export interface HostOwner {
	id: string;
	label: string;
}
export interface HostRepo {
	webUrl: string;
	remoteUrl: string;
}
/** One row of Settings' "Language servers"; see ServerInfo in src-tauri/src/lsp/servers.rs. */
export interface LanguageServer {
	/** `typescript`, `php`, `csharp`, `rust`: what install and remove take. */
	name: string;
	label: string;
	program: string;
	/** Where the copy that would be started was found; null when there is none. */
	source: 'project' | 'managed' | 'path' | null;
	path: string | null;
	version: string | null;
	/** Found, but it does not run: what it said. */
	problem: string | null;
	/** The app has its own copy, which Remove deletes. */
	managed: boolean;
	/** The app can install it. */
	installable: boolean;
	/** What the install needs (`npm`, `dotnet`), and whether that is on this computer. */
	prerequisite: string | null;
	prerequisiteFound: boolean;
	/** For servers the app cannot install: the command that does. */
	hint: string | null;
}
export type OpenTarget = 'finder' | 'terminal' | 'remote' | 'issues' | 'pulls' | 'new-pull' | 'commit' | 'branch';
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
	/** Oldest first. */
	cherryPick(id: string, hashes: string[]) { return this.call<void>('cherry_pick', { id, hashes }); }
	/** Commits an interactive rebase on `upstream` would replay, oldest first; `null` is the whole branch. */
	rebasePlan(id: string, upstream: string | null) { return this.call<Commit[]>('rebase_plan', { id, upstream }); }
	rebaseInteractive(id: string, upstream: string | null, steps: RebaseStep[]) { return this.call<void>('rebase_interactive', { id, upstream, steps }); }
	resetTo(id: string, hash: string, mode: ResetMode) { return this.call<void>('reset_to', { id, hash, mode }); }
	checkoutCommit(id: string, hash: string) { return this.call<void>('checkout_commit', { id, hash }); }
	createTag(id: string, name: string, hash: string, push: boolean) { return this.call<void>('tag_create', { id, name, hash, push }); }
	deleteTag(id: string, name: string) { return this.call<void>('tag_delete', { id, name }); }
	rebaseOnto(id: string, onto: string) { return this.call<void>('rebase_onto', { id, onto }); }
	deleteRemoteBranch(id: string, name: string) { return this.call<void>('branch_delete_remote', { id, name }); }
	discard(id: string, files: FileChange[]) { return this.call<void>('discard_changes', { id, files: files.map((f) => ({ path: f.path, oldPath: f.oldPath })) }); }
	undoCommit(id: string) { return this.call<UndoneCommit>('undo_commit', { id }); }
	history(id: string, skip: number, limit: number) { return this.call<Commit[]>('history', { id, skip, limit }); }
	/** `ahead` false: commits `branch` has that HEAD lacks (what merging it brings in); true: the other way round. */
	compareHistory(id: string, branch: string, ahead: boolean, skip: number, limit: number) { return this.call<Commit[]>('compare_history', { id, branch, ahead, skip, limit }); }
	compareCounts(id: string, branches: string[]) { return this.call<BranchCompare[]>('compare_counts', { id, branches }); }
	commitFiles(id: string, hash: string) { return this.call<FileChange[]>('commit_files', { id, hash }); }
	commitDiff(id: string, hash: string, file: FileChange) { return this.call<DiffResult>('commit_diff', { id, hash, path: file.path, oldPath: file.oldPath }); }
	branches(id: string) { return this.call<Branch[]>('branches', { id }); }
	createBranch(id: string, name: string, start: string | null) { return this.call<void>('branch_create', { id, name, start }); }
	checkout(id: string, name: string, isRemote: boolean) { return this.call<void>('branch_checkout', { id, name, isRemote }); }
	deleteBranch(id: string, name: string, force: boolean) { return this.call<void>('branch_delete', { id, name, force }); }
	renameBranch(id: string, from: string, to: string) { return this.call<void>('branch_rename', { id, from, to }); }
	merge(id: string, from: string) { return this.call<string>('merge_branch', { id, from }); }
	/** Everything `from` brings, as one new commit with `message`. */
	mergeSquash(id: string, from: string, message: string) { return this.call<void>('merge_squash', { id, from, message }); }
	fetch(id: string) { return this.call<void>('fetch', { id }); }
	pull(id: string) { return this.call<void>('pull', { id }); }
	push(id: string, force = false) { return this.call<void>('push', { id, force }); }
	setRemote(id: string, url: string) { return this.call<void>('remote_set', { id, url }); }
	/** The global identity, plus repository `id`'s override. */
	identity(id: string | null) { return this.call<Identities>('identity_get', { id }); }
	/** No `id`: the global identity. With `id`: that repository's override, `null` removes it. */
	setIdentity(id: string | null, identity: Identity | null) { return this.call<void>('identity_set', { id, identity }); }
	openIn(id: string, target: OpenTarget, arg: string | null = null) { return this.call<void>('open_in', { id, target, arg }); }
	pickFolder() { return this.call<string | null>('pick_folder'); }
	worktrees(id: string) { return this.call<Worktree[]>('worktree_list', { id }); }
	addWorktree(id: string, branch: string, base: string | null) { return this.call<string>('worktree_add', { id, branch, base }); }
	selectWorktree(id: string, path: string | null) { return this.call<void>('worktree_select', { id, path }); }
	removeWorktree(id: string, path: string, force: boolean, deleteBranch: boolean) { return this.call<void>('worktree_remove', { id, path, force, deleteBranch }); }
	/** `base` null: since the checkout left the main one's branch. */
	worktreeDiff(id: string, path: string, base: string | null) { return this.call<WorktreeDiff>('worktree_diff', { id, path, base }); }
	/** Open a web address in the user's browser. */
	openUrl(url: string) { return this.call<void>('plugin:opener|open_url', { url }); }
	agentAvailable() { return this.call<string | null>('agent_available'); }
	agentStart(id: string, cwd: string, key: string, prompt: string, mode: AgentMode, resume: string | null, options: AgentRunOptions | null = null) { return this.call<void>('agent_start', { id, cwd, key, prompt, mode, resume, options }); }
	agentStop(key: string) { return this.call<void>('agent_stop', { key }); }
	/** Null when no server for that language is installed (and always in the browser preview). */
	async lspStart(id: string, language: string) { return (await this.call<{ key: string; root: string; fresh: boolean } | null | undefined>('lsp_start', { id, language })) ?? null; }
	lspSend(key: string, message: unknown) { return this.call<void>('lsp_send', { key, message }); }
	lspStop(key: string) { return this.call<void>('lsp_stop', { key }); }
	/** Start the user's shell in the active checkout. Its output arrives as `term-data` events ({ key, data: base64 }), its end as `term-exit` ({ key, code }). */
	termOpen(id: string, cols: number, rows: number) { return this.call<string>('term_open', { id, cols, rows }); }
	termWrite(key: string, data: string) { return this.call<void>('term_write', { key, data }); }
	termResize(key: string, cols: number, rows: number) { return this.call<void>('term_resize', { key, cols, rows }); }
	termClose(key: string) { return this.call<void>('term_close', { key }); }
	/** The servers Settings lists, looked for in the active checkout of `id`, the app's own folder and PATH. */
	async lspServers(id: string | null) { return (await this.call<LanguageServer[] | undefined>('lsp_servers', { id })) ?? []; }
	/** Installs into the app's data folder, never globally. Takes as long as npm or dotnet do. */
	lspInstall(name: string) { return this.call<void>('lsp_install', { name }); }
	lspUninstall(name: string) { return this.call<void>('lsp_uninstall', { name }); }

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

	// ---- the host, through the user's own gh / az / glab ----
	issuesStatus(id: string) { return this.call<HostCliStatus>('issues_status', { id }); }
	issuesList(id: string, query: string) { return this.call<HostIssue[]>('issues_list', { id, query }); }
	prContext(id: string) { return this.call<PrContext>('pr_context', { id }); }
	prChanges(id: string, base: string) { return this.call<PrChanges>('pr_changes', { id, base }); }
	async prExisting(id: string) { return (await this.call<PullRequestRef | null | undefined>('pr_existing', { id })) ?? null; }
	/** Publishes a pull request. Only the dialog's Create button calls this. */
	prCreate(id: string, title: string, body: string, base: string, draft: boolean) { return this.call<PullRequestRef>('pr_create', { id, title, body, base, draft }); }
	prWebUrl(id: string, title: string, body: string, base: string) { return this.call<PrWebUrl>('pr_web_url', { id, title, body, base }); }
	/** Open an issue or pull request page; the native side only opens pages on the repository's own host. */
	hostOpen(id: string, url: string) { return this.call<void>('host_open', { id, url }); }
	hostClis() { return this.call<HostCli[]>('host_clis'); }
	/** `org` is the Azure DevOps organization (name or URL); the other hosts ignore it. */
	hostOwners(provider: HostCli['provider'], org: string | null = null) { return this.call<HostOwner[]>('host_owners', { provider, org }); }
	/** Creates the remote repository only: nothing is pushed and no local repository changes. For Azure DevOps `owner` is the project. */
	hostRepoCreate(provider: HostCli['provider'], name: string, owner: string | null, isPrivate: boolean, org: string | null = null) { return this.call<HostRepo>('host_repo_create', { provider, name, owner, private: isPrivate, org }); }
	// ---- AI features around changes (src-tauri/src/ai_git.rs) ----
	/** The combined working-tree diff of these files, capped for a prompt. */
	aiSelectedDiff(id: string, files: FileChange[]) { return this.call<AiDiff>('ai_selected_diff', { id, files: files.map((f) => ({ path: f.path, oldPath: f.oldPath, status: f.status })) }); }
	/** One whole commit (message, stat, patch), capped. */
	aiCommitPatch(id: string, hash: string) { return this.call<AiDiff>('ai_commit_patch', { id, hash }); }
	aiPushDiff(id: string) { return this.call<PushDiff>('ai_push_diff', { id }); }
	aiRangeFileDiff(id: string, base: string, head: string, path: string) { return this.call<DiffResult>('ai_range_file_diff', { id, base, head, path }); }
	aiConflictFile(id: string, path: string) { return this.call<ConflictFile>('ai_conflict_file', { id, path }); }
	/** The diff from the file as it is to `text`; nothing is written. */
	aiResolutionPreview(id: string, path: string, text: string) { return this.call<DiffResult>('ai_resolution_preview', { id, path, text }); }
	/** Write `text` over the conflicted file and stage it. Refused when the file is no longer `original`, or the checkout no longer `root`. */
	aiResolutionApply(id: string, path: string, text: string, original: string, root: string) { return this.call<void>('ai_resolution_apply', { id, path, text, original, root }); }
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

/** A file left conflicted by a merge, so the preview has something to propose a resolution for. */
const DEMO_CONFLICT_PATH = 'src/player/shuffle.ts';
const DEMO_CONFLICT_TEXT = `import type { Track } from './track';

<<<<<<< HEAD
export function shuffle(tracks: Track[], seed = Date.now()): Track[] {
	const random = mulberry32(seed);
=======
export function shuffle(tracks: readonly Track[]): Track[] {
	const random = Math.random;
>>>>>>> origin/main
	const out = [...tracks];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}
`;
DEMO_DIFFS[DEMO_CONFLICT_PATH] = `diff --git a/src/player/shuffle.ts b/src/player/shuffle.ts
index 4c1d2e3..0000000 100644
--- a/src/player/shuffle.ts
+++ b/src/player/shuffle.ts
@@ -1,6 +1,11 @@
 import type { Track } from './track';

+<<<<<<< HEAD
 export function shuffle(tracks: Track[], seed = Date.now()): Track[] {
 	const random = mulberry32(seed);
+=======
+export function shuffle(tracks: readonly Track[]): Track[] {
+	const random = Math.random;
+>>>>>>> origin/main
 	const out = [...tracks];
 	for (let i = out.length - 1; i > 0; i--) {
 		const j = Math.floor(random() * (i + 1));
`;
/** What accepting the canned resolution (demoAnswer, `resolve-conflict`) does to the conflicted file. */
const DEMO_RESOLUTION_DIFF = `diff --git a/src/player/shuffle.ts b/src/player/shuffle.ts
--- a/src/player/shuffle.ts
+++ b/src/player/shuffle.ts
@@ -1,12 +1,7 @@
 import type { Track } from './track';

-<<<<<<< HEAD
-export function shuffle(tracks: Track[], seed = Date.now()): Track[] {
-	const random = mulberry32(seed);
-=======
-export function shuffle(tracks: readonly Track[]): Track[] {
-	const random = Math.random;
->>>>>>> origin/main
+export function shuffle(tracks: readonly Track[], seed = Date.now()): Track[] {
+	const random = mulberry32(seed);
 	const out = [...tracks];
 	for (let i = out.length - 1; i > 0; i--) {
 		const j = Math.floor(random() * (i + 1));
`;
const DEMO_RESOLVED_DIFF = `diff --git a/src/player/shuffle.ts b/src/player/shuffle.ts
index 4c1d2e3..8a9b0c1 100644
--- a/src/player/shuffle.ts
+++ b/src/player/shuffle.ts
@@ -1,6 +1,6 @@
 import type { Track } from './track';

-export function shuffle(tracks: Track[], seed = Date.now()): Track[] {
+export function shuffle(tracks: readonly Track[], seed = Date.now()): Track[] {
 	const random = mulberry32(seed);
 	const out = [...tracks];
 	for (let i = out.length - 1; i > 0; i--) {
`;

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
		case 'pull-request':
			return demoPullRequestAnswer();
		case 'commit-message':
			return JSON.stringify({
				summary: 'Wrap the queue when repeat is on',
				description: '- next() takes a repeat flag and starts over at the end of the queue\n- Add nextRepeatMode() to cycle off, all, one\n- Expose the queue length and drop the old notes',
			});
		case 'explain-diff':
		case 'explain-commit':
			return [
				'## What changed',
				'- `Queue.next()` takes a `repeat` flag. At the end of the queue it now returns `null` when repeat is off, and starts over from the first track when it is on.',
				'- The cursor is only advanced when there is a track to move to, so it no longer runs past the end.',
				'- A `length` getter exposes how many tracks are queued.',
				'',
				'## Why it probably changed',
				'This looks like groundwork for a repeat mode in the player: the transport needs the queue to wrap, and probably uses `length` to decide whether there is anything to repeat.',
				'',
				'## Worth a second look',
				'- `next()` used to move the cursor even at the end. Code that calls `previous()` right after hitting the end now gets a different track.',
				'- With repeat on and an empty queue the cursor ends up at `0`:',
				'',
				'```ts',
				'this._cursor = -1;',
				'return this._items[++this._cursor] ?? null;',
				'```',
			].join('\n');
		case 'review-push':
			return JSON.stringify({
				summary: 'The wrap-around works, but next() changed what happens at the end of the queue in a way callers may not expect.',
				findings: [
					{ file: 'src/player/queue.ts', line: 17, severity: 'bug', title: 'next() no longer advances past the last track', detail: 'Before this change the cursor moved even when there was nothing left, and previous() relied on that to return the last track. Now previous() after reaching the end skips one track back too far. Keep the old cursor position or adjust previous().' },
					{ file: 'src/player/queue.ts', line: 21, severity: 'risk', title: 'Repeat on an empty queue leaves the cursor at 0', detail: 'With no items the cursor is reset to -1 and then incremented, so it points at a slot that does not exist. Return null before touching the cursor when the queue is empty.' },
					{ file: 'src/player/repeat.ts', line: 6, severity: 'nit', title: 'An unknown mode silently becomes "off"', detail: 'indexOf returns -1 for a value outside ORDER, which wraps to the first entry. Fine for typed callers, surprising for a value read from storage.' },
				],
			});
		case 'resolve-conflict':
			return [
				'<resolution conflict="1">',
				'export function shuffle(tracks: readonly Track[], seed = Date.now()): Track[] {',
				'\tconst random = mulberry32(seed);',
				'</resolution>',
				'<summary>',
				'Kept the seeded generator from your side and the `readonly` parameter from origin/main; the two changes do not depend on each other. Check that every caller is happy to pass a readonly array.',
				'</summary>',
			].join('\n');
		default:
			return 'This is the browser preview, so there is no Claude here. In the desktop app the answer appears in this spot.';
	}
}

/** What the demo "Claude" does with a read-only question: looks around, then answers with references the app links. */
function demoAsk(prompt: string, history: boolean, commits: Commit[]): Record<string, unknown>[] {
	const question = (/^Question: (.*)$/m.exec(prompt)?.[1] ?? prompt).trim();
	const tool = (name: string, input: Record<string, unknown>) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
	const fix = commits.find((c) => /wrap/i.test(c.summary)) ?? commits[0];
	const toggle = commits.find((c) => /toggle/i.test(c.summary)) ?? commits[1] ?? fix;
	const answer = history
		? [
				`**${question}**`,
				'',
				`The behaviour changed in \`${fix?.shortHash ?? ''}\` ("${fix?.summary ?? ''}"). Before it, \`next()\` ran off the end of the queue and returned \`null\`; since then the cursor wraps when repeat is on.`,
				'',
				'How it got there:',
				'',
				`1. \`${toggle?.shortHash ?? ''}\` added the repeat toggle, but nothing read it yet.`,
				`2. \`${fix?.shortHash ?? ''}\` made the queue honour it, in \`src/player/queue.ts:8\`.`,
				'',
				'> The cursor resets instead of running off the end.',
				'',
				`The key press that drives it is still in \`src/main.ts:11\`.`,
			].join('\n')
		: [
				`**${question}**`,
				'',
				'Playback order lives in the `Queue` class:',
				'',
				'- `src/player/queue.ts:8` advances to the next track and wraps when repeat is on.',
				'- `src/player/repeat.ts:5` cycles the repeat mode (`off`, `all`, `one`).',
				'- `src/main.ts:7` wires both to the keyboard.',
				'',
				'The wrap itself is three lines:',
				'',
				'```ts',
				'if (!repeat) {',
				'\treturn null;',
				'}',
				'this._cursor = -1;',
				'```',
				'',
				'| Key | What it does | Where |',
				'| --- | --- | --- |',
				'| `r` | Cycle repeat | `src/main.ts:8` |',
				'| `ArrowRight` | Next track | `src/main.ts:11` |',
				'',
				'The track shape is in src/player/track.ts, and the shortcuts are documented in [the shortcuts page](docs/shortcuts.md).',
			].join('\n');
	return [
		{ type: 'system', subtype: 'init', session_id: 'demo-ask' },
		history ? tool('Bash', { command: 'git log --oneline -S"repeat" -- src/player/queue.ts' }) : tool('Grep', { pattern: 'repeat' }),
		history ? tool('Bash', { command: `git show ${fix?.shortHash ?? 'HEAD'}` }) : tool('Read', { file_path: 'src/player/queue.ts' }),
		{ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } },
		{ type: 'result', subtype: 'success', is_error: false, session_id: 'demo-ask', total_cost_usd: history ? 0.03 : 0.02 },
	];
}

/** What a demo worktree "changed": each attempt gets a slightly different set, so the compare view has something to compare. */
function demoWorktreeDiff(path: string, trees: Worktree[]): WorktreeDiff {
	const at = Math.max(0, trees.filter((w) => !w.isMain).findIndex((w) => w.path === path));
	const file = (p: string, status: FileStatus): ChangedFile => ({ path: p, oldPath: null, status, diff: DEMO_DIFFS[p] ?? '' });
	const sets: ChangedFile[][] = [
		[file('src/player/queue.ts', 'modified'), file('src/player/repeat.ts', 'untracked')],
		[file('src/player/queue.ts', 'modified')],
		[file('docs/old-notes.md', 'deleted'), file('src/player/queue.ts', 'modified'), file('src/player/repeat.ts', 'untracked')],
	];
	return { base: 'b'.repeat(40), head: 'c'.repeat(40), files: sets[at % sets.length], tooLarge: false };
}

/** Nothing persists; enough behaviour to click through every screen. */
class DemoBackend {
	private repos: RepoSummary[] = [
		{ id: DEMO_ID, name: 'harmony', path: DEMO_ID, missing: false },
		{ id: '/Users/demo/Source/cadence', name: 'cadence', path: '/Users/demo/Source/cadence', missing: false },
	];
	private current: string | null = DEMO_ID;
	private globalIdentity: Identity = { name: 'Demo Author', email: 'demo@example.com' };
	private repoIdentity = new Map<string, Identity>();
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
		{ path: DEMO_CONFLICT_PATH, oldPath: null, status: 'conflicted' },
	];
	/** The conflicted file's proposal was accepted (ai_resolution_apply). */
	private resolved = false;
	private commits: Commit[] = [
		demoCommit(6, 'Wrap the queue when repeat is on', 55, { unpushed: true, refs: ['HEAD -> feature/repeat-mode'], body: 'The cursor resets instead of running off the end.' }),
		demoCommit(5, 'Add a repeat toggle to the transport bar', 180, { refs: ['origin/feature/repeat-mode'] }),
		demoCommit(4, 'Fix seek drift after a long pause', 1500, { refs: ['origin/main', 'main'] }),
		demoCommit(3, 'Persist volume between sessions', 3000, { refs: ['tag: v1.3.0'] }),
		demoCommit(2, 'Queue: keyboard reordering', 7000),
		demoCommit(1, 'Initial commit', 20000),
	];
	/** Branches merged in the preview, so comparing with them again shows nothing to bring in. */
	private merged = new Set<string>();
	/** Pretend commits another branch has that this one lacks. */
	/** Commits after `upstream` (a hash, else the unpushed ones), oldest first. */
	private demoPlan(upstream: string | null): Commit[] {
		const at = upstream ? this.commits.findIndex((c) => c.hash === upstream) : this.commits.length;
		const list = at >= 0 ? this.commits.slice(0, at) : this.commits.filter((c) => c.unpushed);
		return [...list].reverse();
	}
	private demoIncoming(branch: string): Commit[] {
		if (this.merged.has(branch) || branch.endsWith('feature/repeat-mode')) {
			return [];
		}
		const n = branch.endsWith('main') ? 2 : branch.includes('release') ? 3 : 1;
		return Array.from({ length: n }, (_, i) => demoCommit(100 + i + branch.length * 7, [`Bump dependencies on ${branch}`, 'Tidy the settings page', 'Release notes'][i], 600 + i * 240));
	}
	private ahead = 1;
	private behind = 0;
	private lastFetched = Date.now() - 12 * 60_000;
	private stashes: Stash[] = [];
	private stashed: FileChange[] = [];

	private languageServers: LanguageServer[] = [
		{ name: 'typescript', label: 'TypeScript and JavaScript', program: 'typescript-language-server', source: 'project', path: `${DEMO_ID}/node_modules/.bin/typescript-language-server`, version: '6.1.0', problem: null, managed: false, installable: true, prerequisite: 'npm', prerequisiteFound: true, hint: null },
		{ name: 'php', label: 'PHP', program: 'intelephense', source: null, path: null, version: null, problem: null, managed: false, installable: true, prerequisite: 'npm', prerequisiteFound: true, hint: null },
		{ name: 'csharp', label: 'C#', program: 'csharp-ls', source: null, path: null, version: null, problem: null, managed: false, installable: true, prerequisite: 'dotnet', prerequisiteFound: false, hint: null },
		{ name: 'rust', label: 'Rust', program: 'rust-analyzer', source: 'path', path: '/Users/demo/.cargo/bin/rust-analyzer', version: null, problem: "error: Unknown binary 'rust-analyzer' in official toolchain 'stable'.", managed: false, installable: false, prerequisite: null, prerequisiteFound: true, hint: 'rustup component add rust-analyzer' },
	];
	private worktreeList: Worktree[] = [{ path: DEMO_ID, branch: 'feature/repeat-mode', head: 'a'.repeat(40), isMain: true, active: true, changes: 4 }];
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

	listen(event: string, handler: (payload: unknown) => void): () => void {
		const set = this.listeners.get(event) ?? new Set();
		set.add(handler);
		this.listeners.set(event, set);
		return () => set.delete(handler);
	}

	/** Timers of events still to come, by agent key, so stopping an agent can call them off. */
	private readonly pending = new Map<string, ReturnType<typeof setTimeout>[]>();

	private emit(event: string, payload: unknown, delay: number): void {
		const key = (payload as { key?: string } | null)?.key;
		const timer = setTimeout(() => {
			if (key && event === 'agent-done') {
				this.pending.delete(key);
			}
			this.listeners.get(event)?.forEach((h) => h(payload));
		}, delay);
		if (key) {
			this.pending.set(key, [...(this.pending.get(key) ?? []), timer]);
		}
	}

	async call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
		await new Promise((r) => setTimeout(r, cmd === 'fetch' || cmd === 'pull' || cmd === 'push' || cmd === 'repo_clone' ? 700 : 40));
		return this.handle(cmd, args) as T;
	}

	private handle(cmd: string, args: Record<string, unknown>): unknown {
		const empty = this.current !== DEMO_ID;
		switch (cmd) {
			case 'app_status':
				return { repos: this.repos, current: this.current, gitVersion: '2.47.0 (demo)', authorName: this.globalIdentity.name, authorEmail: this.globalIdentity.email, appVersion: '0.1.0' } satisfies AppStatus;
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
					defaultBranch: empty ? null : 'main',
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
				return { text: (this.resolved && cmd === 'file_diff' && args.path === DEMO_CONFLICT_PATH ? DEMO_RESOLVED_DIFF : DEMO_DIFFS[String(args.path)]) ?? '', tooLarge: false } satisfies DiffResult;
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
			case 'cherry_pick': {
				const incoming = this.branchList.flatMap((b) => this.demoIncoming(b.name));
				for (const hash of args.hashes as string[]) {
					const c = incoming.find((x) => x.hash === hash);
					this.commits = [demoCommit(this.commits.length + 1, c?.summary ?? 'Cherry-picked commit', 0, { unpushed: true, body: c?.body ?? '' }), ...this.commits];
					this.ahead++;
				}
				return;
			}
			case 'merge_squash': {
				this.merged.add(String(args.from));
				const [summary, ...rest] = String(args.message).trim().split('\n');
				this.commits = [demoCommit(this.commits.length + 1, summary, 0, { unpushed: true, body: rest.join('\n').trim() }), ...this.commits];
				this.ahead++;
				return;
			}
			case 'rebase_plan':
				return this.demoPlan(args.upstream as string | null);
			case 'rebase_interactive': {
				const plan = this.demoPlan(args.upstream as string | null);
				const out: Commit[] = [];
				for (const step of args.steps as RebaseStep[]) {
					const c = plan.find((x) => x.hash === step.hash)!;
					if (step.action === 'drop') {
						continue;
					}
					if (step.action === 'squash' || step.action === 'fixup') {
						continue;
					}
					const [summary, ...rest] = (step.message ?? `${c.summary}\n\n${c.body}`).trim().split('\n');
					out.push({ ...c, summary, body: rest.join('\n').trim(), unpushed: true });
				}
				this.commits = [...out.reverse(), ...this.commits.slice(plan.length)];
				this.ahead = this.commits.filter((c) => c.unpushed).length;
				return;
			}
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
			case 'compare_history': {
				if (empty) {
					return [];
				}
				const list = args.ahead ? this.commits.filter((c) => c.unpushed) : this.demoIncoming(String(args.branch));
				return list.slice(Number(args.skip ?? 0), Number(args.skip ?? 0) + Number(args.limit ?? 100));
			}
			case 'compare_counts':
				return empty
					? []
					: (args.branches as string[]).map((name) => ({ name, ahead: this.commits.filter((c) => c.unpushed).length, behind: this.demoIncoming(name).length })) satisfies BranchCompare[];
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
				this.merged.add(String(args.from));
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
			case 'identity_get':
				return { global: this.globalIdentity, repo: args.id ? (this.repoIdentity.get(String(args.id)) ?? null) : null } satisfies Identities;
			case 'identity_set': {
				const who = args.identity as Identity | null;
				if (!args.id) {
					this.globalIdentity = who!;
				} else if (who) {
					this.repoIdentity.set(String(args.id), who);
				} else {
					this.repoIdentity.delete(String(args.id));
				}
				return;
			}
			case 'worktree_list':
				return this.worktreeList;
			case 'worktree_add': {
				const path = `${DEMO_ID}.worktrees/${String(args.branch).replace(/[^\w.]+/g, '-')}`;
				this.worktreeList = [...this.worktreeList, { path, branch: String(args.branch), head: 'b'.repeat(40), isMain: false, active: false, changes: 0 }];
				if (!this.branchList.some((b) => !b.isRemote && b.name === args.branch)) {
					this.branchList = [...this.branchList, { name: String(args.branch), isRemote: false, isCurrent: false, upstream: null, date: new Date().toISOString() }];
				}
				return path;
			}
			case 'worktree_select': {
				const path = (args.path as string | null) ?? DEMO_ID;
				this.worktreeList = this.worktreeList.map((w) => ({ ...w, active: w.path === path }));
				this.repos = this.repos.map((r) => (r.id === args.id ? { ...r, worktree: path === DEMO_ID ? null : path } : r));
				return;
			}
			case 'worktree_remove':
				if (args.deleteBranch) {
					const gone = this.worktreeList.find((w) => w.path === args.path)?.branch;
					this.branchList = this.branchList.filter((b) => b.isRemote || b.name !== gone);
				}
				this.worktreeList = this.worktreeList.filter((w) => w.path !== args.path).map((w) => ({ ...w, active: w.isMain }));
				this.repos = this.repos.map((r) => ({ ...r, worktree: null }));
				return;
			case 'worktree_diff':
				return demoWorktreeDiff(String(args.path), this.worktreeList);
			case 'plugin:opener|open_url':
				window.open(String(args.url), '_blank', 'noopener');
				return;
			case 'agent_available':
				return '2.1.0 (demo)';
			case 'agent_start': {
				const key = String(args.key);
				this.pending.delete(key);
				const say = (event: Record<string, unknown>, delay: number) => this.emit('agent-event', { key, event }, delay);
				if ((args.options as AgentRunOptions | null)?.quick) {
					// One-shot questions (AiService.ask): features add their own canned answers through demoAnswer().
					const text = demoAnswer(String(args.prompt));
					say({ type: 'assistant', message: { content: [{ type: 'text', text }] } }, 500);
					say({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.001 }, 600);
					this.emit('agent-done', { key, ok: true, error: '' }, 650);
					return;
				}
				const rules = (args.options as AgentRunOptions | null)?.tools;
				if (rules?.includes('Read')) {
					// A read-only question (AgentsStore.ask): an answer with file and commit references to click.
					demoAsk(String(args.prompt), rules.some((r) => r.startsWith('Bash(git')), this.commits).forEach((event, i) => say(event, 300 + i * 600));
					this.emit('agent-done', { key, ok: true, error: '' }, 300 + 4 * 600);
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
			case 'agent_stop': {
				const key = String(args.key);
				if (this.pending.has(key)) {
					this.pending.get(key)!.forEach((t) => clearTimeout(t));
					this.pending.delete(key);
					this.emit('agent-done', { key, ok: false, error: '' }, 60);
				}
				return;
			}
			case 'folder_inspect': {
				// Preview: any path with "new" or "empty" in it is treated as a plain folder, so the setup wizard can be seen.
				const path = String(args.path);
				const plain = /new|empty/i.test(path);
				return {
					path,
					name: path.split(/[\\/]/).filter(Boolean).pop() ?? 'folder',
					exists: true,
					isRepo: !plain,
					entries: /empty/i.test(path) ? 0 : 7,
					hasReadme: false,
					hasGitignore: false,
					detected: ['os', 'node'],
					templates: [['os', 'macOS, Windows and Linux files'], ['editors', 'Editor folders'], ['node', 'Node.js / JavaScript / TypeScript'], ['dotnet', '.NET / C#'], ['php', 'PHP / Composer'], ['rust', 'Rust']],
					defaultBranch: 'main',
					authorName: 'Demo Author',
					authorEmail: 'demo@example.com',
				};
			}
			case 'repo_init':
				return this.handle('repo_add', { path: args.path });
			case 'term_open':
			case 'term_write':
			case 'term_resize':
			case 'term_close':
				return demoTerminal(cmd, args, empty ? String(this.current) : this.worktreeList.find((w) => w.active)?.path ?? DEMO_ID, (event, payload) => this.emit(event, payload, 0));
			case 'lsp_servers':
				return this.languageServers;
			case 'lsp_install':
				this.languageServers = this.languageServers.map((s) => (s.name === args.name ? { ...s, managed: true, source: s.source === 'project' ? s.source : 'managed', path: s.source === 'project' ? s.path : `/Users/demo/Library/Application Support/Melodic Studio/language-servers/${s.program}`, version: s.version ?? '1.0.0', problem: null } : s));
				return;
			case 'lsp_uninstall':
				this.languageServers = this.languageServers.map((s) => (s.name === args.name ? { ...s, managed: false, ...(s.source === 'managed' ? { source: null, path: null, version: null } : {}) } : s));
				return;
			case 'pick_folder':
				return '/Users/demo/Source';
			case 'list_dir':
				return empty ? [] : demoListDir(String(args.path));
			case 'read_file':
				return demoReadFile(String(args.path));
			case 'write_file':
				return demoWriteFile(String(args.path), String(args.text));
			case 'issues_status':
			case 'issues_list':
			case 'pr_context':
			case 'pr_changes':
			case 'pr_existing':
			case 'pr_create':
			case 'pr_web_url':
			case 'host_open':
			case 'host_clis':
			case 'host_owners':
			case 'host_repo_create':
				return demoHost(cmd, args, { empty, branch: this.branch, unpushed: this.ahead, onRemote: !!this.branchList.find((b) => b.isCurrent)?.upstream, remoteBranches: this.branchList.filter((b) => b.isRemote).map((b) => b.name.replace(/^[^/]+\//, '')), subjects: this.commits.filter((c) => c.unpushed || c.refs.some((r) => r.startsWith('origin/feature'))).map((c) => c.summary) });
			case 'ai_selected_diff': {
				const paths = (args.files as { path: string }[]).map((f) => f.path);
				return { text: paths.map((p) => DEMO_DIFFS[p] ?? '').join(''), truncated: false, recent: this.commits.slice(0, 8).map((c) => c.summary) } satisfies AiDiff;
			}
			case 'ai_commit_patch': {
				const c = this.commits.find((x) => x.hash === args.hash);
				return { text: `commit ${c?.shortHash ?? ''}\n\n${c?.summary ?? ''}\n\n${c?.body ?? ''}\n\n${DEMO_DIFFS['src/player/queue.ts']}${DEMO_DIFFS['src/player/repeat.ts']}`, truncated: false, recent: [] } satisfies AiDiff;
			}
			case 'ai_push_diff': {
				const unpushed = this.commits.filter((c) => c.unpushed).map((c) => ({ hash: c.hash, summary: c.summary }));
				const base = this.commits.find((c) => !c.unpushed)?.hash ?? 'b'.repeat(40);
				const against = this.branchList.find((b) => b.isCurrent)?.upstream ?? 'origin/main';
				if (empty || !unpushed.length) {
					return { text: '', truncated: false, base, head: base, against, commits: [], files: [] } satisfies PushDiff;
				}
				return {
					text: DEMO_DIFFS['src/player/queue.ts'] + DEMO_DIFFS['src/player/repeat.ts'],
					truncated: false,
					base,
					head: this.commits[0].hash,
					against,
					commits: unpushed,
					files: [
						{ path: 'src/player/queue.ts', oldPath: null, status: 'modified' },
						{ path: 'src/player/repeat.ts', oldPath: null, status: 'added' },
					],
				} satisfies PushDiff;
			}
			case 'ai_range_file_diff':
				return { text: DEMO_DIFFS[String(args.path)] ?? '', tooLarge: false } satisfies DiffResult;
			case 'ai_conflict_file':
				return { text: args.path === DEMO_CONFLICT_PATH ? DEMO_CONFLICT_TEXT : '', binary: false, tooLarge: false } satisfies ConflictFile;
			case 'ai_resolution_preview':
				return { text: DEMO_RESOLUTION_DIFF, tooLarge: false } satisfies DiffResult;
			case 'ai_resolution_apply':
				this.resolved = true;
				this.files = this.files.map((f) => (f.path === args.path ? { ...f, status: 'modified' } : f));
				return;
			default:
				return;
		}
	}
}
