/**
 * Working with the host from inside the app, beyond what HostStore does (listing issues, drafting a pull
 * request): browsing and reviewing pull requests, acting on issues, CI runs for the current branch, Jira,
 * and the notices that say which command-line tool to install. All of it goes through the user's own
 * signed-in tools (src-tauri/src/host_ops.rs); the app keeps no tokens.
 *
 * Reviews, comments, merges, new issues, state changes and re-runs publish something, so each runs only
 * from its own button. Nothing here calls them on its own.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal, computed, effect, untracked } from '@melodicdev/core/signals';
import { ToastService } from '@melodicdev/components/toast';
import { DialogService } from '@melodicdev/components/dialog';
import { BackendService, asAppError, type CiRun, type HostCli, type JiraIssue, type MergeMethod, type PrDetail, type PrScope, type PrSummary, type PrVerdict } from './backend.service';
import { RepoStore } from './repo.store';
import { HostStore } from './host.store';
export { jiraBranch, jiraKeyOf } from '../shared/jira';

type DialogId = Parameters<DialogService['close']>[0];

const CI_POLL_MS = 60_000;
const JIRA_KEY = 'studio.jira';
const DISMISSED_KEY = 'studio.notices.dismissed';

export interface JiraConfig {
	site: string;
	project: string;
}

function readJson<T>(key: string, fallback: T): T {
	try {
		return (JSON.parse(localStorage.getItem(key) ?? 'null') as T | null) ?? fallback;
	} catch {
		return fallback;
	}
}
function writeJson(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* per-viewer convenience only */
	}
}

@Injectable()
export class HostWorkStore {
	// ---- pull requests ----
	readonly prScope = signal<PrScope>('open');
	readonly prs = signal<PrSummary[]>([]);
	readonly prsLoading = signal(false);
	readonly prsError = signal<string | null>(null);
	readonly selectedPr = signal<string | null>(null);
	readonly prDetail = signal<PrDetail | null>(null);
	readonly prDetailLoading = signal(false);
	readonly reviewText = signal('');
	/** What is being sent right now: approve, request-changes, comment, merge, checkout. */
	readonly prBusy = signal<string>('');
	readonly mergeMethod = signal<MergeMethod>('squash');
	readonly deleteBranch = signal(true);
	readonly confirmMerge = signal(false);

	// ---- issue actions (the Issues dialog) ----
	readonly issueComment = signal('');
	readonly issueBusy = signal<string>('');
	readonly newIssue = signal<{ title: string; body: string; kind: string } | null>(null);

	// ---- CI for the current branch ----
	readonly runs = signal<CiRun[]>([]);
	readonly runsBranch = signal<string | null>(null);
	readonly runsLoading = signal(false);
	readonly ciState = computed<'pass' | 'fail' | 'pending' | ''>(() => {
		// The newest run of each pipeline decides; older ones are history.
		const latest = new Map<string, CiRun>();
		for (const r of this.runs()) {
			if (!latest.has(r.name)) {
				latest.set(r.name, r);
			}
		}
		const states = [...latest.values()].map((r) => r.state);
		return !states.length ? '' : states.includes('fail') ? 'fail' : states.includes('pending') ? 'pending' : 'pass';
	});

	// ---- Jira ----
	readonly jiraConfigs = signal<Record<string, JiraConfig>>(readJson(JIRA_KEY, {}));
	readonly jiraIssues = signal<JiraIssue[]>([]);
	readonly jiraLoading = signal(false);
	readonly jiraError = signal<string | null>(null);
	readonly jiraQuery = signal('');
	readonly selectedJira = signal<string | null>(null);
	readonly jiraComment = signal('');
	readonly jiraBusy = signal('');

	// ---- tools and notices ----
	readonly clis = signal<HostCli[] | null>(null);
	readonly clisLoading = signal(false);
	readonly dismissed = signal<string[]>(readJson(DISMISSED_KEY, []));

	private _prToken = 0;
	private _detailToken = 0;
	private _runsToken = 0;
	private _jiraToken = 0;
	private _ciTimer: ReturnType<typeof setInterval> | null = null;
	private _watching = false;
	private _jiraTimer: ReturnType<typeof setTimeout> | null = null;

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
	}
	private get host(): HostStore {
		return Injector.get(HostStore);
	}
	private get toast(): ToastService {
		return Injector.get(ToastService);
	}
	private get dialogs(): DialogService {
		return Injector.get(DialogService);
	}
	private get id(): string | null {
		return this.repos.repo()?.id ?? null;
	}

	private fail(e: unknown): void {
		this.toast.error(asAppError(e).message);
	}

	// ---- pull requests ------------------------------------------------------------

	openPulls(): void {
		if (!this.id) {
			return;
		}
		this.dialogs.open('host-pulls' as DialogId);
		void this.loadPrs();
	}

	closePulls(): void {
		this.dialogs.close('host-pulls' as DialogId);
	}

	setScope(scope: PrScope): void {
		this.prScope.set(scope);
		void this.loadPrs();
	}

	async loadPrs(): Promise<void> {
		const id = this.id;
		const token = ++this._prToken;
		if (!id) {
			return;
		}
		this.prsLoading.set(true);
		this.prsError.set(null);
		try {
			const cli = await this.host.loadCli();
			if (!cli?.signedIn) {
				this.prs.set([]);
				return;
			}
			const list = await this.backend.prList(id, this.prScope());
			if (token !== this._prToken || id !== this.id) {
				return;
			}
			this.prs.set(list);
			if (!list.some((p) => p.id === this.selectedPr())) {
				this.selectPr(list[0]?.id ?? null);
			}
		} catch (e) {
			if (token === this._prToken) {
				this.prs.set([]);
				this.prsError.set(asAppError(e).message);
			}
		} finally {
			if (token === this._prToken) {
				this.prsLoading.set(false);
			}
		}
	}

	selectPr(number: string | null): void {
		if (number === this.selectedPr() && this.prDetail()) {
			return;
		}
		this.selectedPr.set(number);
		this.reviewText.set(''); // a review typed for one pull request must not go to another
		this.confirmMerge.set(false);
		this.prDetail.set(null);
		if (number) {
			void this.loadDetail(number);
		}
	}

	async loadDetail(number: string): Promise<void> {
		const id = this.id;
		const token = ++this._detailToken;
		if (!id) {
			return;
		}
		this.prDetailLoading.set(true);
		try {
			const detail = await this.backend.prView(id, number);
			if (token === this._detailToken && this.selectedPr() === number) {
				this.prDetail.set(detail);
			}
		} catch (e) {
			if (token === this._detailToken) {
				this.fail(e);
			}
		} finally {
			if (token === this._detailToken) {
				this.prDetailLoading.set(false);
			}
		}
	}

	/** Approve, request changes or comment, from the review box. */
	async review(verdict: PrVerdict): Promise<void> {
		const id = this.id;
		const number = this.selectedPr();
		if (!id || !number || this.prBusy()) {
			return;
		}
		const body = this.reviewText().trim();
		this.prBusy.set(verdict);
		try {
			if (verdict === 'comment') {
				await this.backend.prComment(id, number, body);
			} else {
				await this.backend.prReview(id, number, verdict, body);
			}
			this.reviewText.set('');
			this.toast.success(verdict === 'approve' ? `Approved #${number}` : verdict === 'request-changes' ? `Asked for changes on #${number}` : 'Comment posted');
			await this.loadDetail(number);
			void this.loadPrs();
		} catch (e) {
			this.fail(e);
		} finally {
			this.prBusy.set('');
		}
	}

	async merge(): Promise<void> {
		const id = this.id;
		const number = this.selectedPr();
		if (!id || !number || this.prBusy()) {
			return;
		}
		this.prBusy.set('merge');
		try {
			await this.backend.prMerge(id, number, this.mergeMethod(), this.deleteBranch());
			this.confirmMerge.set(false);
			this.toast.success(`Merged #${number}`, 'Pull to bring it into your checkout.');
			await this.loadPrs();
			void this.repos.refresh();
		} catch (e) {
			this.fail(e);
		} finally {
			this.prBusy.set('');
		}
	}

	/**
	 * The pull request's branch in a worktree of its own (made once, then reused), and the app pointed at it.
	 * True when it is. `as` is the button that asked, which shows as busy meanwhile.
	 */
	async checkout(as: 'checkout' | 'claude' = 'checkout'): Promise<boolean> {
		const id = this.id;
		const number = this.selectedPr();
		if (!id || !number || this.prBusy()) {
			return false;
		}
		this.prBusy.set(as);
		try {
			const branch = await this.backend.prFetch(id, number);
			const trees = await this.backend.worktrees(id);
			const existing = trees.find((t) => t.branch === branch);
			const path = existing ? existing.path : await this.backend.addWorktree(id, branch, null);
			await this.backend.selectWorktree(id, existing?.isMain ? null : path);
			await this.repos.switchContext('changes');
			this.closePulls();
			this.toast.success(`#${number} is checked out`, `On ${branch}, in its own worktree.`);
			return true;
		} catch (e) {
			this.fail(e);
			return false;
		} finally {
			this.prBusy.set('');
		}
	}

	// ---- issues: acting on the selected one ---------------------------------------------

	async commentOnIssue(number: string): Promise<void> {
		const id = this.id;
		const body = this.issueComment().trim();
		if (!id || !body || this.issueBusy()) {
			return;
		}
		this.issueBusy.set('comment');
		try {
			await this.backend.issueComment(id, number, body);
			this.issueComment.set('');
			this.toast.success('Comment posted');
		} catch (e) {
			this.fail(e);
		} finally {
			this.issueBusy.set('');
		}
	}

	async setIssueOpen(number: string, open: boolean): Promise<void> {
		const id = this.id;
		if (!id || this.issueBusy()) {
			return;
		}
		this.issueBusy.set(open ? 'reopen' : 'close');
		try {
			await this.backend.issueSetState(id, number, open);
			this.toast.success(open ? `Reopened #${number}` : `Closed #${number}`);
			await this.host.loadIssues();
		} catch (e) {
			this.fail(e);
		} finally {
			this.issueBusy.set('');
		}
	}

	startNewIssue(): void {
		this.newIssue.set({ title: '', body: '', kind: this.repos.status()?.host?.provider === 'azure' ? 'Task' : '' });
	}

	editNewIssue(change: Partial<{ title: string; body: string; kind: string }>): void {
		const draft = this.newIssue();
		if (draft) {
			this.newIssue.set({ ...draft, ...change });
		}
	}

	async createIssue(): Promise<void> {
		const id = this.id;
		const draft = this.newIssue();
		if (!id || !draft?.title.trim() || this.issueBusy()) {
			return;
		}
		this.issueBusy.set('create');
		try {
			const made = await this.backend.issueCreate(id, draft.title, draft.body, draft.kind);
			this.newIssue.set(null);
			this.toast.success(`Created #${made.id}`);
			await this.host.loadIssues();
			this.host.selectIssue(made.id);
		} catch (e) {
			this.fail(e);
		} finally {
			this.issueBusy.set('');
		}
	}

	/** A branch for the issue, made from the current commit and checked out (no agent). */
	async branchFor(branch: string): Promise<void> {
		if (await this.repos.createBranch(branch.trim())) {
			this.toast.success(`On ${branch.trim()}`);
		}
	}

	// ---- CI -----------------------------------------------------------------------

	/** Keep the current branch's runs fresh: on a branch change, and every minute while one is running. */
	watch(): void {
		if (this._watching) {
			return;
		}
		this._watching = true;
		effect(() => {
			const st = this.repos.status();
			const key = st && st.host && !st.detached && st.upstream ? `${this.id}\n${st.branch}` : null;
			untracked(() => {
				if (key !== `${this.id}\n${this.runsBranch()}`) {
					void this.loadRuns();
				}
			});
		});
		this._ciTimer = setInterval(() => {
			if (this.ciState() === 'pending' && document.visibilityState === 'visible') {
				void this.loadRuns();
			}
		}, CI_POLL_MS);
	}

	async loadRuns(): Promise<void> {
		const id = this.id;
		const st = this.repos.status();
		const token = ++this._runsToken;
		const branch = st && st.host && !st.detached && st.upstream ? st.branch : null;
		this.runsBranch.set(branch);
		if (!id || !branch) {
			this.runs.set([]);
			return;
		}
		this.runsLoading.set(true);
		try {
			const runs = await this.backend.ciRuns(id, branch);
			if (token === this._runsToken) {
				this.runs.set(runs);
			}
		} catch {
			if (token === this._runsToken) {
				this.runs.set([]); // a status dot, not something to raise an error over
			}
		} finally {
			if (token === this._runsToken) {
				this.runsLoading.set(false);
			}
		}
	}

	async rerun(run: CiRun): Promise<void> {
		const id = this.id;
		if (!id) {
			return;
		}
		try {
			await this.backend.ciRerun(id, run);
			this.toast.success(`${run.name} started again`);
			setTimeout(() => void this.loadRuns(), 3000);
		} catch (e) {
			this.fail(e);
		}
	}

	stopWatching(): void {
		if (this._ciTimer) {
			clearInterval(this._ciTimer);
			this._ciTimer = null;
		}
	}

	// ---- Jira -----------------------------------------------------------------------

	jiraConfig(): JiraConfig | null {
		const id = this.id;
		const c = id ? this.jiraConfigs()[id] : undefined;
		return c && c.site && c.project ? c : null;
	}

	setJiraConfig(config: JiraConfig | null): void {
		const id = this.id;
		if (!id) {
			return;
		}
		const all = { ...this.jiraConfigs() };
		if (config && (config.site.trim() || config.project.trim())) {
			all[id] = { site: config.site.trim().replace(/^https:\/\//, '').replace(/\/$/, ''), project: config.project.trim().toUpperCase() };
		} else {
			delete all[id];
		}
		this.jiraConfigs.set(all);
		writeJson(JIRA_KEY, all);
	}

	openJira(): void {
		this.dialogs.open('host-jira' as DialogId);
		void this.loadJira();
	}

	closeJira(): void {
		this.dialogs.close('host-jira' as DialogId);
	}

	setJiraQuery(q: string): void {
		this.jiraQuery.set(q);
		if (this._jiraTimer) {
			clearTimeout(this._jiraTimer);
		}
		this._jiraTimer = setTimeout(() => void this.loadJira(), 400);
	}

	async loadJira(): Promise<void> {
		const config = this.jiraConfig();
		if (!config) {
			this.jiraIssues.set([]);
			return;
		}
		const token = ++this._jiraToken;
		this.jiraLoading.set(true);
		this.jiraError.set(null);
		try {
			const list = await this.backend.jiraIssues(config.site, config.project, this.jiraQuery().trim());
			if (token !== this._jiraToken) {
				return; // a newer search is on its way
			}
			this.jiraIssues.set(list);
			if (!list.some((i) => i.key === this.selectedJira())) {
				this.selectedJira.set(list[0]?.key ?? null);
			}
		} catch (e) {
			if (token === this._jiraToken) {
				this.jiraIssues.set([]);
				this.jiraError.set(asAppError(e).message);
			}
		} finally {
			if (token === this._jiraToken) {
				this.jiraLoading.set(false);
			}
		}
	}

	selectJira(key: string): void {
		if (key !== this.selectedJira()) {
			this.jiraComment.set('');
		}
		this.selectedJira.set(key);
	}

	async jiraMove(key: string, status: string): Promise<void> {
		if (!status.trim() || this.jiraBusy()) {
			return;
		}
		this.jiraBusy.set('move');
		try {
			await this.backend.jiraTransition(key, status);
			this.toast.success(`${key} moved to ${status}`);
			await this.loadJira();
		} catch (e) {
			this.fail(e);
		} finally {
			this.jiraBusy.set('');
		}
	}

	async jiraPostComment(key: string): Promise<void> {
		const body = this.jiraComment().trim();
		if (!body || this.jiraBusy()) {
			return;
		}
		this.jiraBusy.set('comment');
		try {
			await this.backend.jiraComment(key, body);
			this.jiraComment.set('');
			this.toast.success('Comment posted');
		} catch (e) {
			this.fail(e);
		} finally {
			this.jiraBusy.set('');
		}
	}

	// ---- tools and notices ------------------------------------------------------------

	async loadClis(force = false): Promise<HostCli[]> {
		const known = this.clis();
		if (known && !force) {
			return known;
		}
		this.clisLoading.set(true);
		try {
			const list = await this.backend.hostClis();
			this.clis.set(list);
			return list;
		} catch {
			this.clis.set([]);
			return [];
		} finally {
			this.clisLoading.set(false);
		}
	}

	dismiss(tool: string): void {
		const next = [...new Set([...this.dismissed(), tool])];
		this.dismissed.set(next);
		writeJson(DISMISSED_KEY, next);
	}

	undismissAll(): void {
		this.dismissed.set([]);
		writeJson(DISMISSED_KEY, []);
	}
}

// Built now rather than on first use: `computed()` hands itself to whichever component is
// rendering when it is created, and would be disposed with that component.
Injector.get(HostWorkStore);
