import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { AgentSession, AgentsStore } from '../../services/agents.store';
import type { RepoStore } from '../../services/repo.store';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';

let w: World;
let repos: RepoStore;
let agents: AgentsStore;

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
	repos.setTab('agents');
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	await agents.init();
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

/** Tags that mark words inside a sentence: nothing is read between them and the words around them. */
const INLINE = new Set(['B', 'I', 'EM', 'STRONG', 'CODE', 'U']);

/**
 * What a person reads under `root`, through shadow roots: text that stands together stays together,
 * the icons' glyphs are left out, and so is a dialog that is not open.
 */
function read(root: Element | ShadowRoot): string {
	const parts: string[] = [];
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			parts.push(node.textContent ?? '');
		} else if (node instanceof Element) {
			const closed = node.tagName === 'ML-DIALOG' && !node.shadowRoot?.querySelector('dialog')?.open;
			if (node.tagName !== 'STYLE' && node.tagName !== 'SCRIPT' && !closed) {
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

/** The new-question box, as the Agents tab's main pane shows it. */
async function box(scope: 'code' | 'history' = 'code', seed = ''): Promise<HTMLElement> {
	agents.openAsk(scope, seed);
	return mount('ms-ask');
}

const field = (el: HTMLElement): HTMLElement & { value: string } => find(el, 'ml-textarea')!;
const scopes = (el: HTMLElement): HTMLElement[] => all(el, 'button').filter((b) => /^The code/.test(read(b)));

describe('a new question', () => {
	test('says it is a read-only chat about the branch on screen, and that nothing is changed', async () => {
		const el = await box();
		const shown = read(el);
		expect(shown).toContain('Ask about harmony');
		expect(shown).toContain('A read-only chat about feature/repeat-mode. Nothing is changed and no worktree is made.');
		expect(shown).toContain('Claude searches and reads the files in this checkout.');
	});

	test('cannot be asked until something is written', async () => {
		const el = await box();
		expect(disabled(button(el, 'Ask'))).toBe(true);
		await type(field(el), '   ');
		expect(disabled(button(el, 'Ask'))).toBe(true);
		await type(field(el), 'Where is the queue?');
		expect(disabled(button(el, 'Ask'))).toBe(false);
	});

	test('Ask starts a read-only session in the checkout on screen: its rules first, then the question, with Read, Grep and Glob alone', async () => {
		const el = await box();
		await type(field(el), 'Where is the queue?');
		await press(button(el, 'Ask'));
		const sent = w.sent('agent_start');
		expect(sent.length).toBe(1);
		const args = sent[0].args;
		expect(String(args.prompt).startsWith('[ask-repository]')).toBe(true);
		expect(String(args.prompt)).toContain('Question: Where is the queue?');
		expect(args).toMatchObject({ id: REPO, cwd: REPO, mode: 'default', resume: null });
		expect(args.options).toMatchObject({ tools: ['Read', 'Grep', 'Glob'], builtin: ['Read', 'Grep', 'Glob'], lean: true });
		expect(w.sent('worktree_add')).toEqual([]);
		// The pane moves on to the session, which shows the question as it was typed.
		const made = agents.selected()!;
		expect(made).toMatchObject({ kind: 'ask', isolated: false, status: 'running', title: 'Where is the queue?' });
		expect(made.items).toEqual([{ kind: 'user', text: 'Where is the queue?' }]);
		expect(agents.asking()).toBeNull();
	});

	test('about the history it may also read git log, show, diff and blame, and nothing else of Bash', async () => {
		const el = await box('history');
		expect(read(el)).toContain('Claude also reads the git history (log, show, diff, blame) to find when and why things changed.');
		await type(field(el), 'When did repeat change?');
		await press(button(el, 'Ask'));
		const args = w.sent('agent_start')[0].args;
		expect(String(args.prompt).startsWith('[ask-history]')).toBe(true);
		expect(args.options).toMatchObject({ tools: ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git blame:*)'], builtin: ['Read', 'Grep', 'Glob', 'Bash'] });
		expect(args.mode).toBe('default');
	});

	test('the two scopes switch what it may read, and with it the examples', async () => {
		const el = await box();
		expect(field(el).getAttribute('placeholder')).toBe('Where is authentication handled?');
		expect(read(el)).toContain('Where are errors shown to the user?');
		await press(scopes(el).find((b) => read(b) === 'The code and its history')!);
		expect(agents.asking()).toEqual({ scope: 'history', seed: '' });
		expect(field(el).getAttribute('placeholder')).toBe('When did this behaviour change, and why?');
		expect(read(el)).toContain('What changed in the last two weeks, and why?');
		expect(read(el)).not.toContain('Where are errors shown to the user?');
	});

	test('an example fills the box, ready to ask or to change', async () => {
		const el = await box();
		await press(button(el, 'Where are errors shown to the user?'));
		expect(field(el).value).toBe('Where are errors shown to the user?');
		expect(disabled(button(el, 'Ask'))).toBe(false);
		expect(w.sent('agent_start')).toEqual([]);
	});

	test('Cmd/Ctrl+Enter asks', async () => {
		const el = await box();
		await type(field(el), 'Where is the queue?');
		field(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, composed: true, cancelable: true }));
		await settle();
		expect(w.sent('agent_start').length).toBe(1);
	});

	test('Cancel puts the box away and asks nothing', async () => {
		const el = await box();
		await type(field(el), 'Never mind');
		await press(button(el, 'Cancel'));
		expect(agents.asking()).toBeNull();
		expect(w.sent('agent_start')).toEqual([]);
	});

	// A bug until 2026-11-23. Cancel is `agents.select(agents.selectedId())` (ask.component.ts), which reads as "back to
	// the session that was open", and the sidebar and the session pane both allow for a session staying selected
	// while a question is written (`!agents.asking()`). But `AgentsStore.openAsk` clears `selectedId` before it
	// shows the box (agents.store.ts), so Cancel always selects null and lands on the desk instead.
	// What holds now: 's1' is selected again. Before the fix: nothing is.
	test('Cancel goes back to the session that was open before', async () => {
		agents.sessions.set([session()]);
		agents.select('s1');
		const el = await box();
		await press(button(el, 'Cancel'));
		expect(agents.selectedId()).toBe('s1');
	});

	test('opens with a question already written, and takes a new one while it is on screen', async () => {
		const el = await box('code', 'What does the queue do at the end?');
		expect(field(el).value).toBe('What does the queue do at the end?');
		agents.openAsk('code', 'And how does shuffle draw?');
		await settle();
		expect(field(el).value).toBe('And how does shuffle draw?');
	});

	test('without Claude Code it says what to install and cannot ask', async () => {
		const el = await box();
		agents.cli.set(null);
		await settle();
		await type(field(el), 'Where is the queue?');
		expect(read(el)).toContain('The claude command was not found. Install Claude Code, then restart Melodic Studio.');
		expect(disabled(button(el, 'Ask'))).toBe(true);
	});
});

describe('the way in from another tab', () => {
	test('as an icon it opens a question about the code, on the Agents tab', async () => {
		repos.setTab('files');
		const el = await mount('ms-ask-button');
		await click(find(el, 'button'));
		expect(agents.asking()).toEqual({ scope: 'code', seed: '' });
		expect(repos.tab()).toBe('agents');
	});

	test('as a bar above the History list it asks about the history, and stays on the History tab', async () => {
		repos.setTab('history');
		const el = await mount('ms-ask-button', { scope: 'history', look: 'bar' });
		expect(read(el)).toBe('Ask about this history…');
		await press(button(el, 'Ask about this history…'));
		expect(agents.asking()).toEqual({ scope: 'history', seed: '' });
		expect(repos.tab()).toBe('history');
		expect(agents.historyChat()).toEqual({ id: null, open: true });
	});

	test('a history conversation put aside for a commit can be brought back', async () => {
		repos.setTab('history');
		agents.sessions.set([session({ id: 'h1', kind: 'ask', isolated: false, cwd: REPO, tools: ['Read', 'Bash(git log:*)'] })]);
		agents.historyChat.set({ id: 'h1', open: true });
		const el = await mount('ms-ask-button', { scope: 'history', look: 'bar' });
		expect(button(el, 'Back to conversation')).toBeNull();
		agents.hideHistoryChat();
		await settle();
		await press(button(el, 'Back to conversation'));
		expect(agents.historyChat()).toEqual({ id: 'h1', open: true });
		expect(agents.selectedId()).toBe('h1');
		expect(button(el, 'Back to conversation')).toBeNull();
	});
});
