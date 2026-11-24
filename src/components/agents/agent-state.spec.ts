import { beforeEach, describe, expect, test } from 'vitest';
// No store is read here: the pills are templates over a session or a conversation handed to them.
import { render } from '@melodicdev/core/template';
import { convAgentState, convChip, stateChip } from './agent-state';
import type { AgentSession } from '../../services/agents.store';
import type { Conversation, ConvState } from '../../services/workspace.store';

beforeEach(() => {
	document.body.replaceChildren();
});

function session(over: Partial<AgentSession> = {}): AgentSession {
	return { id: 's1', repoId: '/repo', title: 'Task', cwd: '/repo', branch: 'main', isolated: false, mode: 'acceptEdits', sessionId: null, status: 'idle', items: [], cost: 0, updated: 0, kind: 'task', group: null, attempt: 1, base: null, tools: null, unread: false, review: false, stopped: false, investigation: null, check: null, brief: null, name: null, ...over };
}

function conversation(state: ConvState): Conversation {
	return { id: 'c1', kind: 'claude', repoId: '/repo', cwd: '/repo', branch: null, title: 'Conversation', titled: true, sessionId: 'x', state, waitingFor: null, lastSaid: '', subagents: [], created: 0, updated: 0, unread: false };
}

/** The pill on the page: what it says, and whether it moves (the three bars of something working). */
function pill(template: ReturnType<typeof stateChip>): { says: string; moving: boolean } {
	const box = document.createElement('div');
	document.body.append(box);
	render(template, box);
	return { says: (box.textContent ?? '').trim(), moving: !!box.querySelector('[aria-hidden="true"]') };
}

const INVESTIGATION = { summary: 'Crash', description: '', targetId: null, targetName: null, port: null, step: 1, details: {}, thinking: '', approval: null, runs: 0, started: 0, ended: null, report: null, leftover: [], cleanups: 0, checking: false, tab: null };

describe('a session’s pill', () => {
	test('says how it stands', () => {
		expect(pill(stateChip(session({ status: 'running' })))).toEqual({ says: 'Working', moving: true });
		expect(pill(stateChip(session({ status: 'failed' })))).toEqual({ says: 'Failed', moving: false });
		expect(pill(stateChip(session({ stopped: true })))).toEqual({ says: 'Stopped', moving: false });
		expect(pill(stateChip(session({ review: true })))).toEqual({ says: 'Needs review', moving: false });
		expect(pill(stateChip(session()))).toEqual({ says: 'Finished', moving: false });
	});

	test('a question waiting in its brief is "Needs you", since there is nothing to review', () => {
		expect(pill(stateChip(session({ brief: { title: 't', did: 'd', needs: 'Which one?', choices: [] } }))).says).toBe('Needs you');
	});

	test('a failure outranks work to review, and a running turn outranks both', () => {
		expect(pill(stateChip(session({ status: 'failed', review: true }))).says).toBe('Failed');
		expect(pill(stateChip(session({ status: 'running', review: true }))).says).toBe('Working');
	});

	test('a pipeline is working between Claude’s turns, and waits only when it says so', () => {
		const steps = Object.fromEntries(['plan', 'code', 'review', 'test', 'fix', 'ship'].map((s) => [s, { state: 'next', summary: '', lines: [], cost: 0 }]));
		const pipeline = { kind: 'bug', step: 'test', waiting: false, note: null, fixes: 0, allowedFixes: 3, models: {}, steps, plan: null, findings: [], tests: null, pushed: null } as unknown as NonNullable<AgentSession['pipeline']>;
		expect(pill(stateChip(session({ pipeline })))).toEqual({ says: 'Working', moving: true });
		expect(pill(stateChip(session({ pipeline: { ...pipeline, step: 'ship', waiting: true, note: 'Ready' } }))).says).toBe('Needs you');
		expect(pill(stateChip(session({ pipeline: { ...pipeline, step: 'done' } }))).says).toBe('Finished');
	});

	test('an investigation has its own words: it waits for an OK and ends in a cause', () => {
		const asking = { key: 's1', request: 'r', tool: 'run_target' as const, target: null, group: null, project: null, command: null, port: null, method: null, path: null, body: null, touches: null };
		const report = { found: true, summary: 'Null discount', path: [], evidence: [], test: null, run: null, causeSeq: null, crashSeq: null, notes: {} } as unknown as NonNullable<NonNullable<AgentSession['investigation']>['report']>;
		const base = session({ kind: 'investigate', investigation: INVESTIGATION });
		expect(pill(stateChip({ ...base, status: 'running' })).says).toBe('Investigating');
		expect(pill(stateChip({ ...base, status: 'running', investigation: { ...INVESTIGATION, checking: true } })).says).toBe('Checking the fix');
		// Its turn is still going, but it is the user it waits on.
		expect(pill(stateChip({ ...base, status: 'running', investigation: { ...INVESTIGATION, approval: asking } }))).toEqual({ says: 'Waiting for you', moving: false });
		expect(pill(stateChip({ ...base, investigation: { ...INVESTIGATION, report } })).says).toBe('Cause found · fix ready');
		expect(pill(stateChip({ ...base, investigation: { ...INVESTIGATION, report, leftover: ['src/a.ts'] } })).says).toBe('Cause found');
		expect(pill(stateChip({ ...base, investigation: { ...INVESTIGATION, report: { ...report, found: false } } })).says).toBe('No cause found');
	});
});

describe('a conversation’s pill', () => {
	test('says its own state, in the agents’ colours', () => {
		const seen = (['starting', 'working', 'waiting', 'idle', 'ended', 'saved'] as ConvState[]).map((state) => [state, convAgentState(conversation(state)), pill(convChip(conversation(state)))]);
		expect(seen).toEqual([
			['starting', 'working', { says: 'Starting', moving: true }],
			['working', 'working', { says: 'Working', moving: true }],
			['waiting', 'review', { says: 'Needs you', moving: false }],
			['idle', 'finished', { says: 'Ready', moving: false }],
			['ended', 'stopped', { says: 'Ended', moving: false }],
			['saved', 'stopped', { says: 'Saved', moving: false }],
		]);
	});
});
