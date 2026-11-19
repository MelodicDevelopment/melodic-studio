import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byFile, marks, matcher, pieces, searchIn, summary, type SearchOptions } from './search.ts';

const plain: SearchOptions = { matchCase: false, wholeWord: false, regex: false };

test('plain text is not a pattern', () => {
	const re = matcher('a.b(', plain);
	assert.deepEqual(marks('xa.b( and A.B( but not aXb(', re), [[1, 5], [10, 14]]);
});

test('match case and whole word', () => {
	assert.deepEqual(marks('Needle needle needles', matcher('needle', { ...plain, matchCase: true })), [[7, 13], [14, 20]]);
	assert.deepEqual(marks('Needle needle needles', matcher('needle', { ...plain, wholeWord: true })), [[0, 6], [7, 13]]);
});

test('a regular expression marks every match, and one that does not compile marks nothing', () => {
	assert.deepEqual(marks('ab abb a', matcher('ab+', { ...plain, regex: true })), [[0, 2], [3, 6]]);
	assert.equal(matcher('(', { ...plain, regex: true }), null);
	assert.deepEqual(marks('anything', null), []);
	// An expression that can match nothing does not hang.
	assert.deepEqual(marks('aaa', matcher('x*', { ...plain, regex: true })), []);
});

test('a line in pieces', () => {
	assert.deepEqual(pieces('let needle = 1', [[4, 10]]), [{ text: 'let ', hit: false }, { text: 'needle', hit: true }, { text: ' = 1', hit: false }]);
	assert.deepEqual(pieces('needle', [[0, 6]]), [{ text: 'needle', hit: true }]);
	assert.deepEqual(pieces('nothing', []), [{ text: 'nothing', hit: false }]);
});

test('grouped by file, in the order found', () => {
	const result = searchIn(
		[
			['src/b.ts', 'one\n\tconst needle = 1;\n'],
			['README.md', 'a needle\r\nno\nNeedle'],
		],
		'needle',
		plain,
		10,
	);
	const files = byFile(result.matches);
	assert.deepEqual(files.map((f) => [f.dir, f.name, f.matches.map((m) => m.line)]), [['', 'README.md', [1, 3]], ['src/', 'b.ts', [2]]]);
	const hit = files[1].matches[0];
	assert.deepEqual([hit.text, hit.start, hit.column], ['const needle = 1;', 6, 8]);
	assert.equal(summary(result, 10), '3 results in 2 files');
});

test('more than the limit is said', () => {
	const result = searchIn([['a.txt', 'x\nx\nx']], 'x', plain, 2);
	assert.equal(result.truncated, true);
	assert.equal(result.matches.length, 2);
	assert.match(summary(result, 2), /^The first 2 results/);
	assert.match(summary({ matches: [], truncated: false }, 2), /^No results/);
});
