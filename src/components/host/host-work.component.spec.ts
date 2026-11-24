import { beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { RepoStore } from '../../services/repo.store';
import type { HostWorkStore } from '../../services/host-work.store';
import type { AiFeaturesStore } from '../../services/ai-features.store';
import type { HostCli, HostCliStatus, JiraIssue, PrDetail, PrSummary } from '../../services/backend.service';

// Monaco and xterm cannot run in happy-dom; nothing here needs either to arrive.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

let w: World;
let repos: RepoStore;
let work: HostWorkStore;
let ai: AiFeaturesStore;
let el: HTMLElement;
/** The dialogs opened and closed, in order: `+name` and `-name`. */
let dialogs: string[];
/** What the pretend host answers. */
let cli: HostCliStatus;
let prs: PrSummary[];
let tools: HostCli[];
let jira: JiraIssue[];

const READY: HostCliStatus = { provider: 'github', hostName: 'GitHub', issuesLabel: 'Issues', pullsLabel: 'Pull requests', tool: 'gh', installed: true, signedIn: true, hint: null };
const WEB = 'https://github.com/demo/harmony';

function pr(change: Partial<PrSummary> = {}): PrSummary {
	return { id: '131', title: 'Gapless repeat-one', author: 'sam', head: 'issue/214-repeat-one-gap', base: 'main', draft: false, state: 'open', updated: new Date().toISOString(), url: `${WEB}/pull/131`, review: 'required', checks: 'pass', ...change };
}

function detail(summary: PrSummary, change: Partial<PrDetail> = {}): PrDetail {
	return {
		summary,
		body: `What ${summary.title} does.`,
		notes: [{ author: 'kim', body: 'Does this cover shuffle?', created: new Date().toISOString(), kind: 'comment' }],
		checks: [{ name: 'CI / test', state: 'pass', url: `${WEB}/actions/runs/1` }],
		files: [{ path: 'src/player/repeat.ts', additions: 7, deletions: 2 }],
		mergeable: true,
		crossRepo: false,
		...change,
	};
}

function ticket(change: Partial<JiraIssue> = {}): JiraIssue {
	return { key: 'HAR-42', title: 'Crossfade between tracks', body: 'Fade the outgoing track over two seconds.', status: 'To Do', kind: 'Story', assignee: 'Rick', updated: new Date().toISOString(), labels: [], url: 'https://demo.atlassian.net/browse/HAR-42', ...change };
}
/**
 * happy-dom keeps its custom elements across `vi.resetModules()` and Melodic defines a tag only once, so
 * without this every test after the first would mount the first test's classes, bound to its stores.
 */
function forgetElements(): void {
	const registry = customElements as unknown as Record<symbol, unknown>;
	for (const key of Object.getOwnPropertySymbols(registry)) {
		const value = registry[key];
		if (value instanceof Map) {
			value.clear();
		}
	}
}

/** happy-dom has no Popover API (an `ml-select` closes its list through it). */
function popovers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, (this: HTMLElement) => void>;
	proto.showPopover = proto.hidePopover = proto.togglePopover = function () {};
}

/**
 * What a person reads under `root`, through shadow roots: the text as it is written, a space where an element
 * starts or ends, and no icons (an `ml-icon` draws a private-use character of its font).
 */
function words(root: Node): string {
	let out = '';
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			out += node.textContent ?? '';
			return;
		}
		if (node instanceof Element) {
			if (node.tagName === 'STYLE' || node.tagName === 'SCRIPT') {
				return;
			}
			if (node.shadowRoot) {
				walk(node.shadowRoot);
			}
		}
		out += ' ';
		node.childNodes.forEach(walk);
		out += ' ';
	};
	walk(root);
	return out.replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
}

/** The `ml-button` that reads `label`. */
function button(root: Element, label: string): HTMLElement {
	const found = all(root, 'ml-button').find((b) => words(b) === label);
	if (!found) {
		throw new Error(`no button "${label}" among: ${all(root, 'ml-button').map((b) => words(b)).join(' | ')}`);
	}
	return found;
}

function isOff(root: Element, label: string): boolean {
	return find<HTMLButtonElement>(button(root, label), 'button')!.disabled;
}

async function press(root: Element, label: string): Promise<void> {
	await click(find(button(root, label), 'button'));
}

async function type(target: Element, text: string): Promise<void> {
	const input = find<HTMLInputElement>(target, 'input, textarea')!;
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}


beforeEach(async () => {
	w = await world();
	forgetElements();
	popovers();
	cli = READY;
	prs = [pr(), pr({ id: '129', title: 'Persist the queue', author: 'rick', head: 'feature/queue-persist', draft: true, review: '', checks: 'fail' }), pr({ id: '126', title: 'Docs: reorder shortcuts', author: 'kim', head: 'docs/shortcuts', review: 'approved', checks: 'pending' })];
	tools = [];
	jira = [ticket(), ticket({ key: 'HAR-40', title: 'Lyrics panel', body: '', status: 'In Progress', kind: 'Task', assignee: null, url: 'https://demo.atlassian.net/browse/HAR-40' })];
	// The demo host answers after a real pause; everything the host is asked is answered here.
	w.on('issues_status', () => cli);
	w.on('pr_list', (args) => (args.scope === 'mine' ? prs.filter((p) => p.author === 'rick') : prs));
	w.on('pr_view', (args) => detail(prs.find((p) => p.id === args.number)!));
	w.on('host_clis', () => tools);
	w.on('jira_issues', () => jira);
	w.on('ci_runs', () => []);
	w.on('host_open', () => undefined);
	for (const cmd of ['pr_review', 'pr_comment', 'pr_merge', 'jira_transition', 'jira_comment']) {
		w.on(cmd, () => undefined);
	}
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	work = w.get((await import('../../services/host-work.store')).HostWorkStore);
	ai = w.get((await import('../../services/ai-features.store')).AiFeaturesStore);
	const { DialogService } = await import('@melodicdev/components/dialog');
	dialogs = [];
	vi.spyOn(w.get(DialogService), 'open').mockImplementation(((id: string) => void dialogs.push(`+${id}`)) as never);
	vi.spyOn(w.get(DialogService), 'close').mockImplementation(((id: string) => void dialogs.push(`-${id}`)) as never);
	await repos.init();
	el = await mount('ms-host-work');
});

/** The dialog known by `name`: happy-dom drops the `#` of `<ml-dialog #name>`, so it is found by the attribute that is left. */
function dialog(name: string): HTMLElement {
	return find(el, `ml-dialog[${name}]`)!;
}

async function openPulls(): Promise<HTMLElement> {
	work.openPulls();
	await settle();
	return dialog('host-pulls');
}

/** The Jira dialog, with the open repository's site and project set as Settings would. */
async function openJira(configured = true): Promise<HTMLElement> {
	if (configured) {
		work.setJiraConfig({ site: 'demo.atlassian.net', project: 'HAR' });
	}
	work.openJira();
	await settle();
	return dialog('host-jira');
}

/** Everything posted to a host so far, by command. */
function posted(): string[] {
	return w.calls.map((c) => c.cmd).filter((c) => ['pr_review', 'pr_comment', 'pr_merge', 'pr_create', 'issue_comment', 'jira_transition', 'jira_comment'].includes(c));
}

describe('the pull requests dialog', () => {
	test('opens through HostWorkStore.openPulls, named for the host, and lists the open ones', async () => {
		const d = await openPulls();
		expect(dialogs).toEqual(['+host-pulls']);
		expect(words(find(d, 'h3')!)).toBe('Pull requests on GitHub');
		expect(w.sent('pr_list').at(-1)!.args).toEqual({ id: repos.repo()!.id, scope: 'open' });
		expect(all(d, '.issue .line').map((l) => words(l))).toEqual(['#131 Gapless repeat-one', '#129 Persist the queue', '#126 Docs: reorder shortcuts']);
	});

	test('each row says who it is from and how its review stands', async () => {
		const d = await openPulls();
		expect(all(d, '.issue').map((r) => all(r, '.meta .label').map((l) => l.textContent))).toEqual([['review needed'], ['draft'], ['approved']]);
		expect(words(find(all(d, '.issue')[0], '.meta')!)).toContain('sam');
	});

	test('the first one is shown: where it goes, what it says, its checks, files and conversation', async () => {
		const d = await openPulls();
		expect(w.sent('pr_view').at(-1)!.args.number).toBe('131');
		expect(words(find(d, '.detail h4')!)).toBe('Gapless repeat-one');
		expect(words(find(d, '.detail .branchy')!)).toBe('issue/214-repeat-one-gap → main');
		expect(find(d, '.detail .body')!.textContent).toBe('What Gapless repeat-one does.');
		expect(all(d, '.detail .check').map((c) => words(c))).toEqual(['CI / test']);
		expect(all(d, '.detail .file').map((f) => words(f))).toEqual(['src/player/repeat.ts +7 −2']);
		expect(words(find(d, '.detail .note-item .text')!)).toBe('Does this cover shuffle?');
	});

	test('clicking another shows that one', async () => {
		const d = await openPulls();
		await click(all(d, '.issue')[2]);
		expect(w.sent('pr_view').at(-1)!.args.number).toBe('126');
		expect(words(find(d, '.detail h4')!)).toBe('Docs: reorder shortcuts');
	});

	test('"Mine" lists only the user\'s own', async () => {
		const d = await openPulls();
		await click(all(find(d, '.search ml-select')!, '.ml-select__option').find((o) => words(o) === 'Mine')!);
		expect(w.sent('pr_list').at(-1)!.args.scope).toBe('mine');
		expect(all(d, '.issue .num').map((n) => n.textContent)).toEqual(['#129']);
	});

	test('what the host says is shown as text', async () => {
		w.on('pr_view', (args) => detail(prs.find((p) => p.id === args.number)!, { body: '<b>Markup</b> stays text.', notes: [{ author: '<i>kim</i>', body: '<img src=x onerror="window.pwned = true">', created: '', kind: 'comment' }] }));
		const d = await openPulls();
		expect(find(d, '.detail .body')!.textContent).toBe('<b>Markup</b> stays text.');
		expect(find(d, '.note-item .text')!.textContent).toBe('<img src=x onerror="window.pwned = true">');
		expect(find(d, '.note-item .who b')!.textContent).toBe('<i>kim</i>');
		expect(all(d, '.detail img, .detail .body b, .detail .who i')).toEqual([]);
	});

	test('one that conflicts with its base says so', async () => {
		w.on('pr_view', (args) => detail(prs.find((p) => p.id === args.number)!, { mergeable: false }));
		const d = await openPulls();
		expect(words(find(d, '.detail .note.warn')!)).toBe('This pull request has conflicts with main.');
	});

	test('none open says so; a list that cannot be loaded says why', async () => {
		prs = [];
		const d = await openPulls();
		expect(words(find(d, '.rows .none')!)).toBe('No open pull requests here.');
		w.on('pr_list', () => {
			throw appError('error', 'gh: HTTP 502');
		});
		await click(find(d, '.search [title="Reload"]'));
		expect(words(find(d, '.rows .none')!)).toBe('The list could not be loaded. gh: HTTP 502');
	});

	test('without a usable tool it shows what to install or run, and lists nothing', async () => {
		cli = { ...READY, signedIn: false, hint: 'Run `gh auth login`.' };
		const d = await openPulls();
		expect(find(d, 'ms-cli-notice')).not.toBeNull();
		expect(find(d, '.browse')).toBeNull();
		expect(w.sent('pr_list')).toEqual([]);
	});

	test('"All on GitHub" and "Open on GitHub" open the host\'s own pages', async () => {
		const d = await openPulls();
		await press(d, 'All on GitHub');
		expect(w.sent('open_in').at(-1)!.args).toMatchObject({ target: 'pulls' });
		await press(d, 'Open on GitHub');
		expect(w.sent('host_open').at(-1)!.args.url).toBe(`${WEB}/pull/131`);
		await click(find(d, '.detail .check [title="Open"]'));
		expect(w.sent('host_open').at(-1)!.args.url).toBe(`${WEB}/actions/runs/1`);
	});

	test('looking at pull requests posts nothing', async () => {
		const d = await openPulls();
		await click(all(d, '.issue')[1]);
		await click(all(d, '.issue')[2]);
		expect(posted()).toEqual([]);
	});
});

describe('reviewing a pull request', () => {
	test('a comment needs text, and is posted when Comment is pressed', async () => {
		const d = await openPulls();
		expect(isOff(d, 'Comment')).toBe(true);
		expect(isOff(d, 'Request changes')).toBe(true);
		await type(find(d, '.detail ml-textarea')!, ' Looks right to me. ');
		expect(posted()).toEqual([]);
		await press(d, 'Comment');
		expect(w.sent('pr_comment').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, number: '131', body: 'Looks right to me.' }]);
		expect(posted()).toEqual(['pr_comment']);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Comment posted' });
	});

	test('"Request changes" sends that verdict with the text', async () => {
		const d = await openPulls();
		await type(find(d, '.detail ml-textarea')!, 'The gap is still there on shuffle.');
		await press(d, 'Request changes');
		expect(w.sent('pr_review').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, number: '131', verdict: 'request-changes', body: 'The gap is still there on shuffle.' }]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Asked for changes on #131' });
	});

	test('Approve needs no text', async () => {
		const d = await openPulls();
		expect(isOff(d, 'Approve')).toBe(false);
		await press(d, 'Approve');
		expect(w.sent('pr_review').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, number: '131', verdict: 'approve', body: '' }]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Approved #131' });
	});

	test('a review typed for one pull request does not go to another', async () => {
		const d = await openPulls();
		await type(find(d, '.detail ml-textarea')!, 'For 131 only');
		await click(all(d, '.issue')[2]);
		expect(find<HTMLTextAreaElement>(find(d, '.detail ml-textarea')!, 'textarea')!.value).toBe('');
	});

	test('a merged pull request has nothing left to review or merge', async () => {
		prs = [pr({ state: 'merged' })];
		const d = await openPulls();
		expect(find(d, '.detail ml-textarea')).toBeNull();
		expect(all(d, 'ml-button').map((b) => words(b))).not.toContain('Merge…');
	});
});

describe('merging a pull request', () => {
	test('"Merge…" asks how first, and nothing is merged until "Merge into main"', async () => {
		const d = await openPulls();
		await press(d, 'Merge…');
		const row = find(d, '.detail .merge')!;
		expect(words(find(find(row, 'ml-select')!, '.ml-select__value')!)).toBe('Squash and merge');
		expect(find(row, 'ml-checkbox')!.getAttribute('label')).toBe('Delete issue/214-repeat-one-gap afterwards');
		expect(posted()).toEqual([]);
		await press(row, 'Merge into main');
		expect(w.sent('pr_merge').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, number: '131', method: 'squash', deleteBranch: true }]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Merged #131' });
		expect(find(d, '.detail .merge')).toBeNull();
	});

	test('the way of merging and keeping the branch are as chosen', async () => {
		const d = await openPulls();
		await press(d, 'Merge…');
		const row = find(d, '.detail .merge')!;
		await click(all(find(row, 'ml-select')!, '.ml-select__option').find((o) => words(o) === 'Rebase and merge')!);
		const box = find<HTMLInputElement>(find(row, 'ml-checkbox')!, 'input')!;
		box.checked = false;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		await press(find(d, '.detail .merge')!, 'Merge into main');
		expect(w.sent('pr_merge').at(-1)!.args).toMatchObject({ method: 'rebase', deleteBranch: false });
	});

	test('Cancel merges nothing', async () => {
		const d = await openPulls();
		await press(d, 'Merge…');
		await press(find(d, '.detail .merge')!, 'Cancel');
		expect(find(d, '.detail .merge')).toBeNull();
		expect(posted()).toEqual([]);
	});

	test('a draft cannot be merged', async () => {
		const d = await openPulls();
		await click(all(d, '.issue')[1]);
		expect(isOff(d, 'Merge…')).toBe(true);
	});
});

describe('bringing a pull request here', () => {
	test('"Check out" fetches it into a worktree of its own and goes there', async () => {
		w.on('pr_fetch', () => 'pr-131');
		const d = await openPulls();
		await press(d, 'Check out');
		expect(w.sent('pr_fetch').at(-1)!.args.number).toBe('131');
		expect(w.sent('worktree_add').at(-1)!.args).toMatchObject({ branch: 'pr-131', base: null });
		expect(w.sent('worktree_select').at(-1)!.args.path).toBe('/Users/demo/Source/harmony.worktrees/pr-131');
		expect(repos.tab()).toBe('changes');
		expect(dialogs.at(-1)).toBe('-host-pulls');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: '#131 is checked out' });
		expect(posted()).toEqual([]);
	});

	test('"Review with Claude" checks it out and compares it with its target; nothing is posted to the host', async () => {
		w.on('pr_fetch', () => 'pr-131');
		const review = vi.spyOn(ai, 'review').mockResolvedValue();
		const d = await openPulls();
		expect(button(d, 'Review with Claude').title).toContain('Nothing is posted to GitHub.');
		await press(d, 'Review with Claude');
		expect(w.sent('worktree_select').at(-1)!.args.path).toBe('/Users/demo/Source/harmony.worktrees/pr-131');
		expect(review).toHaveBeenCalledWith({ scope: 'branch', base: 'main', label: 'Pull request #131' });
		expect(posted()).toEqual([]);
	});

	test('a pull request that cannot be fetched is said, and nothing is reviewed', async () => {
		w.on('pr_fetch', () => {
			throw appError('git', 'fatal: could not read from remote repository');
		});
		const review = vi.spyOn(ai, 'review').mockResolvedValue();
		const d = await openPulls();
		await press(d, 'Review with Claude');
		expect(review).not.toHaveBeenCalled();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'fatal: could not read from remote repository' });
	});

	test('without Claude Code the review button is off and says why', async () => {
		w.on('agent_available', () => null);
		ai.init();
		const d = await openPulls();
		await settle();
		expect(isOff(d, 'Review with Claude')).toBe(true);
		expect(button(d, 'Review with Claude').title).toBe(ai.unavailable());
		expect(ai.unavailable()).not.toBe('');
	});
});

describe('the Jira dialog', () => {
	test('with no project set for the repository it asks which, and sends you to Settings', async () => {
		const d = await openJira(false);
		expect(dialogs).toEqual(['+host-jira']);
		expect(words(find(d, '.setup b')!)).toBe('Which Jira project belongs to harmony?');
		expect(words(find(d, '.setup p')!)).toBe("Set the site and project key in Settings › Accounts. Issues are read through Atlassian's own CLI (acli); Melodic Studio keeps no Jira token.");
		expect(w.sent('jira_issues')).toEqual([]);
		await press(d, 'Open Settings › Accounts');
		expect(dialogs).toEqual(['+host-jira', '-host-jira', '+settings']);
		expect(repos.prompt()).toEqual({ settingsTab: 'accounts' });
	});

	test('with a project it names it and lists that project\'s issues', async () => {
		const d = await openJira();
		expect(words(find(d, 'h3')!)).toBe('Jira · HAR');
		expect(w.sent('jira_issues').at(-1)!.args).toEqual({ site: 'demo.atlassian.net', project: 'HAR', query: '' });
		expect(all(d, '.issue .line').map((l) => words(l))).toEqual(['HAR-42 Crossfade between tracks', 'HAR-40 Lyrics panel']);
		expect(words(find(d, '.detail h4')!)).toBe('Crossfade between tracks');
		expect(words(find(d, '.detail .facts')!)).toBe('To Do HAR-42 Story Rick');
		expect(find(d, '.detail .body')!.textContent).toBe('Fade the outgoing track over two seconds.');
	});

	test('an issue can be moved to any status but the one it has, on the click', async () => {
		const d = await openJira();
		expect(all(find(d, '.detail .row')!, 'ml-button').map((b) => words(b))).toEqual(['In Progress', 'In Review', 'Done']);
		expect(posted()).toEqual([]);
		await press(d, 'In Review');
		expect(w.sent('jira_transition').map((c) => c.args)).toEqual([{ key: 'HAR-42', status: 'In Review' }]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'HAR-42 moved to In Review' });
	});

	test('a comment is posted on the click, and one typed for another issue is not', async () => {
		const d = await openJira();
		expect(isOff(d, 'Post comment')).toBe(true);
		await type(find(d, '.detail ml-textarea')!, 'For 42');
		await click(all(d, '.issue')[1]);
		expect(find<HTMLTextAreaElement>(find(d, '.detail ml-textarea')!, 'textarea')!.value).toBe('');
		await type(find(d, '.detail ml-textarea')!, 'Starting on this.');
		await press(d, 'Post comment');
		expect(w.sent('jira_comment').map((c) => c.args)).toEqual([{ key: 'HAR-40', body: 'Starting on this.' }]);
	});

	test('"Create branch" makes a branch named after the issue and closes the dialog', async () => {
		const d = await openJira();
		await press(d, 'Create branch');
		expect(w.sent('branch_create').at(-1)!.args).toMatchObject({ name: 'HAR-42-crossfade-between-tracks', start: null });
		expect(dialogs.at(-1)).toBe('-host-jira');
	});

	test('"Open in Jira" opens the issue\'s page', async () => {
		w.on('plugin:opener|open_url', () => undefined);
		const d = await openJira();
		await press(d, 'Open in Jira');
		expect(w.sent('plugin:opener|open_url').at(-1)!.args.url).toBe('https://demo.atlassian.net/browse/HAR-42');
	});

	test('an address that is not an https Jira issue page is not opened', async () => {
		w.on('plugin:opener|open_url', () => undefined);
		for (const url of ['http://demo.atlassian.net/browse/HAR-42', 'https://demo.atlassian.net/browse/HAR-42?next=evil', 'javascript:alert(1)', 'file:///etc/passwd']) {
			jira = [ticket({ url })];
			const d = await openJira();
			await press(d, 'Open in Jira');
		}
		expect(w.sent('plugin:opener|open_url')).toEqual([]);
	});

	test('an issue\'s text is shown as text', async () => {
		jira = [ticket({ title: '<b>Bold</b>', body: '<img src=x onerror="window.pwned = true">' })];
		const d = await openJira();
		expect(find(d, '.detail h4')!.textContent).toBe('<b>Bold</b>');
		expect(find(d, '.detail .body')!.textContent).toBe('<img src=x onerror="window.pwned = true">');
		expect(all(d, '.detail img, .detail h4 b')).toEqual([]);
	});

	test('nothing open, and a list that cannot be loaded, are said', async () => {
		jira = [];
		const d = await openJira();
		expect(words(find(d, '.rows .none')!)).toBe('Nothing open that is yours or moved lately.');
		expect(words(find(d, '.detail')!)).toBe('Pick one on the left.');
		w.on('jira_issues', () => {
			throw appError('error', 'acli: not signed in. Run `acli jira auth login --web`.');
		});
		await click(find(d, '.search [title="Reload"]'));
		expect(words(find(d, '.rows .none')!)).toBe('The list could not be loaded. acli: not signed in. Run acli jira auth login --web .');
	});

	test('a signed-out acli is said at the top, with what to run', async () => {
		tools = [{ provider: 'jira', name: 'Jira', cli: 'acli', installed: true, signedIn: false, account: null, hint: null } as unknown as HostCli];
		await work.loadClis(true);
		const d = await openJira();
		const notice = find(d, 'ms-cli-notice')!;
		expect(words(find(notice, '.notice b')!)).toBe('Sign in to acli to see Jira issues here');
		expect(all(notice, '.cmd code').map((c) => c.textContent)).toEqual(['acli jira auth login --web']);
	});
});
