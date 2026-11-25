import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, world, type Call, type World } from '../test/world';
import type { AgentSession, AgentsStore } from './agents.store';
import type { PipelineStore } from './pipeline.store';
import type { RepoStore } from './repo.store';
import type { Pipeline, WorkKind } from '../shared/pipeline';

// The language servers reach for Monaco as soon as they exist, and the real one needs workers and a layout
// this page does not have. Nothing here is about the editor, so it never finishes loading.
vi.mock('../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: () => Promise.resolve(), releaseMonacoStyles: () => undefined }));

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
let pipes: PipelineStore;

const BRANCH = 'agent/queue-wrap';
const TASK = 'Make the queue wrap when repeat is on';
/** What the worktree holds since the task started, as the native side hands it to the review. */
const CHANGED = { scope: 'work', text: 'diff --git a/src/queue.ts b/src/queue.ts\n--- a/src/queue.ts\n+++ b/src/queue.ts\n@@ -1 +1 @@\n-old\n+new\n', truncated: false, base: 'b'.repeat(40), head: '', against: 'bbbbbbb', commits: [], files: [{ path: 'src/queue.ts', oldPath: null, status: 'modified' }] };
const TARGET = { id: 'web:test', name: 'test', group: 'web · package.json', cwd: '', argv: ['npm', 'test'], kind: 'test', runtime: 'node', source: 'package.json' };
const PASSED = { ok: true, code: 0, output: ' Tests  12 passed (12)\n', command: 'npm test', millis: 5, timedOut: false, stopped: false };
const FAILED = { ok: false, code: 1, output: ' × src/queue.test.ts > wraps at the end 4ms\n Tests  1 failed | 11 passed (12)\n', command: 'npm test', millis: 5, timedOut: false, stopped: false };
const BUG = { file: 'src/queue.ts', line: 1, severity: 'bug', title: 'The cursor runs past the end', detail: 'next() never resets it.' };
const RISK = { file: 'src/queue.ts', line: 1, severity: 'risk', title: 'An empty queue may misbehave', detail: '' };
const NIT = { file: 'src/queue.ts', line: 1, severity: 'nit', title: 'A name could be clearer', detail: '' };

// ---- local helpers: Claude and the native side, played by the test ---------------------------------

/** Promises and timers that are due get their turn. The clock is ours (see beforeEach). */
async function tick(rounds = 4): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await vi.advanceTimersByTimeAsync(1);
	}
}

const quick = (c: Call): boolean => !!(c.args.options as { quick?: boolean } | null)?.quick;
/** Turns of the task's own Claude session that were started. */
const turns = (): Call[] => w.sent('agent_start').filter((c) => !quick(c));
/** One-shot questions (the review). */
const asks = (): Call[] => w.sent('agent_start').filter(quick);
const prompt = (c: Call | undefined): string => String(c?.args.prompt ?? '');
const options = (c: Call | undefined): Record<string, unknown> => (c?.args.options ?? {}) as Record<string, unknown>;
const session = (id: string): AgentSession => agents.get(id)!;
const pipe = (id: string): Pipeline => session(id).pipeline!;

function brief(b: { title?: string; did?: string; needs?: string }): string {
	return ['```brief', `title: ${b.title ?? 'Queue wraps on repeat'}`, `did: ${b.did ?? 'Did the work.'}`, `needs: ${b.needs ?? 'nothing'}`, '```'].join('\n');
}

/** Claude's turn ends: its reply with a brief, the session's running total, then the process is gone. */
async function endTurn(id: string, o: { text?: string; did?: string; needs?: string; total?: number; ok?: boolean; error?: string } = {}): Promise<void> {
	if (o.ok !== false) {
		w.emit('agent-event', { key: id, event: { type: 'assistant', message: { content: [{ type: 'text', text: `${o.text ?? 'Here is what I did.'}\n\n${brief(o)}` }] } } });
	}
	w.emit('agent-event', { key: id, event: { type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session-1', total_cost_usd: o.total ?? 0 } });
	w.emit('agent-done', { key: id, ok: o.ok ?? true, error: o.error ?? '' });
	await tick();
}

/** The review's one-shot question is answered with these findings. */
async function answerReview(findings: Record<string, unknown>[], o: { summary?: string; cost?: number; raw?: string } = {}): Promise<void> {
	const key = asks().at(-1)!.args.key;
	w.emit('agent-event', { key, event: { type: 'result', subtype: 'success', is_error: false, result: o.raw ?? JSON.stringify({ summary: o.summary ?? 'Looked at it.', findings }), total_cost_usd: o.cost ?? 0 } });
	w.emit('agent-done', { key, ok: true, error: '' });
	await tick();
}

async function begin(kind: WorkKind, extra: { models?: Record<string, string> } = {}): Promise<string> {
	expect(await pipes.start({ task: TASK, kind, branch: BRANCH, ...extra })).toBe(true);
	await tick();
	return agents.selectedId()!;
}

/** A bug task whose plan was approved and whose code turn is going. */
async function coding(): Promise<string> {
	const id = await begin('bug');
	await endTurn(id, { did: 'Planned it in two steps.', needs: 'Approve the plan' });
	await pipes.approve(id);
	await tick();
	return id;
}

/** A bug task whose code turn has ended: committed, and its first review is waiting for an answer. */
async function reviewing(): Promise<string> {
	const id = await coding();
	await endTurn(id, { did: 'The queue wraps to the first track.' });
	return id;
}

/** The session with a pipeline that an earlier run of the app saved last. */
function saved(id: string): string {
	return String(w.sent('agent_session_save').filter((c) => c.args.id === id && c.args.session).at(-1)!.args.session);
}

async function load(): Promise<void> {
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	agents = w.get((await import('./agents.store')).AgentsStore);
	await agents.init();
	// The language servers' check of a change is another store's business, and slow.
	agents.setChecks(false);
	pipes = w.get((await import('./pipeline.store')).PipelineStore);
	pipes.init();
}

/** Claude says nothing by itself, and the native side's steps succeed, unless a test says otherwise. */
function quiet(): void {
	w.on('agent_start', () => undefined);
	w.on('agent_stop', () => undefined);
	w.on('pipeline_commit', () => ({ committed: true, head: 'abc1234def5678', pushed: true, pushError: null }));
	w.on('pipeline_review_diff', () => CHANGED);
	w.on('pipeline_tests', () => [TARGET]);
	w.on('pipeline_test_run', () => PASSED);
}

beforeEach(async () => {
	vi.useFakeTimers();
	w = await world();
	quiet();
	await load();
});

afterEach(() => {
	vi.useRealTimers();
});

/** Claude's process ends without a word: what a stop, or a crash, looks like from here. */
async function gone(id: string, error = ''): Promise<void> {
	w.emit('agent-done', { key: id, ok: false, error });
	await tick();
}

/** A bug task that got through its first round with nothing found: it waits to be shipped. */
async function shipping(): Promise<string> {
	const id = await reviewing();
	await answerReview([]);
	expect(pipe(id).reason).toBe('ship');
	return id;
}

/** The position of the first call of a command among everything sent, or -1. */
const at = (cmd: string): number => w.calls.findIndex((c) => c.cmd === cmd);
const needsYou = (): string[] => w.toasts.filter((t) => / needs you/.test(t.title)).map((t) => t.message);

describe('starting a task', () => {
	test('a bug gets a worktree of its own and starts with a read-only planning turn', async () => {
		const id = await begin('bug');
		expect(w.sent('worktree_add').map((c) => c.args.branch)).toEqual([BRANCH]);
		const s = session(id);
		expect(s.isolated).toBe(true);
		expect(s.branch).toBe(BRANCH);
		expect(s.cwd).not.toBe(repos.repo()!.path);
		expect(turns().length).toBe(1);
		const turn = turns()[0];
		expect(turn.args.cwd).toBe(s.cwd);
		expect(prompt(turn)).toMatch(/^\[pipeline-plan\]/);
		expect(prompt(turn)).toContain(TASK);
		expect(turn.args.mode).toBe('default');
		expect(options(turn).tools).toEqual(['Read', 'Grep', 'Glob']);
		expect(options(turn).builtin).toEqual(['Read', 'Grep', 'Glob']);
		expect(pipe(id).step).toBe('plan');
		expect(pipe(id).steps.plan.state).toBe('run');
		expect(pipe(id).waiting).toBe(false);
	});

	test('a quick fix has no plan and no review: it starts by writing the code', async () => {
		const id = await begin('quick');
		expect(pipe(id).steps.plan.state).toBe('skip');
		expect(pipe(id).steps.review.state).toBe('skip');
		expect(pipe(id).step).toBe('code');
		expect(turns().length).toBe(1);
		expect(prompt(turns()[0])).toMatch(/^\[pipeline-code\]/);
		expect(prompt(turns()[0])).toContain(TASK);
		expect(turns()[0].args.mode).toBe('acceptEdits');
		expect(options(turns()[0]).tools).toBeUndefined();
		expect(options(turns()[0]).builtin).toBeUndefined();
	});

	test('Claude is told not to commit, push or run the tests itself', async () => {
		await begin('quick');
		expect(prompt(turns()[0])).toMatch(/Do not commit, push/);
		expect(prompt(turns()[0])).toMatch(/Do not try to run the test suite/);
	});

	test('each step runs on its own model: Sonnet unless another was picked', async () => {
		const id = await begin('bug', { models: { plan: 'opus' } });
		expect(options(turns()[0]).model).toBe('opus');
		await endTurn(id, { needs: 'Approve the plan' });
		pipes.setModel(id, 'review', 'opus');
		await pipes.approve(id);
		await tick();
		expect(options(turns()[1]).model).toBe('sonnet');
		await endTurn(id);
		expect(options(asks()[0]).model).toBe('opus');
	});

	test('the review runs on Haiku unless another model was picked', async () => {
		await reviewing();
		expect(options(asks()[0]).model).toBe('haiku');
	});

	test('images given with the task go with its first turn, by the names they were saved under', async () => {
		const shot = { name: 'shot-1.png', mediaType: 'image/png', data: 'aGVsbG8=', url: 'data:image/png;base64,aGVsbG8=' };
		expect(await pipes.start({ task: TASK, kind: 'bug', branch: BRANCH, images: [shot] })).toBe(true);
		await tick();
		const id = agents.selectedId()!;
		expect(w.sent('agent_image_save').map((c) => c.args)).toEqual([{ id, name: 'shot-1.png', data: 'aGVsbG8=' }]);
		expect(options(turns()[0]).images).toEqual(['shot-1.png']);
		// The path of an image never comes from the window: only its name does.
		expect(JSON.stringify(turns()[0].args)).not.toContain('aGVsbG8=');
	});

	test('no worktree, no task: nothing is started', async () => {
		w.on('worktree_add', () => { throw appError('git', 'a branch named agent/queue-wrap already exists'); });
		expect(await pipes.start({ task: TASK, kind: 'bug', branch: BRANCH })).toBe(false);
		await tick();
		expect(turns()).toEqual([]);
		expect(agents.sessions().filter((s) => s.pipeline)).toEqual([]);
		expect(w.toasts.at(-1)?.message).toContain('already exists');
	});

	test('a task with no words is not started', async () => {
		expect(await pipes.start({ task: '   ', kind: 'bug', branch: BRANCH })).toBe(false);
		expect(w.sent('worktree_add')).toEqual([]);
		expect(turns()).toEqual([]);
	});

	test('a turn of a session that is not a pipeline is left alone', async () => {
		await agents.start({ task: 'Look around', branch: '', mode: 'acceptEdits' });
		const id = agents.selectedId()!;
		await endTurn(id);
		expect(w.sent('pipeline_commit')).toEqual([]);
		expect(asks()).toEqual([]);
	});
});

describe('the plan', () => {
	test.each(['bug', 'feature'] as const)('a %s waits for its plan to be approved, and changes nothing meanwhile', async (kind) => {
		const id = await begin(kind);
		await endTurn(id, { text: 'One sentence on the approach.\n\n1. Change `src/queue.ts`.', did: 'Planned it in two steps.', needs: 'Approve the plan' });
		const p = pipe(id);
		expect(p.step).toBe('plan');
		expect(p.waiting).toBe(true);
		expect(p.reason).toBe('approve');
		expect(p.steps.plan.state).toBe('you');
		expect(p.note).toBe('Approve the plan to start coding.');
		expect(p.plan).toContain('1. Change `src/queue.ts`.');
		expect(p.plan).not.toContain('did:');
		expect(p.steps.plan.summary).toBe('Planned it in two steps.');
		expect(turns().length).toBe(1);
		expect(w.sent('pipeline_commit')).toEqual([]);
		expect(asks()).toEqual([]);
	});

	test('a question the plan asks is what it waits with', async () => {
		const id = await begin('feature');
		await endTurn(id, { needs: 'Should repeat-one restart the same track?' });
		expect(pipe(id).reason).toBe('approve');
		expect(pipe(id).note).toBe('Should repeat-one restart the same track?');
	});

	test('approving starts the code in the same Claude session, with the answer given', async () => {
		const id = await begin('feature');
		await endTurn(id, { needs: 'Should repeat-one restart the same track?' });
		await pipes.approve(id, 'Yes, restart it');
		await tick();
		expect(turns().length).toBe(2);
		const code = turns()[1];
		expect(prompt(code)).toMatch(/^\[pipeline-code\]/);
		expect(prompt(code)).toContain('Yes, restart it');
		expect(code.args.mode).toBe('acceptEdits');
		expect(code.args.resume).toBe('claude-session-1');
		expect(options(code).tools).toBeUndefined();
		const p = pipe(id);
		expect(p.step).toBe('code');
		expect(p.waiting).toBe(false);
		expect(p.reason ?? null).toBeNull();
		expect(p.steps.plan.state).toBe('done');
		expect(p.steps.plan.summary).toContain('Yes, restart it');
		expect(p.steps.code.state).toBe('run');
	});

	test('a chore approves its own plan', async () => {
		const id = await begin('chore');
		await endTurn(id, { needs: 'Approve the plan' });
		expect(turns().length).toBe(2);
		expect(prompt(turns()[1])).toMatch(/^\[pipeline-code\]/);
		expect(pipe(id).step).toBe('code');
		expect(pipe(id).waiting).toBe(false);
	});

	test('a chore whose plan asks something still waits for the answer', async () => {
		const id = await begin('chore');
		await endTurn(id, { needs: 'Move the helpers to shared/ or keep them here?' });
		expect(turns().length).toBe(1);
		expect(pipe(id).waiting).toBe(true);
		expect(pipe(id).reason).toBe('approve');
	});

	test('a message typed while the plan waits changes the plan: another read-only turn, then it waits again', async () => {
		const id = await begin('bug');
		await endTurn(id, { text: 'The first plan.', needs: 'Approve the plan' });
		await pipes.message(id, 'Also cover the empty queue');
		await tick();
		expect(turns().length).toBe(2);
		const again = turns()[1];
		expect(prompt(again)).toMatch(/^\[pipeline-plan\]/);
		expect(prompt(again)).toContain('Also cover the empty queue');
		expect(again.args.mode).toBe('default');
		expect(options(again).tools).toEqual(['Read', 'Grep', 'Glob']);
		expect(options(again).builtin).toEqual(['Read', 'Grep', 'Glob']);
		expect(pipe(id).step).toBe('plan');
		expect(pipe(id).waiting).toBe(false);
		await endTurn(id, { text: 'The second plan.', needs: 'Approve the plan' });
		expect(pipe(id).reason).toBe('approve');
		expect(pipe(id).plan).toContain('The second plan.');
		expect(pipe(id).plan).not.toContain('The first plan.');
		expect(w.sent('pipeline_commit')).toEqual([]);
	});

	test('an empty change to the plan asks Claude nothing', async () => {
		const id = await begin('bug');
		await endTurn(id, { needs: 'Approve the plan' });
		await pipes.revisePlan(id, '   ');
		await tick();
		expect(turns().length).toBe(1);
		expect(pipe(id).reason).toBe('approve');
	});

	test('carrying on from a plan that waits is approving it', async () => {
		const id = await begin('bug');
		await endTurn(id, { needs: 'Approve the plan' });
		await pipes.carryOn(id);
		await tick();
		expect(prompt(turns().at(-1))).toMatch(/^\[pipeline-code\]/);
		expect(pipe(id).steps.plan.state).toBe('done');
	});
});

describe('after the code: commit, push, review, test', () => {
	test('the work is committed as the brief says and pushed, before anything looks at it', async () => {
		const id = await reviewing();
		const s = session(id);
		expect(w.sent('pipeline_commit').length).toBe(1);
		const commit = w.sent('pipeline_commit')[0].args;
		expect(commit.id).toBe(s.repoId);
		expect(commit.cwd).toBe(s.cwd);
		expect(String(commit.message).split('\n')[0]).toBe('Queue wraps on repeat');
		expect(commit.message).toContain('The queue wraps to the first track.');
		expect(at('pipeline_commit')).toBeLessThan(at('pipeline_review_diff'));
		expect(pipe(id).pushed).toBe(`Committed abc1234 and pushed ${BRANCH}.`);
		expect(pipe(id).steps.code.state).toBe('done');
		expect(pipe(id).steps.code.lines).toContain(pipe(id).pushed);
	});

	test('the review is a read-only question in the worktree, over everything since the task started', async () => {
		const id = await reviewing();
		const s = session(id);
		expect(w.sent('pipeline_review_diff').map((c) => c.args)).toEqual([{ id: s.repoId, cwd: s.cwd, base: s.base }]);
		expect(s.base).toBeTruthy();
		expect(asks().length).toBe(1);
		const ask = asks()[0];
		expect(ask.args.id).toBe(s.repoId);
		expect(ask.args.cwd).toBe(s.cwd);
		expect(ask.args.mode).toBe('default');
		expect(ask.args.resume).toBeNull();
		expect(options(ask).tools).toEqual(['Read', 'Grep', 'Glob']);
		expect(prompt(ask)).toContain('+new');
		expect(pipe(id).step).toBe('review');
		expect(pipe(id).steps.review.state).toBe('run');
		// The turn has ended, yet the task is still at work: nothing waits on the user.
		expect(s.status).toBe('idle');
		expect(pipe(id).waiting).toBe(false);
	});

	test('the review is told what the task asked for, in the person\'s own words', async () => {
		await reviewing();
		expect(prompt(asks()[0])).toContain(TASK);
		expect(prompt(asks()[0])).toMatch(/Do not report behaviour the task asked for/);
	});

	test('a clean review and passing tests: it waits to be shipped, and merges nothing', async () => {
		const id = await reviewing();
		await answerReview([], { summary: 'Nothing to report.' });
		const s = session(id);
		expect(w.sent('pipeline_tests').map((c) => c.args)).toEqual([{ id: s.repoId, cwd: s.cwd }]);
		expect(w.sent('pipeline_test_run').map((c) => c.args)).toEqual([{ id: s.repoId, cwd: s.cwd, key: `pipeline:${id}`, target: TARGET.id }]);
		const p = pipe(id);
		expect(p.step).toBe('ship');
		expect(p.waiting).toBe(true);
		expect(p.reason).toBe('ship');
		expect(p.note).toMatch(/^Every check passes\./);
		expect(p.steps.review.state).toBe('done');
		expect(p.steps.test.state).toBe('done');
		expect(p.tests).toMatchObject({ ok: true, summary: '12 passed', none: false });
		expect(p.steps.fix.state).toBe('next');
		expect(p.steps.ship.state).toBe('you');
		expect(p.fixes).toBe(0);
		expect(turns().length).toBe(2);
		for (const cmd of ['merge_branch', 'merge_squash', 'pr_create', 'push', 'pipeline_clean']) {
			expect(w.sent(cmd)).toEqual([]);
		}
	});

	test('a push that fails is said and does not stop the task', async () => {
		w.on('pipeline_commit', () => ({ committed: true, head: 'abc1234def5678', pushed: false, pushError: 'remote: permission denied' }));
		const id = await reviewing();
		expect(pipe(id).pushed).toBe('Committed abc1234; not pushed: remote: permission denied.');
		expect(pipe(id).steps.code.lines).toContain(pipe(id).pushed);
		expect(pipe(id).waiting).toBe(false);
		expect(asks().length).toBe(1);
		await answerReview([]);
		expect(pipe(id).reason).toBe('ship');
	});

	test('a commit that fails stops the task there and says why', async () => {
		w.on('pipeline_commit', () => { throw appError('git', 'pre-commit hook failed'); });
		const id = await reviewing();
		const p = pipe(id);
		expect(p.waiting).toBe(true);
		expect(p.reason).toBe('halted');
		expect(p.note).toContain('pre-commit hook failed');
		expect(w.sent('pipeline_review_diff')).toEqual([]);
		expect(asks()).toEqual([]);
		expect(w.sent('pipeline_test_run')).toEqual([]);
	});

	test('nothing to commit is not a failure: the checks still run', async () => {
		w.on('pipeline_commit', () => ({ committed: false, head: '', pushed: false, pushError: null }));
		const id = await reviewing();
		expect(pipe(id).pushed).toBeNull();
		expect(asks().length).toBe(1);
	});

	test('a worktree with nothing changed is not sent to Claude for review, and is still tested', async () => {
		w.on('pipeline_review_diff', () => ({ ...CHANGED, text: '', files: [] }));
		const id = await reviewing();
		expect(asks()).toEqual([]);
		expect(pipe(id).steps.review.state).toBe('done');
		expect(w.sent('pipeline_test_run').length).toBe(1);
		expect(pipe(id).reason).toBe('ship');
	});

	test('a quick fix is committed and tested, and never reviewed', async () => {
		const id = await begin('quick');
		await endTurn(id, { did: 'Fixed the typo.' });
		expect(w.sent('pipeline_commit').length).toBe(1);
		expect(w.sent('pipeline_review_diff')).toEqual([]);
		expect(asks()).toEqual([]);
		expect(w.sent('pipeline_test_run').length).toBe(1);
		const p = pipe(id);
		expect(p.reason).toBe('ship');
		expect(p.steps.review.state).toBe('skip');
		expect(p.steps.plan.state).toBe('skip');
	});

	test('a project with no test targets counts as passing', async () => {
		w.on('pipeline_tests', () => []);
		const id = await reviewing();
		await answerReview([]);
		expect(w.sent('pipeline_test_run')).toEqual([]);
		expect(pipe(id).tests).toMatchObject({ ok: true, none: true });
		expect(pipe(id).reason).toBe('ship');
	});

	test('at most four test targets run in a round', async () => {
		w.on('pipeline_tests', () => [1, 2, 3, 4, 5, 6].map((n) => ({ ...TARGET, id: `p${n}:test`, cwd: `p${n}` })));
		const id = await reviewing();
		await answerReview([]);
		expect(w.sent('pipeline_test_run').map((c) => c.args.target)).toEqual(['p1:test', 'p2:test', 'p3:test', 'p4:test']);
		expect(pipe(id).tests?.commands.length).toBe(4);
	});

	test('one failing target among several fails the round', async () => {
		w.on('pipeline_tests', () => [{ ...TARGET, id: 'a:test' }, { ...TARGET, id: 'b:test' }]);
		w.on('pipeline_test_run', (a) => (a.target === 'b:test' ? FAILED : PASSED));
		const id = await reviewing();
		await answerReview([]);
		expect(pipe(id).tests?.ok).toBe(false);
		expect(pipe(id).step).toBe('fix');
	});

	test('test targets that cannot be read stop the task and say why', async () => {
		w.on('pipeline_tests', () => { throw appError('error', 'package.json is not valid JSON'); });
		const id = await reviewing();
		await answerReview([]);
		expect(pipe(id).waiting).toBe(true);
		expect(pipe(id).step).toBe('test');
		expect(pipe(id).note).toContain('package.json is not valid JSON');
	});

	test('a test run that cannot start stops the task and says why', async () => {
		w.on('pipeline_test_run', () => { throw appError('error', 'npm was not found'); });
		const id = await reviewing();
		await answerReview([]);
		expect(pipe(id).waiting).toBe(true);
		expect(pipe(id).step).toBe('test');
		expect(pipe(id).note).toContain('npm was not found');
		expect(turns().length).toBe(2);
	});
});

describe('what the review holds up', () => {
	test('a bug sends the work to Fix, with the finding in Claude\'s next turn', async () => {
		const id = await reviewing();
		await answerReview([BUG, NIT]);
		const p = pipe(id);
		expect(p.step).toBe('fix');
		expect(p.fixes).toBe(1);
		expect(p.waiting).toBe(false);
		expect(p.steps.review.state).toBe('warn');
		expect(p.findings.map((f) => f.severity)).toEqual(['bug', 'nit']);
		expect(turns().length).toBe(3);
		const fix = turns()[2];
		expect(prompt(fix)).toMatch(/^\[pipeline-fix\]\nFix 1 of 3\./);
		expect(prompt(fix)).toContain(BUG.title);
		expect(prompt(fix)).not.toContain(NIT.title);
		expect(fix.args.mode).toBe('acceptEdits');
		expect(session(id).items.at(-1)).toMatchObject({ kind: 'user', text: 'Fix 1 of 3: 1 review finding' });
	});

	test('the tests still run before a fix, so one fix gets both', async () => {
		w.on('pipeline_test_run', () => FAILED);
		await reviewing();
		await answerReview([BUG]);
		expect(w.sent('pipeline_test_run').length).toBe(1);
		const fix = prompt(turns()[2]);
		expect(fix).toContain(BUG.title);
		expect(fix).toContain('wraps at the end');
	});

	test('a risk holds the work up before the first fix', async () => {
		const id = await reviewing();
		await answerReview([RISK]);
		expect(pipe(id).step).toBe('fix');
		expect(pipe(id).fixes).toBe(1);
		expect(prompt(turns()[2])).toContain(RISK.title);
	});

	test('after a fix a risk no longer holds it up: it is listed at Ship', async () => {
		const id = await reviewing();
		await answerReview([RISK]);
		await endTurn(id, { did: 'Guarded the empty queue.' });
		await answerReview([{ ...RISK, title: 'Another maybe-problem' }]);
		const p = pipe(id);
		expect(p.step).toBe('ship');
		expect(p.reason).toBe('ship');
		expect(p.fixes).toBe(1);
		expect(turns().length).toBe(3);
		expect(p.findings.map((f) => f.title)).toEqual(['Another maybe-problem']);
		expect(p.note).toMatch(/after 1 fix\./);
		expect(p.note).toMatch(/1 note to look at/);
		expect(p.steps.review.state).toBe('done');
		expect(p.steps.fix.state).toBe('done');
	});

	test('a bug still holds it up after a fix', async () => {
		const id = await reviewing();
		await answerReview([BUG]);
		await endTurn(id, { did: 'Reset the cursor.' });
		await answerReview([BUG]);
		expect(pipe(id).step).toBe('fix');
		expect(pipe(id).fixes).toBe(2);
		expect(prompt(turns().at(-1))).toMatch(/Fix 2 of 3\./);
	});

	test('a nit never holds anything up', async () => {
		const id = await reviewing();
		await answerReview([NIT]);
		expect(pipe(id).reason).toBe('ship');
		expect(pipe(id).fixes).toBe(0);
		expect(pipe(id).findings.length).toBe(1);
		expect(turns().length).toBe(2);
	});

	test('a review that cannot be read stops the task before the tests', async () => {
		const id = await reviewing();
		await answerReview([], { raw: 'It all looks fine to me.' });
		expect(pipe(id).waiting).toBe(true);
		expect(pipe(id).step).toBe('review');
		expect(pipe(id).reason).toBe('halted');
		expect(w.sent('pipeline_test_run')).toEqual([]);
	});

	test('carrying on from it reviews again, committing what is in the worktree first', async () => {
		const id = await reviewing();
		await answerReview([], { raw: 'It all looks fine to me.' });
		const before = w.calls.length;
		void pipes.carryOn(id); // it resolves when the round it starts has ended
		await tick();
		const since = w.calls.slice(before).map((c) => c.cmd);
		expect(since.indexOf('pipeline_commit')).toBeGreaterThanOrEqual(0);
		expect(since.indexOf('pipeline_commit')).toBeLessThan(since.indexOf('pipeline_review_diff'));
		expect(asks().length).toBe(2);
		expect(turns().length).toBe(2);
		expect(pipe(id).waiting).toBe(false);
		await answerReview([]);
		expect(pipe(id).reason).toBe('ship');
	});

	test('a review that Claude Code fails stops the task and says why', async () => {
		const id = await reviewing();
		w.emit('agent-done', { key: asks()[0].args.key, ok: false, error: 'rate limited' });
		await tick();
		expect(pipe(id).waiting).toBe(true);
		expect(pipe(id).step).toBe('review');
		expect(pipe(id).note).toContain('rate limited');
		expect(w.sent('pipeline_test_run')).toEqual([]);
	});

	test('a diff that cannot be read stops the task and says why', async () => {
		w.on('pipeline_review_diff', () => { throw appError('git', 'bad revision'); });
		const id = await reviewing();
		expect(pipe(id).waiting).toBe(true);
		expect(pipe(id).note).toContain('bad revision');
		expect(asks()).toEqual([]);
	});
});

describe('failing tests', () => {
	test('send the work to Fix with what failed', async () => {
		w.on('pipeline_test_run', () => FAILED);
		const id = await reviewing();
		await answerReview([]);
		const p = pipe(id);
		expect(p.tests).toMatchObject({ ok: false, summary: '11 passed, 1 failed', failures: ['src/queue.test.ts > wraps at the end'] });
		expect(p.steps.test.state).toBe('warn');
		expect(p.step).toBe('fix');
		expect(p.fixes).toBe(1);
		expect(p.steps.fix.state).toBe('run');
		const fix = prompt(turns()[2]);
		expect(fix).toMatch(/^\[pipeline-fix\]\nFix 1 of 3\./);
		expect(fix).toContain('11 passed, 1 failed');
		expect(fix).toContain('src/queue.test.ts > wraps at the end');
		expect(fix).toMatch(/Never delete, skip or weaken a test/);
		expect(fix).toMatch(/Do not commit, push, or run the test suite/);
	});

	test('a fix is committed as a fix, pushed, reviewed and tested again', async () => {
		let runs = 0;
		w.on('pipeline_test_run', () => (++runs === 1 ? FAILED : PASSED));
		const id = await reviewing();
		await answerReview([]);
		await endTurn(id, { did: 'Reset the cursor at the end.' });
		expect(w.sent('pipeline_commit').length).toBe(2);
		expect(w.sent('pipeline_commit')[1].args.message).toBe('Fix 1: Reset the cursor at the end.');
		expect(pipe(id).steps.fix.lines).toContain(`Committed abc1234 and pushed ${BRANCH}.`);
		expect(asks().length).toBe(2);
		expect(pipe(id).step).toBe('review');
		await answerReview([]);
		expect(w.sent('pipeline_test_run').length).toBe(2);
		const p = pipe(id);
		expect(p.reason).toBe('ship');
		expect(p.fixes).toBe(1);
		expect(p.tests?.ok).toBe(true);
		expect(p.note).toMatch(/after 1 fix\./);
		expect(p.steps.fix.state).toBe('done');
	});
});

describe('the fix limit', () => {
	/** A bug task whose review finds the same bug every round, taken through all three fixes. */
	async function stuck(): Promise<string> {
		const id = await reviewing();
		for (let n = 1; n <= 3; n++) {
			await answerReview([BUG]);
			expect(pipe(id).fixes).toBe(n);
			await endTurn(id, { did: `Attempt ${n}.` });
		}
		await answerReview([BUG]);
		return id;
	}

	test('after three fixes that did not get there it stops and asks', async () => {
		const id = await stuck();
		const p = pipe(id);
		expect(p.fixes).toBe(3);
		expect(p.waiting).toBe(true);
		expect(p.reason).toBe('limit');
		expect(p.step).toBe('fix');
		expect(p.steps.fix.state).toBe('you');
		expect(p.note).toMatch(/^Stopped after 3 fixes: 1 review finding left\./);
		// Plan, code and three fixes: no fourth.
		expect(turns().length).toBe(5);
	});

	test('failing tests count toward the limit too, and are named when it asks', async () => {
		w.on('pipeline_test_run', () => FAILED);
		const id = await reviewing();
		for (let n = 1; n <= 3; n++) {
			await answerReview([]);
			await endTurn(id, { did: `Attempt ${n}.` });
		}
		await answerReview([]);
		expect(pipe(id).reason).toBe('limit');
		expect(pipe(id).note).toContain('11 passed, 1 failed');
		expect(turns().length).toBe(5);
	});

	test('One more round allows one more fix and starts it', async () => {
		const id = await stuck();
		await pipes.oneMoreRound(id);
		await tick();
		const p = pipe(id);
		expect(p.allowedFixes).toBe(4);
		expect(p.fixes).toBe(4);
		expect(p.waiting).toBe(false);
		expect(p.step).toBe('fix');
		expect(turns().length).toBe(6);
		expect(prompt(turns()[5])).toMatch(/Fix 4 of 4\./);
	});

	test('the round it allowed is the last: it asks again after it', async () => {
		const id = await stuck();
		await pipes.oneMoreRound(id);
		await tick();
		await endTurn(id, { did: 'Attempt 4.' });
		await answerReview([BUG]);
		expect(pipe(id).reason).toBe('limit');
		expect(pipe(id).fixes).toBe(4);
		expect(turns().length).toBe(6);
	});

	test('carrying on at the limit is one more round', async () => {
		const id = await stuck();
		await pipes.carryOn(id);
		await tick();
		expect(pipe(id).allowedFixes).toBe(4);
		expect(turns().length).toBe(6);
	});

	test('Mark done ends it without another fix, and leaves the worktree and branch', async () => {
		const id = await stuck();
		agents.markDone(id);
		await tick();
		expect(pipe(id).step).toBe('done');
		expect(pipe(id).waiting).toBe(false);
		await pipes.carryOn(id);
		await tick();
		expect(turns().length).toBe(5);
		expect(w.sent('pipeline_clean')).toEqual([]);
	});

	test('Take over goes to its worktree and starts nothing', async () => {
		const id = await stuck();
		await agents.review(session(id));
		await tick();
		expect(repos.repo()?.worktree).toBe(session(id).cwd);
		expect(repos.tab()).toBe('changes');
		expect(turns().length).toBe(5);
		expect(pipe(id).reason).toBe('limit');
	});
});

describe('what each step cost', () => {
	test('a Claude step costs what the session\'s total grew by while it ran; the review adds its own', async () => {
		const id = await begin('bug');
		await endTurn(id, { needs: 'Approve the plan', total: 0.1 });
		expect(pipe(id).steps.plan.cost).toBeCloseTo(0.1);
		await pipes.approve(id);
		await tick();
		await endTurn(id, { total: 0.35 });
		expect(pipe(id).steps.code.cost).toBeCloseTo(0.25);
		await answerReview([BUG], { cost: 0.02 });
		expect(pipe(id).steps.review.cost).toBeCloseTo(0.02);
		await endTurn(id, { total: 0.5 });
		expect(pipe(id).steps.fix.cost).toBeCloseTo(0.15);
		await answerReview([BUG], { cost: 0.03 });
		await endTurn(id, { total: 0.6 });
		const p = pipe(id);
		// Two fixes add up on the one Fix step, two reviews on Review; nothing is counted twice.
		expect(p.steps.fix.cost).toBeCloseTo(0.25);
		expect(p.steps.review.cost).toBeCloseTo(0.05);
		expect(p.steps.plan.cost).toBeCloseTo(0.1);
		expect(p.steps.code.cost).toBeCloseTo(0.25);
		expect(p.steps.test.cost).toBe(0);
		// The session's own total is Claude Code's: the reviews are not in it.
		expect(session(id).cost).toBeCloseTo(0.6);
	});

	test('a turn Claude Code reports no cost for adds nothing', async () => {
		const id = await begin('bug');
		await endTurn(id, { needs: 'Approve the plan', total: 0.1 });
		await pipes.approve(id);
		await tick();
		await endTurn(id);
		expect(pipe(id).steps.code.cost).toBe(0);
		expect(pipe(id).steps.plan.cost).toBeCloseTo(0.1);
	});

	test('a stopped step is still charged what it spent', async () => {
		const id = await begin('bug');
		await endTurn(id, { needs: 'Approve the plan', total: 0.1 });
		await pipes.approve(id);
		await tick();
		await pipes.stop(id);
		w.emit('agent-event', { key: id, event: { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.18 } });
		await gone(id);
		expect(pipe(id).steps.code.cost).toBeCloseTo(0.08);
	});
});

describe('Stop', () => {
	test('during Claude\'s turn: Claude Code is stopped, and the step waits with nothing committed', async () => {
		const id = await coding();
		await pipes.stop(id);
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([id]);
		await gone(id);
		const p = pipe(id);
		expect(p.waiting).toBe(true);
		expect(p.reason).toBe('halted');
		expect(p.step).toBe('code');
		expect(p.steps.code.state).toBe('you');
		expect(p.note).toMatch(/^Stopped by you\./);
		expect(w.sent('pipeline_commit')).toEqual([]);
		expect(asks()).toEqual([]);
	});

	test('carrying on runs the stopped step again', async () => {
		const id = await coding();
		await pipes.stop(id);
		await gone(id);
		await pipes.carryOn(id);
		await tick();
		expect(turns().length).toBe(3);
		expect(prompt(turns()[2])).toMatch(/^\[pipeline-code\]/);
		expect(pipe(id).waiting).toBe(false);
		expect(pipe(id).steps.code.state).toBe('run');
	});

	test('a review after a stopped step first commits what the step left in the worktree', async () => {
		const id = await coding();
		await pipes.stop(id);
		await gone(id);
		expect(w.sent('pipeline_commit')).toEqual([]);
		void pipes.review(id);
		await tick();
		expect(w.sent('pipeline_commit').length).toBe(1);
		expect(at('pipeline_commit')).toBeLessThan(at('pipeline_review_diff'));
		expect(asks().length).toBe(1);
	});

	test('during the review: the question is called off and no tests run', async () => {
		const id = await reviewing();
		await pipes.stop(id);
		await tick();
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([asks()[0].args.key]);
		const p = pipe(id);
		expect(p.waiting).toBe(true);
		expect(p.step).toBe('review');
		expect(p.note).toMatch(/^Stopped by you\./);
		expect(w.sent('pipeline_tests')).toEqual([]);
		// An answer that was already on its way changes nothing.
		await answerReview([BUG]);
		expect(pipe(id).findings).toEqual([]);
		expect(pipe(id).note).toMatch(/^Stopped by you\./);
		expect(turns().length).toBe(2);
	});

	test('during the tests: the run is stopped and nothing is decided from it', async () => {
		let finish: (run: unknown) => void = () => undefined;
		w.on('pipeline_test_run', () => new Promise((resolve) => (finish = resolve)));
		const id = await reviewing();
		await answerReview([]);
		expect(pipe(id).step).toBe('test');
		expect(pipe(id).steps.test.state).toBe('run');
		await pipes.stop(id);
		expect(w.sent('pipeline_test_stop').map((c) => c.args.key)).toEqual([`pipeline:${id}`]);
		finish({ ...FAILED, stopped: true });
		await tick();
		const p = pipe(id);
		expect(p.waiting).toBe(true);
		expect(p.step).toBe('test');
		expect(p.note).toMatch(/^Stopped by you\./);
		expect(p.tests).toBeNull();
		expect(p.fixes).toBe(0);
		expect(turns().length).toBe(2);
	});

	test('carrying on after stopped tests runs them again, without another review', async () => {
		let finish: (run: unknown) => void = () => undefined;
		w.on('pipeline_test_run', () => new Promise((resolve) => (finish = resolve)));
		const id = await reviewing();
		await answerReview([]);
		await pipes.stop(id);
		finish({ ...PASSED, stopped: true });
		await tick();
		w.on('pipeline_test_run', () => PASSED);
		await pipes.carryOn(id);
		await tick();
		expect(w.sent('pipeline_test_run').length).toBe(2);
		expect(asks().length).toBe(1);
		expect(pipe(id).reason).toBe('ship');
	});

	// What holds now: Stop while Studio commits and pushes the work (after Code ends the task shows
	// "Committing and pushing", and a push can take seconds) leaves the task waiting, as it says
	// ("Stopped by you"). Before the fix (2026-11-23): nothing remembers the stop; once the commit returns, review()
	// (pipeline.store.ts) goes on to the review and the tests and clears `waiting`, so the
	// task runs on after the user was told it stopped. The same holds while the review's diff is read.
	test('while the work is being committed and pushed: it stays stopped', async () => {
		let committed: (done: unknown) => void = () => undefined;
		w.on('pipeline_commit', () => new Promise((resolve) => (committed = resolve)));
		const id = await reviewing();
		expect(w.sent('pipeline_commit').length).toBe(1);
		await pipes.stop(id);
		expect(pipe(id).note).toMatch(/^Stopped by you\./);
		committed({ committed: true, head: 'abc1234def5678', pushed: true, pushError: null });
		await tick();
		expect(pipe(id).waiting).toBe(true);
		expect(asks()).toEqual([]);
	});

	test('a turn that fails stops the task there, with what Claude Code said', async () => {
		const id = await coding();
		await gone(id, 'Claude Code ran out of credit');
		const p = pipe(id);
		expect(p.waiting).toBe(true);
		expect(p.reason).toBe('halted');
		expect(p.step).toBe('code');
		expect(p.note).toContain('Claude Code ran out of credit');
		expect(w.sent('pipeline_commit')).toEqual([]);
	});

	test('a task that is not a pipeline is not touched', async () => {
		await agents.start({ task: 'Look around', branch: '', mode: 'acceptEdits' });
		const id = agents.selectedId()!;
		await pipes.stop(id);
		await pipes.carryOn(id);
		await pipes.discard(id);
		expect(w.sent('agent_stop')).toEqual([]);
		expect(w.sent('pipeline_clean')).toEqual([]);
		expect(session(id).status).toBe('running');
	});
});

describe('a message typed along the way', () => {
	test('after the plan it is more work: sent as it is, then committed and checked like any other', async () => {
		const id = await shipping();
		await pipes.message(id, 'Rename the helper to wrapAround');
		await tick();
		expect(turns().length).toBe(3);
		const more = turns()[2];
		expect(prompt(more)).toBe('Rename the helper to wrapAround');
		expect(more.args.mode).toBe('acceptEdits');
		expect(options(more).tools).toBeUndefined();
		expect(pipe(id).step).toBe('code');
		expect(pipe(id).waiting).toBe(false);
		await endTurn(id, { did: 'Renamed the helper.' });
		expect(w.sent('pipeline_commit').length).toBe(2);
		expect(w.sent('pipeline_commit')[1].args.message).toContain('Renamed the helper.');
		expect(asks().length).toBe(2);
		await answerReview([]);
		expect(w.sent('pipeline_test_run').length).toBe(2);
		expect(pipe(id).reason).toBe('ship');
	});

	test('once a fix has run it counts as part of the fixing', async () => {
		const id = await reviewing();
		await answerReview([BUG]);
		await endTurn(id, { did: 'Reset the cursor.' });
		await answerReview([]);
		expect(pipe(id).reason).toBe('ship');
		await pipes.message(id, 'Handle the empty queue too');
		await tick();
		expect(pipe(id).step).toBe('fix');
		expect(prompt(turns().at(-1))).toBe('Handle the empty queue too');
		await endTurn(id, { did: 'Handled the empty queue.' });
		expect(w.sent('pipeline_commit').at(-1)!.args.message).toBe('Fix 1: Handled the empty queue.');
		// A message is not one of the three fixes.
		expect(pipe(id).fixes).toBe(1);
	});
});

describe('cleaning up', () => {
	const CLEANED = { removedTree: true, deletedBranch: true, deletedRemote: [`origin/${BRANCH}`], problems: [] as string[] };

	test('work found in the main branch has shipped: its worktree, branch and pushed copy go, the session stays', async () => {
		const id = await shipping();
		const cwd = session(id).cwd;
		const trees = agents.worktrees();
		let cleaned = false;
		w.on('worktree_list', () => trees.filter((t) => !cleaned || t.isMain).map((t) => (t.path === cwd ? { ...t, changes: 0, landed: true } : t)));
		w.on('pipeline_clean', () => { cleaned = true; return CLEANED; });
		await agents.loadWorktrees();
		await tick();
		expect(w.sent('pipeline_clean').map((c) => c.args)).toEqual([{ id: session(id).repoId, cwd, branch: BRANCH }]);
		expect(pipe(id).step).toBe('done');
		expect(pipe(id).waiting).toBe(false);
		expect(pipe(id).steps.ship.state).toBe('done');
		expect(agents.sessions().some((s) => s.id === id)).toBe(true);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Merged and cleaned up' });
		expect(w.toasts.at(-1)!.message).toContain(`origin/${BRANCH}`);
	});

	test('work that has not landed is left where it is', async () => {
		const id = await shipping();
		await agents.loadWorktrees();
		await tick();
		expect(w.sent('pipeline_clean')).toEqual([]);
		expect(pipe(id).reason).toBe('ship');
	});

	test('merging it from here cleans up after it', async () => {
		const id = await shipping();
		const s = session(id);
		const into = agents.worktrees().find((t) => t.isMain)!.branch!;
		expect(await agents.merge(s, into)).toBe(true);
		await tick();
		expect(w.sent('merge_branch').map((c) => c.args.from)).toEqual([BRANCH]);
		expect(w.sent('pipeline_clean').map((c) => c.args)).toEqual([{ id: s.repoId, cwd: s.cwd, branch: BRANCH }]);
		expect(at('merge_branch')).toBeLessThan(at('pipeline_clean'));
		expect(pipe(id).step).toBe('done');
		expect(pipe(id).steps.ship.state).toBe('done');
		expect(agents.worktrees().some((t) => t.path === s.cwd)).toBe(false);
		expect(agents.sessions().some((x) => x.id === id)).toBe(true);
	});

	test('Discard deletes the worktree, the branch and its pushed copy, and merges nothing', async () => {
		const id = await shipping();
		const s = session(id);
		await pipes.discard(id);
		await tick();
		expect(w.sent('pipeline_clean').map((c) => c.args)).toEqual([{ id: s.repoId, cwd: s.cwd, branch: BRANCH }]);
		expect(w.sent('merge_branch')).toEqual([]);
		const p = pipe(id);
		expect(p.step).toBe('done');
		expect(p.waiting).toBe(false);
		expect(p.steps.ship.state).toBe('skip');
		expect(agents.sessions().some((x) => x.id === id)).toBe(true);
		expect(agents.worktrees().some((t) => t.path === s.cwd)).toBe(false);
		expect(repos.branches().some((b) => b.name === BRANCH)).toBe(false);
		expect(w.toasts.some((t) => t.kind === 'success' && t.title === 'Task discarded')).toBe(true);
	});

	test('Discard while Claude works stops it first', async () => {
		w.on('agent_stop', (a) => {
			queueMicrotask(() => w.emit('agent-done', { key: a.key, ok: false, error: '' }));
		});
		const id = await coding();
		await pipes.discard(id);
		await tick();
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([id]);
		expect(at('agent_stop')).toBeLessThan(at('pipeline_clean'));
		expect(session(id).status).toBe('idle');
		expect(pipe(id).step).toBe('done');
		expect(pipe(id).waiting).toBe(false);
		expect(w.sent('pipeline_commit')).toEqual([]);
	});

	test('Discard during the tests stops the run', async () => {
		w.on('pipeline_test_run', () => new Promise(() => undefined));
		const id = await reviewing();
		await answerReview([]);
		await pipes.discard(id);
		await tick();
		expect(w.sent('pipeline_test_stop').map((c) => c.args.key)).toEqual([`pipeline:${id}`]);
		expect(pipe(id).step).toBe('done');
	});

	test('Discard during the review calls the question off', async () => {
		const id = await reviewing();
		await pipes.discard(id);
		await tick();
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([asks()[0].args.key]);
		expect(pipe(id).step).toBe('done');
		expect(pipe(id).waiting).toBe(false);
		expect(w.sent('pipeline_tests')).toEqual([]);
	});

	// What holds now: discarding a task that is at work says "Task discarded" and nothing else.
	// Before the fix (2026-11-23): the stop that discard() makes first is announced like any other. With Claude's turn going
	// (pipeline.store.ts) the turn's end reaches turnEnded(), which waits with "Stopped by you"
	//; with the review going, calling the question off makes review()'s catch
	// take it for a failed review. Either way wait() toasts "<task> needs you" for a task the
	// user has just thrown away.
	test('Discard while Claude works does not say the task needs the user', async () => {
		w.on('agent_stop', (a) => {
			queueMicrotask(() => w.emit('agent-done', { key: a.key, ok: false, error: '' }));
		});
		const id = await coding();
		const before = needsYou().length;
		await pipes.discard(id);
		await tick();
		expect(needsYou().slice(before)).toEqual([]);
	});

	test('Discard during the review does not say the task needs the user', async () => {
		const id = await reviewing();
		const before = needsYou().length;
		await pipes.discard(id);
		await tick();
		expect(needsYou().slice(before)).toEqual([]);
	});

	test('the app leaves the task\'s worktree before it is deleted', async () => {
		const id = await shipping();
		const s = session(id);
		await agents.view(s.cwd);
		expect(repos.repo()?.worktree).toBe(s.cwd);
		const before = w.calls.length;
		await pipes.discard(id);
		await tick();
		const since = w.calls.slice(before);
		const left = since.findIndex((c) => c.cmd === 'worktree_select' && c.args.path === null);
		expect(left).toBeGreaterThanOrEqual(0);
		expect(left).toBeLessThan(since.findIndex((c) => c.cmd === 'pipeline_clean'));
		expect(repos.repo()?.worktree ?? null).toBeNull();
	});

	test('a cleanup that fails is said, and the task is not marked as gone', async () => {
		w.on('pipeline_clean', () => { throw appError('git', 'the worktree is locked'); });
		const id = await shipping();
		await pipes.discard(id);
		await tick();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'Cleaning up failed', message: 'the worktree is locked' });
		expect(pipe(id).step).toBe('ship');
		expect(pipe(id).reason).toBe('ship');
	});

	test('what could not be removed is said', async () => {
		w.on('pipeline_clean', () => ({ removedTree: true, deletedBranch: false, deletedRemote: [], problems: ['The branch is checked out elsewhere.'] }));
		const id = await shipping();
		await pipes.discard(id);
		await tick();
		expect(w.toasts.some((t) => t.kind === 'warning' && t.message.includes('The branch is checked out elsewhere.'))).toBe(true);
	});

	test('only a pipeline task is ever cleaned up', async () => {
		await agents.start({ task: 'Look around', branch: 'agent/look-around', mode: 'acceptEdits' });
		const id = agents.selectedId()!;
		await endTurn(id);
		expect(await pipes.cleanUp(id, 'discarded')).toBe(false);
		expect(w.sent('pipeline_clean')).toEqual([]);
	});
});

describe('after a restart', () => {
	/** The app again, with the session files an earlier run left. */
	async function restart(files: string[], trees?: (main: Record<string, unknown>) => unknown[]): Promise<void> {
		w = await world();
		quiet();
		w.on('agent_sessions_load', () => ({ sessions: files, unreadable: [] }));
		if (trees) {
			const main = { path: '/Users/demo/Source/harmony', branch: 'feature/repeat-mode', head: 'a'.repeat(40), isMain: true, active: true, changes: 4, landed: false };
			w.on('worktree_list', () => trees(main));
		}
		await load();
		await tick();
	}

	test('a step that was going when the app closed waits for Carry on, and starts nothing by itself', async () => {
		const id = await coding();
		await vi.advanceTimersByTimeAsync(600); // a session mid-turn is written within half a second
		const file = saved(id);
		expect(JSON.parse(file).pipeline.steps.code.state).toBe('run');

		await restart([file]);
		const p = pipe(id);
		expect(session(id).status).toBe('idle');
		expect(p.step).toBe('code');
		expect(p.waiting).toBe(true);
		expect(p.steps.code.state).toBe('you');
		expect(p.note).toMatch(/Carry on/);
		expect(turns()).toEqual([]);
		expect(w.sent('pipeline_commit')).toEqual([]);

		await pipes.carryOn(id);
		await tick();
		expect(turns().length).toBe(1);
		expect(prompt(turns()[0])).toMatch(/^\[pipeline-code\]/);
		expect(turns()[0].args.resume).toBe('claude-session-1');
		expect(pipe(id).waiting).toBe(false);
		expect(pipe(id).steps.code.state).toBe('run');
		await endTurn(id, { did: 'Built it.' });
		expect(w.sent('pipeline_commit').length).toBe(1);
	});

	test('a review that was going is asked again on Carry on, after committing what is there', async () => {
		const id = await reviewing();
		await tick();
		const file = saved(id);
		expect(JSON.parse(file).pipeline.step).toBe('review');

		await restart([file]);
		expect(pipe(id).waiting).toBe(true);
		expect(pipe(id).steps.review.state).toBe('you');
		expect(asks()).toEqual([]);

		void pipes.carryOn(id);
		await tick();
		expect(at('pipeline_commit')).toBeGreaterThanOrEqual(0);
		expect(at('pipeline_commit')).toBeLessThan(at('pipeline_review_diff'));
		expect(asks().length).toBe(1);
		await answerReview([]);
		expect(pipe(id).reason).toBe('ship');
	});

	test('a task that was waiting on the user is as it was', async () => {
		const id = await shipping();
		await tick();
		const file = saved(id);
		const cwd = session(id).cwd;
		const note = pipe(id).note;

		await restart([file], (main) => [main, { path: cwd, branch: BRANCH, head: 'c'.repeat(40), isMain: false, active: false, changes: 0, landed: false }]);
		const p = pipe(id);
		expect(p.step).toBe('ship');
		expect(p.reason).toBe('ship');
		expect(p.note).toBe(note);
		await pipes.carryOn(id);
		await tick();
		expect(turns()).toEqual([]);
		expect(w.sent('pipeline_commit')).toEqual([]);
		expect(pipe(id).reason).toBe('ship');
	});
});

describe('saying that it waits', () => {
	test('a task that starts waiting while nobody is looking at it says so', async () => {
		const id = await begin('bug');
		expect(needsYou()).toEqual([]);
		await endTurn(id, { needs: 'Which of the two queues?' });
		expect(needsYou()).toEqual(['Which of the two queues?']);
	});

	test('nothing is said about the task on screen', async () => {
		const id = await begin('bug');
		repos.setTab('agents');
		expect(agents.selectedId()).toBe(id);
		await endTurn(id, { needs: 'Which of the two queues?' });
		expect(pipe(id).reason).toBe('approve');
		expect(needsYou()).toEqual([]);
	});
});

describe('following the agents\' turns', () => {
	test('is set up once: a turn\'s end is acted on once however often init runs', async () => {
		pipes.init();
		pipes.init();
		const id = await reviewing();
		expect(w.sent('pipeline_commit').length).toBe(1);
		expect(asks().length).toBe(1);
		expect(pipe(id).step).toBe('review');
	});
});

describe('what the checks leave for the evidence at Ship', () => {
	test('each pass through Review and Test is a round, and the commit and files it looked at are kept', async () => {
		let runs = 0;
		w.on('pipeline_test_run', () => (++runs === 1 ? FAILED : PASSED));
		w.on('pipeline_review_diff', () => ({ ...CHANGED, commits: [{ hash: 'abc1234', summary: 'Queue wraps' }], truncated: true }));
		const id = await reviewing();
		await answerReview([NIT]);
		expect(pipe(id).rounds).toEqual([{ fixes: 0, holding: 0, notes: 1, tests: '11 passed, 1 failed', ok: false }]);
		await endTurn(id, { did: 'Reset the cursor at the end.' });
		await answerReview([]);
		const p = pipe(id);
		expect(p.rounds).toEqual([
			{ fixes: 0, holding: 0, notes: 1, tests: '11 passed, 1 failed', ok: false },
			{ fixes: 1, holding: 0, notes: 0, tests: '12 passed', ok: true },
		]);
		expect(p.checked).toMatchObject({ head: 'abc1234def5678', files: [{ path: 'src/queue.ts', status: 'modified' }], commits: 1, truncated: true });
		expect(p.checked!.at).toBeGreaterThan(0);
		expect(p.tests).toMatchObject({ printed: '$ npm test\n Tests  12 passed (12)\n', millis: 5 });
	});

	test('a quick fix has no review to list the change, so the files are asked for alone', async () => {
		w.on('worktree_diff', () => ({ base: 'b'.repeat(40), head: 'abc1234def5678', files: [{ path: 'src/queue.ts', oldPath: null, status: 'modified', diff: '' }], tooLarge: false }));
		const id = await begin('quick');
		await endTurn(id, { did: 'Wrapped the index.' });
		const p = pipe(id);
		expect(p.reason).toBe('ship');
		expect(p.checked).toMatchObject({ head: 'abc1234def5678', files: [{ path: 'src/queue.ts', status: 'modified' }], commits: null });
		expect(p.note).toBe('The checks that ran pass, but 1 thing nothing checked (see Ship). Merge it or open a pull request.');
	});

	test('files that cannot be listed do not stop a quick fix', async () => {
		w.on('worktree_diff', () => {
			throw appError('git', 'not a worktree');
		});
		const id = await begin('quick');
		await endTurn(id, { did: 'Wrapped the index.' });
		expect(pipe(id)).toMatchObject({ reason: 'ship', checked: { files: [] } });
	});

	test('a project with no tests ships with that said', async () => {
		w.on('pipeline_tests', () => []);
		const id = await reviewing();
		await answerReview([]);
		expect(pipe(id).note).toBe('The checks that ran pass, but 1 thing nothing checked (see Ship). Merge it or open a pull request.');
	});

	test('reaching Ship looks at the worktree, which is what tells later that it moved', async () => {
		const id = await reviewing();
		w.on('worktree_list', () => [{ path: session(id).cwd, branch: BRANCH, head: 'abc1234def5678', isMain: false, active: false, changes: 0, landed: false }]);
		await answerReview([]);
		expect(pipes.trees()[id]).toEqual({ head: 'abc1234def5678', changes: 0 });
		w.on('worktree_list', () => [{ path: session(id).cwd, branch: BRANCH, head: 'abc1234def5678', isMain: false, active: false, changes: 3, landed: false }]);
		await pipes.look(id); // too soon after the last look: nothing is asked
		expect(pipes.trees()[id].changes).toBe(0);
		await pipes.look(id, true);
		expect(pipes.trees()[id]).toEqual({ head: 'abc1234def5678', changes: 3 });
		w.on('worktree_list', () => []);
		await pipes.look(id, true);
		expect(pipes.trees()[id]).toBeUndefined();
	});

	test('Check again at Ship commits what is in the worktree, then reviews and tests it again', async () => {
		const id = await reviewing();
		await answerReview([]);
		expect(pipe(id).reason).toBe('ship');
		void pipes.recheck(id);
		await tick();
		expect(w.sent('pipeline_commit').length).toBe(2);
		expect(asks().length).toBe(2);
		expect(pipe(id)).toMatchObject({ step: 'review', waiting: false });
		await answerReview([]);
		expect(pipe(id)).toMatchObject({ step: 'ship', waiting: true, reason: 'ship' });
		expect(pipe(id).rounds?.length).toBe(2);
		expect(turns().length).toBe(2); // Claude's own session was asked nothing more
	});

	test('Check again does nothing while the task is not waiting at Ship', async () => {
		const id = await reviewing();
		await pipes.recheck(id);
		expect(w.sent('pipeline_commit').length).toBe(1);
		expect(asks().length).toBe(1);
	});
});
