/**
 * The demo repository's host, for the browser preview: a few issues, a pull
 * request that can be "created", and the three host tools in different states.
 * Kept apart from the demo backend so that file only gains a few `case` lines.
 */
import type { CiRun, HostCli, HostCliStatus, HostIssue, HostOwner, HostRepo, JiraIssue, PrChanges, PrContext, PrDetail, PrSummary, PrWebUrl, PullRequestRef } from './backend.service';

const WEB = 'https://github.com/demo/harmony';

/** What the demo backend knows about the repository right now. */
export interface DemoHostState {
	/** The selected demo repository has no remote. */
	empty: boolean;
	branch: string;
	unpushed: number;
	onRemote: boolean;
	remoteBranches: string[];
	subjects: string[];
}

function hoursAgo(h: number): string {
	return new Date(Date.now() - h * 3_600_000).toISOString();
}

const ISSUES: HostIssue[] = [
	{
		id: '214',
		title: 'Repeat-one restarts the track a second late',
		body: 'With repeat set to **one**, the track ends, there is about a second of silence, and only then does it start again.\n\n### Steps\n1. Play any track\n2. Press R twice (repeat one)\n3. Let it run to the end\n\n### Expected\nA gapless restart, like repeat-all does between tracks.\n\n<img src=x onerror="alert(\'this is shown as text, never run\')">',
		url: `${WEB}/issues/214`,
		labels: ['bug', 'player'],
		assignee: 'demo',
		state: 'open',
		updated: hoursAgo(3),
		kind: 'issue',
	},
	{
		id: '209',
		title: 'Remember the queue between sessions',
		body: 'Volume already survives a restart (#187). The queue should too: tracks, order and the cursor.\n\n- Save on every change, debounced\n- Restore before the first render\n- Drop tracks whose files are gone',
		url: `${WEB}/issues/209`,
		labels: ['enhancement'],
		assignee: null,
		state: 'open',
		updated: hoursAgo(26),
		kind: 'issue',
	},
	{
		id: '201',
		title: 'Keyboard shortcut list is missing the reorder keys',
		body: 'docs/shortcuts.md does not mention Alt+Up / Alt+Down, which have worked since the keyboard reordering change.',
		url: `${WEB}/issues/201`,
		labels: ['documentation', 'good first issue'],
		assignee: null,
		state: 'open',
		updated: hoursAgo(90),
		kind: 'issue',
	},
	{
		id: '188',
		title: 'Seek bar jumps back after a long pause',
		body: '',
		url: `${WEB}/issues/188`,
		labels: ['bug'],
		assignee: 'sam',
		state: 'open',
		updated: hoursAgo(400),
		kind: 'issue',
	},
];

const READY: HostCliStatus = { provider: 'github', hostName: 'GitHub', issuesLabel: 'Issues', pullsLabel: 'Pull requests', tool: 'gh', installed: true, signedIn: true, hint: null };

/** Add `?host=missing` or `?host=signed-out` to the preview's address to see the dialogs without a usable tool. */
function status(): HostCliStatus {
	const mode = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('host');
	if (mode === 'missing') {
		return { ...READY, installed: false, signedIn: false, hint: 'Install the GitHub CLI from https://cli.github.com, then run `gh auth login` in a terminal.' };
	}
	if (mode === 'signed-out') {
		return { ...READY, signedIn: false, hint: 'Run `gh auth login` in a terminal to sign in to github.com.' };
	}
	return READY;
}

const CLIS: HostCli[] = [
	{ provider: 'github', name: 'GitHub', cli: 'gh', installed: true, signedIn: true, account: 'demo', hint: null },
	{ provider: 'azure', name: 'Azure DevOps', cli: 'az', installed: true, signedIn: false, account: null, hint: 'Run `az extension add --name azure-devops` in a terminal, then `az login` if you have not signed in.' },
	{ provider: 'gitlab', name: 'GitLab', cli: 'glab', installed: false, signedIn: false, account: null, hint: 'Install the GitLab CLI from https://gitlab.com/gitlab-org/cli, then run `glab auth login` in a terminal.' },
	{ provider: 'jira', name: 'Jira', cli: 'acli', installed: true, signedIn: true, account: 'demo@example.com on demo.atlassian.net', hint: null },
];

const PRS: PrSummary[] = [
	{ id: '131', title: 'Gapless repeat-one', author: 'sam', head: 'issue/214-repeat-one-gap', base: 'main', draft: false, state: 'open', updated: hoursAgo(2), url: `${WEB}/pull/131`, review: 'required', checks: 'pass' },
	{ id: '129', title: 'Persist the queue between sessions', author: 'demo', head: 'feature/queue-persist', base: 'main', draft: true, state: 'open', updated: hoursAgo(20), url: `${WEB}/pull/129`, review: '', checks: 'fail' },
	{ id: '126', title: 'Docs: list the reorder shortcuts', author: 'kim', head: 'docs/shortcuts', base: 'main', draft: false, state: 'open', updated: hoursAgo(70), url: `${WEB}/pull/126`, review: 'approved', checks: 'pending' },
];

function prDetail(id: string): PrDetail {
	const summary = PRS.find((p) => p.id === id) ?? PRS[0];
	return {
		summary,
		body: `## Summary\n- ${summary.title}\n\n## Testing\n- Play a track with repeat one and listen for the gap\n\n<b>Markup from the host stays text.</b>`,
		notes: [
			{ author: 'kim', body: 'Nice. Does this also cover the shuffle case?', created: hoursAgo(5), kind: 'comment' },
			{ author: 'sam', body: 'Shuffle goes through the same path, so yes.', created: hoursAgo(4), kind: 'comment' },
		],
		checks: [
			{ name: 'CI / test', state: summary.checks === 'fail' ? 'fail' : 'pass', url: `${WEB}/actions/runs/1` },
			{ name: 'CI / lint', state: summary.checks === 'pending' ? 'pending' : 'pass', url: `${WEB}/actions/runs/1` },
		],
		files: [
			{ path: 'src/player/queue.ts', additions: 14, deletions: 3 },
			{ path: 'src/player/repeat.ts', additions: 7, deletions: 0 },
		],
		mergeable: summary.checks !== 'fail',
		crossRepo: false,
	};
}

function runs(branch: string): CiRun[] {
	return [
		{ id: '9001', name: 'CI', title: 'Wrap the queue when repeat is on', state: branch === 'main' ? 'pass' : 'fail', url: `${WEB}/actions/runs/9001`, created: hoursAgo(1), branch, definition: null },
		{ id: '9000', name: 'Release', title: 'v1.4.0', state: 'pass', url: `${WEB}/actions/runs/9000`, created: hoursAgo(30), branch, definition: null },
	];
}

const JIRA: JiraIssue[] = [
	{ key: 'HAR-42', title: 'Crossfade between tracks', body: 'Fade the outgoing track over the last two seconds.', status: 'To Do', kind: 'Story', assignee: 'Demo Author', updated: hoursAgo(6), labels: ['player'], url: 'https://demo.atlassian.net/browse/HAR-42' },
	{ key: 'HAR-40', title: 'Lyrics panel', body: '', status: 'In Progress', kind: 'Task', assignee: null, updated: hoursAgo(50), labels: [], url: 'https://demo.atlassian.net/browse/HAR-40' },
];

const OWNERS: HostOwner[] = [
	{ id: 'demo', label: 'demo (your account)' },
	{ id: 'melodic-demo', label: 'melodic-demo' },
];

/** Pull requests "created" in this preview session, by branch. */
const created = new Map<string, PullRequestRef>();

function later<T>(value: T, ms: number): Promise<T> {
	return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** The canned `[pull-request]` answer: the JSON the real prompt asks Claude for. */
export function demoPullRequestAnswer(): string {
	return JSON.stringify({
		title: 'Wrap the queue when repeat is on',
		body: '## Summary\n- `Queue.next()` takes a `repeat` flag and wraps to the first track instead of running off the end\n- Adds a repeat toggle to the transport bar that cycles off, all, one\n\n## Testing\n- Play the last track with repeat on: the first track should follow\n- With repeat off, playback still stops at the end of the queue',
	});
}

export function demoHost(cmd: string, args: Record<string, unknown>, state: DemoHostState): unknown {
	switch (cmd) {
		case 'issues_status':
			if (state.empty) {
				throw { kind: 'error', message: 'This repository has no remote on a host Melodic Studio knows' };
			}
			return later(status(), 250);
		case 'issues_list': {
			const q = String(args.query ?? '')
				.trim()
				.toLowerCase();
			const found = q ? ISSUES.filter((i) => `#${i.id} ${i.title} ${i.labels.join(' ')}`.toLowerCase().includes(q)) : ISSUES;
			if (!status().signedIn) {
				throw { kind: 'error', message: status().hint ?? '' };
			}
			return later(state.empty ? [] : found, 450);
		}
		case 'pr_context':
			return {
				branch: state.branch,
				base: 'main',
				bases: state.remoteBranches.filter((b) => b !== state.branch),
				onRemote: state.onRemote,
				unpushed: state.unpushed,
			} satisfies PrContext;
		case 'pr_changes': {
			const subjects = state.branch === String(args.base) ? [] : state.subjects.length ? state.subjects : ['Wrap the queue when repeat is on'];
			return {
				count: subjects.length,
				subjects,
				log: subjects.map((s, i) => `${(0xa1b2c3 + i).toString(16)} ${s}`).join('\n'),
				stat: subjects.length ? ' src/player/queue.ts  | 17 ++++++++++++++---\n src/player/repeat.ts |  7 +++++++\n 2 files changed, 21 insertions(+), 3 deletions(-)' : '',
			} satisfies PrChanges;
		}
		case 'pr_existing':
			return later(created.get(state.branch) ?? null, 300);
		case 'pr_create': {
			if (!state.onRemote || state.unpushed > 0) {
				throw { kind: 'error', message: `Push ${state.branch} first: the remote does not have all of its commits yet.` };
			}
			const pr: PullRequestRef = { id: String(128 + created.size), title: String(args.title), url: `${WEB}/pull/${128 + created.size}` };
			created.set(state.branch, pr);
			return later(pr, 900);
		}
		case 'pr_web_url':
			return { url: `${WEB}/compare/${encodeURIComponent(String(args.base))}...${encodeURIComponent(state.branch)}?expand=1&title=${encodeURIComponent(String(args.title))}`, title: true, body: String(args.body).length < 2000 } satisfies PrWebUrl;
		case 'host_open':
			// Nothing real behind these addresses; the preview only says where it would have gone.
			console.info(`[demo] would open ${String(args.url)}`);
			return;
		case 'host_clis':
			return later(CLIS, 400);
		case 'host_owners':
			return later(args.provider === 'github' ? OWNERS : [], 300);
		case 'host_repo_create': {
			if (args.provider !== 'github') {
				throw { kind: 'error', message: CLIS.find((c) => c.provider === args.provider)?.hint ?? 'That host is not available in the preview.' };
			}
			const path = `${String(args.owner ?? 'demo')}/${String(args.name)}`;
			return later({ webUrl: `https://github.com/${path}`, remoteUrl: `https://github.com/${path}.git` } satisfies HostRepo, 900);
		}
		case 'pr_list':
			return later(args.scope === 'mine' ? PRS.filter((p) => p.author === 'demo') : args.scope === 'review' ? PRS.slice(0, 1) : PRS, 350);
		case 'pr_view':
			return later(prDetail(String(args.number)), 300);
		case 'pr_review':
		case 'pr_comment':
		case 'issue_comment':
		case 'issue_set_state':
		case 'ci_rerun':
		case 'jira_transition':
		case 'jira_comment':
			console.info(`[demo] would run ${cmd}`, args);
			return later(undefined, 500);
		case 'pr_merge': {
			const pr = PRS.find((p) => p.id === args.number);
			if (pr) {
				pr.state = 'merged';
			}
			return later(undefined, 700);
		}
		case 'pr_fetch':
			return later(PRS.find((p) => p.id === args.number)?.head ?? `pr-${String(args.number)}`, 400);
		case 'issue_create':
			return later({ id: '215', url: `${WEB}/issues/215` }, 600);
		case 'ci_runs':
			return later(state.empty ? [] : runs(String(args.branch)), 300);
		case 'jira_issues':
			return later(JIRA.filter((j) => !args.query || `${j.key} ${j.title}`.toLowerCase().includes(String(args.query).toLowerCase())), 400);
		default:
			return;
	}
}
