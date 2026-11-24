import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import { newPipeline, withStep } from '../../shared/pipeline';
import type { AgentSession, AgentsStore } from '../../services/agents.store';
import type { RepoStore } from '../../services/repo.store';
import type { Conversation, WorkspaceStore } from '../../services/workspace.store';
import type { ClaudeSession, Worktree } from '../../services/backend.service';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';
const OTHER = '/Users/demo/Source/cadence';
/** The branch the demo repository's main checkout is on. */
const MAIN = 'feature/repeat-mode';

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

/** happy-dom has no Popover API: enough of one for `ml-popover` to open and close, and to say so. */
function popovers(): void {
	const open = new WeakSet<Element>();
	const flip = (el: HTMLElement, to: boolean): void => {
		if (open.has(el) !== to) {
			to ? open.add(el) : open.delete(el);
			el.dispatchEvent(Object.assign(new Event('toggle'), { newState: to ? 'open' : 'closed', oldState: to ? 'closed' : 'open' }));
		}
	};
	Object.assign(HTMLElement.prototype, {
		showPopover(this: HTMLElement) {
			flip(this, true);
		},
		hidePopover(this: HTMLElement) {
			flip(this, false);
		},
		togglePopover(this: HTMLElement) {
			flip(this, !open.has(this));
		},
	});
}

/**
 * happy-dom's HTML parser drops the `#` of `<ml-dialog #new-agent>`, and that name is what a dialog is
 * opened by (`DialogService.open('new-agent')`): it is put back where `ml-dialog` looks for it.
 */
const attributeNames = Element.prototype.getAttributeNames;
Element.prototype.getAttributeNames = function (this: Element): string[] {
	const names = attributeNames.call(this);
	return this.tagName === 'ML-DIALOG' ? names.map((n) => (n !== 'style' && !n.startsWith('#') && this.getAttribute(n) === '' ? `#${n}` : n)) : names;
};

beforeEach(async () => {
	forgetElements();
	popovers();
	w = await world();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	await repos.init();
	repos.setTab('agents');
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	await agents.init();
	workspace = w.get((await import('../../services/workspace.store')).WorkspaceStore);
	// A turn that starts stays started: the demo's own would play out over seconds.
	w.on('agent_start', () => undefined);
	// No sessions started in a terminal, unless a test has some.
	w.on('claude_sessions', () => []);
});

afterEach(() => {
	vi.useRealTimers();
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

function outside(over: Partial<ClaudeSession> = {}): ClaudeSession {
	return { id: 'cli-1', cwd: REPO, branch: 'main', title: 'Started in a terminal', prompt: 'Look into the build', lastPrompt: null, lastSaid: 'Done.', modified: Date.now() - 3_600_000, ...over };
}

/** The sidebar's Agents tab with these in the app, each isolated session with the worktree it works in. */
async function tab(sessions: AgentSession[] = [], conversations: Conversation[] = [], extraTrees: Worktree[] = []): Promise<HTMLElement> {
	const trees: Worktree[] = [
		{ path: REPO, branch: MAIN, head: 'a'.repeat(40), isMain: true, active: true, changes: 4, landed: false },
		...sessions.filter((s) => s.isolated && s.repoId === REPO).map((s) => ({ path: s.cwd, branch: s.branch, head: 'c'.repeat(40), isMain: false, active: false, changes: 2, landed: false })),
		...extraTrees,
	];
	w.on('worktree_list', () => trees);
	agents.sessions.set(sessions);
	workspace.conversations.set(conversations);
	return mount('ms-agents');
}

/** Tags that mark words inside a sentence: nothing is read between them and the words around them. */
const INLINE = new Set(['B', 'I', 'EM', 'STRONG', 'CODE', 'U']);

/**
 * What a person reads under `root`, through shadow roots: text that stands together stays together,
 * the icons' glyphs are left out, and so are a dialog that is not open and a menu that is not open.
 */
function read(root: Element | ShadowRoot): string {
	const parts: string[] = [];
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			parts.push(node.textContent ?? '');
		} else if (node instanceof Element) {
			const closedDialog = node.tagName === 'ML-DIALOG' && !node.shadowRoot?.querySelector('dialog')?.open;
			const menu = node.parentElement?.tagName === 'ML-POPOVER' && node.getAttribute('slot') !== 'trigger' ? (node.parentElement as HTMLElement & { component?: { isOpen: boolean } }) : null;
			if (node.tagName !== 'STYLE' && node.tagName !== 'SCRIPT' && !closedDialog && !(menu && !menu.component?.isOpen)) {
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
		.replace(/[-]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

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

const disabled = (el: Element | null): boolean => !!el && el.hasAttribute('disabled');

/** Types into an `ml-input` or `ml-textarea`. */
async function type(field: Element | null, value: string): Promise<void> {
	const box = field && find<HTMLInputElement>(field, 'input, textarea');
	if (!box) {
		throw new Error('nothing to type in');
	}
	box.value = value;
	box.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
	await settle();
}

/** The list as its group labels, each with the words of the rows under it. The class names are the only handle on these. */
function groups(el: HTMLElement): Record<string, string> {
	const out: Record<string, string> = {};
	let label = '';
	for (const node of find(el, '.list')!.children) {
		if (node.classList.contains('group') && node.tagName !== 'BUTTON') {
			label = read(node).replace(/ · \d+$/, '');
			out[label] = '';
		} else if (node.classList.contains('session') || node.classList.contains('attempts')) {
			out[label] = `${out[label] ?? ''} | ${read(node)}`;
		}
	}
	return out;
}

const labels = (el: HTMLElement): string[] => all(el, '.list > .group').filter((g) => g.tagName !== 'BUTTON').map((g) => read(g));
/** A row of the list, by words in it. */
const row = (el: HTMLElement, words: string): HTMLElement => all(el, '.session, .attempts').find((r) => read(r).includes(words))!;
/** The dialog headed `title`, and whether it is open. */
const dialog = (el: HTMLElement, title: RegExp): HTMLElement => all(el, 'ml-dialog').find((d) => title.test(find(d, 'h3')?.textContent ?? ''))!;
const isOpen = (d: HTMLElement): boolean => !!find<HTMLDialogElement>(d, 'dialog')?.open;
/**
 * A click on New. happy-dom does not carry an event from slotted content into the shadow tree it is
 * slotted into, which is where `ml-popover` listens for its trigger: the click is made there.
 */
const openNew = (el: HTMLElement): Promise<void> => click(find(find(el, 'ml-popover')!, '.ml-popover__trigger'));
const menuOpen = (el: HTMLElement): boolean => !!(find(el, 'ml-popover') as (HTMLElement & { component: { isOpen: boolean } }) | null)?.component.isOpen;
const item = (el: HTMLElement, words: RegExp): HTMLButtonElement => all<HTMLButtonElement>(find(el, 'ml-popover')!, 'button').find((b) => words.test(read(b)))!;
const worktreesFold = (el: HTMLElement): HTMLElement | null => button(el, /^Worktrees · \d+$/);

describe('the list', () => {
	test('groups by how things stand: needs you, working, done', async () => {
		const el = await tab(
			[
				session({ id: 'review', title: 'Shuffle button', review: true, updated: Date.now() - 3000 }),
				session({ id: 'running', title: 'Repeat mode', status: 'running', updated: Date.now() - 2000 }),
				session({ id: 'finished', title: 'Rename the queue', isolated: false, cwd: REPO, updated: Date.now() - 1000 }),
				session({ id: 'unseen', title: 'Ended unseen', isolated: false, cwd: REPO, unread: true }),
			],
			[conversation({ id: 'asks', title: 'Asking conversation', state: 'waiting', waitingFor: 'Claude needs your permission to use Bash' }), conversation({ id: 'busy', title: 'Busy conversation', state: 'working' }), conversation({ id: 'ready', title: 'Ready conversation', state: 'idle' })]
		);
		expect(labels(el)).toEqual(['Needs you · 3', 'Working · 2', 'Done · 2']);
		const g = groups(el);
		expect(g['Needs you']).toContain('Shuffle button');
		expect(g['Needs you']).toContain('Ended unseen');
		expect(g['Needs you']).toContain('Asking conversation');
		expect(g['Working']).toContain('Repeat mode');
		expect(g['Working']).toContain('Busy conversation');
		expect(g['Done']).toContain('Rename the queue');
		expect(g['Done']).toContain('Ready conversation');
	});

	test('is the open repository’s alone', async () => {
		const el = await tab([session({ id: 'here', title: 'In harmony', review: true }), session({ id: 'there', title: 'In cadence', repoId: OTHER, cwd: OTHER, isolated: false, review: true })], [conversation({ id: 'c2', repoId: OTHER, title: 'Cadence conversation' })]);
		expect(read(el)).toContain('In harmony');
		expect(read(el)).not.toContain('In cadence');
		expect(read(el)).not.toContain('Cadence conversation');
		expect(labels(el)).toEqual(['Needs you · 1']);
	});

	test('"All repositories" opens the Agents page', async () => {
		const el = await tab([session({ review: true })]);
		expect(repos.overview()).toBe(false);
		await press(button(el, /^All/));
		expect(repos.overview()).toBe(true);
	});

	test('says what each one needs, is doing or did under its name', async () => {
		const el = await tab([
			session({ id: 'q', title: 'Has a question', brief: { title: 'Has a question', did: 'Looked.', needs: 'Which icon should it use?', choices: [] } }),
			session({ id: 'r', title: 'Is running', status: 'running', items: [{ kind: 'user', text: 'Go' }, { kind: 'tool', text: 'Bash', detail: 'npm test', about: 'Run the tests' }] }),
			session({ id: 'd', title: 'Is done', isolated: false, cwd: REPO, brief: { title: 'Is done', did: 'Renamed the queue in 4 files.', needs: null, choices: [] } }),
			session({ id: 'a', title: 'Where is auth handled', kind: 'ask', isolated: false, cwd: REPO, items: [], tools: ['Read', 'Grep', 'Glob'] }),
		]);
		expect(read(row(el, 'Has a question'))).toContain('Which icon should it use?');
		expect(read(row(el, 'Is running'))).toContain('Run the tests');
		expect(read(row(el, 'Is done'))).toContain('Renamed the queue in 4 files.');
		expect(read(row(el, 'Where is auth handled'))).toContain('Question about the code');
	});

	test('an investigation says where it stands in its own words', async () => {
		const el = await tab([
			session({
				kind: 'investigate',
				title: 'Crash on checkout',
				status: 'running',
				investigation: { summary: 'Crash on checkout', description: '', targetId: null, targetName: 'Shop.Api', port: null, step: 2, details: {}, thinking: '', approval: { key: 's1', request: 'r', tool: 'run_target', target: 'Shop.Api', group: null, project: 'Shop.Api', command: 'dotnet run', port: 5210, method: null, path: null, body: null, touches: null }, runs: 0, started: Date.now(), ended: null, report: null, leftover: [], cleanups: 0, checking: false, tab: null },
			}),
		]);
		expect(groups(el)['Needs you']).toContain('Crash on checkout');
		expect(read(row(el, 'Crash on checkout'))).toContain('Waiting for you');
	});

	test('a click on a row opens that session, and it counts as seen', async () => {
		const el = await tab([session({ unread: true, review: true })]);
		await click(row(el, 'Add a shuffle button'));
		expect(agents.selectedId()).toBe('s1');
		expect(agents.get('s1')).toMatchObject({ unread: false, review: true });
	});

	test('the attempts of one task stay together, where the most pressing of them goes', async () => {
		const el = await tab([
			session({ id: 'a1', title: 'Three ways to shuffle', group: 'g1', attempt: 1, status: 'running' }),
			session({ id: 'a2', title: 'Three ways to shuffle', group: 'g1', attempt: 2, review: true, branch: 'agent/a1-2' }),
			session({ id: 'solo', title: 'On its own', status: 'running' }),
		]);
		expect(labels(el)).toEqual(['Needs you · 1', 'Working · 1']);
		const needs = groups(el)['Needs you'];
		expect(needs).toContain('Three ways to shuffle 2 attempts');
		expect(needs).toContain('Attempt 1');
		expect(needs).toContain('Attempt 2');
		expect(groups(el)['Working']).toContain('On its own');
		expect(groups(el)['Working']).not.toContain('Attempt 1');
		await click(row(el, '2 attempts'));
		expect(agents.comparing()).toBe('g1');
	});

	test('a Claude conversation is listed with the agents; a click shows it in the Claude pane', async () => {
		const el = await tab([], [conversation({ branch: 'feature/upload' })]);
		expect(read(row(el, 'Why is the upload test flaky'))).toContain('Claude conversation · feature/upload');
		let opened = '';
		workspace.open = async (id: string) => void (opened = id);
		await click(row(el, 'Why is the upload test flaky'));
		expect(opened).toBe('c1');
	});

	test('a conversation’s row can forget it, without opening it', async () => {
		const el = await tab([], [conversation({ state: 'saved' })]);
		let opened = '';
		workspace.open = async (id: string) => void (opened = id);
		const forget = find(row(el, 'Why is the upload test flaky'), 'button')!;
		expect(forget.title).toBe('Forget this conversation (Claude Code keeps its transcript)');
		await click(forget);
		expect(workspace.conversations()).toEqual([]);
		expect(opened).toBe('');
		expect(read(el)).toContain('Nothing here yet.');
	});

	test('a terminal of the workspace is not listed', async () => {
		const el = await tab([], [conversation({ kind: 'shell', title: 'zsh' })]);
		expect(read(el)).toContain('Nothing here yet.');
	});

	test('with nothing at all it says how to start', async () => {
		const el = await tab();
		expect(read(find(el, '.list')!)).toBe('Nothing here yet. New starts a task for an agent, a question, an investigation or a Claude conversation.');
	});

	test('what arrives after an empty first look is listed', async () => {
		const el = await tab();
		agents.sessions.set([session({ title: 'Arrived later', status: 'running' })]);
		await settle();
		expect(labels(el)).toEqual(['Working · 1']);
		expect(read(el)).not.toContain('Nothing here yet.');
	});
});

describe('sessions started in a terminal', () => {
	test('are listed as done, marked active while their transcript changed lately', async () => {
		w.on('claude_sessions', () => [outside({ id: 'recent', title: 'Flaky upload test', modified: Date.now() - 2 * 60_000 }), outside({ id: 'old', title: null, prompt: 'Explain how the queue retries failed jobs', modified: Date.now() - 26 * 3_600_000 })]);
		const el = await tab([session({ status: 'running' })]);
		expect(labels(el)).toEqual(['Working · 1', 'Done · 2']);
		expect(read(row(el, 'Flaky upload test'))).toContain('active');
		// Without a title of its own it is known by its first prompt.
		expect(read(row(el, 'Explain how the queue retries failed jobs'))).not.toContain('active');
	});

	test('a click brings one into the workspace, ready to resume; nothing runs', async () => {
		const found = outside({ title: 'Flaky upload test' });
		w.on('claude_sessions', () => [found]);
		const el = await tab();
		const adopted: unknown[][] = [];
		workspace.adopt = async (...args: unknown[]) => void adopted.push(args);
		await click(row(el, 'Flaky upload test'));
		expect(adopted).toEqual([[REPO, found]]);
		expect(w.sent('claude_open')).toEqual([]);
	});

	test('one that is already a conversation of ours is not listed twice', async () => {
		w.on('claude_sessions', () => [outside({ id: 'claude-c1', title: 'Same session' })]);
		const el = await tab([], [conversation()]);
		expect(read(el)).not.toContain('Same session');
		expect(labels(el)).toEqual(['Done · 1']);
	});

	test('only the newest eight show until asked for the rest', async () => {
		w.on('claude_sessions', () => Array.from({ length: 11 }, (_, n) => outside({ id: `cli-${n}`, title: `Terminal session ${n + 1}`, modified: Date.now() - (n + 20) * 60_000 })));
		const el = await tab();
		expect(labels(el)).toEqual(['Done · 8']);
		const more = all(el, '.list > *').find((x) => read(x) === 'Show 3 more from the terminal')!;
		await click(more);
		expect(labels(el)).toEqual(['Done · 11']);
		expect(read(el)).toContain('Terminal session 11');
	});
});

describe('the worktrees', () => {
	const spare: Worktree = { path: `${REPO}.worktrees/spare`, branch: 'fix/seek-drift', head: 'd'.repeat(40), isMain: false, active: false, changes: 0, landed: false };

	test('are a folded section, shown only when there is more than the main checkout', async () => {
		const alone = await tab();
		expect(worktreesFold(alone)).toBeNull();
		alone.remove();
		const el = await tab([session({ review: true })], [], [spare]);
		expect(read(worktreesFold(el)!)).toBe('Worktrees · 3');
		expect(read(el)).not.toContain('fix/seek-drift');
		expect(read(el)).not.toContain('main checkout');
	});

	test('unfold to every checkout, with the main one named and what is uncommitted counted', async () => {
		const el = await tab([session({ review: true })], [], [spare]);
		await press(worktreesFold(el));
		const shown = all(el, '.tree').map((t) => read(t));
		expect(shown).toEqual([`${MAIN} · main checkout 4`, 'agent/s1 2', 'fix/seek-drift']);
		await press(worktreesFold(el));
		expect(all(el, '.tree')).toEqual([]);
	});

	test('a click on one points the app at that checkout, staying on the Agents tab', async () => {
		const el = await tab([], [], [spare]);
		await press(worktreesFold(el));
		await click(all(el, '.tree').find((t) => read(t).includes('fix/seek-drift'))!);
		expect(w.sent('worktree_select').map((c) => c.args.path)).toEqual([spare.path]);
		expect(repos.tab()).toBe('agents');
		await click(all(el, '.tree').find((t) => read(t).includes('main checkout'))!);
		expect(w.sent('worktree_select').map((c) => c.args.path)).toEqual([spare.path, null]);
	});

	test('the main checkout cannot be removed; another asks first, then goes with its branch', async () => {
		const el = await tab([], [], [spare]);
		await press(worktreesFold(el));
		const [main, other] = all(el, '.tree');
		expect(find(main, 'button')).toBeNull();
		await click(find(other, 'button'));
		const remove = dialog(el, /^Remove worktree$/);
		expect(isOpen(remove)).toBe(true);
		expect(read(remove)).toContain('Delete the worktree for fix/seek-drift and the branch itself? Uncommitted and unmerged work on it is lost.');
		expect(w.sent('worktree_remove')).toEqual([]);
		// The click on its bin did not also switch to it.
		expect(w.sent('worktree_select')).toEqual([]);
		await press(button(remove, 'Remove'));
		expect(w.sent('worktree_remove').map((c) => c.args)).toEqual([{ id: REPO, path: spare.path, force: true, deleteBranch: true }]);
		expect(isOpen(remove)).toBe(false);
	});
});

describe('removing an agent', () => {
	const removeDialog = (el: HTMLElement): HTMLElement => dialog(el, /^Remove agent$/);
	const ask = async (el: HTMLElement, words: string): Promise<HTMLElement> => {
		await click(find(row(el, words), 'button[title="Remove agent…"]'));
		return removeDialog(el);
	};

	test('asks first, and by default keeps its worktree and branch', async () => {
		const el = await tab([session({ review: true })]);
		const remove = await ask(el, 'Add a shuffle button');
		expect(isOpen(remove)).toBe(true);
		// The x did not open the session.
		expect(agents.selectedId()).toBeNull();
		expect(read(remove)).toContain('Remove Add a shuffle button and its conversation?');
		const box = find(remove, 'ml-checkbox') as HTMLElement & { checked: boolean };
		expect(box.getAttribute('label')).toBe('Also delete its worktree and the branch agent/s1');
		expect(box.checked).toBe(false);
		await press(button(remove, 'Remove'));
		expect(agents.sessions()).toEqual([]);
		expect(w.sent('worktree_remove')).toEqual([]);
	});

	test('with the box ticked its worktree and branch go too', async () => {
		const el = await tab([session({ review: true })]);
		const remove = await ask(el, 'Add a shuffle button');
		const tick = find<HTMLInputElement>(find(remove, 'ml-checkbox')!, 'input')!;
		tick.checked = true;
		tick.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		await press(button(remove, 'Remove'));
		expect(w.sent('worktree_remove').map((c) => c.args)).toEqual([{ id: REPO, path: `${REPO}.worktrees/s1`, force: true, deleteBranch: true }]);
		expect(agents.sessions()).toEqual([]);
	});

	test('Cancel keeps it', async () => {
		const el = await tab([session({ review: true })]);
		const remove = await ask(el, 'Add a shuffle button');
		await press(button(remove, 'Cancel'));
		expect(isOpen(remove)).toBe(false);
		expect(agents.sessions().length).toBe(1);
	});

	test('a task in the main checkout has no worktree to offer', async () => {
		const el = await tab([session({ isolated: false, cwd: REPO, branch: MAIN })]);
		const remove = await ask(el, 'Add a shuffle button');
		expect(find(remove, 'ml-checkbox')).toBeNull();
		await press(button(remove, 'Remove'));
		expect(agents.sessions()).toEqual([]);
	});

	test('a pipeline task that is not done takes its worktree, branch and pushed copy with it unless unticked', async () => {
		const el = await tab([session({ task: 'Add a shuffle button', pipeline: withStep({ ...newPipeline('bug'), waiting: true, note: 'Approve the plan to start coding.', reason: 'approve' }, 'plan', { state: 'you' }) })]);
		const remove = await ask(el, 'Add a shuffle button');
		const box = find(remove, 'ml-checkbox') as HTMLElement & { checked: boolean };
		expect(box.getAttribute('label')).toBe('Also delete its worktree and the branch agent/s1, here and on the remote');
		expect(box.checked).toBe(true);
		await press(button(remove, 'Remove'));
		expect(w.sent('pipeline_clean').map((c) => c.args)).toEqual([{ id: REPO, cwd: `${REPO}.worktrees/s1`, branch: 'agent/s1' }]);
		expect(agents.sessions()).toEqual([]);
	});

	test('an agent whose worktree could not be deleted stays in the list, so it can be tried again', async () => {
		w.on('worktree_remove', () => {
			throw { kind: 'git', message: 'worktree is locked', paths: [] };
		});
		const el = await tab([session({ review: true })]);
		const remove = await ask(el, 'Add a shuffle button');
		const tick = find<HTMLInputElement>(find(remove, 'ml-checkbox')!, 'input')!;
		tick.checked = true;
		tick.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		await press(button(remove, 'Remove'));
		expect(agents.sessions().map((s) => s.id)).toEqual(['s1']);
		expect(w.toasts.some((t) => t.kind === 'error' && t.message.includes('worktree is locked'))).toBe(true);
	});

	// A bug until 2026-11-23. For an open-ended agent, `AgentsStore.remove` keeps the session when its worktree could not
	// be deleted (the test above). For a pipeline task, `confirmRemove` (agents.component.ts) calls
	// `PipelineStore.discard` and then `agents.remove(session, false)` whatever discard did: when the cleanup
	// fails ("Cleaning up failed") the session is forgotten all the same, and its worktree, branch and pushed
	// copy are left with nothing in the app pointing at them.
	// What holds now: the task stays in the list. Before the fix: it is gone.
	test('a pipeline task whose worktree could not be deleted stays in the list too', async () => {
		w.on('pipeline_clean', () => {
			throw { kind: 'git', message: 'worktree is locked', paths: [] };
		});
		const el = await tab([session({ task: 'Add a shuffle button', pipeline: withStep({ ...newPipeline('bug'), waiting: true, note: 'Approve the plan to start coding.', reason: 'approve' }, 'plan', { state: 'you' }) })]);
		const remove = await ask(el, 'Add a shuffle button');
		await press(button(remove, 'Remove'));
		expect(w.toasts.some((t) => t.title === 'Cleaning up failed')).toBe(true);
		expect(agents.sessions().map((s) => s.id)).toEqual(['s1']);
	});

	test('a running agent is stopped before it is removed', async () => {
		const el = await tab([session({ status: 'running' })]);
		const remove = await ask(el, 'Add a shuffle button');
		await press(button(remove, 'Remove'));
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual(['s1']);
		expect(agents.sessions()).toEqual([]);
	});
});

describe('New', () => {
	test('is the one button that starts everything', async () => {
		const el = await tab();
		expect(read(el)).not.toContain('Task for an agent…');
		await openNew(el);
		expect(menuOpen(el)).toBe(true);
		expect(all(find(el, 'ml-popover')!, 'button:not([slot])').map((b) => read(b))).toEqual([
			'Task for an agent… own worktree',
			'Ask about the code… read-only',
			'Ask about its history… read-only',
			'Investigate a bug…',
			'Start from issues…',
			'Claude conversation Claude pane',
		]);
	});

	test('Task for an agent… closes the menu and opens the new-task dialog', async () => {
		const el = await tab();
		await openNew(el);
		await click(item(el, /^Task for an agent/));
		expect(menuOpen(el)).toBe(false);
		expect(isOpen(dialog(el, /^New agent task$/))).toBe(true);
	});

	test('the two kinds of question open the question box with their scope', async () => {
		const el = await tab([session()]);
		agents.select('s1');
		await openNew(el);
		await click(item(el, /^Ask about its history/));
		expect(agents.asking()).toEqual({ scope: 'history', seed: '' });
		expect(agents.selectedId()).toBeNull();
		await click(item(el, /^Ask about the code/));
		expect(agents.asking()).toEqual({ scope: 'code', seed: '' });
	});

	test('Investigate a bug… opens the box to describe one', async () => {
		const el = await tab();
		expect(agents.investigateDraft()).toBeNull();
		await click(item(el, /^Investigate a bug/));
		expect(agents.investigateDraft()).toEqual({ output: '' });
	});

	test('Start from issues… opens the host’s issues, and Claude conversation starts one in the Claude pane', async () => {
		const el = await tab();
		const host = w.get((await import('../../services/host.store')).HostStore);
		const started: string[] = [];
		host.openIssues = () => void started.push('issues');
		workspace.newClaude = async () => void started.push('conversation');
		await click(item(el, /^Start from issues/));
		await click(item(el, /^Claude conversation/));
		expect(started).toEqual(['issues', 'conversation']);
	});

	test('without Claude Code only the host’s issues can still be opened', async () => {
		const el = await tab();
		agents.cli.set(null);
		await settle();
		expect([/^Task for an agent/, /^Ask about the code/, /^Ask about its history/, /^Investigate a bug/, /^Claude conversation/].map((x) => item(el, x).disabled)).toEqual([true, true, true, true, true]);
		expect(item(el, /^Start from issues/).disabled).toBe(false);
	});
});

describe('the new-task dialog', () => {
	const open = async (): Promise<{ el: HTMLElement; box: HTMLElement }> => {
		const el = await tab();
		await click(item(el, /^Task for an agent/));
		return { el, box: dialog(el, /^New agent task$/) };
	};
	const kind = (box: HTMLElement, name: string): HTMLElement => all(box, '[aria-label="Kind of work"] button').find((b) => read(b) === name)!;
	const branch = (box: HTMLElement): string => (all<HTMLElement & { value: string }>(box, 'ml-input').find((i) => i.getAttribute('label') === 'Branch')?.value ?? '');
	const branchField = (box: HTMLElement): HTMLElement => all(box, 'ml-input').find((i) => i.getAttribute('label') === 'Branch')!;
	const start = (box: HTMLElement): HTMLElement => all(box, 'ml-button').filter((b) => /^Start/.test(read(b)))[0];

	test('starts as a Feature, whose plan you approve, and cannot start without a task', async () => {
		const { box } = await open();
		expect(all(box, '[aria-label="Kind of work"] button').map((b) => `${read(b)}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`)).toEqual(['Quick fix', 'Bug', 'Feature*', 'Chore', 'Open-ended']);
		expect(read(box)).toContain('you are asked to approve the plan and ship.');
		expect(read(start(box))).toBe('Start planning');
		expect(disabled(start(box))).toBe(true);
	});

	test('the branch is named after what the task says, as it is typed', async () => {
		const { box } = await open();
		await type(find(box, 'ml-textarea'), 'Can you fix the seek bug?');
		expect(branch(box)).toBe('agent/fix-seek-bug');
		expect(disabled(start(box))).toBe(false);
		await type(find(box, 'ml-textarea'), '');
		expect(branch(box)).toBe('');
		expect(disabled(start(box))).toBe(true);
	});

	test('a branch typed by hand is kept when the task changes, with spaces made hyphens', async () => {
		const { box } = await open();
		await type(find(box, 'ml-textarea'), 'Fix the seek bug');
		await type(branchField(box), 'fix/seek drift');
		expect(branch(box)).toBe('fix/seek-drift');
		await type(find(box, 'ml-textarea'), 'Fix the seek bug in the player and the queue');
		expect(branch(box)).toBe('fix/seek-drift');
	});

	test('a Feature starts in a worktree on that branch with its plan, read-only; the dialog closes', async () => {
		const { el, box } = await open();
		await type(find(box, 'ml-textarea'), 'Fix the seek bug');
		await press(start(box));
		expect(w.sent('worktree_add').map((c) => c.args.branch)).toEqual(['agent/fix-seek-bug']);
		const sent = w.sent('agent_start');
		expect(sent.length).toBe(1);
		expect(String(sent[0].args.prompt)).toContain('[pipeline-plan]');
		expect(sent[0].args.mode).toBe('default');
		expect(isOpen(box)).toBe(false);
		const made = agents.sessions()[0];
		expect(made).toMatchObject({ kind: 'task', isolated: true, branch: 'agent/fix-seek-bug', pipeline: { kind: 'feature', step: 'plan' } });
		expect(groups(el)['Working']).toContain('Fix the seek bug');
	});

	test('a Quick fix has no plan: it says so, and Start begins the coding', async () => {
		const { box } = await open();
		await press(kind(box, 'Quick fix'));
		expect(read(box)).toContain('No plan, no review: code and test until green, then you ship.');
		expect(read(box)).toContain('you are asked to ship.');
		expect(read(start(box))).toBe('Start');
		await type(find(box, 'ml-textarea'), 'Fix the typo in the README');
		await press(start(box));
		const sent = w.sent('agent_start');
		expect(String(sent[0].args.prompt)).not.toContain('[pipeline-plan]');
		expect(sent[0].args.mode).toBe('acceptEdits');
		expect(agents.sessions()[0].pipeline).toMatchObject({ kind: 'quick', step: 'code', steps: { plan: { state: 'skip' }, review: { state: 'skip' } } });
	});

	test('Open-ended is an agent session with no steps: its own worktree by default, attempts and permissions to choose', async () => {
		const { box } = await open();
		await press(kind(box, 'Open-ended'));
		expect(read(box)).toContain('No steps: a conversation with an agent. You review, commit and merge its work yourself.');
		expect(read(start(box))).toBe('Start agent');
		await type(find(box, 'ml-textarea'), 'Fix the seek bug');
		await press(start(box));
		expect(w.sent('worktree_add').map((c) => c.args.branch)).toEqual(['agent/fix-seek-bug']);
		expect(w.sent('agent_start')[0].args).toMatchObject({ prompt: 'Fix the seek bug', mode: 'acceptEdits', options: { brief: true } });
		expect(agents.sessions()[0].pipeline ?? null).toBeNull();
	});

	test('several attempts run the same task at once, each on its own branch', async () => {
		const { box } = await open();
		await press(kind(box, 'Open-ended'));
		await type(find(box, 'ml-textarea'), 'Fix the seek bug');
		await press(all(box, 'button').find((b) => read(b) === '3')!);
		expect(read(box)).toContain('The same task runs 3 times at once, on agent/fix-seek-bug, agent/fix-seek-bug-2, agent/fix-seek-bug-3.');
		expect(read(start(box))).toBe('Start 3 agents');
		await press(start(box));
		expect(w.sent('worktree_add').map((c) => c.args.branch)).toEqual(['agent/fix-seek-bug', 'agent/fix-seek-bug-2', 'agent/fix-seek-bug-3']);
		expect(w.sent('agent_start').length).toBe(3);
		const made = agents.sessions();
		expect(new Set(made.map((s) => s.group)).size).toBe(1);
		expect(made.map((s) => s.attempt)).toEqual([1, 2, 3]);
		// Started as a group, they open as a comparison.
		expect(agents.comparing()).toBe(made[0].group);
	});

	test('without a worktree it warns that the agent edits the checkout on screen, and makes none', async () => {
		const { box } = await open();
		await press(kind(box, 'Open-ended'));
		const tick = find<HTMLInputElement>(find(box, 'ml-checkbox')!, 'input')!;
		tick.checked = false;
		tick.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(read(box)).toContain('The agent will edit the checkout you are looking at, alongside your own uncommitted changes.');
		await type(find(box, 'ml-textarea'), 'Fix the seek bug');
		await press(start(box));
		expect(w.sent('worktree_add')).toEqual([]);
		expect(w.sent('agent_start')[0].args.cwd).toBe(REPO);
		expect(agents.sessions()[0]).toMatchObject({ isolated: false, cwd: REPO });
	});

	test('Full auto says what it lets the agent do, and is the mode the task starts in', async () => {
		const { box } = await open();
		await press(kind(box, 'Open-ended'));
		expect(read(box)).not.toContain('Full auto lets the agent run any shell command');
		find(box, 'ml-select')!.dispatchEvent(new CustomEvent('ml:change', { detail: { value: 'bypassPermissions' } }));
		await settle();
		expect(read(box)).toContain('Full auto lets the agent run any shell command on this computer, not just inside its worktree.');
		await type(find(box, 'ml-textarea'), 'Fix the seek bug');
		await press(start(box));
		expect(w.sent('agent_start')[0].args.mode).toBe('bypassPermissions');
	});

	test('a start that fails keeps the dialog and what was typed', async () => {
		w.on('worktree_add', () => {
			throw { kind: 'git', message: "a branch named 'agent/fix-seek-bug' already exists", paths: [] };
		});
		const { box } = await open();
		await type(find(box, 'ml-textarea'), 'Fix the seek bug');
		await press(start(box));
		expect(isOpen(box)).toBe(true);
		expect((find(box, 'ml-textarea') as HTMLElement & { value: string }).value).toBe('Fix the seek bug');
		expect(agents.sessions()).toEqual([]);
		expect(w.toasts.some((t) => t.kind === 'error' && t.message.includes('already exists'))).toBe(true);
	});

	test('opened again it is empty', async () => {
		const { el, box } = await open();
		await type(find(box, 'ml-textarea'), 'Fix the seek bug');
		await press(button(box, 'Cancel'));
		expect(isOpen(box)).toBe(false);
		await click(item(el, /^Task for an agent/));
		expect((find(box, 'ml-textarea') as HTMLElement & { value: string }).value).toBe('');
		expect(branch(box)).toBe('');
	});
});

describe('Claude names the branch', () => {
	/** With the clock in hand: the helpers that wait on real timers are not used here. */
	const tick = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);
	const typeNow = (field: Element, value: string): void => {
		const box = find<HTMLTextAreaElement>(field, 'input, textarea')!;
		box.value = value;
		box.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
	};
	const LONG = 'Make the queue wrap around to the first track when repeat mode is switched on in the player';
	const open = async (): Promise<HTMLElement> => {
		const el = await tab();
		await click(item(el, /^Task for an agent/));
		vi.useFakeTimers();
		return dialog(el, /^New agent task$/);
	};
	const branch = (box: HTMLElement): string => (all<HTMLElement & { value: string }>(box, 'ml-input').find((i) => i.getAttribute('label') === 'Branch')?.value ?? '');
	const hint = (box: HTMLElement): string => all(box, 'ml-input').find((i) => i.getAttribute('label') === 'Branch')?.getAttribute('hint') ?? '';

	test('once the typing pauses, for a task whose words do not fit in a name', async () => {
		// The demo's own answer to a one-shot question, which arrives after half a second.
		w.off('agent_start');
		const box = await open();
		typeNow(find(box, 'ml-textarea')!, LONG);
		await tick(50);
		// At once: the task's own telling words.
		expect(branch(box)).toBe('agent/queue-wrap-around-first');
		expect(w.sent('agent_start')).toEqual([]);
		await tick(800);
		expect(hint(box)).toContain('Claude is naming it…');
		const asked = w.sent('agent_start');
		expect(asked.length).toBe(1);
		// The task goes as data in a one-shot question with no tools.
		expect(String(asked[0].args.prompt)).toContain(LONG);
		expect(asked[0].args.options).toMatchObject({ quick: true, tools: [] });
		await tick(1000);
		expect(branch(box)).toBe('agent/repeat-wraps-queue');
		expect(hint(box)).not.toContain('Claude is naming it…');
	});

	test('not for a task that is its own name', async () => {
		const box = await open();
		typeNow(find(box, 'ml-textarea')!, 'Fix the seek bug');
		await tick(2000);
		expect(w.sent('agent_start')).toEqual([]);
		expect(branch(box)).toBe('agent/fix-seek-bug');
	});

	test('never over a branch typed by hand', async () => {
		w.off('agent_start');
		const box = await open();
		typeNow(find(box, 'ml-textarea')!, LONG);
		await tick(50);
		typeNow(all(box, 'ml-input').find((i) => i.getAttribute('label') === 'Branch')!, 'my/own-name');
		await tick(3000);
		expect(branch(box)).toBe('my/own-name');
		expect(w.sent('agent_start')).toEqual([]);
	});

	test('an answer for an older wording is dropped', async () => {
		w.off('agent_start');
		const box = await open();
		typeNow(find(box, 'ml-textarea')!, LONG);
		await tick(850);
		expect(w.sent('agent_start').length).toBe(1);
		// The wording changes while Claude is still answering the first one.
		typeNow(find(box, 'ml-textarea')!, 'Fix the seek bug');
		await tick(3000);
		expect(branch(box)).toBe('agent/fix-seek-bug');
	});

	test('an answer that holds no usable name leaves the task’s own words', async () => {
		w.on('agent_start', (args) => {
			queueMicrotask(() => {
				w.emit('agent-event', { key: args.key, event: { type: 'result', subtype: 'success', is_error: false, result: '!!! ???', total_cost_usd: 0 } });
				w.emit('agent-done', { key: args.key, ok: true, error: '' });
			});
		});
		const box = await open();
		typeNow(find(box, 'ml-textarea')!, LONG);
		await tick(1000);
		expect(w.sent('agent_start').length).toBe(1);
		expect(branch(box)).toBe('agent/queue-wrap-around-first');
		expect(hint(box)).not.toContain('Claude is naming it…');
	});

	test('Start does not wait for the name: what the field shows is what starts', async () => {
		w.on('agent_start', () => undefined);
		const box = await open();
		typeNow(find(box, 'ml-textarea')!, LONG);
		await tick(850);
		expect(hint(box)).toContain('Claude is naming it…');
		find(all(box, 'ml-button').find((b) => /^Start/.test(read(b)))!, 'button')!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
		await tick(200);
		expect(w.sent('worktree_add').map((c) => c.args.branch)).toEqual(['agent/queue-wrap-around-first']);
	});
});
