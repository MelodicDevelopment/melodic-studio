import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { AgentSession, AgentsStore } from '../../services/agents.store';
import type { RepoStore } from '../../services/repo.store';
import type { ChangedFile, Worktree, WorktreeDiff } from '../../services/backend.service';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';
const BASE = 'b'.repeat(40);

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
/** What each attempt's worktree holds that the commit they started from does not, by worktree path. */
let diffs: Record<string, WorktreeDiff | Error>;
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
 * happy-dom's HTML parser drops the `#` of `<ml-dialog #some-name>`, and that name is what a dialog is
 * opened by (`DialogService.open('some-name')`): it is put back where `ml-dialog` looks for it.
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
	diffs = {};
	w.on('worktree_diff', (args) => {
		const diff = diffs[String(args.path)] ?? { base: BASE, head: 'c'.repeat(40), files: [], tooLarge: false };
		if (diff instanceof Error) {
			throw { kind: 'git', message: diff.message, paths: [] };
		}
		return diff;
	});
	trees = [{ path: REPO, branch: 'feature/repeat-mode', head: 'a'.repeat(40), isMain: true, active: true, changes: 0, landed: false }];
	w.on('worktree_list', () => trees);
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

function changed(path: string, added: string[], removed: string[] = [], status: ChangedFile['status'] = 'modified'): ChangedFile {
	const body = [...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n');
	return { path, oldPath: null, status, diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${removed.length} +1,${added.length} @@\n${body}\n` };
}

const attempt = (n: number, over: Partial<AgentSession> = {}): AgentSession => session({ id: `a${n}`, title: 'Three ways to shuffle', group: 'g1', attempt: n, branch: n === 1 ? 'agent/shuffle' : `agent/shuffle-${n}`, base: BASE, ...over });

/** The comparison of these attempts, with a worktree for each. */
async function comparison(sessions: AgentSession[]): Promise<HTMLElement> {
	trees.push(...sessions.map((s) => ({ path: s.cwd, branch: s.branch, head: 'c'.repeat(40), isMain: false, active: false, changes: 1, landed: false })));
	agents.sessions.set(sessions);
	agents.compare('g1');
	const el = await mount('ms-attempts');
	await settle();
	return el;
}

/** One column per attempt, in order. */
const columns = (el: HTMLElement): HTMLElement[] => all(el, 'section');
const keepDialog = (el: HTMLElement): HTMLElement => find(el, 'ml-dialog')!;
const isOpen = (d: HTMLElement): boolean => !!find<HTMLDialogElement>(d, 'dialog')?.open;

describe('comparing attempts', () => {
	test('says what is compared: the task, how many attempts, and the commit they started from', async () => {
		const el = await comparison([attempt(1), attempt(2), attempt(3)]);
		expect(find(el, 'h2')!.textContent).toBe('Three ways to shuffle');
		expect(read(el)).toContain('3 attempts at the same task, each in its own worktree, compared with where they started (bbbbbbb). Uncommitted and untracked work is included.');
	});

	test('has a column for each attempt, in order, with how it stands, its branch and what it last said', async () => {
		const el = await comparison([
			attempt(2, { status: 'running' }),
			attempt(1, { review: true, cost: 0.31, items: [{ kind: 'user', text: 'Shuffle' }, { kind: 'text', text: 'Used **Fisher-Yates** on the whole queue.' }] }),
		]);
		const [first, second] = columns(el).map((c) => read(find(c, 'header')!));
		expect(first).toContain('Attempt 1 Needs review');
		expect(first).toContain('$0.31');
		expect(first).toContain('agent/shuffle');
		expect(first).toContain('Used Fisher-Yates on the whole queue.');
		expect(second).toContain('Attempt 2 Working');
		expect(second).toContain('agent/shuffle-2');
		expect(second).toContain('Working…');
	});

	test('asks for each attempt’s work since the commit it started from, in its own worktree', async () => {
		await comparison([attempt(1), attempt(2)]);
		expect(w.sent('worktree_diff').map((c) => c.args)).toEqual([
			{ id: REPO, path: `${REPO}.worktrees/a1`, base: BASE },
			{ id: REPO, path: `${REPO}.worktrees/a2`, base: BASE },
		]);
	});

	test('lists what each changed, counts the lines, and marks a file only one attempt touched', async () => {
		diffs[`${REPO}.worktrees/a1`] = { base: BASE, head: 'c'.repeat(40), tooLarge: false, files: [changed('src/player/queue.ts', ['one', 'two'], ['old']), changed('src/player/shuffle.ts', ['new file'], [], 'added')] };
		diffs[`${REPO}.worktrees/a2`] = { base: BASE, head: 'd'.repeat(40), tooLarge: false, files: [changed('src/player/queue.ts', ['other way'], ['old'])] };
		const el = await comparison([attempt(1), attempt(2)]);
		const [first, second] = columns(el);
		expect(read(find(first, 'header')!)).toContain('2 files +3 −1');
		expect(read(find(second, 'header')!)).toContain('1 file +1 −1');
		const rows = (col: HTMLElement): string[] => all(col, '[title^="src/"]').map((r) => read(r));
		// The mark at the end is the status: • modified, + added.
		expect(rows(first)).toEqual(['src/player/ queue.ts •', 'src/player/ shuffle.ts only here +']);
		expect(rows(second)).toEqual(['src/player/ queue.ts •']);
		expect(all(first, 'ms-diff').length).toBe(2);
	});

	test('an attempt with nothing changed says so, and one still working says not yet', async () => {
		const el = await comparison([attempt(1), attempt(2, { status: 'running' })]);
		const [first, second] = columns(el).map((c) => read(c));
		expect(first).toContain('This attempt changed nothing.');
		expect(second).toContain('No changes yet.');
	});

	test('a worktree that cannot be read says why in its own column, and the others still show', async () => {
		diffs[`${REPO}.worktrees/a1`] = new Error('fatal: not a git repository');
		diffs[`${REPO}.worktrees/a2`] = { base: BASE, head: 'd'.repeat(40), tooLarge: false, files: [changed('src/a.ts', ['x'])] };
		const el = await comparison([attempt(1), attempt(2)]);
		const [first, second] = columns(el).map((c) => read(c));
		expect(first).toContain('fatal: not a git repository');
		expect(second).toContain('src/ a.ts');
	});

	test('says when a comparison is too large to show whole', async () => {
		diffs[`${REPO}.worktrees/a1`] = { base: BASE, head: 'c'.repeat(40), tooLarge: true, files: [{ path: 'big.json', oldPath: null, status: 'modified', diff: '' }] };
		const el = await comparison([attempt(1), attempt(2)]);
		expect(read(columns(el)[0])).toContain('This attempt changed a lot: some diffs are left out. Review its worktree to see everything.');
	});

	test('Refresh reads the worktrees again', async () => {
		const el = await comparison([attempt(1), attempt(2)]);
		const before = w.sent('worktree_diff').length;
		diffs[`${REPO}.worktrees/a2`] = { base: BASE, head: 'e'.repeat(40), tooLarge: false, files: [changed('src/late.ts', ['arrived'])] };
		await press(button(el, 'Refresh'));
		expect(w.sent('worktree_diff').length).toBe(before + 2);
		expect(read(columns(el)[1])).toContain('src/ late.ts');
	});

	test('reads them again when an attempt’s turn ends', async () => {
		const el = await comparison([attempt(1), attempt(2, { status: 'running' })]);
		const before = w.sent('worktree_diff').length;
		diffs[`${REPO}.worktrees/a2`] = { base: BASE, head: 'e'.repeat(40), tooLarge: false, files: [changed('src/done.ts', ['finished'])] };
		agents.sessions.set([attempt(1), attempt(2, { status: 'idle', review: true })]);
		await settle();
		await settle();
		expect(w.sent('worktree_diff').length).toBeGreaterThan(before);
		expect(read(columns(el)[1])).toContain('src/ done.ts');
	});
});

describe('what can be done with an attempt', () => {
	test('Transcript opens that attempt’s session', async () => {
		const el = await comparison([attempt(1), attempt(2)]);
		await press(button(columns(el)[1], 'Transcript'));
		expect(agents.selectedId()).toBe('a2');
		expect(agents.comparing()).toBeNull();
	});

	test('Review changes switches the app to its worktree, and not while it is still working', async () => {
		const el = await comparison([attempt(1, { review: true }), attempt(2, { status: 'running' })]);
		expect(disabled(button(columns(el)[1], 'Review changes'))).toBe(true);
		await press(button(columns(el)[0], 'Review changes'));
		expect(w.sent('worktree_select').map((c) => c.args.path)).toEqual([`${REPO}.worktrees/a1`]);
		expect(repos.tab()).toBe('changes');
	});

	test('Close goes back to the session that was open', async () => {
		agents.sessions.set([attempt(1), attempt(2)]);
		agents.select('a2');
		const el = await comparison([attempt(1), attempt(2)]);
		await press(button(el, 'Close'));
		expect(agents.comparing()).toBeNull();
		expect(agents.selectedId()).toBe('a2');
	});

	test('Keep this one asks first, naming what stays and what is deleted for good', async () => {
		const el = await comparison([attempt(1), attempt(2), attempt(3, { status: 'running' })]);
		const keep = keepDialog(el);
		expect(isOpen(keep)).toBe(false);
		await press(button(columns(el)[1], 'Keep this one'));
		expect(isOpen(keep)).toBe(true);
		const said = read(keep);
		expect(said).toContain('Keep attempt 2?');
		expect(said).toContain('agent/shuffle-2 stays, with its worktree and its conversation.');
		expect(said).toContain('The other 2 attempts are removed for good: the worktrees and branches agent/shuffle, agent/shuffle-3 are deleted, along with any work in them, committed or not. Attempts still working are stopped first.');
		expect(w.sent('worktree_remove')).toEqual([]);
	});

	test('with one other attempt it speaks of one', async () => {
		const el = await comparison([attempt(1), attempt(2)]);
		await press(button(columns(el)[0], 'Keep this one'));
		expect(read(keepDialog(el))).toContain('The other attempt is removed for good: the worktree and branch agent/shuffle-2 are deleted, along with any work in them, committed or not.');
	});

	test('Cancel keeps every attempt', async () => {
		const el = await comparison([attempt(1), attempt(2)]);
		await press(button(columns(el)[0], 'Keep this one'));
		await press(button(keepDialog(el), 'Cancel'));
		expect(isOpen(keepDialog(el))).toBe(false);
		expect(agents.sessions().length).toBe(2);
		expect(w.sent('worktree_remove')).toEqual([]);
	});

	test('keeping one deletes the others’ worktrees and branches, and the one kept becomes an ordinary agent', async () => {
		const el = await comparison([attempt(1), attempt(2), attempt(3)]);
		await press(button(columns(el)[1], 'Keep this one'));
		await press(button(keepDialog(el), 'Keep attempt 2, delete the rest'));
		expect(w.sent('worktree_remove').map((c) => c.args)).toEqual([
			{ id: REPO, path: `${REPO}.worktrees/a1`, force: true, deleteBranch: true },
			{ id: REPO, path: `${REPO}.worktrees/a3`, force: true, deleteBranch: true },
		]);
		expect(agents.sessions().map((s) => s.id)).toEqual(['a2']);
		expect(agents.get('a2')).toMatchObject({ group: null, attempt: 1 });
		// The comparison is over: the pane goes to the one kept.
		expect(agents.comparing()).toBeNull();
		expect(agents.selectedId()).toBe('a2');
	});

	test('an attempt still working is stopped before its worktree goes', async () => {
		const el = await comparison([attempt(1), attempt(2, { status: 'running' })]);
		await press(button(columns(el)[0], 'Keep this one'));
		await press(button(keepDialog(el), 'Keep attempt 1, delete the rest'));
		const order = w.calls.map((c) => c.cmd).filter((c) => c === 'agent_stop' || c === 'worktree_remove');
		expect(order).toEqual(['agent_stop', 'worktree_remove']);
	});

	test('if a worktree cannot be removed, its attempt is kept and the comparison stays', async () => {
		w.on('worktree_remove', () => {
			throw { kind: 'git', message: 'worktree is locked', paths: [] };
		});
		const el = await comparison([attempt(1), attempt(2)]);
		await press(button(columns(el)[0], 'Keep this one'));
		await press(button(keepDialog(el), 'Keep attempt 1, delete the rest'));
		expect(agents.sessions().length).toBe(2);
		expect(agents.comparing()).toBe('g1');
		expect(w.toasts.some((t) => t.kind === 'error' && t.message.includes('worktree is locked'))).toBe(true);
	});
});
