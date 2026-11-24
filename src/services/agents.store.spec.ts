/**
 * The agents store against the demo backend. Turns are played by the tests themselves: `agent_start`
 * is answered here (so the demo backend's scripted turn stays out of it) and the events Claude Code
 * would send are emitted one by one. The language servers' answer (`LspService.check`) is ours too:
 * what they find is another service's business, what the store does with it is this one's.
 */
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { appError, world, type World } from '../test/world';
import { newPipeline, type Pipeline } from '../shared/pipeline';
import { INVESTIGATE_BUILTIN, INVESTIGATE_RULES, fixProblemsPrompt } from './ai-prompts';
import type { AgentItem, AgentSession, AgentsStore, InvestigateRequest, Investigation, NewTask } from './agents.store';
import type { Attachment } from './agent-images';
import type { ChangedFile, InvestigateApproval, RunTarget, Worktree, WorktreeDiff } from './backend.service';
import type { CheckResult, LspService, Problem } from './lsp.service';
import type { RepoStore } from './repo.store';

// Monaco is the editor's: nothing here needs it, and loading the real one in every test's fresh app is slow and loud.
vi.mock('../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: () => Promise.resolve(), releaseMonacoStyles: () => undefined }));

type Module = typeof import('./agents.store');

let w: World;
let m: Module;
let agents: AgentsStore;
let repos: RepoStore;
let check: MockInstance<LspService['check']>;

const NO_SERVERS: CheckResult = { problems: [], known: 0, impact: [], servers: [], files: 0, users: 0, finished: true };
const BRIEF = '```brief\ntitle: Shuffle button\ndid: Added the button and its test.\nneeds: Should it also shuffle the queue that is playing?\nchoice: Yes\nchoice: No\n```';
const REPORT = JSON.stringify({ found: true, summary: 'next() returns null at the end of the queue', path: [], evidence: [] });

/** The one global that tells the desktop app from the browser preview. */
const native = window as unknown as { __TAURI_INTERNALS__?: unknown };

/**
 * The app with its repository read and the agents store started. `before` runs when the repository
 * is known and the agents store has not been made yet: the place for saved sessions and stored settings.
 */
async function boot(before?: () => void | Promise<void>): Promise<void> {
	vi.useFakeTimers();
	w = await world();
	w.on('agent_start', () => undefined);
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	m = await import('./agents.store');
	const lsp = w.get((await import('./lsp.service')).LspService);
	check = vi.spyOn(lsp, 'check').mockResolvedValue(NO_SERVERS);
	vi.spyOn(lsp, 'changed').mockImplementation(() => undefined);
	await before?.();
	agents = w.get(m.AgentsStore);
	await agents.init();
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	delete native.__TAURI_INTERNALS__;
});

// ---- helpers -----------------------------------------------------------------

/** Lets `ms` pass, and everything already queued run. */
async function tick(ms = 0): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await vi.advanceTimersByTimeAsync(0);
}

/** Waits for something that also loads a module (the terminal's screen), which the pretend clock does not cover. */
async function until<T>(promise: Promise<T>): Promise<T> {
	let settled = false;
	const mark = (): void => void (settled = true);
	void promise.then(mark, mark);
	for (let i = 0; i < 500 && !settled; i++) {
		await vi.advanceTimersByTimeAsync(20);
	}
	return promise;
}

const text = (t: string): Record<string, unknown> => ({ type: 'text', text: t });
const tool = (name: string, input: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'tool_use', name, input });

/** An assistant message from Claude Code for the session `key`. */
function say(key: string, ...content: Record<string, unknown>[]): void {
	w.emit('agent-event', { key, event: { type: 'assistant', message: { content } } });
}

function started(key: string, sessionId: string): void {
	w.emit('agent-event', { key, event: { type: 'system', subtype: 'init', session_id: sessionId } });
}

function result(key: string, event: Record<string, unknown> = {}): void {
	w.emit('agent-event', { key, event: { type: 'result', is_error: false, ...event } });
}

/** Claude Code's process has ended. */
async function done(key: string, ok = true, error = ''): Promise<void> {
	w.emit('agent-done', { key, ok, error });
	await tick();
}

const now = (s: AgentSession): AgentSession => agents.get(s.id)!;
const repoId = (): string => repos.repo()!.id;
const otherRepo = (): string => repos.app()!.repos.find((r) => r.id !== repoId())!.id;
const starts = (): Record<string, unknown>[] => w.sent('agent_start').map((c) => c.args);
const options = (args: Record<string, unknown> | undefined): Record<string, unknown> => (args?.options ?? {}) as Record<string, unknown>;
const saves = (id: string): Record<string, unknown>[] => w.sent('agent_session_save').filter((c) => c.args.id === id).map((c) => c.args);
const toasts = (title: string | RegExp): World['toasts'] => w.toasts.filter((t) => (typeof title === 'string' ? t.title === title : title.test(t.title)));

/** The session as it was last written to its file (null: the file was removed). */
function written(id: string): AgentSession | null {
	const last = saves(id).at(-1)?.session;
	return last ? (JSON.parse(String(last)) as AgentSession) : null;
}

/** Starts a task and answers with its session (the first one, when there are several attempts). */
async function task(over: Partial<NewTask> = {}): Promise<AgentSession> {
	const had = new Set(agents.sessions().map((s) => s.id));
	expect(await agents.start({ task: 'Add a shuffle button', branch: 'agent/shuffle', mode: 'acceptEdits', ...over })).toBe(true);
	return agents.sessions().find((s) => !had.has(s.id))!;
}

/** From here on the list of worktrees is the one the store last read, each changed by `change` (null: it is gone). */
function trees(change: (t: Worktree) => Worktree | null): void {
	const list = agents
		.worktrees()
		.map(change)
		.filter((t): t is Worktree => !!t);
	w.on('worktree_list', () => list);
}

const treeOf = (s: AgentSession, change: Partial<Worktree> | null): void => trees((t) => (t.path === s.cwd ? (change ? { ...t, ...change } : null) : t));

/** A task whose first turn has ended well and left uncommitted work in its worktree: work to review. */
async function reviewable(over: Partial<NewTask> = {}, reply = 'Done.'): Promise<AgentSession> {
	const s = await task(over);
	treeOf(s, { changes: 2 });
	say(s.id, text(reply));
	await done(s.id);
	return now(s);
}

/** A session as the store keeps one: for the functions that only read one, and for files to restore from. */
function session(over: Partial<AgentSession> = {}): AgentSession {
	return { id: 's1', repoId: 'repo', title: 'Add a shuffle button', cwd: '/work/repo.worktrees/agent-shuffle', branch: 'agent/shuffle', isolated: true, mode: 'acceptEdits', sessionId: null, status: 'idle', items: [], cost: 0, updated: 0, kind: 'task', group: null, attempt: 1, base: null, tools: null, unread: false, review: false, stopped: false, investigation: null, check: null, brief: null, name: null, ...over };
}

function looking(over: Partial<Investigation> = {}): Investigation {
	return { summary: 'The player crashes', description: '', targetId: null, targetName: null, port: null, step: 0, details: {}, thinking: '', approval: null, runs: 0, started: 0, ended: null, report: null, leftover: [], cleanups: 0, checking: false, tab: null, ...over };
}

/** The files with saved sessions, as the native side hands them over. */
function stored(...sessions: unknown[]): void {
	w.on('agent_sessions_load', () => ({ sessions: sessions.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))), unreadable: [] }));
}

const image = (name = 'shot-1.png'): Attachment => ({ name, mediaType: 'image/png', data: 'QUJDRA==', url: 'data:image/png;base64,QUJDRA==' });
const changed = (path: string, diff = ''): ChangedFile => ({ path, oldPath: null, status: 'modified', diff });
const diffOf = (...files: ChangedFile[]): WorktreeDiff => ({ base: 'b'.repeat(40), head: 'c'.repeat(40), files, tooLarge: false });
const problem = (over: Partial<Problem> = {}): Problem => ({ path: 'src/player/queue.ts', line: 12, column: 3, message: "Property 'shuffle' does not exist on type 'Queue'.", source: 'ts', changed: true, ...over });

// ---- tasks -------------------------------------------------------------------

describe('a task', () => {
	beforeEach(() => boot());

	test('starts in a worktree of its own on the new branch, at the commit that worktree is at', async () => {
		const s = await task();
		expect(w.sent('worktree_add').map((c) => c.args)).toEqual([{ id: repoId(), branch: 'agent/shuffle', base: null }]);
		const tree = agents.worktrees().find((t) => t.branch === 'agent/shuffle')!;
		expect(s).toMatchObject({ kind: 'task', isolated: true, branch: 'agent/shuffle', status: 'running', group: null, attempt: 1, mode: 'acceptEdits', cwd: tree.path, base: tree.head, task: 'Add a shuffle button' });
		expect(s.cwd).not.toBe(repos.repo()!.path);
		expect(agents.selectedId()).toBe(s.id);
		expect(agents.busy()).toBe(false);
	});

	test('its first turn goes to Claude Code in that worktree: the task as written, a new conversation, the brief asked for', async () => {
		const s = await task({ task: '  Add a shuffle button  ', mode: 'bypassPermissions' });
		expect(starts()).toEqual([{ id: repoId(), cwd: s.cwd, key: s.id, prompt: 'Add a shuffle button', mode: 'bypassPermissions', resume: null, options: { brief: true, images: [] } }]);
		expect(s.items).toEqual([{ kind: 'user', text: 'Add a shuffle button' }]);
	});

	test('without a branch it works in the checkout on screen, and no worktree is made', async () => {
		const s = await task({ branch: '  ' });
		expect(w.sent('worktree_add')).toEqual([]);
		expect(s).toMatchObject({ isolated: false, cwd: repos.repo()!.path, branch: repos.status()!.branch, base: repos.status()!.head });
		expect(starts()[0].cwd).toBe(repos.repo()!.path);
	});

	test('the new branch is in the branch list and the worktree in the list of worktrees', async () => {
		await task();
		expect(repos.branches().some((b) => !b.isRemote && b.name === 'agent/shuffle')).toBe(true);
		expect(agents.worktrees().some((t) => t.branch === 'agent/shuffle' && !t.isMain)).toBe(true);
	});

	test('an empty task starts nothing', async () => {
		expect(await agents.start({ task: '  \n ', branch: 'agent/x', mode: 'acceptEdits' })).toBe(false);
		expect(w.sent('worktree_add')).toEqual([]);
		expect(agents.sessions()).toEqual([]);
	});

	test('a second start while the first is still being set up is refused', async () => {
		let release!: (path: string) => void;
		w.on('worktree_add', () => new Promise<string>((r) => (release = r)));
		const first = agents.start({ task: 'One', branch: 'agent/one', mode: 'acceptEdits' });
		await tick();
		expect(agents.busy()).toBe(true);
		expect(await agents.start({ task: 'Two', branch: 'agent/two', mode: 'acceptEdits' })).toBe(false);
		release('/somewhere/one');
		expect(await first).toBe(true);
		expect(agents.sessions().map((s) => s.title)).toEqual(['One']);
		expect(agents.busy()).toBe(false);
	});

	test('a worktree that cannot be made is said, and leaves no session behind', async () => {
		w.on('worktree_add', () => {
			throw appError('git', "a branch named 'agent/shuffle' already exists");
		});
		expect(await agents.start({ task: 'Add a shuffle button', branch: 'agent/shuffle', mode: 'acceptEdits' })).toBe(false);
		expect(agents.sessions()).toEqual([]);
		expect(starts()).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: "a branch named 'agent/shuffle' already exists" });
		expect(agents.busy()).toBe(false);
	});

	test('its title is the first line of the task, at most 80 characters; Claude gets all of it', async () => {
		const first = 'Make the queue wrap round to the first track when repeat is on and the last track has just ended';
		const s = await task({ task: `${first}\nKeep shuffle as it is.` });
		expect(s.title).toBe(first.slice(0, 80));
		expect(starts()[0].prompt).toBe(`${first}\nKeep shuffle as it is.`);
		expect(m.nameOf(s)).toBe(first.slice(0, 80));
	});

	test('a turn Claude Code would not start fails the session and says why in its transcript', async () => {
		w.on('agent_start', () => {
			throw appError('error', 'claude was not found on PATH');
		});
		const s = await task();
		expect(s.status).toBe('failed');
		expect(s.items.at(-1)).toEqual({ kind: 'error', text: 'claude was not found on PATH' });
		expect(m.stateOf(s)).toBe('failed');
		await agents.idle(s.id); // nothing is left waiting on a turn that never ran
	});
});

describe('parallel attempts', () => {
	beforeEach(() => boot());

	test('three attempts get branch, branch-2 and branch-3, one group, and the same first message each', async () => {
		await task({ attempts: 3 });
		const all = agents.sessions();
		expect(w.sent('worktree_add').map((c) => c.args.branch)).toEqual(['agent/shuffle', 'agent/shuffle-2', 'agent/shuffle-3']);
		expect(all.map((s) => s.branch)).toEqual(['agent/shuffle', 'agent/shuffle-2', 'agent/shuffle-3']);
		expect(all.map((s) => s.attempt)).toEqual([1, 2, 3]);
		expect(all[0].group).toBeTruthy();
		expect(new Set(all.map((s) => s.group)).size).toBe(1);
		expect(new Set(all.map((s) => s.cwd)).size).toBe(3);
		expect(starts().map((a) => [a.key, a.cwd, a.prompt])).toEqual(all.map((s) => [s.id, s.cwd, 'Add a shuffle button']));
		expect(agents.attempts(all[0].group!).map((s) => s.id)).toEqual(all.map((s) => s.id));
	});

	test('the group is on screen as a comparison; a single task is not', async () => {
		const one = await task({ branch: 'agent/one' });
		expect(agents.comparing()).toBeNull();
		expect(one.group).toBeNull();
		const first = await task({ branch: 'agent/two', attempts: 2 });
		expect(agents.comparing()).toBe(first.group);
	});

	test('more than three are three', async () => {
		await task({ attempts: 7 });
		expect(agents.sessions().length).toBe(3);
		expect(m.MAX_ATTEMPTS).toBe(3);
	});

	test.each([
		[0, 1],
		[-2, 1],
		[2.9, 2],
	])('%d attempts are %d', async (asked, made) => {
		await task({ attempts: asked });
		expect(agents.sessions().length).toBe(made);
		expect(w.sent('worktree_add').length).toBe(made);
	});

	test('without a branch there is one session, whatever was asked for', async () => {
		await task({ branch: '', attempts: 3 });
		expect(agents.sessions().length).toBe(1);
		expect(agents.sessions()[0].group).toBeNull();
		expect(starts().length).toBe(1);
	});

	test('when a later worktree cannot be made, the ones that were still run and the failure is said', async () => {
		w.on('worktree_add', (args) => {
			if (String(args.branch).endsWith('-2')) {
				throw appError('git', 'agent/shuffle-2 is already checked out');
			}
			return `/somewhere/${String(args.branch)}`;
		});
		expect(await agents.start({ task: 'Add a shuffle button', branch: 'agent/shuffle', mode: 'acceptEdits', attempts: 3 })).toBe(true);
		expect(agents.sessions().map((s) => s.branch)).toEqual(['agent/shuffle']);
		expect(agents.sessions()[0].group).toBeNull();
		expect(starts().length).toBe(1);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'agent/shuffle-2 is already checked out' });
	});

	test('the toast for an attempt says which one', async () => {
		await task({ attempts: 2 });
		const second = agents.sessions()[1];
		await done(second.id);
		expect(toasts('Agent finished').at(-1)?.message).toBe('Add a shuffle button (attempt 2)');
	});

	test('comparing a group counts its attempts as seen', async () => {
		await task({ attempts: 2 });
		const [a, b] = agents.sessions();
		await done(a.id);
		await done(b.id);
		expect(agents.unread()).toBe(2);
		agents.compare(a.group!);
		expect(agents.unread()).toBe(0);
		expect(agents.comparing()).toBe(a.group);
	});

	test('keeping one deletes the others\' worktrees and branches, forgets their sessions, and leaves an ordinary session', async () => {
		await task({ attempts: 3 });
		const [a, b, c] = agents.sessions();
		for (const s of [a, b, c]) {
			await done(s.id);
		}
		expect(await agents.keep(now(b))).toBe(true);
		expect(w.sent('worktree_remove').map((x) => x.args)).toEqual([
			{ id: repoId(), path: a.cwd, force: true, deleteBranch: true },
			{ id: repoId(), path: c.cwd, force: true, deleteBranch: true },
		]);
		expect(agents.sessions().map((s) => s.id)).toEqual([b.id]);
		expect(now(b)).toMatchObject({ group: null, attempt: 1 });
		expect(agents.comparing()).toBeNull();
		expect(agents.selectedId()).toBe(b.id);
		expect(written(a.id)).toBeNull();
		expect(written(c.id)).toBeNull();
		expect(agents.busy()).toBe(false);
	});

	test('an attempt still running is stopped, and its worktree goes only once its turn has ended', async () => {
		await task({ attempts: 2 });
		const [a, b] = agents.sessions();
		await done(a.id);
		const keeping = agents.keep(now(a));
		await tick();
		expect(w.sent('agent_stop').map((x) => x.args)).toEqual([{ key: b.id }]);
		expect(w.sent('worktree_remove')).toEqual([]);
		await done(b.id, false);
		expect(await keeping).toBe(true);
		expect(w.sent('worktree_remove').map((x) => x.args.path)).toEqual([b.cwd]);
	});

	test('an attempt whose worktree was already removed by hand is just forgotten', async () => {
		await task({ attempts: 2 });
		const [a, b] = agents.sessions();
		await done(a.id);
		await done(b.id);
		treeOf(b, null);
		expect(await agents.keep(now(a))).toBe(true);
		expect(w.sent('worktree_remove')).toEqual([]);
		expect(agents.sessions().map((s) => s.id)).toEqual([a.id]);
	});

	test('when a worktree cannot be removed, keeping stops there and its session is not forgotten', async () => {
		await task({ attempts: 2 });
		const [a, b] = agents.sessions();
		await done(a.id);
		await done(b.id);
		w.on('worktree_remove', () => {
			throw appError('git', 'the worktree is in use');
		});
		expect(await agents.keep(now(a))).toBe(false);
		expect(agents.sessions().map((s) => s.id)).toEqual([a.id, b.id]);
		expect(now(a).group).toBe(a.group);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'the worktree is in use' });
		expect(agents.busy()).toBe(false);
	});

	test('a session that is not one of several attempts cannot be kept', async () => {
		const s = await task();
		expect(await agents.keep(s)).toBe(false);
		expect(w.sent('worktree_remove')).toEqual([]);
	});

	test('removing one of two attempts leaves the other an ordinary session, and the comparison closes', async () => {
		await task({ attempts: 2 });
		const [a, b] = agents.sessions();
		await done(a.id);
		await done(b.id);
		await agents.remove(now(b), true);
		expect(agents.sessions().map((s) => s.id)).toEqual([a.id]);
		expect(now(a)).toMatchObject({ group: null, attempt: 1 });
		expect(agents.comparing()).toBeNull();
	});

	test('removing one of three leaves a comparison of two', async () => {
		await task({ attempts: 3 });
		const [a, b, c] = agents.sessions();
		for (const s of [a, b, c]) {
			await done(s.id);
		}
		await agents.remove(now(c), true);
		expect(now(a).group).toBe(a.group);
		expect(now(b).attempt).toBe(2);
		expect(agents.comparing()).toBe(a.group);
	});
});

describe('a pipeline task', () => {
	beforeEach(() => boot());

	const shipping = (p: Pipeline): Pipeline => ({ ...p, step: 'ship', waiting: true, note: 'Ready to ship', reason: 'ship' });

	test('gets one worktree whatever attempts says, and start sends no turn of its own', async () => {
		const s = await task({ attempts: 3, pipeline: newPipeline('bug') });
		expect(w.sent('worktree_add').length).toBe(1);
		expect(agents.sessions().length).toBe(1);
		expect(starts()).toEqual([]);
		expect(s).toMatchObject({ status: 'idle', isolated: true, task: 'Add a shuffle button', pipeline: { kind: 'bug', step: 'plan' } });
	});

	test('a step runs with its own mode, tools and model, and the brief is still asked for', async () => {
		const s = await task({ pipeline: newPipeline('bug') });
		await agents.send(s.id, 'Plan it', { turn: { mode: 'plan', tools: ['Read', 'Grep'], builtin: ['Read', 'Grep'], model: 'haiku' } });
		expect(starts()[0]).toMatchObject({ mode: 'plan', prompt: 'Plan it', options: { brief: true, images: [], tools: ['Read', 'Grep'], builtin: ['Read', 'Grep'], model: 'haiku' } });
		expect(now(s).mode).toBe('acceptEdits');
	});

	test('the end of one of its turns is not work to review and is not announced: the pipeline says where it stands', async () => {
		const s = await task({ pipeline: newPipeline('quick') });
		await agents.send(s.id, 'Write the code');
		treeOf(s, { changes: 3 });
		await done(s.id);
		expect(now(s).review).toBe(false);
		expect(toasts(/^Agent/)).toEqual([]);
	});

	test('it is working between Claude\'s turns, needs you while it waits, and is finished once done', async () => {
		const s = await task({ pipeline: newPipeline('bug') });
		expect(m.stateOf(now(s))).toBe('working');
		agents.patchPipeline(s.id, (p) => ({ ...p, waiting: true, note: 'Approve the plan', reason: 'approve' }));
		expect(m.stateOf(now(s))).toBe('review');
		expect(m.stateLabel(now(s))).toBe('Needs you');
		expect(m.summary(now(s))).toMatchObject({ asked: 'Add a shuffle button', now: null, needs: 'Approve the plan' });
		agents.patchPipeline(s.id, (p) => ({ ...p, step: 'done', waiting: false, note: null }));
		expect(m.stateOf(now(s))).toBe('finished');
	});

	test('patching a pipeline without touching leaves "how long ago" alone', async () => {
		const s = await task({ pipeline: newPipeline('bug') });
		await tick(5000);
		agents.patchPipeline(s.id, (p) => ({ ...p, pushed: 'Pushed.' }), false);
		expect(now(s).updated).toBe(s.updated);
		agents.patchPipeline(s.id, (p) => ({ ...p, pushed: 'Pushed again.' }));
		expect(now(s).updated).toBeGreaterThan(s.updated);
	});

	test('waiting to ship with its worktree gone, it has shipped; nothing is left to clean', async () => {
		const s = await task({ pipeline: newPipeline('bug') });
		const landed: string[] = [];
		agents.landed.set('test', (id) => landed.push(id));
		agents.patchPipeline(s.id, shipping);
		treeOf(s, null);
		await agents.loadWorktrees();
		expect(now(s).pipeline).toMatchObject({ step: 'done', waiting: false, note: null, steps: { ship: { state: 'done', summary: 'Its worktree was removed.' } } });
		expect(landed).toEqual([]);
	});

	test('waiting to ship with its work already in the main branch, it has shipped and the cleanup is told', async () => {
		const s = await task({ pipeline: newPipeline('bug') });
		const landed: string[] = [];
		agents.landed.set('test', (id) => landed.push(id));
		agents.patchPipeline(s.id, shipping);
		treeOf(s, { changes: 0, head: 'c'.repeat(40), landed: true });
		await agents.loadWorktrees();
		expect(now(s).pipeline).toMatchObject({ step: 'done', waiting: false, steps: { ship: { summary: 'Its work is in the main branch.' } } });
		expect(landed).toEqual([s.id]);
	});

	test.each([
		['its work is not in the main branch yet', { changes: 0, head: 'c'.repeat(40), landed: false }],
		['it has uncommitted work', { changes: 1, head: 'c'.repeat(40), landed: true }],
	])('waiting to ship while %s, it keeps waiting', async (_why, tree) => {
		const s = await task({ pipeline: newPipeline('bug') });
		agents.patchPipeline(s.id, shipping);
		treeOf(s, tree);
		await agents.loadWorktrees();
		expect(now(s).pipeline).toMatchObject({ step: 'ship', waiting: true });
	});

	test('merged from here, it is done and the cleanup is told; the merge dialog\'s own cleanup stays out of it', async () => {
		const s = await task({ pipeline: newPipeline('bug') });
		const landed: string[] = [];
		agents.landed.set('test', (id) => landed.push(id));
		agents.patchPipeline(s.id, shipping);
		treeOf(s, { changes: 0, head: 'c'.repeat(40) });
		expect(await agents.merge(now(s), repos.status()!.branch!, null, true)).toBe(true);
		expect(now(s).pipeline).toMatchObject({ step: 'done', waiting: false, steps: { ship: { state: 'done', summary: `Merged into ${repos.status()!.branch}.` } } });
		expect(landed).toEqual([s.id]);
		expect(w.sent('worktree_remove')).toEqual([]);
	});

	test('marked done, it is done', async () => {
		const s = await task({ pipeline: newPipeline('bug') });
		agents.patchPipeline(s.id, shipping);
		agents.markDone(s.id);
		expect(now(s).pipeline).toMatchObject({ step: 'done', waiting: false, note: null });
		expect(m.stateOf(now(s))).toBe('finished');
	});
});

// ---- questions ---------------------------------------------------------------

describe('a question', () => {
	beforeEach(() => boot());

	test('runs in the checkout on screen, read-only, and makes no worktree', async () => {
		expect(await agents.ask('  Where is the queue advanced?  ')).toBe(true);
		const s = agents.sessions()[0];
		expect(w.sent('worktree_add')).toEqual([]);
		expect(s).toMatchObject({ kind: 'ask', mode: 'default', isolated: false, cwd: repos.repo()!.path, tools: ['Read', 'Grep', 'Glob'], status: 'running' });
		expect(starts()).toEqual([{ id: repoId(), cwd: repos.repo()!.path, key: s.id, prompt: m.askPrompt('code', 'Where is the queue advanced?'), mode: 'default', resume: null, options: { tools: ['Read', 'Grep', 'Glob'], builtin: ['Read', 'Grep', 'Glob'], lean: true, images: [] } }]);
		// The transcript shows the question, not the rules that went with it.
		expect(s.items).toEqual([{ kind: 'user', text: 'Where is the queue advanced?' }]);
		expect(m.scopeOf(s)).toBe('code');
	});

	test('about history it may also run git log, show, diff and blame, and Bash is the only tool added', async () => {
		await agents.ask('When did repeat arrive?', 'history');
		const sent = options(starts()[0]);
		expect(sent.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git blame:*)']);
		expect(sent.builtin).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
		expect(starts()[0].mode).toBe('default');
		expect(String(starts()[0].prompt).split('\n')[0]).toBe('[ask-history]');
		expect(m.scopeOf(agents.sessions()[0])).toBe('history');
	});

	test('a follow-up sends only the question, with the same rules, into the same conversation', async () => {
		await agents.ask('When did repeat arrive?', 'history');
		const s = agents.sessions()[0];
		started(s.id, 'conversation-1');
		await done(s.id);
		await agents.send(s.id, 'And who wrote it?');
		expect(starts()[1]).toMatchObject({ prompt: 'And who wrote it?', resume: 'conversation-1', mode: 'default', options: { tools: m.ASK_TOOLS.history, builtin: ['Read', 'Grep', 'Glob', 'Bash'], lean: true } });
		expect(options(starts()[1]).brief).toBeUndefined();
	});

	test('its answer is never work to review, and a brief block in it stays text', async () => {
		await agents.ask('Where is the queue advanced?');
		const s = agents.sessions()[0];
		say(s.id, text(`In \`src/player/queue.ts:12\`.\n\n${BRIEF}`));
		await done(s.id);
		expect(now(s)).toMatchObject({ status: 'idle', review: false, unread: true, brief: null, name: null });
		expect(now(s).items.at(-1)!.text).toContain('```brief');
		expect(toasts('Answer ready').length).toBe(1);
		expect(m.summary(now(s)).needs).toBe('Read the answer');
		expect(check).not.toHaveBeenCalled();
	});

	test('an empty question asks nothing', async () => {
		expect(await agents.ask('   ')).toBe(false);
		expect(agents.sessions()).toEqual([]);
	});

	test('answers false when Claude Code could not be started', async () => {
		w.on('agent_start', () => {
			throw appError('error', 'claude was not found on PATH');
		});
		expect(await agents.ask('Where is the queue advanced?')).toBe(false);
		expect(agents.sessions()[0].status).toBe('failed');
	});

	test('with a worktree on screen it is asked there', async () => {
		const s = await task();
		await done(s.id);
		await agents.view(s.cwd);
		await agents.ask('What did it change?');
		expect(starts().at(-1)!.cwd).toBe(s.cwd);
		expect(w.sent('worktree_add').length).toBe(1);
	});

	test('images go with the question', async () => {
		await agents.ask('What is wrong on this screen?', 'code', [image()]);
		expect(options(starts()[0]).images).toEqual(['shot-1.png']);
	});
});

describe('the box for a new question', () => {
	beforeEach(() => boot());

	test('opens on the Agents tab with what was already typed', () => {
		repos.setTab('changes');
		agents.openAsk('code', 'What does next() do?');
		expect(repos.tab()).toBe('agents');
		expect(agents.asking()).toEqual({ scope: 'code', seed: 'What does next() do?' });
		expect(agents.selectedId()).toBeNull();
		expect(agents.historyChat()).toBeNull();
	});

	test('a history question started from the History tab opens its box there', () => {
		repos.setTab('history');
		agents.openAsk('history', 'Why was seek changed?');
		expect(repos.tab()).toBe('history');
		expect(agents.historyChat()).toEqual({ id: null, open: true });
		expect(agents.docked()).toEqual({ id: null, open: true });
		expect(agents.asking()).toEqual({ scope: 'history', seed: 'Why was seek changed?' });
	});

	// A bug until 2026-11-23 (agents.store.ts, `ask`, with `select`).
	// What holds now: a history question asked from the History tab stays there, its session docked in that tab's
	// main pane (`historyChat` becomes `{ id: <session>, open: true }`), as the comment on `historyChat` says.
	// Before the fix: `ask` calls `select(session.id)` first, which sees an open chat whose id (null, the box) is not
	// the session's and sets `historyChat` to null; the check `this.historyChat()?.open` that follows is then
	// never true, so the session is not docked and the History tab goes back to showing a commit.
	test('a history question asked from the History tab stays there, with its session docked', async () => {
		repos.setTab('history');
		agents.openAsk('history');
		await agents.ask('Why was seek changed?', 'history');
		const s = agents.sessions()[0];
		expect(agents.historyChat()).toEqual({ id: s.id, open: true });
		expect(agents.docked()).toEqual({ id: s.id, open: true });
	});

	test('a question about the code asked while the History tab has its box open is not docked there', async () => {
		repos.setTab('history');
		agents.openAsk('history');
		await agents.ask('Where is the queue advanced?', 'code');
		expect(agents.historyChat()).toBeNull();
	});

	/** A history question in the History tab's main pane (set by hand). */
	async function dockedQuestion(): Promise<AgentSession> {
		repos.setTab('history');
		await agents.ask('Why was seek changed?', 'history');
		const s = agents.sessions()[0];
		agents.historyChat.set({ id: s.id, open: true });
		return s;
	}

	test('a docked question can be hidden for a commit and brought back', async () => {
		const s = await dockedQuestion();
		agents.hideHistoryChat();
		expect(agents.historyChat()).toEqual({ id: s.id, open: false });
		agents.showHistoryChat();
		expect(agents.historyChat()).toEqual({ id: s.id, open: true });
		expect(agents.selectedId()).toBe(s.id);
	});

	test('hiding the box before anything was asked closes it', () => {
		repos.setTab('history');
		agents.openAsk('history');
		agents.hideHistoryChat();
		expect(agents.historyChat()).toBeNull();
		expect(agents.asking()).toBeNull();
	});

	test('a turn that ends while its docked question is on screen is seen, not unread; hidden behind a commit it is unread', async () => {
		const s = await dockedQuestion();
		await done(s.id);
		expect(now(s).unread).toBe(false);
		expect(toasts('Answer ready')).toEqual([]);
		await agents.send(s.id, 'And before that?');
		agents.hideHistoryChat();
		await done(s.id);
		expect(now(s).unread).toBe(true);
		expect(toasts('Answer ready').length).toBe(1);
	});

	test('showing another session takes the docked one out of the main pane, to come back to', async () => {
		const s = await dockedQuestion();
		const other = await task();
		expect(agents.selectedId()).toBe(other.id);
		expect(agents.historyChat()).toEqual({ id: s.id, open: false });
	});

	test('a docked question of another repository is not this one\'s, and one whose session is gone is not docked', async () => {
		const s = await dockedQuestion();
		expect(agents.docked()).toEqual({ id: s.id, open: true });
		await repos.selectRepo(otherRepo());
		expect(agents.docked()).toBeNull();
		await repos.selectRepo(s.repoId);
		await done(s.id);
		await agents.remove(now(s), false);
		expect(agents.docked()).toBeNull();
	});

	test('selecting a session closes the box', async () => {
		const s = await task();
		agents.openAsk('code');
		agents.select(s.id);
		expect(agents.asking()).toBeNull();
	});
});

// ---- sending -----------------------------------------------------------------

describe('sending a message', () => {
	beforeEach(() => boot());

	test('with no words and no image nothing is sent', async () => {
		const s = await task();
		await done(s.id);
		await agents.send(s.id, '   ');
		expect(starts().length).toBe(1);
		expect(now(s).status).toBe('idle');
	});

	test('nothing is sent while a turn is running', async () => {
		const s = await task();
		await agents.send(s.id, 'And a test for it');
		expect(starts().length).toBe(1);
		expect(now(s).items.length).toBe(1);
	});

	test('a message for a session that does not exist goes nowhere', async () => {
		await agents.send('no-such-session', 'Hello');
		expect(starts()).toEqual([]);
	});

	test('a later turn carries on Claude Code\'s own conversation', async () => {
		const s = await task();
		started(s.id, 'conversation-1');
		await done(s.id);
		await agents.send(s.id, 'And a test for it');
		expect(starts()[1]).toMatchObject({ key: s.id, cwd: s.cwd, prompt: 'And a test for it', resume: 'conversation-1', options: { brief: true } });
	});

	test('the conversation id a result names is the one resumed', async () => {
		const s = await task();
		started(s.id, 'conversation-1');
		result(s.id, { session_id: 'conversation-2' });
		await done(s.id);
		await agents.send(s.id, 'Again');
		expect(starts()[1].resume).toBe('conversation-2');
	});

	test('a new turn clears the last brief, the language servers\' verdict, unread and stopped', async () => {
		check.mockResolvedValue({ ...NO_SERVERS, servers: ['TypeScript'], problems: [problem()], files: 1 });
		const s = await reviewable({}, `Done.\n\n${BRIEF}`);
		expect(now(s)).toMatchObject({ unread: true, brief: { needs: 'Should it also shuffle the queue that is playing?' }, check: { state: 'done' } });
		await agents.send(s.id, 'Yes');
		expect(now(s)).toMatchObject({ status: 'running', unread: false, stopped: false, brief: null, check: null });
		// The name it got from its first brief stays.
		expect(now(s).name).toBe('Shuffle button');
	});

	test('the session\'s model goes with every turn, and a turn\'s own model wins for that turn', async () => {
		const s = await task();
		expect(options(starts()[0]).model).toBeUndefined();
		await done(s.id);
		agents.setModel(s.id, 'opus');
		await agents.send(s.id, 'Two');
		await done(s.id);
		await agents.send(s.id, 'Three', { turn: { model: 'haiku' } });
		await done(s.id);
		agents.setModel(s.id, '');
		await agents.send(s.id, 'Four');
		expect(starts().map((a) => options(a).model)).toEqual([undefined, 'opus', 'haiku', undefined]);
		expect(now(s).model).toBeNull();
	});

	test('a changed permission mode is what later turns run in', async () => {
		const s = await task();
		await done(s.id);
		agents.setMode(s.id, 'plan');
		await agents.send(s.id, 'Think about it first');
		expect(starts()[1].mode).toBe('plan');
	});

	test('changing mode or model is not activity', async () => {
		const s = await task();
		await done(s.id);
		const before = now(s).updated;
		await tick(60_000);
		agents.setMode(s.id, 'plan');
		agents.setModel(s.id, 'opus');
		expect(now(s).updated).toBe(before);
		await agents.send(s.id, 'Go on');
		expect(now(s).updated).toBeGreaterThan(before);
	});

	test('what the transcript shows can be other words than what Claude is sent', async () => {
		const s = await task();
		await done(s.id);
		await agents.send(s.id, 'A long prompt with rules', { shown: 'Asked Claude to tidy up.' });
		expect(now(s).items.at(-1)).toEqual({ kind: 'user', text: 'Asked Claude to tidy up.' });
		expect(starts()[1].prompt).toBe('A long prompt with rules');
	});

	test('a turn that could not be started is a failed one, and whoever waits for it is let go', async () => {
		const s = await task();
		await done(s.id);
		w.on('agent_start', () => {
			throw appError('error', 'No such session');
		});
		await agents.send(s.id, 'Again');
		expect(now(s).status).toBe('failed');
		expect(now(s).items.at(-1)).toEqual({ kind: 'error', text: 'No such session' });
		let free = false;
		void agents.idle(s.id).then(() => (free = true));
		await tick();
		expect(free).toBe(true);
	});
});

describe('images with a message', () => {
	beforeEach(async () => {
		await boot();
		// The web view decodes an image; here anything "decodes" to a small one.
		vi.stubGlobal('createImageBitmap', async () => ({ width: 40, height: 30, close: () => undefined }));
	});

	const png = (): Blob => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3])], { type: 'image/png' });
	const attach = async (box: string, files: Blob[]): Promise<void> => {
		const adding = agents.attach(box, files);
		await tick(50);
		await adding;
	};

	test('an image added to a box waits there, under a name of ours, until it is taken', async () => {
		await attach(m.DRAFT_IMAGES.task, [png()]);
		const waiting = agents.attached()[m.DRAFT_IMAGES.task];
		expect(waiting.length).toBe(1);
		expect(waiting[0]).toMatchObject({ mediaType: 'image/png' });
		expect(waiting[0].name).toMatch(/^[0-9a-f-]{36}\.png$/);
		expect(waiting[0].url).toBe(`data:image/png;base64,${waiting[0].data}`);
		expect(agents.takeAttached(m.DRAFT_IMAGES.task)).toEqual(waiting);
		expect(agents.takeAttached(m.DRAFT_IMAGES.task)).toEqual([]);
		expect(agents.attaching()[m.DRAFT_IMAGES.task]).toBe(0);
	});

	test('each box keeps its own', async () => {
		await attach('one', [png()]);
		await attach('two', [png(), png()]);
		expect(agents.attached().one.length).toBe(1);
		expect(agents.attached().two.length).toBe(2);
	});

	test('a message takes ten at most: the rest are left out and that is said', async () => {
		await attach('box', Array.from({ length: 12 }, png));
		expect(agents.attached().box.length).toBe(10);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'info', title: 'A message takes 10 images at most', message: 'Only the first 10 were added.' });
		await attach('box', [png()]);
		expect(agents.attached().box.length).toBe(10);
		expect(w.toasts.at(-1)).toMatchObject({ message: 'Send these first.' });
	});

	test('one taken off leaves the others', async () => {
		await attach('box', [png(), png()]);
		const [first, second] = agents.attached().box;
		agents.detach('box', first.name);
		expect(agents.attached().box).toEqual([second]);
	});

	test('something that cannot be read as an image is refused in words, and the others still go in', async () => {
		let n = 0;
		vi.stubGlobal('createImageBitmap', async () => {
			if (++n === 1) {
				throw new Error('not decodable');
			}
			return { width: 40, height: 30, close: () => undefined };
		});
		await attach('box', [new Blob(['plain text']), png()]);
		expect(agents.attached().box.length).toBe(1);
		expect(toasts('That image was not added').length).toBe(1);
		expect(agents.attaching().box).toBe(0);
	});

	test('a file dropped from outside is read by the native side; one it refuses is said and the rest go in', async () => {
		w.on('agent_image_file', (args) => {
			if (String(args.path).endsWith('.txt')) {
				throw appError('error', 'notes.txt is not an image');
			}
			return { mediaType: 'image/png', data: 'iVBORw0KGgoAAAAAAAAAAA==' };
		});
		const adding = agents.attachFiles('box', ['/Users/me/Desktop/notes.txt', '/Users/me/Desktop/shot.png']);
		await tick(50);
		await adding;
		expect(w.sent('agent_image_file').map((c) => c.args.path)).toEqual(['/Users/me/Desktop/notes.txt', '/Users/me/Desktop/shot.png']);
		expect(agents.attached().box.length).toBe(1);
		expect(w.toasts).toContainEqual({ kind: 'error', title: 'That file was not added', message: 'notes.txt is not an image' });
	});

	test('images are saved in the session\'s folder first, and Claude Code is given their names only', async () => {
		const s = await task();
		await done(s.id);
		w.calls.length = 0;
		await agents.send(s.id, 'Like this screenshot', { images: [image('a.png'), image('b.png')] });
		expect(w.sent('agent_image_save').map((c) => c.args)).toEqual([
			{ id: s.id, name: 'a.png', data: 'QUJDRA==' },
			{ id: s.id, name: 'b.png', data: 'QUJDRA==' },
		]);
		const order = w.calls.map((c) => c.cmd);
		expect(order.lastIndexOf('agent_image_save')).toBeLessThan(order.indexOf('agent_start'));
		expect(options(starts()[0]).images).toEqual(['a.png', 'b.png']);
		expect(JSON.stringify(starts()[0])).not.toContain('QUJDRA==');
		expect(now(s).items.at(-1)).toEqual({ kind: 'user', text: 'Like this screenshot', images: ['a.png', 'b.png'] });
	});

	test('an image alone is a message', async () => {
		const s = await task();
		await done(s.id);
		await agents.send(s.id, '', { images: [image()] });
		expect(starts()[1]).toMatchObject({ prompt: '', options: { images: ['shot-1.png'] } });
		expect(now(s).status).toBe('running');
	});

	test('every attempt gets the task\'s images in its own folder', async () => {
		await task({ attempts: 2, images: [image()] });
		const [a, b] = agents.sessions();
		expect(w.sent('agent_image_save').map((c) => c.args.id)).toEqual(expect.arrayContaining([a.id, b.id]));
		expect(starts().map((x) => options(x).images)).toEqual([['shot-1.png'], ['shot-1.png']]);
	});

	test('an image that cannot be saved fails the turn before Claude Code is started', async () => {
		const s = await task();
		await done(s.id);
		w.on('agent_image_save', () => {
			throw appError('error', 'The disk is full');
		});
		await agents.send(s.id, 'See this', { images: [image()] });
		expect(starts().length).toBe(1);
		expect(now(s).status).toBe('failed');
		expect(now(s).items.at(-1)).toEqual({ kind: 'error', text: 'The disk is full' });
	});

	test('a transcript\'s image is read once: nothing until it is there, then an address an <img> can show', async () => {
		w.on('agent_image_read', () => 'SU1BR0U=');
		expect(agents.shot('s1', 'a.jpg')).toBeNull();
		expect(agents.shot('s1', 'a.jpg')).toBeNull();
		await tick();
		expect(agents.shot('s1', 'a.jpg')).toBe('data:image/jpeg;base64,SU1BR0U=');
		expect(w.sent('agent_image_read').map((c) => c.args)).toEqual([{ id: 's1', name: 'a.jpg' }]);
	});

	test('an image whose file is gone is empty, not forever loading', async () => {
		w.on('agent_image_read', () => {
			throw appError('error', 'No such file');
		});
		expect(agents.shot('s1', 'gone.png')).toBeNull();
		await tick();
		expect(agents.shot('s1', 'gone.png')).toBe('');
	});

	test('only one session\'s images are kept: asking for another\'s lets the last one\'s go', async () => {
		w.on('agent_image_read', () => 'SU1BR0U=');
		agents.shot('s1', 'a.png');
		await tick();
		agents.shot('s2', 'b.png');
		await tick();
		expect(agents.shot('s1', 'a.png')).toBeNull();
		await tick();
		expect(w.sent('agent_image_read').length).toBe(3);
	});

	test('an answer for a session that is no longer the one on screen is not kept for the one that is', async () => {
		let release!: (data: string) => void;
		w.on('agent_image_read', (args) => (args.id === 's1' ? new Promise<string>((r) => (release = r)) : 'T1RIRVI='));
		agents.shot('s1', 'same.png');
		await tick();
		agents.shot('s2', 'same.png');
		await tick();
		release('TEFURQ==');
		await tick();
		expect(agents.shot('s2', 'same.png')).toBe('data:image/png;base64,T1RIRVI=');
	});

	test('an image just sent from the session on screen is shown without being read back', async () => {
		const s = await task();
		await done(s.id);
		w.on('agent_image_read', () => 'T0xE');
		agents.shot(s.id, 'earlier.png');
		await tick();
		await agents.send(s.id, 'And this', { images: [image('new.png')] });
		expect(agents.shot(s.id, 'new.png')).toBe('data:image/png;base64,QUJDRA==');
		expect(w.sent('agent_image_read').map((c) => c.args.name)).toEqual(['earlier.png']);
	});
});

// ---- events ------------------------------------------------------------------

describe('what Claude Code says', () => {
	beforeEach(() => boot());

	test('text and tool calls join the transcript in the order they came', async () => {
		const s = await task();
		say(s.id, text('I will look at the queue first.'));
		say(s.id, tool('Read', { file_path: 'src/player/queue.ts' }), tool('Edit', { file_path: 'src/player/queue.ts' }));
		say(s.id, text('Done.'));
		expect(now(s).items.slice(1)).toEqual<AgentItem[]>([
			{ kind: 'text', text: 'I will look at the queue first.' },
			{ kind: 'tool', text: 'Read', detail: 'src/player/queue.ts' },
			{ kind: 'tool', text: 'Edit', detail: 'src/player/queue.ts' },
			{ kind: 'text', text: 'Done.' },
		]);
	});

	test('a tool call shows what it acted on: one line, the file before the command, cut to size', async () => {
		const s = await task();
		say(s.id, tool('Bash', { command: 'npm test\n-- queue', description: 'Run the queue tests\nand nothing else' }));
		say(s.id, tool('Write', { command: 'ignored', file_path: 'src/a.ts' }));
		say(s.id, tool('Grep', { pattern: 'x'.repeat(300) }));
		say(s.id, tool('TodoWrite', { todos: [] }));
		const [bash, write, grep, todo] = now(s).items.slice(1);
		expect(bash).toEqual({ kind: 'tool', text: 'Bash', detail: 'npm test', about: 'Run the queue tests' });
		expect(write).toEqual({ kind: 'tool', text: 'Write', detail: 'src/a.ts' });
		expect(grep.detail).toBe('x'.repeat(200));
		expect(todo).toEqual({ kind: 'tool', text: 'TodoWrite', detail: undefined });
	});

	test('while it runs, lists say its latest step in words: a Bash call in Claude\'s own', async () => {
		const s = await task();
		say(s.id, tool('Edit', { file_path: 'src/player/queue.ts' }));
		expect(m.summary(now(s)).now).toBe('Editing player/queue.ts');
		say(s.id, tool('Bash', { command: 'npm test', description: 'Run the queue tests' }));
		expect(m.summary(now(s))).toMatchObject({ asked: 'Add a shuffle button', now: 'Run the queue tests', needs: null });
	});

	test('blank text and messages with nothing to show add nothing', async () => {
		const s = await task();
		say(s.id, text('  \n '));
		say(s.id);
		say(s.id, { type: 'thinking', thinking: 'hm' });
		expect(now(s).items.length).toBe(1);
	});

	test('a task\'s brief is taken out of its reply and kept beside it', async () => {
		const s = await task();
		say(s.id, text(`Added the button in \`src/ui/transport.ts\`.\n\n${BRIEF}`));
		const brief = { title: 'Shuffle button', did: 'Added the button and its test.', needs: 'Should it also shuffle the queue that is playing?', choices: ['Yes', 'No'] };
		expect(now(s).items.at(-1)).toEqual({ kind: 'text', text: 'Added the button in `src/ui/transport.ts`.', brief });
		expect(now(s).brief).toEqual(brief);
		expect(now(s).name).toBe('Shuffle button');
		expect(m.nameOf(now(s))).toBe('Shuffle button');
	});

	test('the name comes from the first brief and stays when a later one is titled otherwise', async () => {
		const s = await task();
		say(s.id, text(BRIEF));
		await done(s.id);
		await agents.send(s.id, 'Yes');
		say(s.id, text('```brief\ntitle: Something else entirely\ndid: Shuffled the playing queue too.\nneeds: nothing\n```'));
		expect(now(s).name).toBe('Shuffle button');
		expect(now(s).brief).toEqual({ title: 'Something else entirely', did: 'Shuffled the playing queue too.', needs: null, choices: [] });
	});

	test('a reply without a brief leaves the last one of this turn standing', async () => {
		const s = await task();
		say(s.id, text(BRIEF));
		say(s.id, text('One more thing: the icon is a placeholder.'));
		expect(now(s).brief?.did).toBe('Added the button and its test.');
		expect(now(s).items.at(-1)).toEqual({ kind: 'text', text: 'One more thing: the icon is a placeholder.' });
	});

	test('the first init names Claude Code\'s conversation', async () => {
		const s = await task();
		expect(now(s).sessionId).toBeNull();
		started(s.id, 'conversation-1');
		expect(now(s).sessionId).toBe('conversation-1');
	});

	test('the cost a result reports is the session\'s running total, not something to add up', async () => {
		const s = await task();
		result(s.id, { total_cost_usd: 0.1 });
		await done(s.id);
		await agents.send(s.id, 'More');
		result(s.id, { total_cost_usd: 0.25 });
		expect(now(s).cost).toBe(0.25);
		result(s.id, {});
		expect(now(s).cost).toBe(0.25);
	});

	test('a result that is an error is in the transcript in Claude Code\'s words', async () => {
		const s = await task();
		result(s.id, { is_error: true, result: 'Credit balance is too low' });
		expect(now(s).items.at(-1)).toEqual({ kind: 'error', text: 'Credit balance is too low' });
		result(s.id, { is_error: true });
		expect(now(s).items.at(-1)).toEqual({ kind: 'error', text: 'The agent stopped with an error.' });
	});

	test('events on the same channel that belong to no session (one-shot questions) change nothing and write nothing', async () => {
		const s = await task();
		await tick(1000);
		const before = agents.sessions();
		const writes = w.sent('agent_session_save').length;
		say('one-shot-question', text('A commit message'));
		result('one-shot-question', { total_cost_usd: 0.01 });
		await done('one-shot-question');
		await tick(1000);
		expect(agents.sessions()).toBe(before);
		expect(w.sent('agent_session_save').length).toBe(writes);
		expect(w.toasts).toEqual([]);
		expect(now(s).status).toBe('running');
	});
});

describe('a turn ending', () => {
	beforeEach(() => boot());

	test('a task that changed something needs the user: work to review, unread, and a toast that names it', async () => {
		const s = await reviewable({}, `Done.\n\n${BRIEF}`);
		expect(s).toMatchObject({ status: 'idle', review: true, unread: true, stopped: false });
		expect(m.stateOf(s)).toBe('review');
		expect(m.stateLabel(s)).toBe('Needs review');
		expect(toasts('Agent finished')).toEqual([{ kind: 'success', title: 'Agent finished', message: 'Shuffle button' }]);
		expect(agents.unread()).toBe(1);
		expect(agents.running()).toBe(0);
	});

	test('with the session on screen it is neither unread nor announced', async () => {
		const s = await task();
		repos.setTab('agents');
		treeOf(s, { changes: 2 });
		await done(s.id);
		expect(now(s)).toMatchObject({ review: true, unread: false });
		expect(w.toasts).toEqual([]);
	});

	test('selected but on another tab is not on screen', async () => {
		const s = await task();
		repos.setTab('changes');
		await done(s.id);
		expect(now(s).unread).toBe(true);
	});

	test('with the box for a new question over it, it is not on screen', async () => {
		const s = await task();
		repos.setTab('agents');
		agents.asking.set({ scope: 'code', seed: '' });
		await done(s.id);
		expect(now(s).unread).toBe(true);
	});

	test('while its group is being compared every attempt is on screen', async () => {
		await task({ attempts: 2 });
		const [, b] = agents.sessions();
		repos.setTab('agents');
		await done(b.id);
		expect(now(b).unread).toBe(false);
	});

	test('a failure is a failed session with the reason in its transcript, and the toast says what went wrong', async () => {
		const s = await task();
		treeOf(s, { changes: 2 });
		await done(s.id, false, 'The API key is not valid');
		expect(now(s)).toMatchObject({ status: 'failed', review: false, unread: true });
		expect(now(s).items.at(-1)).toEqual({ kind: 'error', text: 'The API key is not valid' });
		expect(m.stateOf(now(s))).toBe('failed');
		expect(m.summary(now(s))).toMatchObject({ did: 'The API key is not valid', needs: 'It failed: read what went wrong' });
		expect(toasts('Agent failed')).toEqual([{ kind: 'error', title: 'Agent failed', message: 'Add a shuffle button: The API key is not valid' }]);
		expect(check).not.toHaveBeenCalled();
	});

	test('a failure with no reason given still says something', async () => {
		const s = await task();
		await done(s.id, false);
		expect(now(s).items.at(-1)).toEqual({ kind: 'error', text: 'Claude Code exited with an error.' });
	});

	test('a plan changes nothing: no work to review, and the language servers are not asked', async () => {
		const s = await task({ mode: 'plan' });
		treeOf(s, { changes: 2 });
		await done(s.id);
		expect(now(s)).toMatchObject({ status: 'idle', review: false });
		expect(check).not.toHaveBeenCalled();
	});

	test('work that was waiting for review still waits after a later turn that was only a plan', async () => {
		const s = await reviewable();
		agents.setMode(s.id, 'plan');
		await agents.send(s.id, 'What would you do next?');
		await done(s.id);
		expect(now(s).review).toBe(true);
	});

	test('in the open repository the status and the worktrees are read again at once', async () => {
		const s = await task();
		const before = { status: w.sent('repo_status').length, trees: w.sent('worktree_list').length };
		await done(s.id);
		expect(w.sent('repo_status').length).toBeGreaterThan(before.status);
		expect(w.sent('worktree_list').length).toBeGreaterThan(before.trees);
	});

	test('in another repository the toast says which, and the one on screen is left as it is', async () => {
		const s = await task();
		const name = repos.repo()!.name;
		await repos.selectRepo(otherRepo());
		await tick();
		const before = { status: w.sent('repo_status').length, trees: w.sent('worktree_list').length };
		await done(s.id);
		expect(toasts(`Agent finished · ${name}`).length).toBe(1);
		expect(now(s).unread).toBe(true);
		expect(w.sent('repo_status').length).toBe(before.status);
		expect(w.sent('worktree_list').length).toBe(before.trees);
		expect(agents.current()).toEqual([]);
		expect(agents.unread()).toBe(1);
	});

	test('whoever listens for turns ending is told which, how it went and whether it was stopped', async () => {
		const ended: unknown[][] = [];
		agents.turnEnded.set('test', (...args) => ended.push(args));
		const a = await task({ branch: 'agent/a' });
		const b = await task({ branch: 'agent/b' });
		const c = await task({ branch: 'agent/c' });
		await done(a.id);
		await done(b.id, false, 'boom');
		await agents.stop(c.id);
		await done(c.id, false);
		expect(ended).toEqual([
			[a.id, true, false],
			[b.id, false, false],
			[c.id, false, true],
		]);
	});

	test('idle resolves when the turn has ended, and at once when none is running', async () => {
		const s = await task();
		let free = false;
		void agents.idle(s.id).then(() => (free = true));
		await tick(60_000);
		expect(free).toBe(false);
		await done(s.id);
		expect(free).toBe(true);
		await agents.idle(s.id);
		await agents.idle('no-such-session');
	});

	test('idle with a limit gives up waiting after it', async () => {
		const s = await task();
		let free = false;
		void agents.idle(s.id, 4000).then(() => (free = true));
		await tick(3999);
		expect(free).toBe(false);
		await tick(1);
		expect(free).toBe(true);
	});

	test('showing a session counts it as seen, which is not activity', async () => {
		const s = await reviewable();
		const before = s.updated;
		await tick(60_000);
		agents.select(s.id);
		expect(now(s).unread).toBe(false);
		expect(now(s).updated).toBe(before);
		expect(now(s).review).toBe(true);
		// Shown again, there is nothing new to note or to write.
		await tick();
		const writes = saves(s.id).length;
		agents.select(s.id);
		await tick();
		expect(saves(s.id).length).toBe(writes);
	});

	test('an open-ended task is never committed or pushed by the app: the user reviews, commits, then merges', async () => {
		await reviewable({}, `Done.\n\n${BRIEF}`);
		expect(w.calls.filter((c) => /commit|push/.test(c.cmd))).toEqual([]);
	});

	test('starting the store again does not listen twice', async () => {
		await agents.init();
		await agents.init();
		const s = await task();
		say(s.id, text('Once.'));
		expect(now(s).items.length).toBe(2);
		treeOf(s, { changes: 1 });
		await done(s.id);
		expect(toasts('Agent finished').length).toBe(1);
	});

	test('the end of a turn for a session that was removed meanwhile does nothing', async () => {
		const s = await task({ branch: '' });
		await agents.stop(s.id);
		await done(s.id, false);
		await agents.remove(now(s), false);
		const toastsBefore = w.toasts.length;
		await done(s.id);
		expect(agents.sessions()).toEqual([]);
		expect(w.toasts.length).toBe(toastsBefore);
	});
});

describe('stopping', () => {
	beforeEach(() => boot());

	test('shows at once and tells Claude Code', async () => {
		const s = await task();
		await agents.stop(s.id);
		expect(now(s)).toMatchObject({ status: 'idle', stopped: true });
		expect(now(s).items.at(-1)).toEqual({ kind: 'error', text: 'Stopped.' });
		expect(w.sent('agent_stop').map((c) => c.args)).toEqual([{ key: s.id }]);
		expect(m.stateOf(now(s))).toBe('stopped');
		expect(m.stateLabel(now(s))).toBe('Stopped');
		expect(m.summary(now(s)).did).toBe('Stopped by hand.');
	});

	test('the end of a stopped turn is not a failure, not unread, not work to review, and is not announced or checked', async () => {
		const s = await task();
		treeOf(s, { changes: 2 });
		await agents.stop(s.id);
		const items = now(s).items.length;
		await done(s.id, false, 'killed');
		expect(now(s)).toMatchObject({ status: 'idle', stopped: true, unread: false, review: false });
		expect(now(s).items.length).toBe(items);
		expect(w.toasts).toEqual([]);
		expect(check).not.toHaveBeenCalled();
	});

	test('a stop the native side refuses is still a stop here', async () => {
		const s = await task();
		w.on('agent_stop', () => {
			throw appError('error', 'No such process');
		});
		await agents.stop(s.id);
		expect(now(s)).toMatchObject({ status: 'idle', stopped: true });
		expect(w.toasts).toEqual([]);
	});

	test('the next message carries on from where it was stopped', async () => {
		const s = await task();
		started(s.id, 'conversation-1');
		await agents.stop(s.id);
		await done(s.id, false);
		await agents.send(s.id, 'Carry on');
		expect(now(s)).toMatchObject({ status: 'running', stopped: false });
		expect(starts()[1].resume).toBe('conversation-1');
	});
});

// ---- saving and restoring ----------------------------------------------------

describe('saving', () => {
	beforeEach(() => boot());

	test('a new session is written at once, as JSON of the whole session', async () => {
		const s = await task();
		const first = JSON.parse(String(saves(s.id)[0].session)) as AgentSession;
		expect(first).toMatchObject({ id: s.id, repoId: repoId(), cwd: s.cwd, title: 'Add a shuffle button', kind: 'task' });
	});

	test('while a turn streams, its events are one write per half second', async () => {
		const s = await task();
		await tick(500);
		const before = saves(s.id).length;
		for (let i = 0; i < 20; i++) {
			say(s.id, text(`Step ${i}`));
			await tick(20);
		}
		expect(saves(s.id).length).toBe(before);
		await tick(100);
		expect(saves(s.id).length).toBe(before + 1);
		expect(written(s.id)!.items.length).toBe(21);
		for (let i = 0; i < 20; i++) {
			say(s.id, text(`Later step ${i}`));
			await tick(50);
		}
		expect(saves(s.id).length).toBe(before + 3);
	});

	test('the end of a turn is written at once, and the write that was waiting does not come again', async () => {
		const s = await task();
		treeOf(s, { changes: 2 });
		say(s.id, text('Done.'));
		await done(s.id);
		expect(written(s.id)).toMatchObject({ status: 'idle', review: true });
		expect(written(s.id)!.items.at(-1)).toEqual({ kind: 'text', text: 'Done.' });
		const after = saves(s.id).length;
		await tick(5000);
		expect(saves(s.id).length).toBe(after);
	});

	test('a change to a session that is not mid-turn is written at once', async () => {
		const s = await reviewable();
		agents.markDone(s.id);
		await tick();
		expect(written(s.id)).toMatchObject({ review: false, unread: false });
	});

	test('only the session that changed is written', async () => {
		const a = await task({ branch: 'agent/a' });
		const b = await task({ branch: 'agent/b' });
		await done(a.id);
		await done(b.id);
		await tick(1000);
		const before = saves(a.id).length;
		agents.setMode(b.id, 'plan');
		await tick(1000);
		expect(saves(a.id).length).toBe(before);
		expect(written(b.id)!.mode).toBe('plan');
	});

	test('one write per session at a time: changes made meanwhile go in one more write, with the latest state', async () => {
		const s = await reviewable();
		await tick(1000);
		const before = saves(s.id).length;
		const waiting: (() => void)[] = [];
		w.on('agent_session_save', () => new Promise<void>((r) => waiting.push(r)));
		agents.setMode(s.id, 'plan');
		await tick();
		agents.setMode(s.id, 'default');
		agents.setModel(s.id, 'opus');
		await tick(1000);
		expect(saves(s.id).length).toBe(before + 1);
		waiting.shift()!();
		await tick();
		expect(saves(s.id).length).toBe(before + 2);
		expect(written(s.id)).toMatchObject({ mode: 'default', model: 'opus' });
		waiting.shift()!();
		await tick(1000);
		expect(saves(s.id).length).toBe(before + 2);
	});

	test('a write that fails is said once, the session stays, and the next change tries again', async () => {
		const s = await reviewable();
		w.on('agent_session_save', () => {
			throw appError('error', 'The folder is read-only.');
		});
		agents.setMode(s.id, 'plan');
		await tick();
		agents.setMode(s.id, 'default');
		await tick();
		const said = toasts('Agent history is not being saved');
		expect(said.length).toBe(1);
		expect(said[0]).toMatchObject({ kind: 'error' });
		expect(said[0].message).toContain('The folder is read-only.');
		expect(now(s).mode).toBe('default');
		w.on('agent_session_save', () => undefined);
		agents.setMode(s.id, 'plan');
		await tick();
		expect(written(s.id)!.mode).toBe('plan');
		expect(toasts('Agent history is not being saved').length).toBe(1);
	});

	test('it is said again only when a write has succeeded in between', async () => {
		const s = await reviewable();
		const fail = (): void =>
			w.on('agent_session_save', () => {
				throw appError('error', 'The folder is read-only.');
			});
		fail();
		agents.setMode(s.id, 'plan');
		await tick();
		w.on('agent_session_save', () => undefined);
		agents.setMode(s.id, 'default');
		await tick();
		fail();
		agents.setMode(s.id, 'plan');
		await tick();
		expect(toasts('Agent history is not being saved').length).toBe(2);
	});

	test('flush writes what is waiting, now', async () => {
		const s = await task();
		await tick(500);
		say(s.id, text('Half way'));
		expect(written(s.id)!.items.length).toBe(1);
		await agents.flush();
		expect(written(s.id)!.items.at(-1)).toEqual({ kind: 'text', text: 'Half way' });
	});

	test('the window going away writes what is waiting', async () => {
		const s = await task();
		await tick(500);
		say(s.id, text('Half way'));
		window.dispatchEvent(new Event('pagehide'));
		await tick();
		expect(written(s.id)!.items.at(-1)).toEqual({ kind: 'text', text: 'Half way' });
	});

	test('a session that is forgotten has its file removed', async () => {
		const s = await reviewable();
		await agents.remove(s, false);
		await tick();
		expect(saves(s.id).at(-1)).toEqual({ id: s.id, session: null });
	});

	test('the whole transcript is written, however long', async () => {
		const s = await task();
		for (let i = 0; i < 600; i++) {
			say(s.id, text(`Step ${i}`));
		}
		await done(s.id);
		expect(written(s.id)!.items.length).toBe(601);
		expect(now(s).items.length).toBe(601);
	});
});

describe('restoring', () => {
	test('the saved sessions are there once the store has started, and nothing is left running', async () => {
		await boot(() => stored(session({ id: 'a', repoId: repoId(), status: 'running', sessionId: 'conversation-1', items: [{ kind: 'user', text: 'Add a shuffle button' }] }), session({ id: 'b', repoId: repoId(), status: 'failed' })));
		expect(agents.sessions().map((s) => [s.id, s.status])).toEqual([
			['a', 'idle'],
			['b', 'failed'],
		]);
		expect(agents.get('a')).toMatchObject({ sessionId: 'conversation-1', items: [{ kind: 'user', text: 'Add a shuffle button' }] });
		expect(agents.running()).toBe(0);
	});

	test('reading them writes nothing back', async () => {
		await boot(() => stored(session({ id: 'a', repoId: repoId(), status: 'running' })));
		await tick(1000);
		expect(w.sent('agent_session_save')).toEqual([]);
	});

	test('a session saved before most fields existed gets them filled in: a task, in the main checkout, nothing waiting', async () => {
		await boot(() => stored({ id: 'old', repoId: repoId(), cwd: repos.repo()!.path }));
		expect(agents.get('old')).toEqual({ ...session({ id: 'old', repoId: repoId(), cwd: repos.repo()!.path, title: '', branch: null, isolated: false }), pipeline: null });
		expect(m.stateOf(agents.get('old')!)).toBe('finished');
	});

	test('a restored session can be sent to, and carries on its conversation', async () => {
		await boot(() => stored(session({ id: 'a', repoId: repoId(), cwd: repos.repo()!.path, isolated: false, sessionId: 'conversation-1' })));
		await agents.send('a', 'Carry on');
		expect(starts()[0]).toMatchObject({ key: 'a', resume: 'conversation-1', prompt: 'Carry on' });
	});

	test('what is not a session is dropped; files that are not JSON are counted and said, and left where they are', async () => {
		await boot(() =>
			w.on('agent_sessions_load', () => ({
				sessions: [JSON.stringify(session({ id: 'good', repoId: repoId() })), '{"id": "cut off', JSON.stringify({ title: 'no id' }), 'null', JSON.stringify({ id: 7, repoId: 'r', cwd: '/x' })],
				unreadable: ['3f2a.json'],
			}))
		);
		expect(agents.sessions().map((s) => s.id)).toEqual(['good']);
		const said = toasts('2 saved agent sessions could not be read');
		expect(said.length).toBe(1);
		expect(said[0].kind).toBe('warning');
		expect(said[0].message).toContain('3f2a.json');
		expect(said[0].message).toContain('left where they are');
		expect(w.sent('agent_session_save')).toEqual([]);
	});

	test('one unreadable file is said in the singular', async () => {
		await boot(() => w.on('agent_sessions_load', () => ({ sessions: [], unreadable: ['3f2a.json'] })));
		expect(toasts('1 saved agent session could not be read')[0].message).toBe('3f2a.json. The file is left where it is.');
	});

	test('a history that cannot be read at all is said, and the store works without it', async () => {
		await boot(() =>
			w.on('agent_sessions_load', () => {
				throw appError('error', 'Permission denied');
			})
		);
		expect(toasts('Agent history could not be read')).toEqual([{ kind: 'error', title: 'Agent history could not be read', message: 'Permission denied' }]);
		expect(agents.sessions()).toEqual([]);
		const s = await task();
		expect(now(s).status).toBe('running');
	});

	test('an investigation comes back without the question it was waiting on or the app it had running', async () => {
		const approval: InvestigateApproval = { key: 'i', request: 'req-1', tool: 'run_target', target: 'dev', group: null, project: null, command: 'npm run dev', port: 5174, method: null, path: null, body: null, touches: null };
		await boot(() => stored(session({ id: 'i', repoId: repoId(), kind: 'investigate', status: 'running', investigation: looking({ approval, checking: true, tab: 's3', runs: 2, step: 4 }) })));
		expect(agents.get('i')!.investigation).toMatchObject({ approval: null, checking: false, tab: null, runs: 2, step: 4 });
		expect(m.stateOf(agents.get('i')!)).toBe('finished');
	});

	test('a finished check of its work is kept; one that was still looking, or from before it knew what was new, is not', async () => {
		const finished = { state: 'done', problems: [problem()], known: 1, impact: [], servers: ['TypeScript'], files: 1, users: 0, finished: true };
		await boot(() =>
			stored(
				session({ id: 'done', repoId: repoId(), check: finished as AgentSession['check'] }),
				session({ id: 'checking', repoId: repoId(), check: { ...finished, state: 'checking' } as AgentSession['check'] }),
				session({ id: 'older', repoId: repoId(), check: { state: 'done', problems: [] } as unknown as AgentSession['check'] })
			)
		);
		expect(agents.get('done')!.check).toEqual(finished);
		expect(agents.get('checking')!.check).toBeNull();
		expect(agents.get('older')!.check).toBeNull();
	});

	test('a pipeline step that was going when the app closed waits for the user to carry on', async () => {
		await boot(() => stored(session({ id: 'p', repoId: repoId(), status: 'running', pipeline: { ...newPipeline('bug'), step: 'code' } })));
		const p = agents.get('p')!.pipeline!;
		expect(p).toMatchObject({ step: 'code', waiting: true, steps: { code: { state: 'you' } } });
		expect(p.note).toContain('Carry on');
		expect(m.stateOf(agents.get('p')!)).toBe('review');
	});

	test('a pipeline that was already waiting, or done, comes back as it was', async () => {
		const waiting: Pipeline = { ...newPipeline('bug'), waiting: true, note: 'Approve the plan', reason: 'approve' };
		const shipped: Pipeline = { ...newPipeline('quick'), step: 'done' };
		await boot(() => stored(session({ id: 'w', repoId: repoId(), pipeline: waiting }), session({ id: 'd', repoId: repoId(), pipeline: shipped })));
		expect(agents.get('w')!.pipeline).toEqual(waiting);
		expect(agents.get('d')!.pipeline).toEqual(shipped);
	});

	test('starting waits for the saved sessions', async () => {
		let release!: (answer: { sessions: string[]; unreadable: string[] }) => void;
		vi.useFakeTimers();
		w = await world();
		repos = w.get((await import('./repo.store')).RepoStore);
		await repos.init();
		w.on('agent_sessions_load', () => new Promise((r) => (release = r)));
		agents = w.get((await import('./agents.store')).AgentsStore);
		let ready = false;
		void agents.init().then(() => (ready = true));
		await tick(1000);
		expect(ready).toBe(false);
		expect(agents.sessions()).toEqual([]);
		release({ sessions: [JSON.stringify(session({ id: 'a', repoId: repoId() }))], unreadable: [] });
		await tick();
		expect(ready).toBe(true);
		expect(agents.sessions().map((s) => s.id)).toEqual(['a']);
	});

	test('a session started while the files were still being read is kept, after the ones read', async () => {
		let release!: (answer: { sessions: string[]; unreadable: string[] }) => void;
		vi.useFakeTimers();
		w = await world();
		w.on('agent_start', () => undefined);
		repos = w.get((await import('./repo.store')).RepoStore);
		await repos.init();
		w.on('agent_sessions_load', () => new Promise((r) => (release = r)));
		agents = w.get((await import('./agents.store')).AgentsStore);
		expect(await agents.ask('Where is the queue advanced?')).toBe(true);
		const asked = agents.sessions()[0];
		release({ sessions: [JSON.stringify(session({ id: 'a', repoId: repoId() }))], unreadable: [] });
		await agents.restored;
		expect(agents.sessions().map((s) => s.id)).toEqual(['a', asked.id]);
		expect(agents.get(asked.id)!.status).toBe('running');
	});

	test('the settings kept in browser storage come back as they were left', async () => {
		await boot();
		expect(agents.cleanupAfterMerge()).toBe(true);
		expect(agents.checksOn()).toBe(true);
		agents.setCleanupAfterMerge(false);
		agents.setChecks(false);
		expect(agents.cleanupAfterMerge()).toBe(false);
		expect(localStorage.getItem('studio.agents.merge-cleanup')).toBe('off');
		expect(localStorage.getItem('studio.agents.check')).toBe('off');
		await boot(() => {
			localStorage.setItem('studio.agents.merge-cleanup', 'off');
			localStorage.setItem('studio.agents.check', 'off');
		});
		expect(agents.cleanupAfterMerge()).toBe(false);
		expect(agents.checksOn()).toBe(false);
		agents.setCleanupAfterMerge(true);
		expect(localStorage.getItem('studio.agents.merge-cleanup')).toBe('on');
	});
});

describe('sessions kept in browser storage by versions before 0.6', () => {
	const old = (id: string, over: Partial<AgentSession> = {}): AgentSession => session({ id, repoId: '/work/repo', ...over });

	/** The store as the desktop app makes it. Only the reading of the old key asks which of the two it is. */
	async function restoreOnDesktop(): Promise<void> {
		m = await import('./agents.store');
		native.__TAURI_INTERNALS__ = {};
		try {
			agents = w.get(m.AgentsStore);
			await agents.restored;
		} finally {
			delete native.__TAURI_INTERNALS__;
		}
	}

	beforeEach(async () => {
		w = await world();
	});

	test('are moved to files at the first start, and only then is the key removed', async () => {
		localStorage.setItem('studio.agents', JSON.stringify([old('a', { status: 'running' }), old('b')]));
		stored();
		w.on('agent_session_save', () => undefined);
		await restoreOnDesktop();
		expect(agents.sessions().map((s) => s.id)).toEqual(['a', 'b']);
		expect(w.sent('agent_session_save').map((c) => c.args.id)).toEqual(['a', 'b']);
		expect(JSON.parse(String(saves('a')[0].session))).toMatchObject({ id: 'a', status: 'idle', title: 'Add a shuffle button' });
		expect(localStorage.getItem('studio.agents')).toBeNull();
	});

	test('one that already has a file is not written again: the file is the newer', async () => {
		localStorage.setItem('studio.agents', JSON.stringify([old('a', { title: 'From browser storage' }), old('b')]));
		stored(old('a', { title: 'From its file' }));
		w.on('agent_session_save', () => undefined);
		await restoreOnDesktop();
		expect(agents.sessions().map((s) => [s.id, s.title])).toEqual([
			['a', 'From its file'],
			['b', 'Add a shuffle button'],
		]);
		expect(w.sent('agent_session_save').map((c) => c.args.id)).toEqual(['b']);
		expect(localStorage.getItem('studio.agents')).toBeNull();
	});

	test('the key stays while any of them could not be written, and that is said', async () => {
		const kept = JSON.stringify([old('a'), old('b')]);
		localStorage.setItem('studio.agents', kept);
		stored();
		w.on('agent_session_save', (args) => {
			if (args.id === 'b') {
				throw appError('error', 'The folder is read-only.');
			}
		});
		await restoreOnDesktop();
		expect(localStorage.getItem('studio.agents')).toBe(kept);
		expect(w.toasts.filter((t) => t.title === 'Agent history is not being saved').length).toBe(1);
		expect(agents.sessions().map((s) => s.id)).toEqual(['a', 'b']);
	});

	test('with every one of them in a file already, nothing is written and the key goes', async () => {
		localStorage.setItem('studio.agents', JSON.stringify([old('a')]));
		stored(old('a'));
		w.on('agent_session_save', () => undefined);
		await restoreOnDesktop();
		expect(w.sent('agent_session_save')).toEqual([]);
		expect(localStorage.getItem('studio.agents')).toBeNull();
	});

	test.each([['not json at all'], ['{"id":"a"}'], ['[]']])('a key holding %s moves nothing and is left alone', async (value) => {
		localStorage.setItem('studio.agents', value);
		stored();
		w.on('agent_session_save', () => undefined);
		await restoreOnDesktop();
		expect(agents.sessions()).toEqual([]);
		expect(w.sent('agent_session_save')).toEqual([]);
		expect(localStorage.getItem('studio.agents')).toBe(value);
	});

	test('entries in it that are not sessions are not moved, and do not keep the key', async () => {
		localStorage.setItem('studio.agents', JSON.stringify([null, 'text', { title: 'no id' }, old('a')]));
		stored();
		w.on('agent_session_save', () => undefined);
		await restoreOnDesktop();
		expect(agents.sessions().map((s) => s.id)).toEqual(['a']);
		expect(w.sent('agent_session_save').map((c) => c.args.id)).toEqual(['a']);
		expect(localStorage.getItem('studio.agents')).toBeNull();
	});

	test('in the browser preview the key is the demo backend\'s own store: read through it, and left there', async () => {
		const kept = JSON.stringify([old('a')]);
		localStorage.setItem('studio.agents', kept);
		agents = w.get((await import('./agents.store')).AgentsStore);
		await agents.restored;
		expect(agents.sessions().map((s) => s.id)).toEqual(['a']);
		expect(w.sent('agent_session_save')).toEqual([]);
		expect(localStorage.getItem('studio.agents')).toBe(kept);
	});
});

// ---- review, settle, merge ---------------------------------------------------

describe('work to review', () => {
	beforeEach(() => boot());

	test('looking at an isolated task\'s changes shows its worktree on the Changes tab and does not settle it', async () => {
		const s = await reviewable();
		await agents.review(s);
		expect(w.sent('worktree_select').at(-1)!.args).toEqual({ id: repoId(), path: s.cwd });
		expect(repos.tab()).toBe('changes');
		expect(now(s)).toMatchObject({ review: true, unread: false });
		expect(m.stateOf(now(s))).toBe('review');
	});

	test('a task in the main checkout has no merge step: having looked settles it', async () => {
		const s = await reviewable({ branch: '' });
		expect(s.review).toBe(true);
		await agents.review(s);
		expect(w.sent('worktree_select').at(-1)!.args).toEqual({ id: repoId(), path: null });
		expect(now(s)).toMatchObject({ review: false, unread: false });
		expect(m.stateOf(now(s))).toBe('finished');
	});

	test('looking is not activity', async () => {
		const s = await reviewable();
		await tick(60_000);
		await agents.review(s);
		expect(now(s).updated).toBe(s.updated);
	});

	test.each<[string, Partial<Worktree> | null, boolean]>([
		['its worktree is gone', null, false],
		['its worktree is clean and it made no commit', { changes: 0 }, false],
		['its worktree is clean and its commit is in the main branch', { changes: 0, head: 'c'.repeat(40), landed: true }, false],
		['its commit is not in the main branch yet', { changes: 0, head: 'c'.repeat(40), landed: false }, true],
		['it has uncommitted work, even with its commit landed', { changes: 1, head: 'c'.repeat(40), landed: true }, true],
		['it has uncommitted work and no commit', { changes: 3 }, true],
	])('when %s, the list of worktrees leaves "needs review" %s', async (_what, tree, waits) => {
		const s = await reviewable();
		treeOf(s, tree);
		await agents.loadWorktrees();
		expect(now(s).review).toBe(waits);
	});

	test('a task that changed nothing is settled as soon as its turn ends', async () => {
		const s = await task();
		await done(s.id);
		expect(now(s).review).toBe(false);
		expect(m.stateOf(now(s))).toBe('finished');
	});

	test('work is not settled under a turn that is running', async () => {
		const s = await reviewable();
		await agents.send(s.id, 'One more thing');
		treeOf(s, null);
		await agents.loadWorktrees();
		expect(now(s).review).toBe(true);
	});

	test('a list of worktrees that came back empty, or not at all, settles nothing', async () => {
		const s = await reviewable();
		w.on('worktree_list', () => []);
		await agents.loadWorktrees();
		expect(now(s).review).toBe(true);
		w.on('worktree_list', () => {
			throw appError('git', 'not a git repository');
		});
		await agents.loadWorktrees();
		expect(agents.worktrees()).toEqual([]);
		expect(now(s).review).toBe(true);
	});

	test('settling is not activity, and a task in the main checkout is never settled this way', async () => {
		const isolated = await reviewable({ branch: 'agent/a' });
		const inMain = await reviewable({ branch: '' });
		await tick(60_000);
		trees((t) => (t.isMain ? { ...t, changes: 0 } : null));
		await agents.loadWorktrees();
		expect(now(isolated)).toMatchObject({ review: false, updated: isolated.updated });
		expect(now(inMain).review).toBe(true);
	});

	test('the question it asked outlives its work being settled', async () => {
		const s = await reviewable({}, `Nothing to change.\n\n${BRIEF}`);
		treeOf(s, null);
		await agents.loadWorktrees();
		expect(now(s).review).toBe(false);
		expect(now(s).brief).toMatchObject({ needs: 'Should it also shuffle the queue that is playing?', choices: ['Yes', 'No'] });
		expect(m.stateOf(now(s))).toBe('review');
		expect(m.stateLabel(now(s))).toBe('Needs you');
		expect(m.summary(now(s))).toMatchObject({ needs: 'Should it also shuffle the queue that is playing?', choices: ['Yes', 'No'] });
	});

	test('sessions of another repository are not judged by this one\'s worktrees', async () => {
		await boot(() => stored(session({ id: 'elsewhere', repoId: otherRepo(), review: true, cwd: '/work/cadence.worktrees/agent-x' })));
		await agents.loadWorktrees();
		expect(agents.get('elsewhere')!.review).toBe(true);
	});

	test('a list that arrives after the repository was switched is dropped', async () => {
		const usual = agents.worktrees();
		let release!: (list: Worktree[]) => void;
		w.on('worktree_list', () => new Promise<Worktree[]>((r) => (release = r)));
		const reading = agents.loadWorktrees();
		await tick();
		w.off('worktree_list');
		await repos.selectRepo(otherRepo());
		release([{ ...usual[0], path: '/late/answer' }]);
		await reading;
		expect(agents.worktrees().some((t) => t.path === '/late/answer')).toBe(false);
	});

	test('"Mark done" settles the work and the question, touches no worktree or branch, and is not activity', async () => {
		const s = await reviewable({}, `Done.\n\n${BRIEF}`);
		await tick(60_000);
		const calls = w.calls.length;
		agents.markDone(s.id);
		expect(now(s)).toMatchObject({ review: false, unread: false, updated: s.updated, brief: { did: 'Added the button and its test.', needs: null, choices: [] } });
		expect(m.stateOf(now(s))).toBe('finished');
		await tick();
		expect(w.calls.slice(calls).map((c) => c.cmd)).toEqual(['agent_session_save']);
	});

	test('the worktree on screen that is not the main checkout is the active one', async () => {
		const s = await task();
		expect(agents.activeWorktree()).toBeNull();
		await agents.view(s.cwd, 'files');
		expect(agents.activeWorktree()?.path).toBe(s.cwd);
		expect(repos.tab()).toBe('files');
		await agents.view(null);
		expect(agents.activeWorktree()).toBeNull();
		expect(w.sent('worktree_select').at(-1)!.args).toEqual({ id: repoId(), path: null });
	});

	test('a checkout that cannot be switched to is said', async () => {
		w.on('worktree_select', () => {
			throw appError('error', 'That folder is not one of this repository\'s checkouts');
		});
		await agents.view('/somewhere/else');
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'That folder is not one of this repository\'s checkouts' });
	});
});

describe('merging', () => {
	beforeEach(() => boot());

	const current = (): string => repos.status()!.branch!;
	const merges = (): Record<string, unknown>[] => w.sent('merge_branch').map((c) => c.args);

	test('into the branch the main checkout is on: merged there, and the task needs nothing more, its question included', async () => {
		const s = await reviewable({}, `Done.\n\n${BRIEF}`);
		expect(await agents.merge(s, current())).toBe(true);
		expect(w.sent('worktree_select').at(-1)!.args).toEqual({ id: repoId(), path: null });
		expect(merges()).toEqual([{ id: repoId(), from: 'agent/shuffle' }]);
		expect(w.sent('branch_checkout')).toEqual([]);
		expect(now(s)).toMatchObject({ review: false, brief: { needs: null, choices: [] } });
		expect(m.stateOf(now(s))).toBe('finished');
		expect(agents.get(s.id)).not.toBeNull();
	});

	test('into a branch another worktree holds: merged in that worktree, and nothing is checked out', async () => {
		const a = await task({ branch: 'agent/a' });
		const b = await task({ branch: 'agent/b' });
		treeOf(a, { changes: 0, head: 'c'.repeat(40) });
		await done(a.id);
		await done(b.id);
		expect(await agents.merge(now(a), 'agent/b')).toBe(true);
		expect(w.sent('worktree_select').at(-1)!.args).toEqual({ id: repoId(), path: b.cwd });
		expect(merges()).toEqual([{ id: repoId(), from: 'agent/a' }]);
		expect(w.sent('branch_checkout')).toEqual([]);
	});

	test('into a branch no checkout holds: the main checkout switches to it first', async () => {
		const s = await reviewable();
		trees((t) => (t.isMain ? { ...t, changes: 0 } : t));
		expect(await agents.merge(s, 'main')).toBe(true);
		const order = w.calls.map((c) => c.cmd);
		expect(w.sent('branch_checkout').map((c) => c.args)).toEqual([{ id: repoId(), name: 'main', isRemote: false }]);
		expect(order.indexOf('branch_checkout')).toBeLessThan(order.indexOf('merge_branch'));
		expect(w.sent('worktree_select').at(-1)!.args.path).toBeNull();
	});

	test('the main checkout is not switched while it has uncommitted changes', async () => {
		const s = await reviewable();
		expect(agents.worktrees().find((t) => t.isMain)!.changes).toBeGreaterThan(0);
		expect(await agents.merge(s, 'main')).toBe(false);
		expect(w.sent('branch_checkout')).toEqual([]);
		expect(merges()).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'The main checkout has uncommitted changes' });
		expect(now(s).review).toBe(true);
	});

	test('into a new branch: made from the one picked, in the main checkout, then merged into', async () => {
		const s = await reviewable();
		expect(await agents.merge(s, 'release/next', 'main')).toBe(true);
		expect(w.sent('branch_create').map((c) => c.args)).toEqual([{ id: repoId(), name: 'release/next', start: 'main' }]);
		const order = w.calls.map((c) => c.cmd);
		expect(order.indexOf('branch_create')).toBeLessThan(order.indexOf('merge_branch'));
		expect(w.sent('worktree_select').at(-1)!.args.path).toBeNull();
	});

	test('a new branch that cannot be made merges nothing', async () => {
		const s = await reviewable();
		w.on('branch_create', () => {
			throw appError('git', "a branch named 'release/next' already exists");
		});
		expect(await agents.merge(s, 'release/next', 'main')).toBe(false);
		expect(merges()).toEqual([]);
		expect(now(s).review).toBe(true);
	});

	test('a branch that does not exist is not merged into', async () => {
		const s = await reviewable();
		trees((t) => (t.isMain ? { ...t, changes: 0 } : t));
		expect(await agents.merge(s, 'no/such-branch')).toBe(false);
		expect(merges()).toEqual([]);
	});

	test('into itself, into nothing, or with no branch of its own: nothing happens at all', async () => {
		const s = await reviewable();
		const calls = w.calls.length;
		expect(await agents.merge(s, 'agent/shuffle')).toBe(false);
		expect(await agents.merge(s, '')).toBe(false);
		expect(await agents.merge({ ...s, branch: null }, 'main')).toBe(false);
		expect(w.calls.length).toBe(calls);
	});

	test('a merge that stops on conflicts leaves the task waiting and cleans nothing up', async () => {
		const s = await reviewable();
		treeOf(s, { changes: 0, head: 'c'.repeat(40) });
		w.on('merge_branch', () => {
			throw appError('conflict', 'Automatic merge failed', ['src/player/queue.ts']);
		});
		expect(await agents.merge(s, current(), null, true)).toBe(false);
		expect(now(s).review).toBe(true);
		expect(w.sent('worktree_remove')).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'warning', title: 'Merge conflicts' });
	});

	test('with the cleanup box ticked the worktree and its branch go after the merge; the session stays', async () => {
		const s = await reviewable();
		treeOf(s, { changes: 0, head: 'c'.repeat(40) });
		expect(await agents.merge(s, current(), null, true)).toBe(true);
		expect(w.sent('worktree_remove').map((c) => c.args)).toEqual([{ id: repoId(), path: s.cwd, force: true, deleteBranch: true }]);
		const order = w.calls.map((c) => c.cmd);
		expect(order.indexOf('merge_branch')).toBeLessThan(order.indexOf('worktree_remove'));
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'success', title: 'Cleaned up', message: 'Removed the worktree and the branch agent/shuffle.' });
		expect(agents.get(s.id)).toMatchObject({ review: false });
	});

	test('a worktree with uncommitted changes is kept, which the merge did not take, and that is said', async () => {
		const s = await reviewable();
		expect(await agents.merge(s, current(), null, true)).toBe(true);
		expect(w.sent('worktree_remove')).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'warning', title: 'Worktree kept' });
		expect(w.toasts.at(-1)!.message).toContain('2 uncommitted changes');
	});

	test('with the box unticked nothing is removed', async () => {
		const s = await reviewable();
		treeOf(s, { changes: 0, head: 'c'.repeat(40) });
		expect(await agents.merge(s, current())).toBe(true);
		expect(w.sent('worktree_remove')).toEqual([]);
	});

	test('a task in the main checkout has no worktree to clean up', async () => {
		const s = await reviewable({ branch: '' });
		trees((t) => (t.isMain ? { ...t, changes: 0 } : t));
		expect(await agents.merge(s, 'main', null, true)).toBe(true);
		expect(merges()).toEqual([{ id: repoId(), from: s.branch }]);
		expect(w.sent('worktree_remove')).toEqual([]);
	});

	test('a session of another repository is merged in its own: the app goes there first', async () => {
		const s = await reviewable();
		await repos.selectRepo(otherRepo());
		expect(await agents.merge(s, 'release/next', 'main')).toBe(true);
		expect(repos.repo()!.id).toBe(s.repoId);
		expect(merges()).toEqual([{ id: s.repoId, from: 'agent/shuffle' }]);
	});
});

describe('forgetting a session', () => {
	beforeEach(() => boot());

	test('with its worktree: the worktree and its branch go, then the session', async () => {
		const s = await reviewable();
		await agents.remove(s, true);
		expect(w.sent('worktree_remove').map((c) => c.args)).toEqual([{ id: repoId(), path: s.cwd, force: true, deleteBranch: true }]);
		expect(agents.sessions()).toEqual([]);
		expect(agents.selectedId()).toBeNull();
	});

	test('without: only the session goes', async () => {
		const s = await reviewable();
		await agents.remove(s, false);
		expect(w.sent('worktree_remove')).toEqual([]);
		expect(agents.sessions()).toEqual([]);
	});

	test('a worktree that cannot be removed keeps the session, and says why', async () => {
		const s = await reviewable();
		w.on('worktree_remove', () => {
			throw appError('git', 'a process still has the folder open');
		});
		await agents.remove(s, true);
		expect(agents.sessions().map((x) => x.id)).toEqual([s.id]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'a process still has the folder open' });
	});

	test('a task in the main checkout never takes a checkout with it', async () => {
		const s = await reviewable({ branch: '' });
		await agents.remove(s, true);
		expect(w.sent('worktree_remove')).toEqual([]);
		expect(agents.sessions()).toEqual([]);
	});

	test('a running one is stopped first, and its worktree goes only once its turn has ended', async () => {
		const s = await task();
		const removing = agents.remove(s, true);
		await tick();
		expect(w.sent('agent_stop').map((c) => c.args)).toEqual([{ key: s.id }]);
		expect(w.sent('worktree_remove')).toEqual([]);
		expect(agents.get(s.id)).not.toBeNull();
		await done(s.id, false);
		await removing;
		expect(w.sent('worktree_remove').length).toBe(1);
		expect(agents.sessions()).toEqual([]);
	});

	test('a running one whose end never comes is removed after four seconds all the same', async () => {
		const s = await task();
		const removing = agents.remove(s, true);
		await tick(3900);
		expect(agents.get(s.id)).not.toBeNull();
		await tick(200);
		await removing;
		expect(agents.sessions()).toEqual([]);
	});

	test('another session selected stays selected', async () => {
		const a = await task({ branch: 'agent/a' });
		const b = await task({ branch: 'agent/b' });
		await done(a.id);
		await done(b.id);
		agents.select(b.id);
		await agents.remove(a, false);
		expect(agents.selectedId()).toBe(b.id);
	});
});

describe('removing a worktree', () => {
	beforeEach(() => boot());

	test('by default keeps its branch and refuses to discard work; forced, the branch goes too unless told otherwise', async () => {
		const s = await task();
		await done(s.id);
		expect(await agents.removeWorktree(s.cwd, false)).toBe(true);
		expect(await agents.removeWorktree(s.cwd, true)).toBe(true);
		expect(await agents.removeWorktree(s.cwd, true, null, false)).toBe(true);
		expect(w.sent('worktree_remove').map((c) => c.args)).toEqual([
			{ id: repoId(), path: s.cwd, force: false, deleteBranch: false },
			{ id: repoId(), path: s.cwd, force: true, deleteBranch: true },
			{ id: repoId(), path: s.cwd, force: true, deleteBranch: false },
		]);
	});

	test('the lists of worktrees and branches are read again, so neither goes on offering it', async () => {
		const s = await task();
		await done(s.id);
		expect(await agents.removeWorktree(s.cwd, true)).toBe(true);
		expect(agents.worktrees().some((t) => t.path === s.cwd)).toBe(false);
		expect(repos.branches().some((b) => b.name === 'agent/shuffle')).toBe(false);
	});

	test('a refusal is said and answered false', async () => {
		const s = await task();
		w.on('worktree_remove', () => {
			throw appError('git', 'the worktree has uncommitted changes');
		});
		expect(await agents.removeWorktree(s.cwd, false)).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'the worktree has uncommitted changes' });
	});

	test('removing the one on screen takes the app back to the main checkout', async () => {
		const s = await task();
		await done(s.id);
		await agents.view(s.cwd);
		expect(repos.repo()!.worktree).toBe(s.cwd);
		expect(await agents.removeWorktree(s.cwd, true)).toBe(true);
		expect(repos.repo()!.worktree ?? null).toBeNull();
		expect(repos.tab()).toBe('agents');
	});

	test('in a repository that is not the open one, the lists on screen are not read again', async () => {
		const s = await task();
		await done(s.id);
		await repos.selectRepo(otherRepo());
		await tick();
		const before = w.sent('worktree_list').length;
		expect(await agents.removeWorktree(s.cwd, true, s.repoId)).toBe(true);
		expect(w.sent('worktree_remove').at(-1)!.args.id).toBe(s.repoId);
		expect(w.sent('worktree_list').length).toBe(before);
	});
});

describe('with no repository open', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		w = await world();
		w.on('app_status', () => ({ repos: [], current: null, gitVersion: '2.47.0', authorName: '', authorEmail: '', appVersion: '0.0.0' }));
		repos = w.get((await import('./repo.store')).RepoStore);
		await repos.init();
		m = await import('./agents.store');
		agents = w.get(m.AgentsStore);
		await agents.init();
	});

	test('nothing can be started, and nothing is asked of the native side for it', async () => {
		expect(repos.repo()).toBeNull();
		expect(await agents.start({ task: 'Add a shuffle button', branch: 'agent/shuffle', mode: 'acceptEdits' })).toBe(false);
		expect(await agents.ask('Where is the queue advanced?')).toBe(false);
		expect(await agents.investigate({ description: 'It crashes', error: null, target: null, command: null, exitCode: null })).toBe(false);
		expect(await agents.removeWorktree('/somewhere', true)).toBe(false);
		await agents.view('/somewhere');
		await agents.loadWorktrees();
		expect(agents.worktrees()).toEqual([]);
		expect(agents.current()).toEqual([]);
		expect(agents.sessions()).toEqual([]);
		for (const cmd of ['worktree_list', 'worktree_add', 'worktree_select', 'worktree_remove', 'agent_start']) {
			expect(w.sent(cmd)).toEqual([]);
		}
	});
});

// ---- finding one's way -------------------------------------------------------

describe('going to a session', () => {
	test('the list is the open repository\'s, newest first', async () => {
		await boot(() => stored(session({ id: 'elsewhere', repoId: otherRepo() }), session({ id: 'older', repoId: repoId(), updated: 1000 }), session({ id: 'newer', repoId: repoId(), updated: 2000 })));
		expect(agents.current().map((s) => s.id)).toEqual(['newer', 'older']);
		expect(agents.get('elsewhere')).not.toBeNull();
		agents.selectedId.set('elsewhere');
		expect(agents.selected()).toBeNull();
	});

	test('one in another repository: the app switches to it, opens the Agents tab and shows the session', async () => {
		await boot(() => stored(session({ id: 'elsewhere', repoId: otherRepo(), unread: true })));
		const there = otherRepo();
		expect(await agents.open('elsewhere')).toBe(true);
		expect(w.sent('repo_select').map((c) => c.args)).toEqual([{ id: there }]);
		expect(repos.repo()!.id).toBe(there);
		expect(repos.tab()).toBe('agents');
		expect(agents.selected()?.id).toBe('elsewhere');
		expect(agents.get('elsewhere')!.unread).toBe(false);
	});

	test('one whose repository is no longer in the app cannot be opened, and that is said', async () => {
		await boot(() => stored(session({ id: 'orphan', repoId: '/work/removed' })));
		expect(await agents.open('orphan')).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'warning', title: 'Repository not found' });
		expect(w.sent('repo_select')).toEqual([]);
		expect(agents.selectedId()).toBeNull();
	});

	test('one that does not exist is not opened', async () => {
		await boot();
		expect(await agents.open('no-such-session')).toBe(false);
	});

	test('back to the desk: no session, question or comparison open', async () => {
		await boot();
		await task({ attempts: 2 });
		agents.asking.set({ scope: 'code', seed: '' });
		agents.showDesk();
		expect(agents.selectedId()).toBeNull();
		expect(agents.comparing()).toBeNull();
		expect(agents.asking()).toBeNull();
	});

	test('selecting a session closes a comparison and a replay', async () => {
		await boot();
		await task({ attempts: 2 });
		const [a] = agents.sessions();
		agents.replaying.set('some-investigation');
		agents.select(a.id);
		expect(agents.comparing()).toBeNull();
		expect(agents.replaying()).toBeNull();
		expect(agents.selectedId()).toBe(a.id);
	});
});

describe('links in an answer', () => {
	let s: AgentSession;

	beforeEach(async () => {
		await boot();
		await agents.ask('Why was seek changed?', 'history');
		s = agents.sessions()[0];
		await done(s.id);
	});

	test('a web address is opened by the system', async () => {
		w.on('plugin:opener|open_url', () => undefined);
		await agents.follow(s, { kind: 'url', url: 'https://example.com/docs' });
		expect(w.sent('plugin:opener|open_url').map((c) => c.args)).toEqual([{ url: 'https://example.com/docs' }]);
	});

	test('one that cannot be opened is said, with the address', async () => {
		w.on('plugin:opener|open_url', () => {
			throw appError('error', 'No browser');
		});
		await agents.follow(s, { kind: 'url', url: 'https://example.com/docs' });
		expect(w.toasts.at(-1)).toEqual({ kind: 'info', title: 'Could not open the link', message: 'https://example.com/docs' });
	});

	test('a commit hash selects that commit in History, by its first characters', async () => {
		await repos.loadHistory(true);
		const commit = repos.commits()[2];
		const shown = agents.commitShown();
		repos.setTab('agents');
		expect(await agents.openCommit(s, commit.hash.slice(0, 7))).toBe(true);
		expect(repos.tab()).toBe('history');
		expect(repos.selectedHash()).toBe(commit.hash);
		expect(agents.commitShown()).toBe(shown + 1);
	});

	test('following one from a docked question puts the commit in the main pane and keeps the question to come back to', async () => {
		repos.setTab('history');
		agents.historyChat.set({ id: s.id, open: true });
		await repos.loadHistory(true);
		await agents.follow(s, { kind: 'commit', hash: repos.commits()[1].hash });
		expect(agents.historyChat()).toEqual({ id: s.id, open: false });
		expect(repos.selectedHash()).toBe(repos.commits()[1].hash);
	});

	test('a hash that is not on the branch checked out is said, and nothing is selected', async () => {
		await repos.loadHistory(true);
		const selected = repos.selectedHash();
		expect(await agents.openCommit(s, 'ffffffffffff')).toBe(false);
		expect(w.toasts.at(-1)).toEqual({ kind: 'info', title: 'Commit not in this history', message: 'ffffffffff is not on the branch that is checked out.' });
		expect(repos.selectedHash()).toBe(selected);
	});

	test('a file opens in the Files tab', async () => {
		repos.setTab('agents');
		await agents.follow(s, { kind: 'file', path: 'src/player/queue.ts', line: null, column: null });
		expect(repos.tab()).toBe('files');
	});
});

// ---- investigations ------------------------------------------------------------

describe('an investigation', () => {
	beforeEach(() => boot());

	const DEV: RunTarget = { id: 'node::dev', name: 'dev', group: 'package.json', cwd: '', argv: ['npm', 'run', 'dev'], kind: 'run', runtime: 'node', source: 'package.json' };
	const MARKED = '@@ -1,2 +1,3 @@\n function next() {\n+  record("next", { cursor }); // studio-replay\n   return queue[cursor];';
	const CLEAN = '@@ -1,2 +1,2 @@\n function next() {\n-  return queue[cursor];\n+  return queue[cursor] ?? null;';

	async function investigation(request: Partial<InvestigateRequest> = {}): Promise<AgentSession> {
		const had = new Set(agents.sessions().map((s) => s.id));
		expect(await agents.investigate({ description: 'The player crashes on an empty queue', error: null, target: null, command: null, exitCode: null, ...request })).toBe(true);
		return agents.sessions().find((s) => !had.has(s.id))!;
	}

	const asks = (key: string, over: Partial<InvestigateApproval> = {}): InvestigateApproval => ({ key, request: 'req-1', tool: 'run_target', target: 'dev', group: 'package.json', project: null, command: 'npm run dev', port: 5174, method: null, path: null, body: null, touches: null, ...over });
	const answers = (): Record<string, unknown>[] => w.sent('investigate_answer').map((c) => c.args);
	const state = (s: AgentSession): Investigation => now(s).investigation!;

	/** The turn ends with `answer` as Claude's last message and `files` as what its worktree holds. */
	async function concludes(s: AgentSession, answer: string, ...files: ChangedFile[]): Promise<void> {
		w.on('worktree_diff', () => diffOf(...files));
		say(s.id, text(answer));
		await done(s.id);
	}

	test('works in a worktree of its own on investigate/<what>, made from the commit on screen', async () => {
		const s = await investigation();
		expect(w.sent('worktree_add').map((c) => c.args)).toEqual([{ id: repoId(), branch: 'investigate/the-player-crashes-on-an', base: repos.status()!.head }]);
		expect(s).toMatchObject({ kind: 'investigate', isolated: true, branch: 'investigate/the-player-crashes-on-an', title: 'The player crashes on an empty queue', status: 'running' });
		expect(s.cwd).not.toBe(repos.repo()!.path);
		expect(s.investigation).toMatchObject({ summary: 'The player crashes on an empty queue', description: 'The player crashes on an empty queue', step: 0, runs: 0, approval: null, report: null, leftover: [], cleanups: 0, ended: null });
		expect(repos.tab()).toBe('agents');
		expect(agents.selectedId()).toBe(s.id);
		expect(m.stateLabel(s)).toBe('Investigating');
	});

	test('runs with its own rules and tools only, in its worktree, never in the main checkout', async () => {
		const s = await investigation({ target: DEV });
		const sent = starts()[0];
		expect(sent).toMatchObject({ id: repoId(), cwd: s.cwd, key: s.id, mode: 'acceptEdits', resume: null });
		expect(sent.cwd).not.toBe(repos.repo()!.path);
		expect(sent.options).toEqual({ tools: INVESTIGATE_RULES, builtin: INVESTIGATE_BUILTIN, investigate: { target: 'node::dev' }, images: [] });
		expect(String(sent.prompt).split('\n')[0]).toBe('[investigate]');
		expect(String(sent.prompt)).toContain('The player crashes on an empty queue');
		// The transcript shows what was asked, not the rules that went with it.
		expect(s.items).toEqual([{ kind: 'user', text: 'Investigate: The player crashes on an empty queue' }]);
	});

	test('its branch says what failed: the exception and the function it was thrown in', async () => {
		const s = await investigation({
			description: '',
			error: { kind: 'exception', runtime: 'dotnet', summary: 'NullReferenceException: Object reference not set to an instance of an object.', type: 'NullReferenceException', message: 'Object reference not set to an instance of an object.', test: null, frames: [{ file: 'Cart.cs', line: 41, column: null, fn: 'Shop.Api.Cart.ApplyDiscount' }], text: 'fail: ...', line: 12 },
		});
		expect(s.branch).toBe('investigate/nullreferenceexception-in-applydiscount');
		expect(s.title).toBe('NullReferenceException: Object reference not set to an instance of an object.');
		expect(s.items[0].text).toBe('Investigate: NullReferenceException: Object reference not set to an instance of an object.');
	});

	test('a function name a compiler made up is left out of the branch', async () => {
		const s = await investigation({
			description: '',
			error: { summary: 'TypeError: x is null', type: 'TypeError', message: 'x is null', frames: [{ file: 'a.js', line: 1, column: 1, fn: '<anonymous>' }], text: 'TypeError: x is null' },
		});
		expect(s.branch).toBe('investigate/typeerror-x-is-null');
	});

	test('output selected in a terminal is enough to go on', async () => {
		const s = await investigation({ description: '', error: { text: 'panic: runtime error: index out of range [3] with length 3' } });
		expect(s.title).toBe('panic: runtime error: index out of range [3] with length 3');
		expect(s.branch).toBe('investigate/panic-runtime-error-index-out');
	});

	test('a branch name already in use gets a number', async () => {
		const first = await investigation();
		const second = await investigation();
		expect(first.branch).toBe('investigate/the-player-crashes-on-an');
		expect(second.branch).toBe('investigate/the-player-crashes-on-an-2');
		expect(second.cwd).not.toBe(first.cwd);
	});

	test('with nothing to go on, nothing is started', async () => {
		expect(await agents.investigate({ description: '   ', error: null, target: null, command: null, exitCode: null })).toBe(false);
		expect(w.sent('worktree_add')).toEqual([]);
		expect(agents.sessions()).toEqual([]);
	});

	test('a worktree that cannot be made is said, and leaves no session', async () => {
		w.on('worktree_add', () => {
			throw appError('git', 'could not create the worktree');
		});
		expect(await agents.investigate({ description: 'It crashes', error: null, target: null, command: null, exitCode: null })).toBe(false);
		expect(agents.sessions()).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'could not create the worktree' });
		expect(agents.busy()).toBe(false);
	});

	test('answers false when Claude Code could not be started', async () => {
		w.on('agent_start', () => {
			throw appError('error', 'An investigation cannot run in the main checkout');
		});
		expect(await agents.investigate({ description: 'It crashes', error: null, target: null, command: null, exitCode: null })).toBe(false);
		expect(agents.sessions()[0].status).toBe('failed');
	});

	test('its target is named as the toolbar names it: the project first, unless the group is only a file', async () => {
		const a = await investigation({ target: DEV });
		const b = await investigation({ description: 'Orders return 500', target: { ...DEV, id: 'dotnet::https', name: 'https', group: 'Shop.Api · launch profiles', source: 'launchSettings.json', runtime: 'dotnet' } });
		expect(a.investigation).toMatchObject({ targetId: 'node::dev', targetName: 'dev' });
		expect(b.investigation).toMatchObject({ targetId: 'dotnet::https', targetName: 'Shop.Api · https' });
	});

	test('images that show the failure go with its first message', async () => {
		await investigation({ images: [image()] });
		expect(options(starts()[0]).images).toEqual(['shot-1.png']);
		expect(w.sent('agent_image_save').length).toBe(1);
	});

	test('its last message is its report: a brief block in it is not taken out', async () => {
		const s = await investigation();
		say(s.id, text(`Looking.\n\n${BRIEF}`));
		expect(now(s).brief).toBeNull();
		expect(now(s).items.at(-1)!.text).toContain('```brief');
	});

	describe('progress', () => {
		test('the checklist step, what Claude said under it and what it thinks now are kept', async () => {
			const s = await investigation();
			w.emit('investigate-progress', { key: s.id, step: 2, detail: 'Reproduced with an empty queue', thinking: 'Probably next()' });
			w.emit('investigate-progress', { key: s.id, step: 3, detail: null, thinking: null });
			expect(state(s)).toMatchObject({ step: 3, details: { 2: 'Reproduced with an empty queue' }, thinking: 'Probably next()' });
		});

		test.each([
			[0, 1],
			[-4, 1],
			[9, 6],
			[2.6, 3],
			[Number.NaN, 1],
		])('a step of %d is step %d of the six', async (said, shown) => {
			const s = await investigation();
			w.emit('investigate-progress', { key: s.id, step: said, detail: 'x', thinking: null });
			expect(state(s).step).toBe(shown);
			expect(state(s).details[String(shown)]).toBe('x');
		});

		test('progress for something that is not an investigation is ignored', async () => {
			const s = await task();
			w.emit('investigate-progress', { key: s.id, step: 2, detail: 'x', thinking: 'y' });
			w.emit('investigate-progress', { key: 'no-such-session', step: 2, detail: 'x', thinking: 'y' });
			expect(now(s).investigation).toBeNull();
		});
	});

	describe('asking before it runs something', () => {
		test('the request waits on the session, which then needs the user though its turn is still going', async () => {
			const s = await investigation();
			w.emit('investigate-approval', asks(s.id));
			expect(state(s).approval).toEqual(asks(s.id));
			expect(now(s).status).toBe('running');
			expect(m.stateOf(now(s))).toBe('review');
			expect(m.stateLabel(now(s))).toBe('Waiting for you');
			expect(m.summary(now(s)).needs).toBe('Wants to run dev');
			expect(answers()).toEqual([]);
			expect(w.sent('investigate_start')).toEqual([]);
		});

		test('on screen it is not announced; anywhere else it is unread and a toast says Claude is waiting', async () => {
			const s = await investigation();
			w.emit('investigate-approval', asks(s.id));
			expect(w.toasts).toEqual([]);
			expect(now(s).unread).toBe(false);
			repos.setTab('changes');
			w.emit('investigate-approval', asks(s.id, { request: 'req-2' }));
			expect(now(s).unread).toBe(true);
			expect(w.toasts).toEqual([{ kind: 'info', title: 'Claude is waiting for your OK', message: 'The player crashes on an empty queue' }]);
		});

		test('lists say what it wants to run in a few words', async () => {
			const s = await investigation();
			w.emit('investigate-approval', asks(s.id, { tool: 'http_request', method: 'GET', path: '/orders/7' }));
			expect(m.summary(now(s)).needs).toBe('Wants to run GET /orders/7');
			w.emit('investigate-approval', asks(s.id, { tool: 'run_tests', target: 'test' }));
			expect(m.summary(now(s)).needs).toBe('Wants to run the tests');
			w.emit('investigate-approval', asks(s.id, { project: 'Shop.Api', target: 'https' }));
			expect(m.summary(now(s)).needs).toBe('Wants to run Shop.Api');
		});

		test('a request for a session that is gone, or is not an investigation, is answered no', async () => {
			const s = await task();
			w.emit('investigate-approval', asks('no-such-session', { request: 'req-a' }));
			w.emit('investigate-approval', asks(s.id, { request: 'req-b' }));
			await tick();
			expect(answers()).toEqual([
				{ request: 'req-a', allow: false },
				{ request: 'req-b', allow: false },
			]);
		});

		test('"Don\'t run" tells Claude no, and the request is gone', async () => {
			const s = await investigation();
			w.emit('investigate-approval', asks(s.id));
			await agents.deny(s.id);
			expect(answers()).toEqual([{ request: 'req-1', allow: false }]);
			expect(state(s).approval).toBeNull();
			expect(w.sent('investigate_start')).toEqual([]);
			await agents.deny(s.id);
			expect(answers().length).toBe(1);
		});

		test('allowing a request to the app answers yes, and starts nothing', async () => {
			const s = await investigation();
			w.emit('investigate-approval', asks(s.id, { tool: 'http_request', method: 'GET', path: '/orders/7' }));
			await agents.allow(s.id);
			expect(answers()).toEqual([{ request: 'req-1', allow: true }]);
			expect(w.sent('investigate_start')).toEqual([]);
			expect(state(s)).toMatchObject({ approval: null, runs: 0, tab: null });
		});

		test('allowing a run starts it on a terminal of its own in the worktree, and counts the run', async () => {
			const s = await investigation();
			w.on('investigate_start', () => ({ key: 'pty-9', port: 5174, command: 'npm run dev', replay: 1 }));
			w.emit('investigate-approval', asks(s.id));
			await until(agents.allow(s.id));
			expect(w.sent('investigate_start').length).toBe(1);
			expect(w.sent('investigate_start')[0].args.request).toBe('req-1');
			expect(answers()).toEqual([]);
			expect(state(s)).toMatchObject({ approval: null, runs: 1, port: 5174 });
			const { TerminalStore } = await import('./terminal.store');
			const tab = w.get(TerminalStore).all().find((t) => t.id === state(s).tab);
			expect(tab).toMatchObject({ repoId: repoId(), cwd: s.cwd, kind: 'investigation', title: 'Investigation · dev :5174' });
		});

		test('a run that could not be started is said, and Claude is told no instead of being left waiting', async () => {
			const s = await investigation();
			w.on('investigate_start', () => {
				throw appError('error', 'Claude is no longer waiting for that');
			});
			w.emit('investigate-approval', asks(s.id));
			await until(agents.allow(s.id));
			expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'Claude is no longer waiting for that' });
			expect(answers()).toEqual([{ request: 'req-1', allow: false }]);
			expect(state(s)).toMatchObject({ approval: null, runs: 0, tab: null });
		});

		test('allowing with nothing waiting does nothing', async () => {
			const s = await investigation();
			await agents.allow(s.id);
			await agents.allow(s.id, true);
			expect(answers()).toEqual([]);
			expect(w.sent('investigate_start')).toEqual([]);
			expect(agents.alwaysAllowed(now(s))).toBe(false);
		});

		test('"Always allow" is remembered for that target in that repository, and from then on the window answers by itself', async () => {
			const s = await investigation({ target: DEV });
			w.emit('investigate-approval', asks(s.id, { tool: 'http_request', method: 'GET', path: '/' }));
			await agents.allow(s.id, true);
			expect(JSON.parse(localStorage.getItem('studio.investigate.allow')!)).toEqual({ [repoId()]: ['dev'] });
			expect(agents.alwaysAllowed(now(s))).toBe(true);
			repos.setTab('changes');
			w.emit('investigate-approval', asks(s.id, { request: 'req-2', tool: 'http_request', method: 'POST', path: '/queue' }));
			await tick();
			expect(answers()).toEqual([
				{ request: 'req-1', allow: true },
				{ request: 'req-2', allow: true },
			]);
			expect(state(s).approval).toBeNull();
			expect(toasts(/waiting for your OK/)).toEqual([]);
		});

		test('it is remembered once, and an investigation of another target is still asked', async () => {
			const s = await investigation({ target: DEV });
			w.emit('investigate-approval', asks(s.id, { tool: 'http_request' }));
			await agents.allow(s.id, true);
			w.emit('investigate-approval', asks(s.id, { request: 'req-2', tool: 'http_request' }));
			await tick();
			await agents.allow(s.id, true);
			expect(JSON.parse(localStorage.getItem('studio.investigate.allow')!)).toEqual({ [repoId()]: ['dev'] });
			const other = await investigation({ description: 'The build breaks', target: { ...DEV, id: 'node::build', name: 'build' } });
			expect(agents.alwaysAllowed(other)).toBe(false);
			w.emit('investigate-approval', asks(other.id, { request: 'req-3', tool: 'http_request' }));
			await tick();
			expect(state(other).approval?.request).toBe('req-3');
			expect(answers().some((a) => a.request === 'req-3')).toBe(false);
		});

		test('what was allowed before is read from storage at the start; anything else there is ignored', async () => {
			await boot(() => localStorage.setItem('studio.investigate.allow', JSON.stringify({ [repoId()]: ['dev'] })));
			const s = await investigation({ target: DEV });
			expect(agents.alwaysAllowed(s)).toBe(true);
			for (const broken of ['not json', '["dev"]', 'null']) {
				await boot(() => localStorage.setItem('studio.investigate.allow', broken));
				const again = await investigation({ target: DEV });
				expect(agents.alwaysAllowed(again)).toBe(false);
			}
		});

		test('stopping takes back what it was waiting to run', async () => {
			const s = await investigation();
			w.emit('investigate-approval', asks(s.id));
			await agents.stop(s.id);
			expect(state(s).approval).toBeNull();
			expect(m.stateOf(now(s))).toBe('stopped');
			await done(s.id, false);
			expect(state(s).ended).not.toBeNull();
			expect(state(s).report).toBeNull();
		});
	});

	describe('when its turn ends', () => {
		test('its last message is read as the report, and with no recording left in the worktree the fix is ready', async () => {
			const s = await investigation();
			say(s.id, tool('Edit', { file_path: 'src/player/queue.ts' }));
			await concludes(s, REPORT, changed('src/player/queue.ts', CLEAN));
			expect(w.sent('worktree_diff').at(-1)!.args).toEqual({ id: repoId(), path: s.cwd, base: s.base });
			expect(state(s)).toMatchObject({ report: { found: true, summary: 'next() returns null at the end of the queue' }, leftover: [], checking: false, cleanups: 0 });
			expect(state(s).ended).not.toBeNull();
			expect(now(s).status).toBe('idle');
			expect(m.stateLabel(now(s))).toBe('Cause found · fix ready');
			expect(starts().length).toBe(1);
		});

		test('on screen it is not announced; elsewhere a toast says the cause was found', async () => {
			const seen = await investigation();
			await concludes(seen, REPORT);
			expect(w.toasts).toEqual([]);
			const unseen = await investigation({ description: 'Seek drifts after a pause' });
			repos.setTab('changes');
			await concludes(unseen, REPORT);
			expect(now(unseen).unread).toBe(true);
			expect(w.toasts).toEqual([{ kind: 'success', title: 'Cause found', message: 'Seek drifts after a pause' }]);
		});

		test('a report that found nothing says so', async () => {
			const s = await investigation();
			repos.setTab('changes');
			await concludes(s, JSON.stringify({ found: false, summary: 'It could not be reproduced.' }));
			expect(m.stateLabel(now(s))).toBe('No cause found');
			expect(w.toasts.at(-1)).toMatchObject({ title: 'Investigation finished' });
		});

		test('recording still in the code sends Claude back to remove it, and the report is not final yet', async () => {
			const s = await investigation();
			started(s.id, 'conversation-1');
			repos.setTab('changes');
			await concludes(s, REPORT, changed('src/player/queue.ts', MARKED), changed('src/main.ts', CLEAN));
			expect(state(s)).toMatchObject({ leftover: ['src/player/queue.ts'], cleanups: 1, checking: false, ended: null });
			expect(now(s).status).toBe('running');
			const sent = starts()[1];
			expect(sent).toMatchObject({ key: s.id, cwd: s.cwd, resume: 'conversation-1', options: { tools: INVESTIGATE_RULES } });
			expect(String(sent.prompt).split('\n')[0]).toBe('[investigate-cleanup]');
			expect(String(sent.prompt)).toContain('src/player/queue.ts');
			expect(String(sent.prompt)).not.toContain('src/main.ts');
			expect(now(s).items.at(-1)).toEqual({ kind: 'user', text: 'The recording is still in the code. Asked Claude to remove it before the fix is shown.' });
			expect(toasts(/Cause found|Investigation finished/)).toEqual([]);
		});

		test('once the recording is gone the fix is ready', async () => {
			const s = await investigation();
			await concludes(s, REPORT, changed('src/player/queue.ts', MARKED));
			await concludes(s, REPORT, changed('src/player/queue.ts', CLEAN));
			expect(state(s)).toMatchObject({ leftover: [], cleanups: 1 });
			expect(state(s).ended).not.toBeNull();
			expect(m.stateLabel(now(s))).toBe('Cause found · fix ready');
			expect(starts().length).toBe(2);
		});

		test('it is sent back twice at most; after that the report is shown and the fix is not offered', async () => {
			const s = await investigation();
			await concludes(s, REPORT, changed('src/player/queue.ts', MARKED));
			await concludes(s, REPORT, changed('src/player/queue.ts', MARKED));
			expect(state(s).cleanups).toBe(2);
			expect(starts().length).toBe(3);
			await concludes(s, REPORT, changed('src/player/queue.ts', MARKED));
			expect(starts().length).toBe(3);
			expect(now(s).status).toBe('idle');
			expect(state(s)).toMatchObject({ leftover: ['src/player/queue.ts'], cleanups: 2 });
			expect(state(s).ended).not.toBeNull();
			expect(m.stateLabel(now(s))).toBe('Cause found');
		});

		test('a recording helper left behind counts as recording; a marker on a removed line does not', async () => {
			const s = await investigation();
			const removed = '@@ -1,3 +1,2 @@\n function next() {\n-  record("next", { cursor }); // studio-replay\n   return queue[cursor];';
			await concludes(s, REPORT, changed('tools/studio_replay.py'), changed('src/player/queue.ts', removed));
			expect(state(s).leftover).toEqual(['tools/studio_replay.py']);
		});

		test('a worktree that cannot be read ends it with the report and nothing said to be left', async () => {
			const s = await investigation();
			w.on('worktree_diff', () => {
				throw appError('git', 'not a working tree');
			});
			say(s.id, text(REPORT));
			await done(s.id);
			expect(state(s)).toMatchObject({ leftover: [], checking: false, report: { found: true } });
			expect(state(s).ended).not.toBeNull();
		});

		test('a turn that failed ends it without a report, and the worktree is not looked at', async () => {
			const s = await investigation();
			const diffs = w.sent('worktree_diff').length;
			say(s.id, text(REPORT));
			await done(s.id, false, 'Claude Code crashed');
			expect(now(s).status).toBe('failed');
			expect(state(s).report).toBeNull();
			expect(state(s).ended).not.toBeNull();
			expect(w.sent('worktree_diff').length).toBe(diffs);
			expect(m.stateLabel(now(s))).toBe('Failed');
		});

		// A bug until 2026-11-23 (agents.store.ts, `onDone` with `conclude`).
		// What holds now: a turn that ends where the user is not looking is announced (CLAUDE.md: "sets `unread` ... and
		// shows a toast"), and `announce` has the words for this very case ("Investigation failed").
		// Before the fix: an investigation's end goes to `conclude` instead of `announce`, and `conclude` returns early
		// for a failed turn without announcing, so the session turns unread and failed with no toast; the
		// "Investigation failed" wording can never be reached.
		test('a turn that failed where nobody is looking is announced', async () => {
			const s = await investigation();
			repos.setTab('changes');
			await done(s.id, false, 'Claude Code crashed');
			expect(now(s).unread).toBe(true);
			expect(toasts('Investigation failed').length).toBe(1);
		});

		test('while the worktree is being checked it says so', async () => {
			const s = await investigation();
			let release!: (diff: WorktreeDiff) => void;
			w.on('worktree_diff', () => new Promise<WorktreeDiff>((r) => (release = r)));
			say(s.id, text(REPORT));
			await done(s.id);
			expect(state(s)).toMatchObject({ checking: true, ended: null });
			release(diffOf());
			await tick();
			expect(state(s).checking).toBe(false);
		});

		test('a follow-up goes in under the investigation\'s rules, and the report does not stand until it is answered', async () => {
			const s = await investigation({ target: DEV });
			started(s.id, 'conversation-1');
			await concludes(s, REPORT);
			await agents.send(s.id, 'Could it also happen on shuffle?');
			const sent = starts()[1];
			expect(String(sent.prompt).split('\n')[0]).toBe('[investigate-follow-up]');
			expect(String(sent.prompt)).toContain('Could it also happen on shuffle?');
			expect(sent).toMatchObject({ resume: 'conversation-1', mode: 'acceptEdits', options: { tools: INVESTIGATE_RULES, builtin: INVESTIGATE_BUILTIN, investigate: { target: 'node::dev' } } });
			expect(now(s).items.at(-1)).toEqual({ kind: 'user', text: 'Could it also happen on shuffle?' });
			expect(state(s).ended).toBeNull();
			expect(state(s).report).not.toBeNull();
		});

		test('an answer to a follow-up that is not a report leaves the earlier report standing', async () => {
			const s = await investigation();
			await concludes(s, REPORT);
			await agents.send(s.id, 'Thanks');
			await concludes(s, 'You are welcome.');
			expect(state(s).report).toMatchObject({ summary: 'next() returns null at the end of the queue' });
			expect(state(s).ended).not.toBeNull();
		});
	});

	describe('the fix', () => {
		test('accepting commits in its worktree with the user\'s own message', async () => {
			const s = await investigation();
			await concludes(s, REPORT);
			expect(await agents.commitFix(now(s), 'Return null past the end of the queue', 'Found by an investigation.')).toBe(true);
			expect(w.sent('investigate_commit').map((c) => c.args)).toEqual([{ id: repoId(), cwd: s.cwd, summary: 'Return null past the end of the queue', description: 'Found by an investigation.' }]);
		});

		test('a commit the native side refuses is said and answered false', async () => {
			const s = await investigation();
			w.on('investigate_commit', () => {
				throw appError('error', 'Recording is still in src/player/queue.ts');
			});
			expect(await agents.commitFix(now(s), 'Fix')).toBe(false);
			expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', message: 'Recording is still in src/player/queue.ts' });
		});

		test('discarding takes the investigation, its worktree and its branch, after its app is closed', async () => {
			const s = await investigation();
			await concludes(s, REPORT);
			agents.replaying.set(s.id);
			await agents.discard(now(s));
			expect(w.sent('investigate_close').map((c) => c.args)).toEqual([{ key: s.id }]);
			expect(w.sent('worktree_remove').map((c) => c.args)).toEqual([{ id: repoId(), path: s.cwd, force: true, deleteBranch: true }]);
			const order = w.calls.map((c) => c.cmd);
			expect(order.indexOf('investigate_close')).toBeLessThan(order.indexOf('worktree_remove'));
			expect(agents.sessions()).toEqual([]);
			expect(agents.replaying()).toBeNull();
		});

		test('discarding closes the terminal of the app it started', async () => {
			const s = await investigation();
			w.on('investigate_start', () => ({ key: 'pty-9', port: 5174, command: 'npm run dev', replay: 1 }));
			w.emit('investigate-approval', asks(s.id));
			await until(agents.allow(s.id));
			const { TerminalStore } = await import('./terminal.store');
			expect(w.get(TerminalStore).all().length).toBe(1);
			await agents.stop(s.id);
			await done(s.id, false);
			await agents.discard(now(s));
			expect(w.get(TerminalStore).all()).toEqual([]);
		});
	});
});

describe('an investigation without Claude Code', () => {
	test('is not started, and says what to install', async () => {
		await boot(() => w.on('agent_available', () => null));
		await tick();
		expect(agents.cli()).toBeNull();
		expect(await agents.investigate({ description: 'It crashes', error: null, target: null, command: null, exitCode: null })).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'Claude Code was not found' });
		expect(w.sent('worktree_add')).toEqual([]);
	});

	test('a version check that fails counts as not installed', async () => {
		await boot(() =>
			w.on('agent_available', () => {
				throw appError('error', 'spawn failed');
			})
		);
		await tick();
		expect(agents.cli()).toBeNull();
	});

	test('the version is known once the store has started', async () => {
		await boot(() => w.on('agent_available', () => '2.1.330'));
		await tick();
		expect(agents.cli()).toBe('2.1.330');
	});

	test('opening the box to describe a bug keeps the terminal output that goes with it, cut to size', async () => {
		await boot();
		agents.openInvestigate(`  ${'x'.repeat(9000)}  `);
		expect(agents.investigateDraft()).toEqual({ output: 'x'.repeat(8000) });
		agents.openInvestigate();
		expect(agents.investigateDraft()).toEqual({ output: '' });
	});
});

// ---- the language servers' look ------------------------------------------------

describe('the language servers\' look at a task\'s change', () => {
	beforeEach(() => boot());

	const found: CheckResult = { problems: [problem(), problem({ path: 'src/ui/transport.ts', line: 4, changed: false })], known: 1, impact: [{ symbol: 'next', path: 'src/player/queue.ts', line: 10, uses: [{ path: 'src/ui/transport.ts', line: 4 }] }], servers: ['TypeScript'], files: 1, users: 1, finished: true };

	/** A task whose turn ends with these files changed in its worktree. */
	async function ends(...files: ChangedFile[]): Promise<AgentSession> {
		const s = await task();
		treeOf(s, { changes: files.length });
		w.on('worktree_diff', () => diffOf(...files));
		await done(s.id);
		return now(s);
	}

	test('when its turn ends, the changed files a server could know are put to them, in the task\'s own checkout, against the commit it started from', async () => {
		const s = await ends(changed('src/player/queue.ts', '@@'), changed('README.md'), changed('src/lib.rs'), changed('notes.txt'));
		expect(w.sent('worktree_diff').at(-1)!.args).toEqual({ id: repoId(), path: s.cwd, base: s.base });
		expect(check).toHaveBeenCalledTimes(1);
		expect(check).toHaveBeenCalledWith(repoId(), s.cwd, [changed('src/player/queue.ts', '@@'), changed('src/lib.rs')], 'b'.repeat(40));
	});

	test('what they found is on the session, and nothing is sent to the agent by itself', async () => {
		check.mockResolvedValue(found);
		const s = await ends(changed('src/player/queue.ts'));
		expect(s.check).toEqual({ state: 'done', ...found });
		expect(starts().length).toBe(1);
		expect(written(s.id)!.check).toEqual({ state: 'done', ...found });
	});

	test('while they look, the session says it is being checked; looking is not activity', async () => {
		let release!: (r: CheckResult) => void;
		check.mockImplementation(() => new Promise<CheckResult>((r) => (release = r)));
		const s = await ends(changed('src/player/queue.ts'));
		expect(s.check).toMatchObject({ state: 'checking', problems: [] });
		const before = s.updated;
		await tick(3000);
		release(found);
		await tick();
		expect(now(s).check).toMatchObject({ state: 'done', problems: found.problems });
		expect(now(s).updated).toBe(before);
	});

	test('with no server for any of the files there is nothing to show', async () => {
		const s = await ends(changed('src/player/queue.ts'));
		expect(s.check).toBeNull();
	});

	test('with nothing changed that a server could know, none is asked', async () => {
		const s = await ends(changed('README.md'));
		expect(check).not.toHaveBeenCalled();
		expect(s.check).toBeNull();
	});

	test('of very many changed files only the first sixty are put to them', async () => {
		await ends(...Array.from({ length: 75 }, (_, i) => changed(`src/file-${i}.ts`)));
		const files = check.mock.calls[0][2];
		expect(files.length).toBe(60);
		expect(files[59].path).toBe('src/file-59.ts');
	});

	test('switched off in Settings, nothing is looked at', async () => {
		agents.setChecks(false);
		const s = await ends(changed('src/player/queue.ts'));
		expect(check).not.toHaveBeenCalled();
		expect(s.check).toBeNull();
		agents.setChecks(true);
		expect(localStorage.getItem('studio.agents.check')).toBe('on');
		await agents.checkWork(s.id);
		expect(check).toHaveBeenCalledTimes(1);
	});

	test('an answer that arrives after the next turn has started is dropped: the files have moved on', async () => {
		let release!: (r: CheckResult) => void;
		check.mockImplementation(() => new Promise<CheckResult>((r) => (release = r)));
		const s = await ends(changed('src/player/queue.ts'));
		await agents.send(s.id, 'One more thing');
		release(found);
		await tick();
		expect(now(s).check).toBeNull();
	});

	test('an older look that answers after a newer one does not replace it', async () => {
		const waiting: ((r: CheckResult) => void)[] = [];
		check.mockImplementation(() => new Promise<CheckResult>((r) => waiting.push(r)));
		const s = await ends(changed('src/player/queue.ts'));
		void agents.checkWork(s.id);
		await tick();
		expect(waiting.length).toBe(2);
		waiting[1]({ ...found, known: 7 });
		await tick();
		waiting[0]({ ...found, known: 1 });
		await tick();
		expect(now(s).check).toMatchObject({ state: 'done', known: 7 });
	});

	test('a look that fails shows nothing rather than "checking" for ever', async () => {
		check.mockRejectedValue(new Error('The server would not start'));
		const s = await ends(changed('src/player/queue.ts'));
		expect(s.check).toBeNull();
		expect(w.toasts.filter((t) => t.kind === 'error')).toEqual([]);
	});

	test('a worktree whose changes cannot be read shows nothing', async () => {
		const s = await task();
		w.on('worktree_diff', () => {
			throw appError('git', 'not a working tree');
		});
		await done(s.id);
		expect(check).not.toHaveBeenCalled();
		expect(now(s).check).toBeNull();
	});

	test('"Ask Claude to fix them" is the one thing that hands the errors to the agent, as its next turn', async () => {
		check.mockResolvedValue(found);
		const s = await ends(changed('src/player/queue.ts'));
		started(s.id, 'conversation-1');
		await agents.fixProblems(s.id);
		expect(starts()[1]).toMatchObject({ key: s.id, prompt: fixProblemsPrompt(found.problems), resume: 'conversation-1', options: { brief: true } });
		expect(now(s).items.at(-1)).toEqual({ kind: 'user', text: 'Asked Claude to fix the 2 errors its change brought, as the language server reports them.' });
		expect(now(s)).toMatchObject({ status: 'running', check: null });
	});

	test('one error is said in the singular', async () => {
		check.mockResolvedValue({ ...found, problems: [problem()] });
		const s = await ends(changed('src/player/queue.ts'));
		await agents.fixProblems(s.id);
		expect(now(s).items.at(-1)!.text).toBe('Asked Claude to fix the error its change brought, as the language server reports it.');
	});

	test('with no errors there is nothing to ask for', async () => {
		check.mockResolvedValue({ ...found, problems: [] });
		const s = await ends(changed('src/player/queue.ts'));
		await agents.fixProblems(s.id);
		expect(starts().length).toBe(1);
	});

	test('the changes of a session are what its checkout holds that the commit it started from does not', async () => {
		const s = await task();
		w.on('worktree_diff', () => diffOf(changed('src/a.ts')));
		expect(await agents.changes(s)).toEqual(diffOf(changed('src/a.ts')));
		expect(w.sent('worktree_diff').at(-1)!.args).toEqual({ id: repoId(), path: s.cwd, base: s.base });
	});
});

// ---- the functions that only read a session --------------------------------------

describe('how a session stands', () => {
	beforeEach(async () => {
		w = await world();
		m = await import('./agents.store');
	});

	const approval: InvestigateApproval = { key: 's1', request: 'r', tool: 'run_target', target: 'dev', group: null, project: null, command: 'npm run dev', port: null, method: null, path: null, body: null, touches: null };
	const report = { found: true, summary: 'x', path: [], evidence: [], run: null, causeSeq: null, crashSeq: null, notes: {}, test: null };
	const brief = { title: 'Shuffle button', did: 'Added it.', needs: 'Keep the old icon?', choices: ['Yes', 'No'] };

	test.each<[string, Partial<AgentSession>, string, string]>([
		['a turn is running', { status: 'running', review: true, stopped: true }, 'working', 'Working'],
		['its last turn failed', { status: 'failed', review: true, stopped: true }, 'failed', 'Failed'],
		['it was stopped by hand', { stopped: true, review: true }, 'stopped', 'Stopped'],
		['it has work to review', { review: true }, 'review', 'Needs review'],
		['it has work to review and asked something', { review: true, brief }, 'review', 'Needs review'],
		['it only asked something', { brief }, 'review', 'Needs you'],
		['its brief asks nothing', { brief: { ...brief, needs: null, choices: [] } }, 'finished', 'Finished'],
		['it ended unseen with nothing to do', { unread: true }, 'finished', 'Finished'],
		['nothing is left', {}, 'finished', 'Finished'],
	])('when %s', (_what, over, state, label) => {
		expect(m.stateOf(session(over))).toBe(state);
		expect(m.stateLabel(session(over))).toBe(label);
	});

	test.each<[string, Partial<AgentSession>, Partial<Investigation>, string, string]>([
		['is running', { status: 'running' }, {}, 'working', 'Investigating'],
		['is having its worktree checked', { status: 'running' }, { checking: true }, 'working', 'Checking the fix'],
		['asked to run something, though its turn is going', { status: 'running' }, { approval }, 'review', 'Waiting for you'],
		['ended with no report', {}, {}, 'finished', 'Finished'],
		['found no cause', {}, { report: { ...report, found: false } }, 'finished', 'No cause found'],
		['found the cause but left recording in the code', {}, { report, leftover: ['src/a.ts'] }, 'finished', 'Cause found'],
		['found the cause and cleaned up', {}, { report }, 'finished', 'Cause found · fix ready'],
		['failed', { status: 'failed' }, { report }, 'failed', 'Failed'],
		['was stopped', { stopped: true }, {}, 'stopped', 'Stopped'],
	])('an investigation that %s', (_what, over, investigation, state, label) => {
		const s = session({ kind: 'investigate', ...over, investigation: looking(investigation) });
		expect(m.stateOf(s)).toBe(state);
		expect(m.stateLabel(s)).toBe(label);
	});

	test.each<[string, Partial<Pipeline>, AgentSession['status'], string]>([
		['between Claude\'s turns', { step: 'review' }, 'idle', 'working'],
		['in a turn', { step: 'code' }, 'running', 'working'],
		['waiting on the user', { step: 'plan', waiting: true }, 'idle', 'review'],
		['waiting, with a message of the user\'s being worked on', { step: 'plan', waiting: true }, 'running', 'working'],
		['done', { step: 'done' }, 'idle', 'finished'],
	])('a pipeline %s', (_what, p, status, state) => {
		// A pipeline says itself where it stands: review, stopped and failed on the session do not.
		expect(m.stateOf(session({ status, review: true, stopped: true, pipeline: { ...newPipeline('bug'), ...p } }))).toBe(state);
	});

	test('a session is called by the name its brief gave it, else by what it was asked', () => {
		expect(m.nameOf(session())).toBe('Add a shuffle button');
		expect(m.nameOf(session({ name: 'Shuffle button' }))).toBe('Shuffle button');
		expect(m.nameOf(session({ name: '' }))).toBe('Add a shuffle button');
	});

	test('the last thing said is the latest turn\'s last reply or error, as one plain line', () => {
		const items: AgentItem[] = [
			{ kind: 'user', text: 'Add a shuffle button' },
			{ kind: 'text', text: 'Looking.' },
			{ kind: 'tool', text: 'Read', detail: 'src/a.ts' },
			{ kind: 'text', text: '## Done\n\nAdded **the button** in `src/ui/transport.ts`.\n\n```ts\nconst x = 1;\n```' },
			{ kind: 'tool', text: 'Bash', detail: 'npm test' },
		];
		expect(m.lastSaid(session({ items }))).toBe('Done Added the button in src/ui/transport.ts.');
		expect(m.lastSaid(session({ items: [...items, { kind: 'error', text: 'Stopped.' }] }))).toBe('Stopped.');
		expect(m.lastSaid(session({ items: [...items, { kind: 'user', text: 'And a test' }] }))).toBe('');
		expect(m.lastSaid(session())).toBe('');
	});

	test('a read-only session may look at history when its rules allow git', () => {
		expect(m.scopeOf(session({ kind: 'ask', tools: m.ASK_TOOLS.code }))).toBe('code');
		expect(m.scopeOf(session({ kind: 'ask', tools: m.ASK_TOOLS.history }))).toBe('history');
		expect(m.scopeOf(session({ tools: null }))).toBe('code');
	});

	describe('in three lines', () => {
		const items: AgentItem[] = [
			{ kind: 'user', text: 'Add a shuffle button' },
			{ kind: 'text', text: 'Added the button.' },
		];

		test('work in a worktree of its own is reviewed, then merged; in the main checkout just reviewed', () => {
			expect(m.summary(session({ items, review: true }))).toEqual({ asked: 'Add a shuffle button', now: null, did: 'Added the button.', needs: 'Review its changes, then merge', choices: [] });
			expect(m.summary(session({ items, review: true, isolated: false })).needs).toBe('Review its changes');
		});

		test('a question it asked comes before "review", with its choices', () => {
			expect(m.summary(session({ items, review: true, brief }))).toEqual({ asked: 'Add a shuffle button', now: null, did: 'Added it.', needs: 'Keep the old icon?', choices: ['Yes', 'No'] });
		});

		test('an unseen reply is to be read; an unseen answer is an answer', () => {
			expect(m.summary(session({ items, unread: true })).needs).toBe('Read its reply');
			expect(m.summary(session({ items, unread: true, kind: 'ask' })).needs).toBe('Read the answer');
			expect(m.summary(session({ items })).needs).toBeNull();
		});

		test('an investigation waiting for an OK says what it wants to run', () => {
			const waiting = (a: Partial<InvestigateApproval>): string | null => m.summary(session({ kind: 'investigate', status: 'running', items, investigation: looking({ approval: { ...approval, ...a } }) })).needs;
			expect(waiting({})).toBe('Wants to run dev');
			expect(waiting({ target: null })).toBe('Wants to run the app');
			expect(waiting({ tool: 'run_tests' })).toBe('Wants to run the tests');
			expect(waiting({ tool: 'http_request', method: 'POST', path: '/orders' })).toBe('Wants to run POST /orders');
			expect(waiting({ tool: 'http_request' })).toBe('Wants to run a request');
		});

		test('a pipeline says where it stands; the brief only adds what the last turn did', () => {
			const p = newPipeline('bug');
			const s = session({ items, brief, task: 'Fix the seek drift', review: true, status: 'failed' });
			expect(m.summary({ ...s, status: 'running', pipeline: p })).toEqual({ asked: 'Fix the seek drift', now: 'Writing the plan', did: '', needs: null, choices: [] });
			expect(m.summary({ ...s, status: 'idle', pipeline: { ...p, step: 'test' } })).toMatchObject({ now: 'Running the tests · free', did: 'Added it.', needs: null });
			expect(m.summary({ ...s, status: 'idle', pipeline: { ...p, waiting: true, note: 'Approve the plan', reason: 'approve' } })).toEqual({ asked: 'Fix the seek drift', now: null, did: 'Added it.', needs: 'Approve the plan', choices: ['Yes', 'No'] });
			expect(m.summary({ ...s, status: 'idle', pipeline: { ...p, step: 'ship', waiting: true, note: null, reason: 'ship' } })).toMatchObject({ needs: 'Needs you', choices: [] });
			expect(m.summary({ ...s, status: 'idle', task: undefined, pipeline: { ...p, step: 'done' } })).toMatchObject({ asked: 'Add a shuffle button', now: null, needs: null });
		});
	});
});

describe('names and prompts', () => {
	beforeEach(async () => {
		w = await world();
		m = await import('./agents.store');
	});

	test.each([
		['NullReferenceException in ApplyDiscount', 'investigate/nullreferenceexception-in-applydiscount'],
		['The player crashes when the queue is empty and repeat is on', 'investigate/the-player-crashes-when-the'],
		["  TypeError: Cannot read properties of null (reading 'title')  ", 'investigate/typeerror-cannot-read-properties-of'],
		['HTTP 500 /orders/7', 'investigate/http-500-orders-7'],
		['¿¿¿ ???', 'investigate/bug'],
		['', 'investigate/bug'],
	])('an investigation of "%s" works on %s', (summary, branch) => {
		expect(m.investigateBranch(summary)).toBe(branch);
	});

	test('an investigation\'s branch is at most 60 characters after the prefix and never ends in a hyphen', () => {
		const branch = m.investigateBranch(`${'a'.repeat(59)} bcd efg`);
		expect(branch).toBe(`investigate/${'a'.repeat(59)}`);
		expect(m.investigateBranch(`${'a'.repeat(30)} ${'b'.repeat(40)}`)).toBe(`investigate/${'a'.repeat(30)}-${'b'.repeat(29)}`);
	});

	test('attempts work on branch, branch-2, branch-3', () => {
		expect([0, 1, 2, 3].map((n) => m.attemptBranch('agent/shuffle', n))).toEqual(['agent/shuffle', 'agent/shuffle', 'agent/shuffle-2', 'agent/shuffle-3']);
	});

	test('a question about the code starts with its tag, says it is read-only with three tools, and ends with the question', () => {
		const prompt = m.askPrompt('code', 'Where is the queue advanced?');
		const lines = prompt.split('\n');
		expect(lines[0]).toBe('[ask-repository]');
		expect(lines.at(-1)).toBe('Question: Where is the queue advanced?');
		expect(prompt).toContain('This is read-only. You have Read, Grep and Glob only.');
		expect(prompt).not.toContain('Bash');
		expect(prompt).toContain('`path:line`');
	});

	test('a question about history adds the four git commands and the forms of them that are refused', () => {
		const prompt = m.askPrompt('history', 'When did repeat arrive?');
		expect(prompt.split('\n')[0]).toBe('[ask-history]');
		expect(prompt.split('\n').at(-1)).toBe('Question: When did repeat arrive?');
		expect(prompt).toContain('plus Bash for `git log`, `git show`, `git diff` and `git blame` only');
		for (const refused of ['one plain git command', 'no `cd`', 'no `git -C`', 'no pipes']) {
			expect(prompt).toContain(refused);
		}
		expect(prompt).toContain('short hash');
	});

	test('the tools of a read-only session are the three that read, plus git\'s four for history', () => {
		expect(m.ASK_TOOLS.code).toEqual(['Read', 'Grep', 'Glob']);
		expect(m.ASK_TOOLS.history.filter((t) => !m.ASK_TOOLS.code.includes(t))).toEqual(['Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git blame:*)']);
	});
});
