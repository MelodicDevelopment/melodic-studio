/**
 * Every call into the native side goes through here. In a plain browser
 * (`npm run dev` outside Tauri) the app runs against a small in-memory demo
 * so the UI stays previewable.
 */
import type { RepoOrigin } from '../shared/repo-groups';
import type { ReviewScope } from '../shared/review-offers';
import { Injectable } from '@melodicdev/core/injection';
import { demoFileOp, demoFiles, demoListDir, demoReadFile, demoSearch, demoWriteFile } from './demo-files';
import { SEARCH_LIMIT, type SearchOptions, type SearchResult } from '../shared/search';
import { demoProgram, demoTerminal } from './demo-terminal';
import { DEMO_AFTER, DEMO_BEFORE, DEMO_DENIED, DEMO_REPORT, DEMO_TARGETS, demoApproval, demoFix, demoReplay, demoRunScript } from './demo-investigate';
import { demoHost, demoPullRequestAnswer } from './demo-host';
import { demoProject } from './demo-project';

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
	/** Where `origin` (else the first remote) lives; null without a remote. */
	origin?: RepoOrigin | null;
}
export type { RepoOrigin };
/** A repository found under the folder the user scanned. */
export interface ScanHit {
	path: string;
	name: string;
	/** Already in Melodic Studio. */
	added: boolean;
	origin: RepoOrigin | null;
}
export interface ScanResult {
	repos: ScanHit[];
	/** A depth, folder or time limit stopped the search early. */
	truncated: boolean;
}
/** One checkout of the repository: the main one, or a linked worktree on its own branch. */
export interface Worktree {
	path: string;
	branch: string | null;
	head: string;
	isMain: boolean;
	active: boolean;
	changes: number;
	/** Its commit is already in the main checkout's branch or the remote's default branch (as of the last fetch). Also true before it has a commit of its own. */
	landed: boolean;
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
	/** A task's turn: Claude ends it with a brief (BRIEF_RULES in agent.rs; parsed by shared/brief.ts). */
	brief?: boolean;
	/** The turn belongs to an investigation: it gets Studio's own tools for running the app and none of the user's settings. */
	investigate?: { target: string | null };
	/** Images that go with the message, by the names they were saved under for this session (`agentImageSave`). */
	images?: string[];
}
/** A test run in an agent's worktree (src-tauri/src/pipeline.rs). `output` is the end of what it printed. */
export interface PipelineTestRun {
	ok: boolean;
	code: number | null;
	output: string;
	command: string;
	millis: number;
	timedOut: boolean;
	stopped: boolean;
}
/** What cleaning up after a task removed (src-tauri/src/pipeline.rs `clean_up`). */
export interface PipelineCleaned {
	removedTree: boolean;
	deletedBranch: boolean;
	/** Remote copies deleted, as `origin/agent/x`. */
	deletedRemote: string[];
	problems: string[];
}
/** An agent's work committed (as the user) and pushed on its branch. */
export interface PipelineCommitted {
	committed: boolean;
	head: string;
	pushed: boolean;
	pushError: string | null;
}
/** Something a checkout can run, found in its project files (src-tauri/src/targets.rs). */
export interface RunTarget {
	id: string;
	name: string;
	/** Where it came from, as a heading: "Shop.Api · launch profiles", "web · package.json". */
	group: string;
	/** Repository-relative working folder; empty for the root. */
	cwd: string;
	argv: string[];
	kind: 'run' | 'test';
	runtime: 'dotnet' | 'node' | 'rust' | 'go' | 'python';
	/** The file it was read from, by name. */
	source: string;
}
/** A target that was started: the terminal that shows it, and the port a worktree's copy was given. */
export interface RunStarted {
	key: string;
	port: number | null;
	command: string;
}
/** Claude wants to run something for an investigation and waits for the user's answer (`investigate-approval`). */
export interface InvestigateApproval {
	/** The agent session. */
	key: string;
	request: string;
	tool: 'run_target' | 'run_tests' | 'http_request';
	target: string | null;
	group: string | null;
	/** The project the target belongs to ("Shop.Api"), when its group names one rather than a file. */
	project: string | null;
	command: string | null;
	port: number | null;
	method: string | null;
	path: string | null;
	body: string | null;
	/** Claude's sentence on what this touches outside the worktree. Untrusted: text only. */
	touches: string | null;
}
/** Claude moved on in the checklist, or changed its mind about the cause (`investigate-progress`). */
export interface InvestigateProgress {
	key: string;
	step: number;
	detail: string | null;
	thinking: string | null;
}
export interface InvestigateStarted extends RunStarted {
	/** The number of the recording this run writes. */
	replay: number;
}
/** One recorded run: the events as the program wrote them and the files as they were when it ran. */
export interface ReplayData {
	run: number;
	events: string;
	files: { path: string; text: string }[];
}
/** One file a checkout changed since a commit, with its own unified diff. */
export interface ChangedFile extends FileChange {
	diff: string;
}
/** Everything a checkout holds that `base` does not: commits since, uncommitted edits, untracked files. */
/** A Claude Code session started outside the app, read from its transcript (src-tauri/src/sessions.rs). */
export interface ClaudeSession {
	/** What `claude --resume` takes. */
	id: string;
	/** The checkout it ran in, spelled as worktrees() spells it. */
	cwd: string;
	branch: string | null;
	/** Claude Code's own short title, when it wrote one. */
	title: string | null;
	prompt: string;
	lastPrompt: string | null;
	lastSaid: string | null;
	/** When its transcript last changed (ms). */
	modified: number;
}
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
	/** A local branch's own copy on a remote (`origin/feature`) as of the last fetch, else null. */
	published: string | null;
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
/**
 * What a review covers: `base`..`head`, measured against `against`. For a push that is the upstream (or the
 * default branch), for a branch the branch it is compared with, for the work in a checkout the commit it
 * started at, and then `head` is '' (the files as they are) and `commits` may be empty.
 */
export interface ReviewDiff {
	scope: ReviewScope;
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
export interface PrSummary {
	id: string;
	title: string;
	author: string;
	head: string;
	base: string;
	draft: boolean;
	state: 'open' | 'merged' | 'closed';
	updated: string;
	url: string;
	review: 'approved' | 'changes' | 'required' | '';
	checks: 'pass' | 'fail' | 'pending' | '';
}
/** Untrusted text from the host: shown as text only. */
export interface HostNote {
	author: string;
	body: string;
	created: string;
	kind: 'comment' | 'approved' | 'changes';
}
export interface HostCheck {
	name: string;
	state: 'pass' | 'fail' | 'pending' | 'skipped';
	url: string;
}
export interface PrDetail {
	summary: PrSummary;
	body: string;
	notes: HostNote[];
	checks: HostCheck[];
	files: { path: string; additions: number; deletions: number }[];
	mergeable: boolean | null;
	crossRepo: boolean;
}
export interface CiRun {
	id: string;
	name: string;
	title: string;
	state: 'pass' | 'fail' | 'pending' | 'skipped';
	url: string;
	created: string;
	branch: string;
	definition: string | null;
}
export interface JiraIssue {
	key: string;
	title: string;
	body: string;
	status: string;
	kind: string;
	assignee: string | null;
	updated: string;
	labels: string[];
	url: string;
}
export type PrScope = 'open' | 'mine' | 'review';
export type PrVerdict = 'approve' | 'request-changes' | 'comment';
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type TemplateOption =
	| { kind: 'flag'; id: string; label: string; default: boolean }
	| { kind: 'pick'; id: string; label: string; choices: { value: string; label: string }[] }
	| { kind: 'name'; id: string; label: string; default: string; when: string | null };
export interface ProjectTemplate {
	id: string;
	name: string;
	description: string;
	group: 'melodic' | 'popular' | 'blank';
	icon: string;
	tools: { program: string; name: string; installPage: string; found: boolean }[];
	options: TemplateOption[];
	nameRule: string;
}
/** A New Project run's progress: `step` starts a command (its label and the command), `out` is a line it printed. */
export interface ProjectOutput {
	kind: 'step' | 'out';
	text: string;
}
/** What to do when something copied or moved in already has a namesake there. `ask` changes nothing and answers the clashes. */
export type OnConflict = 'ask' | 'replace' | 'keep-both' | 'skip';

/** A project's own formatter (src-tauri/src/format.rs). */
export interface FormatTool {
	name: string;
	version: string | null;
}
export interface Placed {
	/** Repository-relative paths written. */
	done: string[];
	/** Where each of `done` came from. */
	sources: string[];
	/** Names already taken at the destination (with `ask`, when nothing was written). */
	conflicts: string[];
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
	provider: 'github' | 'azure' | 'gitlab' | 'jira';
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
/** One Claude Code hook call for a conversation (see src-tauri/src/conversation.rs). */
export interface ClaudeHook {
	/** The conversation's terminal key. */
	key: string;
	event: 'SessionStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Notification' | 'Stop' | 'SessionEnd';
	sessionId: string | null;
	transcriptPath: string | null;
	/** Notification: what it waits for. UserPromptSubmit: the prompt. Stop: the last answer. */
	text: string | null;
	/** Notification: permission_prompt, idle_prompt, ... SessionStart: startup, resume, clear. */
	kind: string | null;
	toolUseId: string | null;
	description: string | null;
	subagentType: string | null;
}

export type OpenTarget = 'finder' | 'reveal' | 'terminal' | 'remote' | 'issues' | 'pulls' | 'new-pull' | 'commit' | 'branch';
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

const DEMO_SESSIONS_KEY = 'studio.agents';

function demoSessions(): { id: string }[] {
	try {
		const all = JSON.parse(localStorage.getItem(DEMO_SESSIONS_KEY) ?? '[]') as unknown;
		return Array.isArray(all) ? all.filter((s): s is { id: string } => !!s && typeof (s as { id?: unknown }).id === 'string') : [];
	} catch {
		return [];
	}
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
	/** Quit and start again (after an update). Does not return in the desktop app. */
	relaunch() { return this.call<void>('app_relaunch'); }
	addRepo(path: string) { return this.call<RepoSummary>('repo_add', { path }); }
	/** Finds repositories under `root`; adds nothing. */
	scanRepos(root: string) { return this.call<ScanResult>('repo_scan', { root }); }
	/** Adds the given repositories without changing the current one; returns how many were new. */
	addRepos(paths: string[]) { return this.call<number>('repo_add_many', { paths }); }
	createRepo(parent: string, name: string, readme: boolean) { return this.call<RepoSummary>('repo_create', { parent, name, readme }); }
	cloneRepo(url: string, parent: string) { return this.call<RepoSummary>('repo_clone', { url, parent }); }
	removeRepo(id: string) { return this.call<void>('repo_remove', { id }); }
	selectRepo(id: string) { return this.call<void>('repo_select', { id }); }
	/** Folders the system asked the app to open (the Dock's recent list, a folder dropped on the icon), each handed over once. */
	takeOpened() { return this.call<string[]>('opened_take'); }
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
	/** With `path`, only the commits that touched that file (following renames). */
	history(id: string, skip: number, limit: number, path: string | null = null) { return this.call<Commit[]>('history', { id, skip, limit, path }); }
	/** `ahead` false: commits `branch` has that HEAD lacks (what merging it brings in); true: the other way round. */
	compareHistory(id: string, branch: string, ahead: boolean, skip: number, limit: number) { return this.call<Commit[]>('compare_history', { id, branch, ahead, skip, limit }); }
	compareCounts(id: string, branches: string[]) { return this.call<BranchCompare[]>('compare_counts', { id, branches }); }
	commitFiles(id: string, hash: string) { return this.call<FileChange[]>('commit_files', { id, hash }); }
	commitDiff(id: string, hash: string, file: FileChange) { return this.call<DiffResult>('commit_diff', { id, hash, path: file.path, oldPath: file.oldPath }); }
	branches(id: string) { return this.call<Branch[]>('branches', { id }); }
	createBranch(id: string, name: string, start: string | null) { return this.call<void>('branch_create', { id, name, start }); }
	checkout(id: string, name: string, isRemote: boolean) { return this.call<void>('branch_checkout', { id, name, isRemote }); }
	/** `remote` also deletes the branch's copy on the remote (`Branch.published`), and does that first. */
	deleteBranch(id: string, name: string, force: boolean, remote = false) { return this.call<void>('branch_delete', { id, name, force, remote }); }
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
	/** Agent sessions as they were saved (each one's JSON text), from files in the app's data folder; `unreadable` names files that are there but could not be read. */
	agentSessionsLoad() { return this.call<{ sessions: string[]; unreadable: string[] }>('agent_sessions_load'); }
	/** Keep one session's JSON text, or with null forget the session. Rejects when it cannot be written (a full disk, a folder that cannot be written). */
	agentSessionSave(id: string, session: string | null) { return this.call<void>('agent_session_save', { id, session }); }
	/** Keep an image attached to a message of a session; `data` is base64. It is deleted with the session. */
	agentImageSave(id: string, name: string, data: string) { return this.call<void>('agent_image_save', { id, name, data }); }
	/** An attached image, in base64. */
	agentImageRead(id: string, name: string) { return this.call<string>('agent_image_read', { id, name }); }
	/** An image file dropped on the window, in base64. Rejects for a file that is not named as an image. */
	agentImageFile(path: string) { return this.call<{ mediaType: string; data: string }>('agent_image_file', { path }); }
	agentStart(id: string, cwd: string, key: string, prompt: string, mode: AgentMode, resume: string | null, options: AgentRunOptions | null = null) { return this.call<void>('agent_start', { id, cwd, key, prompt, mode, resume, options }); }
	agentStop(key: string) { return this.call<void>('agent_stop', { key }); }
	/** Null when no server for that language is installed (and always in the browser preview). */
	async lspStart(id: string, language: string) { return (await this.call<{ key: string; root: string; fresh: boolean } | null | undefined>('lsp_start', { id, language })) ?? null; }
	lspSend(key: string, message: unknown) { return this.call<void>('lsp_send', { key, message }); }
	lspStop(key: string) { return this.call<void>('lsp_stop', { key }); }
	/** Start the user's shell in the active checkout. Its output arrives as `term-data` events ({ key, data: base64 }), its end as `term-exit` ({ key, code }). */
	termOpen(id: string, cols: number, rows: number, at: string | null = null) { return this.call<string>('term_open', { id, cols, rows, at }); }
	termWrite(key: string, data: string) { return this.call<void>('term_write', { key, data }); }
	termResize(key: string, cols: number, rows: number) { return this.call<void>('term_resize', { key, cols, rows }); }
	termClose(key: string) { return this.call<void>('term_close', { key }); }
	/**
	 * Start the user's `claude` interactively in `cwd` (the repository or one of its worktrees), on a pty like a
	 * terminal: the term* calls and events work on the key it answers. `session` is the conversation's id, new or
	 * (with `resume`) one to continue. Claude Code's hooks report on it as `claude-hook` events.
	 */
	/** Claude Code sessions in the repository's checkouts that were started outside the app, newest first. */
	claudeSessions(id: string) { return this.call<ClaudeSession[]>('claude_sessions', { id }); }
	claudeOpen(id: string, cwd: string, session: string, resume: boolean, cols: number, rows: number) { return this.call<string>('claude_open', { id, cwd, session, resume, cols, rows }); }
	// ---- Run & Investigate (targets.rs, run.rs, investigate.rs) ----
	/** What the active checkout of `id` can run. */
	async targets(id: string) { return (await this.call<RunTarget[] | undefined>('targets_list', { id })) ?? []; }
	/** Start a target on a pty in the active checkout. The terminal events and `termClose` work on the key it answers. */
	targetRun(id: string, target: string, cols: number, rows: number) { return this.call<RunStarted>('target_run', { id, target, cols, rows }); }
	/** The user allowed what an investigation asked to run: start it, and answer the terminal that shows it. */
	investigateStart(request: string, cols: number, rows: number) { return this.call<InvestigateStarted>('investigate_start', { request, cols, rows }); }
	/** The user's answer to a request an investigation wants to send, or "no" to anything it asked. */
	investigateAnswer(request: string, allow: boolean) { return this.call<void>('investigate_answer', { request, allow }); }
	/** An investigation is over: stop what it runs. */
	investigateClose(key: string) { return this.call<void>('investigate_close', { key }); }
	replayRead(id: string, cwd: string, run: number) { return this.call<ReplayData>('replay_read', { id, cwd, run }); }
	/** Commit everything an investigation changed in its worktree, as the user. Only the Accept fix button calls this. */
	investigateCommit(id: string, cwd: string, summary: string, description: string) { return this.call<void>('investigate_commit', { id, cwd, summary, description }); }
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
	/** Every file of the active checkout that git tracks or would add, for opening one by name. */
	listFiles(id: string) { return this.call<{ paths: string[]; truncated: boolean }>('files_list', { id }); }
	/** Find in files, in the active checkout: `git grep` over tracked and new files. The native side stops at `SEARCH_LIMIT` lines. */
	searchFiles(id: string, pattern: string, options: SearchOptions) { return this.call<SearchResult>('files_search', { id, pattern, options }); }
	/** A file of a checkout that need not be the active one (`path`: the main checkout or a worktree of the repository). */
	worktreeRead(id: string, path: string, file: string, rev?: string) { return this.call<FileContent>('worktree_read', { id, path, file, rev }); }
	/** `root` is the checkout the text was read from; the save is refused if another one is active by now. */
	writeFile(id: string, path: string, text: string, root: string) { return this.call<void>('write_file', { id, path, text, root }); }
	/** The formatter the file's project brings (Prettier), if it brings one. Looks at the disk only. */
	formatTool(id: string, path: string) { return this.call<FormatTool | null>('format_tool', { id, path }); }
	/** `text` as the project's own formatter would write it; null when the project has none for this file. The file is not touched. */
	formatFile(id: string, root: string, path: string, text: string) { return this.call<string | null>('format_file', { id, root, path, text }); }
	// New Project. Output arrives as `project-output` events; answers the new folder.
	projectTemplates() { return this.call<ProjectTemplate[]>('project_templates'); }
	projectCreate(template: string, parent: string, name: string, options: Record<string, string>) { return this.call<string>('project_create', { request: { template, parent, name, options } }); }
	projectStop() { return this.call<void>('project_stop'); }
	// File operations. `root` is the checkout the action was aimed at; refused if another one is active by now.
	createEntry(id: string, root: string, dir: string, name: string, isDir: boolean) { return this.call<string>('files_create', { id, root, dir, name, isDir }); }
	/** Move into folder `to`; `rename` gives the single path a new name. */
	moveEntries(id: string, root: string, paths: string[], to: string, rename: string | null, onConflict: OnConflict) { return this.call<Placed>('files_move', { id, root, paths, to, rename, onConflict }); }
	duplicateEntry(id: string, root: string, path: string) { return this.call<string>('files_duplicate', { id, root, path }); }
	/** To the OS trash. */
	trashEntries(id: string, root: string, paths: string[]) { return this.call<void>('files_trash', { id, root, paths }); }
	/** Copy absolute `sources` (dropped from outside the app) into folder `to`. */
	importEntries(id: string, root: string, sources: string[], to: string, onConflict: OnConflict) { return this.call<Placed>('files_import', { id, root, sources, to, onConflict }); }

	// ---- pull requests, issue actions, CI and Jira (host_ops.rs). Writes run only from explicit clicks. ----
	prList(id: string, scope: PrScope) { return this.call<PrSummary[]>('pr_list', { id, scope }); }
	prView(id: string, number: string) { return this.call<PrDetail>('pr_view', { id, number }); }
	prReview(id: string, number: string, verdict: PrVerdict, body: string) { return this.call<void>('pr_review', { id, number, verdict, body }); }
	prComment(id: string, number: string, body: string) { return this.call<void>('pr_comment', { id, number, body }); }
	prMerge(id: string, number: string, method: MergeMethod, deleteBranch: boolean) { return this.call<void>('pr_merge', { id, number, method, deleteBranch }); }
	/** The pull request's commits as a local branch; answers its name. */
	prFetch(id: string, number: string) { return this.call<string>('pr_fetch', { id, number }); }
	issueCreate(id: string, title: string, body: string, kind: string) { return this.call<{ id: string; url: string }>('issue_create', { id, title, body, kind }); }
	issueComment(id: string, number: string, body: string) { return this.call<void>('issue_comment', { id, number, body }); }
	issueSetState(id: string, number: string, open: boolean) { return this.call<void>('issue_set_state', { id, number, open }); }
	ciRuns(id: string, branch: string) { return this.call<CiRun[]>('ci_runs', { id, branch }); }
	ciRerun(id: string, run: CiRun) { return this.call<void>('ci_rerun', { id, run: run.id, definition: run.definition, branch: run.branch }); }
	jiraIssues(site: string, project: string, query: string) { return this.call<JiraIssue[]>('jira_issues', { site, project, query }); }
	jiraTransition(key: string, status: string) { return this.call<void>('jira_transition', { key, status }); }
	jiraComment(key: string, body: string) { return this.call<void>('jira_comment', { key, body }); }

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
	/** `base`: the branch to compare with (scope `branch`) or the commit the work started at (scope `work`); null for the default of each. */
	/** The test targets in an agent's worktree. */
	pipelineTests(id: string, cwd: string) { return this.call<RunTarget[]>('pipeline_tests', { id, cwd }); }
	/** Run a test target in an agent's worktree to the end; `key` is what `pipelineTestStop` takes. */
	pipelineTestRun(id: string, cwd: string, key: string, target: string) { return this.call<PipelineTestRun>('pipeline_test_run', { id, cwd, key, target }); }
	pipelineTestStop(key: string) { return this.call<void>('pipeline_test_stop', { key }); }
	/** Commit everything in an agent's worktree as the user, then push its branch. */
	pipelineCommit(id: string, cwd: string, message: string) { return this.call<PipelineCommitted>('pipeline_commit', { id, cwd, message }); }
	/** Remove a task's worktree and delete its branch, here and on the remote. */
	pipelineClean(id: string, cwd: string, branch: string) { return this.call<PipelineCleaned>('pipeline_clean', { id, cwd, branch }); }
	/** What a task's review covers: its worktree since `base`. */
	pipelineReviewDiff(id: string, cwd: string, base: string | null) { return this.call<ReviewDiff>('pipeline_review_diff', { id, cwd, base }); }
	aiReviewDiff(id: string, scope: ReviewScope, base: string | null = null) { return this.call<ReviewDiff>('ai_review_diff', { id, scope, base }); }
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
		case 'branch-name':
			return 'repeat-wraps-queue';
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

const DEMO_ORIGINS: Record<string, RepoOrigin> = {
	tempo: { provider: 'github', label: 'GitHub', owner: 'melodic-demo' },
	dotfiles: { provider: 'github', label: 'GitHub', owner: 'demo' },
	'billing-api': { provider: 'azure', label: 'Azure DevOps', owner: 'contoso/Payments' },
	ledger: { provider: 'azure', label: 'Azure DevOps', owner: 'contoso/Payments' },
	site: { provider: 'bitbucket', label: 'Bitbucket', owner: 'studio-team' },
};

/** Nothing persists; enough behaviour to click through every screen. */
class DemoBackend {
	private repos: RepoSummary[] = [
		{ id: DEMO_ID, name: 'harmony', path: DEMO_ID, missing: false, origin: { provider: 'github', label: 'GitHub', owner: 'melodic-demo' } },
		{ id: '/Users/demo/Source/cadence', name: 'cadence', path: '/Users/demo/Source/cadence', missing: false, origin: { provider: 'azure', label: 'Azure DevOps', owner: 'contoso/Music' } },
	];
	private current: string | null = DEMO_ID;
	private globalIdentity: Identity = { name: 'Demo Author', email: 'demo@example.com' };
	private repoIdentity = new Map<string, Identity>();
	private branch = 'feature/repeat-mode';
	private branchList: Branch[] = [
		{ name: 'feature/repeat-mode', isRemote: false, isCurrent: true, upstream: 'origin/feature/repeat-mode', published: 'origin/feature/repeat-mode', date: new Date(Date.now() - 3_600_000).toISOString() },
		{ name: 'main', isRemote: false, isCurrent: false, upstream: 'origin/main', published: 'origin/main', date: new Date(Date.now() - 86_400_000).toISOString() },
		{ name: 'fix/seek-drift', isRemote: false, isCurrent: false, upstream: null, published: null, date: new Date(Date.now() - 4 * 86_400_000).toISOString() },
		{ name: 'origin/main', isRemote: true, isCurrent: false, upstream: null, published: null, date: new Date(Date.now() - 86_400_000).toISOString() },
		{ name: 'origin/feature/repeat-mode', isRemote: true, isCurrent: false, upstream: null, published: null, date: new Date(Date.now() - 7_200_000).toISOString() },
		{ name: 'origin/release/1.4', isRemote: true, isCurrent: false, upstream: null, published: null, date: new Date(Date.now() - 9 * 86_400_000).toISOString() },
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
	private worktreeList: Worktree[] = [{ path: DEMO_ID, branch: 'feature/repeat-mode', head: 'a'.repeat(40), isMain: true, active: true, changes: 4, landed: false }];
	private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

	listen(event: string, handler: (payload: unknown) => void): () => void {
		const set = this.listeners.get(event) ?? new Set();
		set.add(handler);
		this.listeners.set(event, set);
		return () => set.delete(handler);
	}

	/** The demo investigation's question that is waiting for an answer: its request id and the session it belongs to. */
	private demoAsk: { request: string; key: string } | null = null;
	private demoAsks = 0;
	/** Worktrees whose tests ran once already (the first run fails a test). */
	private readonly demoTested = new Set<string>();

	/** The rest of the demo investigation, once the user has answered its question. */
	private demoInvestigate(key: string, allowed: boolean): void {
		const say = (event: Record<string, unknown>, delay: number) => this.emit('agent-event', { key, event }, delay);
		if (allowed) {
			DEMO_AFTER.forEach(([delay, step, detail, thinking]) => this.emit('investigate-progress', { key, step, detail, thinking }, delay));
			say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '.studio/replay/run-1.jsonl' } }] } }, 2400);
			say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/main.ts' } }] } }, 3700);
		}
		const answer = JSON.stringify(allowed ? DEMO_REPORT : DEMO_DENIED);
		const end = allowed ? 5200 : 900;
		say({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }, end);
		say({ type: 'result', subtype: 'success', is_error: false, session_id: 'demo-investigation', total_cost_usd: allowed ? 0.41 : 0.08 }, end + 100);
		this.emit('agent-done', { key, ok: true, error: '' }, end + 200);
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

	private readonly demoImages = new Map<string, string>();

	async call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
		await new Promise((r) => setTimeout(r, cmd === 'fetch' || cmd === 'pull' || cmd === 'push' || cmd === 'repo_clone' ? 700 : 40));
		return this.handle(cmd, args) as T;
	}

	private handle(cmd: string, args: Record<string, unknown>): unknown {
		const empty = this.current !== DEMO_ID;
		switch (cmd) {
			case 'app_relaunch':
				location.reload();
				return null;
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
			case 'repo_scan': {
				const root = String(args.root).replace(/[/\\]+$/, '');
				const hits: [string, RepoOrigin | null][] = [
					['harmony', { provider: 'github', label: 'GitHub', owner: 'melodic-demo' }],
					['cadence', { provider: 'azure', label: 'Azure DevOps', owner: 'contoso/Music' }],
					['tempo', { provider: 'github', label: 'GitHub', owner: 'melodic-demo' }],
					['dotfiles', { provider: 'github', label: 'GitHub', owner: 'demo' }],
					['billing-api', { provider: 'azure', label: 'Azure DevOps', owner: 'contoso/Payments' }],
					['ledger', { provider: 'azure', label: 'Azure DevOps', owner: 'contoso/Payments' }],
					['site', { provider: 'bitbucket', label: 'Bitbucket', owner: 'studio-team' }],
					['scratch', null],
				];
				return {
					repos: hits.map(([name, origin]) => {
						const path = `${root}/${name}`;
						return { path, name, origin, added: this.repos.some((r) => r.name === name) };
					}),
					truncated: false,
				} satisfies ScanResult;
			}
			case 'repo_add_many': {
				let added = 0;
				for (const path of args.paths as string[]) {
					const name = path.split('/').pop() ?? path;
					if (!this.repos.some((r) => r.path === path || r.name === name)) {
						const origin = DEMO_ORIGINS[name] ?? null;
						this.repos = [...this.repos, { id: path, name, path, missing: false, origin }].sort((a, b) => a.name.localeCompare(b.name));
						added++;
					}
				}
				this.current ??= this.repos[0]?.id ?? null;
				return added;
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
				return empty ? [] : this.commits.filter((_, i) => !args.path || i % 3 === 0).slice(Number(args.skip ?? 0), Number(args.skip ?? 0) + Number(args.limit ?? 100));
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
				return empty ? [{ name: 'main', isRemote: false, isCurrent: true, upstream: null, published: null, date: new Date().toISOString() }] : this.branchList;
			case 'branch_create':
				this.branchList = [{ name: String(args.name), isRemote: false, isCurrent: true, upstream: null, published: null, date: new Date().toISOString() }, ...this.branchList.map((b) => ({ ...b, isCurrent: false }))];
				this.branch = String(args.name);
				return;
			case 'branch_checkout': {
				const name = args.isRemote ? String(args.name).replace(/^[^/]+\//, '') : String(args.name);
				if (!this.branchList.some((b) => !b.isRemote && b.name === name)) {
					this.branchList = [{ name, isRemote: false, isCurrent: false, upstream: String(args.name), published: String(args.name), date: new Date().toISOString() }, ...this.branchList];
				}
				this.branchList = this.branchList.map((b) => ({ ...b, isCurrent: !b.isRemote && b.name === name }));
				this.branch = name;
				return;
			}
			case 'branch_delete': {
				const published = args.remote ? this.branchList.find((b) => !b.isRemote && b.name === args.name)?.published : null;
				this.branchList = this.branchList.filter((b) => (b.isRemote ? b.name !== published : b.name !== args.name));
				return;
			}
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
				this.branchList = this.branchList.map((b) => (b.isCurrent && !b.upstream ? { ...b, upstream: `origin/${b.name}`, published: `origin/${b.name}` } : b));
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
				this.worktreeList = [...this.worktreeList, { path, branch: String(args.branch), head: 'b'.repeat(40), isMain: false, active: false, changes: 0, landed: false }];
				if (!this.branchList.some((b) => !b.isRemote && b.name === args.branch)) {
					this.branchList = [...this.branchList, { name: String(args.branch), isRemote: false, isCurrent: false, upstream: null, published: null, date: new Date().toISOString() }];
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
				return String(args.path).includes('investigate-') ? demoFix() : demoWorktreeDiff(String(args.path), this.worktreeList);
			case 'targets_list':
				return empty ? [] : DEMO_TARGETS;
			case 'target_run': {
				const target = DEMO_TARGETS.find((t) => t.id === args.target);
				if (!target) {
					throw { kind: 'error', message: 'That run target is no longer in this checkout' };
				}
				const active = this.worktreeList.find((w) => w.active);
				// As in the app: the main checkout keeps the app's own port, a worktree gets one of its own.
				const port = active && !active.isMain && target.kind === 'run' ? 5174 : null;
				const script = demoRunScript(target, DEMO_ID, port);
				const key = demoProgram(active?.path ?? DEMO_ID, script.lines, script.exit, (event, payload) => this.emit(event, payload, 0));
				return { key, port, command: target.argv.join(' ') };
			}
			case 'investigate_start': {
				const ask = this.demoAsk;
				if (!ask || ask.request !== args.request) {
					throw { kind: 'error', message: 'Claude is no longer waiting for that' };
				}
				this.demoAsk = null;
				const script = demoRunScript(DEMO_TARGETS[1], DEMO_ID, 5174);
				const lines: [number, string][] = [[100, '\x1b[2mRecording to .studio/replay/run-1.jsonl\x1b[0m'], ...script.lines.slice(0, -1)];
				const key = demoProgram(DEMO_ID, lines, null, (event, payload) => this.emit(event, payload, 0));
				this.demoInvestigate(ask.key, true);
				return { key, port: 5174, command: 'npm run dev', replay: 1 };
			}
			case 'investigate_answer': {
				const ask = this.demoAsk;
				if (ask && ask.request === args.request) {
					this.demoAsk = null;
					this.demoInvestigate(ask.key, !!args.allow);
				}
				return;
			}
			case 'investigate_close':
			case 'investigate_commit':
				return;
			case 'pipeline_tests':
				return DEMO_TARGETS.filter((t) => t.kind === 'test');
			case 'pipeline_test_run': {
				// The first run of each worktree fails one test, so the preview shows a fix; later runs pass.
				const where = String(args.cwd);
				const first = !this.demoTested.has(where);
				this.demoTested.add(where);
				const result = first
					? { ok: false, code: 1, output: ' ✓ src/player/queue.test.ts (11)\n × src/player/repeat.test.ts > restarts the track on repeat-one 4ms\n Tests  1 failed | 11 passed (12)\n', command: 'npm test', millis: 1500, timedOut: false, stopped: false }
					: { ok: true, code: 0, output: ' ✓ src/player/queue.test.ts (11)\n ✓ src/player/repeat.test.ts (1)\n Tests  12 passed (12)\n', command: 'npm test', millis: 1500, timedOut: false, stopped: false };
				return new Promise((resolve) => setTimeout(() => resolve(result), 1500));
			}
			case 'pipeline_test_stop':
				return;
			case 'pipeline_clean': {
				const had = this.worktreeList.some((w) => w.path === args.cwd);
				this.worktreeList = this.worktreeList.filter((w) => w.path !== args.cwd).map((w) => ({ ...w, active: had && w.active ? w.isMain : w.active }));
				this.branchList = this.branchList.filter((b) => b.name !== args.branch && b.name !== `origin/${String(args.branch)}`);
				return { removedTree: had, deletedBranch: true, deletedRemote: [`origin/${String(args.branch)}`], problems: [] };
			}
			case 'pipeline_commit':
				return { committed: true, head: Math.random().toString(16).slice(2).padEnd(40, '0'), pushed: true, pushError: null };
			case 'pipeline_review_diff':
				return this.call('ai_review_diff', { id: args.id, scope: 'work', base: args.base });
			case 'replay_read':
				return demoReplay(DEMO_ID);
			case 'plugin:opener|open_url':
				window.open(String(args.url), '_blank', 'noopener');
				return;
			case 'agent_available':
				return '2.1.0 (demo)';
			// The preview has no data folder: its sessions stay in the browser's storage, as they did everywhere before.
			case 'agent_sessions_load':
				return { sessions: demoSessions().map((s) => JSON.stringify(s)), unreadable: [] };
			case 'agent_session_save': {
				const rest = demoSessions().filter((s) => s.id !== args.id);
				localStorage.setItem(DEMO_SESSIONS_KEY, JSON.stringify(args.session ? [...rest, JSON.parse(String(args.session))] : rest));
				return;
			}
			// The preview keeps attached images only while the page is open.
			case 'agent_image_save':
				this.demoImages.set(`${args.id}/${args.name}`, String(args.data));
				return;
			case 'agent_image_read': {
				const data = this.demoImages.get(`${args.id}/${args.name}`);
				if (!data) {
					throw { kind: 'error', message: 'The preview does not keep images across a reload', paths: [] } satisfies AppError;
				}
				return data;
			}
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
				if ((args.options as AgentRunOptions | null)?.investigate) {
					say({ type: 'system', subtype: 'init', session_id: 'demo-investigation' }, 200);
					if (args.resume) {
						// A follow-up (or the cleanup): it thinks for a moment and stands by its report.
						this.emit('investigate-progress', { key, step: 5, detail: null, thinking: 'Nothing in the recording changes with that. The report stands.' }, 600);
						this.demoInvestigate(key, true);
						return;
					}
					say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/main.ts' } }] } }, 400);
					say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/player/queue.ts' } }] } }, 900);
					say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/player/queue.ts' } }] } }, 2400);
					DEMO_BEFORE.forEach(([delay, step, detail, thinking]) => this.emit('investigate-progress', { key, step, detail, thinking }, delay));
					// Then it asks to run the app, and waits: `investigate_start` or `investigate_answer` carries on from here.
					const request = `demo-ask-${++this.demoAsks}`;
					this.demoAsk = { request, key };
					this.emit('investigate-approval', demoApproval(key, request), 3500);
					return;
				}
				const rules = (args.options as AgentRunOptions | null)?.tools;
				if (String(args.prompt).startsWith('[pipeline-plan]')) {
					// A task's plan: read-only, ends with a question to approve it with.
					say({ type: 'system', subtype: 'init', session_id: 'demo-session' }, 200);
					say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/player/queue.ts' } }] } }, 700);
					say({ type: 'assistant', message: { content: [{ type: 'text', text: 'Wrap the queue when repeat is on, in `src/player/queue.ts`.\n\n1. Make `next()` go back to the first track when repeat is on (`src/player/queue.ts`).\n2. Restart the current track for repeat-one (`src/player/repeat.ts`).\n3. Tests: wrapping, repeat-one, and an empty queue (`src/player/queue.test.ts`).\n\n```brief\ntitle: Queue wraps on repeat\ndid: Planned the change in 3 steps across 2 files.\nneeds: Should repeat-one restart the same track?\nchoice: Yes, restart it\nchoice: No, wrap as well\n```' }] } }, 1800);
					say({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0.08 }, 1900);
					this.emit('agent-done', { key, ok: true, error: '' }, 1950);
					return;
				}
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
				say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- queue', description: 'Run the queue tests' } }] } }, 4200);
				// A task ends its turn with a brief (BRIEF_RULES in agent.rs); the first turn asks something, a later one does not.
				const brief = args.resume
					? '```brief\ntitle: Queue wraps on repeat\ndid: Repeat-one now restarts the same track; the queue tests pass.\nneeds: nothing\n```'
					: '```brief\ntitle: Queue wraps on repeat\ndid: The queue wraps to the first track when repeat is on; the queue tests pass.\nneeds: Should repeat-one restart the same track instead of wrapping?\nchoice: Yes, restart it\nchoice: No, wrap as well\n```';
				say({ type: 'assistant', message: { content: [{ type: 'text', text: `Done. The queue now wraps when repeat is on, in \`src/player/queue.ts\`.\n\nI looked at how \`next()\` picks the following track: it returned \`null\` at the end of the list whatever the repeat setting was, so playback stopped. It now goes back to the first track when repeat is on. I left shuffle alone: it already draws from the whole queue.\n\n${brief}` }] } }, 6800);
				say({ type: 'result', subtype: 'success', is_error: false, session_id: 'demo-session', total_cost_usd: 0.04 }, 6900);
				this.emit('agent-done', { key, ok: true, error: '' }, 7000);
				return;
			}
			case 'agent_stop': {
				const key = String(args.key);
				// An investigation that is waiting for the user's OK has no events left to come, but is still running.
				const asking = this.demoAsk?.key === key;
				if (asking) {
					this.demoAsk = null;
				}
				if (this.pending.has(key) || asking) {
					this.pending.get(key)?.forEach((t) => clearTimeout(t));
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
			case 'claude_sessions':
				return args.id === DEMO_ID
					? [
							{ id: 'demo-cli-1', cwd: DEMO_ID, branch: 'main', title: 'Flaky upload test', prompt: 'The upload test fails about one run in ten on CI. Can you find out why?', lastPrompt: 'ok, make the fix', lastSaid: 'Fixed: the test waited on a timer instead of the upload promise. It passes 200 runs in a row now.', modified: Date.now() - 2 * 60_000 },
							{ id: 'demo-cli-2', cwd: DEMO_ID, branch: 'main', title: null, prompt: 'Explain how the queue retries failed jobs', lastPrompt: null, lastSaid: 'Failed jobs go back on the queue with an exponential delay, up to five times.', modified: Date.now() - 26 * 3_600_000 },
						]
					: [];
			case 'claude_open':
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
			case 'worktree_read':
				return demoReadFile(String(args.file ?? args.path));
			case 'write_file':
				return demoWriteFile(String(args.path), String(args.text));
			case 'format_tool':
			case 'format_file':
				return null; // the demo project brings no formatter of its own
			case 'files_list':
				return { paths: empty ? [] : demoFiles(), truncated: false };
			case 'files_search':
				return empty ? { matches: [], truncated: false } : demoSearch(String(args.pattern), args.options as SearchOptions, SEARCH_LIMIT);
			case 'project_templates':
			case 'project_create':
			case 'project_stop':
				return demoProject(cmd, args, (event, payload, delay) => this.emit(event, payload, delay));
			case 'files_create':
			case 'files_move':
			case 'files_duplicate':
			case 'files_trash':
			case 'files_import':
				return demoFileOp(cmd, args);
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
			case 'pr_list':
			case 'pr_view':
			case 'pr_review':
			case 'pr_comment':
			case 'pr_merge':
			case 'pr_fetch':
			case 'issue_create':
			case 'issue_comment':
			case 'issue_set_state':
			case 'ci_runs':
			case 'ci_rerun':
			case 'jira_issues':
			case 'jira_transition':
			case 'jira_comment':
				return demoHost(cmd, args, { empty, branch: this.branch, unpushed: this.ahead, onRemote: !!this.branchList.find((b) => b.isCurrent)?.upstream, remoteBranches: this.branchList.filter((b) => b.isRemote).map((b) => b.name.replace(/^[^/]+\//, '')), subjects: this.commits.filter((c) => c.unpushed || c.refs.some((r) => r.startsWith('origin/feature'))).map((c) => c.summary) });
			case 'ai_selected_diff': {
				const paths = (args.files as { path: string }[]).map((f) => f.path);
				return { text: paths.map((p) => DEMO_DIFFS[p] ?? '').join(''), truncated: false, recent: this.commits.slice(0, 8).map((c) => c.summary) } satisfies AiDiff;
			}
			case 'ai_commit_patch': {
				const c = this.commits.find((x) => x.hash === args.hash);
				return { text: `commit ${c?.shortHash ?? ''}\n\n${c?.summary ?? ''}\n\n${c?.body ?? ''}\n\n${DEMO_DIFFS['src/player/queue.ts']}${DEMO_DIFFS['src/player/repeat.ts']}`, truncated: false, recent: [] } satisfies AiDiff;
			}
			case 'ai_review_diff': {
				const scope = String(args.scope) as ReviewScope;
				const current = this.branchList.find((b) => b.isCurrent);
				const unpushed = this.commits.filter((c) => c.unpushed).map((c) => ({ hash: c.hash, summary: c.summary }));
				// The work in a checkout has no commits of its own here, and ends at the files as they are.
				const commits = scope === 'work' ? [] : scope === 'branch' ? this.commits.slice(0, 3).map((c) => ({ hash: c.hash, summary: c.summary })) : unpushed;
				const base = scope === 'work' ? String(args.base || this.commits[0].hash) : (this.commits.find((c) => !c.unpushed)?.hash ?? 'b'.repeat(40));
				const against = scope === 'work' ? base.slice(0, 7) : scope === 'branch' ? `origin/${String(args.base || 'main')}` : (current?.upstream ?? 'origin/main');
				if (empty || (scope !== 'work' && !commits.length)) {
					return { scope, text: '', truncated: false, base, head: scope === 'work' ? '' : base, against, commits: [], files: [] } satisfies ReviewDiff;
				}
				return {
					scope,
					text: DEMO_DIFFS['src/player/queue.ts'] + DEMO_DIFFS['src/player/repeat.ts'],
					truncated: false,
					base,
					head: scope === 'work' ? '' : this.commits[0].hash,
					against,
					commits,
					files: [
						{ path: 'src/player/queue.ts', oldPath: null, status: 'modified' },
						{ path: 'src/player/repeat.ts', oldPath: null, status: 'added' },
					],
				} satisfies ReviewDiff;
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
