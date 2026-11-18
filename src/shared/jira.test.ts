import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiraBranch, jiraKeyOf } from './jira.ts';

test('Jira keys are found in branch names', () => {
	assert.equal(jiraKeyOf('ABC-12-login'), 'ABC-12');
	assert.equal(jiraKeyOf('feature/ABC-12-login'), 'ABC-12');
	assert.equal(jiraKeyOf('HAR-42'), 'HAR-42');
	assert.equal(jiraKeyOf('feature/abc-12'), null);
	assert.equal(jiraKeyOf('main'), null);
	assert.equal(jiraKeyOf('issue/42-fix'), null);
});

test('branches are named after the issue', () => {
	assert.equal(jiraBranch({ key: 'ABC-12', title: 'Fix the login: twice!' }), 'ABC-12-fix-the-login-twice');
	assert.equal(jiraBranch({ key: 'ABC-12', title: '!!!' }), 'ABC-12');
	assert.equal(jiraKeyOf(jiraBranch({ key: 'ABC-12', title: 'Anything at all' })), 'ABC-12');
});
