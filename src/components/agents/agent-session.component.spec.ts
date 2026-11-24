import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import { newPipeline, withStep } from '../../shared/pipeline';
import type { AgentItem, AgentRef, AgentSession, AgentsStore, WorkCheck } from '../../services/agents.store';
import type { RepoStore } from '../../services/repo.store';
import type { Conversation, WorkspaceStore } from '../../services/workspace.store';
import type { Worktree } from '../../services/backend.service';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';
const TREE = `${REPO}.worktrees/s1`;
/** The branch the demo repository's main checkout is on. */
const MAIN = 'feature/repeat-mode';

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
let workspace: WorkspaceStore;
/** What `worktree_list` answers: the main checkout and the agent's worktree. */
let trees: Worktree[];

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

/**
 * happy-dom's HTML parser drops the `#` of `<ml-dialog #agent-merge>`, and that name is what a dialog is
 * opened by (`DialogService.open('agent-merge')`): it is put back where `ml-dialog` looks for it.
 */
const attributeNames = Element.prototype.getAttributeNames;
Element.prototype.getAttributeNames = function (this: Element): string[] {
	const names = attributeNames.call(this);
	return this.tagName === 'ML-DIALOG' ? names.map((n) => (n !== 'style' && !n.startsWith('#') && this.getAttribute(n) === '' ? `#${n}` : n)) : names;
};

beforeEach(async () => {
	forgetElements();
	w = await world();
	await import('../../components');
	repos = w.get((await import('../../services/repo.store')).RepoStore);
	await repos.init();
	repos.setTab('agents');
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	await agents.init();
	workspace = w.get((await import('../../services/workspace.store')).WorkspaceStore);
	trees = [
		{ path: REPO, branch: MAIN, head: 'a'.repeat(40), isMain: true, active: true, changes: 0, landed: false },
		{ path: TREE, branch: 'agent/s1', head: 'c'.repeat(40), isMain: false, active: false, changes: 0, landed: false },
	];
	w.on('worktree_list', () => trees);
	// A turn that starts stays started: the demo's own would play out over seconds.
	w.on('agent_start', () => undefined);
});

function session(over: Partial<AgentSession> = {}): AgentSession {
	return {
		id: 's1',
		repoId: REPO,
		title: 'Add a shuffle button to the player',
		cwd: TREE,
		branch: 'agent/s1',
		isolated: true,
		mode: 'acceptEdits',
		sessionId: 'claude-s1',
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

/** A question about the code: it runs in the checkout on screen and only reads. */
const question = (over: Partial<AgentSession> = {}): AgentSession => session({ kind: 'ask', title: 'Where is authentication handled?', cwd: REPO, branch: MAIN, isolated: false, mode: 'default', tools: ['Read', 'Grep', 'Glob'], items: [{ kind: 'user', text: 'Where is authentication handled?' }], ...over });

/** The session pane with this session open in it (and the others in the list). */
async function pane(open: AgentSession | null, others: AgentSession[] = []): Promise<HTMLElement> {
	agents.sessions.set(open ? [open, ...others] : others);
	// The worktrees as this test has them (the pane reads the list the store holds).
	await agents.loadWorktrees();
	if (open) {
		agents.select(open.id);
	}
	return mount('ms-agent-session');
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

/** The line under the title: its state, branch, checkout, uncommitted count, cost and the check's pill. */
const statusLine = (el: HTMLElement): string => read(find(el, '.status')!);
const transcript = (el: HTMLElement): HTMLElement => find(el, '.log')!;
const composer = (el: HTMLElement): HTMLElement => find(el, 'ml-textarea')!;
/** The dialog headed `title`, and whether it is open. */
const dialog = (el: HTMLElement, title: RegExp): HTMLElement => all(el, 'ml-dialog').find((d) => title.test(find(d, 'h3')?.textContent ?? ''))!;
const isOpen = (d: HTMLElement): boolean => !!find<HTMLDialogElement>(d, 'dialog')?.open;
/** The pill at the end of the status line that says how the language servers' check went. */
const pill = (el: HTMLElement): HTMLElement | null => all(el, '.status button, .status span').find((x) => /new errors?$|^No new errors$|^Checking…$/.test(read(x))) ?? null;

const BRIEF = { title: 'Shuffle button', did: 'Added the shuffle button; the player tests pass.', needs: null, choices: [] };

describe('with no session open', () => {
	test('a repository with no agents gets the introduction, with the two kinds of question to start', async () => {
		const el = await pane(null);
		expect(read(el)).toContain('Hand a task to Claude Code.');
		expect(read(el)).toContain('Using Claude Code 2.1.0 (demo)');
		await press(button(el, 'Ask about its history'));
		expect(agents.asking()).toEqual({ scope: 'history', seed: '' });
		// The pane is now the new-question box.
		expect(read(el)).toContain('Ask about harmony');
		expect(read(el)).not.toContain('Hand a task to Claude Code.');
	});

	test('without Claude Code it says what to install and the questions cannot be started', async () => {
		// Asked once, when the store first listens: a world of its own, where the answer is "not found" from the start.
		forgetElements();
		const bare = await world();
		bare.on('agent_available', () => null);
		await import('../../components');
		await bare.get((await import('../../services/repo.store')).RepoStore).init();
		await bare.get((await import('../../services/agents.store')).AgentsStore).init();
		await settle();
		const el = await mount('ms-agent-session');
		expect(read(el)).toContain('The claude command was not found. Install Claude Code, then restart Melodic Studio.');
		expect(disabled(button(el, 'Ask about the code'))).toBe(true);
		expect(disabled(button(el, 'Ask about its history'))).toBe(true);
	});

	test('a repository with agents gets the desk: their cards, for this repository only', async () => {
		const el = await pane(null, [session({ title: 'Shuffle button', review: true }), session({ id: 'other', repoId: '/Users/demo/Source/cadence', cwd: '/Users/demo/Source/cadence', isolated: false, title: 'In cadence', unread: true })]);
		const shown = read(el);
		expect(shown).toContain('Needs you · 1');
		expect(shown).toContain('Shuffle button');
		expect(shown).not.toContain('In cadence');
		expect(shown).not.toContain('Hand a task to Claude Code.');
		expect(find(el, 'h1')).toBeNull();
	});

	test('a Claude conversation alone is enough for the desk', async () => {
		const conv: Conversation = { id: 'c1', kind: 'claude', repoId: REPO, cwd: REPO, branch: 'main', title: 'Why is the upload test flaky', titled: true, sessionId: 'x', state: 'idle', waitingFor: null, lastSaid: '', subagents: [], created: Date.now(), updated: Date.now(), unread: false };
		workspace.conversations.set([conv]);
		const el = await pane(null);
		expect(read(el)).toContain('Why is the upload test flaky');
		expect(read(el)).not.toContain('Hand a task to Claude Code.');
	});

	test('a session opened from the desk replaces it, and its header has the way back', async () => {
		const el = await pane(null, [session({ review: true })]);
		await press(button(el, 'Open'));
		expect(find(el, 'h2')!.textContent).toBe('Add a shuffle button to the player');
		await press(find(el, '[aria-label="Back to all agents"]'));
		expect(agents.selectedId()).toBeNull();
		expect(read(el)).toContain('Needs you · 1');
	});
});

describe('the header of a task', () => {
	test('is its short name once it has a brief, with what was asked as the tooltip', async () => {
		const el = await pane(session({ name: 'Shuffle button' }));
		const title = find(el, 'h2')!;
		expect(title.textContent).toBe('Shuffle button');
		expect(title.title).toBe('Add a shuffle button to the player');
	});

	test('a task in a worktree of its own can be reviewed, reviewed by Claude and merged', async () => {
		const el = await pane(session());
		expect(['Review changes', 'Review with Claude', 'Merge…'].map((label) => !!button(el, label))).toEqual([true, true, true]);
		expect(button(el, 'New question')).toBeNull();
		expect(button(el, 'Compare attempts')).toBeNull();
	});

	test('a task in the main checkout has nothing to merge', async () => {
		const el = await pane(session({ isolated: false, cwd: REPO, branch: MAIN }));
		expect(button(el, 'Review changes')).not.toBeNull();
		expect(button(el, 'Merge…')).toBeNull();
	});

	test('Mark done is there while it needs you (work to review, or a question) and not otherwise', async () => {
		const el = await pane(session());
		expect(button(el, 'Mark done')).toBeNull();
		agents.sessions.set([session({ review: true })]);
		await settle();
		expect(button(el, 'Mark done')).not.toBeNull();
		agents.sessions.set([session({ brief: { ...BRIEF, needs: 'Which icon?' } })]);
		await settle();
		expect(button(el, 'Mark done')).not.toBeNull();
	});

	test('Mark done settles it and leaves its worktree and branch alone', async () => {
		trees[1].changes = 3;
		const el = await pane(session({ review: true, brief: { ...BRIEF, needs: 'Which icon?', choices: ['The old one'] } }));
		const before = w.calls.length;
		await press(button(el, 'Mark done'));
		expect(agents.get('s1')).toMatchObject({ review: false, brief: { needs: null, choices: [] } });
		expect(button(el, 'Mark done')).toBeNull();
		expect(button(el, 'The old one')).toBeNull();
		expect(statusLine(el)).toContain('Finished');
		expect(w.calls.slice(before).map((c) => c.cmd)).not.toContain('worktree_remove');
	});

	test('while it works, nothing can be reviewed or merged', async () => {
		const el = await pane(session({ status: 'running', review: true }));
		expect(disabled(button(el, 'Review changes'))).toBe(true);
		expect(disabled(button(el, 'Review with Claude'))).toBe(true);
		expect(disabled(button(el, 'Merge…'))).toBe(true);
		expect(button(el, 'Mark done')).toBeNull();
	});

	test('Review changes goes to its worktree on the Changes tab; the work still waits to be merged', async () => {
		trees[1].changes = 2;
		const el = await pane(session({ review: true }));
		await press(button(el, 'Review changes'));
		expect(w.sent('worktree_select').map((c) => c.args.path)).toEqual([TREE]);
		expect(repos.tab()).toBe('changes');
		expect(agents.get('s1')!.review).toBe(true);
	});

	test('Review with Claude goes to its worktree and has Claude review everything since the agent started, committed or not', async () => {
		trees[1].changes = 2;
		const el = await pane(session({ review: true }));
		expect(button(el, 'Review with Claude')!.title).toBe('Goes to its worktree, where Claude looks for bugs and risks in everything it changed, committed or not');
		await press(button(el, 'Review with Claude'));
		await settle();
		expect(w.sent('worktree_select').map((c) => c.args.path)).toEqual([TREE]);
		expect(w.sent('ai_review_diff').map((c) => c.args)).toEqual([{ id: REPO, scope: 'work', base: 'b'.repeat(40) }]);
		// Nothing of a review is posted to the host.
		expect(w.calls.map((c) => c.cmd).filter((c) => /^(pr_|host_|push$)/.test(c))).toEqual([]);
	});

	test('one attempt of several has the way to compare them', async () => {
		const el = await pane(session({ group: 'g1', attempt: 1 }), [session({ id: 's2', group: 'g1', attempt: 2, cwd: `${REPO}.worktrees/s2`, branch: 'agent/s1-2' })]);
		expect(statusLine(el)).toContain('Attempt 1');
		await press(button(el, 'Compare attempts'));
		expect(agents.comparing()).toBe('g1');
		// The pane is now the comparison.
		expect(read(el)).toContain('2 attempts at the same task');
	});
});

describe('the line under the title', () => {
	test('says how it stands, its branch, that it has its own worktree, what is uncommitted and what it cost', async () => {
		trees[1].changes = 3;
		const el = await pane(session({ review: true, cost: 1.234 }));
		expect(statusLine(el)).toBe('Needs review agent/s1 own worktree 3 uncommitted $1.23');
	});

	test('names the main checkout for a task that works there', async () => {
		const el = await pane(session({ isolated: false, cwd: REPO, branch: MAIN }));
		expect(statusLine(el)).toBe(`Finished ${MAIN} main checkout`);
	});

	test('follows the session: working, then failed, then stopped', async () => {
		const el = await pane(session({ status: 'running' }));
		expect(statusLine(el)).toContain('Working');
		agents.sessions.set([session({ status: 'failed' })]);
		await settle();
		expect(statusLine(el)).toContain('Failed');
		agents.sessions.set([session({ stopped: true })]);
		await settle();
		expect(statusLine(el)).toContain('Stopped');
	});

	test('a question open in its brief reads "Needs you", not "Needs review"', async () => {
		const el = await pane(session({ brief: { ...BRIEF, needs: 'Which icon?' } }));
		expect(statusLine(el)).toContain('Needs you');
		expect(statusLine(el)).not.toContain('Needs review');
	});

	test('a question says it is read-only, and whether it can read the history', async () => {
		const el = await pane(question());
		expect(statusLine(el)).toBe(`Finished Read-only ${MAIN}`);
		agents.sessions.set([question({ tools: ['Read', 'Grep', 'Glob', 'Bash(git log:*)'] })]);
		await settle();
		expect(statusLine(el)).toContain('Read-only, with git history');
	});
});

describe('the check of its change', () => {
	const check = (over: Partial<WorkCheck> = {}): WorkCheck => ({ state: 'done', problems: [], known: 0, impact: [], servers: ['TypeScript'], files: 1, users: 0, finished: true, ...over });
	const errors = [
		{ path: 'src/player/queue.ts', line: 17, column: 5, message: "Type 'null' is not assignable to type 'Track'.\n  second line of the message", source: 'ts', changed: true },
		{ path: 'src/app/main.ts', line: 40, column: 9, message: 'Expected 2 arguments, but got 1.', source: 'ts', changed: false },
	];

	test('is a pill at the end of the line, and starts folded', async () => {
		const el = await pane(session({ check: check({ problems: errors, files: 2, users: 1 }) }));
		expect(statusLine(el)).toMatch(/2 new errors$/);
		expect(pill(el)!.getAttribute('aria-expanded')).toBe('false');
		expect(read(el)).not.toContain('Expected 2 arguments, but got 1.');
		expect(button(el, 'Ask Claude to fix them')).toBeNull();
	});

	test('the pill unfolds what was looked at and each new error, and folds it away again', async () => {
		const el = await pane(session({ check: check({ problems: errors, files: 2, users: 1, known: 1 }) }));
		await press(pill(el));
		const shown = read(el);
		expect(shown).toContain('2 new errors in the 2 files it changed and 1 that use them (TypeScript). 1 error was already there.');
		expect(shown).toContain("src/player/queue.ts:17 Type 'null' is not assignable to type 'Track'.");
		expect(shown).not.toContain('second line of the message');
		// An error in a caller the agent did not touch is said to be one.
		expect(shown).toContain('src/app/main.ts:40 a file it did not change Expected 2 arguments, but got 1.');
		await press(pill(el));
		expect(read(el)).not.toContain('Expected 2 arguments, but got 1.');
	});

	test('Ask Claude to fix them is the only thing that sends the errors to the agent', async () => {
		const el = await pane(session({ check: check({ problems: errors }) }));
		expect(w.sent('agent_start')).toEqual([]);
		await press(pill(el));
		await press(button(el, 'Ask Claude to fix them'));
		const sent = w.sent('agent_start');
		expect(sent.length).toBe(1);
		expect(String(sent[0].args.prompt)).toContain('src/player/queue.ts');
		expect(String(sent[0].args.prompt)).toContain('Expected 2 arguments, but got 1.');
		// The transcript says what was asked, not the whole prompt, and the old verdict is gone with the new turn.
		expect(read(transcript(el))).toContain('Asked Claude to fix the 2 errors its change brought, as the language server reports them.');
		expect(agents.get('s1')!.check).toBeNull();
		expect(pill(el)).toBeNull();
	});

	test('one error is "it", not "them"', async () => {
		const el = await pane(session({ check: check({ problems: [errors[0]] }) }));
		expect(statusLine(el)).toMatch(/1 new error$/);
		await press(pill(el));
		expect(button(el, 'Ask Claude to fix it')).not.toBeNull();
	});

	test('more than six errors are counted, not listed', async () => {
		const many = Array.from({ length: 9 }, (_, n) => ({ ...errors[0], line: n + 1, message: `Problem number ${n + 1}` }));
		const el = await pane(session({ check: check({ problems: many }) }));
		await press(pill(el));
		expect(read(el)).toContain('Problem number 6');
		expect(read(el)).not.toContain('Problem number 7');
		expect(read(el)).toContain('and 3 more');
	});

	test('an error is a way to the place: its checkout, on the Files tab, at the line', async () => {
		const el = await pane(session({ check: check({ problems: errors }) }));
		const went: unknown[][] = [];
		agents.openPlace = async (...args: unknown[]) => void went.push(args);
		await press(pill(el));
		await press(button(el, 'src/app/main.ts:40'));
		expect(went).toEqual([[agents.get('s1'), 'src/app/main.ts', 40, 9]]);
	});

	test('a clean change says so, and still lists who uses what it changed', async () => {
		const impact = [{ symbol: 'greet', path: 'src/greet.ts', line: 3, uses: [{ path: 'src/a.ts', line: 1 }, { path: 'src/b.ts', line: 2 }, { path: 'src/c.ts', line: 3 }, { path: 'src/d.ts', line: 4 }] }];
		const el = await pane(session({ check: check({ impact, users: 4 }) }));
		expect(statusLine(el)).toMatch(/No new errors$/);
		await press(pill(el));
		expect(read(el)).toContain('No new errors in the file it changed and 4 that use it (TypeScript).');
		const uses = find<HTMLDetailsElement>(el, 'details')!;
		expect(read(find(uses, 'summary')!)).toBe('It changed greet, used in 4 places it did not touch');
		expect(uses.open).toBe(false);
		expect(all(uses, 'li').map((li) => read(li))).toEqual(['src/a.ts:1 uses greet', 'src/b.ts:2 uses greet', 'src/c.ts:3 uses greet', 'src/d.ts:4 uses greet']);
	});

	test('says when the server ran out of time, so there may be more', async () => {
		const el = await pane(session({ check: check({ finished: false }) }));
		await press(pill(el));
		expect(read(el)).toContain('The language server was still working when the time ran out, so there may be more.');
	});

	test('while the servers look it says Checking…, and that cannot be unfolded', async () => {
		const el = await pane(session({ check: check({ state: 'checking' }) }));
		expect(statusLine(el)).toMatch(/Checking…$/);
		expect(pill(el)!.tagName).not.toBe('BUTTON');
	});

	test('the fix cannot be asked for while the agent is on a turn', async () => {
		const el = await pane(session({ check: check({ problems: errors }) }));
		await press(pill(el));
		agents.sessions.set([session({ status: 'running', check: check({ problems: errors }) })]);
		await settle();
		expect(disabled(button(el, 'Ask Claude to fix them'))).toBe(true);
	});

	test('compiler output is shown as text', async () => {
		const el = await pane(session({ check: check({ problems: [{ ...errors[0], message: '<img src=x onerror=alert(1)> is not assignable' }], impact: [{ symbol: '<b>greet</b>', path: 'a.ts', line: 1, uses: [{ path: 'src/a.ts', line: 1 }] }] }) }));
		await press(pill(el));
		expect(all(el, 'img').length).toBe(0);
		expect(read(el)).toContain('<img src=x onerror=alert(1)> is not assignable');
		expect(read(el)).toContain('It changed <b>greet</b>, used in 1 place it did not touch');
	});
});

describe('the brief above the transcript', () => {
	test('says what was asked, what it did and that nothing is needed', async () => {
		const el = await pane(session({ brief: BRIEF, items: [{ kind: 'user', text: 'Add a shuffle button to the player' }, { kind: 'text', text: 'Long reply.', brief: BRIEF }] }));
		const brief = read(find(el, 'dl')!);
		expect(brief).toBe('Asked Add a shuffle button to the player Did Added the shuffle button; the player tests pass. Needs you Nothing. It is finished.');
	});

	test('a question comes with Claude’s suggested answers as buttons, and a click sends that answer', async () => {
		const brief = { ...BRIEF, needs: 'Should it shuffle the whole queue or only what is left?', choices: ['The whole queue', 'Only what is left'] };
		const el = await pane(session({ brief, review: true }));
		expect(read(find(el, 'dl')!)).toContain('Needs you Should it shuffle the whole queue or only what is left? The whole queue Only what is left');
		await press(button(el, 'Only what is left'));
		const sent = w.sent('agent_start');
		expect(sent.map((c) => c.args.prompt)).toEqual(['Only what is left']);
		expect(sent[0].args).toMatchObject({ key: 's1', cwd: TREE, resume: 'claude-s1', mode: 'acceptEdits', options: { brief: true } });
		// Answered: the question and its buttons are gone, and it says what it is doing now.
		expect(button(el, 'The whole queue')).toBeNull();
		expect(read(find(el, 'dl')!)).toContain('Now');
		expect(read(transcript(el))).toContain('Only what is left');
	});

	test('with work to review and no question it says to review, then merge', async () => {
		const el = await pane(session({ review: true, brief: BRIEF }));
		expect(read(find(el, 'dl')!)).toContain('Needs you Review its changes, then merge');
	});

	test('while a turn runs it says the latest step in Claude’s own words for it', async () => {
		const el = await pane(session({ status: 'running', items: [{ kind: 'user', text: 'Fix the queue' }, { kind: 'tool', text: 'Bash', detail: 'npm test -- queue', about: 'Run the queue tests' }] }));
		const brief = read(find(el, 'dl')!);
		expect(brief).toContain('Asked Fix the queue');
		expect(brief).toContain('Now Run the queue tests');
		expect(brief).not.toContain('Needs you');
	});

	test('a question has no brief', async () => {
		const el = await pane(question());
		expect(find(el, 'dl')).toBeNull();
	});

	test('what Claude put in its brief is shown as text', async () => {
		const el = await pane(session({ brief: { title: 't', did: '<script>alert(1)</script>', needs: '<img src=x onerror=alert(2)>', choices: ['<b>yes</b>'] } }));
		expect(all(el, 'script, img, dl b').length).toBe(0);
		expect(read(find(el, 'dl')!)).toContain('<script>alert(1)</script>');
		expect(read(find(el, 'dl')!)).toContain('<img src=x onerror=alert(2)>');
		expect(button(el, '<b>yes</b>')).not.toBeNull();
	});
});

describe('the transcript', () => {
	const reply = (text: string): AgentItem[] => [{ kind: 'user', text: 'Where is the queue?' }, { kind: 'text', text }];

	test('shows the message, each tool call with what it acted on, and the reply', async () => {
		const el = await pane(
			session({
				items: [
					{ kind: 'user', text: 'Fix the queue' },
					{ kind: 'tool', text: 'Read', detail: 'src/player/queue.ts' },
					{ kind: 'tool', text: 'Bash', detail: 'npm test -- queue', about: 'Run the queue tests' },
					{ kind: 'text', text: 'It **wraps** now.' },
					{ kind: 'error', text: 'Stopped.' },
				],
			})
		);
		expect(read(transcript(el))).toBe('Fix the queue Read src/player/queue.ts Bash Run the queue tests It wraps now. Stopped.');
		expect(find(transcript(el), 'strong')!.textContent).toBe('wraps');
	});

	test('markup in a reply, in the user’s message and in an error is text', async () => {
		const el = await pane(
			session({
				items: [
					{ kind: 'user', text: '<img src=x onerror=alert(1)> please' },
					{ kind: 'tool', text: 'Bash', detail: '<b>rm</b>' },
					{ kind: 'text', text: 'Sure <script>alert(2)</script> and [link](javascript:alert(3))' },
					{ kind: 'error', text: '<iframe src="x"></iframe>' },
				],
			})
		);
		expect(all(transcript(el), 'img, script, iframe, a, .tool b > b').length).toBe(0);
		const shown = read(transcript(el));
		expect(shown).toContain('<img src=x onerror=alert(1)> please');
		expect(shown).toContain('<script>alert(2)</script>');
		expect(shown).toContain('<iframe src="x"></iframe>');
		expect(shown).toContain('<b>rm</b>');
	});

	test('a question’s answer links its files, and a click opens the file at the line', async () => {
		const el = await pane(question({ items: reply('It is in `src/services/auth.ts:42`.') }));
		const followed: AgentRef[] = [];
		agents.follow = async (_s: AgentSession, ref: AgentRef) => void followed.push(ref);
		const link = find(transcript(el), 'a')!;
		expect(link.textContent).toBe('src/services/auth.ts:42');
		await click(link);
		expect(followed).toEqual([{ kind: 'file', path: 'src/services/auth.ts', line: 42, column: null }]);
	});

	test('commit hashes are links in a question about the history, and only there', async () => {
		const text = 'Changed in `a1b2c3d`, see `src/player/queue.ts:17`.';
		const el = await pane(question({ items: reply(text) }));
		expect(all(transcript(el), 'a').map((a) => a.textContent)).toEqual(['src/player/queue.ts:17']);
		agents.sessions.set([question({ items: reply(text), tools: ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)'] })]);
		await settle();
		expect(all(transcript(el), 'a').map((a) => a.textContent)).toEqual(['a1b2c3d', 'src/player/queue.ts:17']);
	});

	test('a task’s file references are links only while its checkout is the one on screen', async () => {
		const el = await pane(session({ items: reply('See `src/player/queue.ts:17`.') }));
		// Its worktree is not on screen: a link would open the main checkout's copy of the file.
		expect(all(transcript(el), 'a')).toEqual([]);
		expect(read(transcript(el))).toContain('src/player/queue.ts:17');
		await agents.view(TREE, 'agents');
		await settle();
		expect(all(transcript(el), 'a').map((a) => a.textContent)).toEqual(['src/player/queue.ts:17']);
	});

	test('a task in the main checkout links its files', async () => {
		const el = await pane(session({ isolated: false, cwd: REPO, branch: MAIN, items: reply('See `src/player/queue.ts:17`.') }));
		expect(all(transcript(el), 'a').map((a) => a.textContent)).toEqual(['src/player/queue.ts:17']);
	});

	test('a web address is a link that the app opens in the browser, never a navigation', async () => {
		const el = await pane(question({ items: reply('Docs: https://example.com/docs') }));
		w.on('plugin:opener|open_url', () => undefined);
		const link = find(transcript(el), 'a')!;
		expect(link.getAttribute('href')).toBeNull();
		await click(link);
		expect(w.sent('plugin:opener|open_url').map((c) => c.args.url)).toEqual(['https://example.com/docs']);
	});

	test('an earlier turn that ended with a brief is folded to what it did and asked', async () => {
		const first = { title: 'Shuffle', did: 'Added the button.', needs: 'Which icon?', choices: [] };
		const el = await pane(
			session({
				brief: BRIEF,
				items: [
					{ kind: 'user', text: 'Add a shuffle button' },
					{ kind: 'tool', text: 'Read', detail: 'src/player/controls.ts' },
					{ kind: 'tool', text: 'Edit', detail: 'src/player/controls.ts' },
					{ kind: 'text', text: 'One two three four five.', brief: first },
					{ kind: 'user', text: 'The old icon' },
					{ kind: 'text', text: 'Used the old icon everywhere.', brief: BRIEF },
				],
			})
		);
		const shown = read(transcript(el));
		expect(shown).toContain('Add a shuffle button Added the button. Which icon? Full reply · 5 words · 2 steps');
		expect(shown).not.toContain('One two three four five.');
		expect(shown).not.toContain('src/player/controls.ts');
		// The newest turn's brief is the block above: here it is only the fold.
		expect(shown).toMatch(/The old icon Full reply · 5 words$/);
		expect(shown).not.toContain('Used the old icon everywhere.');
	});

	test('Full reply unfolds a turn, and folds it again', async () => {
		const el = await pane(session({ brief: BRIEF, items: [{ kind: 'user', text: 'Add a shuffle button' }, { kind: 'tool', text: 'Edit', detail: 'src/player/controls.ts' }, { kind: 'text', text: 'The whole long reply.', brief: BRIEF }] }));
		const fold = (): HTMLElement => button(transcript(el), /^Full reply/)!;
		expect(fold().getAttribute('aria-expanded')).toBe('false');
		await press(fold());
		expect(fold().getAttribute('aria-expanded')).toBe('true');
		expect(read(transcript(el))).toContain('Edit src/player/controls.ts The whole long reply.');
		await press(fold());
		expect(read(transcript(el))).not.toContain('The whole long reply.');
	});

	test('a turn still running is shown as it comes, not folded', async () => {
		const el = await pane(session({ status: 'running', items: [{ kind: 'user', text: 'Add a shuffle button' }, { kind: 'text', text: 'Looking at the controls first.', brief: BRIEF }] }));
		expect(read(transcript(el))).toContain('Looking at the controls first.');
		expect(button(transcript(el), /^Full reply/)).toBeNull();
		expect(read(transcript(el))).toContain('Working…');
	});

	test('a turn without a brief (a question, an older session) shows whole', async () => {
		const el = await pane(question({ items: reply('The queue lives in the player folder.') }));
		expect(read(transcript(el))).toBe('Where is the queue? The queue lives in the player folder.');
	});

	test('only the last 300 items are drawn; Show earlier brings 300 more', async () => {
		const items: AgentItem[] = Array.from({ length: 700 }, (_, n) => ({ kind: 'tool', text: 'Read', detail: `file-${n + 1}.ts` }));
		const el = await pane(question({ items }));
		const drawn = (): number => all(transcript(el), 'b').length;
		expect(drawn()).toBe(300);
		expect(read(transcript(el))).toContain('file-700.ts');
		expect(read(transcript(el))).not.toContain('file-400.ts ');
		await press(button(el, 'Show earlier (400 more)'));
		expect(drawn()).toBe(600);
		await press(button(el, 'Show earlier (100 more)'));
		expect(drawn()).toBe(700);
		expect(button(el, /^Show earlier/)).toBeNull();
	});

	test('showing a session counts it as seen', async () => {
		agents.sessions.set([session({ unread: true, review: true })]);
		// As when its turn ended while it was already selected in another window state.
		agents.selectedId.set('s1');
		expect(agents.get('s1')!.unread).toBe(true);
		await mount('ms-agent-session');
		expect(agents.get('s1')!.unread).toBe(false);
		// Seen is not settled: the work still waits.
		expect(agents.get('s1')!.review).toBe(true);
	});
});

describe('the box that writes to it', () => {
	test('Send is off until something is typed, and sends what was typed as the next turn', async () => {
		const el = await pane(session());
		expect(disabled(button(el, 'Send'))).toBe(true);
		await type(composer(el), 'Also add a tooltip');
		expect(disabled(button(el, 'Send'))).toBe(false);
		await press(button(el, 'Send'));
		const sent = w.sent('agent_start');
		expect(sent.length).toBe(1);
		expect(sent[0].args).toMatchObject({ id: REPO, key: 's1', cwd: TREE, prompt: 'Also add a tooltip', mode: 'acceptEdits', resume: 'claude-s1' });
		expect(read(transcript(el))).toContain('Also add a tooltip');
		// The box is empty again and the turn can be stopped.
		expect(find<HTMLTextAreaElement>(composer(el), 'textarea')!.value).toBe('');
		expect(button(el, 'Send')).toBeNull();
		expect(button(el, 'Stop')).not.toBeNull();
	});

	test('Cmd/Ctrl+Enter sends', async () => {
		const el = await pane(session());
		await type(composer(el), 'With the keyboard');
		composer(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, composed: true, cancelable: true }));
		await settle();
		expect(w.sent('agent_start').map((c) => c.args.prompt)).toEqual(['With the keyboard']);
	});

	test('Enter alone is a new line, not a send', async () => {
		const el = await pane(session());
		await type(composer(el), 'Not yet');
		composer(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true, cancelable: true }));
		await settle();
		expect(w.sent('agent_start')).toEqual([]);
	});

	test('while a turn runs there is Stop instead of Send, and the keyboard sends nothing', async () => {
		const el = await pane(session({ status: 'running' }));
		expect(composer(el).getAttribute('placeholder')).toBe('The agent is working…');
		await type(composer(el), 'One more thing');
		composer(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, composed: true, cancelable: true }));
		await settle();
		expect(w.sent('agent_start')).toEqual([]);
		// What was typed is still there for when the turn ends.
		expect(find<HTMLTextAreaElement>(composer(el), 'textarea')!.value).toBe('One more thing');
		await press(button(el, 'Stop'));
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual(['s1']);
		expect(agents.get('s1')).toMatchObject({ status: 'idle', stopped: true });
		expect(read(transcript(el))).toContain('Stopped.');
	});

	test('the model picked for the next message goes with it', async () => {
		const el = await pane(session());
		const model = all(el, 'ml-select').find((x) => x.classList.contains('model'))!;
		model.dispatchEvent(new CustomEvent('ml:change', { detail: { value: 'opus' } }));
		await settle();
		expect(agents.get('s1')!.model).toBe('opus');
		await type(composer(el), 'Think harder');
		await press(button(el, 'Send'));
		expect(w.sent('agent_start')[0].args.options).toMatchObject({ model: 'opus' });
	});

	test('the permission mode picked is the one the next turn runs in', async () => {
		const el = await pane(session());
		const mode = all(el, 'ml-select').find((x) => !x.classList.contains('model') && !x.closest('ml-dialog'))!;
		mode.dispatchEvent(new CustomEvent('ml:change', { detail: { value: 'plan' } }));
		await settle();
		await type(composer(el), 'Only plan it');
		await press(button(el, 'Send'));
		expect(w.sent('agent_start')[0].args.mode).toBe('plan');
	});

	test('an image waiting in the box goes with the message by a name of ours, even with no words', async () => {
		const image = { name: '0d9f6c1e-1111-4222-8333-444455556666.png', mediaType: 'image/png', data: 'AAAA', url: 'data:image/png;base64,AAAA' };
		agents.attached.set({ s1: [image] });
		const el = await pane(session());
		expect(disabled(button(el, 'Send'))).toBe(false);
		await press(button(el, 'Send'));
		// Saved in the session's folder first; the turn is handed the name, never a path or the bytes.
		expect(w.sent('agent_image_save').map((c) => c.args)).toEqual([{ id: 's1', name: image.name, data: 'AAAA' }]);
		const sent = w.sent('agent_start')[0].args;
		expect(sent.options).toMatchObject({ images: [image.name] });
		expect(JSON.stringify(sent)).not.toContain('AAAA');
		const order = w.calls.map((c) => c.cmd);
		expect(order.indexOf('agent_image_save')).toBeLessThan(order.indexOf('agent_start'));
		// The box is empty again, and the transcript shows what went.
		expect(agents.attached().s1).toEqual([]);
		expect(find<HTMLImageElement>(transcript(el), 'img')!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
	});

	test('nothing can be sent while an image is still being made ready', async () => {
		const el = await pane(session());
		await type(composer(el), 'Look at this');
		agents.attaching.set({ s1: 1 });
		await settle();
		expect(disabled(button(el, 'Send'))).toBe(true);
		composer(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, composed: true, cancelable: true }));
		await settle();
		expect(w.sent('agent_start')).toEqual([]);
		expect(find<HTMLTextAreaElement>(composer(el), 'textarea')!.value).toBe('Look at this');
	});

	test('an image sent earlier is read back from the session’s folder, small at first and large on a click', async () => {
		w.on('agent_image_read', (args) => (args.name === 'kept.png' ? 'QUJD' : Promise.reject({ kind: 'error', message: 'No such image', paths: [] })));
		const el = await pane(session({ items: [{ kind: 'user', text: 'See the screenshot', images: ['kept.png', 'gone.png'] }] }));
		await settle();
		expect(w.sent('agent_image_read').map((c) => c.args)).toEqual([
			{ id: 's1', name: 'kept.png' },
			{ id: 's1', name: 'gone.png' },
		]);
		const shot = find<HTMLImageElement>(transcript(el), 'img')!;
		expect(shot.getAttribute('src')).toBe('data:image/png;base64,QUJD');
		expect(shot.title).toBe('Show it large');
		// One whose file is no longer there says so instead of showing a broken picture.
		expect(read(transcript(el))).toContain('Image not kept');
		await click(shot);
		expect(find<HTMLImageElement>(transcript(el), 'img')!.title).toBe('Show it small again');
	});

	test('a question is asked, not sent: read-only, in default mode, with only its own tools', async () => {
		const el = await pane(question({ tools: ['Read', 'Grep', 'Glob', 'Bash(git log:*)'] }));
		expect(button(el, 'Send')).toBeNull();
		expect(read(el)).toContain('Read-only: it can search and read the files and the git history, and change nothing.');
		expect(composer(el).getAttribute('placeholder')).toBe('Ask a follow-up question');
		await type(composer(el), 'And who changed it last?');
		await press(button(el, 'Ask'));
		const args = w.sent('agent_start')[0].args;
		expect(args).toMatchObject({ prompt: 'And who changed it last?', mode: 'default', cwd: REPO, resume: 'claude-s1' });
		expect(args.options).toMatchObject({ tools: ['Read', 'Grep', 'Glob', 'Bash(git log:*)'], builtin: ['Read', 'Grep', 'Glob', 'Bash'], lean: true });
		expect(w.sent('worktree_add')).toEqual([]);
	});

	test('a question has New question in its header and nothing to review or merge', async () => {
		const el = await pane(question());
		expect(['Review changes', 'Review with Claude', 'Merge…'].map((label) => button(el, label))).toEqual([null, null, null]);
		await press(button(el, 'New question'));
		expect(agents.asking()).toEqual({ scope: 'code', seed: '' });
	});
});

describe('a task with a pipeline', () => {
	const planning = (): AgentSession => session({ task: 'Add a shuffle button to the player', pipeline: withStep({ ...newPipeline('bug'), waiting: true, note: 'Approve the plan to start coding.', reason: 'approve' }, 'plan', { state: 'you' }) });
	const shipping = (): AgentSession => session({ task: 'Add a shuffle button to the player', pipeline: withStep({ ...newPipeline('bug'), step: 'ship', waiting: true, note: 'Every check passes. Merge it or open a pull request.', reason: 'ship' }, 'ship', { state: 'you' }) });

	test('has its track where the brief would be', async () => {
		const el = await pane(planning());
		expect(find(el, 'ms-pipeline')).not.toBeNull();
		expect(find(el, 'dl')).toBeNull();
		expect(button(el, 'Approve plan')).not.toBeNull();
	});

	test('what is typed while the plan waits changes the plan: another read-only planning turn', async () => {
		const el = await pane(planning());
		expect(composer(el).getAttribute('placeholder')).toBe('Ask for changes to the plan');
		expect(read(el)).toContain('Changes the plan before you approve it.');
		await type(composer(el), 'Cover an empty queue too');
		await press(button(el, 'Send'));
		const args = w.sent('agent_start')[0].args;
		expect(String(args.prompt)).toContain('[pipeline-plan]');
		expect(String(args.prompt)).toContain('Cover an empty queue too');
		expect(args.mode).toBe('default');
		expect(agents.get('s1')!.pipeline).toMatchObject({ step: 'plan', waiting: false });
		// The transcript shows the words typed, not the prompt around them.
		expect(read(transcript(el))).toContain('Cover an empty queue too');
		expect(read(transcript(el))).not.toContain('[pipeline-plan]');
	});

	test('what is typed later is more work, to be committed and checked like the rest', async () => {
		const el = await pane(shipping());
		expect(read(el)).toContain('More work: committed, reviewed and tested like the rest.');
		await type(composer(el), 'Rename the button');
		await press(button(el, 'Send'));
		expect(w.sent('agent_start')[0].args).toMatchObject({ prompt: 'Rename the button', mode: 'acceptEdits' });
		expect(agents.get('s1')!.pipeline).toMatchObject({ step: 'code', waiting: false });
	});

	test('has no permission mode or model to pick in its box: each step has its own', async () => {
		const el = await pane(planning());
		expect(all(el, 'ml-select').filter((x) => !x.closest('ml-dialog'))).toEqual([]);
	});

	test('Merge… on its track opens the Merge dialog, which says its worktree and branch go afterwards', async () => {
		const el = await pane(shipping());
		const merge = dialog(el, /^Merge agent\/s1$/);
		expect(isOpen(merge)).toBe(false);
		await press(button(find(el, 'ms-pipeline')!, 'Merge…'));
		expect(isOpen(merge)).toBe(true);
		expect(read(merge)).toContain('Afterwards its worktree and the branch agent/s1 are deleted, here and on the remote. The session stays as a record.');
		// No box to untick: a task's worktree always goes once its work is merged.
		expect(find(merge, 'ml-checkbox')).toBeNull();
	});
});

describe('the Merge dialog', () => {
	const open = async (s: AgentSession = session({ review: true })): Promise<{ el: HTMLElement; merge: HTMLElement }> => {
		const el = await pane(s);
		await press(button(el, 'Merge…'));
		const merge = dialog(el, /^Merge agent\/s1$/);
		expect(isOpen(merge)).toBe(true);
		return { el, merge };
	};
	const into = (merge: HTMLElement): HTMLElement & { value: string } => all<HTMLElement & { value: string }>(merge, 'ml-select')[0];
	const mergeButton = (merge: HTMLElement): HTMLElement => button(merge, 'Merge')!;

	test('opens on the branch of the main checkout and says where the merge happens', async () => {
		const { merge } = await open();
		expect(isOpen(merge)).toBe(true);
		expect(into(merge).value).toBe(MAIN);
		expect(read(merge)).toContain(`Merges in the main checkout, which has ${MAIN} checked out.`);
		expect(disabled(mergeButton(merge))).toBe(false);
	});

	test('Merge merges the agent’s branch there, closes, and the work no longer waits', async () => {
		const { el, merge } = await open();
		await press(mergeButton(merge));
		expect(w.sent('merge_branch').map((c) => c.args)).toEqual([{ id: REPO, from: 'agent/s1' }]);
		expect(isOpen(merge)).toBe(false);
		expect(agents.get('s1')!.review).toBe(false);
		expect(button(el, 'Mark done')).toBeNull();
		// Merged into a branch that was already checked out: no checkout was switched.
		expect(w.sent('branch_checkout')).toEqual([]);
	});

	test('the box to delete its worktree and branch afterwards is ticked, and with it the merge cleans up; the session stays', async () => {
		const { merge } = await open();
		const box = find(merge, 'ml-checkbox')!;
		expect(box.getAttribute('label')).toBe('Then delete its worktree and the branch agent/s1');
		expect((box as HTMLElement & { checked: boolean }).checked).toBe(true);
		await press(mergeButton(merge));
		expect(w.sent('worktree_remove').map((c) => c.args)).toEqual([{ id: REPO, path: TREE, force: true, deleteBranch: true }]);
		expect(agents.get('s1')).not.toBeNull();
	});

	test('unticked, the merge leaves the worktree and branch, and the choice is remembered', async () => {
		const { merge } = await open();
		const tick = find<HTMLInputElement>(find(merge, 'ml-checkbox')!, 'input')!;
		tick.checked = false;
		tick.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(localStorage.getItem('studio.agents.merge-cleanup')).toBe('off');
		await press(mergeButton(merge));
		expect(w.sent('merge_branch').length).toBe(1);
		expect(w.sent('worktree_remove')).toEqual([]);
	});

	test('uncommitted work in its worktree is not merged: it says so, and the worktree is kept', async () => {
		trees[1].changes = 2;
		const { merge } = await open();
		expect(read(merge)).toContain("The agent's worktree has 2 uncommitted changes. Only committed work is merged: review and commit first.");
		expect(find(merge, 'ml-checkbox')!.getAttribute('hint')).toBe('Not while the worktree has uncommitted changes: it is kept and you are told.');
		await press(mergeButton(merge));
		expect(w.sent('worktree_remove')).toEqual([]);
		expect(w.toasts.some((t) => t.title === 'Worktree kept')).toBe(true);
	});

	test('a branch that is checked out nowhere cannot be merged into while the main checkout has uncommitted changes', async () => {
		trees[0].changes = 4;
		const { merge } = await open();
		into(merge).dispatchEvent(new CustomEvent('ml:change', { detail: { value: 'main' } }));
		await settle();
		expect(read(merge)).toContain(`The main checkout switches from ${MAIN} to main, then merges.`);
		expect(read(merge)).toContain('The main checkout has uncommitted changes. Commit or stash them before it switches to main.');
		expect(disabled(mergeButton(merge))).toBe(true);
	});

	test('with a clean main checkout it switches to the branch first, then merges', async () => {
		const { merge } = await open();
		into(merge).dispatchEvent(new CustomEvent('ml:change', { detail: { value: 'main' } }));
		await settle();
		expect(disabled(mergeButton(merge))).toBe(false);
		await press(mergeButton(merge));
		expect(w.sent('branch_checkout').map((c) => c.args.name)).toEqual(['main']);
		expect(w.sent('merge_branch').map((c) => c.args.from)).toEqual(['agent/s1']);
		const order = w.calls.map((c) => c.cmd);
		expect(order.indexOf('branch_checkout')).toBeLessThan(order.indexOf('merge_branch'));
	});

	test('a new branch is made from the one picked, named after the agent’s, then merged into', async () => {
		const { merge } = await open();
		into(merge).dispatchEvent(new CustomEvent('ml:change', { detail: { value: '\u0000new' } }));
		await settle();
		expect(read(merge)).toContain(`Creates feature/s1 from ${MAIN} in the main checkout, which switches to it, then merges.`);
		await type(all(merge, 'ml-input')[0], 'release with space');
		expect(read(merge)).toContain('Creates release-with-space from');
		await press(mergeButton(merge));
		expect(w.sent('branch_create').map((c) => c.args)).toEqual([{ id: REPO, name: 'release-with-space', start: MAIN }]);
		expect(w.sent('merge_branch').map((c) => c.args.from)).toEqual(['agent/s1']);
	});

	test('the agent’s own branch is not offered as a target', async () => {
		const { merge } = await open();
		const options = (into(merge) as unknown as { options: { value: string; label: string }[] }).options;
		expect(options.map((o) => o.value)).not.toContain('agent/s1');
		expect(options.map((o) => o.label)).toContain(`${MAIN} (main checkout)`);
		expect(options[options.length - 1].label).toBe('New branch…');
	});

	test('Cancel closes it and merges nothing', async () => {
		const { merge } = await open();
		await press(button(merge, 'Cancel'));
		expect(isOpen(merge)).toBe(false);
		expect(w.sent('merge_branch')).toEqual([]);
		expect(agents.get('s1')!.review).toBe(true);
	});

	test('for a protected branch: Open a pull request… goes to the agent’s worktree and opens the pull request dialog, publishing nothing', async () => {
		const { el, merge } = await open();
		const host = w.get((await import('../../services/host.store')).HostStore);
		let asked = 0;
		host.openPr = () => void asked++;
		expect(read(merge)).toContain('Branch protected? Push agent/s1 and open a pull request instead.');
		await press(button(merge, 'Open a pull request…'));
		expect(isOpen(merge)).toBe(false);
		expect(w.sent('worktree_select').map((c) => c.args.path)).toEqual([TREE]);
		expect(repos.tab()).toBe('changes');
		expect(asked).toBe(1);
		expect(w.calls.map((c) => c.cmd).filter((c) => /^(pr_create|push|merge_branch)$/.test(c))).toEqual([]);
		expect(el.isConnected).toBe(true);
	});

	test('a merge that fails leaves the dialog open and the work waiting', async () => {
		w.on('merge_branch', () => {
			throw { kind: 'conflict', message: 'Merge conflict in src/player/queue.ts', paths: ['src/player/queue.ts'] };
		});
		const { merge } = await open();
		await press(mergeButton(merge));
		expect(isOpen(merge)).toBe(true);
		expect(agents.get('s1')!.review).toBe(true);
		expect(w.sent('worktree_remove')).toEqual([]);
	});
});

describe('an investigation', () => {
	const investigation = (): AgentSession =>
		session({
			kind: 'investigate',
			title: 'NullReferenceException in ApplyDiscount',
			branch: 'investigate/nullreferenceexception-in-applydiscount',
			status: 'running',
			investigation: { summary: 'NullReferenceException in ApplyDiscount', description: '', targetId: null, targetName: 'Shop.Api', port: null, step: 2, details: {}, thinking: '', approval: null, runs: 0, started: Date.now(), ended: null, report: null, leftover: [], cleanups: 0, checking: false, tab: null },
		});

	test('has its own view in the pane, not a transcript and a box', async () => {
		const el = await pane(investigation());
		expect(find(el, 'ms-investigation')).not.toBeNull();
		expect(find(el, 'ml-textarea')).toBeNull();
		expect(read(el)).toContain('Investigating');
		expect(read(el)).toContain('NullReferenceException in ApplyDiscount');
	});

	const found = (): AgentSession => ({
		...investigation(),
		status: 'idle',
		investigation: {
			...investigation().investigation!,
			step: 6,
			ended: Date.now(),
			report: { found: true, summary: 'ApplyDiscount reads customer.Tier before checking the customer: guest orders have none.', path: [], evidence: [], run: null, causeSeq: null, crashSeq: null, notes: {}, test: { name: 'ApplyDiscount_GuestOrder', failsBefore: true, passesAfter: true } },
		},
	});

	test('accepting its fix opens the Merge dialog with a commit message to edit, made from the cause', async () => {
		trees[1].changes = 2;
		const el = await pane(found());
		const accept = dialog(el, /^Accept the fix$/);
		expect(isOpen(accept)).toBe(false);
		find(el, 'ms-investigation')!.dispatchEvent(new CustomEvent('accept'));
		await settle();
		expect(isOpen(accept)).toBe(true);
		const message = all<HTMLElement & { value: string }>(accept, 'ml-input').find((i) => i.getAttribute('label') === 'Commit message')!;
		expect(message.value).toBe('Fix: ApplyDiscount reads customer.Tier before checking the customer');
		expect(message.getAttribute('hint')).toBe('The fix is committed on investigate/nullreferenceexception-in-applydiscount as you, then merged.');
		expect(button(accept, 'Commit and merge')).not.toBeNull();
		expect(w.sent('investigate_commit')).toEqual([]);
	});

	test('Commit and merge commits the fix in its worktree with the message as typed, then merges it', async () => {
		trees[1].changes = 2;
		const el = await pane(found());
		find(el, 'ms-investigation')!.dispatchEvent(new CustomEvent('accept'));
		await settle();
		const accept = dialog(el, /^Accept the fix$/);
		await type(all(accept, 'ml-input').find((i) => i.getAttribute('label') === 'Commit message')!, 'Fix the crash for guest orders');
		await press(button(accept, 'Commit and merge'));
		// The user's own words and nothing added: no trailer, no attribution.
		expect(w.sent('investigate_commit').map((c) => c.args)).toEqual([{ id: REPO, cwd: TREE, summary: 'Fix the crash for guest orders', description: 'Adds the test ApplyDiscount_GuestOrder.' }]);
		expect(w.sent('merge_branch').map((c) => c.args.from)).toEqual(['investigate/nullreferenceexception-in-applydiscount']);
		const order = w.calls.map((c) => c.cmd);
		expect(order.indexOf('investigate_commit')).toBeLessThan(order.indexOf('merge_branch'));
		expect(isOpen(accept)).toBe(false);
	});

	test('the fix is not committed without a message', async () => {
		trees[1].changes = 2;
		const el = await pane(found());
		find(el, 'ms-investigation')!.dispatchEvent(new CustomEvent('accept'));
		await settle();
		const accept = dialog(el, /^Accept the fix$/);
		await type(all(accept, 'ml-input').find((i) => i.getAttribute('label') === 'Commit message')!, '   ');
		expect(disabled(button(accept, 'Commit and merge'))).toBe(true);
	});

	test('a commit that is refused (recording still in the code) merges nothing', async () => {
		trees[1].changes = 2;
		w.on('investigate_commit', () => {
			throw { kind: 'error', message: 'Recording is still in src/Shop.Api/Services/PriceService.cs', paths: [] };
		});
		const el = await pane(found());
		find(el, 'ms-investigation')!.dispatchEvent(new CustomEvent('accept'));
		await settle();
		const accept = dialog(el, /^Accept the fix$/);
		await press(button(accept, 'Commit and merge'));
		expect(w.sent('merge_branch')).toEqual([]);
		expect(isOpen(accept)).toBe(true);
		expect(w.toasts.some((t) => t.kind === 'error' && t.message.includes('Recording is still in'))).toBe(true);
	});

	test('discarding it asks first, saying the checkout was never changed, and then removes its worktree and branch', async () => {
		const el = await pane({ ...investigation(), status: 'idle', stopped: true });
		const discard = dialog(el, /^Discard this investigation$/);
		expect(isOpen(discard)).toBe(false);
		find(el, 'ms-investigation')!.dispatchEvent(new CustomEvent('discard', { detail: 's1' }));
		await settle();
		expect(isOpen(discard)).toBe(true);
		expect(read(discard)).toContain('Its worktree and the branch investigate/nullreferenceexception-in-applydiscount are deleted');
		expect(read(discard)).toContain('Your own checkout was never changed, so nothing there is lost.');
		expect(w.sent('worktree_remove')).toEqual([]);
		await press(button(discard, 'Discard'));
		expect(w.sent('worktree_remove').map((c) => c.args)).toEqual([{ id: REPO, path: TREE, force: true, deleteBranch: true }]);
		expect(agents.get('s1')).toBeNull();
	});
});
