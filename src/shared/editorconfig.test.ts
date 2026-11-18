import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorConfigFor, globToRegExp, parseEditorConfig, tidy } from './editorconfig.ts';

test('globs match the way editorconfig says', () => {
	assert.ok(globToRegExp('*').test('a.ts'));
	assert.ok(globToRegExp('*').test('src/deep/a.ts'));
	assert.ok(globToRegExp('*.{ts,js}').test('src/a.js'));
	assert.ok(!globToRegExp('*.{ts,js}').test('src/a.md'));
	assert.ok(globToRegExp('src/**.ts').test('src/x/y.ts'));
	assert.ok(!globToRegExp('src/*.ts').test('src/x/y.ts'));
	assert.ok(globToRegExp('[Mm]akefile').test('Makefile'));
	assert.ok(globToRegExp('a?.c').test('ab.c'));
	assert.ok(!globToRegExp('*.ts').test('a.tsx'));
});

test('later sections win, unknown values are ignored', () => {
	const config = parseEditorConfig(`
root = true
# all files
[*]
indent_style = tab
tab_width = 4
trim_trailing_whitespace = true
insert_final_newline = true

[*.{yml,yaml}]
indent_style = space
indent_size = 2

[*.md]
trim_trailing_whitespace = false
max_line_length = 100
indent_size = nonsense
`);
	assert.deepEqual(editorConfigFor(config, 'src/a.ts'), { indentStyle: 'tab', tabWidth: 4, indentSize: 4, trimTrailingWhitespace: true, insertFinalNewline: true });
	assert.deepEqual(editorConfigFor(config, '.github/ci.yml'), { indentStyle: 'space', tabWidth: 4, indentSize: 2, trimTrailingWhitespace: true, insertFinalNewline: true });
	assert.equal(editorConfigFor(config, 'README.md').trimTrailingWhitespace, false);
	assert.equal(editorConfigFor(config, 'README.md').maxLineLength, 100);
	assert.deepEqual(editorConfigFor(parseEditorConfig(''), 'a.ts'), {});
});

test('tidying keeps line endings', () => {
	assert.equal(tidy('a  \nb\t\nc', true, true), 'a\nb\nc\n');
	assert.equal(tidy('a  \r\nb', true, true), 'a\r\nb\r\n');
	assert.equal(tidy('a  \n', false, true), 'a  \n');
	assert.equal(tidy('', true, true), '');
	assert.equal(tidy('x', false, false), 'x');
});
