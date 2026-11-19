import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, fuzzyMatch, marked, parseGoTo, rankFiles } from './fuzzy.ts';

const FILES = [
	'CLAUDE.md',
	'README.md',
	'docs/daily-driver.md',
	'docs/debugging.md',
	'package.json',
	'src-tauri/src/agent.rs',
	'src-tauri/src/git.rs',
	'src-tauri/src/lsp/servers.rs',
	'src-tauri/src/terminal.rs',
	'src/components/agents/agent-session.component.ts',
	'src/components/app/app.component.ts',
	'src/components/app/app.styles.ts',
	'src/components/app/app.template.ts',
	'src/components/editor/editor.component.ts',
	'src/components/explorer/explorer.component.ts',
	'src/components/terminal/terminal.component.ts',
	'src/services/agents.store.ts',
	'src/services/explorer.store.ts',
	'src/services/repo.store.ts',
	'src/services/terminal.store.ts',
	'src/shared/git-ops.ts',
	'src/shared/paths.ts',
];
const index = buildIndex(FILES);
const top = (query: string, recent: string[] = []): string => rankFiles(index, query, recent, 5)[0]?.path ?? '';

test('a few letters of the name find the file', () => {
	assert.equal(top('git'), 'src-tauri/src/git.rs');
	assert.equal(top('clau'), 'CLAUDE.md');
	assert.equal(top('dail'), 'docs/daily-driver.md');
	assert.equal(top('pack'), 'package.json');
	assert.equal(top('repo'), 'src/services/repo.store.ts');
});

test('the start of each word counts: initials find a file', () => {
	assert.equal(top('asc'), 'src/components/agents/agent-session.component.ts');
	assert.equal(top('exst'), 'src/services/explorer.store.ts');
	assert.equal(top('tst'), 'src/services/terminal.store.ts');
});

test('the file name weighs more than the folders', () => {
	// "terminal" is a folder of one and the name of three.
	assert.ok(!top('termi').includes('lsp'));
	assert.equal(rankFiles(index, 'app', [], 5).every((r) => r.path.includes('/app.')), true);
	// Letters spread over the folders still find something, after the names.
	assert.equal(top('srclsp'), 'src-tauri/src/lsp/servers.rs');
});

test('words narrow each other, and a slash means the path', () => {
	assert.equal(top('terminal rs'), 'src-tauri/src/terminal.rs');
	assert.equal(top('explorer comp'), 'src/components/explorer/explorer.component.ts');
	assert.equal(top('lsp/ser'), 'src-tauri/src/lsp/servers.rs');
	assert.deepEqual(rankFiles(index, 'zzz', [], 5), []);
});

test('a file opened lately wins a tie, and leads when nothing is typed', () => {
	assert.equal(top('term'), 'src-tauri/src/terminal.rs');
	assert.equal(top('term', ['src/services/terminal.store.ts']), 'src/services/terminal.store.ts');
	const empty = rankFiles(index, '', ['src/shared/paths.ts', 'gone.ts', 'package.json'], 4).map((r) => r.path);
	assert.deepEqual(empty, ['src/shared/paths.ts', 'package.json', 'CLAUDE.md', 'README.md']);
});

test('the matched letters are known, for marking them', () => {
	const [hit] = rankFiles(index, 'gitrs', [], 1);
	assert.equal(hit.path, 'src-tauri/src/git.rs');
	assert.deepEqual(hit.at.map((i) => hit.path[i]).join(''), 'gitrs');
	assert.deepEqual(marked('git.rs', 14, hit.at), [{ text: 'git', hit: true }, { text: '.', hit: false }, { text: 'rs', hit: true }]);
	const m = fuzzyMatch('ac', 'app.component.ts', 'app.component.ts', 0, true);
	assert.deepEqual(m?.at, [0, 4]);
	assert.equal(fuzzyMatch('xyz', 'app.ts', 'app.ts'), null);
});

test('what the box was asked for', () => {
	assert.deepEqual(parseGoTo('git.rs'), { mode: 'files', query: 'git.rs', line: null, column: null });
	assert.deepEqual(parseGoTo('git.rs:120'), { mode: 'files', query: 'git.rs', line: 120, column: null });
	assert.deepEqual(parseGoTo('git.rs:120:8'), { mode: 'files', query: 'git.rs', line: 120, column: 8 });
	assert.deepEqual(parseGoTo('@ Git '), { mode: 'symbols', query: 'Git', line: null, column: null });
	assert.deepEqual(parseGoTo(''), { mode: 'files', query: '', line: null, column: null });
});
