import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKETS, bucketOf, mostPressing } from './attention.ts';

test('a running session is working, whatever else is set', () => {
	assert.equal(bucketOf('working', false), 'working');
	assert.equal(bucketOf('working', true), 'working');
});

test('work to review and anything that ended unseen need the user', () => {
	assert.equal(bucketOf('review', false), 'needs');
	assert.equal(bucketOf('finished', true), 'needs');
	assert.equal(bucketOf('failed', true), 'needs');
	assert.equal(bucketOf('stopped', true), 'needs');
});

test('what was seen and asks for nothing is done', () => {
	assert.equal(bucketOf('finished', false), 'done');
	assert.equal(bucketOf('failed', false), 'done');
	assert.equal(bucketOf('stopped', false), 'done');
});

test('attempts of one task go where the most pressing one goes', () => {
	assert.equal(mostPressing(['done', 'working', 'needs']), 'needs');
	assert.equal(mostPressing(['done', 'working']), 'working');
	assert.equal(mostPressing(['done', 'done']), 'done');
	assert.equal(mostPressing([]), 'done');
});

test('the groups are listed most pressing first', () => {
	assert.deepEqual(BUCKETS.map((b) => b.key), ['needs', 'working', 'done']);
});
