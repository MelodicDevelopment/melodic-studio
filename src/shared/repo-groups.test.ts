import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupByOrigin } from './repo-groups.ts';

const gh = (owner: string) => ({ provider: 'github', label: 'GitHub', owner });
const az = (owner: string) => ({ provider: 'azure', label: 'Azure DevOps', owner });

test('groups by host, then owner, in a fixed host order', () => {
	const groups = groupByOrigin([
		{ name: 'scratch', origin: null },
		{ name: 'portal', origin: az('nha/Web') },
		{ name: 'studio', origin: gh('MelodicDevelopment') },
		{ name: 'api', origin: az('nha/Web') },
		{ name: 'melodic', origin: gh('melodicdevelopment') },
		{ name: 'dotfiles', origin: gh('rick') },
		{ name: 'tool', origin: { provider: 'other', label: 'git.example.com', owner: 'team' } },
	]);
	assert.deepEqual(
		groups.map((g) => [g.label, g.count, g.owners.map((o) => [o.owner, o.items.map((i) => i.name)])]),
		[
			['GitHub', 3, [['MelodicDevelopment', ['melodic', 'studio']], ['rick', ['dotfiles']]]],
			['Azure DevOps', 2, [['nha/Web', ['api', 'portal']]]],
			['git.example.com', 1, [['team', ['tool']]]],
			['No remote', 1, [['', ['scratch']]]],
		]
	);
	// Keys stay unique and stable for remembering collapsed groups.
	const keys = groups.flatMap((g) => [g.key, ...g.owners.map((o) => o.key)]);
	assert.equal(new Set(keys).size, keys.length);
});
