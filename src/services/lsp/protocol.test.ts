import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTextEdits, planEdit, Client, codeActions, COMPLETION_KIND, changesSince, clientCapabilities, completions, inlayHints, touches, workspaceEdit, workspaceSymbols, contentChanges, highlights, languageOf, newSince, oldSpans, progress, resolved, saveWanted, signatureHelp, statusChanges, symbolsAt, syncKind, triggerCharacters, type EditorSymbol, type FileState, type Span, type LspMessage } from './protocol.ts';

/** A client whose messages land in a list, delivered a tick late like the app's own carrier. */
function wired(): { client: Client; sent: LspMessage[] } {
	const sent: LspMessage[] = [];
	const client = new Client({ key: 'k', root: '/repo', fresh: true, server: 'typescript', initializationOptions: null }, 'file:///repo', async (message) => {
		await new Promise((done) => setTimeout(done, 1));
		sent.push(message as LspMessage);
	});
	return { client, sent };
}
const settled = (): Promise<void> => new Promise((done) => setTimeout(done, 30));

test('messages go out in the order they were asked for', async () => {
	const { client, sent } = wired();
	client.notify('textDocument/didChange', { n: 1 });
	client.notify('textDocument/didChange', { n: 2 });
	void client.request('textDocument/completion', {});
	await settled();
	assert.deepEqual(
		sent.map((m) => m.method),
		['textDocument/didChange', 'textDocument/didChange', 'textDocument/completion']
	);
	assert.deepEqual(sent.map((m) => (m.params as { n?: number }).n), [1, 2, undefined]);
});

test('a request that is given up on answers null and tells the server', async () => {
	const { client, sent } = wired();
	let cancel = (): void => undefined;
	const token = { isCancellationRequested: false, onCancellationRequested: (listener: () => void) => ((cancel = listener), { dispose: () => undefined }) };
	const answer = client.request('textDocument/completion', {}, 15_000, token);
	cancel();
	assert.equal(await answer, null);
	await settled();
	assert.deepEqual(sent.map((m) => m.method), ['textDocument/completion', '$/cancelRequest']);
	assert.deepEqual(sent[1].params, { id: sent[0].id });
	// The server's "cancelled" answer for it is not the server's last error.
	client.receive({ id: sent[0].id, error: { code: -32800, message: 'Request cancelled' } });
	assert.equal(client.error, null);
});

test('a request already cancelled is never sent', async () => {
	const { client, sent } = wired();
	assert.equal(await client.request('textDocument/hover', {}, 15_000, { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => undefined }) }), null);
	await settled();
	assert.equal(sent.length, 0);
});

test('what a server registers for later is remembered', async () => {
	const { client, sent } = wired();
	client.receive({ id: 7, method: 'client/registerCapability', params: { registrations: [{ id: 'a', method: 'workspace/didChangeWatchedFiles' }] } });
	assert.ok(client.registered.has('workspace/didChangeWatchedFiles'));
	client.receive({ id: 8, method: 'client/unregisterCapability', params: { unregisterations: [{ id: 'a', method: 'workspace/didChangeWatchedFiles' }] } });
	assert.equal(client.registered.size, 0);
	await settled();
	assert.deepEqual(sent.map((m) => [m.id, m.result]), [[7, null], [8, null]]);
});

test('how a server wants edits and saves', () => {
	assert.equal(syncKind({ textDocumentSync: 2 }), 2);
	assert.equal(syncKind({ textDocumentSync: { openClose: true, change: 1 } }), 1);
	assert.equal(syncKind({}), 0);
	assert.deepEqual(saveWanted({ textDocumentSync: 2 }), { includeText: false });
	assert.deepEqual(saveWanted({ textDocumentSync: { change: 2, save: { includeText: true } } }), { includeText: true });
	assert.deepEqual(saveWanted({ textDocumentSync: { change: 2, save: true } }), { includeText: false });
	assert.equal(saveWanted({ textDocumentSync: { change: 2 } }), null);
	assert.equal(saveWanted({ textDocumentSync: 0 }), null);
});

test('edits go as ranges only to a server that takes them', () => {
	const edit = { range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 8 }, text: 'x' };
	assert.deepEqual(contentChanges(2, [edit], () => 'whole'), [{ range: { start: { line: 2, character: 4 }, end: { line: 2, character: 7 } }, text: 'x' }]);
	assert.deepEqual(contentChanges(1, [edit], () => 'whole'), [{ text: 'whole' }]);
	assert.deepEqual(contentChanges(2, null, () => 'whole'), [{ text: 'whole' }]);
});

test('progress notifications', () => {
	assert.deepEqual(progress({ token: 3, value: { kind: 'begin', title: 'Indexing', percentage: 0 } }), { token: '3', kind: 'begin', title: 'Indexing', message: undefined, percentage: 0 });
	assert.equal(progress({ token: 'x', value: { anything: 'else' } }), null);
});

test('completion kinds match Monaco by name', async () => {
	// Named in a variable: the file has no types, and all that is wanted from it is this one list.
	const enums = 'monaco-editor/editor/common/standalone/standaloneEnums.js';
	const { CompletionItemKind } = (await import(enums)) as { CompletionItemKind: Record<string, number> };
	// The protocol's CompletionItemKind, in its own order from 1.
	const names = ['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];
	names.forEach((name, at) => assert.equal(COMPLETION_KIND[at + 1], CompletionItemKind[name], name));
});

const WORD = { insert: { startLineNumber: 1, startColumn: 9, endLineNumber: 1, endColumn: 11 }, replace: { startLineNumber: 1, startColumn: 9, endLineNumber: 1, endColumn: 14 } };

test('completion items in the shapes servers send them', () => {
	const plain = completions([{ label: 'name', kind: 5 }], WORD);
	assert.equal(plain.incomplete, false);
	assert.deepEqual(plain.suggestions[0], { label: 'name', kind: 3, insertText: 'name', range: WORD, item: { label: 'name', kind: 5 } });

	const item = {
		label: 'greet',
		labelDetails: { detail: '(name)', description: './greeter' },
		kind: 3,
		tags: [1],
		detail: 'function greet(name: string): string',
		documentation: { kind: 'markdown', value: 'Builds **the** line.' },
		sortText: '11',
		filterText: 'greet',
		preselect: true,
		insertTextFormat: 2,
		textEdit: { insert: { start: { line: 0, character: 8 }, end: { line: 0, character: 10 } }, replace: { start: { line: 0, character: 8 }, end: { line: 0, character: 13 } }, newText: 'greet(${1:name})' },
		additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: "import { greet } from './greeter';\n" }],
		commitCharacters: ['('],
		command: { command: 'editor.action.triggerParameterHints', title: '' },
	};
	const list = completions({ isIncomplete: true, items: [item, { label: 'x', command: { command: 'server.private', title: 'no' } }, { nothing: true }] }, WORD);
	assert.equal(list.incomplete, true);
	assert.equal(list.suggestions.length, 2, 'an item without a label is dropped');
	assert.deepEqual(list.suggestions[0], {
		label: { label: 'greet', detail: '(name)', description: './greeter' },
		kind: 1,
		insertText: 'greet(${1:name})',
		range: WORD,
		item,
		tags: [1],
		detail: 'function greet(name: string): string',
		documentation: { value: 'Builds **the** line.' },
		sortText: '11',
		filterText: 'greet',
		preselect: true,
		insertTextRules: 4,
		commitCharacters: ['('],
		additionalTextEdits: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "import { greet } from './greeter';\n" }],
		command: { id: 'editor.action.triggerParameterHints', title: '' },
	});
	assert.equal(list.suggestions[1].command, undefined, "a server's own command is not run");
	assert.equal(list.suggestions[1].kind, 18);
	assert.deepEqual(completions(null, WORD), { suggestions: [], incomplete: false });

	// One range for the edit (not insert/replace), plain-text documentation.
	const ranged = completions([{ label: 'a', textEdit: { range: { start: { line: 4, character: 2 }, end: { line: 4, character: 3 } }, newText: 'abc' }, documentation: 'plain' }], WORD).suggestions[0];
	assert.deepEqual(ranged.range, { startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 4 });
	assert.equal(ranged.documentation, 'plain');
});

test('resolving a completion adds the slow parts and keeps what is showing', () => {
	const shown = completions([{ label: 'greet', kind: 3, sortText: '11' }], WORD).suggestions[0];
	const answer = { label: 'greet', kind: 3, detail: 'function greet()', documentation: 'Doc.', additionalTextEdits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'import' }] };
	const full = resolved(shown, answer);
	assert.equal(full.detail, 'function greet()');
	assert.equal(full.documentation, 'Doc.');
	assert.equal(full.additionalTextEdits?.[0].text, 'import');
	assert.deepEqual([full.range, full.sortText, full.insertText], [WORD, '11', 'greet']);
	assert.equal(full.item, answer);
	assert.equal(resolved(shown, null), shown);
});

test('trigger characters', () => {
	assert.deepEqual(triggerCharacters({ completionProvider: { triggerCharacters: ['.', ':'] } }, 'completionProvider'), ['.', ':']);
	assert.deepEqual(triggerCharacters({ signatureHelpProvider: { triggerCharacters: ['('], retriggerCharacters: [','] } }, 'signatureHelpProvider'), ['(', ',']);
	assert.deepEqual(triggerCharacters({}, 'completionProvider'), []);
});

test('signature help', () => {
	const raw = { signatures: [{ label: 'greet(name: string): string', documentation: { kind: 'markdown', value: 'Doc' }, parameters: [{ label: [6, 18], documentation: 'who' }] }], activeSignature: 0, activeParameter: null };
	assert.deepEqual(signatureHelp(raw), {
		signatures: [{ label: 'greet(name: string): string', documentation: { value: 'Doc' }, parameters: [{ label: [6, 18], documentation: 'who' }], activeParameter: undefined }],
		activeSignature: 0,
		activeParameter: 0,
		raw,
	});
	assert.equal(signatureHelp({ signatures: [] }), null);
	assert.equal(signatureHelp(null), null);
});

test('highlights', () => {
	assert.deepEqual(highlights([{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, kind: 3 }, { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } } }]), [
		{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 }, kind: 2 },
		{ range: { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 4 }, kind: 0 },
	]);
	assert.deepEqual(highlights(null), []);
});

test('the language of a file the editor has not opened', () => {
	assert.equal(languageOf('src/app/main.ts'), 'typescript');
	assert.equal(languageOf('src/Badge.TSX'), 'typescript');
	assert.equal(languageOf('scripts/build.mjs'), 'javascript');
	assert.equal(languageOf('src-tauri/src/lib.rs'), 'rust');
	assert.equal(languageOf('Api/Program.cs'), 'csharp');
	assert.equal(languageOf('README.md'), null);
	assert.equal(languageOf('Makefile'), null);
	assert.equal(languageOf('a.b/ts'), null);
});

test('the old lines a diff touches, without its context', () => {
	const diff = [
		'diff --git a/src/greeter.ts b/src/greeter.ts',
		'index 1111111..2222222 100644',
		'--- a/src/greeter.ts',
		'+++ b/src/greeter.ts',
		'@@ -1,7 +1,8 @@',
		' /** Builds the line. */',
		'-export function greet(name: string): string {',
		'+export function greet(name: string, loud = false): string {',
		' \treturn `Hello, ${name}!`;',
		' }',
		' ',
		' export interface Visitor {',
		'+\tnickname?: string;',
		' \tname: string;',
		'@@ -20,3 +21,2 @@ export const a = 1;',
		' const keep = 1;',
		'-const gone = 2;',
		' const last = 3;',
		'\\ No newline at end of file',
	].join('\n');
	// Line 2 was replaced, something was put between lines 6 and 7, line 21 was removed.
	assert.deepEqual(oldSpans(diff), [[2, 2], [6, 7], [21, 21]]);
	assert.deepEqual(oldSpans('@@ -0,0 +1,2 @@\n+a\n+b\n'), [[0, 1]], 'a new file: before the first line, which nothing holds');
	assert.deepEqual(oldSpans(''), []);
});

test('the innermost symbols on the touched lines', () => {
	const at = (startLineNumber: number, endLineNumber: number) => ({ startLineNumber, startColumn: 1, endLineNumber, endColumn: 1 });
	const symbol = (name: string, from: number, to: number, children: EditorSymbol[] = []): EditorSymbol => ({ name, detail: '', kind: 0, tags: [], range: at(from, to), selectionRange: at(from, from), children });
	const outline = [symbol('greet', 2, 4), symbol('Greeter', 6, 20, [symbol('name', 7, 7), symbol('hello', 9, 12), symbol('bye', 14, 18)]), symbol('later', 30, 31)];
	const names = (...spans: Span[]) => symbolsAt(outline, spans).map((s) => s.name);
	assert.deepEqual(names([3, 3]), ['greet']);
	assert.deepEqual(names([10, 10], [11, 11]), ['hello'], 'a method, not the class around it');
	assert.deepEqual(names([6, 6]), ['Greeter'], "the class's own line");
	assert.deepEqual(names([6, 7]), ['Greeter'], 'a member put in before the first one is a change to the class');
	assert.deepEqual(names([12, 13]), ['Greeter'], 'and so is one put in between two methods');
	assert.deepEqual(names([6, 6], [10, 10], [15, 15], [30, 30]), ['Greeter', 'hello', 'bye', 'later']);
	assert.deepEqual(names([4, 5], [5, 5], [25, 25]), [], 'something added after a function is not a change to it');
	assert.deepEqual(names([0, 1]), []);
});

test('errors that were not there before', () => {
	const error = (path: string, line: number, message: string, code: string) => ({ path, line, message, code });
	const before = [error('a.ts', 3, "Cannot find module 'x'", "import x from 'x';"), error('a.ts', 9, 'Type mismatch', 'const n: number = s;'), error('a.ts', 12, 'Type mismatch', 'const n: number = s;')];
	const after = [
		error('a.ts', 4, "Cannot find module 'x'", "import x from 'x';"), // moved down a line: the same error
		error('a.ts', 10, 'Type mismatch', 'const n: number = s;'),
		error('a.ts', 13, 'Type mismatch', 'const n: number = s;'),
		error('a.ts', 20, 'Type mismatch', 'const n: number = s;'), // a third one of the same: new
		error('b.ts', 3, "Cannot find module 'x'", "import x from 'x';"), // same words, another file: new
	];
	assert.deepEqual(newSince(before, after).map((e) => `${e.path}:${e.line}`), ['a.ts:20', 'b.ts:3']);
	assert.deepEqual(newSince([], after).length, 5);
	assert.deepEqual(newSince(before, []), []);
});

test('only servers that do not watch the disk themselves are offered to be told', () => {
	const base = { workspace: { configuration: true }, textDocument: {} };
	assert.deepEqual(clientCapabilities(base, 'php'), { workspace: { configuration: true, didChangeWatchedFiles: { dynamicRegistration: true } }, textDocument: {} });
	assert.equal(clientCapabilities(base, 'typescript'), base);
	assert.equal(clientCapabilities(base, 'rust'), base);
	assert.deepEqual(base, { workspace: { configuration: true }, textDocument: {} }, 'the shared copy is left alone');
});

test('what changed on disk between two looks at the status', () => {
	const f = (path: string, status: string, oldPath: string | null = null) => ({ path, status, oldPath });
	const before = [f('edited.go', 'modified'), f('new.go', 'untracked'), f('gone.go', 'deleted'), f('same.go', 'modified'), f('staged.go', 'untracked'), f('moved.go', 'renamed', 'old.go')];
	const after = [f('same.go', 'modified'), f('staged.go', 'added'), f('fresh.go', 'untracked'), f('removed.go', 'deleted'), f('b.go', 'renamed', 'a.go'), f('touched.go', 'modified')];
	const sorted = (list: { path: string; type: number }[]) => list.map((c) => `${c.path} ${c.type}`).sort();
	assert.deepEqual(sorted(statusChanges(before, after)), [
		'a.go 3', // renamed away
		'b.go 1',
		'edited.go 2', // reverted
		'fresh.go 1',
		'gone.go 1', // restored
		'moved.go 3', // the rename was undone:
		'new.go 3', // deleted again
		'old.go 1', // ... so its old name is back
		'removed.go 3',
		'staged.go 2', // listed differently: told, to be safe
		'touched.go 2',
	]);
	assert.deepEqual(statusChanges(after, after), []);
	assert.deepEqual(sorted(changesSince([f('a.go', 'modified'), f('b.go', 'added'), f('c.go', 'deleted'), f('e.go', 'renamed', 'd.go')])), ['a.go 2', 'b.go 1', 'c.go 3', 'd.go 3', 'e.go 1']);
});

const at = (line: number, character: number) => ({ line, character });
const span = (l1: number, c1: number, l2: number, c2: number) => ({ start: at(l1, c1), end: at(l2, c2) });

test('edits are applied against the text as it was, whatever order they come in', () => {
	const text = 'const visitor = 1;\r\nuse(visitor);\nlast';
	const renamed = applyTextEdits(text, [
		{ range: span(1, 4, 1, 11), newText: 'guest' },
		{ range: span(0, 6, 0, 13), newText: 'guest' },
	]);
	assert.equal(renamed, 'const guest = 1;\r\nuse(guest);\nlast', 'the line ending is kept as it is');
	// Two at one place go in the order given; a column past the end of a line is its end, before the line ending.
	assert.equal(applyTextEdits(text, [{ range: span(0, 99, 0, 99), newText: ' // a' }, { range: span(0, 99, 0, 99), newText: 'b' }]), 'const visitor = 1; // ab\r\nuse(visitor);\nlast');
	assert.equal(applyTextEdits(text, [{ range: span(3, 0, 3, 0), newText: '\nmore' }]), text + '\nmore', 'one past the last line is the end');
	assert.equal(applyTextEdits(text, [{ range: span(0, 0, 1, 0), newText: '' }]), 'use(visitor);\nlast', 'a whole line with its ending');
	assert.equal(applyTextEdits('a\u{1F600}b', [{ range: span(0, 3, 0, 4), newText: 'c' }]), 'a\u{1F600}c', 'columns count UTF-16 units, as strings do');
	assert.equal(applyTextEdits(text, [{ range: span(0, 0, 0, 8), newText: 'x' }, { range: span(0, 6, 0, 13), newText: 'y' }]), null, 'overlapping');
	assert.equal(applyTextEdits(text, [{ range: span(9, 0, 9, 1), newText: 'x' }]), null, 'outside the text');
	assert.equal(applyTextEdits(text, []), text);
});

test('the steps of a workspace edit', () => {
	const edit = { range: span(0, 0, 0, 1), newText: 'x' };
	assert.deepEqual(workspaceEdit({ changes: { 'file:///a.ts': [edit], 'file:///b.ts': [] } }), [{ kind: 'edit', uri: 'file:///a.ts', edits: [edit] }]);
	assert.deepEqual(
		workspaceEdit({ documentChanges: [{ textDocument: { uri: 'file:///a.ts', version: 3 }, edits: [edit] }, { textDocument: { uri: 'file:///a.ts', version: 3 }, edits: [edit] }] }),
		[{ kind: 'edit', uri: 'file:///a.ts', edits: [edit, edit] }],
		"one file's edits are kept together"
	);
	assert.deepEqual(
		workspaceEdit({
			documentChanges: [
				{ kind: 'create', uri: 'file:///new.ts', options: { ignoreIfExists: true } },
				{ textDocument: { uri: 'file:///new.ts', version: null }, edits: [edit] },
				{ kind: 'rename', oldUri: 'file:///new.ts', newUri: 'file:///b.ts' },
				{ textDocument: { uri: 'file:///b.ts', version: null }, edits: [edit] },
				{ kind: 'delete', uri: 'file:///a.ts', options: { ignoreIfNotExists: true } },
			],
		}),
		[
			{ kind: 'create', uri: 'file:///new.ts', overwrite: false, ignoreIfExists: true },
			{ kind: 'edit', uri: 'file:///new.ts', edits: [edit] },
			{ kind: 'rename', from: 'file:///new.ts', to: 'file:///b.ts', overwrite: false, ignoreIfExists: false },
			{ kind: 'edit', uri: 'file:///b.ts', edits: [edit] },
			{ kind: 'delete', uri: 'file:///a.ts', ignoreIfNotExists: true },
		],
		'file operations keep their place among the edits'
	);
	assert.equal(workspaceEdit({ documentChanges: [{ kind: 'chmod', uri: 'file:///a.ts' }] }), null, 'a kind of change that is not known');
	assert.deepEqual(workspaceEdit(null), []);
});

test('an edit with file operations is planned whole or not at all', () => {
	const there = (text: string | null, open = false, dirty = false): FileState => ({ exists: true, text, open, dirty });
	const insert = (text: string) => ({ range: span(0, 0, 0, 0), newText: text });
	const files = new Map([
		['src/a.ts', there('export const a = 1;\nexport const b = 2;\n', true)],
		['src/use.ts', there("import { b } from './a';\n")],
		['src/draft.ts', there('x', true, true)],
		['logo.png', there(null)],
	]);
	// "Move to a new file": the file is made, filled, and the others follow.
	const move = planEdit(
		[
			{ kind: 'create', uri: 'src/b.ts', overwrite: false, ignoreIfExists: false },
			{ kind: 'edit', uri: 'src/b.ts', edits: [insert('export const b = 2;\n')] },
			{ kind: 'edit', uri: 'src/a.ts', edits: [{ range: span(1, 0, 2, 0), newText: '' }] },
			{ kind: 'edit', uri: 'src/use.ts', edits: [{ range: span(0, 0, 0, 24), newText: "import { b } from './b';" }] },
		],
		files
	);
	assert.deepEqual(move, {
		ops: [
			{ kind: 'create', path: 'src/b.ts' },
			{ kind: 'write', path: 'src/b.ts', text: 'export const b = 2;\n' },
			{ kind: 'model', path: 'src/a.ts', edits: [{ range: span(1, 0, 2, 0), newText: '' }] },
			{ kind: 'write', path: 'src/use.ts', text: "import { b } from './b';\n" },
		],
	});
	// A renamed file is edited under its new name, with the text it had.
	assert.deepEqual(planEdit([{ kind: 'rename', from: 'src/use.ts', to: 'src/user.ts', overwrite: false, ignoreIfExists: false }, { kind: 'edit', uri: 'src/user.ts', edits: [insert('// moved\n')] }], files), {
		ops: [
			{ kind: 'rename', from: 'src/use.ts', to: 'src/user.ts', replace: false },
			{ kind: 'write', path: 'src/user.ts', text: "// moved\nimport { b } from './a';\n" },
		],
	});
	const refused = (steps: Parameters<typeof planEdit>[0]): string => {
		const plan = planEdit(steps, files);
		return 'reason' in plan ? plan.reason : '';
	};
	assert.match(refused([{ kind: 'edit', uri: 'src/use.ts', edits: [insert('x')] }, { kind: 'create', uri: 'src/a.ts', overwrite: false, ignoreIfExists: false }]), /already exists\. Nothing was changed\.$/, 'one step that cannot be done stops them all');
	assert.match(refused([{ kind: 'rename', from: 'src/use.ts', to: 'src/a.ts', overwrite: false, ignoreIfExists: false }]), /already exists/);
	assert.match(refused([{ kind: 'rename', from: 'src/draft.ts', to: 'src/final.ts', overwrite: false, ignoreIfExists: false }]), /unsaved edits: save it first/);
	assert.match(refused([{ kind: 'delete', uri: 'src/draft.ts', ignoreIfNotExists: false }]), /unsaved edits/);
	assert.match(refused([{ kind: 'delete', uri: 'src/nothing.ts', ignoreIfNotExists: false }]), /not a file that is there/);
	assert.match(refused([{ kind: 'edit', uri: 'logo.png', edits: [insert('x')] }]), /could not be read or edited/);
	assert.match(refused([{ kind: 'edit', uri: 'src/use.ts', edits: [{ range: span(9, 0, 9, 1), newText: 'x' }] }]), /could not be read or edited/);
	assert.match(refused([{ kind: 'create', uri: 'src/a.ts', overwrite: true, ignoreIfExists: false }]), /open in the editor/);
	// What a server allows to be skipped is skipped, and replacing is only done when it says so.
	assert.deepEqual(planEdit([{ kind: 'create', uri: 'src/a.ts', overwrite: false, ignoreIfExists: true }, { kind: 'delete', uri: 'src/nothing.ts', ignoreIfNotExists: true }], files), { ops: [] });
	assert.deepEqual(planEdit([{ kind: 'rename', from: 'src/use.ts', to: 'logo.png', overwrite: true, ignoreIfExists: false }, { kind: 'delete', uri: 'src/use.ts', ignoreIfNotExists: true }], files), {
		ops: [{ kind: 'rename', from: 'src/use.ts', to: 'logo.png', replace: true }],
	});
});

test('quick fixes: actions, bare commands, and what the server says of them', () => {
	const fix = { title: "Add import from './greeter'", kind: 'quickfix', isPreferred: true, edit: { changes: {} }, data: 7 };
	const list = codeActions([fix, { title: 'Extract to function', kind: 'refactor.extract', disabled: { reason: 'Select an expression' } }, { title: 'Organize', command: 'ts.organize', arguments: ['a.ts'] }, { nothing: true }]);
	assert.deepEqual(list[0], { title: "Add import from './greeter'", kind: 'quickfix', isPreferred: true, raw: fix });
	assert.equal(list[1].disabled, 'Select an expression');
	assert.deepEqual(list[2], { title: 'Organize', raw: { title: 'Organize', command: { command: 'ts.organize', arguments: ['a.ts'] } } });
	assert.equal(list.length, 3);
	assert.deepEqual(codeActions(null), []);
});

test('ranges that touch', () => {
	assert.equal(touches(span(2, 4, 2, 9), span(2, 9, 2, 9)), true, 'the cursor at the end of an error');
	assert.equal(touches(span(2, 4, 2, 9), span(2, 0, 3, 0)), true);
	assert.equal(touches(span(2, 4, 2, 9), span(2, 10, 2, 12)), false);
	assert.equal(touches(span(2, 4, 2, 9), span(1, 0, 2, 3)), false);
});

test('inlay hints and workspace symbols', () => {
	assert.deepEqual(inlayHints([{ position: at(3, 9), label: [{ value: ': ' }, { value: 'String', location: {} }], kind: 1, paddingLeft: true }, { position: at(4, 2), label: 'name:', kind: 2 }, { label: 'x' }]), [
		{ position: { lineNumber: 4, column: 10 }, label: ': String', kind: 1, paddingLeft: true, paddingRight: undefined, tooltip: undefined },
		{ position: { lineNumber: 5, column: 3 }, label: 'name:', kind: 2, paddingLeft: undefined, paddingRight: undefined, tooltip: undefined },
	]);
	assert.deepEqual(workspaceSymbols([{ name: 'greet', kind: 12, containerName: 'greeter', location: { uri: 'file:///g.ts', range: span(1, 16, 1, 21) } }, { name: 'Lazy', kind: 5, location: { uri: 'file:///l.ts' } }, { name: 'nowhere' }]), [
		{ name: 'greet', kind: 11, container: 'greeter', uri: 'file:///g.ts', range: { startLineNumber: 2, startColumn: 17, endLineNumber: 2, endColumn: 22 } },
		{ name: 'Lazy', kind: 4, container: '', uri: 'file:///l.ts', range: null },
	]);
});

test('a request from the server that takes doing something is answered when it is done', async () => {
	const { client, sent } = wired();
	client.handler = (method) => (method === 'workspace/applyEdit' ? Promise.resolve({ applied: true }) : undefined);
	client.receive({ id: 5, method: 'workspace/applyEdit', params: {} });
	client.receive({ id: 6, method: 'window/showMessageRequest', params: {} });
	await settled();
	assert.deepEqual(sent.map((m) => [m.id, m.result]).sort(), [[5, { applied: true }], [6, null]]);
});
