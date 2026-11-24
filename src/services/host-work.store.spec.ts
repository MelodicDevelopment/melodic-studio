import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, world, type World } from '../test/world';
import type { RepoStore } from './repo.store';
import type { HostStore } from './host.store';
import type { HostWorkStore } from './host-work.store';
import type { CiRun, Host, HostCli, HostCliStatus, HostIssue, JiraIssue, PrDetail, PrSummary, RepoStatus, Worktree } from './backend.service';

// Monaco is the editor's: nothing here needs it, and loading the real one in every test's fresh app is slow and loud
// (HostStore brings the agents store with it, and that the language servers, which reach for the editor).
vi.mock('../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: () => Promise.resolve(), releaseMonacoStyles: () => undefined }));

const READY: HostCliStatus = { provider: 'github', hostName: 'GitHub', issuesLabel: 'Issues', pullsLabel: 'Pull requests', tool: 'gh', installed: true, signedIn: true, hint: null };
const SIGNED_OUT: HostCliStatus = { ...READY, signedIn: false, hint: 'Run `gh auth login` in a terminal to sign in to github.com.' };
const MISSING: HostCliStatus = { ...READY, installed: false, signedIn: false, hint: 'Install the GitHub CLI from https://cli.github.com, then run `gh auth login` in a terminal.' };
const HARMONY = '/Users/demo/Source/harmony';
const CADENCE = '/Users/demo/Source/cadence';
/** Everything that publishes something on a host. Each may only follow its own action. */
const WRITES = ['pr_review', 'pr_comment', 'pr_merge', 'pr_create', 'issue_create', 'issue_comment', 'issue_set_state', 'ci_rerun', 'jira_transition', 'jira_comment', 'host_repo_create'];

/** What the user's own tools answer. A test changes these before, or between, the calls it is about. */
interface Native {
	cli: HostCliStatus | null;
	prs: PrSummary[];
	trees: Worktree[];
	issues: HostIssue[];
	runs: CiRun[];
	jira: JiraIssue[];
	clis: HostCli[];
}

let w: World;
let repos: RepoStore;
let host: HostStore;
let work: HostWorkStore;
let native: Native;
let opened: string[];
let closed: string[];

function pr(id: string, title: string, extra: Partial<PrSummary> = {}): PrSummary {
	return { id, title, author: 'sam', head: `topic-${id}`, base: 'main', draft: false, state: 'open', updated: '2026-11-20T10:00:00Z', url: `https://github.com/demo/harmony/pull/${id}`, review: '', checks: 'pass', ...extra };
}

function detailOf(summary: PrSummary): PrDetail {
	return { summary, body: `What #${summary.id} does.`, notes: [], checks: [], files: [{ path: 'a.ts', additions: 1, deletions: 1 }], mergeable: true, crossRepo: false };
}

function issue(id: string, title: string): HostIssue {
	return { id, title, body: '', url: `https://github.com/demo/harmony/issues/${id}`, labels: [], assignee: null, state: 'open', updated: '2026-11-20T10:00:00Z', kind: 'issue' };
}

function run(id: string, name: string, state: CiRun['state'], extra: Partial<CiRun> = {}): CiRun {
	return { id, name, title: `Run ${id}`, state, url: `https://github.com/demo/harmony/actions/runs/${id}`, created: '2026-11-20T10:00:00Z', branch: 'feature/repeat-mode', definition: null, ...extra };
}

function ticket(key: string, title: string, status = 'To Do'): JiraIssue {
	return { key, title, body: '', status, kind: 'Task', assignee: null, updated: '2026-11-20T10:00:00Z', labels: [], url: `https://demo.atlassian.net/browse/${key}` };
}

function tree(path: string, branch: string, isMain = false): Worktree {
	return { path, branch, head: 'a'.repeat(40), isMain, active: isMain, changes: 0, landed: false };
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Answers the calls of `cmd` one after the other; the last answer stays for the calls after it. */
function inTurn(cmd: string, ...answers: unknown[]): void {
	let n = 0;
	w.on(cmd, () => answers[Math.min(n++, answers.length - 1)]);
}

/** Lets everything that is under way finish. The clock is ours in this file, so `settle()` would wait for ever. */
async function flush(): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await vi.advanceTimersByTimeAsync(0);
	}
}

/** What was published on a host so far, by command, in order. */
function written(): string[] {
	return w.calls.filter((c) => WRITES.includes(c.cmd)).map((c) => c.cmd);
}

/** The store says a failure in the toast's title. */
function errors(): string[] {
	return w.toasts.filter((t) => t.kind === 'error').map((t) => t.title);
}

function successes(): string[] {
	return w.toasts.filter((t) => t.kind === 'success').map((t) => t.title);
}

/** The status on screen with `change` over it, read by the store. */
async function statusIs(change: Partial<RepoStatus>): Promise<RepoStatus> {
	const next = { ...repos.status()!, ...change };
	w.on('repo_status', () => next);
	await repos.refresh();
	return next;
}

async function start(before?: () => void): Promise<void> {
	w = await world();
	native = {
		cli: READY,
		prs: [pr('131', 'Gapless repeat-one'), pr('129', 'Persist the queue', { author: 'me', draft: true }), pr('126', 'List the reorder shortcuts')],
		trees: [tree(HARMONY, 'feature/repeat-mode', true)],
		issues: [issue('214', 'Repeat-one restarts late'), issue('209', 'Remember the queue')],
		runs: [run('9001', 'CI', 'fail'), run('9000', 'Release', 'pass')],
		jira: [ticket('HAR-42', 'Crossfade between tracks'), ticket('HAR-40', 'Lyrics panel', 'In Progress')],
		clis: [
			{ provider: 'github', name: 'GitHub', cli: 'gh', installed: true, signedIn: true, account: 'me', hint: null },
			{ provider: 'gitlab', name: 'GitLab', cli: 'glab', installed: false, signedIn: false, account: null, hint: 'Install the GitLab CLI, then run `glab auth login` in a terminal.' },
		],
	};
	w.on('issues_status', () => {
		if (!native.cli) {
			throw appError('error', 'This repository has no remote on a host Melodic Studio knows');
		}
		return native.cli;
	});
	w.on('pr_list', ({ scope }) => (scope === 'mine' ? native.prs.filter((p) => p.author === 'me') : scope === 'review' ? native.prs.slice(0, 1) : native.prs));
	w.on('pr_view', ({ number }) => detailOf(native.prs.find((p) => p.id === number) ?? pr(String(number), 'Unlisted')));
	w.on('pr_fetch', ({ number }) => `topic-${String(number)}`);
	w.on('worktree_list', () => native.trees);
	w.on('worktree_add', ({ branch }) => `${HARMONY}.worktrees/${String(branch)}`);
	w.on('worktree_select', () => undefined);
	w.on('issues_list', () => native.issues);
	w.on('issue_create', ({ title }) => {
		native.issues = [issue('215', String(title)), ...native.issues];
		return { id: '215', url: 'https://github.com/demo/harmony/issues/215' };
	});
	w.on('ci_runs', () => native.runs);
	w.on('jira_issues', ({ query }) => native.jira.filter((j) => `${j.key} ${j.title}`.toLowerCase().includes(String(query).toLowerCase())));
	w.on('host_clis', () => native.clis);
	for (const cmd of ['pr_review', 'pr_comment', 'pr_merge', 'issue_comment', 'issue_set_state', 'ci_rerun', 'jira_transition', 'jira_comment']) {
		w.on(cmd, () => undefined);
	}
	before?.();
	const { DialogService } = await import('@melodicdev/components/dialog');
	const dialogs = w.get(DialogService);
	opened = [];
	closed = [];
	dialogs.open = ((id: string) => {
		opened.push(id);
		return undefined;
	}) as unknown as typeof dialogs.open;
	dialogs.close = ((id: string) => void closed.push(id)) as unknown as typeof dialogs.close;
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	host = w.get((await import('./host.store')).HostStore);
	work = w.get((await import('./host-work.store')).HostWorkStore);
}

beforeEach(async () => {
	vi.useFakeTimers();
	await start();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('the pull requests dialog', () => {
	test('lists the open ones and shows the first', async () => {
		work.openPulls();
		expect(opened).toEqual(['host-pulls']);
		expect(work.prsLoading()).toBe(true);
		await flush();
		expect(w.sent('pr_list')).toEqual([{ cmd: 'pr_list', args: { id: HARMONY, scope: 'open' } }]);
		expect(work.prs().map((p) => p.id)).toEqual(['131', '129', '126']);
		expect(work.selectedPr()).toBe('131');
		expect(w.sent('pr_view')).toEqual([{ cmd: 'pr_view', args: { id: HARMONY, number: '131' } }]);
		expect(work.prDetail()).toEqual(detailOf(native.prs[0]));
		expect(work.prsLoading()).toBe(false);
		expect(work.prDetailLoading()).toBe(false);
		expect(work.prsError()).toBeNull();
	});

	test('another scope is asked for when it is chosen', async () => {
		work.setScope('mine');
		await flush();
		expect(work.prScope()).toBe('mine');
		expect(w.sent('pr_list').at(-1)!.args.scope).toBe('mine');
		expect(work.prs().map((p) => p.id)).toEqual(['129']);
		work.setScope('review');
		await flush();
		expect(w.sent('pr_list').at(-1)!.args.scope).toBe('review');
	});

	test.each([
		['signed out', SIGNED_OUT],
		['not installed', MISSING],
	])('with the tool %s nothing is listed and the list is not asked for', async (_what, cli) => {
		native.cli = cli;
		work.openPulls();
		await flush();
		expect(work.prs()).toEqual([]);
		expect(w.sent('pr_list')).toEqual([]);
		expect(work.prsLoading()).toBe(false);
		expect(work.prsError()).toBeNull();
		expect(host.cli()!.hint).toBe(cli.hint);
	});

	test('a list the tool fails to give is said in the dialog', async () => {
		w.on('pr_list', () => { throw appError('error', 'HTTP 502 from api.github.com'); });
		await work.loadPrs();
		expect(work.prs()).toEqual([]);
		expect(work.prsError()).toBe('HTTP 502 from api.github.com');
		expect(work.prsLoading()).toBe(false);
		expect(w.toasts).toEqual([]);
	});

	test('with no repository open the dialog does not open', async () => {
		await start(() => w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: 'Me', authorEmail: 'me@example.com', appVersion: '1.0.0' })));
		work.openPulls();
		await flush();
		expect(opened).toEqual([]);
		expect(w.sent('pr_list')).toEqual([]);
	});

	test('the list of a scope left behind is dropped when it arrives late', async () => {
		await host.loadCli();
		const slow = deferred<PrSummary[]>();
		inTurn('pr_list', slow.promise, [pr('2', 'Asked second')]);
		work.setScope('mine');
		await flush();
		work.setScope('review');
		await flush();
		slow.resolve([pr('1', 'Asked first')]);
		await flush();
		expect(work.prs().map((p) => p.id)).toEqual(['2']);
		expect(work.prsLoading()).toBe(false);
	});

	test('pull requests of the repository left behind are not listed for the new one', async () => {
		await host.loadCli();
		const slow = deferred<PrSummary[]>();
		w.on('pr_list', () => slow.promise);
		const loading = work.loadPrs();
		await flush();
		await repos.selectRepo(CADENCE);
		slow.resolve([pr('1', 'From the other repository')]);
		await loading;
		expect(work.prs()).toEqual([]);
	});

	test('the one on screen stays while it is still listed', async () => {
		await work.loadPrs();
		work.selectPr('126');
		await flush();
		native.prs = [pr('140', 'A new one'), ...native.prs];
		await work.loadPrs();
		expect(work.selectedPr()).toBe('126');
		expect(work.prDetail()!.summary.id).toBe('126');
	});

	test('when it is gone from the list the first one is shown; an empty list shows none', async () => {
		await work.loadPrs();
		work.selectPr('126');
		await flush();
		native.prs = [pr('140', 'A new one')];
		await work.loadPrs();
		await flush();
		expect(work.selectedPr()).toBe('140');
		expect(work.prDetail()!.summary.id).toBe('140');
		native.prs = [];
		await work.loadPrs();
		expect(work.selectedPr()).toBeNull();
		expect(work.prDetail()).toBeNull();
	});

	test('selecting one shows nothing of the last until its own detail arrives', async () => {
		await work.loadPrs();
		await flush();
		const slow = deferred<PrDetail>();
		w.on('pr_view', () => slow.promise);
		work.selectPr('129');
		expect(work.selectedPr()).toBe('129');
		expect(work.prDetail()).toBeNull();
		await flush();
		expect(work.prDetailLoading()).toBe(true);
		slow.resolve(detailOf(native.prs[1]));
		await flush();
		expect(work.prDetail()!.summary.id).toBe('129');
		expect(work.prDetailLoading()).toBe(false);
	});

	test('the detail of one left behind is dropped when it arrives late', async () => {
		await work.loadPrs();
		await flush();
		const slow = deferred<PrDetail>();
		inTurn('pr_view', slow.promise, detailOf(native.prs[2]));
		work.selectPr('129');
		work.selectPr('126');
		await flush();
		slow.resolve(detailOf(native.prs[1]));
		await flush();
		expect(work.selectedPr()).toBe('126');
		expect(work.prDetail()!.summary.id).toBe('126');
	});

	test('selecting the one already shown reads nothing', async () => {
		await work.loadPrs();
		await flush();
		work.reviewText.set('Half a review');
		work.selectPr('131');
		await flush();
		expect(w.sent('pr_view').length).toBe(1);
		expect(work.reviewText()).toBe('Half a review');
	});

	test('a detail that cannot be read is said, and selecting it again tries again', async () => {
		let down = true;
		w.on('pr_view', ({ number }) => {
			if (down) {
				throw appError('error', 'HTTP 502 from api.github.com');
			}
			return detailOf(pr(String(number), 'Back again'));
		});
		await work.loadPrs();
		await flush();
		expect(errors()).toEqual(['HTTP 502 from api.github.com']);
		expect(work.prDetail()).toBeNull();
		expect(work.prDetailLoading()).toBe(false);
		down = false;
		work.selectPr('131');
		await flush();
		expect(work.prDetail()!.summary.title).toBe('Back again');
	});

	test('a review typed for one pull request does not go with another', async () => {
		await work.loadPrs();
		await flush();
		work.reviewText.set('Looks wrong to me');
		work.confirmMerge.set(true);
		work.selectPr('129');
		expect(work.reviewText()).toBe('');
		expect(work.confirmMerge()).toBe(false);
	});

	test('closing the dialog closes that dialog', () => {
		work.closePulls();
		expect(closed).toEqual(['host-pulls']);
	});
});

describe('reviewing, commenting and merging', () => {
	beforeEach(async () => {
		work.openPulls();
		await flush();
	});

	test('looking around publishes nothing', async () => {
		work.setScope('mine');
		await flush();
		work.setScope('open');
		await flush();
		work.selectPr('126');
		work.reviewText.set('I have thoughts');
		work.mergeMethod.set('rebase');
		work.deleteBranch.set(false);
		work.confirmMerge.set(true);
		await work.loadDetail('126');
		await work.loadPrs();
		work.closePulls();
		await flush();
		expect(written()).toEqual([]);
	});

	test('approving sends a review that approves, and nothing else', async () => {
		work.reviewText.set('  Ship it  ');
		await work.review('approve');
		expect(written()).toEqual(['pr_review']);
		expect(w.sent('pr_review')[0].args).toEqual({ id: HARMONY, number: '131', verdict: 'approve', body: 'Ship it' });
		expect(successes()).toEqual(['Approved #131']);
	});

	test('approving needs no words', async () => {
		await work.review('approve');
		expect(w.sent('pr_review')[0].args).toMatchObject({ verdict: 'approve', body: '' });
	});

	test('asking for changes sends a review that asks for them, and nothing else', async () => {
		work.reviewText.set('The queue is off by one');
		await work.review('request-changes');
		expect(written()).toEqual(['pr_review']);
		expect(w.sent('pr_review')[0].args).toEqual({ id: HARMONY, number: '131', verdict: 'request-changes', body: 'The queue is off by one' });
		expect(successes()).toEqual(['Asked for changes on #131']);
	});

	test('a comment is posted as a comment, not as a review', async () => {
		work.reviewText.set('Does this cover shuffle?');
		await work.review('comment');
		expect(written()).toEqual(['pr_comment']);
		expect(w.sent('pr_comment')[0].args).toEqual({ id: HARMONY, number: '131', body: 'Does this cover shuffle?' });
		expect(successes()).toEqual(['Comment posted']);
	});

	test('it goes to the pull request on screen', async () => {
		work.selectPr('126');
		await flush();
		await work.review('approve');
		expect(w.sent('pr_review')[0].args.number).toBe('126');
	});

	test('once sent the box is empty and the pull request and the list are read again', async () => {
		const before = { view: w.sent('pr_view').length, list: w.sent('pr_list').length };
		work.reviewText.set('Ship it');
		await work.review('approve');
		await flush();
		expect(work.reviewText()).toBe('');
		expect(work.prBusy()).toBe('');
		expect(w.sent('pr_view').length).toBe(before.view + 1);
		expect(w.sent('pr_list').length).toBe(before.list + 1);
	});

	test('a review the host refuses is said, and what was typed is kept', async () => {
		w.on('pr_review', () => { throw appError('error', 'You cannot approve your own pull request'); });
		work.reviewText.set('Ship it');
		await work.review('approve');
		expect(errors()).toEqual(['You cannot approve your own pull request']);
		expect(successes()).toEqual([]);
		expect(work.reviewText()).toBe('Ship it');
		expect(work.prBusy()).toBe('');
	});

	test('while one is on its way a second press, of any of the buttons, sends nothing', async () => {
		const slow = deferred();
		w.on('pr_review', () => slow.promise);
		const first = work.review('approve');
		expect(work.prBusy()).toBe('approve');
		await work.review('approve');
		await work.review('comment');
		await work.merge();
		expect(await work.checkout()).toBe(false);
		slow.resolve();
		await first;
		expect(written()).toEqual(['pr_review']);
		expect(w.sent('pr_fetch')).toEqual([]);
	});

	test('with no pull request on screen there is nothing to review or merge', async () => {
		work.selectPr(null);
		work.reviewText.set('To nobody');
		await work.review('approve');
		await work.review('comment');
		await work.merge();
		expect(written()).toEqual([]);
	});

	test('merging sends the merge, squashed and with the branch deleted unless chosen otherwise', async () => {
		await work.merge();
		expect(written()).toEqual(['pr_merge']);
		expect(w.sent('pr_merge')[0].args).toEqual({ id: HARMONY, number: '131', method: 'squash', deleteBranch: true });
	});

	test('merging goes the way that was chosen', async () => {
		work.mergeMethod.set('rebase');
		work.deleteBranch.set(false);
		await work.merge();
		expect(w.sent('pr_merge')[0].args).toEqual({ id: HARMONY, number: '131', method: 'rebase', deleteBranch: false });
	});

	test('a merge leaves the review box alone and posts no review', async () => {
		work.reviewText.set('Not sent');
		await work.merge();
		expect(written()).toEqual(['pr_merge']);
		expect(work.reviewText()).toBe('Not sent');
	});

	test('once merged it is said, the question is put away, and the list and the checkout are read again', async () => {
		work.confirmMerge.set(true);
		const before = { list: w.sent('pr_list').length, status: w.sent('repo_status').length };
		await work.merge();
		await flush();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Merged #131', message: 'Pull to bring it into your checkout.' });
		expect(work.confirmMerge()).toBe(false);
		expect(work.prBusy()).toBe('');
		expect(w.sent('pr_list').length).toBe(before.list + 1);
		expect(w.sent('repo_status').length).toBe(before.status + 1);
	});

	test('merging pulls nothing into the checkout by itself', async () => {
		await work.merge();
		await flush();
		expect(w.sent('pull')).toEqual([]);
		expect(w.sent('fetch')).toEqual([]);
	});

	test('a merge the host refuses is said and the question stays', async () => {
		w.on('pr_merge', () => { throw appError('error', 'Required status check "CI" is failing'); });
		work.confirmMerge.set(true);
		await work.merge();
		expect(errors()).toEqual(['Required status check "CI" is failing']);
		expect(successes()).toEqual([]);
		expect(work.confirmMerge()).toBe(true);
		expect(work.prBusy()).toBe('');
	});
});

describe('checking a pull request out', () => {
	beforeEach(async () => {
		work.openPulls();
		await flush();
		opened.length = 0;
	});

	test('fetches its branch into a worktree of its own and points the app at it', async () => {
		expect(await work.checkout()).toBe(true);
		expect(w.sent('pr_fetch')).toEqual([{ cmd: 'pr_fetch', args: { id: HARMONY, number: '131' } }]);
		expect(w.sent('worktree_add')).toEqual([{ cmd: 'worktree_add', args: { id: HARMONY, branch: 'topic-131', base: null } }]);
		expect(w.sent('worktree_select')).toEqual([{ cmd: 'worktree_select', args: { id: HARMONY, path: `${HARMONY}.worktrees/topic-131` } }]);
		expect(repos.tab()).toBe('changes');
		expect(closed).toEqual(['host-pulls']);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: '#131 is checked out', message: 'On topic-131, in its own worktree.' });
		expect(work.prBusy()).toBe('');
	});

	test('the app reads the repository again once it points at the worktree', async () => {
		const before = { app: w.sent('app_status').length, status: w.sent('repo_status').length };
		await work.checkout();
		expect(w.sent('app_status').length).toBe(before.app + 1);
		expect(w.sent('repo_status').length).toBe(before.status + 1);
		const order = w.calls.map((c) => c.cmd).filter((c) => c === 'worktree_select' || c === 'app_status');
		expect(order.at(-1)).toBe('app_status');
	});

	test('a worktree that is already there for the branch is used again, not made again', async () => {
		native.trees = [...native.trees, tree('/somewhere/else/topic-131', 'topic-131')];
		expect(await work.checkout()).toBe(true);
		expect(w.sent('worktree_add')).toEqual([]);
		expect(w.sent('worktree_select')[0].args).toEqual({ id: HARMONY, path: '/somewhere/else/topic-131' });
	});

	test('a branch the main checkout is on goes back to the main checkout', async () => {
		native.trees = [tree(HARMONY, 'topic-131', true)];
		expect(await work.checkout()).toBe(true);
		expect(w.sent('worktree_add')).toEqual([]);
		expect(w.sent('worktree_select')[0].args).toEqual({ id: HARMONY, path: null });
	});

	test('it publishes nothing and merges nothing', async () => {
		await work.checkout();
		await flush();
		expect(written()).toEqual([]);
		expect(w.sent('merge_branch')).toEqual([]);
		expect(w.sent('push')).toEqual([]);
	});

	test('the button that asked shows as busy meanwhile', async () => {
		const slow = deferred<string>();
		w.on('pr_fetch', () => slow.promise);
		const going = work.checkout('claude');
		expect(work.prBusy()).toBe('claude');
		slow.resolve('topic-131');
		await going;
		expect(work.prBusy()).toBe('');
	});

	test('a pull request that cannot be fetched is said, and the app stays where it is', async () => {
		w.on('pr_fetch', () => { throw appError('git', 'could not read from remote repository'); });
		repos.setTab('history');
		expect(await work.checkout()).toBe(false);
		expect(errors()).toEqual(['could not read from remote repository']);
		expect(w.sent('worktree_add')).toEqual([]);
		expect(w.sent('worktree_select')).toEqual([]);
		expect(closed).toEqual([]);
		expect(repos.tab()).toBe('history');
		expect(work.prBusy()).toBe('');
	});

	test('a worktree that cannot be made is said, and nothing is selected', async () => {
		w.on('worktree_add', () => { throw appError('git', 'topic-131 is already checked out elsewhere'); });
		expect(await work.checkout()).toBe(false);
		expect(w.sent('worktree_select')).toEqual([]);
		expect(closed).toEqual([]);
	});
});

describe('acting on an issue', () => {
	test('typing publishes nothing', async () => {
		host.openIssues();
		await flush();
		work.issueComment.set('A thought');
		work.startNewIssue();
		work.editNewIssue({ title: 'Something new', body: 'About it' });
		host.selectIssue('209');
		await flush();
		expect(written()).toEqual([]);
	});

	describe('a comment', () => {
		test('is posted on the issue it was asked for, and nothing else', async () => {
			work.issueComment.set('  Still happens on 2.1  ');
			await work.commentOnIssue('214');
			expect(written()).toEqual(['issue_comment']);
			expect(w.sent('issue_comment')[0].args).toEqual({ id: HARMONY, number: '214', body: 'Still happens on 2.1' });
			expect(work.issueComment()).toBe('');
			expect(successes()).toEqual(['Comment posted']);
			expect(work.issueBusy()).toBe('');
		});

		test('with nothing typed is not posted', async () => {
			work.issueComment.set('   ');
			await work.commentOnIssue('214');
			expect(written()).toEqual([]);
		});

		test('the host refuses is said, and what was typed is kept', async () => {
			w.on('issue_comment', () => { throw appError('error', 'This issue is locked'); });
			work.issueComment.set('Still happens');
			await work.commentOnIssue('214');
			expect(errors()).toEqual(['This issue is locked']);
			expect(work.issueComment()).toBe('Still happens');
			expect(work.issueBusy()).toBe('');
		});

		test('is posted once, however often the button is pressed meanwhile', async () => {
			const slow = deferred();
			w.on('issue_comment', () => slow.promise);
			work.issueComment.set('Once');
			const first = work.commentOnIssue('214');
			expect(work.issueBusy()).toBe('comment');
			await work.commentOnIssue('214');
			await work.setIssueOpen('214', false);
			slow.resolve();
			await first;
			expect(written()).toEqual(['issue_comment']);
		});
	});

	describe('closing and reopening', () => {
		test('closing sets that issue closed, and the list is read again', async () => {
			await host.loadIssues();
			const before = w.sent('issues_list').length;
			await work.setIssueOpen('214', false);
			expect(written()).toEqual(['issue_set_state']);
			expect(w.sent('issue_set_state')[0].args).toEqual({ id: HARMONY, number: '214', open: false });
			expect(successes()).toEqual(['Closed #214']);
			expect(w.sent('issues_list').length).toBe(before + 1);
			expect(work.issueBusy()).toBe('');
		});

		test('reopening sets it open', async () => {
			await work.setIssueOpen('214', true);
			expect(w.sent('issue_set_state')[0].args).toEqual({ id: HARMONY, number: '214', open: true });
			expect(successes()).toEqual(['Reopened #214']);
		});

		test('a change the host refuses is said, and nothing is called closed', async () => {
			w.on('issue_set_state', () => { throw appError('error', 'You do not have permission to close issues here'); });
			await work.setIssueOpen('214', false);
			expect(errors()).toEqual(['You do not have permission to close issues here']);
			expect(successes()).toEqual([]);
			expect(work.issueBusy()).toBe('');
		});

		test('it posts no comment, whatever is in the box', async () => {
			work.issueComment.set('Closing as fixed');
			await work.setIssueOpen('214', false);
			expect(written()).toEqual(['issue_set_state']);
			expect(work.issueComment()).toBe('Closing as fixed');
		});
	});

	describe('a new one', () => {
		test('starts as an empty form', () => {
			expect(work.newIssue()).toBeNull();
			work.startNewIssue();
			expect(work.newIssue()).toEqual({ title: '', body: '', kind: '' });
		});

		test('on Azure DevOps it starts as a Task', async () => {
			await statusIs({ host: { ...repos.status()!.host!, provider: 'azure' } as Host });
			work.startNewIssue();
			expect(work.newIssue()!.kind).toBe('Task');
		});

		test('what is typed is kept field by field', () => {
			work.startNewIssue();
			work.editNewIssue({ title: 'Seek bar jumps' });
			work.editNewIssue({ body: 'After a long pause.', kind: 'Bug' });
			expect(work.newIssue()).toEqual({ title: 'Seek bar jumps', body: 'After a long pause.', kind: 'Bug' });
		});

		test('with no form open there is nothing to type into or to create', async () => {
			work.editNewIssue({ title: 'Nowhere to go' });
			expect(work.newIssue()).toBeNull();
			await work.createIssue();
			expect(written()).toEqual([]);
		});

		test('Create makes it with what was typed, and nothing else', async () => {
			work.startNewIssue();
			work.editNewIssue({ title: 'Seek bar jumps', body: 'After a long pause.', kind: 'Bug' });
			await work.createIssue();
			expect(written()).toEqual(['issue_create']);
			expect(w.sent('issue_create')[0].args).toEqual({ id: HARMONY, title: 'Seek bar jumps', body: 'After a long pause.', kind: 'Bug' });
		});

		test('once made, the form goes, it is said, and the new issue is the one on screen', async () => {
			work.startNewIssue();
			work.editNewIssue({ title: 'Seek bar jumps' });
			await work.createIssue();
			expect(work.newIssue()).toBeNull();
			expect(successes()).toEqual(['Created #215']);
			expect(host.issues()[0].id).toBe('215');
			expect(host.selectedIssueId()).toBe('215');
			expect(work.issueBusy()).toBe('');
		});

		test('without a title it is not made', async () => {
			work.startNewIssue();
			work.editNewIssue({ title: '   ', body: 'A body alone is not an issue' });
			await work.createIssue();
			expect(written()).toEqual([]);
			expect(work.newIssue()).not.toBeNull();
		});

		test('one the host refuses is said, and the form keeps what was typed', async () => {
			w.on('issue_create', () => { throw appError('error', 'Issues are disabled for this repository'); });
			work.startNewIssue();
			work.editNewIssue({ title: 'Seek bar jumps', body: 'After a long pause.' });
			await work.createIssue();
			expect(errors()).toEqual(['Issues are disabled for this repository']);
			expect(work.newIssue()).toEqual({ title: 'Seek bar jumps', body: 'After a long pause.', kind: '' });
			expect(work.issueBusy()).toBe('');
		});

		test('it is made once, however often Create is pressed meanwhile', async () => {
			const slow = deferred<{ id: string; url: string }>();
			w.on('issue_create', () => slow.promise);
			work.startNewIssue();
			work.editNewIssue({ title: 'Once' });
			const first = work.createIssue();
			expect(work.issueBusy()).toBe('create');
			await work.createIssue();
			slow.resolve({ id: '215', url: 'https://github.com/demo/harmony/issues/215' });
			await first;
			expect(written()).toEqual(['issue_create']);
		});
	});

	describe('a branch for it', () => {
		test('is made from the commit on screen and checked out, with no agent and no worktree', async () => {
			await work.branchFor('  issue/214-repeat-one-restarts-late ');
			expect(w.sent('branch_create')).toEqual([{ cmd: 'branch_create', args: { id: HARMONY, name: 'issue/214-repeat-one-restarts-late', start: null } }]);
			expect(successes()).toEqual(['On issue/214-repeat-one-restarts-late']);
			expect(w.sent('worktree_add')).toEqual([]);
			expect(w.sent('agent_start')).toEqual([]);
			expect(written()).toEqual([]);
		});

		test('one that cannot be made is said, and is not called checked out', async () => {
			w.on('branch_create', () => { throw appError('git', 'a branch named issue/214 already exists'); });
			await work.branchFor('issue/214');
			expect(successes()).toEqual([]);
			expect(w.toasts.filter((t) => t.kind === 'error').length).toBe(1);
		});
	});
});

describe('the branch\'s check runs', () => {
	const reads = () => w.sent('ci_runs').length;

	test('are read for the branch on screen', async () => {
		await work.loadRuns();
		expect(w.sent('ci_runs')).toEqual([{ cmd: 'ci_runs', args: { id: HARMONY, branch: 'feature/repeat-mode' } }]);
		expect(work.runs()).toEqual(native.runs);
		expect(work.runsBranch()).toBe('feature/repeat-mode');
		expect(work.runsLoading()).toBe(false);
	});

	test.each<[string, Partial<RepoStatus>]>([
		['a branch that was never pushed', { upstream: null }],
		['a detached HEAD', { detached: true }],
		['a repository with no host', { host: null }],
	])('%s has none, and none are asked for', async (_what, change) => {
		await work.loadRuns();
		const before = reads();
		await statusIs(change);
		await work.loadRuns();
		expect(reads()).toBe(before);
		expect(work.runs()).toEqual([]);
		expect(work.runsBranch()).toBeNull();
		expect(work.ciState()).toBe('');
	});

	test.each<[string, CiRun[], string]>([
		['no runs', [], ''],
		['every pipeline passing', [run('3', 'CI', 'pass'), run('2', 'Release', 'pass')], 'pass'],
		['a pipeline whose newest run fails', [run('3', 'CI', 'fail'), run('2', 'CI', 'pass'), run('1', 'Release', 'pass')], 'fail'],
		['a pipeline that failed before and passes now', [run('3', 'CI', 'pass'), run('2', 'CI', 'fail')], 'pass'],
		['a pipeline still running', [run('3', 'CI', 'pass'), run('2', 'Release', 'pending')], 'pending'],
		['one failing and one still running', [run('3', 'CI', 'pending'), run('2', 'Release', 'fail')], 'fail'],
		['a run that passed before and runs again', [run('3', 'CI', 'pending'), run('2', 'CI', 'pass')], 'pending'],
	])('with %s the state is "%s"', async (_what, runs, state) => {
		native.runs = runs;
		await work.loadRuns();
		expect(work.ciState()).toBe(state);
	});

	test('runs that cannot be read show as none, without an error', async () => {
		await work.loadRuns();
		w.on('ci_runs', () => { throw appError('error', 'HTTP 502 from api.github.com'); });
		await work.loadRuns();
		expect(work.runs()).toEqual([]);
		expect(work.ciState()).toBe('');
		expect(work.runsLoading()).toBe(false);
		expect(w.toasts).toEqual([]);
	});

	test('an older answer that arrives late is dropped', async () => {
		const slow = deferred<CiRun[]>();
		inTurn('ci_runs', slow.promise, [run('2', 'CI', 'pass')]);
		const first = work.loadRuns();
		await work.loadRuns();
		slow.resolve([run('1', 'CI', 'fail')]);
		await first;
		expect(work.runs().map((r) => r.id)).toEqual(['2']);
		expect(work.runsLoading()).toBe(false);
	});

	describe('running one again', () => {
		test('asks for that run, and nothing else', async () => {
			await work.rerun(native.runs[0]);
			expect(written()).toEqual(['ci_rerun']);
			expect(w.sent('ci_rerun')[0].args).toEqual({ id: HARMONY, run: '9001', definition: null, branch: 'feature/repeat-mode' });
			expect(successes()).toEqual(['CI started again']);
		});

		test('an Azure pipeline goes by its definition and branch', async () => {
			await work.rerun(run('77', 'Build', 'fail', { definition: '12', branch: 'release/1.4' }));
			expect(w.sent('ci_rerun')[0].args).toEqual({ id: HARMONY, run: '77', definition: '12', branch: 'release/1.4' });
		});

		test('the runs are read again three seconds later, when the host knows about the new one', async () => {
			await work.rerun(native.runs[0]);
			const before = reads();
			await vi.advanceTimersByTimeAsync(2_999);
			expect(reads()).toBe(before);
			await vi.advanceTimersByTimeAsync(1);
			expect(reads()).toBe(before + 1);
		});

		test('a re-run the host refuses is said, and nothing is read again for it', async () => {
			w.on('ci_rerun', () => { throw appError('error', 'This run is too old to run again'); });
			await work.rerun(native.runs[0]);
			expect(errors()).toEqual(['This run is too old to run again']);
			expect(successes()).toEqual([]);
			const before = reads();
			await vi.advanceTimersByTimeAsync(4_000);
			expect(reads()).toBe(before);
		});
	});

	describe('kept fresh', () => {
		test('they are read as soon as the watching starts', async () => {
			work.watch();
			await flush();
			expect(reads()).toBe(1);
			expect(work.runs()).toEqual(native.runs);
		});

		test('starting the watch twice reads them once', async () => {
			work.watch();
			work.watch();
			await flush();
			expect(reads()).toBe(1);
		});

		test('they are read again when another branch is checked out', async () => {
			work.watch();
			await flush();
			await statusIs({ branch: 'main', upstream: 'origin/main' });
			await flush();
			expect(reads()).toBe(2);
			expect(w.sent('ci_runs').at(-1)!.args.branch).toBe('main');
			expect(work.runsBranch()).toBe('main');
		});

		test('a status that says nothing new about the branch reads nothing', async () => {
			work.watch();
			await flush();
			await statusIs({ ahead: 5, files: [] });
			await flush();
			expect(reads()).toBe(1);
		});

		test('a branch that loses its upstream shows no runs', async () => {
			work.watch();
			await flush();
			await statusIs({ upstream: null });
			await flush();
			expect(work.runs()).toEqual([]);
			expect(reads()).toBe(1);
		});

		test('a repository with no host shows none of the last one\'s', async () => {
			work.watch();
			await flush();
			expect(work.ciState()).toBe('fail');
			await repos.selectRepo(CADENCE);
			await flush();
			expect(work.runs()).toEqual([]);
			expect(work.ciState()).toBe('');
		});

		test('while a run is still going they are read every minute, and no longer once it has ended', async () => {
			native.runs = [run('3', 'CI', 'pending')];
			work.watch();
			await flush();
			expect(work.ciState()).toBe('pending');
			await vi.advanceTimersByTimeAsync(59_999);
			expect(reads()).toBe(1);
			native.runs = [run('3', 'CI', 'pass')];
			await vi.advanceTimersByTimeAsync(1);
			await flush();
			expect(reads()).toBe(2);
			expect(work.ciState()).toBe('pass');
			await vi.advanceTimersByTimeAsync(180_000);
			expect(reads()).toBe(2);
		});

		test('nothing is read on the minute while the window is hidden', async () => {
			native.runs = [run('3', 'CI', 'pending')];
			work.watch();
			await flush();
			vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
			await vi.advanceTimersByTimeAsync(180_000);
			expect(reads()).toBe(1);
		});

		test('the minute reads end when the watching is stopped', async () => {
			native.runs = [run('3', 'CI', 'pending')];
			work.watch();
			await flush();
			work.stopWatching();
			work.stopWatching();
			await vi.advanceTimersByTimeAsync(180_000);
			expect(reads()).toBe(1);
		});

		test('watching starts no run', async () => {
			native.runs = [run('3', 'CI', 'fail'), run('2', 'Release', 'pending')];
			work.watch();
			await vi.advanceTimersByTimeAsync(180_000);
			await statusIs({ branch: 'main', upstream: 'origin/main' });
			await flush();
			expect(written()).toEqual([]);
		});
	});
});

describe('Jira', () => {
	const kept = () => JSON.parse(localStorage.getItem('studio.jira') ?? 'null') as Record<string, unknown> | null;
	const reads = () => w.sent('jira_issues').length;

	describe('where a repository\'s issues are', () => {
		test('is nowhere until it is said', () => {
			expect(work.jiraConfig()).toBeNull();
			expect(localStorage.getItem('studio.jira')).toBeNull();
		});

		test('the site and the project are kept for the repository on screen, tidied', () => {
			work.setJiraConfig({ site: ' https://demo.atlassian.net/ ', project: ' har ' });
			expect(work.jiraConfig()).toEqual({ site: 'demo.atlassian.net', project: 'HAR' });
			expect(kept()).toEqual({ [HARMONY]: { site: 'demo.atlassian.net', project: 'HAR' } });
		});

		test('nothing but the site and the project is kept: no account, no token', () => {
			work.setJiraConfig({ site: 'demo.atlassian.net', project: 'HAR', ...({ token: 'secret', account: 'me@example.com' } as object) });
			expect(Object.keys(kept()![HARMONY] as object).sort()).toEqual(['project', 'site']);
			expect(localStorage.getItem('studio.jira')).not.toContain('secret');
		});

		test('each repository has its own', async () => {
			work.setJiraConfig({ site: 'demo.atlassian.net', project: 'HAR' });
			await repos.selectRepo(CADENCE);
			expect(work.jiraConfig()).toBeNull();
			work.setJiraConfig({ site: 'other.atlassian.net', project: 'CAD' });
			expect(kept()).toEqual({ [HARMONY]: { site: 'demo.atlassian.net', project: 'HAR' }, [CADENCE]: { site: 'other.atlassian.net', project: 'CAD' } });
			await repos.selectRepo(HARMONY);
			expect(work.jiraConfig()).toEqual({ site: 'demo.atlassian.net', project: 'HAR' });
		});

		test.each([
			['no answer at all', null],
			['both fields left empty', { site: '  ', project: '' }],
		])('%s forgets the repository\'s, and leaves the others', async (_what, cleared) => {
			work.setJiraConfig({ site: 'demo.atlassian.net', project: 'HAR' });
			await repos.selectRepo(CADENCE);
			work.setJiraConfig({ site: 'other.atlassian.net', project: 'CAD' });
			work.setJiraConfig(cleared);
			expect(work.jiraConfig()).toBeNull();
			expect(kept()).toEqual({ [HARMONY]: { site: 'demo.atlassian.net', project: 'HAR' } });
		});

		test('half of it is kept for the form, but is not enough to ask Jira anything', async () => {
			work.setJiraConfig({ site: 'demo.atlassian.net', project: '' });
			expect(kept()).toEqual({ [HARMONY]: { site: 'demo.atlassian.net', project: '' } });
			expect(work.jiraConfig()).toBeNull();
			await work.loadJira();
			expect(reads()).toBe(0);
		});

		test('it is there again the next time the app starts', async () => {
			await start(() => localStorage.setItem('studio.jira', JSON.stringify({ [HARMONY]: { site: 'demo.atlassian.net', project: 'HAR' }, [CADENCE]: { site: 'other.atlassian.net', project: 'CAD' } })));
			expect(work.jiraConfig()).toEqual({ site: 'demo.atlassian.net', project: 'HAR' });
		});

		test.each([
			['text that is not JSON', '{"/Users/demo'],
			['nothing', 'null'],
			['a list', '[]'],
			['a text', '"demo.atlassian.net"'],
			['a repository with only a site', JSON.stringify({ [HARMONY]: { site: 'demo.atlassian.net' } })],
			['a repository with something else under its name', JSON.stringify({ [HARMONY]: 'demo.atlassian.net/HAR' })],
		])('kept as %s, the repository has none and nothing is asked of Jira', async (_what, text) => {
			await start(() => localStorage.setItem('studio.jira', text));
			expect(work.jiraConfig()).toBeNull();
			work.openJira();
			await flush();
			expect(reads()).toBe(0);
			expect(work.jiraIssues()).toEqual([]);
			expect(w.toasts).toEqual([]);
		});

		test('broken storage is put right when the site and project are said again', async () => {
			await start(() => localStorage.setItem('studio.jira', '{"/Users/demo'));
			work.setJiraConfig({ site: 'demo.atlassian.net', project: 'HAR' });
			expect(kept()).toEqual({ [HARMONY]: { site: 'demo.atlassian.net', project: 'HAR' } });
		});

		test('storage that refuses to be written still serves until the window closes', () => {
			vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
				throw new Error('QuotaExceededError');
			});
			work.setJiraConfig({ site: 'demo.atlassian.net', project: 'HAR' });
			expect(work.jiraConfig()).toEqual({ site: 'demo.atlassian.net', project: 'HAR' });
		});
	});

	describe('the list', () => {
		beforeEach(() => {
			work.setJiraConfig({ site: 'demo.atlassian.net', project: 'HAR' });
		});

		test('opening the dialog asks the repository\'s site and project, and shows the first issue', async () => {
			work.openJira();
			expect(opened).toEqual(['host-jira']);
			await flush();
			expect(w.sent('jira_issues')).toEqual([{ cmd: 'jira_issues', args: { site: 'demo.atlassian.net', project: 'HAR', query: '' } }]);
			expect(work.jiraIssues().map((j) => j.key)).toEqual(['HAR-42', 'HAR-40']);
			expect(work.selectedJira()).toBe('HAR-42');
			expect(work.jiraLoading()).toBe(false);
			expect(work.jiraError()).toBeNull();
		});

		test('a search waits for a pause in the typing, then asks once', async () => {
			await work.loadJira();
			const before = reads();
			work.setJiraQuery('ly');
			await vi.advanceTimersByTimeAsync(200);
			work.setJiraQuery(' lyrics ');
			await vi.advanceTimersByTimeAsync(399);
			expect(reads()).toBe(before);
			await vi.advanceTimersByTimeAsync(1);
			await flush();
			expect(reads()).toBe(before + 1);
			expect(w.sent('jira_issues').at(-1)!.args.query).toBe('lyrics');
			expect(work.jiraIssues().map((j) => j.key)).toEqual(['HAR-40']);
		});

		test('a list Jira\'s tool fails to give is said in the dialog', async () => {
			w.on('jira_issues', () => { throw appError('error', 'acli is not signed in: run `acli jira auth login`'); });
			await work.loadJira();
			expect(work.jiraIssues()).toEqual([]);
			expect(work.jiraError()).toBe('acli is not signed in: run `acli jira auth login`');
			expect(work.jiraLoading()).toBe(false);
			expect(w.toasts).toEqual([]);
		});

		test('the issue on screen stays while it is still listed, else the first one is shown', async () => {
			await work.loadJira();
			work.selectJira('HAR-40');
			native.jira = [ticket('HAR-50', 'A new one'), ...native.jira];
			await work.loadJira();
			expect(work.selectedJira()).toBe('HAR-40');
			native.jira = [ticket('HAR-50', 'A new one')];
			await work.loadJira();
			expect(work.selectedJira()).toBe('HAR-50');
			native.jira = [];
			await work.loadJira();
			expect(work.selectedJira()).toBeNull();
		});

		test('a comment typed for one issue does not go with another', async () => {
			await work.loadJira();
			work.jiraComment.set('For HAR-42');
			work.selectJira('HAR-42');
			expect(work.jiraComment()).toBe('For HAR-42');
			work.selectJira('HAR-40');
			expect(work.jiraComment()).toBe('');
			expect(work.selectedJira()).toBe('HAR-40');
		});

		// What holds now: like the issues, pull requests and check runs, the answer to an older search does not
		// replace a newer one. Before the fix (2026-11-23): loadJira() has no guard for that, so a slow answer to "ly" arriving
		// after the answer to "lyrics" is what stays on screen under a box that says "lyrics".
		test('the answer to an older search does not replace a newer one', async () => {
			const slow = deferred<JiraIssue[]>();
			inTurn('jira_issues', slow.promise, [ticket('HAR-2', 'Asked second')]);
			const first = work.loadJira();
			await work.loadJira();
			slow.resolve([ticket('HAR-1', 'Asked first')]);
			await first;
			expect(work.jiraIssues().map((j) => j.key)).toEqual(['HAR-2']);
		});

		test('closing the dialog closes that dialog', () => {
			work.closeJira();
			expect(closed).toEqual(['host-jira']);
		});
	});

	describe('moving and commenting', () => {
		beforeEach(async () => {
			work.setJiraConfig({ site: 'demo.atlassian.net', project: 'HAR' });
			work.openJira();
			await flush();
		});

		test('looking around changes nothing in Jira', async () => {
			work.setJiraQuery('lyrics');
			await vi.advanceTimersByTimeAsync(500);
			work.selectJira('HAR-40');
			work.jiraComment.set('A thought');
			await work.loadJira();
			work.closeJira();
			expect(written()).toEqual([]);
		});

		test('a move sends that issue to that status, and nothing else', async () => {
			const before = reads();
			await work.jiraMove('HAR-42', 'In Progress');
			expect(written()).toEqual(['jira_transition']);
			expect(w.sent('jira_transition')[0].args).toEqual({ key: 'HAR-42', status: 'In Progress' });
			expect(successes()).toEqual(['HAR-42 moved to In Progress']);
			expect(reads()).toBe(before + 1);
			expect(work.jiraBusy()).toBe('');
		});

		test('a move to no status is not sent', async () => {
			await work.jiraMove('HAR-42', '  ');
			expect(written()).toEqual([]);
		});

		test('a move Jira refuses is said, and nothing is called moved', async () => {
			w.on('jira_transition', () => { throw appError('error', 'No transition to "Done" from "To Do"'); });
			await work.jiraMove('HAR-42', 'Done');
			expect(errors()).toEqual(['No transition to "Done" from "To Do"']);
			expect(successes()).toEqual([]);
			expect(work.jiraBusy()).toBe('');
		});

		test('a comment is posted on that issue, and nothing else', async () => {
			work.jiraComment.set('  Picked this up  ');
			await work.jiraPostComment('HAR-42');
			expect(written()).toEqual(['jira_comment']);
			expect(w.sent('jira_comment')[0].args).toEqual({ key: 'HAR-42', body: 'Picked this up' });
			expect(work.jiraComment()).toBe('');
			expect(successes()).toEqual(['Comment posted']);
		});

		test('a comment with nothing typed is not posted', async () => {
			work.jiraComment.set('  ');
			await work.jiraPostComment('HAR-42');
			expect(written()).toEqual([]);
		});

		test('a comment Jira refuses is said, and what was typed is kept', async () => {
			w.on('jira_comment', () => { throw appError('error', 'You cannot comment on HAR-42'); });
			work.jiraComment.set('Picked this up');
			await work.jiraPostComment('HAR-42');
			expect(errors()).toEqual(['You cannot comment on HAR-42']);
			expect(work.jiraComment()).toBe('Picked this up');
			expect(work.jiraBusy()).toBe('');
		});

		test('while one is on its way a second press, of either button, sends nothing', async () => {
			const slow = deferred();
			w.on('jira_transition', () => slow.promise);
			const first = work.jiraMove('HAR-42', 'In Progress');
			expect(work.jiraBusy()).toBe('move');
			work.jiraComment.set('Meanwhile');
			await work.jiraMove('HAR-42', 'Done');
			await work.jiraPostComment('HAR-42');
			slow.resolve();
			await first;
			expect(written()).toEqual(['jira_transition']);
		});
	});
});

describe('the tools and the notices about them', () => {
	const kept = () => localStorage.getItem('studio.notices.dismissed');

	test('the tools are asked about once, and again only when told to', async () => {
		expect(work.clis()).toBeNull();
		expect(await work.loadClis()).toEqual(native.clis);
		expect(await work.loadClis()).toEqual(native.clis);
		expect(w.sent('host_clis').length).toBe(1);
		native.clis = [{ ...native.clis[0], signedIn: false, hint: 'Run `gh auth login` in a terminal.' }];
		expect(await work.loadClis(true)).toEqual(native.clis);
		expect(w.sent('host_clis').length).toBe(2);
		expect(work.clis()).toEqual(native.clis);
		expect(work.clisLoading()).toBe(false);
	});

	test('what to install or run comes with a tool that cannot be used', async () => {
		const list = await work.loadClis();
		const missing = list.find((c) => !c.installed)!;
		expect(missing.hint).toBe('Install the GitLab CLI, then run `glab auth login` in a terminal.');
	});

	test('tools that cannot be asked about show as none, without an error', async () => {
		w.on('host_clis', () => { throw appError('error', 'could not look for the tools'); });
		expect(await work.loadClis()).toEqual([]);
		expect(work.clis()).toEqual([]);
		expect(work.clisLoading()).toBe(false);
		expect(w.toasts).toEqual([]);
	});

	test('asking about the tools installs nothing and signs in to nothing', async () => {
		const before = w.calls.length;
		await work.loadClis(true);
		await flush();
		expect(w.calls.slice(before).map((c) => c.cmd)).toEqual(['host_clis']);
	});

	test('a notice that was dismissed stays dismissed, once', () => {
		work.dismiss('glab');
		work.dismiss('az');
		work.dismiss('glab');
		expect(work.dismissed()).toEqual(['glab', 'az']);
		expect(kept()).toBe('["glab","az"]');
	});

	test('the dismissed notices are the same the next time the app starts', async () => {
		await start(() => localStorage.setItem('studio.notices.dismissed', '["glab"]'));
		expect(work.dismissed()).toEqual(['glab']);
	});

	test.each([
		['text that is not JSON', '["glab"'],
		['nothing', 'null'],
	])('kept as %s, no notice counts as dismissed', async (_what, text) => {
		await start(() => localStorage.setItem('studio.notices.dismissed', text));
		expect(work.dismissed()).toEqual([]);
	});

	test('all of them can be brought back', () => {
		work.dismiss('glab');
		work.undismissAll();
		expect(work.dismissed()).toEqual([]);
		expect(kept()).toBe('[]');
	});
});
