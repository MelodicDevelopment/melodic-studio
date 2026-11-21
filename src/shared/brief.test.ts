import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activity, parseBrief, summaryOf, toolWords, wordCount, type BriefItem, type Standing } from './brief.ts';

const REPLY = [
	'I changed `reviewSession` to wait for the switch.',
	'',
	'```brief',
	'title: Review opens the wrong checkout',
	'did: Review now waits for the switch to the session’s checkout.',
	'needs: Grey out or hide the items?',
	'choice: Grey them out',
	'choice: Hide them',
	'```',
].join('\n');

test('a brief is taken out of the reply', () => {
	const { brief, rest } = parseBrief(REPLY);
	assert.deepEqual(brief, {
		title: 'Review opens the wrong checkout',
		did: 'Review now waits for the switch to the session’s checkout.',
		needs: 'Grey out or hide the items?',
		choices: ['Grey them out', 'Hide them'],
	});
	assert.equal(rest, 'I changed `reviewSession` to wait for the switch.');
});

test('"nothing" needs nothing, and then there are no choices', () => {
	const { brief } = parseBrief('Done.\n```brief\ntitle: X\ndid: Fixed it.\nneeds: Nothing.\nchoice: Yes\n```');
	assert.equal(brief?.needs, null);
	assert.deepEqual(brief?.choices, []);
});

test('a block that is not closed counts when it runs to the end', () => {
	const { brief, rest } = parseBrief('Text\n~~~brief\ndid: Read the code\nneeds: none');
	assert.equal(brief?.did, 'Read the code');
	assert.equal(brief?.needs, null);
	assert.equal(rest, 'Text');
});

test('text after the block stays, the last block wins, Markdown in values is dropped', () => {
	const text = '```brief\ndid: first\n```\nmiddle\n```brief\n- did: **second** `x`\n```\nafter';
	const { brief, rest } = parseBrief(text);
	assert.equal(brief?.did, 'second x');
	assert.equal(rest, '```brief\ndid: first\n```\nmiddle\nafter');
});

test('a plain block that ends the reply counts too (Claude sometimes writes ```text)', () => {
	const { brief, rest } = parseBrief('Fixed it.\n\n```text\ntitle: Fix add\ndid: add() adds now.\nneeds: Rename to sum?\nchoice: Yes, rename\n```\n');
	assert.equal(brief?.needs, 'Rename to sum?');
	assert.deepEqual(brief?.choices, ['Yes, rename']);
	assert.equal(rest, 'Fixed it.');
	// Not at the end: it is code, not a brief.
	const mid = '```\ndid: x\n```\nmore text';
	assert.deepEqual(parseBrief(mid), { brief: null, rest: mid });
	// A ts block is never a brief.
	const ts = '```ts\ndid: x\n```';
	assert.deepEqual(parseBrief(ts), { brief: null, rest: ts });
});

test('a ```brief inside another code block is not one', () => {
	const text = '````md\n```brief\ndid: example\n```\n````\nAfter.';
	assert.deepEqual(parseBrief(text), { brief: null, rest: text });
});

test('no brief, or one without did and needs, leaves the text alone', () => {
	assert.deepEqual(parseBrief('Just a reply.'), { brief: null, rest: 'Just a reply.' });
	const odd = '```brief\ntitle: only a title\n```';
	assert.deepEqual(parseBrief(odd), { brief: null, rest: odd });
	const code = '```ts\nconst brief = 1;\n```';
	assert.deepEqual(parseBrief(code), { brief: null, rest: code });
});

test('choices are capped at three and long values are cut', () => {
	const { brief } = parseBrief(`\`\`\`brief\ndid: x\nneeds: which?\nchoice: a\nchoice: b\nchoice: c\nchoice: d\ntitle: ${'w '.repeat(60)}\n\`\`\``);
	assert.deepEqual(brief?.choices, ['a', 'b', 'c']);
	assert.ok((brief?.title.length ?? 0) <= 60);
});

test('tool calls in words', () => {
	assert.equal(toolWords({ kind: 'tool', text: 'Edit', detail: '/Users/me/repo.worktrees/x/src/services/agents.store.ts' }), 'Editing services/agents.store.ts');
	assert.equal(toolWords({ kind: 'tool', text: 'Bash', detail: 'npm test', about: 'Run the unit tests' }), 'Run the unit tests');
	assert.equal(toolWords({ kind: 'tool', text: 'Bash', detail: 'npm test' }), 'Running npm test');
	assert.equal(toolWords({ kind: 'tool', text: 'Grep', detail: 'reviewSession' }), 'Searching for reviewSession');
	assert.equal(toolWords({ kind: 'tool', text: 'Odd' }), 'Odd');
});

test('activity is the latest step of the turn running now', () => {
	const items: BriefItem[] = [
		{ kind: 'user', text: 'first' },
		{ kind: 'tool', text: 'Read', detail: 'a/b/c.ts' },
		{ kind: 'user', text: 'second' },
	];
	assert.equal(activity(items), 'Starting');
	assert.equal(activity([...items, { kind: 'text', text: 'Now the **tests**.' }]), 'Now the tests.');
	assert.equal(activity([...items, { kind: 'text', text: 'Looking' }, { kind: 'tool', text: 'Read', detail: 'x/y.ts' }]), 'Reading x/y.ts');
});

const base: Standing = { kind: 'task', running: false, failed: false, stopped: false, review: false, unread: false, isolated: true, approval: null, brief: null, items: [{ kind: 'user', text: 'Fix the **menu**' }, { kind: 'text', text: 'Fixed the menu and the tests.' }] };

test('a finished turn says what it did and what it needs', () => {
	const brief = { title: 'Menu', did: 'Menu follows the tab.', needs: 'Grey out or hide?', choices: ['Grey', 'Hide'] };
	assert.deepEqual(summaryOf({ ...base, review: true, brief }), { asked: 'Fix the menu', now: null, did: 'Menu follows the tab.', needs: 'Grey out or hide?', choices: ['Grey', 'Hide'] });
	// No question: work to review is what it needs.
	assert.equal(summaryOf({ ...base, review: true, brief: { ...brief, needs: null, choices: [] } }).needs, 'Review its changes, then merge');
	assert.equal(summaryOf({ ...base, review: true, isolated: false }).needs, 'Review its changes');
	// No brief: the reply stands in for it.
	assert.equal(summaryOf(base).did, 'Fixed the menu and the tests.');
	assert.equal(summaryOf(base).needs, null);
	assert.equal(summaryOf({ ...base, kind: 'ask', unread: true }).needs, 'Read the answer');
});

test('running, failed, stopped and waiting for an OK', () => {
	assert.deepEqual(summaryOf({ ...base, running: true, items: [...base.items, { kind: 'user', text: 'again' }, { kind: 'tool', text: 'Bash', detail: 'cargo test' }] }), { asked: 'again', now: 'Running cargo test', did: '', needs: null, choices: [] });
	assert.equal(summaryOf({ ...base, failed: true }).needs, 'It failed: read what went wrong');
	assert.equal(summaryOf({ ...base, stopped: true }).did, 'Stopped by hand.');
	assert.equal(summaryOf({ ...base, running: true, approval: 'the app' }).needs, 'Wants to run the app');
});

test('words are counted across replies', () => {
	assert.equal(wordCount(['one two', ' three\nfour ', '']), 4);
});
