import { beforeEach, describe, expect, test } from 'vitest';
import { appError, settle, world, type Call, type World } from '../test/world';
import type { AiService } from './ai.service';
import type { RepoStore } from './repo.store';

let w: World;
let repos: RepoStore;
let ai: AiService;

beforeEach(async () => {
	w = await world();
	// Claude says only what a test makes it say.
	w.on('agent_start', () => undefined);
	w.on('agent_stop', () => undefined);
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	ai = w.get((await import('./ai.service')).AiService);
});

// ---- local helpers: Claude Code, played by the test ------------------------------------------------

/** The questions that reached the native side so far. */
async function started(): Promise<Call[]> {
	await settle();
	return w.sent('agent_start');
}

/** The key of the only question asked. */
async function only(): Promise<string> {
	const calls = await started();
	expect(calls.length).toBe(1);
	return String(calls[0].args.key);
}

const says = (key: string, ...content: Record<string, unknown>[]): void => w.emit('agent-event', { key, event: { type: 'assistant', message: { content } } });
const text = (t: string): Record<string, unknown> => ({ type: 'text', text: t });
const result = (key: string, fields: Record<string, unknown> = {}): void => w.emit('agent-event', { key, event: { type: 'result', subtype: 'success', is_error: false, ...fields } });
const ends = (key: string, ok = true, error = ''): void => w.emit('agent-done', { key, ok, error });

describe('where and how a question is asked', () => {
	test('in the checkout on screen, as a one-shot with no tools, on Haiku', async () => {
		ai.ask({ prompt: '[commit-message]\nWrite one.' }).result.catch(() => undefined);
		const calls = await started();
		expect(calls.length).toBe(1);
		const repo = repos.repo()!;
		expect(calls[0].args).toEqual({
			id: repo.id,
			cwd: repo.path,
			key: expect.stringMatching(/^ai:.+/),
			prompt: '[commit-message]\nWrite one.',
			mode: 'default',
			resume: null,
			options: { tools: [], model: 'haiku', quick: true },
		});
	});

	test('the tools and the model named are what it runs with, and nothing more', async () => {
		ai.ask({ prompt: 'Review this.', tools: ['Read', 'Grep'], model: 'sonnet' }).result.catch(() => undefined);
		const [call] = await started();
		expect(call.args.options).toEqual({ tools: ['Read', 'Grep'], model: 'sonnet', quick: true });
		expect(call.args.mode).toBe('default');
	});

	test('with a worktree on screen it asks there', async () => {
		const { BackendService } = await import('./backend.service');
		const backend = w.get(BackendService);
		const path = await backend.addWorktree(repos.repo()!.id, 'agent/elsewhere', null);
		await backend.selectWorktree(repos.repo()!.id, path);
		await repos.switchContext();
		expect(repos.repo()?.worktree).toBe(path);
		ai.ask({ prompt: 'Where am I?' }).result.catch(() => undefined);
		const [call] = await started();
		expect(call.args.cwd).toBe(path);
		expect(call.args.id).toBe(repos.repo()!.id);
	});

	test('`where` asks in that checkout, whatever is on screen', async () => {
		ai.ask({ prompt: 'Review this.', where: { repoId: '/somewhere/else', cwd: '/somewhere/else.worktrees/agent-x' } }).result.catch(() => undefined);
		const [call] = await started();
		expect(call.args.id).toBe('/somewhere/else');
		expect(call.args.cwd).toBe('/somewhere/else.worktrees/agent-x');
	});

	test('every question has a key of its own', async () => {
		ai.ask({ prompt: 'One' }).result.catch(() => undefined);
		ai.ask({ prompt: 'Two' }).result.catch(() => undefined);
		const calls = await started();
		expect(calls.length).toBe(2);
		expect(calls[0].args.key).not.toBe(calls[1].args.key);
	});

	test('with no repository open there is nowhere to ask, and nothing is started', async () => {
		w = await world();
		w.on('agent_start', () => undefined);
		const alone = w.get((await import('./ai.service')).AiService);
		await expect(alone.ask({ prompt: 'Anyone?' }).result).rejects.toThrow('Open a repository first.');
		await settle();
		expect(w.sent('agent_start')).toEqual([]);
	});
});

describe('the answer', () => {
	test('is the result Claude Code reports, not what it said on the way', async () => {
		const ask = ai.ask({ prompt: 'Q' });
		const key = await only();
		says(key, text('Let me look at the diff first.'));
		result(key, { result: 'The final answer.' });
		ends(key);
		await expect(ask.result).resolves.toBe('The final answer.');
	});

	test('without a result text it is everything Claude said, a blank line between messages', async () => {
		const ask = ai.ask({ prompt: 'Q' });
		const key = await only();
		says(key, text('First part.'));
		says(key, text('Second part.'));
		result(key, { result: '' });
		ends(key);
		await expect(ask.result).resolves.toBe('First part.\n\nSecond part.');
	});

	test('text is handed on as it arrives, everything so far each time; a tool call is not text', async () => {
		const seen: string[] = [];
		const ask = ai.ask({ prompt: 'Q', onText: (soFar) => seen.push(soFar) });
		const key = await only();
		says(key, text('Looking.'));
		says(key, { type: 'tool_use', name: 'Read', input: { file_path: 'src/a.ts' } });
		says(key, text('Found '), text('it.'));
		expect(seen).toEqual(['Looking.', 'Looking.\n\nFound it.']);
		ends(key);
		await expect(ask.result).resolves.toBe('Looking.\n\nFound it.');
	});

	test('what it cost is reported when Claude Code says', async () => {
		const costs: number[] = [];
		const ask = ai.ask({ prompt: 'Q', onCost: (usd) => costs.push(usd) });
		const key = await only();
		result(key, { result: 'A', total_cost_usd: 0.012 });
		ends(key);
		await ask.result;
		expect(costs).toEqual([0.012]);
	});

	test('no cost reported: none is made up', async () => {
		const costs: number[] = [];
		const ask = ai.ask({ prompt: 'Q', onCost: (usd) => costs.push(usd) });
		const key = await only();
		result(key, { result: 'A' });
		ends(key);
		await ask.result;
		expect(costs).toEqual([]);
	});

	test('two questions at once each get their own answer', async () => {
		const seenA: string[] = [];
		const a = ai.ask({ prompt: 'A?', onText: (t) => seenA.push(t) });
		const b = ai.ask({ prompt: 'B?' });
		const calls = await started();
		const keyA = String(calls.find((c) => c.args.prompt === 'A?')!.args.key);
		const keyB = String(calls.find((c) => c.args.prompt === 'B?')!.args.key);
		says(keyB, text('Answer to B.'));
		says(keyA, text('Answer to A.'));
		ends(keyB);
		await expect(b.result).resolves.toBe('Answer to B.');
		expect(seenA).toEqual(['Answer to A.']);
		ends(keyA);
		await expect(a.result).resolves.toBe('Answer to A.');
	});

	test('an agent session\'s events on the same channel are not an answer', async () => {
		const seen: string[] = [];
		const ask = ai.ask({ prompt: 'Q', onText: (t) => seen.push(t) });
		const key = await only();
		says('some-agent-session', text('I changed three files.'));
		result('some-agent-session', { result: 'Done.', total_cost_usd: 1 });
		ends('some-agent-session');
		await settle();
		expect(seen).toEqual([]);
		result(key, { result: 'Mine.' });
		ends(key);
		await expect(ask.result).resolves.toBe('Mine.');
	});
});

describe('failures', () => {
	test('an error result rejects with what Claude Code said', async () => {
		const ask = ai.ask({ prompt: 'Q' });
		const failed = expect(ask.result).rejects.toThrow('Credit balance is too low');
		const key = await only();
		says(key, text('Starting.'));
		result(key, { is_error: true, result: 'Credit balance is too low' });
		ends(key);
		await failed;
	});

	test('a process that fails having said nothing rejects with its error', async () => {
		const ask = ai.ask({ prompt: 'Q' });
		const failed = expect(ask.result).rejects.toThrow('claude exited with code 1');
		ends(await only(), false, 'claude exited with code 1');
		await failed;
	});

	test('and with a plain sentence when it gave no error either', async () => {
		const ask = ai.ask({ prompt: 'Q' });
		const failed = expect(ask.result).rejects.toThrow('Claude Code exited with an error.');
		ends(await only(), false);
		await failed;
	});

	test('a start the native side refuses rejects with its message, as an Error', async () => {
		w.on('agent_start', () => { throw appError('error', 'Claude Code was not found on PATH'); });
		const ask = ai.ask({ prompt: 'Q' });
		const error = await ask.result.then(
			() => null,
			(e: unknown) => e
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe('Claude Code was not found on PATH');
	});

	test('a later question still works after one that could not start', async () => {
		w.on('agent_start', () => { throw appError('error', 'not yet'); });
		await expect(ai.ask({ prompt: 'Q1' }).result).rejects.toThrow('not yet');
		w.on('agent_start', () => undefined);
		const ask = ai.ask({ prompt: 'Q2' });
		const calls = await started();
		const key = String(calls.at(-1)!.args.key);
		result(key, { result: 'Fine now.' });
		ends(key);
		await expect(ask.result).resolves.toBe('Fine now.');
	});
});

describe('stopping', () => {
	test('cancel stops Claude Code and rejects; what arrives afterwards is dropped', async () => {
		const seen: string[] = [];
		const ask = ai.ask({ prompt: 'Q', onText: (t) => seen.push(t) });
		const key = await only();
		says(key, text('Half an'));
		const stopped = expect(ask.result).rejects.toThrow('Stopped.');
		ask.cancel();
		await stopped;
		await settle();
		expect(w.sent('agent_stop').map((c) => c.args.key)).toEqual([key]);
		says(key, text('answer.'));
		result(key, { result: 'Half an answer.', total_cost_usd: 0.01 });
		ends(key);
		await settle();
		expect(seen).toEqual(['Half an']);
	});

	test('cancelled before it started: Claude Code is never started', async () => {
		const ask = ai.ask({ prompt: 'Q' });
		ask.cancel();
		await expect(ask.result).rejects.toThrow('Stopped.');
		await settle();
		expect(w.sent('agent_start')).toEqual([]);
		expect(w.sent('agent_stop')).toEqual([]);
	});

	test('cancel after the answer has come does nothing', async () => {
		const ask = ai.ask({ prompt: 'Q' });
		const key = await only();
		result(key, { result: 'Done.' });
		ends(key);
		await expect(ask.result).resolves.toBe('Done.');
		ask.cancel();
		await settle();
		expect(w.sent('agent_stop')).toEqual([]);
	});

	test('cancelling one question leaves another running', async () => {
		const a = ai.ask({ prompt: 'A?' });
		const b = ai.ask({ prompt: 'B?' });
		const calls = await started();
		const keyB = String(calls.find((c) => c.args.prompt === 'B?')!.args.key);
		const stopped = expect(a.result).rejects.toThrow('Stopped.');
		a.cancel();
		await stopped;
		result(keyB, { result: 'Still here.' });
		ends(keyB);
		await expect(b.result).resolves.toBe('Still here.');
	});

	test('a stop that the native side refuses is not an error of its own', async () => {
		w.on('agent_stop', () => { throw appError('error', 'no such process'); });
		const ask = ai.ask({ prompt: 'Q' });
		await only();
		const stopped = expect(ask.result).rejects.toThrow('Stopped.');
		ask.cancel();
		await stopped;
		await settle();
	});
});
