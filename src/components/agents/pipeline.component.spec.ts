import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import { newPipeline, withStep, type Pipeline, type StepName, type WaitReason, type WorkKind } from '../../shared/pipeline';
import type { AgentSession, AgentsStore } from '../../services/agents.store';
import type { RepoStore } from '../../services/repo.store';
import type { Worktree } from '../../services/backend.service';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

const REPO = '/Users/demo/Source/harmony';
const TREE = `${REPO}.worktrees/queue-wraps`;

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
	const trees: Worktree[] = [
		{ path: REPO, branch: 'main', head: 'a'.repeat(40), isMain: true, active: true, changes: 0, landed: false },
		{ path: TREE, branch: 'agent/queue-wraps', head: 'c'.repeat(40), isMain: false, active: false, changes: 0, landed: false },
	];
	w.on('worktree_list', () => trees);
	// A turn that starts stays started: the demo's own would play out over seconds.
	w.on('agent_start', () => undefined);
});

function task(pipeline: Pipeline, over: Partial<AgentSession> = {}): AgentSession {
	return {
		id: 's1',
		repoId: REPO,
		title: 'Make the queue wrap when repeat is on',
		task: 'Make the queue wrap when repeat is on',
		cwd: TREE,
		branch: 'agent/queue-wraps',
		isolated: true,
		mode: 'acceptEdits',
		sessionId: 'claude-s1',
		status: 'idle',
		items: [{ kind: 'user', text: 'Make the queue wrap when repeat is on' }],
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
		name: 'Queue wraps on repeat',
		pipeline,
		...over,
	};
}

/** A pipeline at `step`, with the steps before it done. */
function at(step: StepName | 'done', kind: WorkKind = 'bug'): Pipeline {
	let p: Pipeline = { ...newPipeline(kind), step };
	const order: StepName[] = ['plan', 'code', 'review', 'test', 'fix', 'ship'];
	const upTo = step === 'done' ? order.length : order.indexOf(step);
	for (const name of order.slice(0, upTo)) {
		if (p.steps[name].state !== 'skip' && name !== 'fix') {
			p = withStep(p, name, { state: 'done' });
		}
	}
	return step === 'done' ? p : withStep(p, step, { state: 'run' });
}

function waiting(p: Pipeline, reason: WaitReason, note: string): Pipeline {
	const step = p.step === 'done' ? 'ship' : p.step;
	return withStep({ ...p, waiting: true, note, reason }, step, { state: 'you' });
}

/** The track of this task, on the page as the session pane has it. */
async function track(session: AgentSession): Promise<HTMLElement> {
	agents.sessions.set([session]);
	return mount('ms-pipeline', { sessionId: session.id });
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

/** The six pads, as "Name sub-line", and which one is picked. */
const pads = (el: HTMLElement): HTMLElement[] => all(el, 'button[aria-pressed]');
const pad = (el: HTMLElement, name: string): HTMLElement => pads(el).find((p) => read(p).startsWith(name))!;
const picked = (el: HTMLElement): string => read(pads(el).find((p) => p.getAttribute('aria-pressed') === 'true')!).split(' ')[0];
/** The picked step's detail, under the track. */
const detail = (el: HTMLElement): HTMLElement => find(el, 'section')!;
const pipeline = (): Pipeline => agents.get('s1')!.pipeline!;

describe('the track', () => {
	test('has the six steps in order, and says the kind of work and what it cost so far', async () => {
		const p = withStep(withStep(at('test'), 'plan', { cost: 0.26 }), 'review', { cost: 0.05 });
		const el = await track(task(p, { cost: 0.9 }));
		expect(pads(el).map((x) => read(x).split(' ')[0])).toEqual(['Plan', 'Code', 'Review', 'Test', 'Fix', 'Ship']);
		const shown = read(el);
		expect(shown).toContain('Bug');
		// Claude's turns are the session's total; the reviews run on their own and are added.
		expect(shown).toContain('$0.95 so far');
		expect(read(pad(el, 'Plan'))).toBe('Plan $0.26');
	});

	test('Test is free, Ship is yours, and a step going now has no price yet', async () => {
		const el = await track(task(at('code'), { status: 'running' }));
		expect(read(pad(el, 'Code'))).toBe('Code …');
		expect(read(pad(el, 'Test'))).toBe('Test free');
		expect(read(pad(el, 'Ship'))).toBe('Ship you');
	});

	test('a quick fix leaves the plan and the review out', async () => {
		const el = await track(task(at('code', 'quick'), { status: 'running' }));
		expect(read(pad(el, 'Plan'))).toBe('Plan skipped');
		expect(read(pad(el, 'Review'))).toBe('Review skipped');
		await press(pad(el, 'Review'));
		expect(read(detail(el))).toContain('Not part of a quick fix');
		expect(read(detail(el))).toContain('This kind of work leaves this step out.');
		// No model to pick for a step that does not run.
		expect(find(detail(el), 'select')).toBeNull();
	});

	test('once shipped, Ship says merged', async () => {
		const el = await track(task(withStep(at('done'), 'ship', { state: 'done', summary: 'Merged into main.' })));
		expect(read(pad(el, 'Ship'))).toBe('Ship merged');
		expect(read(detail(el))).toContain('Merged into main.');
	});

	test('the loop is said in words that follow where it is', async () => {
		const el = await track(task(waiting(at('plan'), 'approve', 'Approve the plan to start coding.')));
		expect(read(el)).toContain('After the plan: Code → Review → Test → Fix, until every test passes');
		agents.patchPipeline('s1', () => ({ ...at('fix'), fixes: 2 }));
		await settle();
		expect(read(el)).toContain('Fix 2 of 3 · after 3 it asks you');
		agents.patchPipeline('s1', () => waiting({ ...at('ship'), fixes: 2 }, 'ship', 'Every check passes after 2 fixes. Merge it or open a pull request.'));
		await settle();
		expect(read(el)).toContain('Loop finished after 2 fixes: every test passes');
	});

	test('shows the step the pipeline is at, and another one when its pad is clicked', async () => {
		const p = withStep(withStep(at('test'), 'code', { summary: 'The queue wraps to the first track.', lines: ['Committed c0ffee1 and pushed agent/queue-wraps.'] }), 'test', { summary: 'Running npm test.' });
		const el = await track(task(p));
		expect(picked(el)).toBe('Test');
		expect(read(detail(el))).toContain('Running npm test.');
		await press(pad(el, 'Code'));
		expect(picked(el)).toBe('Code');
		expect(read(detail(el))).toContain('The queue wraps to the first track.');
		expect(read(detail(el))).toContain('Committed c0ffee1 and pushed agent/queue-wraps.');
		expect(read(detail(el))).not.toContain('Running npm test.');
	});

	test('a pick holds while the pipeline stays where it is, and gives way when it moves on', async () => {
		const el = await track(task(at('review')));
		await press(pad(el, 'Plan'));
		agents.patchPipeline('s1', (p) => withStep(p, 'review', { summary: 'Still reviewing.' }));
		await settle();
		expect(picked(el)).toBe('Plan');
		agents.patchPipeline('s1', (p) => withStep({ ...p, step: 'test' }, 'test', { state: 'run', summary: 'Running the tests on this machine.' }));
		await settle();
		expect(picked(el)).toBe('Test');
		expect(read(detail(el))).toContain('Running the tests on this machine.');
	});

	test('a step not reached yet says so', async () => {
		const el = await track(task(at('code'), { status: 'running' }));
		await press(pad(el, 'Fix'));
		expect(read(detail(el))).toContain('Not reached yet.');
	});

	test('shows nothing for a session with no pipeline, and the track once it has one', async () => {
		const el = await track(task(at('plan'), { pipeline: null }));
		expect(pads(el)).toEqual([]);
		expect(read(el)).toBe('');
		agents.sessions.set([task(waiting(at('plan'), 'approve', 'Approve the plan to start coding.'))]);
		await settle();
		expect(pads(el).length).toBe(6);
		expect(button(el, 'Approve plan')).not.toBeNull();
	});
});

describe('who does a step', () => {
	test('Claude’s steps name their model: Sonnet, and Haiku for the review', async () => {
		const el = await track(task(at('code'), { status: 'running' }));
		const model = (): string => find<HTMLSelectElement>(detail(el), 'select')!.value;
		expect(read(detail(el))).toContain('commits and pushes to its branch');
		expect(model()).toBe('sonnet');
		await press(pad(el, 'Review'));
		expect(model()).toBe('haiku');
		expect(read(detail(el))).toContain('read-only');
		await press(pad(el, 'Plan'));
		expect(model()).toBe('sonnet');
		expect(read(detail(el))).toContain('writes the plan, reads only');
	});

	test('picking another model changes it for that step of this task only', async () => {
		const el = await track(task(at('code'), { status: 'running' }));
		await press(pad(el, 'Fix'));
		const select = find<HTMLSelectElement>(detail(el), 'select')!;
		expect([...select.options].map((o) => o.textContent)).toEqual(['Opus', 'Sonnet', 'Haiku']);
		select.value = 'opus';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(pipeline().models).toEqual({ fix: 'opus' });
		expect(find<HTMLSelectElement>(detail(el), 'select')!.title).toBe('Changed from sonnet for this task');
	});

	test('the tests are Studio’s and shipping is yours: neither has a model', async () => {
		const el = await track(task(at('test')));
		expect(read(detail(el))).toContain('Studio · on this machine, free');
		expect(find(detail(el), 'select')).toBeNull();
		await press(pad(el, 'Ship'));
		expect(read(detail(el))).toContain('You · merge or pull request');
		expect(find(detail(el), 'select')).toBeNull();
	});

	test('a finished task’s models can no longer be changed', async () => {
		const el = await track(task(at('done')));
		await press(pad(el, 'Code'));
		expect(find<HTMLSelectElement>(detail(el), 'select')!.disabled).toBe(true);
	});
});

describe('a plan to approve', () => {
	const planned = (over: Partial<AgentSession> = {}): AgentSession =>
		task(withStep({ ...waiting(at('plan'), 'approve', 'Approve the plan to start coding.'), plan: 'Wrap the queue in `src/player/queue.ts`.\n\n1. Make `next()` go back to the first track.\n2. Tests for wrapping.' }, 'plan', { summary: 'Planned the change in 2 steps.' }), over);

	test('shows the plan Claude wrote, and Approve plan with a hint about the box below', async () => {
		const el = await track(planned());
		const shown = read(detail(el));
		expect(shown).toContain('Planned the change in 2 steps.');
		expect(shown).toContain('Make next() go back to the first track.');
		expect(shown).toContain('Approve the plan to start coding.');
		expect(shown).toContain('Or write changes to the plan in the box below.');
		expect(all(detail(el), 'ol li').length).toBe(2);
	});

	test('the plan is text: its markup makes no elements and its file names are not links', async () => {
		const el = await track(task({ ...waiting(at('plan'), 'approve', 'Approve the plan to start coding.'), plan: '<img src=x onerror=alert(1)> Change `src/player/queue.ts:12` and [this](javascript:alert(1)).' }));
		expect(all(el, 'img, a').length).toBe(0);
		expect(read(detail(el))).toContain('<img src=x onerror=alert(1)> Change src/player/queue.ts:12 and this');
	});

	test('Approve plan marks the plan approved and starts the coding turn on the model picked for Code', async () => {
		const el = await track(planned({ pipeline: { ...planned().pipeline!, models: { code: 'opus' } } }));
		await press(button(el, 'Approve plan'));
		expect(pipeline()).toMatchObject({ step: 'code', waiting: false, note: null, steps: { plan: { state: 'done', summary: 'Approved by you.' }, code: { state: 'run' } } });
		const sent = w.sent('agent_start');
		expect(sent.length).toBe(1);
		expect(sent[0].args).toMatchObject({ key: 's1', cwd: TREE, mode: 'acceptEdits', resume: 'claude-s1', options: { model: 'opus', brief: true } });
		// The track moved on with it.
		expect(picked(el)).toBe('Code');
		expect(button(el, 'Approve plan')).toBeNull();
		expect(button(el, 'Stop')).not.toBeNull();
	});

	test('the plan’s question has its choices as buttons, which approve with that answer', async () => {
		const el = await track(planned({ brief: { title: 'Queue wraps', did: 'Planned it.', needs: 'Should repeat-one restart the same track?', choices: ['Yes, restart it', 'No, wrap as well'] } }));
		expect(button(el, 'No, wrap as well')).not.toBeNull();
		await press(button(el, 'Yes, restart it'));
		expect(pipeline().steps.plan).toMatchObject({ state: 'done', summary: 'Approved by you, with: Yes, restart it' });
		expect(String(w.sent('agent_start')[0].args.prompt)).toContain('Yes, restart it');
	});

	test('choices belong to the plan: they are not offered once it waits for something else', async () => {
		const el = await track(task(waiting(at('ship'), 'ship', 'Every check passes. Merge it or open a pull request.'), { brief: { title: 'Queue wraps', did: 'Done.', needs: 'Old question?', choices: ['Yes, restart it'] } }));
		expect(button(el, 'Yes, restart it')).toBeNull();
	});
});

describe('ready to ship', () => {
	const ready = (): AgentSession => task(waiting(at('ship'), 'ship', 'Every check passes. Merge it or open a pull request.'));

	test('offers to merge, to open a pull request and to see the changes', async () => {
		const el = await track(ready());
		expect(picked(el)).toBe('Ship');
		expect(read(detail(el))).toContain('Every check passes. Merge it or open a pull request.');
		expect(['Merge…', 'Open a pull request…', 'See the changes'].map((label) => !!button(el, label))).toEqual([true, true, true]);
		expect(button(el, 'Approve plan')).toBeNull();
	});

	test('Merge… and Open a pull request… ask the session pane, which owns those dialogs; nothing is merged or published by the click', async () => {
		const el = await track(ready());
		const asked: string[] = [];
		el.addEventListener('merge', () => asked.push('merge'));
		el.addEventListener('pr', () => asked.push('pr'));
		await press(button(el, 'Merge…'));
		await press(button(el, 'Open a pull request…'));
		expect(asked).toEqual(['merge', 'pr']);
		expect(w.calls.map((c) => c.cmd).filter((c) => /^(merge_branch|pr_create|push)$/.test(c))).toEqual([]);
		expect(pipeline().step).toBe('ship');
	});

	test('See the changes goes to its worktree on the Changes tab', async () => {
		const el = await track(ready());
		await press(button(el, 'See the changes'));
		expect(w.sent('worktree_select').map((c) => c.args.path)).toEqual([TREE]);
		expect(repos.tab()).toBe('changes');
	});
});

describe('at the fix limit', () => {
	const stuck = (): AgentSession => {
		const failing = { ok: false, summary: '41 passed, 1 failed', failures: ['queue wraps on repeat'], commands: ['npm test'], output: 'AssertionError: <b>expected</b> 1 to be 0', none: false };
		const p = withStep(withStep({ ...at('fix'), fixes: 3, tests: failing }, 'test', { state: 'warn', summary: '41 passed, 1 failed', lines: ['queue wraps on repeat'] }), 'fix', { summary: 'Stopped after 3 fixes. 41 passed, 1 failed.', lines: ['queue wraps on repeat'] });
		return task(waiting(p, 'limit', 'Stopped after 3 fixes: 41 passed, 1 failed.'));
	};

	test('it stops and asks: one more round, take over, or mark done', async () => {
		const el = await track(stuck());
		expect(picked(el)).toBe('Fix');
		expect(read(detail(el))).toContain('Stopped after 3 fixes: 41 passed, 1 failed.');
		expect(read(detail(el))).toContain('queue wraps on repeat');
		expect(['One more round', 'Take over', 'Mark done'].map((label) => !!button(el, label))).toEqual([true, true, true]);
		expect(read(el)).toContain('Fix 3 of 3 · after 3 it asks you');
	});

	test('One more round allows a fourth fix and starts it', async () => {
		const el = await track(stuck());
		await press(button(el, 'One more round'));
		expect(pipeline()).toMatchObject({ step: 'fix', fixes: 4, allowedFixes: 4, waiting: false, steps: { fix: { state: 'run' } } });
		expect(w.sent('agent_start').length).toBe(1);
		expect(read(el)).toContain('Fix 4 of 4 · after 4 it asks you');
	});

	test('Take over goes to its worktree on the Changes tab, and it still waits there', async () => {
		const el = await track(stuck());
		await press(button(el, 'Take over'));
		expect(w.sent('worktree_select').map((c) => c.args.path)).toEqual([TREE]);
		expect(repos.tab()).toBe('changes');
		expect(pipeline().waiting).toBe(true);
	});

	test('Mark done ends it where it is: nothing is deleted', async () => {
		const el = await track(stuck());
		await press(button(el, 'Mark done'));
		expect(pipeline()).toMatchObject({ step: 'done', waiting: false, note: null });
		expect(w.sent('pipeline_clean')).toEqual([]);
		expect(button(el, 'One more round')).toBeNull();
		// With the task done, giving it up is no longer offered either.
		expect(button(el, 'Discard task…')).toBeNull();
	});

	test('what the failing tests printed is there to unfold, as text', async () => {
		const el = await track(stuck());
		await press(pad(el, 'Test'));
		const output = find(detail(el), 'details')!;
		expect(read(find(output, 'summary')!)).toBe('What the tests printed');
		expect(find(output, 'pre')!.textContent).toBe('AssertionError: <b>expected</b> 1 to be 0');
		expect(find(output, 'b')).toBeNull();
	});
});

describe('stopped, failed or going', () => {
	test('after a stop it offers to carry on or take over, and Carry on runs the step again', async () => {
		const el = await track(task(waiting(at('test'), 'halted', 'Stopped by you. Its branch keeps everything committed so far.')));
		expect(button(el, 'Take over')).not.toBeNull();
		await press(button(el, 'Carry on'));
		expect(w.sent('pipeline_tests').map((c) => c.args.cwd)).toEqual([TREE]);
	});

	test('a step that was going when the app closed waits for Carry on', async () => {
		const el = await track(task(waiting(at('code'), 'halted', 'Melodic Studio closed while this step was going. Carry on to run it again.')));
		expect(read(detail(el))).toContain('Melodic Studio closed while this step was going. Carry on to run it again.');
		await press(button(el, 'Carry on'));
		expect(w.sent('agent_start').length).toBe(1);
		expect(pipeline()).toMatchObject({ step: 'code', waiting: false });
	});

	test('while Claude’s turn runs, Stop ends the turn', async () => {
		const el = await track(task(at('code'), { status: 'running' }));
		expect(button(el, 'Carry on')).toBeNull();
		await press(button(el, 'Stop'));
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual(['s1']);
	});

	test('while Studio runs the tests, Stop makes it wait and says the branch keeps what was committed', async () => {
		const el = await track(task(at('test')));
		await press(button(el, 'Stop'));
		expect(w.sent('agent_stop')).toEqual([]);
		expect(pipeline()).toMatchObject({ step: 'test', waiting: true, steps: { test: { state: 'you' } } });
		expect(read(detail(el))).toContain('Stopped by you. Its branch keeps everything committed so far.');
		expect(button(el, 'Carry on')).not.toBeNull();
		expect(button(el, 'Stop')).toBeNull();
	});
});

describe('giving a task up', () => {
	test('asks first, naming the branch that would go, here and on the remote', async () => {
		const el = await track(task(waiting(at('plan'), 'approve', 'Approve the plan to start coding.')));
		expect(button(el, 'Discard')).toBeNull();
		await press(button(el, 'Discard task…'));
		expect(read(detail(el))).toContain('Stop it and delete its worktree and the branch agent/queue-wraps, here and on the remote?');
		expect(read(detail(el))).toContain('work that is not merged is lost');
		expect(w.sent('pipeline_clean')).toEqual([]);
	});

	test('Keep it changes nothing', async () => {
		const el = await track(task(waiting(at('plan'), 'approve', 'Approve the plan to start coding.')));
		await press(button(el, 'Discard task…'));
		await press(button(el, 'Keep it'));
		expect(w.sent('pipeline_clean')).toEqual([]);
		expect(button(el, 'Discard task…')).not.toBeNull();
		expect(pipeline().waiting).toBe(true);
	});

	test('Discard removes its worktree and branch, and the session stays as a record', async () => {
		const el = await track(task(waiting(at('ship'), 'ship', 'Every check passes. Merge it or open a pull request.')));
		await press(button(el, 'Discard task…'));
		await press(button(el, 'Discard'));
		expect(w.sent('pipeline_clean').map((c) => c.args)).toEqual([{ id: REPO, cwd: TREE, branch: 'agent/queue-wraps' }]);
		expect(w.sent('merge_branch')).toEqual([]);
		expect(agents.get('s1')).not.toBeNull();
		expect(pipeline()).toMatchObject({ step: 'done', waiting: false, steps: { ship: { state: 'skip', summary: 'Discarded: its worktree and branch were deleted.' } } });
		expect(read(detail(el))).toContain('Discarded: its worktree and branch were deleted.');
	});

	test('a task that could not be cleaned up is not called discarded', async () => {
		w.on('pipeline_clean', () => {
			throw { kind: 'git', message: 'worktree is locked', paths: [] };
		});
		const el = await track(task(waiting(at('ship'), 'ship', 'Every check passes. Merge it or open a pull request.')));
		await press(button(el, 'Discard task…'));
		await press(button(el, 'Discard'));
		expect(pipeline()).toMatchObject({ step: 'ship', waiting: true });
		expect(w.toasts.some((t) => t.kind === 'error' && t.title === 'Cleaning up failed' && t.message.includes('worktree is locked'))).toBe(true);
	});
});
