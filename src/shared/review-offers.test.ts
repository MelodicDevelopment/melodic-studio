import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeReview, nothingToReview, reviewOffers, sameRequest, type OfferInput } from './review-offers.ts';

type Status = NonNullable<OfferInput['status']>;

function offers(status: Partial<Status>, rest: Partial<Omit<OfferInput, 'status'>> = {}): string[] {
	const full: Status = { branch: 'main', detached: false, hasCommits: true, head: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, defaultBranch: 'main', changed: 0, tipUnpushed: false, ...status };
	return reviewOffers({ status: full, unpushedLoaded: 0, agentBase: null, ...rest }).map((o) => `${o.request.scope}${o.request.base ? `@${o.request.base}` : ''}: ${o.chip}`);
}

test('nothing is offered where there is nothing to review', () => {
	assert.deepEqual(reviewOffers({ status: null, unpushedLoaded: 0, agentBase: null }), []);
	assert.deepEqual(offers({ hasCommits: false, changed: 3 }), []);
	assert.deepEqual(offers({}), [], 'the default branch, level with its upstream, nothing uncommitted');
});

test('uncommitted work, commits to push and the whole branch are offered side by side', () => {
	assert.deepEqual(offers({ changed: 3 }), ['work: 3 uncommitted']);
	assert.deepEqual(offers({ ahead: 2 }), ['push: 2 to push']);
	// A feature branch with a pull request out: nothing to push, the branch is still reviewable.
	assert.deepEqual(offers({ branch: 'topic', upstream: 'origin/topic' }), ['branch: vs main']);
	assert.deepEqual(offers({ branch: 'topic', upstream: 'origin/topic', ahead: 1, changed: 1 }), ['work: 1 uncommitted', 'push: 1 to push', 'branch: vs main']);
});

test('a branch that was never pushed: "to push" is the whole branch, so it is offered once', () => {
	assert.deepEqual(offers({ branch: 'topic', upstream: null, tipUnpushed: true }), ['push: To push'], 'History not opened yet: the number is not known');
	assert.deepEqual(offers({ branch: 'topic', upstream: null, tipUnpushed: true }, { unpushedLoaded: 2 }), ['push: 2 to push']);
	// A pull request checked out into a worktree: no upstream, and every commit is on the remote.
	assert.deepEqual(offers({ branch: 'pr-12', upstream: null }), ['branch: vs main']);
	assert.deepEqual(offers({ branch: 'topic', upstream: null, defaultBranch: null }), [], 'no default branch known to compare with');
});

test("an agent's worktree: one review of everything since it started", () => {
	const base = 'b'.repeat(40);
	assert.deepEqual(offers({ branch: 'agent/x', upstream: null, head: base }, { agentBase: base }), [], 'it has changed nothing yet');
	assert.deepEqual(offers({ branch: 'agent/x', upstream: null, head: base, changed: 4 }, { agentBase: base }), [`work@${base}: Agent's work`]);
	// Committed and never pushed: the same work, not offered a second time as "to push" or as the branch.
	assert.deepEqual(offers({ branch: 'agent/x', upstream: null, tipUnpushed: true }, { agentBase: base, unpushedLoaded: 2 }), [`work@${base}: Agent's work`]);
	// Pushed, then one more commit: that commit alone is worth its own look.
	assert.deepEqual(offers({ branch: 'agent/x', upstream: 'origin/agent/x', ahead: 1 }, { agentBase: base }), [`work@${base}: Agent's work`, 'push: 1 to push']);
});

test('a detached HEAD has only its uncommitted work', () => {
	assert.deepEqual(offers({ detached: true, branch: '', changed: 2, ahead: 1 }), ['work: 2 uncommitted']);
});

test('the panel names what was reviewed', () => {
	assert.deepEqual(describeReview({ scope: 'push' }, { against: 'origin/main', commits: 2, files: 1 }), { title: 'Before you push', detail: '2 commits and 1 changed file, compared with origin/main' });
	assert.deepEqual(describeReview({ scope: 'work' }, { against: 'abc1234', commits: 0, files: 3 }), { title: 'Uncommitted changes', detail: '3 changed files, not committed yet' });
	assert.equal(describeReview({ scope: 'work', agent: true, base: 'x' }, { against: 'abc1234', commits: 0, files: 3 }).detail, '3 changed files since it started at abc1234, none of it committed yet');
	assert.equal(describeReview({ scope: 'work', agent: true, base: 'x' }, { against: 'abc1234', commits: 1, files: 3 }).detail, '3 changed files since it started at abc1234, 1 commit among them');
	assert.equal(describeReview({ scope: 'branch', label: 'Pull request #412' }, null).title, 'Pull request #412');
	assert.equal(describeReview({ scope: 'branch' }, { against: 'origin/develop', commits: 4, files: 9 }).detail, '4 commits and 9 changed files, compared with origin/develop');
	assert.match(nothingToReview({ scope: 'branch' }, { against: 'origin/main', commits: 0 }), /no commits that origin\/main does not already have/);
	assert.match(nothingToReview({ scope: 'work', agent: true }, { against: 'abc', commits: 0 }), /where the agent started/);
});

test('two requests for the same review are the same', () => {
	assert.ok(sameRequest({ scope: 'work' }, { scope: 'work', label: 'x' }));
	assert.ok(!sameRequest({ scope: 'work' }, { scope: 'work', base: 'abc' }));
	assert.ok(!sameRequest({ scope: 'push' }, { scope: 'branch' }));
	assert.ok(!sameRequest(null, { scope: 'push' }));
});
