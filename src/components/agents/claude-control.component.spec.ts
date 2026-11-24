import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import { newPipeline, withStep } from '../../shared/pipeline';
import type { AgentSession, AgentsStore } from '../../services/agents.store';
import type { RepoStore } from '../../services/repo.store';
import type { Conversation, WorkspaceStore } from '../../services/workspace.store';
import type { Worktree } from '../../services/backend.service';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';
const OTHER = '/Users/demo/Source/cadence';

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

beforeEach(async () => {
	forgetElements();
	popovers();
	w = await world();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	await repos.init();
	repos.setTab('changes');
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	workspace = w.get((await import('../../services/workspace.store')).WorkspaceStore);
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

/** The toolbar's control with these sessions in the app, each with the worktree it works in. */
async function control(sessions: AgentSession[], conversations: Conversation[] = []): Promise<HTMLElement> {
	const trees: Worktree[] = [
		{ path: REPO, branch: 'main', head: 'a'.repeat(40), isMain: true, active: true, changes: 0, landed: false },
		...sessions.filter((s) => s.isolated && s.repoId === REPO).map((s) => ({ path: s.cwd, branch: s.branch, head: 'c'.repeat(40), isMain: false, active: false, changes: 2, landed: false })),
	];
	w.on('worktree_list', () => trees);
	// The sessions are read from their files first: what is set before that is replaced.
	await agents.restored;
	agents.sessions.set(sessions);
	workspace.conversations.set(conversations);
	return mount('ms-claude-control');
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

/** The half with the count: its accessible name says what the number means. */
const count = (el: HTMLElement): HTMLElement => find(el, 'button[slot=trigger]')!;
/** The half with the sparkle. */
const sparkle = (el: HTMLElement): HTMLElement => all(el, 'button').find((b) => /the Claude pane$/.test(b.getAttribute('aria-label') ?? ''))!;
/**
 * A click on the count. happy-dom does not carry an event from slotted content into the shadow tree it
 * is slotted into, which is where `ml-popover` listens for its trigger: the click is made there.
 */
const openList = (el: HTMLElement): Promise<void> => click(find(find(el, 'ml-popover')!, '.ml-popover__trigger'));
const listOpen = (el: HTMLElement): boolean => !!(find(el, 'ml-popover') as (HTMLElement & { component: { isOpen: boolean } }) | null)?.component.isOpen;
/** The rows of the open list: each goes to its agent or conversation. */
const rows = (el: HTMLElement): HTMLElement[] => all(el, '[title="Go to this agent"], [title="Go to this conversation"]');
const row = (el: HTMLElement, name: string): HTMLElement => rows(el).find((r) => read(r).includes(name))!;
const everything = (el: HTMLElement): HTMLButtonElement => all<HTMLButtonElement>(el, 'button').find((b) => read(b).startsWith('Everything, in every repository'))!;

describe('the count', () => {
	test('is how many agents and conversations wait on you, in every repository', async () => {
		const el = await control(
			[
				session({ id: 'review', review: true }),
				session({ id: 'unseen', repoId: OTHER, cwd: OTHER, isolated: false, unread: true }),
				session({ id: 'question', brief: { title: 'Q', did: 'Looked.', needs: 'Which one?', choices: [] } }),
				session({ id: 'running', status: 'running' }),
				session({ id: 'finished' }),
			],
			[conversation({ id: 'asks', state: 'waiting', waitingFor: 'Claude needs your permission' }), conversation({ id: 'ready', state: 'idle' })]
		);
		expect(read(count(el))).toBe('4');
		expect(count(el).getAttribute('aria-label')).toBe('Agents and Claude conversations: 4 waiting for you');
	});

	test('shows no number while something only works, and says how many do', async () => {
		const el = await control([session({ id: 'a', status: 'running' })], [conversation({ state: 'working' })]);
		expect(read(count(el))).toBe('');
		expect(count(el).getAttribute('aria-label')).toBe('Agents and Claude conversations: 2 working');
	});

	test('shows nothing when nothing waits and nothing works', async () => {
		const el = await control([session({ id: 'finished' })], [conversation({ state: 'idle' })]);
		expect(read(count(el))).toBe('');
		expect(count(el).getAttribute('aria-label')).toBe('Agents and Claude conversations: nothing is waiting for you');
	});

	test('leaves out what belongs to a repository no longer in the app', async () => {
		const el = await control([session({ id: 'gone', repoId: '/Users/demo/Source/removed', review: true })]);
		expect(read(count(el))).toBe('');
	});

	test('a pipeline waiting for its plan to be approved counts; one running its tests does not', async () => {
		const el = await control([
			session({ id: 'plan', pipeline: withStep({ ...newPipeline('bug'), waiting: true, note: 'Approve the plan to start coding.', reason: 'approve' }, 'plan', { state: 'you' }) }),
			session({ id: 'tests', pipeline: withStep({ ...newPipeline('bug'), step: 'test' }, 'test', { state: 'run' }) }),
		]);
		expect(read(count(el))).toBe('1');
	});

	test('goes up when a turn ends that nobody was looking at, because the control listens from the start', async () => {
		const el = await control([session({ status: 'running' })]);
		expect(read(count(el))).toBe('');
		w.emit('agent-done', { key: 's1', ok: true, error: '' });
		await settle();
		expect(read(count(el))).toBe('1');
		expect(agents.get('s1')).toMatchObject({ status: 'idle', unread: true, review: true });
		expect(w.toasts.map((t) => t.title)).toContain('Agent finished');
	});

	test('follows a session that is looked at: seen and settled, it no longer counts', async () => {
		const el = await control([session({ unread: true, isolated: false, cwd: REPO })]);
		expect(read(count(el))).toBe('1');
		agents.seen('s1');
		await settle();
		expect(read(count(el))).toBe('');
	});
});

describe('the list the count opens', () => {
	test('is built only while it is open', async () => {
		const el = await control([session({ review: true })]);
		expect(rows(el)).toEqual([]);
		await openList(el);
		expect(listOpen(el)).toBe(true);
		expect(rows(el).length).toBe(1);
	});

	test('has what needs you and what is working, and nothing that is done', async () => {
		const el = await control(
			[session({ id: 'review', title: 'Shuffle button', review: true }), session({ id: 'running', title: 'Repeat mode', status: 'running' }), session({ id: 'finished', title: 'Rename the queue' })],
			[conversation({ id: 'asks', title: 'Asking conversation', state: 'waiting', waitingFor: 'Claude needs your permission to use Bash' })]
		);
		await openList(el);
		const shown = read(find(el, 'ml-popover')!);
		expect(shown).toContain('Needs you · 2');
		expect(shown).toContain('Working · 1');
		expect(shown).toContain('Shuffle button');
		expect(shown).toContain('Asking conversation');
		expect(shown).toContain('Repeat mode');
		expect(shown).not.toContain('Rename the queue');
		expect(shown.indexOf('Shuffle button')).toBeLessThan(shown.indexOf('Working · 1'));
		expect(shown.indexOf('Repeat mode')).toBeGreaterThan(shown.indexOf('Working · 1'));
	});

	test('a row says how it stands, where it is and what it needs', async () => {
		const el = await control(
			[
				session({ id: 'task', title: 'Shuffle button', review: true, cost: 1.5, brief: { title: 'Shuffle', did: 'Added the button.', needs: null, choices: [] }, name: 'Shuffle' }),
				session({ id: 'ask', kind: 'ask', title: 'When did repeat change', isolated: false, cwd: REPO, repoId: OTHER, unread: true, tools: ['Read', 'Bash(git log:*)'] }),
			],
			[conversation({ state: 'waiting', waitingFor: 'Claude is waiting for your input', branch: 'feature/upload', subagents: [{ id: 't1', description: 'Search', type: null, running: true, started: 1, ended: null }] })]
		);
		await openList(el);
		const task = read(row(el, 'Shuffle'));
		expect(task).toContain('Needs review');
		expect(task).toContain('harmony');
		expect(task).toContain('agent/task');
		expect(task).toContain('$1.50');
		expect(task).toContain('Review its changes, then merge');
		const question = read(row(el, 'When did repeat change'));
		// It is finished; what it waits for is being read.
		expect(question).toContain('Finished');
		expect(question).toContain('cadence');
		expect(question).toContain('Question about history');
		expect(question).toContain('Read the answer');
		const conv = read(row(el, 'Why is the upload test flaky'));
		expect(conv).toContain('Needs you');
		expect(conv).toContain('Claude conversation · feature/upload');
		expect(conv).toContain('1 subagent running');
		expect(conv).toContain('Claude is waiting for your input');
	});

	test('what Claude wrote is shown as text', async () => {
		const el = await control([session({ review: true, name: '<img src=x onerror=alert(1)>', brief: { title: 'x', did: 'd', needs: '<script>alert(2)</script>', choices: [] } })]);
		await openList(el);
		expect(all(el, 'img, script').length).toBe(0);
		expect(read(rows(el)[0])).toContain('<img src=x onerror=alert(1)>');
		expect(read(rows(el)[0])).toContain('<script>alert(2)</script>');
	});

	test('says so when it is empty', async () => {
		const el = await control([session({ id: 'finished' })]);
		await openList(el);
		expect(read(find(el, 'ml-popover')!)).toContain('Nothing is waiting for you, and nothing is running.');
	});

	test('a session’s row goes to it: its repository opens on the Agents tab with it selected, and the list closes', async () => {
		const el = await control([session({ id: 'there', title: 'In cadence', repoId: OTHER, cwd: OTHER, isolated: false, unread: true })]);
		await openList(el);
		await click(row(el, 'In cadence'));
		expect(repos.repo()!.id).toBe(OTHER);
		expect(repos.tab()).toBe('agents');
		expect(agents.selectedId()).toBe('there');
		expect(listOpen(el)).toBe(false);
		// Looked at now: it no longer waits.
		expect(read(count(el))).toBe('');
	});

	test('a conversation’s row shows it in the Claude pane', async () => {
		const el = await control([], [conversation({ state: 'waiting', waitingFor: 'Claude needs your permission' })]);
		let opened = '';
		workspace.open = async (id: string) => void (opened = id);
		await openList(el);
		await click(row(el, 'Why is the upload test flaky'));
		expect(opened).toBe('c1');
		expect(listOpen(el)).toBe(false);
	});

	test('its last row is the Agents page, every repository', async () => {
		const el = await control([session({ review: true })]);
		await openList(el);
		expect(read(everything(el))).toBe('Everything, in every repository Agents page');
		await click(everything(el));
		expect(repos.overview()).toBe(true);
		expect(listOpen(el)).toBe(false);
	});

	test('the Agents page cannot be opened while no repository is', async () => {
		const el = await control([]);
		repos.app.set({ ...repos.app()!, current: null });
		await settle();
		expect(everything(el).disabled).toBe(true);
	});
});

describe('the sparkle', () => {
	test('hides the Claude pane when it is shown and shows it when it is hidden', async () => {
		const el = await control([]);
		expect(workspace.shown()).toBe('side');
		expect(sparkle(el).getAttribute('aria-pressed')).toBe('true');
		expect(sparkle(el).getAttribute('aria-label')).toBe('Hide the Claude pane');
		await click(sparkle(el));
		expect(workspace.shown()).toBe('hidden');
		expect(sparkle(el).getAttribute('aria-pressed')).toBe('false');
		expect(sparkle(el).getAttribute('aria-label')).toBe('Show the Claude pane');
		await click(sparkle(el));
		expect(workspace.shown()).toBe('side');
	});

	test('shows the Claude pane alone when the window has no room for both', async () => {
		const el = await control([]);
		// 900 px to share: under the main pane's 840 and the Claude pane's 320.
		workspace.setRoom(900, 900);
		await settle();
		// The view the user chose stays "side", but there is no room: nothing of the pane is on screen.
		expect(workspace.view()).toBe('side');
		expect(sparkle(el).getAttribute('aria-pressed')).toBe('false');
		await click(sparkle(el));
		expect(workspace.shown()).toBe('full');
	});

	test('Cmd/Ctrl+Shift+K does the same, before a focused terminal can take the key', async () => {
		await control([]);
		const key = (init: KeyboardEventInit): KeyboardEvent => {
			const e = new KeyboardEvent('keydown', { code: 'KeyK', key: 'K', bubbles: true, cancelable: true, ...init });
			window.dispatchEvent(e);
			return e;
		};
		expect(key({ ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
		expect(workspace.shown()).toBe('hidden');
		key({ metaKey: true, shiftKey: true });
		expect(workspace.shown()).toBe('side');
		// Without Shift, or with Alt, it is some other shortcut.
		expect(key({ ctrlKey: true }).defaultPrevented).toBe(false);
		key({ ctrlKey: true, shiftKey: true, altKey: true });
		expect(workspace.shown()).toBe('side');
	});

	test('the shortcut is gone with the control', async () => {
		const el = await control([]);
		el.remove();
		await settle();
		window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', ctrlKey: true, shiftKey: true, bubbles: true }));
		expect(workspace.shown()).toBe('side');
	});
});

test('mounting it starts the pipelines following turns, whichever tab is open', async () => {
	expect(agents.turnEnded.has('pipeline')).toBe(false);
	await control([]);
	expect(agents.turnEnded.has('pipeline')).toBe(true);
	expect(agents.landed.has('pipeline')).toBe(true);
	expect(repos.tab()).toBe('changes');
});
