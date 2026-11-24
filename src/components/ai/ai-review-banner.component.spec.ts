import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { AgentSession, AgentsStore } from '../../services/agents.store';
import type { AiFeaturesStore } from '../../services/ai-features.store';
import type { RepoStore } from '../../services/repo.store';
import type { RepoStatus } from '../../services/backend.service';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
let ai: AiFeaturesStore;

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
	repos.setTab('changes');
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	await agents.init();
	ai = w.get((await import('../../services/ai-features.store')).AiFeaturesStore);
	ai.init();
	await settle();
	// The review's question to Claude stays unanswered: it is "reviewing" until a test says otherwise.
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

/** The checkout as git reports it, with these differences. */
function status(over: Partial<RepoStatus>): void {
	repos.status.set({ ...repos.status()!, branch: 'feature/repeat-mode', detached: false, hasCommits: true, head: 'c'.repeat(40), upstream: 'origin/feature/repeat-mode', ahead: 0, defaultBranch: 'main', files: [], undo: null, ...over });
}

const FILES = [
	{ path: 'src/a.ts', oldPath: null, status: 'modified' as const },
	{ path: 'src/b.ts', oldPath: null, status: 'untracked' as const },
	{ path: 'src/c.ts', oldPath: null, status: 'modified' as const },
];

const offers = (el: HTMLElement): string[] => all(el, 'ml-button').map((b) => read(b));

describe('the review strip', () => {
	test('has one button for each thing Claude can review here: what is uncommitted, what a push would send, the whole branch', async () => {
		status({ files: FILES, ahead: 2 });
		const el = await mount('ms-ai-review-banner');
		expect(read(el)).toBe('Review 3 uncommitted 2 to push vs main');
	});

	test('takes no room when there is nothing to review, and comes back when there is', async () => {
		status({ branch: 'main' });
		const el = await mount('ms-ai-review-banner');
		expect(read(el)).toBe('');
		expect(all(el, 'ml-button')).toEqual([]);
		status({ branch: 'main', files: FILES.slice(0, 1) });
		await settle();
		expect(offers(el)).toEqual(['1 uncommitted']);
	});

	test('after a push the branch can still be reviewed against the default branch', async () => {
		status({ ahead: 0, files: [] });
		const el = await mount('ms-ai-review-banner');
		expect(offers(el)).toEqual(['vs main']);
	});

	test('on the default branch itself there is no "vs"', async () => {
		status({ branch: 'main', upstream: 'origin/main', ahead: 1 });
		const el = await mount('ms-ai-review-banner');
		expect(offers(el)).toEqual(['1 to push']);
	});

	test('each button starts that review, of this checkout, and nothing is posted anywhere', async () => {
		status({ files: FILES, ahead: 2 });
		const el = await mount('ms-ai-review-banner');
		await press(button(el, '2 to push'));
		expect(w.sent('ai_review_diff').map((c) => c.args)).toEqual([{ id: REPO, scope: 'push', base: null }]);
		expect(ai.reviewed()).toMatchObject({ state: 'running', request: { scope: 'push' } });
		expect(w.calls.map((c) => c.cmd).filter((c) => /^(push|pr_|host_)/.test(c))).toEqual([]);
	});

	test('the one being reviewed says so, and the others do not', async () => {
		status({ files: FILES, ahead: 2 });
		const el = await mount('ms-ai-review-banner');
		await press(button(el, '3 uncommitted'));
		// (Its spinner reads "Loading" to a screen reader.)
		expect(offers(el)).toEqual(['Loading Reviewing…', '2 to push', 'vs main']);
		expect(w.sent('ai_review_diff').map((c) => c.args.scope)).toEqual(['work']);
	});

	test('a second review is not started over one that runs', async () => {
		status({ files: FILES, ahead: 2 });
		const el = await mount('ms-ai-review-banner');
		await press(button(el, '3 uncommitted'));
		await press(button(el, 'vs main'));
		expect(w.sent('ai_review_diff').length).toBe(1);
		expect(w.toasts.map((t) => t.title)).toEqual(['A review is already running']);
	});

	test('in an agent’s worktree one button stands for all of its work, committed or not', async () => {
		const owner: AgentSession = session({ review: true });
		agents.sessions.set([owner]);
		await agents.view(owner.cwd, 'changes');
		status({ branch: 'agent/s1', upstream: null, files: FILES, undo: { hash: 'c'.repeat(40), summary: 'x', description: '' } });
		const el = await mount('ms-ai-review-banner');
		expect(offers(el)).toEqual(["Agent's work"]);
		await press(button(el, "Agent's work"));
		expect(w.sent('ai_review_diff').map((c) => c.args)).toEqual([{ id: REPO, scope: 'work', base: owner.base }]);
	});

	test('without Claude Code the buttons are off and say what to install', async () => {
		status({ files: FILES });
		const el = await mount('ms-ai-review-banner');
		ai.cli.set(null);
		await settle();
		const first = find(el, 'ml-button')!;
		expect(disabled(first)).toBe(true);
		expect(first.title).toContain('Claude Code (the `claude` command) was not found on this computer.');
	});
});
