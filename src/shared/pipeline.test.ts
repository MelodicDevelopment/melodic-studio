import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterChecks, blocking, columnOf, combineTests, commitMessage, newPipeline, readTestOutput } from './pipeline.ts';

test('a new pipeline starts at the plan, or at the code for a quick fix', () => {
	const f = newPipeline('feature');
	assert.equal(f.step, 'plan');
	assert.equal(f.steps.review.state, 'next');
	const q = newPipeline('quick');
	assert.equal(q.step, 'code');
	assert.equal(q.steps.plan.state, 'skip');
	assert.equal(q.steps.review.state, 'skip');
	assert.equal(columnOf(q), 1);
	assert.equal(columnOf({ ...q, step: 'done' }), 6);
});

test('the loop fixes until clean, then asks after the limit', () => {
	const p = newPipeline('bug');
	const failing = { ok: false, summary: '1 failed', failures: [], commands: [], output: '', none: false };
	assert.equal(afterChecks({ ...p, tests: failing }), 'fix');
	assert.equal(afterChecks({ ...p, tests: failing, fixes: 3 }), 'ask');
	assert.equal(afterChecks({ ...p, tests: failing, fixes: 3, allowedFixes: 4 }), 'fix');
	assert.equal(afterChecks({ ...p, tests: { ...failing, ok: true } }), 'ship');
	const nit = { file: 'a.ts', line: 1, severity: 'nit' as const, title: 't', detail: '' };
	const bug = { ...nit, severity: 'bug' as const };
	assert.equal(afterChecks({ ...p, findings: [nit] }), 'ship', 'nits do not hold it up');
	assert.equal(afterChecks({ ...p, findings: [nit, bug] }), 'fix');
	assert.deepEqual(blocking([nit, bug]), [bug]);
	const risk = { ...nit, severity: 'risk' as const };
	assert.equal(afterChecks({ ...p, findings: [risk] }), 'fix', 'a risk is fixed once');
	assert.equal(afterChecks({ ...p, findings: [risk], fixes: 1 }), 'ship', 'then it is only listed');
	assert.equal(afterChecks({ ...p, findings: [bug], fixes: 1 }), 'fix', 'a bug always goes back');
});

test('reads jest and vitest totals and failing names', () => {
	const jest = readTestOutput('  ● Auth › retries after a timeout\n\nTests:       1 failed, 41 passed, 42 total\n', false, 1);
	assert.equal(jest.summary, '41 passed, 1 failed');
	assert.deepEqual(jest.failures, ['Auth › retries after a timeout']);
	const vitest = readTestOutput(' × src/a.test.ts > keeps the page 12ms\n Tests  2 failed | 38 passed (40)\n', false, 1);
	assert.equal(vitest.summary, '38 passed, 2 failed');
	assert.deepEqual(vitest.failures, ['src/a.test.ts > keeps the page']);
	assert.equal(readTestOutput(' Tests  52 passed (52)\n', true, 0).summary, '52 passed');
});

test('reads cargo, pytest, go, dotnet and node --test', () => {
	const cargo = readTestOutput('test a::b ... FAILED\ntest result: FAILED. 10 passed; 1 failed; 0 ignored\ntest result: ok. 5 passed; 0 failed; 0 ignored\n', false, 101);
	assert.equal(cargo.summary, '15 passed, 1 failed');
	assert.deepEqual(cargo.failures, ['a::b']);
	const py = readTestOutput('FAILED tests/test_x.py::test_y - AssertionError\n========== 1 failed, 41 passed in 2.31s ==========\n', false, 1);
	assert.equal(py.summary, '41 passed, 1 failed');
	assert.deepEqual(py.failures, ['tests/test_x.py::test_y']);
	const go = readTestOutput('--- FAIL: TestRetry (0.00s)\n--- PASS: TestA (0.00s)\nFAIL\n', false, 1);
	assert.equal(go.summary, '1 passed, 1 failed');
	const dotnet = readTestOutput('  Failed Shop.Tests.Archived_tier [12 ms]\nFailed!  - Failed:     1, Passed:    41, Skipped:     0, Total:    42\n', false, 1);
	assert.equal(dotnet.summary, '41 passed, 1 failed');
	assert.deepEqual(dotnet.failures, ['Shop.Tests.Archived_tier']);
	const node = readTestOutput('not ok 3 - sums\n# pass 12\n# fail 1\n', false, 1);
	assert.equal(node.summary, '12 passed, 1 failed');
	assert.deepEqual(node.failures, ['sums']);
});

test('without totals it goes by the exit code', () => {
	assert.equal(readTestOutput('all good', true, 0).summary, 'Tests passed');
	assert.equal(readTestOutput('error TS2304', false, 2).summary, 'Tests failed (exit code 2)');
	assert.equal(readTestOutput('Tests:       41 passed, 41 total\n', false, 1).summary, '41 passed, but it exited with code 1');
});

test('no test target counts as passing, several runs are one outcome', () => {
	assert.equal(combineTests([]).ok, true);
	assert.equal(combineTests([]).none, true);
	const two = combineTests([
		{ ok: true, command: 'npm test', output: '# pass 3\n# fail 0\n', code: 0 },
		{ ok: false, command: 'cargo test', output: 'test result: FAILED. 1 passed; 1 failed;', code: 101 },
	]);
	assert.equal(two.ok, false);
	assert.match(two.summary, /npm test: 3 passed · cargo test: 1 passed, 1 failed/);
	assert.match(two.output, /^\$ cargo test/);
});

test('commit messages come from the brief', () => {
	assert.equal(commitMessage('code', 'Export reports as CSV', 'Added toCsv and a Download button.', 0), 'Export reports as CSV\n\nAdded toCsv and a Download button.');
	assert.equal(commitMessage('fix', 'Export reports as CSV', 'Escaped commas in cells.', 2), 'Fix 2: Escaped commas in cells.');
	assert.equal(commitMessage('code', '', '', 0), 'Agent work');
});

test('status words say what it is doing or waiting on', async () => {
	const { statusOf } = await import('./pipeline.ts');
	const p = newPipeline('feature');
	assert.equal(statusOf(p, true), 'Writing the plan');
	assert.equal(statusOf({ ...p, waiting: true, note: 'Approve the plan' }, false), 'Approve the plan');
	assert.equal(statusOf({ ...p, step: 'fix', fixes: 2 }, true), 'Fix 2 of 3');
	assert.equal(statusOf({ ...p, step: 'done' }, false), 'Shipped');
	assert.equal(statusOf({ ...p, step: 'done', steps: { ...p.steps, ship: { ...p.steps.ship, state: 'skip' } } }, false), 'Discarded');
});

test("reads node --test's own reporter", () => {
	const out = '✔ subtotal adds price times quantity (0.47ms)\n✖ total applies a percentage discount (1.2ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\n\n✖ failing tests:\n\ntest at test/cart.test.js:9:1\n✖ total applies a percentage discount (1.2ms)\n';
	const r = readTestOutput(out, false, 1);
	assert.equal(r.summary, '1 passed, 1 failed');
	assert.deepEqual(r.failures, ['total applies a percentage discount']);
});
