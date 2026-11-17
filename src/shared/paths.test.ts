/**
 * Run with `npm test` (Node's own test runner; it strips the types itself).
 * These cases are the cross-platform contract: the same code has to be right for
 * `/Users/me/repo` and for `C:\Users\me\repo`, whichever machine runs the tests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirName, fileName, isWindowsPath, joinPath, relativeTo, samePath } from './paths.ts';

test('recognises Windows paths', () => {
	assert.equal(isWindowsPath('C:\\Users\\me\\repo'), true);
	assert.equal(isWindowsPath('c:/Users/me/repo'), true);
	assert.equal(isWindowsPath('\\\\server\\share\\repo'), true);
	assert.equal(isWindowsPath('/Users/me/repo'), false);
	assert.equal(isWindowsPath('src/app/main.ts'), false);
	// A repository-relative path on Linux may hold a backslash or a colon in a name.
	assert.equal(isWindowsPath('notes\\draft.md'), false);
	assert.equal(isWindowsPath('C:notes.md'), false);
});

test('file and folder names', () => {
	assert.equal(fileName('src/app/main.ts'), 'main.ts');
	assert.equal(dirName('src/app/main.ts'), 'src/app/');
	assert.equal(fileName('README.md'), 'README.md');
	assert.equal(dirName('README.md'), '');
	assert.equal(fileName('/Users/me/repo.worktrees/agent-fix'), 'agent-fix');
	assert.equal(fileName('C:\\Users\\me\\repo.worktrees\\agent-fix'), 'agent-fix');
	assert.equal(dirName('C:\\Users\\me\\repo'), 'C:\\Users\\me\\');
	assert.equal(fileName('C:/Users/me/repo'), 'repo');
	// Not a Windows path, so the backslash is part of the name.
	assert.equal(fileName('docs/odd\\name.md'), 'odd\\name.md');
});

test('the same path, however it is spelled', () => {
	assert.equal(samePath('/Users/me/repo', '/Users/me/repo/'), true);
	assert.equal(samePath('/Users/me/repo', '/Users/me/Repo'), false);
	// What git prints, what Rust prints, and what Monaco hands back for one Windows folder.
	assert.equal(samePath('C:\\Users\\me\\repo', 'C:/Users/me/repo'), true);
	assert.equal(samePath('C:\\Users\\me\\repo', 'c:\\users\\me\\repo\\'), true);
	assert.equal(samePath('C:\\Users\\me\\repo', 'C:\\Users\\me\\repo2'), false);
	assert.equal(samePath('/Users/me/repo', null), false);
	assert.equal(samePath('', ''), false);
});

test('a path inside a root', () => {
	assert.equal(relativeTo('/Users/me/repo', '/Users/me/repo/src/main.ts'), 'src/main.ts');
	assert.equal(relativeTo('/Users/me/repo/', '/Users/me/repo/src/main.ts'), 'src/main.ts');
	assert.equal(relativeTo('/Users/me/repo', '/Users/me/repo'), '');
	assert.equal(relativeTo('/Users/me/repo', '/Users/me/repo2/src/main.ts'), null);
	assert.equal(relativeTo('/Users/me/repo', '/Users/me'), null);
	assert.equal(relativeTo('/', '/etc/hosts'), 'etc/hosts');
	// Monaco's fsPath lower-cases the drive letter and uses backslashes; the root came from Rust.
	assert.equal(relativeTo('C:\\Users\\me\\repo', 'c:\\Users\\me\\repo\\src\\Main.ts'), 'src/Main.ts');
	assert.equal(relativeTo('C:\\Users\\me\\repo', 'C:/Users/me/repo/src/main.ts'), 'src/main.ts');
	assert.equal(relativeTo('C:\\Users\\me\\repo', 'C:\\Users\\me\\repo-other\\src\\main.ts'), null);
	assert.equal(relativeTo('C:\\', 'C:\\Windows\\win.ini'), 'Windows/win.ini');
	assert.equal(relativeTo('C:\\Users\\me\\repo', 'D:\\Users\\me\\repo\\a.ts'), null);
});

test('joining a repository-relative path to its root', () => {
	assert.equal(joinPath('/Users/me/repo', 'src/main.ts'), '/Users/me/repo/src/main.ts');
	assert.equal(joinPath('/Users/me/repo/', 'src/main.ts'), '/Users/me/repo/src/main.ts');
	assert.equal(joinPath('C:\\Users\\me\\repo', 'src/main.ts'), 'C:\\Users\\me\\repo\\src\\main.ts');
	assert.equal(joinPath('C:/Users/me/repo', 'src/main.ts'), 'C:/Users/me/repo/src/main.ts');
	assert.equal(joinPath('/Users/me/repo', ''), '/Users/me/repo');
	// And back again.
	assert.equal(relativeTo('C:\\Users\\me\\repo', joinPath('C:\\Users\\me\\repo', 'src/app/main.ts')), 'src/app/main.ts');
	assert.equal(relativeTo('/Users/me/repo', joinPath('/Users/me/repo', 'src/app/main.ts')), 'src/app/main.ts');
});
