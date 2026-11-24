/**
 * App state, as signals. Components read these in their templates (Melodic
 * re-renders on every signal a template reads) and call the methods to act.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal, computed } from '@melodicdev/core/signals';
import { ToastService } from '@melodicdev/components/toast';
import { DialogService } from '@melodicdev/components/dialog';
import { BackendService, asAppError, type AppStatus, type Branch, type BranchCompare, type Commit, type FileChange, type RebaseStep, type Identities, type Identity, type OpenTarget, type RepoStatus, type RepoSummary, type ResetMode, type ScanResult } from './backend.service';
import { parseDiff, type ParsedDiff } from '../shared/diff';
import { fileName, plural } from '../shared/format';

export type Busy = '' | 'fetch' | 'pull' | 'push' | 'commit' | 'checkout' | 'branch' | 'repo' | 'discard' | 'undo' | 'merge' | 'stash' | 'history';
export type Tab = 'changes' | 'history' | 'files' | 'agents';
export type DialogName = 'add-repo' | 'new-branch' | 'rename-branch' | 'delete-branch' | 'merge-branch' | 'publish' | 'discard' | 'remove-repo' | 'settings' | 'new-tag' | 'reset' | 'force-push' | 'cherry-pick' | 'rebase-interactive' | 'new-project';

/** What a confirmation dialog is about. */
export interface Prompt {
	branch?: string;
	files?: FileChange[];
	repo?: RepoSummary;
	/** Which tab the Add repository dialog opens on. */
	tab?: 'add' | 'scan' | 'clone' | 'create';
	/** Which section Settings opens on. */
	settingsTab?: 'general' | 'editor' | 'accounts' | 'language-servers';
	/** Add repository dialog: open the result in a new tab instead of replacing the current one. */
	newTab?: boolean;
	/** A commit the dialog acts on (branch from, tag, reset to). */
	commit?: Commit;
	/** The branch in `branch` is a remote one. */
	remote?: boolean;
	/** Merge dialog: rebase onto the branch instead of merging it in. */
	rebase?: boolean;
	/** Merge dialog: open on "Squash and merge". */
	squash?: boolean;
	/** Interactive rebase: replay the commits after this ref (a branch, or the parent of `commit`); null is the whole branch. */
	upstream?: string | null;
	/** Commits to start with selected (cherry-pick), or to start as reword (interactive rebase). */
	hashes?: string[];
}

export interface SyncAction {
	kind: 'publish-repo' | 'publish-branch' | 'pull' | 'push' | 'fetch';
	label: string;
	detail: string;
	icon: string;
}

type DialogId = Parameters<DialogService['close']>[0];

const PAGE = 100;
const REPO_TABS_KEY = 'studio.repo-tabs';

/** The part of the screen worth remembering per repository tab. */
interface RepoView {
	tab: Tab;
	selectedPath: string | null;
	openTabs: string[];
	excluded: ReadonlySet<string>;
	summary: string;
	description: string;
}

function loadRepoTabs(): string[] {
	try {
		const ids = JSON.parse(localStorage.getItem(REPO_TABS_KEY) ?? '[]');
		return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
	} catch {
		return [];
	}
}
const POLL_MS = 5000;

@Injectable()
export class RepoStore {
	readonly ready = signal(false);
	readonly app = signal<AppStatus | null>(null);
	readonly status = signal<RepoStatus | null>(null);
	readonly statusError = signal<string | null>(null);
	readonly tab = signal<Tab>('files');
	readonly busy = signal<Busy>('');
	readonly prompt = signal<Prompt>({});

	// ---- changes ----
	/** Unchecked files. Tracking exclusions means a newly changed file starts checked. */
	readonly excluded = signal<ReadonlySet<string>>(new Set());
	readonly selectedPath = signal<string | null>(null);
	/** Files pinned as tabs above the diff, in the order they were opened. */
	readonly openTabs = signal<string[]>([]);
	/** The next commit replaces the last one instead of adding to it. */
	readonly amend = signal(false);
	/** Null while loading. */
	readonly diff = signal<ParsedDiff | null>(null);
	readonly summary = signal('');
	readonly description = signal('');

	// ---- history ----
	readonly commits = signal<Commit[]>([]);
	readonly historyLoaded = signal(false);
	readonly historyEnd = signal(false);
	readonly selectedHash = signal<string | null>(null);
	readonly commitFiles = signal<FileChange[]>([]);
	readonly selectedCommitPath = signal<string | null>(null);
	readonly commitDiff = signal<ParsedDiff | null>(null);

	readonly branches = signal<Branch[]>([]);

	// ---- comparing with another branch (History tab) ----
	/** The branch the History tab compares the current one with; null shows the plain history. */
	/** History tab: only the commits that touched this file. */
	readonly historyPath = signal<string | null>(null);
	readonly compareBranch = signal<string | null>(null);
	/** Which side of the comparison is listed: false = behind (what merging it would bring in), true = ahead. */
	readonly compareAhead = signal(false);
	readonly compareCommits = signal<Commit[]>([]);
	readonly compareLoaded = signal(false);
	readonly compareEnd = signal(false);
	/** Ahead/behind of the current branch against others, by branch name, as far as they have been counted. */
	readonly compareCounts = signal<Map<string, BranchCompare>>(new Map());

	/** Ids of the repositories open as tabs across the top, in order (see `repoTabList`). */
	readonly repoTabs = signal<string[]>(loadRepoTabs());
	/** The open tabs as repositories. The current repository is always one of them. */
	readonly repoTabList = computed<RepoSummary[]>(() => {
		const app = this.app();
		const repos = app?.repos ?? [];
		const list = this.repoTabs()
			.map((id) => repos.find((r) => r.id === id))
			.filter((r): r is RepoSummary => !!r);
		const current = repos.find((r) => r.id === app?.current);
		return current && !list.includes(current) ? [...list, current] : list;
	});
	/** The tab strip only appears once a second repository is open. */
	readonly showRepoTabs = computed(() => this.repoTabList().length > 1);
	/**
	 * The Agents page (`ms-agents-overview`): every repository's agents and Claude conversations on one
	 * page, in place of the open repository's sidebar and panes. Any tab or repository switch leaves it.
	 */
	readonly overview = signal(false);

	readonly repo = computed<RepoSummary | null>(() => {
		const app = this.app();
		return app?.repos.find((r) => r.id === app.current) ?? null;
	});
	readonly selectedFile = computed<FileChange | null>(() => this.status()?.files.find((f) => f.path === this.selectedPath()) ?? null);
	readonly includedFiles = computed<FileChange[]>(() => (this.status()?.files ?? []).filter((f) => !this.excluded().has(f.path)));
	readonly selectedCommit = computed<Commit | null>(() => {
		const hash = this.selectedHash();
		return (this.compareBranch() ? this.compareCommits() : this.commits()).find((c) => c.hash === hash) ?? null;
	});
	readonly selectedCommitFile = computed<FileChange | null>(() => this.commitFiles().find((f) => f.path === this.selectedCommitPath()) ?? null);

	/** The one toolbar button that fetches, pulls, pushes or publishes, whichever is next. */
	readonly sync = computed<SyncAction | null>(() => {
		const st = this.status();
		if (!st) {
			return null;
		}
		const remote = st.remote ?? 'origin';
		if (!st.remote) {
			return { kind: 'publish-repo', label: 'Publish repository', detail: 'Add a remote to push to', icon: 'cloud-arrow-up' };
		}
		if (!st.upstream && !st.detached) {
			return { kind: 'publish-branch', label: 'Publish branch', detail: `Push this branch to ${remote}`, icon: 'cloud-arrow-up' };
		}
		const fetched = st.lastFetched ? `Last fetched ${shortAgo(st.lastFetched)}` : 'Never fetched';
		if (st.behind > 0) {
			return { kind: 'pull', label: `Pull ${remote}`, detail: fetched, icon: 'arrow-down' };
		}
		if (st.ahead > 0) {
			return { kind: 'push', label: `Push ${remote}`, detail: fetched, icon: 'arrow-up' };
		}
		return { kind: 'fetch', label: `Fetch ${remote}`, detail: fetched, icon: 'arrows-clockwise' };
	});

	private _statusToken = 0;
	private _diffToken = 0;
	private _historyToken = 0;
	private _compareToken = 0;
	private _commitToken = 0;
	private _started = false;
	/** What each open repository was showing, so coming back to its tab picks up where it left off. */
	private readonly _views = new Map<string, RepoView>();
	/** Set by the tab strip's "+": the next repository opened goes in a new tab. */
	private _nextInNewTab = false;

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get toast(): ToastService {
		return Injector.get(ToastService);
	}
	private get dialogs(): DialogService {
		return Injector.get(DialogService);
	}
	private get id(): string | null {
		return this.repo()?.id ?? null;
	}

	// ---- lifecycle ----------------------------------------------------------

	async init(): Promise<void> {
		if (this._started) {
			return;
		}
		this._started = true;
		try {
			this.app.set(await this.backend.appStatus());
		} catch (e) {
			this.fail(e);
		}
		this.ready.set(true);
		await this.refresh();
		void this.loadBranches();
		window.addEventListener('focus', () => void this.refresh());
		setInterval(() => {
			if (document.visibilityState === 'visible' && !this.busy()) {
				void this.refresh();
			}
		}, POLL_MS);
	}

	private async reloadApp(): Promise<void> {
		this.app.set(await this.backend.appStatus());
	}

	/** The active checkout changed (a worktree was selected): forget everything and re-read it. */
	async switchContext(tab: Tab = 'files'): Promise<void> {
		this.resetRepoState();
		this.tab.set(tab);
		try {
			await this.reloadApp();
		} catch (e) {
			this.fail(e);
		}
		await this.refresh();
		void this.loadBranches();
	}

	private resetRepoState(): void {
		this._statusToken++;
		this._diffToken++;
		this._historyToken++;
		this._commitToken++;
		this.status.set(null);
		this.statusError.set(null);
		this.excluded.set(new Set());
		this.selectedPath.set(null);
		this.openTabs.set([]);
		this.amend.set(false);
		this.diff.set(null);
		this.summary.set('');
		this.description.set('');
		this.commits.set([]);
		this.historyLoaded.set(false);
		this.historyEnd.set(false);
		this.historyPath.set(null);
		this.selectedHash.set(null);
		this.commitFiles.set([]);
		this.selectedCommitPath.set(null);
		this.commitDiff.set(null);
		this.branches.set([]);
		this._compareToken++;
		this.compareBranch.set(null);
		this.compareAhead.set(false);
		this.compareCommits.set([]);
		this.compareLoaded.set(false);
		this.compareEnd.set(false);
		this.compareCounts.set(new Map());
		this.tab.set('files');
	}

	/** Re-read the working tree. Cheap enough to run on focus and on a timer. */
	async refresh(): Promise<void> {
		const id = this.id;
		if (!id) {
			this.status.set(null);
			return;
		}
		const token = ++this._statusToken;
		let st: RepoStatus;
		try {
			st = await this.backend.status(id);
		} catch (e) {
			if (token === this._statusToken) {
				this.status.set(null);
				this.statusError.set(asAppError(e).message);
			}
			return;
		}
		if (token !== this._statusToken || id !== this.id) {
			return;
		}
		const prev = this.status();
		this.statusError.set(null);
		if (!prev || JSON.stringify(prev) !== JSON.stringify(st)) {
			this.status.set(st);
		}

		const paths = new Set(st.files.map((f) => f.path));
		const excluded = this.excluded();
		if ([...excluded].some((p) => !paths.has(p))) {
			this.excluded.set(new Set([...excluded].filter((p) => paths.has(p))));
		}
		if (this.openTabs().some((p) => !paths.has(p))) {
			this.openTabs.set(this.openTabs().filter((p) => paths.has(p)));
		}
		if (!st.undo && this.amend()) {
			this.amend.set(false);
		}
		const selected = this.selectedPath();
		if (!selected || !paths.has(selected)) {
			this.selectedPath.set(st.files[0]?.path ?? null);
			this.diff.set(null);
		}
		await this.loadDiff();

		// Something moved HEAD outside the app (a terminal commit, a checkout).
		if (prev && (prev.head !== st.head || prev.branch !== st.branch)) {
			void this.loadBranches();
			if (this.historyLoaded()) {
				void this.loadHistory(true);
			}
			this.reloadCompare();
		}
	}

	private async reloadEverything(): Promise<void> {
		await this.refresh();
		void this.loadBranches();
		if (this.historyLoaded()) {
			void this.loadHistory(true);
		}
		this.reloadCompare();
	}

	// ---- errors -------------------------------------------------------------

	/** `pushed`: the failure is a push's. Only then can "rejected" mean the remote has moved on, which is what forcing is for. */
	fail(e: unknown, pushed = false): void {
		const err = asAppError(e);
		if (pushed && /\[rejected\]|non-fast-forward|fetch first|stale info/i.test(err.message)) {
			// The remote has commits this branch does not: after a pull that is fine, after an amend or rebase it needs a force.
			this.ask('force-push');
			return;
		}
		if (err.kind === 'conflict') {
			this.tab.set('changes');
			this.toast.warning('Merge conflicts', `${plural(err.paths?.length ?? 0, 'file')} need resolving. Resolve them, then press Continue in the Changes tab.`);
		} else if (err.kind === 'auth') {
			this.toast.error('Authentication failed', 'Git could not sign in to the remote. Check your SSH key or credential helper, then try again.');
		} else {
			this.toast.error('That did not work', err.message.length > 400 ? `${err.message.slice(0, 400)}…` : err.message);
		}
	}

	/** Run one exclusive operation, report failure, then re-read the repository. */
	private async act(busy: Busy, fn: (id: string) => Promise<void>, done?: string): Promise<boolean> {
		const id = this.id;
		if (!id || this.busy()) {
			return false;
		}
		this.busy.set(busy);
		let ok = true;
		try {
			await fn(id);
			if (done) {
				this.toast.success(done);
			}
		} catch (e) {
			ok = false;
			this.fail(e, busy === 'push');
		} finally {
			this.busy.set('');
		}
		await this.reloadEverything();
		return ok;
	}

	// ---- dialogs ------------------------------------------------------------

	ask(dialog: DialogName, prompt: Prompt = {}): void {
		if (dialog === 'add-repo') {
			this._nextInNewTab = !!prompt.newTab;
		}
		this.prompt.set(prompt);
		this.dialogs.open(dialog as DialogId);
	}

	closeDialog(dialog: DialogName): void {
		this.dialogs.close(dialog as DialogId);
	}

	// ---- repositories -------------------------------------------------------

	/** Switch repository: in the current tab, or (`newTab`) in a tab of its own. A repository already open in a tab is just switched to. */
	async selectRepo(id: string, newTab = false): Promise<void> {
		this.overview.set(false);
		const from = this.id;
		if (id === from) {
			return;
		}
		try {
			await this.backend.selectRepo(id);
			this.keepView(from);
			this.placeRepoTab(from, id, newTab);
			this.resetRepoState();
			await this.reloadApp();
			await this.restoreView(id);
			void this.loadBranches();
		} catch (e) {
			this.fail(e);
		}
	}

	// ---- repository tabs ----------------------------------------------------

	/** Show the Agents page; again (or `false`) goes back to the repository. */
	showOverview(show = !this.overview()): void {
		this.overview.set(show);
	}

	openRepoTab(id: string): Promise<void> {
		return this.selectRepo(id, true);
	}

	/** Close a tab. The repository stays in the list; closing the one in view moves to its neighbour. */
	async closeRepoTab(id: string): Promise<void> {
		const tabs = this.repoTabList().map((r) => r.id);
		const at = tabs.indexOf(id);
		if (at < 0 || tabs.length < 2) {
			return;
		}
		const rest = tabs.filter((t) => t !== id);
		this.setRepoTabs(rest);
		if (id === this.id) {
			await this.selectRepo(rest[Math.min(at, rest.length - 1)]);
		}
		// After the switch, which keeps the view of the repository it leaves: a closed tab starts clean next time.
		this._views.delete(id);
	}

	/** Move a tab to position `to` (dragged in the strip). */
	moveRepoTab(id: string, to: number): void {
		const tabs = this.repoTabList().map((r) => r.id);
		const from = tabs.indexOf(id);
		if (from < 0 || from === to) {
			return;
		}
		tabs.splice(from, 1);
		tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, id);
		this.setRepoTabs(tabs);
	}

	/** Next (1) or previous (-1) tab, wrapping round. */
	cycleRepoTab(step: 1 | -1): void {
		const tabs = this.repoTabList().map((r) => r.id);
		const at = tabs.indexOf(this.id ?? '');
		if (tabs.length > 1 && at >= 0) {
			void this.selectRepo(tabs[(at + step + tabs.length) % tabs.length]);
		}
	}

	private setRepoTabs(ids: string[]): void {
		this.repoTabs.set(ids);
		try {
			localStorage.setItem(REPO_TABS_KEY, JSON.stringify(ids));
		} catch {
			/* tabs still work until the window closes */
		}
	}

	/** Put `to` among the tabs: beside the others when asked for a new tab, otherwise in place of `from`. */
	private placeRepoTab(from: string | null, to: string, newTab: boolean): void {
		const tabs = this.repoTabList().map((r) => r.id);
		if (tabs.includes(to)) {
			return;
		}
		const at = from ? tabs.indexOf(from) : -1;
		if (newTab || at < 0) {
			this.setRepoTabs([...tabs, to]);
		} else {
			this._views.delete(from!);
			this.setRepoTabs(tabs.map((t) => (t === from ? to : t)));
		}
	}

	private keepView(id: string | null): void {
		if (id && this.status()) {
			this._views.set(id, {
				tab: this.tab(),
				selectedPath: this.selectedPath(),
				openTabs: this.openTabs(),
				excluded: this.excluded(),
				summary: this.summary(),
				description: this.description(),
			});
		}
	}

	/** Load the repository now current and put back what its tab was showing. Call after resetRepoState(). */
	private async restoreView(id: string): Promise<void> {
		const view = this._views.get(id);
		if (view) {
			this.excluded.set(view.excluded);
			this.openTabs.set(view.openTabs);
			this.summary.set(view.summary);
			this.description.set(view.description);
		}
		await this.refresh();
		if (view && id === this.id) {
			if (view.selectedPath && this.status()?.files.some((f) => f.path === view.selectedPath)) {
				this.selectFile(view.selectedPath);
			}
			this.setTab(view.tab);
		}
	}

	/** Add, clone or create; all three end with the new repository selected. */
	async openRepo(how: () => Promise<RepoSummary>): Promise<boolean> {
		if (this.busy()) {
			return false;
		}
		this.busy.set('repo');
		const from = this.id;
		const newTab = this._nextInNewTab;
		try {
			const opened = await how();
			// Used up only now: after a try that failed the dialog is still open, and the next try is the same request.
			this._nextInNewTab = false;
			this.overview.set(false);
			this.keepView(from);
			this.placeRepoTab(from, opened.id, newTab);
			this.resetRepoState();
			await this.reloadApp();
		} catch (e) {
			this.fail(e);
			return false;
		} finally {
			this.busy.set('');
		}
		await this.refresh();
		void this.loadBranches();
		return true;
	}

	addRepo(path: string): Promise<boolean> {
		return this.openRepo(() => this.backend.addRepo(path));
	}
	cloneRepo(url: string, parent: string): Promise<boolean> {
		return this.openRepo(() => this.backend.cloneRepo(url, parent));
	}
	createRepo(parent: string, name: string, readme: boolean): Promise<boolean> {
		return this.openRepo(() => this.backend.createRepo(parent, name, readme));
	}

	/** Repositories under `root`, for the user to pick from. Adds nothing. */
	async scanRepos(root: string): Promise<ScanResult | null> {
		try {
			return await this.backend.scanRepos(root);
		} catch (e) {
			this.fail(e);
			return null;
		}
	}

	/** Adds the repositories picked after a scan. The current repository stays, unless there was none. */
	async addRepos(paths: string[]): Promise<boolean> {
		if (this.busy() || paths.length === 0) {
			return false;
		}
		const hadRepo = !!this.id;
		this.busy.set('repo');
		try {
			const added = await this.backend.addRepos(paths);
			await this.reloadApp();
			this.toast.success(added === 0 ? 'Those repositories were already added' : `Added ${added} ${added === 1 ? 'repository' : 'repositories'}`);
		} catch (e) {
			this.fail(e);
			return false;
		} finally {
			this.busy.set('');
		}
		if (!hadRepo && this.id) {
			await this.refresh();
			void this.loadBranches();
		}
		return true;
	}

	async removeRepo(id: string): Promise<void> {
		try {
			const shown = id === this.id;
			await this.backend.removeRepo(id);
			this._views.delete(id);
			this.setRepoTabs(this.repoTabs().filter((t) => t !== id));
			if (shown) {
				// Another repository takes its place. Removing one that is not on screen leaves the open one as it is.
				this.resetRepoState();
			}
			await this.reloadApp();
			await this.refresh();
			void this.loadBranches();
		} catch (e) {
			this.fail(e);
		}
	}

	pickFolder(): Promise<string | null> {
		return this.backend.pickFolder().catch(() => null);
	}

	/** `repoId` opens a repository other than the current one. */
	async openIn(target: OpenTarget, arg: string | null = null, repoId: string | null = null): Promise<void> {
		const id = repoId ?? this.id;
		if (!id) {
			return;
		}
		try {
			await this.backend.openIn(id, target, arg);
		} catch (e) {
			this.fail(e);
		}
	}

	/** The global identity and the current repository's override. */
	async identities(): Promise<Identities | null> {
		try {
			return await this.backend.identity(this.id);
		} catch (e) {
			this.fail(e);
			return null;
		}
	}

	/** Save who commits: `global` everywhere (null: leave it alone), `repo` (null: none) for the current repository only. */
	async saveIdentities(global: Identity | null, repo: Identity | null): Promise<boolean> {
		try {
			const was = await this.backend.identity(this.id);
			const same = (a: Identity | null, b: Identity | null) => a?.name.trim() === b?.name.trim() && a?.email.trim() === b?.email.trim();
			if (global && !same(global, was.global)) {
				await this.backend.setIdentity(null, global);
				await this.reloadApp();
			}
			if (this.id && !same(repo, was.repo)) {
				await this.backend.setIdentity(this.id, repo);
			}
			return true;
		} catch (e) {
			this.fail(e);
			return false;
		}
	}

	// ---- changes ------------------------------------------------------------

	setTab(tab: Tab): void {
		this.overview.set(false);
		this.tab.set(tab);
		if (tab === 'history' && !this.historyLoaded()) {
			void this.loadHistory(true);
		}
	}

	selectFile(path: string): void {
		if (path === this.selectedPath()) {
			return;
		}
		this.selectedPath.set(path);
		this.diff.set(null);
		void this.loadDiff();
	}

	private async loadDiff(): Promise<void> {
		const id = this.id;
		const file = this.selectedFile();
		const token = ++this._diffToken;
		if (!id || !file) {
			this.diff.set(null);
			return;
		}
		try {
			const res = await this.backend.fileDiff(id, file);
			if (token !== this._diffToken) {
				return;
			}
			const current = this.diff();
			if (!current || current.raw !== res.text || current.tooLarge !== res.tooLarge) {
				this.diff.set(parseDiff(res.text, res.tooLarge));
			}
		} catch {
			if (token === this._diffToken) {
				this.diff.set(parseDiff(''));
			}
		}
	}

	/** Pin a file as a tab and show it. */
	openTab(path: string): void {
		if (!this.openTabs().includes(path)) {
			this.openTabs.set([...this.openTabs(), path]);
		}
		this.selectFile(path);
	}

	closeTab(path: string): void {
		const tabs = this.openTabs();
		const at = tabs.indexOf(path);
		if (at < 0) {
			return;
		}
		const rest = tabs.filter((p) => p !== path);
		this.openTabs.set(rest);
		if (path === this.selectedPath() && rest.length) {
			this.selectFile(rest[Math.min(at, rest.length - 1)]);
		}
	}

	toggleFile(path: string, include: boolean): void {
		const next = new Set(this.excluded());
		if (include) {
			next.delete(path);
		} else {
			next.add(path);
		}
		this.excluded.set(next);
	}

	toggleAll(include: boolean): void {
		this.excluded.set(include ? new Set() : new Set((this.status()?.files ?? []).map((f) => f.path)));
	}

	/** What the summary falls back to when one file is being committed, as a placeholder and a default. */
	defaultSummary(): string {
		const files = this.includedFiles();
		if (files.length !== 1) {
			return '';
		}
		const f = files[0];
		const verb = f.status === 'added' || f.status === 'untracked' ? 'Create' : f.status === 'deleted' ? 'Delete' : f.status === 'renamed' ? 'Rename' : 'Update';
		return `${verb} ${fileName(f.path)}`;
	}

	async commit(): Promise<void> {
		const files = this.includedFiles();
		const summary = this.summary().trim() || this.defaultSummary();
		const amend = this.amend();
		if ((!files.length && !amend) || !summary) {
			return;
		}
		const paths = files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
		const description = this.description();
		await this.act('commit', async (id) => {
			await this.backend.commit(id, paths, summary, description, amend);
			this.summary.set('');
			this.description.set('');
			this.amend.set(false);
		});
	}

	async undoCommit(): Promise<void> {
		await this.act('undo', async (id) => {
			const undone = await this.backend.undoCommit(id);
			this.summary.set(undone.summary);
			this.description.set(undone.description);
			this.tab.set('changes');
		});
	}

	/** Amending starts from the last commit's message. */
	setAmend(on: boolean): void {
		const undo = this.status()?.undo;
		this.amend.set(on && !!undo);
		if (on && undo && !this.summary().trim()) {
			this.summary.set(undo.summary);
			this.description.set(undo.description);
		}
	}

	resolveFile(path: string, side: 'mine' | 'theirs'): Promise<boolean> {
		return this.act('discard', (id) => this.backend.resolveFile(id, path, side));
	}

	ignoreFile(path: string): Promise<boolean> {
		return this.act('discard', (id) => this.backend.ignoreFile(id, path));
	}

	stash(): Promise<boolean> {
		return this.act('stash', (id) => this.backend.stashSave(id, this.summary().trim()), 'Changes stashed');
	}

	stashPop(name: string): Promise<boolean> {
		return this.act('stash', (id) => this.backend.stashPop(id, name));
	}

	stashDrop(name: string): Promise<boolean> {
		return this.act('stash', (id) => this.backend.stashDrop(id, name));
	}

	/** Carry on with, or give up on, a merge, rebase, cherry-pick or revert that stopped on conflicts. */
	continueOperation(): Promise<boolean> {
		return this.act('merge', (id) => this.backend.opContinue(id));
	}

	abortOperation(): Promise<boolean> {
		return this.act('merge', (id) => this.backend.opAbort(id));
	}

	// ---- acting on a commit ----

	revertCommit(hash: string): Promise<boolean> {
		return this.act('history', (id) => this.backend.revertCommit(id, hash), 'Commit reverted');
	}

	resetTo(hash: string, mode: ResetMode): Promise<boolean> {
		return this.act('history', (id) => this.backend.resetTo(id, hash, mode));
	}

	checkoutCommit(hash: string): Promise<boolean> {
		return this.act('checkout', (id) => this.backend.checkoutCommit(id, hash));
	}

	createTag(name: string, hash: string, push: boolean): Promise<boolean> {
		return this.act('history', (id) => this.backend.createTag(id, name, hash, push), `Tagged ${name}`);
	}

	deleteTag(name: string): Promise<boolean> {
		return this.act('history', (id) => this.backend.deleteTag(id, name));
	}

	async discard(files: FileChange[]): Promise<void> {
		await this.act('discard', (id) => this.backend.discard(id, files));
	}

	// ---- history ------------------------------------------------------------

	async loadHistory(reset: boolean): Promise<void> {
		const id = this.id;
		if (!id) {
			return;
		}
		const token = ++this._historyToken;
		const skip = reset ? 0 : this.commits().length;
		try {
			const page = await this.backend.history(id, skip, PAGE, this.historyPath());
			if (token !== this._historyToken) {
				return;
			}
			const commits = reset ? page : [...this.commits(), ...page];
			this.commits.set(commits);
			this.historyEnd.set(page.length < PAGE);
			this.historyLoaded.set(true);
			const selected = this.selectedHash();
			if (!this.compareBranch() && (!selected || !commits.some((c) => c.hash === selected))) {
				if (commits[0]) {
					this.selectCommit(commits[0].hash);
				} else {
					this.selectedHash.set(null);
					this.commitFiles.set([]);
					this.commitDiff.set(null);
				}
			}
		} catch (e) {
			if (token === this._historyToken) {
				this.historyLoaded.set(true);
				this.fail(e);
			}
		}
	}

	/** The History tab limited to one file's commits (null shows them all again). */
	async showFileHistory(path: string | null): Promise<void> {
		if (path && this.compareBranch()) {
			await this.setCompare(null);
		}
		this.historyPath.set(path);
		this.selectedHash.set(null);
		this.historyLoaded.set(false);
		if (path) {
			this.setTab('history');
		}
		await this.loadHistory(true);
	}

	// ---- comparing with another branch ---------------------------------------

	/** Compare the current branch with `branch` (null goes back to the plain history). Starts on whichever side has commits. */
	async setCompare(branch: string | null): Promise<void> {
		this._compareToken++;
		this.compareBranch.set(branch);
		this.compareCommits.set([]);
		this.compareLoaded.set(false);
		this.compareEnd.set(false);
		if (!branch) {
			const first = this.commits()[0];
			const selected = this.selectedHash();
			if (first && !this.commits().some((c) => c.hash === selected)) {
				this.selectCommit(first.hash);
			}
			return;
		}
		const known = this.compareCounts().get(branch);
		this.compareAhead.set(!!known && known.behind === 0 && known.ahead > 0);
		await Promise.all([this.loadCompare(true), this.loadCompareCounts([branch])]);
	}

	setCompareAhead(ahead: boolean): void {
		if (ahead !== this.compareAhead()) {
			this.compareAhead.set(ahead);
			void this.loadCompare(true);
		}
	}

	async loadCompare(reset: boolean): Promise<void> {
		const id = this.id;
		const branch = this.compareBranch();
		if (!id || !branch) {
			return;
		}
		const token = ++this._compareToken;
		const skip = reset ? 0 : this.compareCommits().length;
		try {
			const page = await this.backend.compareHistory(id, branch, this.compareAhead(), skip, PAGE);
			if (token !== this._compareToken) {
				return;
			}
			const commits = reset ? page : [...this.compareCommits(), ...page];
			this.compareCommits.set(commits);
			this.compareEnd.set(page.length < PAGE);
			this.compareLoaded.set(true);
			const selected = this.selectedHash();
			if (commits[0] && !commits.some((c) => c.hash === selected)) {
				this.selectCommit(commits[0].hash);
			} else if (!commits.length) {
				this.selectedHash.set(null);
				this.commitFiles.set([]);
				this.commitDiff.set(null);
			}
		} catch {
			if (token === this._compareToken) {
				// The branch is gone (deleted, pruned by a fetch): back to the plain history.
				void this.setCompare(null);
			}
		}
	}

	/** Count ahead/behind for the branches a list is about to show. */
	async loadCompareCounts(names: string[]): Promise<void> {
		const id = this.id;
		if (!id || !names.length) {
			return;
		}
		try {
			const counts = await this.backend.compareCounts(id, names.slice(0, 100));
			if (id !== this.id) {
				return;
			}
			const next = new Map(this.compareCounts());
			for (const c of counts) {
				next.set(c.name, c);
			}
			this.compareCounts.set(next);
		} catch {
			/* the counts are a hint; the list works without them */
		}
	}

	/** HEAD moved (commit, merge, pull, checkout): counts are stale, and the comparison is re-read. */
	private reloadCompare(): void {
		this.compareCounts.set(new Map());
		const branch = this.compareBranch();
		if (branch) {
			void this.loadCompare(true);
			void this.loadCompareCounts([branch]);
		}
	}

	selectCommit(hash: string): void {
		if (hash === this.selectedHash()) {
			return;
		}
		this.selectedHash.set(hash);
		this.commitFiles.set([]);
		this.selectedCommitPath.set(null);
		this.commitDiff.set(null);
		void this.loadCommit(hash);
	}

	private async loadCommit(hash: string): Promise<void> {
		const id = this.id;
		if (!id) {
			return;
		}
		const token = ++this._commitToken;
		try {
			const files = await this.backend.commitFiles(id, hash);
			if (token !== this._commitToken) {
				return;
			}
			this.commitFiles.set(files);
			if (files[0]) {
				this.selectCommitFile(files[0].path);
			} else {
				this.commitDiff.set(parseDiff(''));
			}
		} catch (e) {
			if (token === this._commitToken) {
				this.fail(e);
			}
		}
	}

	selectCommitFile(path: string): void {
		const id = this.id;
		const hash = this.selectedHash();
		const file = this.commitFiles().find((f) => f.path === path);
		if (!id || !hash || !file || path === this.selectedCommitPath()) {
			return;
		}
		this.selectedCommitPath.set(path);
		this.commitDiff.set(null);
		const token = ++this._commitToken;
		this.backend
			.commitDiff(id, hash, file)
			.then((res) => {
				if (token === this._commitToken) {
					this.commitDiff.set(parseDiff(res.text, res.tooLarge));
				}
			})
			.catch(() => {
				if (token === this._commitToken) {
					this.commitDiff.set(parseDiff(''));
				}
			});
	}

	// ---- branches -----------------------------------------------------------

	async loadBranches(): Promise<void> {
		const id = this.id;
		if (!id) {
			this.branches.set([]);
			return;
		}
		try {
			const branches = await this.backend.branches(id);
			if (id === this.id) {
				this.branches.set(branches);
			}
		} catch {
			/* the status error already explains a broken repository */
		}
	}

	checkout(branch: Branch): Promise<boolean> {
		return this.act('checkout', (id) => this.backend.checkout(id, branch.name, branch.isRemote));
	}

	createBranch(name: string, start: string | null = null): Promise<boolean> {
		return this.act('branch', (id) => this.backend.createBranch(id, name, start));
	}

	rebaseOnto(onto: string): Promise<boolean> {
		return this.act('merge', (id) => this.backend.rebaseOnto(id, onto), `Rebased onto ${onto}`);
	}

	deleteRemoteBranch(name: string): Promise<boolean> {
		return this.act('branch', (id) => this.backend.deleteRemoteBranch(id, name));
	}

	forcePush(): Promise<boolean> {
		return this.act('push', (id) => this.backend.push(id, true));
	}

	renameBranch(from: string, to: string): Promise<boolean> {
		return this.act('branch', (id) => this.backend.renameBranch(id, from, to));
	}

	/** Where deleting the checked-out branch `name` lands: the usual trunk names first, else the most recent other branch. */
	fallbackBranch(name: string): string | null {
		const locals = this.branches().filter((b) => !b.isRemote && b.name !== name).map((b) => b.name);
		return ['main', 'master', 'develop'].find((n) => locals.includes(n)) ?? locals[0] ?? null;
	}

	/**
	 * `unmerged` means git refused a safe delete; the dialog then offers to force it. The checked-out branch is left first.
	 * `remote` deletes the branch's copy on the remote (`Branch.published`) as well.
	 */
	async deleteBranch(name: string, force: boolean, remote = false): Promise<'ok' | 'unmerged' | 'failed'> {
		const id = this.id;
		if (!id || this.busy()) {
			return 'failed';
		}
		const st = this.status();
		const current = !!st && !st.detached && st.branch === name;
		const fallback = current ? this.fallbackBranch(name) : null;
		if (current && !fallback) {
			this.toast.error('That did not work', 'This is the only branch. Create another one before deleting it.');
			return 'failed';
		}
		this.busy.set('branch');
		try {
			if (fallback) {
				await this.backend.checkout(id, fallback, false);
			}
			await this.backend.deleteBranch(id, name, force, remote);
			return 'ok';
		} catch (e) {
			if (!force && /not fully merged/i.test(asAppError(e).message)) {
				return 'unmerged';
			}
			this.fail(e);
			return 'failed';
		} finally {
			this.busy.set('');
			void this.reloadEverything();
		}
	}

	/** Commits `branch` has that HEAD lacks, newest first (what merging or cherry-picking could bring in). */
	async incoming(branch: string): Promise<Commit[]> {
		const id = this.id;
		if (!id) {
			return [];
		}
		try {
			return await this.backend.compareHistory(id, branch, false, 0, 500);
		} catch (e) {
			this.fail(e);
			return [];
		}
	}

	/** Copy commits onto the current branch, oldest first. */
	cherryPick(hashes: string[]): Promise<boolean> {
		return this.act('merge', (id) => this.backend.cherryPick(id, hashes), hashes.length === 1 ? 'Commit cherry-picked' : `Cherry-picked ${plural(hashes.length, 'commit')}`);
	}

	/** Everything `from` brings as one commit. On conflicts the message waits in the commit form as well. */
	mergeSquash(from: string, message: string): Promise<boolean> {
		return this.act(
			'merge',
			async (id) => {
				try {
					await this.backend.mergeSquash(id, from, message);
				} catch (e) {
					if (asAppError(e).kind === 'conflict') {
						const [summary, ...rest] = message.trim().split('\n');
						this.summary.set(summary);
						this.description.set(rest.join('\n').trim());
					}
					throw e;
				}
			},
			`Squashed ${from} into one commit`,
		);
	}

	/** The commits an interactive rebase on `upstream` would replay, oldest first. Null when git refused. */
	async rebasePlan(upstream: string | null): Promise<Commit[] | null> {
		const id = this.id;
		if (!id) {
			return null;
		}
		try {
			return await this.backend.rebasePlan(id, upstream);
		} catch (e) {
			this.fail(e);
			return null;
		}
	}

	rebaseInteractive(upstream: string | null, steps: RebaseStep[]): Promise<boolean> {
		return this.act('merge', (id) => this.backend.rebaseInteractive(id, upstream, steps), 'History rewritten');
	}

	merge(from: string): Promise<boolean> {
		return this.act('merge', (id) => this.backend.merge(id, from).then(() => undefined), `Merged ${from}`);
	}

	// ---- remotes ------------------------------------------------------------

	async runSync(): Promise<void> {
		const action = this.sync();
		if (!action) {
			return;
		}
		switch (action.kind) {
			case 'publish-repo':
				this.ask('publish');
				return;
			case 'publish-branch':
			case 'push':
				await this.act('push', (id) => this.backend.push(id));
				return;
			case 'pull':
				await this.act('pull', (id) => this.backend.pull(id));
				return;
			case 'fetch':
				await this.act('fetch', (id) => this.backend.fetch(id));
				return;
		}
	}

	fetch(): Promise<boolean> {
		return this.act('fetch', (id) => this.backend.fetch(id));
	}

	/** Point `origin` at a URL and push the current branch to it. */
	publish(url: string): Promise<boolean> {
		return this.act(
			'push',
			async (id) => {
				await this.backend.setRemote(id, url);
				await this.backend.push(id);
			},
			'Published'
		);
	}
}

function shortAgo(ms: number): string {
	const m = Math.round((Date.now() - ms) / 60_000);
	if (m < 1) {
		return 'just now';
	}
	if (m < 60) {
		return `${m} min ago`;
	}
	const h = Math.round(m / 60);
	if (h < 24) {
		return `${h} hr ago`;
	}
	return `${Math.round(h / 24)} d ago`;
}
