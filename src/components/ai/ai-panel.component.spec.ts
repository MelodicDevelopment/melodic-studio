import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { AgentSession, AgentsStore } from '../../services/agents.store';
import type { AiFeaturesStore, ExplainState, ReviewState } from '../../services/ai-features.store';
import type { Finding } from '../../services/ai-prompts';
import type { RepoStore } from '../../services/repo.store';

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

const QUEUE = { path: 'src/player/queue.ts', oldPath: null, status: 'modified' as const };

function explanation(over: Partial<ExplainState> = {}): ExplainState {
	return { target: { kind: 'file', file: QUEUE }, title: 'queue.ts', detail: 'src/player/queue.ts', state: 'done', text: '## What changed\n- `next()` takes a **repeat** flag.', error: '', ...over };
}

const BUG: Finding = { file: 'src/player/queue.ts', line: 17, severity: 'bug', title: 'next() no longer advances past the last track', detail: 'previous() relied on that. Keep the old `cursor` position.' };
const RISK: Finding = { file: 'src/player/queue.ts', line: 21, severity: 'risk', title: 'Repeat on an empty queue leaves the cursor at 0', detail: '' };
const NIT: Finding = { file: 'src/player/repeat.ts', line: null, severity: 'nit', title: 'The mode names could be an enum', detail: '' };

function review(over: Partial<ReviewState> = {}): ReviewState {
	return {
		state: 'done',
		request: { scope: 'push' },
		range: { scope: 'push', truncated: false, base: 'b'.repeat(40), head: 'c'.repeat(40), against: 'origin/main', commits: [{ hash: 'c'.repeat(40), summary: 'Wrap the queue' }, { hash: 'd'.repeat(40), summary: 'Repeat modes' }], files: [QUEUE, { path: 'src/player/repeat.ts', oldPath: null, status: 'added' }] },
		summary: 'The wrap-around works, but next() changed what happens at the end of the queue.',
		findings: [BUG, RISK, NIT],
		error: '',
		raw: '',
		progress: '',
		...over,
	};
}

/** The panel beside the diff, with this explanation and/or review in it. */
async function panel(ex: ExplainState | null, rv: ReviewState | null = null): Promise<HTMLElement> {
	ai.explanation.set(ex);
	ai.reviewed.set(rv);
	ai.panelTab.set(ex ? 'explain' : 'review');
	return mount('ms-ai-panel');
}

/** A finding's row, by its title. */
const finding = (el: HTMLElement, f: Finding): HTMLElement => all(el, '[title="Show this in the diff"]').find((r) => read(r).includes(f.title))!;
const tabs = (el: HTMLElement): HTMLElement[] => all(el, 'button').filter((b) => /^(Explanation|Review)( \d+)?$/.test(read(b)));

describe('an explanation', () => {
	test('names the file it is about and shows what Claude wrote, as Markdown', async () => {
		const el = await panel(explanation());
		expect(read(el)).toBe('Explanation queue.ts src/player/queue.ts What changed • next() takes a repeat flag. Explain again Copy');
		expect(find(el, 'code')!.textContent).toBe('next()');
		expect(find(el, 'strong')!.textContent).toBe('repeat');
	});

	test('what Claude wrote is never markup', async () => {
		const el = await panel(explanation({ text: '<img src=x onerror=alert(1)> and <script>alert(2)</script> and [here](javascript:alert(3))', title: '<b>queue.ts</b>' }));
		expect(all(el, 'img, script, a, b').length).toBe(0);
		expect(read(el)).toContain('<img src=x onerror=alert(1)> and <script>alert(2)</script> and here');
		expect(read(el)).toContain('<b>queue.ts</b>');
	});

	test('says what it is waiting for while the diff is read and while Claude reads it', async () => {
		const el = await panel(explanation({ state: 'collecting', text: '' }));
		expect(read(el)).toContain('Reading the diff…');
		ai.explanation.set(explanation({ state: 'running', text: '' }));
		await settle();
		expect(read(el)).toContain('Claude is reading the change…');
		ai.explanation.set(explanation({ state: 'running', text: 'So far so good' }));
		await settle();
		expect(read(el)).toContain('So far so good');
		expect(read(el)).toContain('Still writing…');
		expect(button(el, 'Explain again')).toBeNull();
		expect(button(el, 'Copy')).toBeNull();
	});

	test('Stop keeps what was written and says it was stopped', async () => {
		const el = await panel(explanation({ state: 'running', text: 'Half an explanation' }));
		await press(button(el, 'Stop'));
		expect(ai.explanation()).toMatchObject({ state: 'stopped', text: 'Half an explanation' });
		expect(read(el)).toContain('Half an explanation');
		expect(read(el)).toContain('Stopped before the explanation was finished.');
		expect(button(el, 'Explain again')).not.toBeNull();
	});

	test('an error is said in the panel', async () => {
		const el = await panel(explanation({ state: 'error', text: '', error: 'This file has no text changes to explain.' }));
		expect(read(el)).toContain('This file has no text changes to explain.');
		expect(button(el, 'Copy')).toBeNull();
	});

	test('Explain again asks about the same file, sending Claude its diff and no tools', async () => {
		const el = await panel(explanation());
		await press(button(el, 'Explain again'));
		expect(w.sent('ai_selected_diff').map((c) => c.args.files)).toEqual([[QUEUE]]);
		const asked = w.sent('agent_start');
		expect(asked.length).toBe(1);
		expect(asked[0].args.options).toMatchObject({ quick: true, tools: [] });
		expect(ai.explanation()).toMatchObject({ state: 'running', title: 'queue.ts' });
	});

	test('Copy puts the explanation on the clipboard and says so', async () => {
		const copied: string[] = [];
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (text: string) => void copied.push(text) } });
		try {
			const el = await panel(explanation());
			await press(button(el, 'Copy'));
			expect(copied).toEqual(['## What changed\n- `next()` takes a **repeat** flag.']);
			expect(w.toasts.map((t) => t.title)).toEqual(['Copied']);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test('says so when it could not be copied', async () => {
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
		try {
			const el = await panel(explanation());
			await press(button(el, 'Copy'));
			expect(w.toasts.map((t) => [t.kind, t.title])).toEqual([['error', 'Could not copy']]);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test('Close puts it away', async () => {
		const el = await panel(explanation());
		await click(find(el, 'button[title="Close"]'));
		expect(ai.explanation()).toBeNull();
		expect(ai.panelOpen()).toBe(false);
	});
});

describe('a review', () => {
	test('says what was reviewed, sums it up and counts the findings by kind', async () => {
		const el = await panel(null, review());
		const shown = read(el);
		expect(shown).toContain('Review Before you push 2 commits and 2 changed files, compared with origin/main');
		expect(shown).toContain('The wrap-around works, but next() changed what happens at the end of the queue.');
		expect(shown).toContain('1 bug 1 risk 1 nit');
	});

	test('lists the findings under their files, each with its kind, its line and what to do about it', async () => {
		const el = await panel(null, review());
		expect(read(finding(el, BUG))).toBe('Bug next() no longer advances past the last track previous() relied on that. Keep the old cursor position. Line 17 Ask Claude to fix');
		expect(read(finding(el, RISK))).toBe('Risk Repeat on an empty queue leaves the cursor at 0 Line 21 Ask Claude to fix');
		expect(read(finding(el, NIT))).toBe('Nit The mode names could be an enum Whole file Ask Claude to fix');
		const order = read(el);
		expect(order.indexOf('src/player/ queue.ts')).toBeLessThan(order.indexOf(BUG.title));
		expect(order.indexOf('src/player/ repeat.ts')).toBeGreaterThan(order.indexOf(RISK.title));
		expect(order.indexOf('src/player/ repeat.ts')).toBeLessThan(order.indexOf(NIT.title));
	});

	test('a finding’s words are text, not markup', async () => {
		const nasty: Finding = { file: 'src/a.ts', line: 1, severity: 'bug', title: '<img src=x onerror=alert(1)>', detail: '<script>alert(2)</script> **bold**' };
		const el = await panel(null, review({ findings: [nasty], summary: '<b>summary</b>' }));
		expect(all(el, 'img, script, b').length).toBe(0);
		expect(read(el)).toContain('<img src=x onerror=alert(1)>');
		expect(read(el)).toContain('<script>alert(2)</script> bold');
		expect(read(el)).toContain('<b>summary</b>');
	});

	test('a click on a finding shows it in the diff of what was reviewed', async () => {
		const el = await panel(null, review());
		await click(finding(el, BUG));
		expect(w.sent('ai_range_file_diff').map((c) => c.args)).toEqual([{ id: REPO, base: 'b'.repeat(40), head: 'c'.repeat(40), path: 'src/player/queue.ts' }]);
		expect(ai.reviewView()).toMatchObject({ path: 'src/player/queue.ts', line: 17 });
		expect(ai.reviewView()!.diff).not.toBeNull();
	});

	test('with nothing found it says so, in words that fit what was reviewed', async () => {
		const el = await panel(null, review({ findings: [], summary: '' }));
		expect(read(el)).toContain('No problems found Claude found nothing in these commits that needs fixing before you push.');
		ai.reviewed.set(review({ findings: [], summary: '', request: { scope: 'work' } }));
		await settle();
		expect(read(el)).toContain('No problems found Claude found nothing in these changes that needs fixing.');
		expect(button(el, /^Ask Claude to fix/)).toBeNull();
	});

	test('while it runs it says what it is doing, shows what Claude last said, and can be stopped', async () => {
		const el = await panel(null, review({ state: 'collecting', range: null, findings: [], summary: '' }));
		expect(read(el)).toContain('Before you push Everything a push would send');
		expect(read(el)).toContain('Reading what would be pushed…');
		ai.reviewed.set(review({ state: 'running', findings: [], summary: '', progress: 'Looking at how previous() uses the cursor.' }));
		await settle();
		expect(read(el)).toContain('Claude is reviewing the changes. It may open files around them, so this can take a minute or two.');
		expect(read(el)).toContain('Looking at how previous() uses the cursor.');
		expect(button(el, 'Review again')).toBeNull();
		await press(button(el, 'Stop'));
		expect(ai.reviewed()!.state).toBe('stopped');
		expect(read(el)).toContain('The review was stopped. Nothing was reported.');
	});

	test('an answer that could not be read is shown as it came, with the error', async () => {
		const el = await panel(null, review({ state: 'error', findings: [], summary: '', error: 'Claude answered, but not with a list of findings. Its answer is below.', raw: 'I think it is <b>fine</b>.' }));
		expect(read(el)).toContain('Claude answered, but not with a list of findings. Its answer is below.');
		expect(read(el)).toContain('I think it is <b>fine</b>.');
		expect(find(el, 'b')).toBeNull();
	});

	test('says when the diff was too long to review whole', async () => {
		const el = await panel(null, review({ range: { ...review().range!, truncated: true } }));
		expect(read(el)).toContain('Some of the diff was too long to send whole, so large files were only partly reviewed.');
	});

	test('Review again asks for the same review', async () => {
		const el = await panel(null, review({ request: { scope: 'branch' } }));
		await press(button(el, 'Review again'));
		expect(w.sent('ai_review_diff').map((c) => c.args)).toEqual([{ id: REPO, scope: 'branch', base: null }]);
	});

	test('Close puts it away, with the finding that was open in the main pane', async () => {
		const el = await panel(null, review());
		await click(finding(el, BUG));
		await click(find(el, 'button[title="Close"]'));
		expect(ai.reviewed()).toBeNull();
		expect(ai.reviewView()).toBeNull();
	});
});

describe('handing findings to an agent', () => {
	test('in the main checkout, "Ask Claude to fix" starts an agent on that finding there, and goes to the Agents tab', async () => {
		const el = await panel(null, review());
		const fix = button(finding(el, BUG), 'Ask Claude to fix')!;
		expect(fix.title).toBe('Starts an agent on this in the checkout on screen');
		await press(fix);
		const sent = w.sent('agent_start');
		expect(sent.length).toBe(1);
		expect(sent[0].args.cwd).toBe(REPO);
		expect(String(sent[0].args.prompt)).toContain(BUG.title);
		expect(String(sent[0].args.prompt)).not.toContain(RISK.title);
		expect(w.sent('worktree_add')).toEqual([]);
		expect(repos.tab()).toBe('agents');
		// The click was the button's own: the finding was not also opened in the diff.
		expect(ai.reviewView()).toBeNull();
	});

	test('a finding that was handed over says so and cannot be sent twice', async () => {
		const el = await panel(null, review());
		await press(button(finding(el, BUG), 'Ask Claude to fix'));
		const sent = button(finding(el, BUG), 'Sent to Claude')!;
		expect(disabled(sent)).toBe(true);
		expect(disabled(button(finding(el, RISK), 'Ask Claude to fix'))).toBe(false);
	});

	test('with several left, one button hands over all that were not sent yet', async () => {
		const el = await panel(null, review());
		expect(button(el, 'Ask Claude to fix all 3')).not.toBeNull();
		await press(button(finding(el, NIT), 'Ask Claude to fix'));
		agents.sessions.set(agents.sessions().map((s) => ({ ...s, status: 'idle' as const })));
		repos.setTab('changes');
		await settle();
		await press(button(el, 'Ask Claude to fix all 2'));
		const prompt = String(w.sent('agent_start')[1].args.prompt);
		expect(prompt).toContain(BUG.title);
		expect(prompt).toContain(RISK.title);
		expect(prompt).not.toContain(NIT.title);
		expect(button(el, /^Ask Claude to fix all/)).toBeNull();
	});

	test('in an agent’s worktree the findings go to that agent as its next turn', async () => {
		const owner: AgentSession = session({ review: true });
		agents.sessions.set([owner]);
		await agents.view(owner.cwd, 'changes');
		const el = await panel(null, review({ request: { scope: 'work', base: owner.base!, agent: true } }));
		const fix = button(finding(el, BUG), 'Ask Claude to fix')!;
		expect(fix.title).toBe('Sends this to the agent working in this worktree, as its next turn');
		await press(fix);
		const sent = w.sent('agent_start');
		expect(sent.length).toBe(1);
		expect(sent[0].args).toMatchObject({ key: 's1', cwd: owner.cwd, resume: 'claude-s1' });
		// Its transcript says what was asked in a line, not the whole prompt.
		const said = agents.get('s1')!.items.at(-1)!.text;
		expect(said).toContain('Asked Claude to fix what the review found:');
		expect(said).toContain('src/player/queue.ts:17 next() no longer advances past the last track');
		expect(agents.sessions().length).toBe(1);
		expect(agents.selectedId()).toBe('s1');
	});

	test('not while that agent is on a turn', async () => {
		const owner: AgentSession = session({ status: 'running' });
		agents.sessions.set([owner]);
		await agents.view(owner.cwd, 'changes');
		const el = await panel(null, review());
		const fix = button(finding(el, BUG), 'Ask Claude to fix')!;
		expect(disabled(fix)).toBe(true);
		expect(fix.title).toBe('The agent in this worktree is working. Ask when its turn has ended.');
	});
});

describe('with both', () => {
	test('there are two tabs, the review’s with its number of findings', async () => {
		const el = await panel(explanation(), review());
		expect(tabs(el).map((t) => read(t))).toEqual(['Explanation', 'Review 3']);
		expect(read(el)).toContain('What changed');
		expect(read(el)).not.toContain(BUG.title);
		await click(tabs(el)[1]);
		expect(read(el)).toContain(BUG.title);
		expect(read(el)).not.toContain('What changed');
	});

	test('closing the one on screen leaves the other', async () => {
		const el = await panel(explanation(), review());
		await click(find(el, 'button[title="Close"]'));
		expect(ai.explanation()).toBeNull();
		expect(ai.reviewed()).not.toBeNull();
		expect(tabs(el)).toEqual([]);
		expect(read(el)).toContain(BUG.title);
	});
});

describe('its width', () => {
	const drag = (el: HTMLElement, from: number, to: number): void => {
		find(el, '.grip')!.dispatchEvent(new MouseEvent('pointerdown', { clientX: from, bubbles: true, cancelable: true }));
		window.dispatchEvent(new MouseEvent('pointermove', { clientX: to }));
		window.dispatchEvent(new MouseEvent('pointerup', { clientX: to }));
	};

	test('starts at 380 px and follows a drag of its left edge, which is remembered', async () => {
		const el = await panel(explanation());
		expect(el.style.width).toBe('380px');
		drag(el, 500, 400);
		expect(el.style.width).toBe('480px');
		expect(localStorage.getItem('studio.ai-panel')).toBe('480');
		el.remove();
		const again = await mount('ms-ai-panel');
		expect(again.style.width).toBe('480px');
	});

	test('stays between 280 and 640 px however far it is dragged', async () => {
		const el = await panel(explanation());
		drag(el, 500, 2000);
		expect(el.style.width).toBe('280px');
		drag(el, 500, -2000);
		expect(el.style.width).toBe('640px');
	});
});
