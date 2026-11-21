import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_NAME, branchFor, namedBranch, wantsNaming } from './branch-name.ts';

test('a name from the task keeps the words that say something', () => {
	assert.equal(branchFor('Fix the seek bug!'), 'agent/fix-seek-bug');
	assert.equal(branchFor('Can you please fix the seek bug?'), 'agent/fix-seek-bug');
	assert.equal(branchFor("I'd like a dark mode in the settings"), 'agent/dark-mode-settings');
	assert.equal(branchFor("Let's rename the user's avatar field"), 'agent/rename-users-avatar-field');
	assert.equal(branchFor('Can you make the branch name suggestions based on what the task actually says instead of just taking the first few words?'), 'agent/branch-name-suggestions-based');
	assert.equal(branchFor('  '), '');
	assert.equal(branchFor('¿¡!?'), '');
	assert.equal(branchFor('Can you do it?'), 'agent/can-you-do-it', 'nothing but filler keeps its words');
});

test('a name from the task fits, cut at a word', () => {
	const long = branchFor('Internationalization localization accessibility synchronization');
	assert.equal(long, 'agent/internationalization-localization');
	assert.ok(long.length <= 'agent/'.length + MAX_NAME);
	assert.equal(branchFor('a'.repeat(80)), `agent/${'a'.repeat(MAX_NAME)}`);
});

test('Claude is asked only when the words of a task do not fit in a name', () => {
	assert.equal(wantsNaming('Fix the seek bug'), false);
	assert.equal(wantsNaming('Can you please fix the seek bug in the player?'), false);
	assert.equal(wantsNaming('The player stops when a track ends while repeat is on, it should start the queue over'), true);
	assert.equal(wantsNaming(''), false);
});

test("the name in Claude's answer becomes a branch of ours", () => {
	assert.equal(namedBranch('branch-names-from-task'), 'agent/branch-names-from-task');
	assert.equal(namedBranch('`fix-seek-past-end`\n'), 'agent/fix-seek-past-end');
	assert.equal(namedBranch('"Fix Seek Past End"'), 'agent/fix-seek-past-end');
	assert.equal(namedBranch('feature/settings_dark_mode'), 'agent/settings-dark-mode', 'its prefix is not ours');
	assert.equal(namedBranch('agent/queue-repeat.'), 'agent/queue-repeat');
	assert.equal(namedBranch('```\nqueue-repeat\n```'), 'agent/queue-repeat');
	assert.equal(namedBranch('The branch name is **fix-seek-past-end**, since the task is about seeking.'), 'agent/fix-seek-past-end');
	assert.equal(namedBranch('retry'), 'agent/retry');
});

test('an answer with no name in it gives none', () => {
	assert.equal(namedBranch(''), null);
	assert.equal(namedBranch('I cannot name this task because it is not clear what should be done.'), null);
	assert.equal(namedBranch('1234'), null, 'a number alone is no name');
	assert.equal(namedBranch('--force'), null, 'nothing that reads as an option is taken for a name');
});

test('a name that is too long is cut at a word', () => {
	const name = namedBranch('synchronize-accessibility-localization-settings-everywhere');
	assert.equal(name, 'agent/synchronize-accessibility-localization');
});
