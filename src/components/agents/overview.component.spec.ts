import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import { newPipeline, withStep, type Pipeline } from '../../shared/pipeline';
import type { AgentSession, AgentsStore } from '../../services/agents.store';
import type { RepoStore } from '../../services/repo.store';
import type { Conversation, WorkspaceStore } from '../../services/workspace.store';
import type { Worktree } from '../../services/backend.service';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';
const OTHER = '/Users/demo/Source/cadence';
const DAY = 86_400_000;

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
let workspace: WorkspaceStore;

/**
 * happy-dom keeps one registry of custom elements for the whole file and Melodic never defines a name
 * twice, so without this the elements of a later test would still be the first test's classes, tied
 * to the first test's stores.
 */
function forgetElements(): void {
	const registry = customElements as unknown as Record<symbol, unknown>;
	for (const key of Object.getOwnPropertySymbols(registry)) {
		const held = registry[key];
		if (held instanceof Map) {
			held.clear();
		}
	}
}

beforeEach(async () => {
	forgetElements();
	w = await world();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	await repos.init();
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	await agents.init();
	repos.setTab('agents');
	workspace = w.get((await import('../../services/workspace.store')).WorkspaceStore);
	// A turn that starts stays started: the demo's own would play out over seconds.
	w.on('agent_start', () => undefined);
});

function session(over: Partial<AgentSession> = {}): AgentSession {
	const id = over.id ?? 's1';
	return {
		id,
		repoId: REPO,
		title: 'Add a shuffle button',
		cwd: `${REPO}.worktrees/${id}`,
		branch: `agent/${id}`,
		isolated: true,
		mode: 'acceptEdits',
		sessionId: `claude-${id}`,
		status: 'idle',
		items: [{ kind: 'user', text: 'Add a shuffle button to the player' }],
		cost: 0,
		updated: Date.now(),
		kind: 'task',
		group: null,
		attempt: 1,
		base: 'b'.repeat(40),
		tools: null,
		unread: false,
		review: false,
		stopped: false,
		investigation: null,
		check: null,
		brief: null,
		name: null,
		...over,
	};
}

function conversation(over: Partial<Conversation> = {}): Conversation {
	return { id: 'c1', kind: 'claude', repoId: REPO, cwd: REPO, branch: 'main', title: 'Why is the upload test flaky', titled: true, sessionId: 'claude-c1', state: 'idle', waitingFor: null, lastSaid: '', subagents: [], created: Date.now(), updated: Date.now(), unread: false, ...over };
}

/** The sessions in the app, each with the worktree it works in (work to review is settled when its worktree is gone). */
function seed(sessions: AgentSession[], conversations: Conversation[] = []): void {
	const trees: Worktree[] = [
		{ path: REPO, branch: 'main', head: 'a'.repeat(40), isMain: true, active: true, changes: 0, landed: false },
		...sessions.filter((s) => s.isolated && s.repoId === REPO).map((s) => ({ path: s.cwd, branch: s.branch, head: 'c'.repeat(40), isMain: false, active: false, changes: 2, landed: false })),
	];
	w.on('worktree_list', () => trees);
	agents.sessions.set(sessions);
	workspace.conversations.set(conversations);
}

/** Tags that mark words inside a sentence: nothing is read between them and the words around them. */
const INLINE = new Set(['B', 'I', 'EM', 'STRONG', 'CODE', 'U']);

/**
 * What a person reads under `root`, through shadow roots: text that stands together stays together
 * ("$0.42", not "$ 0.42"), and the icons' glyphs are left out.
 */
function read(root: Element | ShadowRoot): string {
	const parts: string[] = [];
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			parts.push(node.textContent ?? '');
		} else if (node instanceof Element) {
			if (node.tagName !== 'STYLE' && node.tagName !== 'SCRIPT') {
				const gap = INLINE.has(node.tagName) ? '' : ' ';
				parts.push(gap);
				if (node.shadowRoot) {
					walk(node.shadowRoot);
				}
				node.childNodes.forEach(walk);
				parts.push(gap);
			}
		} else {
			node.childNodes.forEach(walk);
		}
	};
	walk(root);
	return parts
		.join('')
		.replace(/[\uE000-\uF8FF]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The page as its headings, each with the words of what stands under it. */
function sections(el: HTMLElement): Record<string, string> {
	const out: Record<string, string> = {};
	let heading = '';
	for (const node of el.shadowRoot!.querySelectorAll('h2, article, section, button[title="Open this agent"], button[title="Show this conversation in the Claude pane"]')) {
		if (node.tagName === 'H2' && !node.closest('section')) {
			heading = read(node).replace(/ · \d+$/, '');
			out[heading] = '';
		} else if (node.tagName !== 'H2' && node.tagName !== 'SECTION' && !node.closest('article button')) {
			out[heading] = `${out[heading] ?? ''} | ${read(node)}`;
		}
	}
	return out;
}

const card = (el: HTMLElement, name: string): HTMLElement => all(el, 'article').find((a) => read(a).includes(name))!;

function button(root: Element, label: string | RegExp): HTMLElement | null {
	return all(root, 'ml-button, button').find((b) => (typeof label === 'string' ? read(b) === label : label.test(read(b)))) ?? null;
}

/** A click on a button; an `ml-button` listens on the button inside it. */
async function press(el: Element | null): Promise<void> {
	if (!el) {
		throw new Error('nothing to press');
	}
	await click(el.tagName === 'ML-BUTTON' ? find(el, 'button') : el);
}

/** Types into an `ml-input`. */
async function type(field: Element | null, value: string): Promise<void> {
	const box = field && find<HTMLInputElement>(field, 'input');
	if (!box) {
		throw new Error('nothing to type in');
	}
	box.value = value;
	box.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
	await settle();
}

const page = (): Promise<HTMLElement> => mount('ms-agents-overview');

function waitingOn(reason: NonNullable<Pipeline['reason']>, step: 'plan' | 'fix' | 'ship' | 'test', note: string, kind: Pipeline['kind'] = 'bug'): Pipeline {
	return withStep({ ...newPipeline(kind), step, waiting: true, note, reason }, step, { state: 'you' });
}

describe('where each one stands', () => {
	test('work to review needs you, a running turn is working, a seen finished one is done', async () => {
		seed([
			session({ id: 'review', title: 'Shuffle button', review: true }),
			session({ id: 'running', title: 'Repeat mode', status: 'running' }),
			session({ id: 'finished', title: 'Rename the queue', isolated: false, cwd: REPO }),
		]);
		const s = sections(await page());
		expect(Object.keys(s)).toEqual(['Needs you', 'Working', 'Done today']);
		expect(s['Needs you']).toContain('Shuffle button');
		expect(s['Working']).toContain('Repeat mode');
		expect(s['Done today']).toContain('Rename the queue');
		expect(s['Needs you']).not.toContain('Repeat mode');
		expect(s['Needs you']).not.toContain('Rename the queue');
	});

	test('the headings count what is under them', async () => {
		seed([session({ id: 'a', review: true }), session({ id: 'b', review: true }), session({ id: 'c', status: 'running' })]);
		const el = await page();
		expect([...el.shadowRoot!.querySelectorAll('h2')].map((h) => read(h))).toEqual(['Needs you · 2', 'Working · 1']);
	});

	test('a turn that ended unseen needs you until it is looked at, even a failed or a read-only one', async () => {
		seed([
			session({ id: 'failed-unseen', title: 'Failed and unseen', status: 'failed', unread: true }),
			session({ id: 'failed-seen', title: 'Failed and seen', status: 'failed' }),
			session({ id: 'answer', title: 'Where is auth handled', kind: 'ask', isolated: false, cwd: REPO, unread: true }),
		]);
		const s = sections(await page());
		expect(s['Needs you']).toContain('Failed and unseen');
		expect(s['Needs you']).toContain('Where is auth handled');
		expect(s['Needs you']).toContain('Read the answer');
		expect(s['Done today']).toContain('Failed and seen');
	});

	test('an open question in its brief needs you, though there is no work to review', async () => {
		seed([session({ title: 'Queue', brief: { title: 'Queue wraps on repeat', did: 'The queue wraps.', needs: 'Should repeat-one restart the track?', choices: [] }, name: 'Queue wraps on repeat' })]);
		const s = sections(await page());
		expect(s['Needs you']).toContain('Queue wraps on repeat');
		expect(s['Needs you']).toContain('Should repeat-one restart the track?');
	});

	test('a Claude conversation that asks needs you, one on a turn is working, one at its prompt is done', async () => {
		seed([], [
			conversation({ id: 'asks', title: 'Asking conversation', state: 'waiting', waitingFor: 'Claude needs your permission to use Bash' }),
			conversation({ id: 'busy', title: 'Busy conversation', state: 'working' }),
			conversation({ id: 'ready', title: 'Ready conversation', state: 'idle', lastSaid: 'All done here.' }),
			conversation({ id: 'ready-unseen', title: 'Unseen conversation', state: 'idle', unread: true }),
		]);
		const s = sections(await page());
		expect(s['Needs you']).toContain('Asking conversation');
		expect(s['Needs you']).toContain('Claude needs your permission to use Bash');
		expect(s['Needs you']).toContain('Unseen conversation');
		expect(s['Working']).toContain('Busy conversation');
		expect(s['Done today']).toContain('Ready conversation');
	});

	test('a terminal of the workspace is not an agent and is not listed', async () => {
		seed([], [conversation({ id: 'shell', kind: 'shell', title: 'zsh in harmony', state: 'working' })]);
		expect(read(await page())).not.toContain('zsh in harmony');
	});

	test('a pipeline between Claude turns is still working; one that waits needs you', async () => {
		seed([
			session({ id: 'testing', title: 'Runs its tests', task: 'Runs its tests', pipeline: withStep({ ...newPipeline('bug'), step: 'test' }, 'test', { state: 'run' }) }),
			session({ id: 'plan', title: 'Has a plan', task: 'Has a plan', pipeline: waitingOn('approve', 'plan', 'Approve the plan to start coding.') }),
		]);
		const s = sections(await page());
		expect(s['Working']).toContain('Runs its tests');
		expect(s['Working']).toContain('Running the tests · free');
		expect(s['Needs you']).toContain('Has a plan');
		expect(s['Needs you']).toContain('Approve the plan to start coding.');
	});

	test('an investigation that asks to run something needs you, though its turn is still going', async () => {
		seed([
			session({
				id: 'inv',
				kind: 'investigate',
				title: 'NullReferenceException in ApplyDiscount',
				status: 'running',
				investigation: { summary: 'NullReferenceException in ApplyDiscount', description: '', targetId: 't', targetName: 'Shop.Api', port: 5210, step: 3, details: {}, thinking: '', approval: { key: 'inv', request: 'r1', tool: 'http_request', target: null, group: null, project: null, command: null, port: 5210, method: 'GET', path: '/orders/7', body: null, touches: null }, runs: 1, started: Date.now(), ended: null, report: null, leftover: [], cleanups: 0, checking: false, tab: null },
			}),
		]);
		const s = sections(await page());
		expect(s['Needs you']).toContain('Wants to run GET /orders/7');
		expect(s['Working']).toBeUndefined();
	});

	test('with nothing waiting and nothing working it says so', async () => {
		seed([session({ title: 'Old and done', isolated: false, cwd: REPO })]);
		const el = await page();
		expect(read(el)).toContain('Nothing is waiting on you');
		expect(sections(el)['Done today']).toContain('Old and done');
	});

	test('sessions started in a terminal are not on the page: nothing reports their state', async () => {
		seed([session({ review: true })]);
		await workspace.loadElsewhere(REPO);
		expect(workspace.elsewhereIn(REPO).length).toBeGreaterThan(0);
		const shown = read(await page());
		for (const outside of workspace.elsewhereIn(REPO)) {
			expect(shown).not.toContain(outside.title ?? outside.prompt);
		}
	});
});

describe('a card', () => {
	test('says what was asked, what it did and what it needs', async () => {
		seed([
			session({
				name: 'Queue wraps on repeat',
				cost: 0.42,
				review: true,
				items: [{ kind: 'user', text: 'Make the queue wrap when repeat is on' }],
				brief: { title: 'Queue wraps on repeat', did: 'The queue wraps to the first track; the queue tests pass.', needs: null, choices: [] },
			}),
		]);
		const shown = read(card(await page(), 'Queue wraps on repeat'));
		expect(shown).toContain('Asked Make the queue wrap when repeat is on');
		expect(shown).toContain('Did The queue wraps to the first track; the queue tests pass.');
		expect(shown).toContain('Review its changes, then merge');
		expect(shown).toContain('agent/s1');
		expect(shown).toContain('$0.42');
	});

	test('while it works, says the step it is on in Claude’s own words for it', async () => {
		seed([session({ status: 'running', items: [{ kind: 'user', text: 'Fix it' }, { kind: 'tool', text: 'Bash', detail: 'npm test -- queue', about: 'Run the queue tests' }] })]);
		expect(read(card(await page(), 'Add a shuffle button'))).toContain('Run the queue tests');
	});

	test('names its repository on the Agents page', async () => {
		seed([session({ id: 'here', title: 'In harmony', review: true }), session({ id: 'there', repoId: OTHER, cwd: OTHER, isolated: false, title: 'In cadence', unread: true })]);
		const el = await page();
		expect(read(card(el, 'In harmony'))).toContain('harmony');
		expect(read(card(el, 'In cadence'))).toContain('cadence');
	});

	test('leaves out a session whose repository is no longer in the app', async () => {
		seed([session({ id: 'gone', repoId: '/Users/demo/Source/removed', title: 'From a removed repository', review: true }), session({ id: 'kept', title: 'Still here', review: true })]);
		const shown = read(await page());
		expect(shown).toContain('Still here');
		expect(shown).not.toContain('From a removed repository');
	});

	test('shows what Claude wrote as text, never as markup', async () => {
		seed([session({ review: true, name: '<img src=x onerror=alert(1)>', brief: { title: 'x', did: '<script>alert(2)</script>', needs: '<b>bold?</b>', choices: ['<i>yes</i>'] } })]);
		const el = await page();
		expect(all(el, 'img, script, article b > b, article i').length).toBe(0);
		const shown = read(el);
		expect(shown).toContain('<img src=x onerror=alert(1)>');
		expect(shown).toContain('<script>alert(2)</script>');
		expect(shown).toContain('<b>bold?</b>');
		expect(shown).toContain('<i>yes</i>');
	});

	test('a suggested choice is a button that sends its text as the reply', async () => {
		seed([session({ brief: { title: 'Queue', did: 'The queue wraps.', needs: 'Should repeat-one restart the track?', choices: ['Yes, restart it', 'No, wrap as well'] } })]);
		const el = await page();
		expect(button(el, 'No, wrap as well')).not.toBeNull();
		await press(button(el, 'Yes, restart it'));
		const sent = w.sent('agent_start');
		expect(sent.length).toBe(1);
		expect(sent[0].args).toMatchObject({ key: 's1', prompt: 'Yes, restart it', resume: 'claude-s1', cwd: `${REPO}.worktrees/s1` });
		// It is working now, and the question it asked is answered.
		expect(agents.get('s1')!.status).toBe('running');
		expect(sections(el)['Working']).toContain('Add a shuffle button');
		expect(button(el, 'Yes, restart it')).toBeNull();
	});

	test('with choices to give, Review changes is not offered beside them', async () => {
		seed([session({ review: true, brief: { title: 'Queue', did: 'Done.', needs: 'Which one?', choices: ['This one'] } })]);
		const el = await page();
		expect(button(el, 'This one')).not.toBeNull();
		expect(button(el, 'Review changes')).toBeNull();
	});

	test('Reply… opens a box on the card; Enter sends what was typed', async () => {
		seed([session({ review: true })]);
		const el = await page();
		expect(find(el, 'ml-input')).toBeNull();
		await press(button(el, 'Reply…'));
		const box = find(el, 'ml-input')!;
		expect(box.getAttribute('placeholder')).toBe('Reply to Add a shuffle button');
		expect(button(el, 'Send')!.hasAttribute('disabled')).toBe(true);
		await type(box, '  Use the existing icon  ');
		expect(button(el, 'Send')!.hasAttribute('disabled')).toBe(false);
		box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true }));
		await settle();
		expect(w.sent('agent_start').map((c) => c.args.prompt)).toEqual(['Use the existing icon']);
		expect(find(el, 'ml-input')).toBeNull();
	});

	test('Shift+Enter does not send, and Escape puts the box away without sending', async () => {
		seed([session({ review: true })]);
		const el = await page();
		await press(button(el, 'Reply…'));
		await type(find(el, 'ml-input'), 'half a thought');
		find(el, 'ml-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, composed: true, cancelable: true }));
		await settle();
		expect(find(el, 'ml-input')).not.toBeNull();
		find(el, 'ml-input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true }));
		await settle();
		expect(find(el, 'ml-input')).toBeNull();
		expect(w.sent('agent_start')).toEqual([]);
		expect(button(el, 'Reply…')).not.toBeNull();
	});

	test('the Send button sends, and Cancel does not', async () => {
		seed([session({ id: 'a', title: 'First', review: true }), session({ id: 'b', title: 'Second', review: true, updated: Date.now() - 1000 })]);
		const el = await page();
		await press(button(card(el, 'Second'), 'Reply…'));
		await type(find(el, 'ml-input'), 'not this');
		await press(button(el, 'Cancel'));
		expect(w.sent('agent_start')).toEqual([]);
		await press(button(card(el, 'Second'), 'Reply…'));
		// A box opened again starts empty.
		expect(button(el, 'Send')!.hasAttribute('disabled')).toBe(true);
		await type(find(el, 'ml-input'), 'this one');
		await press(button(el, 'Send'));
		expect(w.sent('agent_start').map((c) => [c.args.key, c.args.prompt])).toEqual([['b', 'this one']]);
	});

	test('a running one has Stop and no reply box; Stop ends its turn', async () => {
		seed([session({ status: 'running' })]);
		const el = await page();
		expect(button(el, 'Reply…')).toBeNull();
		expect(button(el, 'Mark done')).toBeNull();
		await press(button(el, 'Stop'));
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual(['s1']);
		expect(agents.get('s1')).toMatchObject({ status: 'idle', stopped: true });
		expect(button(el, 'Stop')).toBeNull();
	});

	test('Mark done settles it without touching its worktree or branch', async () => {
		seed([session({ review: true, unread: true, brief: { title: 'Queue', did: 'Done.', needs: 'Merge it?', choices: ['Yes'] } })]);
		const el = await page();
		const before = w.calls.length;
		await press(button(el, 'Mark done'));
		expect(agents.get('s1')).toMatchObject({ review: false, unread: false, brief: { needs: null, choices: [] } });
		const s = sections(el);
		expect(s['Needs you']).toBeUndefined();
		expect(s['Done today']).toContain('Add a shuffle button');
		expect(w.calls.slice(before).map((c) => c.cmd).filter((c) => /worktree_remove|branch_delete|pipeline_clean/.test(c))).toEqual([]);
	});

	test('Review changes leaves the page for the agent’s worktree on the Changes tab, and the work still waits', async () => {
		seed([session({ review: true, unread: true })]);
		repos.showOverview(true);
		const el = await page();
		await press(button(el, 'Review changes'));
		expect(repos.overview()).toBe(false);
		expect(w.sent('worktree_select').map((c) => c.args.path)).toEqual([`${REPO}.worktrees/s1`]);
		expect(repos.tab()).toBe('changes');
		// Looking is not finishing: it is merged, marked done, or its worktree goes.
		expect(agents.get('s1')).toMatchObject({ review: true, unread: false });
	});

	test('a task in the main checkout has no merge step, so looking at its changes settles it', async () => {
		seed([session({ review: true, isolated: false, cwd: REPO, branch: 'main' })]);
		const el = await page();
		expect(read(card(el, 'Add a shuffle button'))).toContain('Review its changes');
		await press(button(el, 'Review changes'));
		expect(agents.get('s1')!.review).toBe(false);
		expect(w.sent('worktree_select').map((c) => c.args.path)).toEqual([null]);
	});

	test('Open goes to the session in its repository, on the Agents tab', async () => {
		seed([session({ id: 'there', repoId: OTHER, cwd: OTHER, isolated: false, title: 'In cadence', unread: true })]);
		repos.showOverview(true);
		const el = await page();
		await press(button(card(el, 'In cadence'), 'Open'));
		expect(repos.overview()).toBe(false);
		expect(repos.repo()!.id).toBe(OTHER);
		expect(repos.tab()).toBe('agents');
		expect(agents.selectedId()).toBe('there');
		expect(agents.get('there')!.unread).toBe(false);
	});

	test('a question is called a question and has no changes to review', async () => {
		seed([session({ kind: 'ask', isolated: false, cwd: REPO, title: 'Where is auth handled', unread: true, tools: ['Read', 'Grep', 'Glob'] })]);
		const el = await page();
		expect(read(card(el, 'Where is auth handled'))).toContain('Question');
		expect(button(el, 'Review changes')).toBeNull();
		expect(button(el, 'Reply…')).not.toBeNull();
	});

	test('an investigation is not answered from its card', async () => {
		seed([session({ kind: 'investigate', title: 'Crash on checkout', unread: true, investigation: { summary: 'Crash on checkout', description: '', targetId: null, targetName: null, port: null, step: 6, details: {}, thinking: '', approval: null, runs: 2, started: Date.now() - 60_000, ended: Date.now(), report: null, leftover: [], cleanups: 0, checking: false, tab: null } })]);
		const el = await page();
		expect(button(el, 'Reply…')).toBeNull();
		expect(button(el, 'Open')).not.toBeNull();
	});

	test('a conversation is answered in its terminal: its card only opens it', async () => {
		seed([], [conversation({ state: 'waiting', waitingFor: 'Claude is waiting for your input', lastSaid: 'Shall I go on?', branch: 'feature/upload' })]);
		repos.showOverview(true);
		const el = await page();
		const shown = read(card(el, 'Why is the upload test flaky'));
		expect(shown).toContain('Claude conversation · feature/upload');
		expect(shown).toContain('Said Shall I go on?');
		expect(button(el, 'Reply…')).toBeNull();
		expect(button(el, 'Mark done')).toBeNull();
		let opened = '';
		workspace.open = async (id: string) => void (opened = id);
		await press(button(el, 'Open'));
		expect(opened).toBe('c1');
		expect(repos.overview()).toBe(false);
	});
});

describe('a task with a pipeline on its card', () => {
	test('shows its six steps and where it stands', async () => {
		seed([session({ title: 'Wrap the queue', task: 'Wrap the queue', pipeline: waitingOn('approve', 'plan', 'Approve the plan to start coding.') })]);
		const shown = read(card(await page(), 'Wrap the queue'));
		expect(shown).toContain('Plan Code Review Test Fix Ship');
		expect(shown).toContain('Approve the plan to start coding.');
	});

	test('a plan to approve: Approve plan starts the coding turn', async () => {
		seed([session({ task: 'Wrap the queue', pipeline: waitingOn('approve', 'plan', 'Approve the plan to start coding.') })]);
		const el = await page();
		await press(button(el, 'Approve plan'));
		expect(w.sent('agent_start').length).toBe(1);
		expect(agents.get('s1')!.pipeline).toMatchObject({ step: 'code', waiting: false, steps: { plan: { state: 'done', summary: 'Approved by you.' }, code: { state: 'run' } } });
	});

	test('the plan’s question is answered with a choice, which approves it with that answer', async () => {
		seed([session({ task: 'Wrap the queue', brief: { title: 'Queue', did: 'Planned it.', needs: 'Should repeat-one restart the same track?', choices: ['Yes, restart it', 'No, wrap as well'] }, pipeline: waitingOn('approve', 'plan', 'Should repeat-one restart the same track?') })]);
		const el = await page();
		await press(button(el, 'No, wrap as well'));
		expect(agents.get('s1')!.pipeline!.steps.plan.summary).toBe('Approved by you, with: No, wrap as well');
		expect(String(w.sent('agent_start')[0].args.prompt)).toContain('No, wrap as well');
	});

	test('ready to ship: Ship… opens the task, where the Merge dialog is', async () => {
		seed([session({ task: 'Wrap the queue', pipeline: waitingOn('ship', 'ship', 'Every check passes. Merge it or open a pull request.') })]);
		repos.showOverview(true);
		const el = await page();
		expect(button(el, 'Approve plan')).toBeNull();
		await press(button(el, 'Ship…'));
		expect(repos.overview()).toBe(false);
		expect(agents.selectedId()).toBe('s1');
		expect(w.sent('merge_branch')).toEqual([]);
	});

	test('at the fix limit: One more round allows another fix and starts it', async () => {
		const stuck = withStep({ ...waitingOn('limit', 'fix', 'Stopped after 3 fixes: 41 passed, 1 failed.'), fixes: 3, tests: { ok: false, summary: '41 passed, 1 failed', failures: ['queue wraps'], commands: ['npm test'], output: 'x', none: false } }, 'test', { state: 'warn' });
		seed([session({ task: 'Wrap the queue', pipeline: stuck })]);
		const el = await page();
		await press(button(el, 'One more round'));
		expect(agents.get('s1')!.pipeline).toMatchObject({ allowedFixes: 4, fixes: 4, step: 'fix', waiting: false });
		expect(w.sent('agent_start').length).toBe(1);
	});

	test('stopped or failed: Carry on runs the step it stopped at again', async () => {
		seed([session({ task: 'Wrap the queue', pipeline: waitingOn('halted', 'test', 'Stopped by you. Its branch keeps everything committed so far.') })]);
		const el = await page();
		await press(button(el, 'Carry on'));
		expect(w.sent('pipeline_tests').length).toBe(1);
	});

	test('while it runs it can be stopped, and nothing else is offered for it', async () => {
		seed([session({ status: 'running', task: 'Wrap the queue', pipeline: withStep({ ...newPipeline('bug'), step: 'code' }, 'code', { state: 'run' }) })]);
		const el = await page();
		expect(button(el, 'Approve plan')).toBeNull();
		expect(button(el, 'Reply…')).toBeNull();
		await press(button(el, 'Stop'));
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual(['s1']);
	});

	test('a reply typed on its card goes to the pipeline: while the plan waits it changes the plan', async () => {
		seed([session({ task: 'Wrap the queue', pipeline: waitingOn('approve', 'plan', 'Approve the plan to start coding.') })]);
		const el = await page();
		await press(button(el, 'Reply…'));
		await type(find(el, 'ml-input'), 'Also cover an empty queue');
		await press(button(el, 'Send'));
		const sent = w.sent('agent_start');
		expect(sent.length).toBe(1);
		expect(String(sent[0].args.prompt)).toContain('[pipeline-plan]');
		expect(String(sent[0].args.prompt)).toContain('Also cover an empty queue');
		// Still planning: read and search only.
		expect(sent[0].args.mode).toBe('default');
		expect(agents.get('s1')!.pipeline!.step).toBe('plan');
	});
});

describe('done', () => {
	test('today’s are rows; earlier ones wait behind "Show N earlier"', async () => {
		seed([
			session({ id: 'today', title: 'Finished today', isolated: false, cwd: REPO }),
			session({ id: 'old1', title: 'Finished last week', isolated: false, cwd: REPO, updated: Date.now() - 6 * DAY }),
			session({ id: 'old2', title: 'Finished last month', isolated: false, cwd: REPO, updated: Date.now() - 30 * DAY }),
		]);
		const el = await page();
		expect(sections(el)['Done today']).toContain('Finished today');
		expect(read(el)).not.toContain('Finished last week');
		await press(button(el, 'Show 2 earlier'));
		const s = sections(el);
		expect(s['Done']).toContain('Finished last week');
		expect(s['Done']).toContain('Finished last month');
		expect(s['Done']).toContain('Finished today');
		await press(button(el, 'Show today only'));
		expect(read(el)).not.toContain('Finished last week');
	});

	test('with nothing finished today the earlier ones are still reachable', async () => {
		seed([session({ id: 'old', title: 'Finished last week', isolated: false, cwd: REPO, updated: Date.now() - 6 * DAY })]);
		const el = await page();
		expect(read(el)).not.toContain('Finished last week');
		await press(button(el, 'Show 1 finished earlier'));
		expect(read(el)).toContain('Finished last week');
	});

	test('a row says what it did and opens the session', async () => {
		seed([session({ title: 'Rename the queue', isolated: false, cwd: REPO, brief: { title: 'Queue renamed', did: 'Renamed Queue to PlayQueue in 4 files.', needs: null, choices: [] }, name: 'Queue renamed' })]);
		repos.showOverview(true);
		const el = await page();
		const row = find(el, 'button[title="Open this agent"]')!;
		expect(read(row)).toContain('Queue renamed');
		expect(read(row)).toContain('Renamed Queue to PlayQueue in 4 files.');
		await click(row);
		expect(agents.selectedId()).toBe('s1');
		expect(repos.overview()).toBe(false);
	});
});

describe('the page and the desk', () => {
	test('the page is titled, lists every repository and goes back to the open one', async () => {
		seed([session({ id: 'here', title: 'In harmony', review: true }), session({ id: 'there', repoId: OTHER, cwd: OTHER, isolated: false, title: 'In cadence', unread: true })]);
		repos.showOverview(true);
		const el = await page();
		expect(read(find(el, 'h1')!)).toBe('Agents');
		expect(read(el)).toContain('In cadence');
		await press(button(el, 'Back to harmony'));
		expect(repos.overview()).toBe(false);
	});

	test('the desk lists the open repository only, with no title and no repository names on its cards', async () => {
		seed([session({ id: 'here', title: 'In harmony', review: true }), session({ id: 'there', repoId: OTHER, cwd: OTHER, isolated: false, title: 'In cadence', unread: true })]);
		const el = await mount('ms-agents-overview', { repoId: REPO });
		expect(find(el, 'h1')).toBeNull();
		expect(button(el, /^Back to/)).toBeNull();
		const shown = read(el);
		expect(shown).toContain('In harmony');
		expect(shown).not.toContain('In cadence');
		expect(read(card(el, 'In harmony'))).not.toContain('harmony agent/here');
		expect(all(card(el, 'In harmony'), '[title="/Users/demo/Source/harmony"]').length).toBe(0);
	});

	test('a session that arrives after an empty first look is shown', async () => {
		seed([]);
		const el = await page();
		expect(read(el)).toContain('Nothing is waiting on you');
		seed([session({ title: 'Arrived later', review: true })]);
		await settle();
		expect(sections(el)['Needs you']).toContain('Arrived later');
		expect(read(el)).not.toContain('Nothing is waiting on you');
	});
});

describe('the board', () => {
	const columns = (el: HTMLElement): Record<string, string> => Object.fromEntries(all(el, 'section').map((c) => [c.getAttribute('aria-label')!, read(c)]));

	test('has seven columns, Plan to Done, with each task in the column of its step', async () => {
		seed([
			session({ id: 'p', title: 'Planning task', task: 'Planning task', pipeline: waitingOn('approve', 'plan', 'Approve the plan to start coding.') }),
			session({ id: 't', title: 'Testing task', task: 'Testing task', pipeline: withStep({ ...newPipeline('quick'), step: 'test' }, 'test', { state: 'run' }) }),
			session({ id: 's', title: 'Shipping task', task: 'Shipping task', pipeline: waitingOn('ship', 'ship', 'Every check passes. Merge it or open a pull request.', 'feature') }),
			session({ id: 'd', title: 'Shipped task', task: 'Shipped task', pipeline: withStep({ ...newPipeline('chore'), step: 'done' }, 'ship', { state: 'done' }) }),
		]);
		const el = await page();
		await press(button(el, 'Board'));
		const cols = columns(el);
		expect(Object.keys(cols)).toEqual(['Plan', 'Code', 'Review', 'Test', 'Fix', 'Ship', 'Done']);
		expect(cols.Plan).toContain('Planning task');
		expect(cols.Plan).toContain('Bug');
		expect(cols.Test).toContain('Testing task');
		expect(cols.Test).toContain('Quick fix');
		expect(cols.Ship).toContain('Shipping task');
		expect(cols.Done).toContain('Shipped task');
		expect(cols.Done).toContain('Shipped');
		expect(cols.Code).toContain('Nothing here');
		expect(cols.Plan).not.toContain('Testing task');
	});

	test('Done holds today’s only', async () => {
		seed([
			session({ id: 'd1', title: 'Shipped today', task: 'Shipped today', pipeline: { ...newPipeline('bug'), step: 'done' } }),
			session({ id: 'd2', title: 'Shipped last week', task: 'Shipped last week', updated: Date.now() - 6 * DAY, pipeline: { ...newPipeline('bug'), step: 'done' } }),
		]);
		const el = await page();
		await press(button(el, 'Board'));
		expect(columns(el).Done).toContain('Shipped today');
		expect(columns(el).Done).not.toContain('Shipped last week');
	});

	test('says how many open-ended sessions and conversations are only in the list', async () => {
		seed([session({ id: 'p', task: 'Planning task', pipeline: waitingOn('approve', 'plan', 'Approve the plan.') }), session({ id: 'open', title: 'Open-ended', review: true })], [conversation()]);
		const el = await page();
		await press(button(el, 'Board'));
		expect(read(el)).toContain('2 open-ended sessions and conversations are in the list.');
		expect(read(el)).not.toContain('Open-ended ');
	});

	test('a card on the board opens its task', async () => {
		seed([session({ id: 'p', title: 'Planning task', task: 'Planning task', pipeline: waitingOn('approve', 'plan', 'Approve the plan.') })]);
		const el = await page();
		await press(button(el, 'Board'));
		await click(all(el, 'section button').find((b) => read(b).includes('Planning task'))!);
		expect(agents.selectedId()).toBe('p');
	});

	test('List or Board is remembered for the next time', async () => {
		seed([session({ review: true })]);
		const el = await page();
		expect(button(el, 'List')!.getAttribute('aria-pressed')).toBe('true');
		await press(button(el, 'Board'));
		expect(button(el, 'Board')!.getAttribute('aria-pressed')).toBe('true');
		expect(localStorage.getItem('studio.agents.view')).toBe('board');
		el.remove();
		const again = await page();
		expect(all(again, 'section').length).toBe(7);
		await press(button(again, 'List'));
		expect(localStorage.getItem('studio.agents.view')).toBe('list');
		expect(sections(again)['Needs you']).toContain('Add a shuffle button');
	});
});
