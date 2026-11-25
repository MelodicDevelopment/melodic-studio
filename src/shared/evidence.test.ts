import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceOf, evidenceText, hasEvidence, isTestFile, shipNote, type CheckLike } from './evidence.ts';
import { newPipeline, withStep, type Pipeline, type TestOutcome, type WorkKind } from './pipeline.ts';

const HEAD = 'c'.repeat(40);
const passed: TestOutcome = { ok: true, summary: '12 passed', failures: [], commands: ['npm test'], output: '', none: false, printed: '$ npm test\n Tests  12 passed (12)', millis: 1500 };
const failed: TestOutcome = { ok: false, summary: '11 passed, 1 failed', failures: ['repeat > restarts the track'], commands: ['npm test'], output: 'boom', none: false };
const clean: CheckLike = { state: 'done', problems: [], known: 0, impact: [], servers: ['TypeScript'], files: 2, users: 3, finished: true };
const finding = (severity: 'bug' | 'risk' | 'nit') => ({ file: 'src/queue.ts', line: 14, severity, title: 'Wraps one too far', detail: 'The index is not reduced.' });

/** A task waiting at Ship with every check run and clean. */
function shipped(kind: WorkKind = 'bug', over: Partial<Pipeline> = {}): Pipeline {
	let p = newPipeline(kind);
	for (const s of ['plan', 'code', 'review', 'test'] as const) {
		if (p.steps[s].state !== 'skip') {
			p = withStep(p, s, { state: 'done' });
		}
	}
	return {
		...p,
		step: 'ship',
		waiting: true,
		reason: 'ship',
		tests: passed,
		rounds: [{ fixes: 0, holding: 0, notes: 0, tests: '12 passed', ok: true }],
		checked: { head: HEAD, at: 1000, files: [{ path: 'src/queue.ts', status: 'modified' }, { path: 'src/queue.test.ts', status: 'modified' }], commits: 1, truncated: false },
		pushed: 'Committed ccccccc and pushed agent/queue-wraps.',
		...over,
	};
}

const proofOf = (p: Pipeline, id: string, check: CheckLike | null = clean) => evidenceOf({ pipeline: p, check, checksOn: true }).proofs.find((x) => x.id === id)!;

test('everything checked and clean is one plain verdict', () => {
	const e = evidenceOf({ pipeline: shipped(), check: clean, checksOn: true, tree: { head: HEAD, changes: 0 } });
	assert.equal(e.mark, 'ok');
	assert.equal(e.headline, 'Every check passed');
	assert.deepEqual(e.gaps, []);
	assert.equal(e.stale, null);
	assert.deepEqual(e.proofs.map((x) => `${x.id}:${x.mark}`), ['tests:ok', 'review:ok', 'types:ok', 'loop:ok', 'change:ok']);
	assert.equal(e.head, HEAD);
	assert.equal(e.at, 1000);
});

test('the tests say what ran, how long it took, and whether the change brought any of its own', () => {
	const own = proofOf(shipped(), 'tests');
	assert.equal(own.says, '12 passed in 1.5 s');
	assert.equal(own.lines[0].text, '$ npm test');
	assert.match(own.lines[1].text, /1 test file of its own: src\/queue\.test\.ts/);
	assert.match(own.printed ?? '', /12 passed \(12\)/);
	const none = shipped('bug', { checked: { head: HEAD, at: 1, files: [{ path: 'src/queue.ts', status: 'modified' }], commits: 1, truncated: false } });
	assert.equal(proofOf(none, 'tests').says, '12 passed in 1.5 s · all written before this change');
	assert.equal(proofOf({ ...none, kind: 'chore' }, 'tests').says, '12 passed in 1.5 s', 'a chore is not expected to bring tests');
});

test('no tests is a gap, not a pass', () => {
	const p = shipped('bug', { tests: { ok: true, summary: 'No tests found in this project', failures: [], commands: [], output: '', none: true } });
	const e = evidenceOf({ pipeline: p, check: clean, checksOn: true });
	assert.equal(e.mark, 'warn');
	assert.equal(e.headline, 'Passed what was checked · 1 thing nothing checked');
	assert.match(e.gaps[0], /^No tests ran/);
	assert.equal(e.proofs[0].mark, 'none');
});

test('a quick fix says nobody reviewed it', () => {
	const e = evidenceOf({ pipeline: shipped('quick'), check: clean, checksOn: true });
	assert.equal(proofOf(shipped('quick'), 'review').mark, 'none');
	assert.match(e.gaps[0], /a quick fix skips the review/);
	assert.equal(e.mark, 'warn');
});

test('failing tests and bugs are not ready; a risk left over is for the user to judge', () => {
	const red = evidenceOf({ pipeline: shipped('bug', { tests: failed, rounds: [{ fixes: 0, holding: 0, notes: 0, tests: failed.summary, ok: false }] }), check: clean, checksOn: true });
	assert.equal(red.mark, 'bad');
	assert.equal(red.headline, 'Not ready: tests found problems');
	assert.equal(red.proofs[0].lines[0].text, 'Failed: repeat > restarts the track');
	const bug = proofOf(shipped('bug', { findings: [finding('bug'), finding('risk')] }), 'review');
	assert.equal(bug.mark, 'bad');
	assert.equal(bug.says, '1 bug found, and 1 risk.');
	assert.deepEqual(bug.lines[0].place, { path: 'src/queue.ts', line: 14 });
	const risk = evidenceOf({ pipeline: shipped('bug', { fixes: 1, findings: [finding('risk'), finding('nit')] }), check: clean, checksOn: true });
	assert.equal(risk.mark, 'warn');
	assert.equal(risk.headline, 'Passed, with something left for you to judge');
	assert.equal(risk.proofs[1].says, 'No bugs. 1 risk left for you to judge, and 1 nit.');
	assert.equal(proofOf(shipped('bug', { findings: [finding('nit')] }), 'review').mark, 'ok');
});

test('a review that saw only part of the diff is a gap', () => {
	const p = shipped();
	const e = evidenceOf({ pipeline: { ...p, checked: { ...p.checked!, truncated: true } }, check: clean, checksOn: true });
	assert.match(e.gaps[0], /only part of the change/);
});

test('the language servers: new errors, nothing looking, switched off, out of time', () => {
	const errors: CheckLike = { ...clean, problems: [{ path: 'src/player.ts', line: 9, message: "Expected 2 arguments, but got 1." }], known: 2, impact: [{ symbol: 'next', uses: [1, 2, 3] }] };
	const bad = proofOf(shipped(), 'types', errors);
	assert.equal(bad.mark, 'bad');
	assert.equal(bad.says, '1 new error the change brought · TypeScript');
	assert.deepEqual(bad.lines.map((l) => l.text), ['src/player.ts:9', 'It changed next, used in 3 places it did not touch', '2 errors in these files were there before the change and still are']);
	assert.equal(proofOf(shipped(), 'types').says, 'No new errors in 2 changed files and 3 files that use them · TypeScript');

	const nobody = evidenceOf({ pipeline: shipped(), check: null, checksOn: true });
	assert.match(nobody.gaps[0], /no language server checked the 2 code files/);
	const off = evidenceOf({ pipeline: shipped(), check: null, checksOn: false });
	assert.match(off.gaps[0], /off in Settings/);
	const docs = shipped('chore', { checked: { head: HEAD, at: 1, files: [{ path: 'README.md', status: 'modified' }], commits: 1, truncated: false } });
	assert.deepEqual(evidenceOf({ pipeline: docs, check: null, checksOn: true }).gaps, [], 'nothing in a docs change for a compiler to look at');
	const late = evidenceOf({ pipeline: shipped(), check: { ...clean, finished: false }, checksOn: true });
	assert.match(late.gaps[0], /still working when its time ran out/);
	assert.equal(evidenceOf({ pipeline: shipped(), check: { ...clean, state: 'checking' }, checksOn: true }).headline, 'Still checking');
	assert.equal(evidenceOf({ pipeline: shipped() }).proofs.some((x) => x.id === 'types'), false, 'left out when not asked about');
});

test('the loop tells what each round found, counting a round run twice once', () => {
	const rounds = [
		{ fixes: 0, holding: 2, notes: 1, tests: '11 passed, 1 failed', ok: false },
		{ fixes: 1, holding: 0, notes: 1, tests: '11 passed, 1 failed', ok: false },
		{ fixes: 1, holding: 0, notes: 1, tests: '12 passed', ok: true },
	];
	const loop = proofOf(shipped('bug', { fixes: 1, rounds }), 'loop');
	assert.equal(loop.mark, 'ok');
	assert.equal(loop.says, 'Clean after 1 fix: each one was reviewed and tested again.');
	assert.deepEqual(loop.lines.map((l) => l.text), ['First look: 11 passed, 1 failed and 2 review findings', 'After fix 1: clean (12 passed)']);
	const stuck = proofOf(shipped('bug', { fixes: 3, rounds: [rounds[0], { fixes: 3, holding: 0, notes: 0, tests: '1 failed', ok: false }] }), 'loop');
	assert.equal(stuck.mark, 'bad');
	assert.equal(stuck.says, 'Still not clean after 3 fixes: 1 failed.');
	assert.deepEqual(proofOf(shipped(), 'loop').lines, [], 'one clean round has nothing to unfold');
});

test('work that moved after the checks is stale, but only while it waits at Ship', () => {
	const p = shipped();
	assert.match(evidenceOf({ pipeline: p, check: clean, checksOn: true, tree: { head: HEAD, changes: 2 } }).stale ?? '', /2 uncommitted changes the checks never saw/);
	const moved = evidenceOf({ pipeline: p, check: clean, checksOn: true, tree: { head: 'd'.repeat(40), changes: 0 } });
	assert.match(moved.stale ?? '', /they saw ccccccc, it is at ddddddd/);
	assert.equal(moved.mark, 'warn');
	assert.equal(moved.headline, 'Changed since it was checked');
	assert.equal(evidenceOf({ pipeline: { ...p, step: 'fix', waiting: false }, check: clean, checksOn: true, tree: { head: 'd'.repeat(40), changes: 3 } }).stale, null);
	assert.equal(evidenceOf({ pipeline: p, check: clean, checksOn: true, tree: null }).stale, null, 'nobody looked: nothing is claimed');
});

test('what Ship says in lists counts the gaps', () => {
	assert.equal(shipNote(shipped()), 'Every check passes. Merge it or open a pull request.');
	assert.equal(shipNote(shipped('bug', { fixes: 2, findings: [finding('nit')] })), 'Every check passes after 2 fixes. Merge it or open a pull request. The review left 1 note to look at.');
	assert.equal(shipNote(shipped('quick')), 'The checks that ran pass, but 1 thing nothing checked (see Ship). Merge it or open a pull request.');
});

test('there is evidence once a check has run', () => {
	assert.equal(hasEvidence(newPipeline('bug')), false);
	assert.equal(hasEvidence(shipped()), true);
});

test('the evidence as text', () => {
	const text = evidenceText(evidenceOf({ pipeline: shipped('quick'), check: clean, checksOn: true }));
	assert.equal(
		text,
		[
			'Passed what was checked · 1 thing nothing checked (checked at ccccccc)',
			'',
			'✓ Tests: 12 passed in 1.5 s',
			'– Review: Not reviewed: a quick fix skips the review.',
			'✓ Language servers: No new errors in 2 changed files and 3 files that use them · TypeScript',
			'✓ The loop: Clean at the first look: nothing needed fixing.',
			'✓ The change: 2 files changed in 1 commit since the task started.',
			'',
			'Not checked:',
			'- Nobody reviewed it: a quick fix skips the review.',
		].join('\n')
	);
});

test('test files are known by where they are or what they are called', () => {
	for (const path of ['src/a.test.ts', 'src/a.spec.tsx', 'tests/unit/a.rs', 'pkg/queue_test.go', 'app/test_queue.py', 'Shop.Tests/QueueTests.cs', 'tests/QueueTest.php', 'src/__tests__/a.js']) {
		assert.equal(isTestFile(path), true, path);
	}
	for (const path of ['src/queue.ts', 'src/contest.ts', 'src/latest/queue.ts', 'README.md']) {
		assert.equal(isTestFile(path), false, path);
	}
});
