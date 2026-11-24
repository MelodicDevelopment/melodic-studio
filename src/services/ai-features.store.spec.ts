import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, world, type Call, type World } from '../test/world';
import type { AgentSession, AgentsStore } from './agents.store';
import type { AiFeaturesStore } from './ai-features.store';
import type { FileChange, RepoStatus } from './backend.service';
import type { RepoStore } from './repo.store';
import type { Finding } from './ai-prompts';

// The language servers reach for Monaco as soon as they exist, and the real one needs workers and a layout
// this page does not have. Nothing here is about the editor, so it never finishes loading.
vi.mock('../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: () => Promise.resolve(), releaseMonacoStyles: () => undefined }));

let w: World;
let repos: RepoStore;
let agents: AgentsStore;
let ai: AiFeaturesStore;

/** What a review is given to look at, as the native side hands it over. */
const RANGE = {
	scope: 'push',
	text: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
	truncated: false,
	base: '1'.repeat(40),
	head: '2'.repeat(40),
	against: 'origin/main',
	commits: [{ hash: '2'.repeat(40), summary: 'Change a' }],
	files: [
		{ path: 'src/a.ts', oldPath: null, status: 'modified' },
		{ path: 'src/b.ts', oldPath: null, status: 'added' },
	],
};
const BUG = { file: 'src/a.ts', line: 1, severity: 'bug', title: 'Off by one', detail: 'The loop stops early.' };
const RISK = { file: 'src/b.ts', line: 4, severity: 'risk', title: 'No check for empty', detail: '' };
const NIT = { file: 'src/a.ts', line: 9, severity: 'nit', title: 'Name could be clearer', detail: '' };
const FILE_DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
const CONFLICT = ['first line', '<<<<<<< HEAD', 'mine', '=======', 'theirs', '>>>>>>> origin/main', 'last line', ''].join('\n');
const RESOLVED = ['<resolution conflict="1">', 'both of them', '</resolution>', '<summary>', 'Kept both sides.', '</summary>'].join('\n');

// ---- local helpers: Claude and the native side, played by the test ---------------------------------

/** Promises, effects and timers that are due get their turn. The clock is ours (see beforeEach). */
async function tick(rounds = 4): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await vi.advanceTimersByTimeAsync(1);
	}
}

const quick = (c: Call): boolean => !!(c.args.options as { quick?: boolean } | null)?.quick;
/** The one-shot questions asked so far. */
const asks = (): Call[] => w.sent('agent_start').filter(quick);
/** Turns of agent sessions started so far. */
const turns = (): Call[] => w.sent('agent_start').filter((c) => !quick(c));
const prompt = (c: Call | undefined): string => String(c?.args.prompt ?? '');
const options = (c: Call | undefined): Record<string, unknown> => (c?.args.options ?? {}) as Record<string, unknown>;
const keyOf = (c: Call | undefined): string => String(c?.args.key);

/** Claude says something on the way to its answer. */
function says(text: string, ask = asks().at(-1)): void {
	w.emit('agent-event', { key: keyOf(ask), event: { type: 'assistant', message: { content: [{ type: 'text', text }] } } });
}

/** Claude's answer to a question (the last one asked, unless another is named), and its end. */
async function answer(text: string, ask = asks().at(-1)): Promise<void> {
	w.emit('agent-event', { key: keyOf(ask), event: { type: 'result', subtype: 'success', is_error: false, result: text } });
	w.emit('agent-done', { key: keyOf(ask), ok: true, error: '' });
	await tick();
}

/** Claude Code fails on a question. */
async function fails(error: string, ask = asks().at(-1)): Promise<void> {
	w.emit('agent-done', { key: keyOf(ask), ok: false, error });
	await tick();
}

const review = (findings: Record<string, unknown>[], summary = 'Read it all.'): string => JSON.stringify({ summary, findings });
const message = (summary: string, description = ''): string => JSON.stringify({ summary, description });
const changed = (path: string): FileChange => repos.status()!.files.find((f) => f.path === path)!;
const conflicted = (): FileChange => repos.status()!.files.find((f) => f.status === 'conflicted')!;
const errors = (): string[] => w.toasts.filter((t) => t.kind === 'error').map((t) => t.title);

/** The status the native side reports from now on, made from the one on screen. */
async function status(change: (st: RepoStatus) => RepoStatus): Promise<void> {
	const now = change(repos.status()!);
	w.on('repo_status', () => now);
	await repos.refresh();
	await tick();
}

/** A task with a worktree of its own whose first turn has ended. */
async function agentInWorktree(): Promise<AgentSession> {
	expect(await agents.start({ task: 'Make the queue wrap', branch: 'agent/queue-wrap', mode: 'acceptEdits' })).toBe(true);
	const id = agents.selectedId()!;
	w.emit('agent-done', { key: id, ok: true, error: '' });
	await tick();
	return agents.get(id)!;
}

/** A finished review of a push with these findings, as the store holds them. */
async function reviewed(findings: Record<string, unknown>[] = [BUG, RISK]): Promise<Finding[]> {
	void ai.review({ scope: 'push' });
	await tick();
	await answer(review(findings));
	expect(ai.reviewed()?.state).toBe('done');
	return ai.reviewed()!.findings;
}

/** The app from its start. `before` sets the native side up first; `init` false leaves the features to start themselves. */
async function boot(before: () => void = () => undefined, init = true): Promise<void> {
	w = await world();
	// Claude says only what a test makes it say.
	w.on('agent_start', () => undefined);
	w.on('agent_stop', () => undefined);
	w.on('ai_review_diff', (a) => ({ ...RANGE, scope: a.scope }));
	before();
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	agents = w.get((await import('./agents.store')).AgentsStore);
	await agents.init();
	agents.setChecks(false); // the language servers' check of an agent's change is another store's business
	ai = w.get((await import('./ai-features.store')).AiFeaturesStore);
	if (init) {
		ai.init();
	}
	await tick();
	repos.setTab('changes');
	await tick();
}

beforeEach(async () => {
	vi.useFakeTimers();
	await boot();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('Claude Code on this computer', () => {
	test('is looked for when the features start', () => {
		expect(ai.cli()).toBeTruthy();
		expect(ai.unavailable()).toBe('');
	});

	test('missing: every feature says so and asks nothing', async () => {
		await boot(() => w.on('agent_available', () => null));
		expect(ai.cli()).toBeNull();
		expect(ai.unavailable()).toMatch(/was not found/);
		expect(ai.fixButton([BUG as Finding]).disabled).toBe(true);
		await ai.writeCommitMessage();
		await ai.explain({ kind: 'file', file: changed('src/player/queue.ts') });
		await ai.review({ scope: 'push' });
		await ai.proposeResolution(conflicted());
		await tick();
		expect(asks()).toEqual([]);
		expect(w.sent('ai_selected_diff')).toEqual([]);
		expect(w.sent('ai_review_diff')).toEqual([]);
		expect(w.sent('ai_conflict_file')).toEqual([]);
		expect(errors()).toEqual(Array(4).fill('Claude Code was not found'));
		expect(ai.writing()).toBe(false);
		expect(ai.explanation()).toBeNull();
		expect(ai.reviewed()).toBeNull();
		expect(ai.proposal()).toBeNull();
	});

	test('installed since: it is found when the window gets the focus back', async () => {
		await boot(() => w.on('agent_available', () => null));
		expect(ai.cli()).toBeNull();
		w.on('agent_available', () => '2.1.330');
		window.dispatchEvent(new Event('focus'));
		await tick();
		expect(ai.cli()).toBe('2.1.330');
		expect(ai.unavailable()).toBe('');
	});

	test('a feature used before the others were set up still works, and its result stays', async () => {
		await boot(undefined, false);
		const run = ai.review({ scope: 'push' });
		await tick(8);
		expect(ai.reviewed()?.state).toBe('running');
		await answer(review([BUG]));
		await run;
		await tick(8);
		expect(ai.reviewed()).toMatchObject({ state: 'done' });
		expect(ai.reviewed()!.findings.length).toBe(1);
	});
});

describe('commit message', () => {
	test('an empty form is filled from the diff of the checked files, and only those', async () => {
		const all = repos.includedFiles().map((f) => f.path);
		repos.toggleFile(all[0], false);
		const run = ai.writeCommitMessage();
		await tick();
		expect(ai.writing()).toBe(true);
		expect(w.sent('ai_selected_diff').length).toBe(1);
		expect((w.sent('ai_selected_diff')[0].args.files as { path: string }[]).map((f) => f.path)).toEqual(all.slice(1));
		expect(asks().length).toBe(1);
		expect(prompt(asks()[0])).toMatch(/^\[commit-message\]/);
		expect(options(asks()[0])).toEqual({ tools: [], model: 'haiku', quick: true });
		await answer(message('Wrap the queue on repeat', '- next() starts over'));
		await run;
		expect(repos.summary()).toBe('Wrap the queue on repeat');
		expect(repos.description()).toBe('- next() starts over');
		expect(ai.suggestion()).toBeNull();
		expect(ai.writing()).toBe(false);
		// Writing a message commits nothing.
		expect(w.sent('commit_changes')).toEqual([]);
	});

	test('a summary typed before is never replaced: the answer is offered instead', async () => {
		repos.summary.set('My own words');
		const run = ai.writeCommitMessage();
		await tick();
		expect(prompt(asks()[0])).toContain('"My own words"');
		await answer(message('Wrap the queue on repeat', 'Body.'));
		await run;
		expect(repos.summary()).toBe('My own words');
		expect(repos.description()).toBe('');
		expect(ai.suggestion()).toEqual({ summary: 'Wrap the queue on repeat', description: 'Body.' });
	});

	test('what was typed while Claude wrote is kept too', async () => {
		const run = ai.writeCommitMessage();
		await tick();
		repos.summary.set('Typed meanwhile');
		await answer(message('Wrap the queue on repeat'));
		await run;
		expect(repos.summary()).toBe('Typed meanwhile');
		expect(ai.suggestion()?.summary).toBe('Wrap the queue on repeat');
	});

	test('a description alone counts as typed', async () => {
		repos.description.set('Notes to self');
		const run = ai.writeCommitMessage();
		await tick();
		await answer(message('Wrap the queue on repeat', 'Body.'));
		await run;
		expect(repos.summary()).toBe('');
		expect(repos.description()).toBe('Notes to self');
		expect(ai.suggestion()?.summary).toBe('Wrap the queue on repeat');
	});

	test('taking the suggestion puts it in the form, and it is gone', async () => {
		repos.summary.set('My own words');
		const run = ai.writeCommitMessage();
		await tick();
		await answer(message('Wrap the queue on repeat', 'Body.'));
		await run;
		ai.takeSuggestion();
		expect(repos.summary()).toBe('Wrap the queue on repeat');
		expect(repos.description()).toBe('Body.');
		expect(ai.suggestion()).toBeNull();
	});

	test('an answer that says what is already in the form offers nothing', async () => {
		repos.summary.set('Wrap the queue on repeat');
		const run = ai.writeCommitMessage();
		await tick();
		await answer(message('Wrap the queue on repeat'));
		await run;
		expect(ai.suggestion()).toBeNull();
		expect(repos.summary()).toBe('Wrap the queue on repeat');
	});

	test('asking again drops the suggestion that was waiting', async () => {
		repos.summary.set('My own words');
		const first = ai.writeCommitMessage();
		await tick();
		await answer(message('First idea'));
		await first;
		expect(ai.suggestion()).not.toBeNull();
		void ai.writeCommitMessage();
		await tick();
		expect(ai.suggestion()).toBeNull();
		expect(ai.writing()).toBe(true);
	});

	test('pressing it again while it runs stops it, and nothing is written', async () => {
		const run = ai.writeCommitMessage();
		await tick();
		const ask = asks()[0];
		await ai.writeCommitMessage();
		await run;
		await tick();
		expect(ai.writing()).toBe(false);
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([keyOf(ask)]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'info', title: 'Stopped' });
		await answer(message('Too late'), ask);
		expect(repos.summary()).toBe('');
		expect(ai.suggestion()).toBeNull();
		expect(errors()).toEqual([]);
		expect(asks().length).toBe(1);
	});

	test('with nothing checked there is nothing to describe', async () => {
		repos.toggleAll(false);
		await ai.writeCommitMessage();
		await tick();
		expect(w.sent('ai_selected_diff')).toEqual([]);
		expect(asks()).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'info', title: 'Nothing to describe' });
		expect(ai.writing()).toBe(false);
	});

	test('an answer that is no commit message is said, and the form is left alone', async () => {
		const run = ai.writeCommitMessage();
		await tick();
		await answer('{"note": "I would rather not"}');
		await run;
		expect(repos.summary()).toBe('');
		expect(ai.suggestion()).toBeNull();
		expect(ai.writing()).toBe(false);
		expect(errors()).toEqual(['Could not write a commit message']);
	});

	test('a diff that cannot be read is said, and Claude is not asked', async () => {
		w.on('ai_selected_diff', () => { throw appError('git', 'fatal: bad object'); });
		await ai.writeCommitMessage();
		await tick();
		expect(asks()).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'Could not write a commit message', message: 'fatal: bad object' });
		expect(ai.writing()).toBe(false);
	});

	test('Claude Code failing is said, and it can be asked again', async () => {
		const run = ai.writeCommitMessage();
		await tick();
		await fails('overloaded');
		await run;
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'Could not write a commit message', message: 'overloaded' });
		expect(ai.writing()).toBe(false);
		const again = ai.writeCommitMessage();
		await tick();
		await answer(message('Second time lucky'));
		await again;
		expect(repos.summary()).toBe('Second time lucky');
	});
});

describe('explain', () => {
	test('a changed file: its own diff goes to Claude, and the text shows as it is written', async () => {
		const file = changed('src/player/queue.ts');
		w.on('ai_selected_diff', () => ({ text: FILE_DIFF, truncated: false, recent: [] }));
		const run = ai.explain({ kind: 'file', file });
		await tick();
		expect((w.sent('ai_selected_diff')[0].args.files as { path: string }[]).map((f) => f.path)).toEqual(['src/player/queue.ts']);
		expect(prompt(asks()[0])).toMatch(/^\[explain-diff\]/);
		expect(prompt(asks()[0])).toContain('+new');
		expect(options(asks()[0])).toEqual({ tools: [], model: 'haiku', quick: true });
		expect(ai.explanation()).toMatchObject({ state: 'running', title: 'queue.ts', detail: 'src/player/queue.ts', text: '' });
		expect(ai.panelTab()).toBe('explain');
		says('## What changed');
		expect(ai.explanation()).toMatchObject({ state: 'running', text: '## What changed' });
		await answer('## What changed\n- next() wraps.\n\n');
		await run;
		expect(ai.explanation()).toMatchObject({ state: 'done', text: '## What changed\n- next() wraps.', error: '' });
	});

	test('a commit: its patch goes to Claude', async () => {
		await repos.loadHistory(true);
		const commit = repos.commits()[0];
		const run = ai.explain({ kind: 'commit', commit });
		await tick();
		expect(w.sent('ai_commit_patch').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, hash: commit.hash }]);
		expect(w.sent('ai_selected_diff')).toEqual([]);
		expect(prompt(asks()[0])).toMatch(/^\[explain-commit\]/);
		expect(ai.explanation()).toMatchObject({ title: `Commit ${commit.shortHash}`, detail: commit.summary, state: 'running' });
		await answer('It makes the queue wrap.');
		await run;
		expect(ai.explanation()?.state).toBe('done');
	});

	test('a file with no text changes is not sent to Claude', async () => {
		w.on('ai_selected_diff', () => ({ text: 'Binary files a/public/cover.png and b/public/cover.png differ\n', truncated: false, recent: [] }));
		await ai.explain({ kind: 'file', file: changed('public/cover.png') });
		await tick();
		expect(asks()).toEqual([]);
		expect(ai.explanation()).toMatchObject({ state: 'error', error: 'This file has no text changes to explain.' });
		expect(errors()).toEqual(['Could not explain this change']);
	});

	test('stopping keeps what was written so far', async () => {
		const run = ai.explain({ kind: 'file', file: changed('src/player/queue.ts') });
		await tick();
		const ask = asks()[0];
		says('The first half');
		ai.stopExplain();
		await run;
		await tick();
		expect(ai.explanation()).toMatchObject({ state: 'stopped', text: 'The first half' });
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([keyOf(ask)]);
		await answer('The first half and the second.', ask);
		expect(ai.explanation()).toMatchObject({ state: 'stopped', text: 'The first half' });
		expect(errors()).toEqual([]);
	});

	test('explaining something else replaces the one running, whose answer never shows', async () => {
		const first = ai.explain({ kind: 'file', file: changed('src/player/queue.ts') });
		await tick();
		const old = asks()[0];
		const second = ai.explain({ kind: 'file', file: changed('src/player/repeat.ts') });
		await tick();
		expect(asks().length).toBe(2);
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([keyOf(old)]);
		expect(ai.explanation()).toMatchObject({ title: 'repeat.ts', state: 'running' });
		await answer('About the queue.', old);
		expect(ai.explanation()).toMatchObject({ title: 'repeat.ts', state: 'running', text: '' });
		await answer('About repeat.');
		await Promise.all([first, second]);
		expect(ai.explanation()).toMatchObject({ title: 'repeat.ts', state: 'done', text: 'About repeat.' });
		expect(errors()).toEqual([]);
	});

	test('Claude Code failing leaves what it had written, marked as an error', async () => {
		const run = ai.explain({ kind: 'file', file: changed('src/player/queue.ts') });
		await tick();
		says('So far');
		w.emit('agent-event', { key: keyOf(asks()[0]), event: { type: 'result', is_error: true, result: 'Credit balance is too low' } });
		await fails('');
		await run;
		expect(ai.explanation()).toMatchObject({ state: 'error', text: 'So far', error: 'Credit balance is too low' });
		expect(errors()).toEqual(['Could not explain this change']);
	});

	test('closing it stops Claude and clears the panel', async () => {
		void ai.explain({ kind: 'file', file: changed('src/player/queue.ts') });
		await tick();
		expect(ai.panelOpen()).toBe(true);
		ai.closeExplain();
		await tick();
		expect(ai.explanation()).toBeNull();
		expect(ai.panelOpen()).toBe(false);
		expect(w.sent('agent_stop').length).toBe(1);
	});

	test('the side panel belongs to Changes and History only', async () => {
		const run = ai.explain({ kind: 'file', file: changed('src/player/queue.ts') });
		await tick();
		await answer('Explained.');
		await run;
		expect(ai.panelOpen()).toBe(true);
		repos.setTab('files');
		expect(ai.panelOpen()).toBe(false);
		repos.setTab('history');
		expect(ai.panelOpen()).toBe(true);
	});
});

describe('what a review can cover', () => {
	test('uncommitted work, what a push would send, and the whole branch, from the status on screen', async () => {
		await status((st) => ({ ...st, files: st.files.slice(0, 2), ahead: 3, branch: 'feature/x', upstream: 'origin/feature/x', defaultBranch: 'main' }));
		expect(ai.offers().map((o) => o.request)).toEqual([{ scope: 'work' }, { scope: 'push' }, { scope: 'branch' }]);
		expect(ai.offers().map((o) => o.chip)).toEqual(['2 uncommitted', '3 to push', 'vs main']);
	});

	test('after a push the branch is still on offer', async () => {
		await status((st) => ({ ...st, files: [], ahead: 0, undo: null, branch: 'feature/x', upstream: 'origin/feature/x', defaultBranch: 'main' }));
		expect(ai.offers().map((o) => o.request)).toEqual([{ scope: 'branch' }]);
	});

	test('a branch that was never pushed: History tells how many commits a push would send', async () => {
		await status((st) => ({ ...st, files: [], ahead: 0, undo: null, upstream: null }));
		expect(ai.offers().some((o) => o.request.scope === 'push')).toBe(false);
		await repos.loadHistory(true);
		await tick();
		const unpushed = repos.commits().filter((c) => c.unpushed).length;
		expect(unpushed).toBeGreaterThan(0);
		expect(ai.offers().find((o) => o.request.scope === 'push')?.chip).toBe(`${unpushed} to push`);
	});

	test('in an agent\'s worktree the offer is the agent\'s work, since the commit it started from', async () => {
		const session = await agentInWorktree();
		await agents.view(session.cwd);
		await tick();
		expect(ai.fixSession()?.id).toBe(session.id);
		expect(ai.offers()[0].request).toEqual({ scope: 'work', base: session.base, agent: true });
		expect(ai.offers().some((o) => o.request.scope === 'branch')).toBe(false);
		expect(ai.offers().some((o) => o.request.scope === 'work' && !o.request.agent)).toBe(false);
	});

	test('nothing changed and nothing to push: nothing is on offer, and a review says so', async () => {
		await status((st) => ({ ...st, files: [], ahead: 0, undo: null, branch: 'main', upstream: 'origin/main', defaultBranch: 'main' }));
		expect(ai.offers()).toEqual([]);
		await ai.review();
		await tick();
		expect(w.sent('ai_review_diff')).toEqual([]);
		expect(asks()).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'info', title: 'Nothing to review' });
		expect(ai.reviewed()).toBeNull();
	});
});

describe('review', () => {
	test('before a push: the commits a push would send go to Claude, read-only, on Sonnet', async () => {
		const run = ai.review({ scope: 'push' });
		await tick();
		expect(w.sent('ai_review_diff').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, scope: 'push', base: null }]);
		expect(asks().length).toBe(1);
		expect(options(asks()[0])).toEqual({ tools: ['Read', 'Grep', 'Glob'], model: 'sonnet', quick: true });
		expect(asks()[0].args.mode).toBe('default');
		expect(prompt(asks()[0])).toContain('+new');
		const rv = ai.reviewed()!;
		expect(rv.state).toBe('running');
		expect(rv.request).toEqual({ scope: 'push' });
		expect(rv.range).toMatchObject({ base: RANGE.base, head: RANGE.head, against: 'origin/main' });
		expect(rv.range).not.toHaveProperty('text');
		expect(ai.panelTab()).toBe('review');
		await answer(review([NIT, RISK, BUG], 'One real problem.'));
		await run;
		expect(ai.reviewed()).toMatchObject({ state: 'done', summary: 'One real problem.', error: '' });
		expect(ai.reviewed()!.findings.map((f) => f.severity)).toEqual(['bug', 'risk', 'nit']);
		expect(ai.reviewed()!.findings[0]).toEqual(BUG);
	});

	test('a branch: compared with the branch named', async () => {
		void ai.review({ scope: 'branch', base: 'release/1.4' });
		await tick();
		expect(w.sent('ai_review_diff')[0].args).toEqual({ id: repos.repo()!.id, scope: 'branch', base: 'release/1.4' });
		expect(ai.reviewed()?.request).toEqual({ scope: 'branch', base: 'release/1.4' });
	});

	test('the work in a checkout: everything since the commit named', async () => {
		void ai.review({ scope: 'work', base: 'b'.repeat(40), agent: true });
		await tick();
		expect(w.sent('ai_review_diff')[0].args).toEqual({ id: repos.repo()!.id, scope: 'work', base: 'b'.repeat(40) });
	});

	test('with nothing named it reviews the first thing on offer', async () => {
		await status((st) => ({ ...st, files: [], ahead: 2, upstream: 'origin/feature/x', branch: 'feature/x' }));
		expect(ai.offers()[0].request).toEqual({ scope: 'push' });
		void ai.review();
		await tick();
		expect(w.sent('ai_review_diff')[0].args.scope).toBe('push');
	});

	test('a review changes nothing and posts nothing: it only reads and asks Claude', async () => {
		const before = w.calls.length;
		await reviewed();
		const sent = w.calls.slice(before).map((c) => c.cmd);
		expect(sent).toContain('ai_review_diff');
		expect(sent.filter((cmd) => /^(pr_|issue_|jira_|ci_|host_|commit_|push|files_|write_file|discard_|stash_|branch_|merge_|worktree_add|worktree_remove)/.test(cmd))).toEqual([]);
		// Its one question is the only thing Claude was started for.
		expect(w.calls.slice(before).filter((c) => c.cmd === 'agent_start').length).toBe(1);
	});

	test('a diff with nothing in it is not sent to Claude', async () => {
		w.on('ai_review_diff', () => ({ ...RANGE, text: '', files: [], commits: [] }));
		await ai.review({ scope: 'push' });
		await tick();
		expect(asks()).toEqual([]);
		expect(ai.reviewed()).toBeNull();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'info', title: 'Nothing to review' });
		expect(w.toasts.at(-1)!.message).toContain('origin/main');
	});

	test('what Claude says it is looking up is shown as progress; its JSON answer is not', async () => {
		void ai.review({ scope: 'push' });
		await tick();
		says('Checking how next() is called.');
		expect(ai.reviewed()?.progress).toBe('Checking how next() is called.');
		says('{"summary": "Fine", "findings": []}');
		expect(ai.reviewed()?.progress).toBe('Checking how next() is called.');
		expect(ai.reviewed()?.state).toBe('running');
	});

	test('one review at a time: the same one asked again is left running', async () => {
		void ai.review({ scope: 'push' });
		await tick();
		const toasts = w.toasts.length;
		ai.panelTab.set('explain');
		await ai.review({ scope: 'push' });
		await tick();
		expect(w.sent('ai_review_diff').length).toBe(1);
		expect(asks().length).toBe(1);
		expect(w.toasts.length).toBe(toasts);
		expect(ai.panelTab()).toBe('review');
		expect(ai.reviewing({ scope: 'push' })).toBe(true);
	});

	test('one review at a time: another one is refused while it runs, and said', async () => {
		void ai.review({ scope: 'push' });
		await tick();
		await ai.review({ scope: 'branch' });
		await tick();
		expect(w.sent('ai_review_diff').length).toBe(1);
		expect(asks().length).toBe(1);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'info', title: 'A review is already running' });
		expect(ai.reviewed()?.request).toEqual({ scope: 'push' });
		expect(ai.reviewing({ scope: 'branch' })).toBe(false);
	});

	test('once it has finished, another can start', async () => {
		await reviewed([BUG]);
		expect(ai.reviewing({ scope: 'push' })).toBe(false);
		void ai.review({ scope: 'branch' });
		await tick();
		expect(asks().length).toBe(2);
		expect(ai.reviewed()).toMatchObject({ state: 'running', request: { scope: 'branch' }, findings: [] });
	});

	test('an answer that is no list of findings is kept as it came, and said', async () => {
		const run = ai.review({ scope: 'push' });
		await tick();
		await answer('It all looks good to me!\n');
		await run;
		expect(ai.reviewed()).toMatchObject({ state: 'error', raw: 'It all looks good to me!', findings: [] });
		expect(ai.reviewed()!.error).not.toBe('');
		expect(errors()).toEqual(['The review could not be read']);
	});

	test('Claude Code failing is said', async () => {
		const run = ai.review({ scope: 'push' });
		await tick();
		await fails('rate limited');
		await run;
		expect(ai.reviewed()).toMatchObject({ state: 'error', error: 'rate limited' });
		expect(ai.reviewed()!.range).not.toBeNull();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'The review did not finish', message: 'rate limited' });
	});

	test('a diff that cannot be read is said, and Claude is not asked', async () => {
		w.on('ai_review_diff', () => { throw appError('git', 'no merge base'); });
		await ai.review({ scope: 'branch' });
		await tick();
		expect(asks()).toEqual([]);
		expect(ai.reviewed()).toMatchObject({ state: 'error', error: 'no merge base' });
	});

	test('stopping it stops Claude, and an answer on its way is dropped', async () => {
		const run = ai.review({ scope: 'push' });
		await tick();
		const ask = asks()[0];
		ai.stopReview();
		await run;
		await tick();
		expect(ai.reviewed()?.state).toBe('stopped');
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([keyOf(ask)]);
		await answer(review([BUG]), ask);
		expect(ai.reviewed()).toMatchObject({ state: 'stopped', findings: [] });
		expect(errors()).toEqual([]);
	});

	test('stopped while the diff is still being read: Claude is never asked', async () => {
		let hand: (diff: unknown) => void = () => undefined;
		w.on('ai_review_diff', () => new Promise((resolve) => (hand = resolve)));
		const run = ai.review({ scope: 'push' });
		await tick();
		expect(ai.reviewed()?.state).toBe('collecting');
		ai.stopReview();
		hand(RANGE);
		await run;
		await tick();
		expect(asks()).toEqual([]);
		expect(ai.reviewed()).toMatchObject({ state: 'stopped', range: null });
	});

	test('closing it clears the findings and what was open from them', async () => {
		const [bug] = await reviewed();
		await ai.openFinding(bug);
		ai.closeReview();
		expect(ai.reviewed()).toBeNull();
		expect(ai.reviewView()).toBeNull();
		expect(ai.reviewNotes()).toEqual([]);
		expect(ai.panelOpen()).toBe(false);
	});

	test('closing the explanation leaves the review, and shows it', async () => {
		await reviewed();
		const run = ai.explain({ kind: 'file', file: changed('src/player/queue.ts') });
		await tick();
		await answer('Explained.');
		await run;
		expect(ai.panelTab()).toBe('explain');
		ai.closeExplain();
		expect(ai.panelTab()).toBe('review');
		expect(ai.reviewed()?.state).toBe('done');
		expect(ai.panelOpen()).toBe(true);
	});
});

describe('each feature is a run of its own', () => {
	test('stopping the review leaves an explanation and a commit message running', async () => {
		const writing = ai.writeCommitMessage();
		await tick();
		const explaining = ai.explain({ kind: 'file', file: changed('src/player/queue.ts') });
		await tick();
		const reviewing = ai.review({ scope: 'push' });
		await tick();
		const [commitAsk, explainAsk, reviewAsk] = asks();
		ai.stopReview();
		await reviewing;
		await tick();
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([keyOf(reviewAsk)]);
		expect(ai.writing()).toBe(true);
		expect(ai.explanation()?.state).toBe('running');
		await answer('Explained.', explainAsk);
		await answer(message('Wrap the queue'), commitAsk);
		await Promise.all([writing, explaining]);
		expect(ai.explanation()).toMatchObject({ state: 'done', text: 'Explained.' });
		expect(repos.summary()).toBe('Wrap the queue');
		expect(ai.reviewed()?.state).toBe('stopped');
	});
});

describe('a finding in its place', () => {
	test('opens the file\'s diff over what was reviewed, with its findings as notes', async () => {
		const [bug] = await reviewed([BUG, NIT, RISK]);
		w.on('ai_range_file_diff', () => ({ text: FILE_DIFF, tooLarge: false }));
		await ai.openFinding(bug);
		expect(w.sent('ai_range_file_diff').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, base: RANGE.base, head: RANGE.head, path: 'src/a.ts' }]);
		expect(ai.reviewView()).toMatchObject({ path: 'src/a.ts', line: 1 });
		expect(ai.reviewView()!.diff).toMatchObject({ added: 1, removed: 1 });
		// The notes are the findings of that file only.
		expect(ai.reviewNotes().map((n) => [n.line, n.tone, n.title])).toEqual([
			[1, 'bug', 'Off by one'],
			[9, 'nit', 'Name could be clearer'],
		]);
	});

	test('a file opened before is not read again', async () => {
		const findings = await reviewed([BUG, NIT]);
		w.on('ai_range_file_diff', () => ({ text: FILE_DIFF, tooLarge: false }));
		await ai.openFinding(findings[0]);
		ai.closeReviewView();
		expect(ai.reviewView()).toBeNull();
		await ai.openFinding(findings[1]);
		expect(w.sent('ai_range_file_diff').length).toBe(1);
		expect(ai.reviewView()).toMatchObject({ path: 'src/a.ts', line: 9 });
		expect(ai.reviewView()!.diff).not.toBeNull();
	});

	test('a diff that cannot be read shows as an empty one, not as loading for ever', async () => {
		const [bug] = await reviewed();
		w.on('ai_range_file_diff', () => { throw appError('git', 'bad revision'); });
		await ai.openFinding(bug);
		expect(ai.reviewView()!.diff).toMatchObject({ lines: [] });
	});

	test('picking something else to look at takes the main pane back', async () => {
		const [bug] = await reviewed();
		await ai.openFinding(bug);
		await tick();
		expect(ai.reviewView()).not.toBeNull();
		repos.selectFile('src/player/repeat.ts');
		await tick();
		expect(ai.reviewView()).toBeNull();
		expect(ai.reviewed()?.state).toBe('done');
	});

	test('a new review forgets the diffs of the old one', async () => {
		const [bug] = await reviewed([BUG]);
		w.on('ai_range_file_diff', () => ({ text: FILE_DIFF, tooLarge: false }));
		await ai.openFinding(bug);
		const [again] = await reviewed([BUG]);
		expect(ai.reviewView()).toBeNull();
		await ai.openFinding(again);
		expect(w.sent('ai_range_file_diff').length).toBe(2);
	});
});

describe('asking Claude to fix a finding', () => {
	test('in the user\'s own checkout it starts an agent there, on a click, and marks the finding as sent', async () => {
		const [bug, risk] = await reviewed();
		expect(ai.fixButton([bug])).toMatchObject({ label: 'Ask Claude to fix', disabled: false });
		expect(ai.fixButton([bug, risk]).label).toBe('Ask Claude to fix all 2');
		expect(turns()).toEqual([]);
		await ai.fixFindings([bug]);
		await tick();
		expect(turns().length).toBe(1);
		expect(turns()[0].args.cwd).toBe(repos.repo()!.path);
		expect(prompt(turns()[0])).toContain('Off by one');
		expect(prompt(turns()[0])).not.toContain('No check for empty');
		expect(w.sent('worktree_add')).toEqual([]);
		expect(repos.tab()).toBe('agents');
		expect(ai.fixButton([bug])).toMatchObject({ label: 'Sent to Claude', disabled: true });
		expect(ai.fixButton([risk]).disabled).toBe(false);
		expect(ai.fixButton([bug, risk]).disabled).toBe(false);
	});

	test('a finding is never sent twice', async () => {
		const [bug, risk] = await reviewed();
		await ai.fixFindings([bug]);
		await tick();
		await ai.fixFindings([bug]);
		await tick();
		expect(turns().length).toBe(1);
		// Asking for all of them sends only the one that has not gone yet. The first agent is still at work.
		w.emit('agent-done', { key: turns()[0].args.key, ok: true, error: '' });
		await tick();
		await ai.fixFindings([bug, risk]);
		await tick();
		expect(turns().length).toBe(2);
		expect(prompt(turns()[1])).toContain('No check for empty');
		expect(prompt(turns()[1])).not.toContain('Off by one');
	});

	test('in an agent\'s worktree the findings go to that agent as its next turn', async () => {
		const session = await agentInWorktree();
		await agents.view(session.cwd);
		await tick();
		const [bug] = await reviewed();
		const before = agents.sessions().length;
		const started = turns().length;
		await ai.fixFindings([bug]);
		await tick();
		expect(agents.sessions().length).toBe(before);
		expect(turns().length).toBe(started + 1);
		expect(turns().at(-1)!.args.key).toBe(session.id);
		expect(turns().at(-1)!.args.cwd).toBe(session.cwd);
		expect(prompt(turns().at(-1))).toContain('Off by one');
		expect(agents.get(session.id)!.status).toBe('running');
		expect(ai.fixSent().has(bug)).toBe(true);
	});

	test('while that agent is working nothing is sent, and the button says why', async () => {
		const session = await agentInWorktree();
		await agents.view(session.cwd);
		await tick();
		const [bug] = await reviewed();
		await agents.send(session.id, 'Carry on with the rest');
		await tick();
		const started = turns().length;
		expect(ai.fixButton([bug])).toMatchObject({ label: 'Ask Claude to fix', disabled: true });
		await ai.fixFindings([bug]);
		await tick();
		expect(turns().length).toBe(started);
		expect(ai.fixSent().has(bug)).toBe(false);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'info', title: 'The agent is still working' });
	});
});

describe('the checkout on screen changes', () => {
	test('everything that belonged to the other checkout is dropped, and what was running is stopped', async () => {
		const session = await agentInWorktree();
		repos.setTab('changes');
		repos.summary.set('Mine');
		const writing = ai.writeCommitMessage();
		await tick();
		await answer(message('A suggestion'));
		await writing;
		expect(ai.suggestion()).not.toBeNull();
		const explaining = ai.explain({ kind: 'file', file: changed('src/player/queue.ts') });
		await tick();
		await answer('Explained.');
		await explaining;
		void ai.review({ scope: 'push' });
		await tick();
		const reviewAsk = asks().at(-1);
		expect(ai.reviewed()?.state).toBe('running');

		await agents.view(session.cwd);
		await tick();
		expect(ai.suggestion()).toBeNull();
		expect(ai.explanation()).toBeNull();
		expect(ai.reviewed()).toBeNull();
		expect(w.sent('agent_stop').map((c) => c.args.key)).toContain(keyOf(reviewAsk));
		// Its answer, had it been on its way, lands nowhere.
		await answer(review([BUG]), reviewAsk);
		expect(ai.reviewed()).toBeNull();
		expect(errors()).toEqual([]);
	});

	test('a commit message being written for the other checkout never reaches this one\'s form', async () => {
		const session = await agentInWorktree();
		repos.setTab('changes');
		const writing = ai.writeCommitMessage();
		await tick();
		const ask = asks()[0];
		await agents.view(session.cwd);
		await tick();
		await answer(message('For the other checkout'), ask);
		await writing;
		expect(ai.writing()).toBe(false);
		expect(repos.summary()).toBe('');
		expect(ai.suggestion()).toBeNull();
	});

	test('another repository drops them too', async () => {
		await reviewed();
		const other = repos.app()!.repos.find((r) => r.id !== repos.repo()!.id)!;
		await repos.selectRepo(other.id);
		await tick();
		expect(repos.repo()?.id).toBe(other.id);
		expect(ai.reviewed()).toBeNull();
		expect(ai.fixSent().size).toBe(0);
	});

	test('a review started right after going to an agent\'s worktree is not taken for the old checkout\'s', async () => {
		const session = await agentInWorktree();
		repos.setTab('changes');
		await reviewed([BUG]);
		const before = asks().length;
		const run = ai.reviewSession(session);
		await tick(8);
		expect(repos.repo()?.worktree).toBe(session.cwd);
		expect(w.sent('ai_review_diff').at(-1)!.args).toEqual({ id: session.repoId, scope: 'work', base: session.base });
		expect(asks().length).toBe(before + 1);
		// The old checkout's findings are gone; the new review stands, and is still running.
		expect(ai.reviewed()).toMatchObject({ state: 'running', request: { scope: 'work', base: session.base, agent: true }, findings: [] });
		expect(w.sent('agent_stop')).toEqual([]);
		await answer(review([RISK]));
		await run;
		expect(ai.reviewed()).toMatchObject({ state: 'done' });
		expect(ai.reviewed()!.findings.map((f) => f.title)).toEqual(['No check for empty']);
	});

	test('a session in the user\'s own checkout is reviewed as uncommitted work', async () => {
		expect(await agents.start({ task: 'Tidy the queue', branch: '', mode: 'acceptEdits' })).toBe(true);
		const id = agents.selectedId()!;
		w.emit('agent-done', { key: id, ok: true, error: '' });
		await tick();
		void ai.reviewSession(agents.get(id)!);
		await tick(8);
		expect(repos.repo()?.worktree ?? null).toBeNull();
		expect(w.sent('ai_review_diff').at(-1)!.args).toEqual({ id: repos.repo()!.id, scope: 'work', base: null });
		expect(ai.reviewed()?.request).toEqual({ scope: 'work' });
	});
});

describe('a proposed conflict resolution', () => {
	const preview = (): void => w.on('ai_resolution_preview', () => ({ text: FILE_DIFF, tooLarge: false }));
	const conflictText = (text: string, extra: Record<string, unknown> = {}): void => w.on('ai_conflict_file', () => ({ text, binary: false, tooLarge: false, ...extra }));

	/** A proposal for the conflicted file, ready to accept. */
	async function proposed(): Promise<FileChange> {
		const file = conflicted();
		conflictText(CONFLICT);
		preview();
		const run = ai.proposeResolution(file);
		await tick();
		await answer(RESOLVED);
		await run;
		expect(ai.proposal()?.state).toBe('ready');
		return file;
	}

	test('Claude answers for the conflict block only, and nothing is written until it is accepted', async () => {
		const file = conflicted();
		conflictText(CONFLICT);
		preview();
		const run = ai.proposeResolution(file);
		await tick();
		expect(w.sent('ai_conflict_file').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, path: file.path }]);
		expect(ai.proposal()).toMatchObject({ path: file.path, state: 'running', conflicts: 1, original: CONFLICT, diff: null });
		expect(prompt(asks()[0])).toMatch(/^\[resolve-conflict\]/);
		expect(options(asks()[0])).toEqual({ tools: [], model: 'sonnet', quick: true });
		await answer(RESOLVED);
		await run;
		// The lines outside the block are the file's own, untouched.
		const text = 'first line\nboth of them\nlast line\n';
		expect(w.sent('ai_resolution_preview').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, path: file.path, text }]);
		expect(ai.proposal()).toMatchObject({ state: 'ready', text, summary: 'Kept both sides.', original: CONFLICT, root: repos.repo()!.path });
		expect(ai.proposal()!.diff).not.toBeNull();
		expect(ai.proposalFor(file.path)).toBe(ai.proposal());
		expect(ai.proposalFor('some/other.ts')).toBeNull();
		for (const cmd of ['ai_resolution_apply', 'write_file', 'resolve_file', 'commit_changes']) {
			expect(w.sent(cmd)).toEqual([]);
		}
	});

	test('accepting hands the native side the proposal, the text it was made from and the checkout it was read in', async () => {
		const file = await proposed();
		const reads = w.sent('repo_status').length;
		await ai.acceptProposal();
		await tick();
		expect(w.sent('ai_resolution_apply').map((c) => c.args)).toEqual([{ id: repos.repo()!.id, path: file.path, text: 'first line\nboth of them\nlast line\n', original: CONFLICT, root: repos.repo()!.path }]);
		expect(ai.proposal()).toBeNull();
		expect(w.toasts.some((t) => t.kind === 'success' && t.title === 'Conflict resolved')).toBe(true);
		expect(w.sent('repo_status').length).toBeGreaterThan(reads);
		// Marked as resolved, not committed: that stays the user's.
		expect(w.sent('commit_changes')).toEqual([]);
	});

	test('in a worktree, that checkout is the one named', async () => {
		const session = await agentInWorktree();
		await agents.view(session.cwd);
		await tick();
		await proposed();
		expect(ai.proposal()!.root).toBe(session.cwd);
	});

	test('a refusal from the native side is said, the proposal is dropped and the status read again', async () => {
		await proposed();
		w.on('ai_resolution_apply', () => { throw appError('error', 'The file changed since the proposal was made.'); });
		const reads = w.sent('repo_status').length;
		await ai.acceptProposal();
		await tick();
		expect(ai.proposal()).toBeNull();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'The proposal was not applied', message: 'The file changed since the proposal was made.' });
		expect(w.sent('repo_status').length).toBeGreaterThan(reads);
	});

	test('a proposal that is not ready yet cannot be accepted', async () => {
		conflictText(CONFLICT);
		void ai.proposeResolution(conflicted());
		await tick();
		expect(ai.proposal()?.state).toBe('running');
		await ai.acceptProposal();
		await tick();
		expect(w.sent('ai_resolution_apply')).toEqual([]);
		expect(ai.proposal()?.state).toBe('running');
	});

	test('with no proposal there is nothing to accept', async () => {
		await ai.acceptProposal();
		expect(w.sent('ai_resolution_apply')).toEqual([]);
	});

	test.each([
		['a binary file', '', { binary: true }, /binary file/],
		['a file too large to send', '', { tooLarge: true }, /too large/],
		['a file with no conflict markers', 'just\ntext\n', {}, /no conflict markers/],
		['markers that do not pair up', 'a\n<<<<<<< HEAD\nmine\n=======\ntheirs\n', {}, /do not pair up/],
		['conflicts too large to send', ['<<<<<<< HEAD', 'x'.repeat(130_000), '=======', 'y', '>>>>>>> other', ''].join('\n'), {}, /too large/],
	])('%s is not sent to Claude, and the reason is said', async (_what, text, extra, reason) => {
		conflictText(text, extra);
		await ai.proposeResolution(conflicted());
		await tick();
		expect(asks()).toEqual([]);
		expect(ai.proposal()).toBeNull();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'No resolution was proposed' });
		expect(w.toasts.at(-1)!.message).toMatch(reason);
	});

	test('an answer that leaves a conflict out proposes nothing', async () => {
		conflictText(`${CONFLICT}<<<<<<< HEAD\na\n=======\nb\n>>>>>>> origin/main\nend\n`);
		preview();
		const run = ai.proposeResolution(conflicted());
		await tick();
		expect(ai.proposal()?.conflicts).toBe(2);
		await answer(RESOLVED);
		await run;
		expect(ai.proposal()).toBeNull();
		expect(w.sent('ai_resolution_preview')).toEqual([]);
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'No resolution was proposed' });
	});

	test('an answer that still has conflict markers is thrown away', async () => {
		conflictText(CONFLICT);
		preview();
		const run = ai.proposeResolution(conflicted());
		await tick();
		await answer('<resolution conflict="1">\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> origin/main\n</resolution>');
		await run;
		expect(ai.proposal()).toBeNull();
		expect(w.sent('ai_resolution_preview')).toEqual([]);
		expect(w.toasts.at(-1)!.message).toMatch(/conflict markers/);
	});

	test('an answer with no resolution in it proposes nothing', async () => {
		conflictText(CONFLICT);
		const run = ai.proposeResolution(conflicted());
		await tick();
		await answer('I would keep your side.');
		await run;
		expect(ai.proposal()).toBeNull();
		expect(w.sent('ai_resolution_preview')).toEqual([]);
		expect(errors()).toEqual(['No resolution was proposed']);
	});

	test('discarding it while Claude works stops Claude, and its answer proposes nothing', async () => {
		conflictText(CONFLICT);
		preview();
		const run = ai.proposeResolution(conflicted());
		await tick();
		const ask = asks()[0];
		ai.discardProposal();
		await run;
		await tick();
		expect(ai.proposal()).toBeNull();
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([keyOf(ask)]);
		await answer(RESOLVED, ask);
		expect(ai.proposal()).toBeNull();
		expect(w.sent('ai_resolution_preview')).toEqual([]);
		expect(errors()).toEqual([]);
	});

	test('discarded while the file is still being read: Claude is never asked', async () => {
		let hand: (file: unknown) => void = () => undefined;
		w.on('ai_conflict_file', () => new Promise((resolve) => (hand = resolve)));
		const run = ai.proposeResolution(conflicted());
		await tick();
		expect(ai.proposal()?.state).toBe('reading');
		ai.discardProposal();
		hand({ text: CONFLICT, binary: false, tooLarge: false });
		await run;
		await tick();
		expect(asks()).toEqual([]);
		expect(ai.proposal()).toBeNull();
	});

	test('asking again replaces the proposal being made', async () => {
		conflictText(CONFLICT);
		preview();
		const first = ai.proposeResolution(conflicted());
		await tick();
		const old = asks()[0];
		const second = ai.proposeResolution(conflicted());
		await tick();
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([keyOf(old)]);
		await answer(RESOLVED);
		await Promise.all([first, second]);
		expect(ai.proposal()?.state).toBe('ready');
		expect(w.sent('ai_resolution_preview').length).toBe(1);
		expect(errors()).toEqual([]);
	});

	test('a file that is no longer conflicted has no use for its proposal', async () => {
		const file = await proposed();
		await status((st) => ({ ...st, files: st.files.map((f) => (f.path === file.path ? { ...f, status: 'modified' as const } : f)) }));
		expect(ai.proposal()).toBeNull();
		await ai.acceptProposal();
		expect(w.sent('ai_resolution_apply')).toEqual([]);
	});

	test('another checkout on screen drops it: it cannot be accepted there', async () => {
		const session = await agentInWorktree();
		repos.setTab('changes');
		await proposed();
		await agents.view(session.cwd);
		await tick();
		expect(ai.proposal()).toBeNull();
		await ai.acceptProposal();
		expect(w.sent('ai_resolution_apply')).toEqual([]);
	});

	test('a preview that fails is said, and nothing is proposed', async () => {
		conflictText(CONFLICT);
		w.on('ai_resolution_preview', () => { throw appError('git', 'could not write the temp file'); });
		const run = ai.proposeResolution(conflicted());
		await tick();
		await answer(RESOLVED);
		await run;
		expect(ai.proposal()).toBeNull();
		expect(w.toasts.at(-1)).toMatchObject({ kind: 'error', title: 'No resolution was proposed', message: 'could not write the temp file' });
	});
});
