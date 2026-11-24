import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, world, type World } from '../test/world';
import type { FakeModel, FakeMonaco, FakeNative, FakeServer, FakeToken, ProviderKind } from './lsp-fakes.spec-helper';
import type { CheckedFile, CheckResult, LspService } from './lsp.service';
import type { RepoStore } from './repo.store';
import type { ExplorerStore } from './explorer.store';

// Monaco cannot run in a pretend browser: the service gets one that is only its bookkeeping.
vi.mock('../shared/monaco', async () => (await import('./lsp-fakes.spec-helper')).monacoModule());

const HARMONY = '/Users/demo/Source/harmony';
const CADENCE = '/Users/demo/Source/cadence';

/** A file's address as the server is given it. */
const uri = (path: string, root = HARMONY): string => `file://${root}/${path}`;
const at = (lineNumber: number, column: number) => ({ lineNumber, column });
/** A protocol range on one line, counted from 0. */
const span = (line: number, from: number, to: number) => ({ start: { line, character: from }, end: { line, character: to } });

let w: World;
let monaco: FakeMonaco;
let native: FakeNative;
let repos: RepoStore;
let explorer: ExplorerStore;
let lsp: LspService;
let token: () => FakeToken;

/** Lets everything queued run, timers due now included. The clock is ours, so `settle()` would hang. */
async function flush(times = 6): Promise<void> {
	for (let i = 0; i < times; i++) {
		await vi.advanceTimersByTimeAsync(0);
	}
}

/** A fresh app with the Files tab on screen (or another tab), the demo repository open and no server installed yet. */
async function boot(tab: 'files' | 'changes' = 'files'): Promise<void> {
	w = await world();
	const fakes = await import('./lsp-fakes.spec-helper');
	token = fakes.token;
	monaco = ((await import('../shared/monaco')) as unknown as { renew(): FakeMonaco }).renew();
	repos = w.get((await import('./repo.store')).RepoStore);
	native = new fakes.FakeNative(w, () => repos.repo()?.worktree || repos.repo()!.path);
	await repos.init();
	repos.tab.set(tab);
	explorer = w.get((await import('./explorer.store')).ExplorerStore);
	explorer.sync();
	lsp = w.get((await import('./lsp.service')).LspService);
	await flush();
}

/** Open a file of the checkout on screen in the editor, the way the Files tab does. */
async function open(path: string): Promise<FakeModel> {
	explorer.open(path, true);
	await flush();
	const model = (await explorer.model(path)) as unknown as FakeModel | null;
	if (!model) {
		throw new Error(`${path} did not open`);
	}
	await flush();
	return model;
}

/** A file the demo repository does not have. */
async function addFile(path: string, text: string): Promise<void> {
	const { demoFileOp, demoWriteFile } = await import('./demo-files');
	demoFileOp('files_create', { dir: path.slice(0, Math.max(0, path.lastIndexOf('/'))), name: path.slice(path.lastIndexOf('/') + 1), isDir: false });
	demoWriteFile(path, text);
}

/** What is on the demo repository's disk now, or null when the file is not there. */
async function onDisk(path: string): Promise<string | null> {
	const { demoReadFile } = await import('./demo-files');
	try {
		return demoReadFile(path).text;
	} catch {
		return null;
	}
}

/** Ask a provider the way the editor would: for the model's language, with the model first. */
function ask(kind: ProviderKind, method: string, model: FakeModel, ...args: unknown[]): Promise<unknown> {
	return monaco.fake.ask(kind, model.getLanguageId(), method, model, ...args);
}

/** What a server was asked once the handshake was over: its requests (not the notifications), by method. */
const asked = (server: FakeServer): string[] => server.received.flatMap((m) => (m.method !== undefined && m.method !== 'initialize' && m.id !== undefined ? [m.method] : []));

/** A server that offers everything the editor can ask for. */
const EVERYTHING = {
	textDocumentSync: 2,
	completionProvider: { triggerCharacters: ['.', '"'], resolveProvider: true },
	signatureHelpProvider: { triggerCharacters: ['(', ','] },
	hoverProvider: true,
	documentHighlightProvider: true,
	declarationProvider: true,
	definitionProvider: true,
	typeDefinitionProvider: true,
	implementationProvider: true,
	referencesProvider: true,
	documentSymbolProvider: true,
	documentFormattingProvider: true,
	documentRangeFormattingProvider: true,
	renameProvider: { prepareProvider: true },
	codeActionProvider: { resolveProvider: true },
	inlayHintProvider: true,
	workspaceSymbolProvider: true,
};

beforeEach(async () => {
	vi.useFakeTimers();
	await boot();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('which server answers for a file', () => {
	test('a file opened in the editor is shown to the server for its language, once the handshake is over', async () => {
		native.install('typescript', { textDocumentSync: 2 }, { source: 'project', initializationOptions: { tsserver: { path: '/somewhere/tsserver.js' } } });
		const model = await open('src/main.ts');

		expect(w.sent('lsp_start').map((c) => c.args)).toEqual([{ id: HARMONY, language: 'typescript' }]);
		const server = native.server('typescript');
		expect(server.methods()).toEqual(['initialize', 'initialized', 'textDocument/didOpen']);
		expect(server.sent('initialize')[0]).toMatchObject({ processId: null, rootPath: HARMONY, rootUri: `file://${HARMONY}`, workspaceFolders: [{ uri: `file://${HARMONY}`, name: 'harmony' }] });
		expect(server.sent('textDocument/didOpen')).toEqual([{ textDocument: { uri: uri('src/main.ts'), languageId: 'typescript', version: 1, text: model.getValue() } }]);
		expect(lsp.running()).toEqual([server.key]);
		expect(w.toasts).toEqual([]);
	});

	test('TypeScript is told to rename a function itself, not to alias its import, beside the paths the native side worked out', async () => {
		native.install('typescript', {}, { initializationOptions: { tsserver: { path: '/somewhere/tsserver.js' } } });
		await open('src/main.ts');
		expect(native.server('typescript').sent('initialize')[0].initializationOptions).toEqual({ preferences: { providePrefixAndSuffixTextForRename: false }, tsserver: { path: '/somewhere/tsserver.js' } });
	});

	test('nothing is started until the Files tab first opens, and the files already open are picked up then', async () => {
		await boot('changes');
		native.install('typescript', { textDocumentSync: 2 });
		await open('src/main.ts');
		expect(w.sent('lsp_start')).toEqual([]);

		repos.setTab('files');
		await flush();
		expect(native.server('typescript').sent('textDocument/didOpen')).toMatchObject([{ textDocument: { uri: uri('src/main.ts') } }]);
	});

	test('a language with no server installed is asked for once, and the editor gets nothing for its files', async () => {
		await addFile('tools/a.py', 'print(1)\n');
		await addFile('tools/b.py', 'print(2)\n');
		const a = await open('tools/a.py');
		await open('tools/b.py');

		expect(w.sent('lsp_start').map((c) => c.args.language)).toEqual(['python']);
		expect(w.sent('lsp_send')).toEqual([]);
		expect(await ask('Hover', 'provideHover', a, at(1, 1), token())).toBeNull();
		expect(await ask('CompletionItem', 'provideCompletionItems', a, at(1, 1), { triggerKind: 0 }, token())).toBeNull();
		expect(await ask('Definition', 'provideDefinition', a, at(1, 1), token())).toEqual([]);
		expect(await ask('Rename', 'provideRenameEdits', a, at(1, 1), 'x', token())).toBeNull();
		expect(await ask('Rename', 'resolveRenameLocation', a, at(1, 1), token())).toBeNull();
		expect(lsp.failures()).toEqual({});
		expect(w.toasts).toEqual([]);

		// Installed since (Settings calls refresh() after an install): the open files get it.
		native.install('python', { textDocumentSync: 2 });
		await lsp.refresh();
		await flush();
		expect(native.server('python').sent<{ textDocument: { uri: string } }>('textDocument/didOpen').map((p) => p.textDocument.uri)).toEqual([uri('tools/a.py'), uri('tools/b.py')]);
	});

	test('a server that could not be started at all is not tried again for every file, only on refresh()', async () => {
		w.on('lsp_start', () => {
			throw appError('error', 'Could not start typescript-language-server: permission denied');
		});
		const model = await open('src/main.ts');
		await open('src/player/queue.ts');
		expect(w.sent('lsp_start').length).toBe(1);
		expect(await ask('Hover', 'provideHover', model, at(1, 1), token())).toBeNull();
		expect(lsp.running()).toEqual([]);

		await lsp.refresh();
		await flush();
		expect(w.sent('lsp_start').length).toBe(2);
	});

	test('every server is offered edits that create, rename and delete files, and none is told that greyed-out actions are wanted', async () => {
		native.install('typescript', {});
		await open('src/main.ts');
		const offered = native.server('typescript').sent<{ capabilities: { workspace: { applyEdit: boolean; workspaceEdit: Record<string, unknown> } } }>('initialize')[0].capabilities;
		expect(offered.workspace.applyEdit).toBe(true);
		// rust-analyzer's "Extract module to file" is not even listed without these.
		expect(offered.workspace.workspaceEdit).toMatchObject({ documentChanges: true, resourceOperations: ['create', 'rename', 'delete'] });
		// With it typescript-language-server lists every refactoring it knows, greyed out.
		expect(JSON.stringify(offered)).not.toContain('disabledSupport');
	});

	test('a file of a language no server is known for is left alone', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await open('README.md');
		await open('package.json');
		expect(w.sent('lsp_start')).toEqual([]);
	});

	test('TypeScript and JavaScript files go to the one server, which is started and greeted once', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await addFile('scripts/build.js', 'console.log(1);\n');
		await open('src/main.ts');
		await open('scripts/build.js');

		expect(native.started.length).toBe(1);
		const server = native.server('typescript');
		expect(server.sent('initialize').length).toBe(1);
		expect(server.sent<{ textDocument: { uri: string; languageId: string } }>('textDocument/didOpen').map((p) => [p.textDocument.uri, p.textDocument.languageId])).toEqual([
			[uri('src/main.ts'), 'typescript'],
			[uri('scripts/build.js'), 'javascript'],
		]);
		expect(lsp.running()).toEqual([server.key]);
	});

	test('a .tsx file is opened as typescriptreact, a .jsx file as javascriptreact', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await addFile('src/app.tsx', 'export const App = () => <div />;\n');
		await addFile('src/old.jsx', 'export const Old = () => <div />;\n');
		await open('src/app.tsx');
		await open('src/old.jsx');
		expect(native.server('typescript').sent<{ textDocument: { languageId: string } }>('textDocument/didOpen').map((p) => p.textDocument.languageId)).toEqual(['typescriptreact', 'javascriptreact']);
	});

	test('a server left running from before a reload is stopped and started clean', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		const old = native.leftover('typescript', HARMONY);
		await open('src/main.ts');

		expect(w.sent('lsp_stop').map((c) => c.args.key)).toEqual([old.key]);
		expect(old.received).toEqual([]);
		const server = native.server('typescript');
		expect(server.key).not.toBe(old.key);
		expect(server.methods()).toEqual(['initialize', 'initialized', 'textDocument/didOpen']);
		expect(lsp.failures()).toEqual({});
	});

	test("Monaco's own TypeScript features are off while a TypeScript server answers for the checkout on screen, and on otherwise", async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await open('src/main.ts');
		expect(monaco.fake.builtIns.at(-1)).toBe(false);

		await repos.openRepoTab(CADENCE);
		await flush();
		expect(monaco.fake.builtIns.at(-1)).toBe(true);

		await repos.selectRepo(HARMONY);
		await flush();
		expect(monaco.fake.builtIns.at(-1)).toBe(false);

		native.server('typescript').die('Killed');
		expect(monaco.fake.builtIns.at(-1)).toBe(true);
	});
});

describe('a feature is asked only of a server that offers it', () => {
	test('a server that offers nothing but following documents is asked nothing', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		const model = await open('src/main.ts');
		const server = native.server('typescript');
		server.clear();
		const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 };
		const options = { tabSize: 4, insertSpaces: false };

		expect(await ask('CompletionItem', 'provideCompletionItems', model, at(1, 1), { triggerKind: 0 }, token())).toBeNull();
		expect(await ask('SignatureHelp', 'provideSignatureHelp', model, at(1, 1), token(), { triggerKind: 1, isRetrigger: false })).toBeNull();
		expect(await ask('DocumentHighlight', 'provideDocumentHighlights', model, at(1, 1), token())).toEqual([]);
		expect(await ask('Declaration', 'provideDeclaration', model, at(1, 1), token())).toEqual([]);
		expect(await ask('Definition', 'provideDefinition', model, at(1, 1), token())).toEqual([]);
		expect(await ask('TypeDefinition', 'provideTypeDefinition', model, at(1, 1), token())).toEqual([]);
		expect(await ask('Implementation', 'provideImplementation', model, at(1, 1), token())).toEqual([]);
		expect(await ask('Reference', 'provideReferences', model, at(1, 1), { includeDeclaration: true }, token())).toEqual([]);
		expect(await ask('DocumentFormattingEdit', 'provideDocumentFormattingEdits', model, options, token())).toEqual([]);
		expect(await ask('DocumentRangeFormattingEdit', 'provideDocumentRangeFormattingEdits', model, range, options, token())).toEqual([]);
		expect(await ask('CodeAction', 'provideCodeActions', model, range, { trigger: 1 }, token())).toBeNull();
		expect(await ask('InlayHints', 'provideInlayHints', model, range, token())).toBeNull();
		expect(await lsp.findSymbols('queue')).toBeNull();
		expect(asked(server)).toEqual([]);
	});

	// CLAUDE.md: "A feature is only asked of a server that offers it." What holds now: a server whose
	// `initialize` answer has no hoverProvider and no documentSymbolProvider gets neither request.
	// Before the fix (2026-11-23): `hover()` and `symbols()` (lsp.service.ts and :1311) ask without looking at the
	// capabilities, unlike every other feature, so the server is sent textDocument/hover and
	// textDocument/documentSymbol and has to answer "method not found".
	test('hover and the outline are not asked of a server that does not offer them', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		const model = await open('src/main.ts');
		const server = native.server('typescript');
		server.clear();

		await ask('Hover', 'provideHover', model, at(1, 1), token());
		await ask('DocumentSymbol', 'provideDocumentSymbols', model, token());
		expect(asked(server)).toEqual([]);
	});

	test('what a server offers is asked of it, with places counted from 0, and answered in the editor\'s shapes', async () => {
		native.install('typescript', EVERYTHING);
		const model = await open('src/main.ts');
		const server = native.server('typescript');
		const there = { uri: uri('src/player/queue.ts'), range: span(2, 13, 18) };
		const where = { textDocument: { uri: uri('src/main.ts') }, position: { line: 3, character: 8 } };
		const editorRange = { startLineNumber: 3, startColumn: 14, endLineNumber: 3, endColumn: 19 };

		for (const [kind, method, request] of [
			['Declaration', 'provideDeclaration', 'textDocument/declaration'],
			['Definition', 'provideDefinition', 'textDocument/definition'],
			['TypeDefinition', 'provideTypeDefinition', 'textDocument/typeDefinition'],
			['Implementation', 'provideImplementation', 'textDocument/implementation'],
		] as const) {
			server.reply(request, () => there);
			expect(await ask(kind, method, model, at(4, 9), token())).toEqual([{ uri: monaco.Uri.parse(there.uri), range: editorRange }]);
			expect(server.sent(request)).toEqual([where]);
		}

		server.reply('textDocument/references', () => [there]);
		expect(await ask('Reference', 'provideReferences', model, at(4, 9), { includeDeclaration: false }, token())).toEqual([{ uri: monaco.Uri.parse(there.uri), range: editorRange }]);
		expect(server.sent('textDocument/references')).toEqual([{ ...where, context: { includeDeclaration: true } }]);

		server.reply('textDocument/hover', () => ({ contents: { kind: 'markdown', value: '**Queue**' }, range: span(2, 13, 18) }));
		expect(await ask('Hover', 'provideHover', model, at(4, 9), token())).toEqual({ contents: [{ value: '**Queue**' }], range: editorRange });

		server.reply('textDocument/documentHighlight', () => [{ range: span(2, 13, 18), kind: 3 }]);
		expect(await ask('DocumentHighlight', 'provideDocumentHighlights', model, at(4, 9), token())).toMatchObject([{ range: editorRange }]);

		server.reply('textDocument/formatting', () => [{ range: span(0, 0, 2), newText: '\t' }]);
		expect(await ask('DocumentFormattingEdit', 'provideDocumentFormattingEdits', model, { tabSize: 4, insertSpaces: false }, token())).toEqual([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 }, text: '\t' }]);
		expect(server.sent('textDocument/formatting')).toEqual([{ textDocument: { uri: uri('src/main.ts') }, options: { tabSize: 4, insertSpaces: false } }]);

		server.reply('textDocument/rangeFormatting', () => null);
		expect(await ask('DocumentRangeFormattingEdit', 'provideDocumentRangeFormattingEdits', model, { startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 1 }, { tabSize: 2, insertSpaces: true }, token())).toEqual([]);
		expect(server.sent('textDocument/rangeFormatting')).toEqual([{ textDocument: { uri: uri('src/main.ts') }, options: { tabSize: 2, insertSpaces: true }, range: { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } } }]);

		server.reply('textDocument/inlayHint', () => [{ position: { line: 4, character: 10 }, label: ': RepeatMode', kind: 1 }]);
		expect(await ask('InlayHints', 'provideInlayHints', model, { startLineNumber: 1, startColumn: 1, endLineNumber: 9, endColumn: 1 }, token())).toMatchObject({ hints: [{ position: { lineNumber: 5, column: 11 }, label: ': RepeatMode', kind: 1 }] });
		expect(server.sent('textDocument/inlayHint')).toEqual([{ textDocument: { uri: uri('src/main.ts') }, range: { start: { line: 0, character: 0 }, end: { line: 8, character: 0 } } }]);

		server.reply('textDocument/signatureHelp', () => ({ signatures: [{ label: 'next(repeat?: boolean): Track | null', parameters: [{ label: 'repeat?: boolean' }] }], activeSignature: 0, activeParameter: 0 }));
		expect(await ask('SignatureHelp', 'provideSignatureHelp', model, at(4, 9), token(), { triggerKind: 2, triggerCharacter: '(', isRetrigger: false })).toMatchObject({ value: { signatures: [{ label: 'next(repeat?: boolean): Track | null' }], activeSignature: 0, activeParameter: 0 } });
		expect(server.sent('textDocument/signatureHelp')).toMatchObject([{ ...where, context: { triggerKind: 2, triggerCharacter: '(', isRetrigger: false } }]);
	});
});

describe('keeping the server\'s copy of a file in step', () => {
	test('edits reach the server as ranges, in the order made, ahead of the question asked after them', async () => {
		native.install('typescript', { textDocumentSync: 2, hoverProvider: true });
		const model = await open('src/main.ts');
		const server = native.server('typescript');
		server.clear();

		model.type('// first\n');
		model.type('x', 2, 1);
		await ask('Hover', 'provideHover', model, at(1, 1), token());

		expect(server.methods()).toEqual(['textDocument/didChange', 'textDocument/hover']);
		expect(server.sent('textDocument/didChange')).toEqual([
			{
				textDocument: { uri: uri('src/main.ts'), version: 2 },
				contentChanges: [
					{ range: span(0, 0, 0), text: '// first\n' },
					{ range: span(1, 0, 0), text: 'x' },
				],
			},
		]);
		// Sent once: the timer that would have sent them finds nothing left.
		await vi.advanceTimersByTimeAsync(1000);
		expect(server.sent('textDocument/didChange').length).toBe(1);
	});

	test('typing is sent on by itself within 300 ms, each batch under the next version', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		const model = await open('src/main.ts');
		const server = native.server('typescript');

		model.type('a');
		await vi.advanceTimersByTimeAsync(299);
		expect(server.sent('textDocument/didChange')).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		model.type('b');
		await vi.advanceTimersByTimeAsync(300);
		expect(server.sent<{ textDocument: { version: number } }>('textDocument/didChange').map((p) => p.textDocument.version)).toEqual([2, 3]);
	});

	test('a server that takes whole documents gets the whole text each time', async () => {
		native.install('typescript', { textDocumentSync: { change: 1 } });
		const model = await open('src/main.ts');
		model.type('// top\n');
		await vi.advanceTimersByTimeAsync(300);
		expect(native.server('typescript').sent('textDocument/didChange')).toEqual([{ textDocument: { uri: uri('src/main.ts'), version: 2 }, contentChanges: [{ text: model.getValue() }] }]);
	});

	test('a server that does not follow edits is sent none', async () => {
		native.install('typescript', { hoverProvider: true });
		const model = await open('src/main.ts');
		model.type('// top\n');
		await vi.advanceTimersByTimeAsync(300);
		await ask('Hover', 'provideHover', model, at(1, 1), token());
		expect(native.server('typescript').sent('textDocument/didChange')).toEqual([]);
	});

	test('when the whole text was replaced, or there were more than 200 edits, the whole text goes instead of ranges', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		const model = await open('src/main.ts');
		const server = native.server('typescript');

		model.setValue('const replaced = true;\n');
		await vi.advanceTimersByTimeAsync(300);
		for (let n = 0; n < 201; n++) {
			model.type('x');
		}
		await vi.advanceTimersByTimeAsync(300);
		model.type('y');
		await vi.advanceTimersByTimeAsync(300);

		const changes = server.sent<{ contentChanges: unknown[] }>('textDocument/didChange').map((p) => p.contentChanges);
		expect(changes[0]).toEqual([{ text: 'const replaced = true;\n' }]);
		expect(changes[1]).toEqual([{ text: model.getValue().slice(1) }]);
		// And back to ranges afterwards.
		expect(changes[2]).toEqual([{ range: span(0, 0, 0), text: 'y' }]);
	});

	test('messages reach the server one at a time and in the order asked, however slow the carrier is', async () => {
		native.install('typescript', { textDocumentSync: 2, hoverProvider: true, definitionProvider: true });
		const model = await open('src/main.ts');
		const server = native.server('typescript');
		server.clear();
		// The first to go takes the longest: sent side by side, the later ones would overtake it.
		native.delay = (message) => (message.method === 'textDocument/didChange' ? 50 : message.method === 'textDocument/hover' ? 20 : 0);

		model.type('x');
		const answers = [ask('Hover', 'provideHover', model, at(1, 1), token()), ask('Definition', 'provideDefinition', model, at(1, 1), token())];
		await vi.advanceTimersByTimeAsync(200);
		await Promise.all(answers);

		expect(server.methods()).toEqual(['textDocument/didChange', 'textDocument/hover', 'textDocument/definition']);
		expect(native.busiest).toBe(1);
	});

	test('a question the editor gives up on tells the server to stop working on it, and answers nothing', async () => {
		native.install('typescript', { textDocumentSync: 2, hoverProvider: true });
		const model = await open('src/main.ts');
		const server = native.server('typescript');
		server.hold('textDocument/hover');
		const cancel = token();

		const answer = ask('Hover', 'provideHover', model, at(1, 1), cancel);
		await flush();
		cancel.cancel();
		expect(await answer).toBeNull();
		await flush();
		expect(server.sent('$/cancelRequest')).toEqual([{ id: server.requests('textDocument/hover')[0].id }]);
	});

	test('a question already given up on is never sent', async () => {
		native.install('typescript', { textDocumentSync: 2, hoverProvider: true });
		const model = await open('src/main.ts');
		const server = native.server('typescript');
		server.clear();
		const cancel = token();
		cancel.cancel();

		expect(await ask('Hover', 'provideHover', model, at(1, 1), cancel)).toBeNull();
		expect(server.methods()).toEqual([]);
	});

	test('a question the server never answers is given up after its time, and the server is told', async () => {
		native.install('typescript', { textDocumentSync: 2, hoverProvider: true });
		const model = await open('src/main.ts');
		const server = native.server('typescript');
		server.hold('textDocument/hover');

		let answer: unknown = 'waiting';
		void ask('Hover', 'provideHover', model, at(1, 1), token()).then((result) => (answer = result));
		await vi.advanceTimersByTimeAsync(14_900);
		expect(answer).toBe('waiting');
		await vi.advanceTimersByTimeAsync(200);
		expect(answer).toBeNull();
		expect(server.sent('$/cancelRequest')).toEqual([{ id: server.requests('textDocument/hover')[0].id }]);
	});

	test('closing a file tells the server and takes its marks down', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		const model = await open('src/main.ts');
		const server = native.server('typescript');
		server.publish(uri('src/main.ts'), [{ range: span(3, 6, 11), message: "Cannot find name 'Queue'.", severity: 1, source: 'ts', code: 2304 }]);
		expect(monaco.fake.markers(model)).toEqual([{ startLineNumber: 4, startColumn: 7, endLineNumber: 4, endColumn: 12, message: "Cannot find name 'Queue'.", severity: 8, source: 'ts', code: '2304', tags: undefined }]);

		model.type('// thrown away with the tab\n');
		explorer.close('src/main.ts', true);
		await flush();
		expect(model.isDisposed()).toBe(true);
		expect(server.sent('textDocument/didClose')).toEqual([{ textDocument: { uri: uri('src/main.ts') } }]);
		// Edits to a file that is closed are nobody's to send.
		await vi.advanceTimersByTimeAsync(1000);
		expect(server.sent('textDocument/didChange')).toEqual([]);
		expect(server.methods().at(-1)).toBe('textDocument/didClose');
	});
});

describe('a server that is out of action', () => {
	const NOT_RUNNING = 'The TypeScript and JavaScript language server is not running';

	test('one that refuses the handshake is said once, stopped, and not started again until refresh()', async () => {
		const spec = native.install('typescript', { textDocumentSync: 2 }, { handshake: 'refuse', says: 'No tsserver was found' });
		await open('src/main.ts');

		expect(lsp.failures()).toEqual({ typescript: 'No tsserver was found' });
		expect(lsp.running()).toEqual([]);
		expect(w.toasts).toEqual([{ kind: 'warning', title: NOT_RUNNING, message: 'No tsserver was found See Language servers in Settings.' }]);
		expect(w.sent('lsp_stop').map((c) => c.args.key)).toEqual([native.started[0].key]);

		// Every further file of the language would only repeat it.
		await open('src/player/queue.ts');
		expect(w.sent('lsp_start').length).toBe(1);
		expect(w.toasts.length).toBe(1);

		spec.handshake = 'accept';
		await lsp.refresh();
		await flush();
		expect(lsp.failures()).toEqual({});
		const server = native.server('typescript');
		expect(server.sent<{ textDocument: { uri: string } }>('textDocument/didOpen').map((p) => p.textDocument.uri)).toEqual([uri('src/main.ts'), uri('src/player/queue.ts')]);
		expect(lsp.running()).toEqual([server.key]);
		expect(w.toasts.length).toBe(1);
	});

	test('one that exits before it has answered is reported with its last words', async () => {
		native.install('typescript', {}, { handshake: 'die', says: 'env: node: No such file or directory' });
		await open('src/main.ts');
		await open('src/player/queue.ts');

		expect(lsp.failures()).toEqual({ typescript: 'env: node: No such file or directory' });
		expect(w.toasts).toEqual([{ kind: 'warning', title: NOT_RUNNING, message: 'env: node: No such file or directory See Language servers in Settings.' }]);
		expect(w.sent('lsp_start').length).toBe(1);
		expect(lsp.running()).toEqual([]);
	});

	test('one that never answers the handshake is given up on after a minute', async () => {
		native.install('rust', {}, { handshake: 'silent' });
		await addFile('native/lib.rs', 'fn main() {}\n');
		await open('native/lib.rs');

		await vi.advanceTimersByTimeAsync(59_000);
		expect(lsp.failures()).toEqual({});
		await vi.advanceTimersByTimeAsync(3_000);
		expect(lsp.failures()).toEqual({ rust: 'It did not answer.' });
		expect(w.toasts).toEqual([{ kind: 'warning', title: 'The Rust language server is not running', message: 'It did not answer. See Language servers in Settings.' }]);
		expect(w.sent('lsp_stop').map((c) => c.args.key)).toEqual([native.started[0].key]);
	});

	test('one that exits by itself is reported once, its marks and work taken down, and not started again until refresh()', async () => {
		native.install('typescript', { textDocumentSync: 2, hoverProvider: true });
		const model = await open('src/main.ts');
		const server = native.server('typescript');
		server.publish(uri('src/main.ts'), [{ range: span(0, 0, 6), message: 'An error', severity: 1 }]);
		server.progress('load', { kind: 'begin', title: 'Loading project' });
		server.hold('textDocument/hover');
		const waiting = ask('Hover', 'provideHover', model, at(1, 1), token());
		await flush();

		server.die('Segmentation fault');
		expect(await waiting).toBeNull();
		expect(lsp.failures()).toEqual({ typescript: 'Segmentation fault' });
		expect(lsp.running()).toEqual([]);
		expect(lsp.working()).toEqual({});
		expect(monaco.fake.markers(model)).toEqual([]);
		expect(w.toasts).toEqual([{ kind: 'warning', title: NOT_RUNNING, message: 'Segmentation fault See Language servers in Settings.' }]);

		// Neither another file nor a question brings it back.
		await open('src/player/queue.ts');
		expect(await ask('Hover', 'provideHover', model, at(1, 1), token())).toBeNull();
		model.type('x');
		await vi.advanceTimersByTimeAsync(1000);
		expect(w.sent('lsp_start').length).toBe(1);
		expect(w.toasts.length).toBe(1);

		await lsp.refresh();
		await flush();
		const again = native.server('typescript');
		expect(again.key).not.toBe(server.key);
		expect(again.sent<{ textDocument: { uri: string; text: string } }>('textDocument/didOpen').map((p) => [p.textDocument.uri, p.textDocument.text])).toEqual([
			[uri('src/main.ts'), model.getValue()],
			[uri('src/player/queue.ts'), await onDisk('src/player/queue.ts')],
		]);
		expect(lsp.failures()).toEqual({});
		expect(lsp.running()).toEqual([again.key]);
	});

	test('one that goes without a word is said to have stopped unexpectedly; a long last word is cut in the toast only', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.install('rust', { textDocumentSync: 2 });
		await addFile('native/lib.rs', 'fn main() {}\n');
		await open('src/main.ts');
		await open('native/lib.rs');

		native.server('typescript').die();
		const long = 'thread main panicked: '.repeat(30);
		native.server('rust').die(long);
		expect(lsp.failures()).toEqual({ typescript: 'It stopped unexpectedly.', rust: long });
		expect(w.toasts.map((t) => t.message)).toEqual(['It stopped unexpectedly. See Language servers in Settings.', `${long.slice(0, 300)}… See Language servers in Settings.`]);
	});

	test('one the app stopped is no failure: the open files go to a fresh copy', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await open('src/main.ts');
		const first = native.server('typescript');
		const { BackendService } = await import('./backend.service');

		await w.get(BackendService).lspStop(first.key);
		await flush();
		const second = native.server('typescript');
		expect(second.key).not.toBe(first.key);
		expect(second.sent('textDocument/didOpen')).toMatchObject([{ textDocument: { uri: uri('src/main.ts') } }]);
		expect(lsp.running()).toEqual([second.key]);
		expect(lsp.failures()).toEqual({});
		expect(w.toasts).toEqual([]);
	});
});

describe('servers of checkouts that are not on screen', () => {
	const stopped = (): unknown[] => w.sent('lsp_stop').map((c) => c.args.key);

	test('a repository whose tab is closed has its servers stopped at once', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await open('src/main.ts');
		const server = native.server('typescript');

		await repos.openRepoTab(CADENCE);
		await flush();
		// Still open in a tab of its own.
		expect(stopped()).toEqual([]);

		await repos.closeRepoTab(HARMONY);
		await flush();
		expect(stopped()).toEqual([server.key]);
		expect(lsp.running()).toEqual([]);
		expect(lsp.failures()).toEqual({});
	});

	test('a repository another one takes the place of in its tab has its servers stopped at once', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await open('src/main.ts');
		const server = native.server('typescript');

		await repos.selectRepo(CADENCE);
		await flush();
		expect(stopped()).toEqual([server.key]);
	});

	test('a repository that is removed has its servers stopped at once', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await open('src/main.ts');
		const server = native.server('typescript');

		await repos.removeRepo(HARMONY);
		await flush();
		expect(repos.repo()?.id).toBe(CADENCE);
		expect(stopped()).toEqual([server.key]);
	});

	test('a server whose checkout has been off screen for ten minutes is stopped, and started again when the checkout is shown', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await open('src/main.ts');
		const first = native.server('typescript');

		await repos.openRepoTab(CADENCE);
		await flush();
		await vi.advanceTimersByTimeAsync(9 * 60_000);
		expect(stopped()).toEqual([]);
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		expect(stopped()).toEqual([first.key]);
		expect(lsp.running()).toEqual([]);

		await repos.selectRepo(HARMONY);
		await flush();
		const second = native.server('typescript');
		expect(second.key).not.toBe(first.key);
		expect(second.sent('textDocument/didOpen')).toMatchObject([{ textDocument: { uri: uri('src/main.ts') } }]);
		expect(lsp.failures()).toEqual({});
		expect(w.toasts).toEqual([]);
	});

	test('a worktree on screen gets a server of its own, and closing the repository\'s tab stops that one with the main checkout\'s', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await open('src/main.ts');
		const main = native.server('typescript');
		const backend = w.get((await import('./backend.service')).BackendService);
		const tree = await backend.call<string>('worktree_add', { id: HARMONY, branch: 'agent/fix' });
		await backend.call('worktree_select', { id: HARMONY, path: tree });
		await repos.switchContext();
		explorer.sync();
		await flush();

		await open('src/main.ts');
		const other = native.server('typescript', tree);
		expect(other.key).not.toBe(main.key);
		expect(other.sent('initialize')[0]).toMatchObject({ rootUri: `file://${tree}` });
		expect(other.sent('textDocument/didOpen')).toMatchObject([{ textDocument: { uri: uri('src/main.ts', tree) } }]);
		// The main checkout is still the tab's: its server stays, for now.
		expect(stopped()).toEqual([]);
		expect([...lsp.running()].sort()).toEqual([main.key, other.key].sort());

		await repos.openRepoTab(CADENCE);
		await flush();
		expect(stopped()).toEqual([]);
		await repos.closeRepoTab(HARMONY);
		await flush();
		expect(stopped().sort()).toEqual([main.key, other.key].sort());
	});

	test('the servers of the checkout on screen are never stopped for sitting idle', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await open('src/main.ts');
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(stopped()).toEqual([]);
		expect(lsp.running()).toEqual([native.server('typescript').key]);
	});
});

describe('an edit a server asks for across files', () => {
	const MAIN = 'src/main.ts';
	const QUEUE = 'src/player/queue.ts';
	const writes = (): unknown[] => w.sent('write_file').map((c) => c.args.path);
	const rename = (model: FakeModel, to = 'playlist'): Promise<unknown> => ask('Rename', 'provideRenameEdits', model, at(4, 8), to, token());
	/** `queue` to `playlist` where main.ts declares and uses it. */
	const inMain = [
		{ range: span(3, 6, 11), newText: 'playlist' },
		{ range: span(11, 19, 24), newText: 'playlist' },
	];
	/** Ask the client to apply an edit, as a server does for a refactoring it works out itself. */
	async function applied(server: FakeServer, edit: unknown, label?: string): Promise<unknown> {
		const id = server.ask('workspace/applyEdit', { label, edit });
		await flush();
		return server.answer(id);
	}

	test('a rename edits the open file in the editor and saves it, rewrites the closed one on disk, and hands Monaco nothing to apply', async () => {
		native.install('typescript', EVERYTHING);
		const model = await open(MAIN);
		const server = native.server('typescript');
		const queueBefore = (await onDisk(QUEUE))!;
		server.reply('textDocument/rename', () => ({ changes: { [uri(MAIN)]: inMain, [uri(QUEUE)]: [{ range: span(2, 13, 18), newText: 'Playlist' }] } }));

		expect(await rename(model)).toEqual({ edits: [] });
		expect(server.sent('textDocument/rename')).toEqual([{ textDocument: { uri: uri(MAIN) }, position: { line: 3, character: 7 }, newName: 'playlist' }]);

		// The open file: edited where it can be undone, as one step, and saved since it had no edits of its own.
		expect(model.getValue()).toContain('const playlist = new Queue();');
		expect(model.getValue()).toContain("document.title = playlist.next(repeat !== 'off')!.title;");
		expect(model.history).toEqual(['stop', 'edit', 'stop']);
		expect(await onDisk(MAIN)).toBe(model.getValue());
		expect(explorer.tabs().find((t) => t.path === MAIN)?.dirty).toBe(false);
		// The closed one: its whole new text through write_file.
		expect(w.sent('write_file').map((c) => c.args)).toEqual([
			{ id: HARMONY, path: MAIN, text: model.getValue(), root: HARMONY },
			{ id: HARMONY, path: QUEUE, text: queueBefore.replace('export class Queue', 'export class Playlist'), root: HARMONY },
		]);
		expect(monaco.editor.getModel(monaco.Uri.parse(uri(QUEUE)))).toBeNull();
		expect(w.toasts).toEqual([{ kind: 'success', title: 'Renamed to playlist', message: 'In 2 files, which are in Changes to review.' }]);
	});

	test('an open file that had unsaved edits is edited but not saved, and that is said', async () => {
		native.install('typescript', EVERYTHING);
		const model = await open(MAIN);
		const before = await onDisk(MAIN);
		model.type('// mine\n');
		native.server('typescript').reply('textDocument/rename', () => ({ changes: { [uri(MAIN)]: [{ range: span(0, 3, 7), newText: 'ours' }] } }));

		expect(await rename(model, 'ours')).toEqual({ edits: [] });
		expect(model.getValue().startsWith('// ours\n')).toBe(true);
		expect(writes()).toEqual([]);
		expect(await onDisk(MAIN)).toBe(before);
		expect(explorer.tabs().find((t) => t.path === MAIN)?.dirty).toBe(true);
		expect(w.toasts).toEqual([{ kind: 'success', title: 'Renamed to ours', message: 'In 1 file, which is in Changes to review. src/main.ts had unsaved edits and still has: save to finish.' }]);
	});

	test('everything is checked first: one part that cannot be done and nothing is changed', async () => {
		native.install('typescript', EVERYTHING);
		const model = await open(MAIN);
		const server = native.server('typescript');
		const text = model.getValue();
		const queue = await onDisk(QUEUE);
		const good = { [uri(MAIN)]: inMain, [uri(QUEUE)]: [{ range: span(2, 13, 18), newText: 'Playlist' }] };

		for (const [bad, reason] of [
			[{ changes: { ...good, [uri('src/gone.ts')]: [{ range: span(0, 0, 0), newText: 'x' }] } }, 'It would edit src/gone.ts, which is not there. Nothing was changed.'],
			[{ changes: { ...good, [uri('public/cover.png')]: [{ range: span(0, 0, 0), newText: 'x' }] } }, 'public/cover.png could not be read or edited. Nothing was changed.'],
			[{ changes: { ...good, [uri('src/player/track.ts')]: [{ range: span(400, 0, 0), newText: 'x' }] } }, 'src/player/track.ts could not be read or edited. Nothing was changed.'],
			[{ changes: { ...good, 'file:///etc/hosts': [{ range: span(0, 0, 0), newText: 'x' }] } }, 'It would change hosts, which is outside this checkout. Nothing was changed.'],
			[{ documentChanges: [{ textDocument: { uri: uri(MAIN) }, edits: inMain }, { kind: 'copy', uri: uri(QUEUE) }] }, 'It asks for a kind of change to files that is not known here. Nothing was changed.'],
		] as const) {
			server.reply('textDocument/rename', () => bad);
			expect(await rename(model)).toEqual({ edits: [], rejectReason: reason });
		}
		expect(model.getValue()).toBe(text);
		expect(model.history).toEqual([]);
		expect(await onDisk(QUEUE)).toBe(queue);
		expect(writes()).toEqual([]);
		expect(w.toasts).toEqual([]);
	});

	test('a rename that comes to nothing says why: nothing found, or the server\'s own words', async () => {
		native.install('typescript', EVERYTHING);
		const model = await open(MAIN);
		const server = native.server('typescript');

		expect(await rename(model)).toEqual({ edits: [], rejectReason: 'The language server found nothing to rename here.' });
		server.refuse('textDocument/rename', 'You cannot rename elements that are defined in the standard TypeScript library.');
		expect(await rename(model)).toEqual({ edits: [], rejectReason: 'You cannot rename elements that are defined in the standard TypeScript library.' });
		expect(w.toasts).toEqual([]);
	});

	test('workspace/applyEdit is answered by the same code: files are created, renamed and trashed the way the Files tab does it', async () => {
		native.install('typescript', EVERYTHING);
		await open(MAIN);
		const server = native.server('typescript');
		const track = await onDisk('src/player/track.ts');

		const answer = await applied(
			server,
			{
				documentChanges: [
					{ kind: 'create', uri: uri('moved/deep/track-list.ts') },
					{ textDocument: { uri: uri('moved/deep/track-list.ts'), version: null }, edits: [{ range: span(0, 0, 0), newText: 'export const tracks = [];\n' }] },
					{ kind: 'rename', oldUri: uri('src/player/track.ts'), newUri: uri('src/player/song.ts') },
					{ kind: 'delete', uri: uri('docs/shortcuts.md') },
				],
			},
			'Move to a new file'
		);

		expect(answer).toEqual({ applied: true });
		// Missing folders first, outermost first, then the file.
		expect(w.sent('files_create').map((c) => [c.args.dir, c.args.name, c.args.isDir])).toEqual([
			['', 'moved', true],
			['moved', 'deep', true],
			['moved/deep', 'track-list.ts', false],
		]);
		expect(await onDisk('moved/deep/track-list.ts')).toBe('export const tracks = [];\n');
		expect(w.sent('files_move').map((c) => c.args)).toEqual([{ id: HARMONY, root: HARMONY, paths: ['src/player/track.ts'], to: 'src/player', rename: 'song.ts', onConflict: 'ask' }]);
		expect(await onDisk('src/player/track.ts')).toBeNull();
		expect(await onDisk('src/player/song.ts')).toBe(track);
		expect(w.sent('files_trash').map((c) => c.args.paths)).toEqual([['docs/shortcuts.md']]);
		expect(await onDisk('docs/shortcuts.md')).toBeNull();
		// The editor does not show files coming and going, so it is said.
		expect(w.toasts).toEqual([
			{ kind: 'success', title: 'Move to a new file', message: 'Created moved/deep/track-list.ts. Renamed src/player/track.ts to src/player/song.ts. Moved docs/shortcuts.md to the trash. It is all in Changes to review.' },
		]);
		// The Files tree was read again for what came and went.
		expect(explorer.children().get('')?.map((e) => e.name)).toContain('moved');
	});

	test('the Files tree is read again after an edit that only wrote a file: the server may have made that file itself', async () => {
		native.install('typescript', EVERYTHING);
		const model = await open(MAIN);
		// As typescript-language-server does for "Move to a new file": the file is there, then plain edits to it arrive.
		await addFile('extracted.ts', '');
		expect(explorer.children().get('')?.map((e) => e.name)).not.toContain('extracted.ts');
		native.server('typescript').reply('textDocument/rename', () => ({ changes: { [uri('extracted.ts')]: [{ range: span(0, 0, 0), newText: 'export const moved = 1;\n' }] } }));

		expect(await rename(model)).toEqual({ edits: [] });
		expect(await onDisk('extracted.ts')).toBe('export const moved = 1;\n');
		expect(explorer.children().get('')?.map((e) => e.name)).toContain('extracted.ts');
	});

	test('a step the disk refuses stops the rest, and the answer says to look at Changes for what was done', async () => {
		native.install('typescript', EVERYTHING);
		await open(MAIN);
		const server = native.server('typescript');
		w.on('files_trash', () => {
			throw appError('error', 'The trash is not available');
		});

		const answer = await applied(server, {
			documentChanges: [
				{ kind: 'create', uri: uri('src/first.ts') },
				{ kind: 'delete', uri: uri('docs/shortcuts.md') },
				{ kind: 'create', uri: uri('src/never.ts') },
			],
		});

		expect(answer).toEqual({ applied: false, failureReason: 'It stopped part way: docs/shortcuts.md could not be removed. Look at Changes for what was done.' });
		expect(await onDisk('src/first.ts')).toBe('');
		expect(await onDisk('docs/shortcuts.md')).not.toBeNull();
		expect(await onDisk('src/never.ts')).toBeNull();
	});

	test('an open file that is renamed takes its tab along, and the tab shows what was then written to it', async () => {
		native.install('typescript', EVERYTHING);
		await open(MAIN);
		const old = await open('src/player/track.ts');
		const server = native.server('typescript');

		const answer = await applied(server, {
			documentChanges: [
				{ kind: 'rename', oldUri: uri('src/player/track.ts'), newUri: uri('src/player/song.ts') },
				{ textDocument: { uri: uri('src/player/song.ts'), version: null }, edits: [{ range: span(0, 17, 22), newText: 'Song' }] },
			],
		});

		expect(answer).toEqual({ applied: true });
		expect(old.isDisposed()).toBe(true);
		expect(explorer.tabs().map((t) => t.path)).toEqual([MAIN, 'src/player/song.ts']);
		expect(await onDisk('src/player/song.ts')).toContain('export interface Song {');
		const now = (await explorer.model('src/player/song.ts')) as unknown as FakeModel;
		expect(now.getValue()).toBe(await onDisk('src/player/song.ts'));
		expect(explorer.tabs().find((t) => t.path === 'src/player/song.ts')?.dirty).toBe(false);
	});

	test('nothing is replaced unless the server said overwrite', async () => {
		native.install('typescript', EVERYTHING);
		await open(MAIN);
		const server = native.server('typescript');
		const track = await onDisk('src/player/track.ts');
		const repeat = await onDisk('src/player/repeat.ts');
		const onto = { kind: 'rename', oldUri: uri('src/player/track.ts'), newUri: uri('src/player/repeat.ts') };

		expect(await applied(server, { documentChanges: [{ kind: 'create', uri: uri('src/player/repeat.ts') }] })).toEqual({ applied: false, failureReason: 'It would create src/player/repeat.ts, which already exists. Nothing was changed.' });
		expect(await applied(server, { documentChanges: [onto] })).toEqual({ applied: false, failureReason: 'It would rename src/player/track.ts to src/player/repeat.ts, which already exists. Nothing was changed.' });
		expect(await applied(server, { documentChanges: [{ kind: 'delete', uri: uri('src/nowhere.ts') }] })).toEqual({ applied: false, failureReason: 'It would delete src/nowhere.ts, which is not a file that is there. Nothing was changed.' });
		// Told not to mind, the step is left out and the rest goes ahead.
		expect(await applied(server, { documentChanges: [{ ...onto, options: { ignoreIfExists: true } }, { kind: 'create', uri: uri('src/player/repeat.ts'), options: { ignoreIfExists: true } }, { kind: 'delete', uri: uri('src/nowhere.ts'), options: { ignoreIfNotExists: true } }] })).toEqual({ applied: true });
		expect(w.sent('files_move')).toEqual([]);
		expect(w.sent('files_create')).toEqual([]);
		expect(w.sent('files_trash')).toEqual([]);
		expect(writes()).toEqual([]);
		expect(await onDisk('src/player/repeat.ts')).toBe(repeat);

		expect(await applied(server, { documentChanges: [{ ...onto, options: { overwrite: true } }] })).toEqual({ applied: true });
		expect(w.sent('files_move').map((c) => c.args)).toMatchObject([{ paths: ['src/player/track.ts'], to: 'src/player', rename: 'repeat.ts', onConflict: 'replace' }]);
		expect(await onDisk('src/player/repeat.ts')).toBe(track);
		expect(await onDisk('src/player/track.ts')).toBeNull();
	});

	test('a file with unsaved edits is never renamed, replaced, emptied or deleted', async () => {
		native.install('typescript', EVERYTHING);
		const model = await open(MAIN);
		const server = native.server('typescript');
		model.type('// not saved yet\n');
		const text = model.getValue();

		for (const [change, reason] of [
			[{ kind: 'rename', oldUri: uri(MAIN), newUri: uri('src/start.ts') }, 'It would rename src/main.ts, which has unsaved edits: save it first. Nothing was changed.'],
			[{ kind: 'rename', oldUri: uri('src/player/repeat.ts'), newUri: uri(MAIN), options: { overwrite: true } }, 'It would replace src/main.ts, which has unsaved edits. Nothing was changed.'],
			[{ kind: 'create', uri: uri(MAIN), options: { overwrite: true } }, 'It would empty src/main.ts, which is open in the editor. Nothing was changed.'],
			[{ kind: 'delete', uri: uri(MAIN) }, 'It would delete src/main.ts, which has unsaved edits. Nothing was changed.'],
		] as const) {
			// Something that could be done comes first: it must not be, either.
			expect(await applied(server, { documentChanges: [{ kind: 'create', uri: uri('src/fresh.ts') }, change] })).toEqual({ applied: false, failureReason: reason });
		}
		expect(w.sent('files_move')).toEqual([]);
		expect(w.sent('files_trash')).toEqual([]);
		expect(w.sent('files_create')).toEqual([]);
		expect(writes()).toEqual([]);
		expect(model.isDisposed()).toBe(false);
		expect(model.getValue()).toBe(text);
		expect(explorer.tabs().map((t) => [t.path, t.dirty])).toEqual([[MAIN, true]]);
		expect(w.toasts).toEqual([]);
	});

	test('an edit from a server whose checkout is no longer on screen changes nothing', async () => {
		native.install('typescript', EVERYTHING);
		await open(MAIN);
		const server = native.server('typescript');
		await repos.openRepoTab(CADENCE);
		await flush();

		expect(await applied(server, { changes: { [uri(QUEUE)]: [{ range: span(2, 13, 18), newText: 'Playlist' }] } })).toEqual({ applied: false, failureReason: 'Its checkout is not the one on screen any more, so nothing was changed.' });
		expect(writes()).toEqual([]);
	});

	test('a quick fix is asked for by the server\'s own errors at that place, and applied by the editor command it carries', async () => {
		native.install('typescript', EVERYTHING);
		const model = await open(MAIN);
		const server = native.server('typescript');
		const here = { range: span(3, 6, 11), message: "'queue' is declared but never used.", severity: 2, source: 'ts', code: 6133 };
		server.publish(uri(MAIN), [here, { range: span(10, 2, 4), message: 'Somewhere else', severity: 1 }]);
		const fix = { title: 'Rename to playlist', kind: 'quickfix', isPreferred: true, edit: { changes: { [uri(MAIN)]: inMain, [uri(QUEUE)]: [{ range: span(2, 13, 18), newText: 'Playlist' }] } } };
		server.reply('textDocument/codeAction', () => [fix]);

		const list = (await ask('CodeAction', 'provideCodeActions', model, { startLineNumber: 4, startColumn: 8, endLineNumber: 4, endColumn: 8 }, { trigger: 1, only: 'quickfix' }, token())) as { actions: { command: { id: string; arguments: unknown[] } }[] };
		expect(server.sent('textDocument/codeAction')).toEqual([{ textDocument: { uri: uri(MAIN) }, range: span(3, 7, 7), context: { diagnostics: [here], only: ['quickfix'], triggerKind: 1 } }]);
		// Not the edit itself: Monaco would apply that only to the files it has open.
		expect(list.actions).toEqual([{ title: 'Rename to playlist', kind: 'quickfix', isPreferred: true, command: { id: 'melodic.lsp.applyAction', title: 'Rename to playlist', arguments: [server.key, fix] } }]);

		monaco.fake.run(list.actions[0].command.id, ...list.actions[0].command.arguments);
		await flush();
		expect(model.getValue()).toContain('const playlist = new Queue();');
		expect(writes()).toEqual([MAIN, QUEUE]);
		expect(await onDisk(QUEUE)).toContain('export class Playlist {');
		// Nothing came or went, so nothing needs saying.
		expect(w.toasts).toEqual([]);
	});

	test('the code action provider names the kinds it has, without which Monaco keeps Auto Fix and Organize Imports off', () => {
		for (const language of ['typescript', 'javascript', 'rust', 'python', 'go', 'php', 'csharp']) {
			expect((monaco.fake.metadata('CodeAction', language) as { providedCodeActionKinds: string[] }).providedCodeActionKinds).toEqual(expect.arrayContaining(['quickfix', 'refactor', 'source', 'source.organizeImports', 'source.fixAll']));
		}
	});

	test('a fix whose edit the server leaves for later is resolved first, and its command is then run by the server', async () => {
		native.install('typescript', EVERYTHING);
		await open(MAIN);
		const server = native.server('typescript');
		const lazy = { title: 'Extract to a new file', kind: 'refactor.move', data: { id: 7 } };
		server.reply('codeAction/resolve', () => ({ ...lazy, edit: { documentChanges: [{ kind: 'create', uri: uri('src/extracted.ts') }] }, command: { command: '_typescript.didOrganize', arguments: ['src/extracted.ts'] } }));
		server.clear();

		monaco.fake.run('melodic.lsp.applyAction', server.key, lazy);
		await flush();
		expect(server.sent('codeAction/resolve')).toEqual([lazy]);
		expect(await onDisk('src/extracted.ts')).toBe('');
		expect(server.sent('workspace/executeCommand')).toEqual([{ command: '_typescript.didOrganize', arguments: ['src/extracted.ts'] }]);
		expect(asked(server)).toEqual(['codeAction/resolve', 'workspace/executeCommand']);
		expect(w.toasts).toEqual([{ kind: 'success', title: 'Extract to a new file', message: 'Created src/extracted.ts. It is all in Changes to review.' }]);
	});

	test('a fix that cannot be applied changes nothing, says why, and its command is not run', async () => {
		native.install('typescript', EVERYTHING);
		await open(MAIN);
		const server = native.server('typescript');
		server.clear();

		monaco.fake.run('melodic.lsp.applyAction', server.key, { title: 'Fix it', edit: { changes: { [uri('src/gone.ts')]: [{ range: span(0, 0, 0), newText: 'x' }] } }, command: { command: 'never' } });
		await flush();
		expect(w.toasts).toEqual([{ kind: 'warning', title: '"Fix it" was not applied', message: 'It would edit src/gone.ts, which is not there. Nothing was changed.' }]);
		expect(asked(server)).toEqual([]);
		expect(writes()).toEqual([]);
	});

	test('a server that does not resolve fixes is not asked to, and a fix for a server that is gone does nothing', async () => {
		native.install('typescript', { textDocumentSync: 2, codeActionProvider: true });
		await open(MAIN);
		const server = native.server('typescript');
		server.clear();

		monaco.fake.run('melodic.lsp.applyAction', server.key, { title: 'Nothing to it' });
		await flush();
		expect(asked(server)).toEqual([]);

		server.die('gone');
		monaco.fake.run('melodic.lsp.applyAction', server.key, { title: 'Too late', edit: { documentChanges: [{ kind: 'create', uri: uri('src/late.ts') }] } });
		await flush();
		expect(await onDisk('src/late.ts')).toBeNull();
	});
});

describe('completion', () => {
	const complete = (model: FakeModel, line: number, column: number, context: { triggerKind: number; triggerCharacter?: string }): Promise<unknown> =>
		ask('CompletionItem', 'provideCompletionItems', model, at(line, column), context, token());

	test('a typed character opens completion only when it is one of the answering server\'s own', async () => {
		native.install('typescript', { textDocumentSync: 2, completionProvider: { triggerCharacters: ['.', '"'] } });
		native.install('php', { textDocumentSync: 2, completionProvider: { triggerCharacters: ['$', '>'] } });
		await addFile('web/index.php', '<?php\n$queue = 1;\n');
		const ts = await open('src/main.ts');
		const php = await open('web/index.php');
		const tsServer = native.server('typescript');
		const phpServer = native.server('php');
		tsServer.reply('textDocument/completion', () => ({ isIncomplete: false, items: [{ label: 'next' }] }));
		phpServer.reply('textDocument/completion', () => [{ label: '$queue' }]);

		// Monaco wants the list when the provider is registered, before any server has said its own: every language gets everyone's.
		for (const language of ['typescript', 'php']) {
			expect(monaco.fake.provider('CompletionItem', language)?.triggerCharacters).toEqual(expect.arrayContaining(['.', '"', '$', '>']));
		}

		expect(await complete(ts, 1, 1, { triggerKind: 1, triggerCharacter: '$' })).toBeNull();
		expect(await complete(php, 2, 1, { triggerKind: 1, triggerCharacter: '.' })).toBeNull();
		expect(asked(tsServer)).not.toContain('textDocument/completion');
		expect(asked(phpServer)).not.toContain('textDocument/completion');

		expect(await complete(ts, 1, 1, { triggerKind: 1, triggerCharacter: '.' })).toMatchObject({ suggestions: [{ label: 'next' }] });
		expect(await complete(php, 2, 1, { triggerKind: 1, triggerCharacter: '$' })).toMatchObject({ suggestions: [{ label: '$queue' }] });
		// Asked for (Ctrl+Space) it goes to whichever server answers, with no character.
		expect(await complete(ts, 1, 1, { triggerKind: 0 })).toMatchObject({ suggestions: [{ label: 'next' }] });
		// The protocol counts trigger kinds from 1, Monaco from 0.
		expect(tsServer.sent('textDocument/completion')).toEqual([
			{ textDocument: { uri: uri('src/main.ts') }, position: { line: 0, character: 0 }, context: { triggerKind: 2, triggerCharacter: '.' } },
			{ textDocument: { uri: uri('src/main.ts') }, position: { line: 0, character: 0 }, context: { triggerKind: 1 } },
		]);
	});

	test('a suggestion goes over the word being typed, and keeps a command only when it is one of the editor\'s own', async () => {
		native.install('typescript', { textDocumentSync: 2, completionProvider: {} });
		const model = await open('src/main.ts');
		// A server with nothing to suggest leaves the list to others.
		expect(await complete(model, 4, 9, { triggerKind: 0 })).toBeNull();
		native.server('typescript').reply('textDocument/completion', () => [
			{ label: 'queue.', command: { command: 'editor.action.triggerSuggest', title: 'Suggest' } },
			{ label: 'next()', command: { command: 'editor.action.triggerParameterHints', title: 'Hints' } },
			{ label: 'Queue', command: { command: '_typescript.applyCompletionCodeAction', title: '', arguments: ['src/main.ts'] } },
		]);

		// Line 4 is `const queue = new Queue();`, the cursor after `qu`.
		const list = (await complete(model, 4, 9, { triggerKind: 0 })) as { suggestions: Record<string, unknown>[] };
		const range = { insert: { startLineNumber: 4, startColumn: 7, endLineNumber: 4, endColumn: 9 }, replace: { startLineNumber: 4, startColumn: 7, endLineNumber: 4, endColumn: 12 } };
		expect(list.suggestions.map((s) => [s.label, s.insertText, s.range, s.command])).toEqual([
			['queue.', 'queue.', range, { id: 'editor.action.triggerSuggest', title: 'Suggest' }],
			['next()', 'next()', range, { id: 'editor.action.triggerParameterHints', title: 'Hints' }],
			['Queue', 'Queue', range, undefined],
		]);
	});

	test('a suggestion looked at is resolved by the server it came from, when that server resolves', async () => {
		native.install('typescript', { textDocumentSync: 2, completionProvider: { resolveProvider: true } });
		native.install('rust', { textDocumentSync: 2, completionProvider: {} });
		await addFile('native/lib.rs', 'fn main() {}\n');
		const ts = await open('src/main.ts');
		const rs = await open('native/lib.rs');
		const tsServer = native.server('typescript');
		const rsServer = native.server('rust');
		tsServer.reply('textDocument/completion', () => [{ label: 'nextRepeatMode', data: { n: 7 } }]);
		rsServer.reply('textDocument/completion', () => [{ label: 'println!' }]);
		tsServer.reply('completionItem/resolve', (item: object) => ({ ...item, detail: 'function nextRepeatMode(mode: RepeatMode): RepeatMode', documentation: { kind: 'markdown', value: 'The mode **after** this one.' }, additionalTextEdits: [{ range: span(0, 0, 0), newText: "import { nextRepeatMode } from './player/repeat';\n" }] }));

		const [first] = ((await complete(ts, 1, 1, { triggerKind: 0 })) as { suggestions: object[] }).suggestions;
		const full = await monaco.fake.ask('CompletionItem', 'typescript', 'resolveCompletionItem', first, token());
		// It wants its own item back.
		expect(tsServer.sent('completionItem/resolve')).toEqual([{ label: 'nextRepeatMode', data: { n: 7 } }]);
		expect(full).toMatchObject({
			label: 'nextRepeatMode',
			detail: 'function nextRepeatMode(mode: RepeatMode): RepeatMode',
			documentation: { value: 'The mode **after** this one.' },
			additionalTextEdits: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "import { nextRepeatMode } from './player/repeat';\n" }],
		});

		const [plain] = ((await complete(rs, 1, 1, { triggerKind: 0 })) as { suggestions: object[] }).suggestions;
		expect(await monaco.fake.ask('CompletionItem', 'rust', 'resolveCompletionItem', plain, token())).toBe(plain);
		expect(asked(rsServer)).toEqual(['textDocument/completion']);
	});
});

describe('rename at the cursor', () => {
	const renameAt = (model: FakeModel, line: number, column: number): Promise<unknown> => ask('Rename', 'resolveRenameLocation', model, at(line, column), token());

	test('a server that answers for the language but does not rename says so at the cursor: intelephense with its own reason', async () => {
		native.install('php', { textDocumentSync: 2, renameProvider: false });
		native.install('python', { textDocumentSync: 2 });
		await addFile('web/index.php', '<?php\nfunction greet() {}\ngreet();\n');
		await addFile('tools/gen.py', 'def greet():\n    pass\n');
		const php = await open('web/index.php');
		const py = await open('tools/gen.py');
		const licence = 'Intelephense renames only with a licence key (intelephense.com); without one it cannot rename.';

		expect(await renameAt(php, 2, 12)).toEqual({ range: { startLineNumber: 2, startColumn: 10, endLineNumber: 2, endColumn: 15 }, text: 'greet', rejectReason: licence });
		expect(await ask('Rename', 'provideRenameEdits', php, at(2, 12), 'welcome', token())).toEqual({ edits: [], rejectReason: licence });
		expect(await renameAt(py, 1, 6)).toMatchObject({ text: 'greet', rejectReason: "Python's language server does not rename." });
		expect(asked(native.server('php'))).toEqual([]);
		expect(asked(native.server('python'))).toEqual([]);
		expect(w.toasts).toEqual([]);
	});

	test('where a rename starts is the server\'s to say when it can, the word under the cursor when it cannot', async () => {
		native.install('typescript', { textDocumentSync: 2, renameProvider: { prepareProvider: true } });
		native.install('rust', { textDocumentSync: 2, renameProvider: true });
		await addFile('native/lib.rs', 'fn main() {}\n');
		const ts = await open('src/main.ts');
		const rs = await open('native/lib.rs');
		const server = native.server('typescript');
		const word = { range: { startLineNumber: 4, startColumn: 7, endLineNumber: 4, endColumn: 12 }, text: 'queue' };

		server.reply('textDocument/prepareRename', () => ({ range: span(3, 6, 11), placeholder: 'theQueue' }));
		expect(await renameAt(ts, 4, 8)).toEqual({ range: word.range, text: 'theQueue' });
		expect(server.sent('textDocument/prepareRename')).toEqual([{ textDocument: { uri: uri('src/main.ts') }, position: { line: 3, character: 7 } }]);
		// A bare range: the text is what the file has there.
		server.reply('textDocument/prepareRename', () => span(3, 6, 11));
		expect(await renameAt(ts, 4, 8)).toEqual(word);
		server.reply('textDocument/prepareRename', () => ({ defaultBehavior: true }));
		expect(await renameAt(ts, 4, 8)).toEqual(word);
		server.reply('textDocument/prepareRename', () => null);
		expect(await renameAt(ts, 4, 8)).toEqual({ ...word, rejectReason: 'This cannot be renamed.' });

		expect(await renameAt(rs, 1, 5)).toEqual({ range: { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 8 }, text: 'main' });
		expect(asked(native.server('rust'))).toEqual([]);
	});
});

describe('what a server says it is busy with', () => {
	test('$/progress becomes the work of its checkout, and is gone when the work ends', async () => {
		native.install('rust', { textDocumentSync: 2 });
		await addFile('native/lib.rs', 'fn main() {}\n');
		await open('native/lib.rs');
		const server = native.server('rust');

		server.progress('rustAnalyzer/Indexing', { kind: 'begin', title: 'Indexing', percentage: 0 });
		expect(lsp.working()).toEqual({ [`${server.key}|rustAnalyzer/Indexing`]: { root: HARMONY, label: 'Rust', title: 'Indexing', message: '', percentage: 0 } });
		server.progress('rustAnalyzer/Indexing', { kind: 'report', message: '12/40 (core)', percentage: 30 });
		server.progress(7, { kind: 'begin', title: 'cargo check' });
		expect(lsp.busy()).toEqual([
			{ root: HARMONY, label: 'Rust', title: 'Indexing', message: '12/40 (core)', percentage: 30 },
			{ root: HARMONY, label: 'Rust', title: 'cargo check', message: '', percentage: null },
		]);
		// A report that says nothing new keeps what was there.
		server.progress('rustAnalyzer/Indexing', { kind: 'report' });
		expect(lsp.busy()[0]).toMatchObject({ message: '12/40 (core)', percentage: 30 });
		// Not about work in progress.
		server.progress('rustAnalyzer/Indexing', { kind: 'partial' });
		server.notify('$/progress', { value: { kind: 'begin', title: 'No token' } });
		expect(lsp.busy().length).toBe(2);

		await repos.openRepoTab(CADENCE);
		await flush();
		expect(lsp.busy()).toEqual([]);
		expect(lsp.workAt(HARMONY).map((work) => work.title)).toEqual(['Indexing', 'cargo check']);

		server.progress('rustAnalyzer/Indexing', { kind: 'end' });
		server.progress(7, { kind: 'end' });
		expect(lsp.working()).toEqual({});
	});

	test('inlay hints are asked for again when a server comes up, finishes work, or says they changed', async () => {
		let stale = 0;
		(monaco.fake.provider('InlayHints', 'typescript')!.onDidChangeInlayHints as (listener: () => void) => unknown)(() => stale++);
		native.install('typescript', EVERYTHING);
		await open('src/main.ts');
		const server = native.server('typescript');

		// The editor asked when the file was shown, before the server had read the project.
		await vi.advanceTimersByTimeAsync(400);
		expect(stale).toBe(1);

		server.progress('load', { kind: 'begin', title: 'Loading' });
		await vi.advanceTimersByTimeAsync(1000);
		expect(stale).toBe(1);
		server.progress('load', { kind: 'end' });
		await vi.advanceTimersByTimeAsync(399);
		expect(stale).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(stale).toBe(2);

		const id = server.ask('workspace/inlayHint/refresh', null);
		await vi.advanceTimersByTimeAsync(400);
		expect(server.answer(id)).toBeNull();
		expect(stale).toBe(3);
	});
});

describe('files that change on disk without the editor', () => {
	const WATCHED = 'workspace/didChangeWatchedFiles';
	/** The server asks to be told, as gopls, intelephense and csharp-ls do once the handshake is over. */
	async function register(server: FakeServer): Promise<void> {
		const id = server.ask('client/registerCapability', { registrations: [{ id: 'watch', method: WATCHED, registerOptions: { watchers: [{ globPattern: '**/*' }] } }] });
		await flush();
		expect(server.answer(id)).toBeNull();
		server.clear();
	}
	/** The next read of the status says this. */
	async function statusBecomes(change: Record<string, unknown>): Promise<void> {
		const status = repos.status()!;
		w.on('repo_status', () => ({ ...status, ...change }));
		await repos.refresh();
		await flush();
	}
	const untracked = (path: string) => ({ path, oldPath: null, status: 'untracked' });

	test.each([
		['go', 'cmd/main.go'],
		['php', 'web/index.php'],
		['csharp', 'App/Program.cs'],
	])('%s, which learns of files changing only from the client, is offered to be told', async (name, path) => {
		native.install(name, { textDocumentSync: 2 });
		await addFile(path, '\n');
		await open(path);
		expect(native.server(name).sent<{ capabilities: { workspace: Record<string, unknown> } }>('initialize')[0].capabilities.workspace.didChangeWatchedFiles).toEqual({ dynamicRegistration: true });
	});

	test.each([
		['typescript', 'src/main.ts'],
		['rust', 'native/lib.rs'],
		['python', 'tools/gen.py'],
	])('%s, which watches the disk itself and would stop if offered, is not', async (name, path) => {
		native.install(name, { textDocumentSync: 2 });
		if (path !== 'src/main.ts') {
			await addFile(path, '\n');
		}
		await open(path);
		expect(native.server(name).sent<{ capabilities: { workspace: Record<string, unknown> } }>('initialize')[0].capabilities.workspace).not.toHaveProperty('didChangeWatchedFiles');
	});

	test('a server that asked is told what differs between two reads of the status, and is sent each open document again', async () => {
		native.install('php', { textDocumentSync: 2 });
		await addFile('web/index.php', '<?php\n');
		const model = await open('web/index.php');
		const server = native.server('php');
		await register(server);
		const files = repos.status()!.files;

		await statusBecomes({ files: [...files, untracked('web/new.php')] });
		expect(server.sent(WATCHED)).toEqual([{ changes: [{ uri: uri('web/new.php'), type: 1 }] }]);
		// csharp-ls looks at an open document again only when that is edited: each goes once more, whole.
		expect(server.sent('textDocument/didChange')).toEqual([{ textDocument: { uri: uri('web/index.php'), version: 2 }, contentChanges: [{ text: model.getValue() }] }]);

		// The same status again is no news.
		await statusBecomes({ files: [...files, untracked('web/new.php')] });
		expect(server.sent(WATCHED).length).toBe(1);

		// Gone again: deleted.
		await statusBecomes({ files });
		expect(server.sent(WATCHED).at(-1)).toEqual({ changes: [{ uri: uri('web/new.php'), type: 3 }] });

		const id = server.ask('client/unregisterCapability', { unregisterations: [{ id: 'watch', method: WATCHED }] });
		await flush();
		expect(server.answer(id)).toBeNull();
		await statusBecomes({ files: [...files, untracked('web/other.php')] });
		expect(server.sent(WATCHED).length).toBe(2);
	});

	test('after another commit was checked out it is told everything that differs from the earlier one', async () => {
		native.install('go', { textDocumentSync: 2 });
		await addFile('cmd/main.go', 'package main\n');
		await open('cmd/main.go');
		const server = native.server('go');
		await register(server);
		const before = repos.status()!.head;
		w.on('worktree_diff', () => ({
			base: before,
			head: 'b'.repeat(40),
			tooLarge: false,
			files: [
				{ path: 'cmd/main.go', oldPath: null, status: 'modified' },
				{ path: 'cmd/serve.go', oldPath: 'cmd/run.go', status: 'renamed' },
				{ path: 'cmd/old.go', oldPath: null, status: 'deleted' },
				{ path: 'cmd/new.go', oldPath: null, status: 'added' },
			],
		}));

		await statusBecomes({ head: 'b'.repeat(40), files: [] });
		expect(w.sent('worktree_diff').at(-1)?.args).toEqual({ id: HARMONY, path: HARMONY, base: before });
		expect(server.sent(WATCHED)).toEqual([
			{
				changes: [
					{ uri: uri('cmd/main.go'), type: 2 },
					{ uri: uri('cmd/run.go'), type: 3 },
					{ uri: uri('cmd/serve.go'), type: 1 },
					{ uri: uri('cmd/old.go'), type: 3 },
					{ uri: uri('cmd/new.go'), type: 1 },
				],
			},
		]);
	});

	test('a server that did not ask is told nothing, whether it was offered or not', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.install('csharp', { textDocumentSync: 2 });
		await addFile('App/Program.cs', 'class Program {}\n');
		await open('src/main.ts');
		await open('App/Program.cs');
		native.server('typescript').clear();
		native.server('csharp').clear();

		await statusBecomes({ files: [...repos.status()!.files, untracked('App/New.cs'), untracked('src/new.ts')] });
		lsp.changed(HARMONY, [{ path: 'App/Other.cs', type: 1 }]);
		await flush();
		expect(native.server('typescript').methods()).toEqual([]);
		expect(native.server('csharp').methods()).toEqual([]);
	});

	test('what an agent\'s turn changed is passed on to the servers of that checkout that asked', async () => {
		native.install('csharp', { textDocumentSync: 2 });
		await addFile('App/Program.cs', 'class Program {}\n');
		await open('App/Program.cs');
		const server = native.server('csharp');
		await register(server);

		lsp.changed(`${HARMONY}.worktrees/agent`, [{ path: 'App/Elsewhere.cs', type: 1 }]);
		lsp.changed(HARMONY, []);
		await flush();
		expect(server.methods()).toEqual([]);

		lsp.changed(HARMONY, [
			{ path: 'App/Player.cs', type: 1 },
			{ path: 'App/Program.cs', type: 2 },
			{ path: 'App/Old.cs', type: 3 },
		]);
		await flush();
		expect(server.sent(WATCHED)).toEqual([
			{
				changes: [
					{ uri: uri('App/Player.cs'), type: 1 },
					{ uri: uri('App/Program.cs'), type: 2 },
					{ uri: uri('App/Old.cs'), type: 3 },
				],
			},
		]);
	});

	test('what a server\'s own edit wrote on disk is told to it as well', async () => {
		native.install('php', { textDocumentSync: 2, renameProvider: true });
		await addFile('web/index.php', '<?php\ngreet();\n');
		await addFile('web/lib.php', '<?php\nfunction greet() {}\n');
		const model = await open('web/index.php');
		const server = native.server('php');
		await register(server);
		server.reply('textDocument/rename', () => ({ changes: { [uri('web/lib.php')]: [{ range: span(1, 9, 14), newText: 'welcome' }] } }));

		await ask('Rename', 'provideRenameEdits', model, at(2, 2), 'welcome', token());
		await flush();
		expect(await onDisk('web/lib.php')).toBe('<?php\nfunction welcome() {}\n');
		expect(server.sent(WATCHED)).toEqual([{ changes: [{ uri: uri('web/lib.php'), type: 2 }] }]);
	});
});

describe('saving', () => {
	test('a save is told to a server that wants to hear of it, after the edits it has not seen, and with the text only if it asked', async () => {
		native.install('rust', { textDocumentSync: { openClose: true, change: 2, save: {} } });
		native.install('go', { textDocumentSync: { openClose: true, change: 2, save: { includeText: true } } });
		native.install('php', { textDocumentSync: 2 });
		native.install('typescript', { textDocumentSync: { openClose: true, change: 2 } });
		await addFile('native/lib.rs', 'fn main() {}\n');
		await addFile('cmd/main.go', 'package main\n');
		await addFile('web/index.php', '<?php\n');

		const told: Record<string, [string, unknown][]> = {};
		for (const [name, path] of [
			['rust', 'native/lib.rs'],
			['go', 'cmd/main.go'],
			['php', 'web/index.php'],
			['typescript', 'src/main.ts'],
		]) {
			const model = await open(path);
			const server = native.server(name);
			server.clear();
			model.type('// edited\n');
			expect(await explorer.save(path)).toBe(true);
			await flush();
			told[name] = server.received.map((m) => [m.method ?? '', m.method === 'textDocument/didSave' ? m.params : null]);
		}

		// rust-analyzer only runs `cargo check`, and so only reports type errors, on a save.
		expect(told.rust).toEqual([
			['textDocument/didChange', null],
			['textDocument/didSave', { textDocument: { uri: uri('native/lib.rs') } }],
		]);
		expect(told.go).toEqual([
			['textDocument/didChange', null],
			['textDocument/didSave', { textDocument: { uri: uri('cmd/main.go') }, text: '// edited\npackage main\n' }],
		]);
		// The short form of textDocumentSync: a server that follows documents follows their saves.
		expect(told.php).toEqual([
			['textDocument/didChange', null],
			['textDocument/didSave', { textDocument: { uri: uri('web/index.php') } }],
		]);
		// One that did not ask hears nothing of the save; the edit follows on its own timer.
		expect(told.typescript).toEqual([]);
		await vi.advanceTimersByTimeAsync(300);
		expect(native.server('typescript').methods()).toEqual(['textDocument/didChange']);
	});
});

describe('going to another file', () => {
	test('a definition in another file of the checkout is opened in the Files tab, with the cursor put there', async () => {
		const opener = monaco.editor.openers[0];
		let showing: FakeModel | null = null;
		const went: unknown[] = [];
		const editor = { getModel: () => showing, setPosition: (position: unknown) => void went.push(position), revealPositionInCenter: () => undefined, focus: () => void went.push('focus') };

		expect(opener.openCodeEditor(editor, monaco.Uri.parse(uri('src/player/queue.ts')), { startLineNumber: 8, startColumn: 2, endLineNumber: 8, endColumn: 6 })).toBe(true);
		await flush();
		expect(explorer.active()).toBe('src/player/queue.ts');
		// A file opened this way is there to stay, not a preview the next click replaces.
		expect(explorer.preview()).toBeNull();

		showing = (await explorer.model('src/player/queue.ts')) as unknown as FakeModel;
		await vi.advanceTimersByTimeAsync(50);
		expect(went).toEqual([{ lineNumber: 8, column: 2 }, 'focus']);
	});

	test('a file outside the checkout is not the Files tab\'s to open', () => {
		const editor = { getModel: () => null, setPosition: () => undefined, revealPositionInCenter: () => undefined, focus: () => undefined };
		expect(monaco.editor.openers[0].openCodeEditor(editor, monaco.Uri.parse('file:///usr/lib/typescript/lib.es5.d.ts'))).toBe(false);
		expect(explorer.tabs()).toEqual([]);
	});
});

describe('checking a change the editor does not have open', () => {
	/** An agent's worktree: not the checkout on screen. */
	const TREE = `${HARMONY}.worktrees/agent-fix`;
	const BASE = 'c0ffee1';
	const there = (path: string): string => uri(path, TREE);
	const modified = (path: string, diff = ''): CheckedFile => ({ path, oldPath: null, status: 'modified', diff });
	const NOTHING: CheckResult = { problems: [], known: 0, impact: [], servers: [], files: 0, users: 0, finished: true };

	/** A function that gains a parameter, and a file that calls it the old way. */
	const GREET_WAS = 'export function greet(name: string): string {\n\treturn `Hello ${name}`;\n}\n';
	const GREET_NOW = 'export function greet(name: string, title: string): string { // !! Missing return on some paths.\n\treturn `Hello ${title} ${name}`;\n}\n';
	const CALLER = "import { greet } from './greet';\n\ngreet('Rick');\n";
	const GREET_DIFF = ['@@ -1,3 +1,3 @@', '-export function greet(name: string): string {', '-\treturn `Hello ${name}`;', '+export function greet(name: string, title: string): string { // !! Missing return on some paths.', '+\treturn `Hello ${title} ${name}`;', ' }', ''].join('\n');

	/** The files of the checkout being checked: as they were at the commit the change started from, and as they are on disk. */
	function tree(files: Record<string, { was?: string; now?: string }>): void {
		w.on('worktree_read', (args) => {
			const text = files[String(args.file)]?.[args.rev ? 'was' : 'now'];
			if (text === undefined) {
				throw appError('error', `${String(args.file)} no longer exists`);
			}
			return { text, binary: false, tooLarge: false, size: text.length };
		});
	}

	/**
	 * Makes a server report on what it is shown, as a compiler would: an error for every line that
	 * ends in `!! <message>`, on every file it has open, each time one is opened or changed. `also`
	 * adds errors that depend on other files (a caller broken by a changed signature).
	 */
	function compiles(server: FakeServer, how: { source?: string; also?: (texts: Map<string, string>) => Record<string, string[]>; silentOnChange?: boolean } = {}): void {
		const texts = new Map<string, string>();
		const source = how.source ?? 'ts';
		const report = (): void => {
			const more = how.also?.(texts) ?? {};
			for (const [address, text] of texts) {
				const own = text.split('\n').flatMap((line, n) => {
					const found = /!! (.+)$/.exec(line);
					return found ? [{ range: span(n, 0, line.length), message: found[1], severity: 1, source }] : [];
				});
				server.publish(address, [...own, ...(more[address] ?? []).map((message) => ({ range: span(0, 0, 1), message, severity: 1, source }))]);
			}
		};
		server.on('textDocument/didOpen', (p: { textDocument: { uri: string; text: string } }) => {
			texts.set(p.textDocument.uri, p.textDocument.text);
			report();
		});
		server.on('textDocument/didChange', (p: { textDocument: { uri: string }; contentChanges: { text: string }[] }) => {
			texts.set(p.textDocument.uri, p.contentChanges[p.contentChanges.length - 1].text);
			if (!how.silentOnChange) {
				report();
			}
		});
		server.on('textDocument/didClose', (p: { textDocument: { uri: string } }) => void texts.delete(p.textDocument.uri));
	}

	/** What a server was shown of the files, in order: what happened, to which file, with what text. */
	function shown(server: FakeServer, root = TREE): [string, string, string?][] {
		const out: [string, string, string?][] = [];
		for (const message of server.received) {
			const p = message.params as { textDocument: { uri: string; text?: string }; contentChanges?: { text: string }[] };
			const path = p?.textDocument?.uri?.slice(`file://${root}/`.length);
			if (message.method === 'textDocument/didOpen') {
				out.push(['opened', path, p.textDocument.text]);
			} else if (message.method === 'textDocument/didChange') {
				out.push(['changed', path, p.contentChanges?.[0].text]);
			} else if (message.method === 'textDocument/didClose') {
				out.push(['closed', path]);
			}
		}
		return out;
	}

	/**
	 * The same without the closes, for a server that the check stops when it is done: one that is
	 * being stopped is not there to be told, so whether a close still reaches it says nothing.
	 */
	const shownBeforeItWent = (server: FakeServer): [string, string, string?][] => shown(server).filter(([what]) => what !== 'closed');

	/** Run a check to its end, giving the servers all the time they could want. */
	async function check(files: CheckedFile[], root = TREE): Promise<CheckResult> {
		const result = lsp.check(HARMONY, root, files, BASE);
		await vi.advanceTimersByTimeAsync(20_000);
		return result;
	}

	/** Start a check and say where it has got to: null until it is done. */
	function checking(files: CheckedFile[]): () => CheckResult | null {
		let result: CheckResult | null = null;
		void lsp.check(HARMONY, TREE, files, BASE).then((done) => (result = done));
		return () => result;
	}

	test('the files are shown as they were, then as they are; errors only the new text has are the change\'s own, the rest are counted', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => compiles(server));
		const was = 'const a = 1;\nlet b: number = "x"; // !! Type string is not assignable to type number.\n';
		const now = `import "./gone"; // !! Cannot find module ./gone.\n\n${was}`;
		tree({ 'src/a.ts': { was, now } });

		const result = await check([modified('src/a.ts')]);

		expect(result).toEqual({
			problems: [{ path: 'src/a.ts', line: 1, column: 1, message: 'Cannot find module ./gone.', source: 'ts', changed: true }],
			// The same message on the same line of code, wherever it moved to, was there before.
			known: 1,
			impact: [],
			servers: ['TypeScript and JavaScript'],
			files: 1,
			users: 0,
			finished: true,
		});
		// The server runs in the agent's checkout, and reads were of that checkout: at the base, then from disk.
		expect(w.sent('lsp_start').map((c) => c.args)).toEqual([{ id: HARMONY, language: 'typescript', cwd: TREE }]);
		expect(w.sent('worktree_read').map((c) => c.args)).toEqual([
			{ id: HARMONY, path: TREE, file: 'src/a.ts', rev: BASE },
			{ id: HARMONY, path: TREE, file: 'src/a.ts' },
		]);
		const server = native.started[0];
		expect(server.root).toBe(TREE);
		// There were errors, so the old text went back once more to see which of them it had.
		expect(shownBeforeItWent(server)).toEqual([
			['opened', 'src/a.ts', was],
			['changed', 'src/a.ts', now],
			['changed', 'src/a.ts', was],
		]);
		// Started for this alone, in a checkout nobody is looking at.
		expect(w.sent('lsp_stop').map((c) => c.args.key)).toEqual([server.key]);
		expect(lsp.running()).toEqual([]);
		expect(lsp.failures()).toEqual({});
	});

	test('a change that brings no errors is done after one wait: reported on and quiet for 1.2 s, with no second look at the old files', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => compiles(server));
		tree({ 'src/a.ts': { was: 'const a = 1;\n', now: 'const a = 2;\n' } });

		const result = checking([modified('src/a.ts')]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(result()).toBeNull();
		await vi.advanceTimersByTimeAsync(400);
		expect(result()).toEqual({ ...NOTHING, servers: ['TypeScript and JavaScript'], files: 1 });
		expect(shownBeforeItWent(native.started[0])).toEqual([
			['opened', 'src/a.ts', 'const a = 1;\n'],
			['changed', 'src/a.ts', 'const a = 2;\n'],
		]);
	});

	test('a server with nothing new to say of a file counts as done 3 s after it has answered a question sent behind the edits', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => {
			compiles(server, { silentOnChange: true });
			// Still loading the project: its first answer takes a while, so the swap comes later than its report.
			server.hold('textDocument/documentSymbol');
		});
		tree({ 'src/a.ts': { was: 'const a = 1;\n', now: 'const a = 1; \n' } });

		const result = checking([modified('src/a.ts')]);
		await vi.advanceTimersByTimeAsync(500);
		native.started[0].release('textDocument/documentSymbol');
		await vi.advanceTimersByTimeAsync(2800);
		expect(result()).toBeNull();
		await vi.advanceTimersByTimeAsync(400);
		expect(result()).toMatchObject({ problems: [], known: 0, files: 1, finished: true });
	});

	test('a server is never taken for done while it reports work in progress', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => {
			compiles(server);
			server.on('textDocument/didChange', () => server.progress('check', { kind: 'begin', title: 'Checking' }));
		});
		tree({ 'src/a.ts': { was: 'const a = 1;\n', now: 'const a = 2;\n' } });

		const result = checking([modified('src/a.ts')]);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(result()).toBeNull();
		expect(lsp.workAt(TREE)).toEqual([{ root: TREE, label: 'TypeScript and JavaScript', title: 'Checking', message: '', percentage: null }]);

		native.started[0].progress('check', { kind: 'end' });
		await vi.advanceTimersByTimeAsync(400);
		expect(result()).toMatchObject({ problems: [], files: 1, finished: true });
	});

	test('a server that never goes quiet is given up on after a minute, and the result says there may be more', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => {
			compiles(server);
			server.on('textDocument/didChange', (p: { textDocument: { uri: string } }) => void setInterval(() => server.publish(p.textDocument.uri, []), 500));
		});
		tree({ 'src/a.ts': { was: 'const a = 1;\n', now: 'const a = 2;\n' } });

		const result = checking([modified('src/a.ts')]);
		await vi.advanceTimersByTimeAsync(59_000);
		expect(result()).toBeNull();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(result()).toEqual({ ...NOTHING, servers: ['TypeScript and JavaScript'], files: 1, finished: false });
		// Given up on or not, the server started for it goes.
		expect(w.sent('lsp_stop').map((c) => c.args.key)).toEqual([native.started[0].key]);
	});

	test('a server that reports work without end is given five minutes in all', async () => {
		native.install('rust', { textDocumentSync: 2 });
		native.starting.push((server) => {
			compiles(server, { source: 'rustc' });
			server.on('textDocument/didChange', () => server.progress('cargo', { kind: 'begin', title: 'cargo check' }));
		});
		tree({ 'src/lib.rs': { was: 'fn a() {}\n', now: 'fn b() {}\n' } });

		const result = checking([modified('src/lib.rs')]);
		await vi.advanceTimersByTimeAsync(299_000);
		expect(result()).toBeNull();
		await vi.advanceTimersByTimeAsync(2_000);
		expect(result()).toMatchObject({ servers: ['Rust'], files: 1, finished: false });
	});

	test('errors from a build of the disk (rust-analyzer\'s cargo check) have no before: the files are saved, and every error counts as new', async () => {
		native.install('rust', { textDocumentSync: { openClose: true, change: 2, save: {} } });
		native.starting.push((server) => compiles(server, { source: 'rustc' }));
		const was = 'fn a() -> u8 { "x" } // !! mismatched types\n';
		const now = `${was}fn b() {}\n`;
		tree({ 'src/lib.rs': { was, now } });

		const result = await check([modified('src/lib.rs')]);

		expect(result).toEqual({ ...NOTHING, problems: [{ path: 'src/lib.rs', line: 1, column: 1, message: 'mismatched types', source: 'rustc', changed: true }], servers: ['Rust'], files: 1 });
		const server = native.started[0];
		// The old text is not shown again: what cargo says is about the disk, whatever the server is shown.
		expect(shownBeforeItWent(server)).toEqual([
			['opened', 'src/lib.rs', was],
			['changed', 'src/lib.rs', now],
		]);
		// The check only runs on a save.
		expect(server.sent('textDocument/didSave')).toEqual([{ textDocument: { uri: there('src/lib.rs') } }]);
		expect(server.methods().indexOf('textDocument/didSave')).toBeGreaterThan(server.methods().indexOf('textDocument/didChange'));
	});

	test('what the change touched is looked up where it is used: those files are opened too, and a caller it broke is listed', async () => {
		native.install('typescript', { textDocumentSync: 2, documentSymbolProvider: true, referencesProvider: true });
		const [was, now, caller, diff] = [GREET_WAS, GREET_NOW, CALLER, GREET_DIFF];
		tree({ 'src/greet.ts': { was, now }, 'src/app.ts': { now: caller } });
		native.starting.push((server) => {
			// The caller is wrong exactly while greet takes two arguments.
			compiles(server, { also: (texts) => (texts.get(uri('src/greet.ts'))?.includes('title: string') && texts.has(uri('src/app.ts')) ? { [uri('src/app.ts')]: ['Expected 2 arguments, but got 1.'] } : {}) });
			server.reply('textDocument/documentSymbol', () => [{ name: 'greet', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }, selectionRange: span(0, 16, 21) }]);
			server.reply('textDocument/references', () => [
				{ uri: uri('src/app.ts'), range: span(2, 0, 5) },
				{ uri: uri('src/app.ts'), range: span(0, 9, 14) },
				// Not uses the change did not touch: the file itself, and one outside the checkout.
				{ uri: uri('src/greet.ts'), range: span(0, 16, 21) },
				{ uri: 'file:///usr/lib/node_modules/typescript/lib/lib.es5.d.ts', range: span(0, 0, 1) },
			]);
		});

		// In the checkout on screen, where the server stays when the check is over.
		const result = await check([modified('src/greet.ts', diff)], HARMONY);

		expect(result).toEqual({
			// The changed file's own first, then the ones that use what it changed.
			problems: [
				{ path: 'src/greet.ts', line: 1, column: 1, message: 'Missing return on some paths.', source: 'ts', changed: true },
				{ path: 'src/app.ts', line: 1, column: 1, message: 'Expected 2 arguments, but got 1.', source: 'ts', changed: false },
			],
			known: 0,
			impact: [
				{
					symbol: 'greet',
					path: 'src/greet.ts',
					line: 1,
					uses: [
						{ path: 'src/app.ts', line: 1 },
						{ path: 'src/app.ts', line: 3 },
					],
				},
			],
			servers: ['TypeScript and JavaScript'],
			files: 1,
			users: 1,
			finished: true,
		});
		const server = native.started[0];
		// Asked of the file as it was, at the name, without the declaration itself.
		expect(server.sent('textDocument/references')).toEqual([{ textDocument: { uri: uri('src/greet.ts') }, position: { line: 0, character: 16 }, context: { includeDeclaration: false } }]);
		// Everything opened is closed again.
		expect(shown(server, HARMONY)).toEqual([
			['opened', 'src/greet.ts', was],
			['opened', 'src/app.ts', caller],
			['changed', 'src/greet.ts', now],
			['changed', 'src/greet.ts', was],
			['closed', 'src/greet.ts'],
			['closed', 'src/app.ts'],
		]);
		expect(w.sent('lsp_stop')).toEqual([]);
	});

	test('a flat outline only says where a declaration starts: its uses are asked for at the name itself', async () => {
		native.install('typescript', { textDocumentSync: 2, documentSymbolProvider: true, referencesProvider: true });
		tree({ 'src/greet.ts': { was: GREET_WAS, now: GREET_WAS.replace('Hello', 'Hi') }, 'src/app.ts': { now: CALLER } });
		native.starting.push((server) => {
			compiles(server);
			server.reply('textDocument/documentSymbol', () => [{ name: 'greet(name)', kind: 12, location: { uri: there('src/greet.ts'), range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } } }]);
			server.reply('textDocument/references', () => [{ uri: there('src/app.ts'), range: span(2, 0, 5) }]);
		});

		const result = await check([modified('src/greet.ts', GREET_DIFF)]);

		expect(native.started[0].sent('textDocument/references')).toMatchObject([{ position: { line: 0, character: 16 } }]);
		expect(result).toMatchObject({ problems: [], impact: [{ symbol: 'greet', path: 'src/greet.ts', line: 1, uses: [{ path: 'src/app.ts', line: 3 }] }], users: 1 });
	});

	test('a server that has no outline or no references to give is not asked what the change touched', async () => {
		native.install('typescript', { textDocumentSync: 2, documentSymbolProvider: true });
		tree({ 'src/greet.ts': { was: GREET_WAS, now: GREET_WAS.replace('Hello', 'Hi') } });
		native.starting.push((server) => compiles(server));

		const result = await check([modified('src/greet.ts', GREET_DIFF)]);
		expect(result).toMatchObject({ impact: [], users: 0, files: 1 });
		expect(asked(native.started[0])).not.toContain('textDocument/references');
	});

	test('the problems of several files come by file, then by line', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => compiles(server));
		tree({
			'src/b.ts': { was: 'const b = 1;\n', now: 'const b = 1;\nb(); // !! b is not a function.\n' },
			'src/a.ts': { was: 'const a = 1;\n', now: 'a(); // !! a is not a function.\n\na.x; // !! No property x.\n' },
		});

		const result = await check([modified('src/b.ts'), modified('src/a.ts')]);
		expect(result.problems.map((p) => [p.path, p.line, p.message])).toEqual([
			['src/a.ts', 1, 'a is not a function.'],
			['src/a.ts', 3, 'No property x.'],
			['src/b.ts', 2, 'b is not a function.'],
		]);
		expect(result).toMatchObject({ known: 0, files: 2, finished: true });
	});

	test('a new file has no before and a deleted one no after', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => compiles(server));
		tree({ 'src/new.ts': { was: 'never read', now: 'export const fresh: number = "1"; // !! Not a number.\n' }, 'src/old.ts': { was: 'export const old = 1;\n', now: 'never read' } });

		const result = await check(
			[
				{ path: 'src/new.ts', oldPath: null, status: 'untracked', diff: '' },
				{ path: 'src/old.ts', oldPath: null, status: 'deleted', diff: '' },
			],
			HARMONY
		);

		expect(result).toEqual({ ...NOTHING, problems: [{ path: 'src/new.ts', line: 1, column: 1, message: 'Not a number.', source: 'ts', changed: true }], servers: ['TypeScript and JavaScript'], files: 2 });
		expect(w.sent('worktree_read').map((c) => [c.args.file, c.args.rev])).toEqual([
			['src/new.ts', undefined],
			['src/old.ts', BASE],
		]);
		expect(shown(native.started[0], HARMONY)).toEqual([
			['opened', 'src/old.ts', 'export const old = 1;\n'],
			['opened', 'src/new.ts', 'export const fresh: number = "1"; // !! Not a number.\n'],
			['closed', 'src/old.ts'],
			// There is an error now, so the project as it was is looked at once more: without the new file, with the old one.
			['closed', 'src/new.ts'],
			['opened', 'src/old.ts', 'export const old = 1;\n'],
			['closed', 'src/old.ts'],
		]);
	});

	test('a renamed file is shown under its old name as it was and under its new name as it is', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => compiles(server));
		tree({ 'src/before.ts': { was: 'export const a = 1;\n' }, 'src/after.ts': { now: 'export const a = 2;\n' } });

		const result = await check([{ path: 'src/after.ts', oldPath: 'src/before.ts', status: 'renamed', diff: '' }], HARMONY);

		expect(result).toEqual({ ...NOTHING, servers: ['TypeScript and JavaScript'], files: 1 });
		expect(w.sent('worktree_read').map((c) => [c.args.file, c.args.rev])).toEqual([
			['src/before.ts', BASE],
			['src/after.ts', undefined],
		]);
		expect(shown(native.started[0], HARMONY)).toEqual([
			['opened', 'src/before.ts', 'export const a = 1;\n'],
			['closed', 'src/before.ts'],
			['opened', 'src/after.ts', 'export const a = 2;\n'],
			['closed', 'src/after.ts'],
		]);
	});

	// CLAUDE.md: errors "reported for the files as they are and not for the files as they were (same
	// file, same message, same line of code, wherever it moved) are the change's own"; ones that were
	// already there are only counted. What holds now: an error a renamed file already had under its old
	// name is counted as known (problems: [], known: 1). Before the fix (2026-11-23): `checkWith` records the earlier
	// errors under the old path and the later ones under the new path (lsp.service.ts shows
	// `plan.was`, :1501 `plan.file.path`), `newSince` compares paths, so every old error of a renamed
	// file comes out as new (problems: [the old error], known: 0).
	test('an error a renamed file already had under its old name is not the change\'s own', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => compiles(server));
		const text = 'export const a: number = "1"; // !! Not a number.\n';
		tree({ 'src/before.ts': { was: text }, 'src/after.ts': { now: text } });

		const result = await check([{ path: 'src/after.ts', oldPath: 'src/before.ts', status: 'renamed', diff: '' }]);
		expect(result).toMatchObject({ problems: [], known: 1 });
	});

	// What holds now: every question the server is sent about a document names that document. Before the fix (2026-11-23): when
	// nothing is left open after the swap (the change only deleted files, and nothing uses them),
	// `settle` asks textDocument/documentSymbol for `uris[0] ?? [...open.keys()][0]`, which is
	// undefined (lsp.service.ts), so the server gets `{ textDocument: {} }` on the wire.
	test('a change that only deletes a file asks the server about no document without an address', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => compiles(server));
		tree({ 'src/old.ts': { was: 'export const old = 1;\n' } });

		await check([{ path: 'src/old.ts', oldPath: null, status: 'deleted', diff: '' }]);
		const about = native.started[0].sent<{ textDocument: { uri?: string } }>('textDocument/documentSymbol');
		expect(about.length).toBeGreaterThan(0);
		expect(about.map((p) => typeof p.textDocument.uri)).not.toContain('undefined');
	});

	test('a changed file that is open in the editor is not swapped: its current errors are listed as they are', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		await open('src/main.ts');
		const server = native.server('typescript');
		server.publish(uri('src/main.ts'), [
			{ range: span(3, 6, 11), message: "Cannot find name 'Queue'.", severity: 1, source: 'ts' },
			{ range: span(4, 4, 10), message: "'repeat' is never read.", severity: 2, source: 'ts' },
		]);
		server.clear();

		const result = await check([modified('src/main.ts')], HARMONY);

		expect(result).toEqual({ ...NOTHING, problems: [{ path: 'src/main.ts', line: 4, column: 7, message: "Cannot find name 'Queue'.", source: 'ts', changed: true }], servers: ['TypeScript and JavaScript'], files: 1 });
		// Its text is the editor's: nothing was read, shown or closed, and the server it already had stays.
		expect(server.methods()).toEqual([]);
		expect(w.sent('worktree_read')).toEqual([]);
		expect(w.sent('lsp_stop')).toEqual([]);
	});

	test('a file the editor opens while a check has it with the server waits its turn, and the server of the checkout on screen stays', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => compiles(server));
		const disk = (await onDisk('src/player/queue.ts'))!;
		tree({ 'src/player/queue.ts': { was: 'export class Queue {}\n', now: disk } });

		const result = lsp.check(HARMONY, HARMONY, [modified('src/player/queue.ts')], BASE);
		await flush();
		const model = await open('src/player/queue.ts');
		const server = native.server('typescript');
		expect(shown(server, HARMONY).map(([what]) => what)).toEqual(['opened', 'changed']);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(await result).toMatchObject({ problems: [], files: 1, finished: true });
		// Never open twice at once: the check's copy is closed before the editor's is opened.
		expect(shown(server, HARMONY)).toEqual([
			['opened', 'src/player/queue.ts', 'export class Queue {}\n'],
			['changed', 'src/player/queue.ts', disk],
			['closed', 'src/player/queue.ts'],
			['opened', 'src/player/queue.ts', model.getValue()],
		]);
		expect(w.sent('lsp_stop')).toEqual([]);
		expect(lsp.running()).toEqual([server.key]);
	});

	test('files no installed server knows are not checked, and nothing is started for a language without one', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		tree({});

		expect(await check([modified('README.md'), modified('src/styles/app.css')])).toEqual(NOTHING);
		expect(w.sent('lsp_start')).toEqual([]);

		expect(await check([modified('tools/gen.py')])).toEqual(NOTHING);
		expect(w.sent('lsp_start').map((c) => c.args)).toEqual([{ id: HARMONY, language: 'python', cwd: TREE }]);
		expect(native.started).toEqual([]);
	});

	test('a file that can be read neither as it was nor as it is leaves nothing to check', async () => {
		native.install('typescript', { textDocumentSync: 2 });
		native.starting.push((server) => compiles(server));
		tree({});

		expect(await check([modified('src/vanished.ts')])).toEqual({ ...NOTHING, servers: ['TypeScript and JavaScript'] });
		expect(shown(native.started[0])).toEqual([]);
		expect(w.sent('lsp_stop').map((c) => c.args.key)).toEqual([native.started[0].key]);
	});
});

describe('the symbol search', () => {
	async function files(): Promise<string[]> {
		return (await import('./demo-files')).demoFiles();
	}
	const opened = (server: FakeServer): string[] => server.sent<{ textDocument: { uri: string } }>('textDocument/didOpen').map((p) => p.textDocument.uri);
	const closed = (server: FakeServer): string[] => server.sent<{ textDocument: { uri: string } }>('textDocument/didClose').map((p) => p.textDocument.uri);

	test('covering the checkout starts the server of every language it has files of, shows each one file, and says what cannot be searched', async () => {
		native.install('typescript', { textDocumentSync: 2, workspaceSymbolProvider: true });
		native.install('rust', { textDocumentSync: 2 });
		await addFile('scripts/build.js', 'console.log(1);\n');
		await addFile('native/lib.rs', 'fn main() {}\n');
		await addFile('tools/gen.py', 'print(1)\n');

		const coverage = await lsp.cover(await files());
		await flush();

		// One server answers for TypeScript and JavaScript: it is named once. Rust's cannot search; Python has none.
		expect(coverage).toEqual({ covered: ['TypeScript and JavaScript'], without: ['Python', 'Rust'] });
		expect(w.sent('lsp_start').map((c) => c.args.language).sort()).toEqual(['javascript', 'python', 'rust', 'typescript']);
		const server = native.server('typescript');
		// TypeScript only knows a project once a file of it is open: the one nearest the top goes.
		expect(server.sent<{ textDocument: Record<string, unknown> }>('textDocument/didOpen').map((p) => p.textDocument)).toEqual(
			expect.arrayContaining([
				{ uri: uri('src/main.ts'), languageId: 'typescript', version: 1, text: await onDisk('src/main.ts') },
				{ uri: uri('scripts/build.js'), languageId: 'javascript', version: 1, text: 'console.log(1);\n' },
			])
		);
		expect(opened(server).length).toBe(2);
		expect(opened(native.server('rust'))).toEqual([]);

		// Covering again shows nothing twice.
		await lsp.cover(await files());
		await flush();
		expect(opened(server).length).toBe(2);

		lsp.uncover();
		await flush();
		expect(closed(server).sort()).toEqual([uri('scripts/build.js'), uri('src/main.ts')]);
		lsp.uncover();
		await flush();
		expect(closed(server).length).toBe(2);
	});

	test('of a language\'s files the one opened most lately is the one shown', async () => {
		native.install('typescript', { textDocumentSync: 2, workspaceSymbolProvider: true });
		await lsp.cover(await files(), ['README.md', 'src/player/track.ts', 'src/player/queue.ts']);
		await flush();
		expect(opened(native.server('typescript'))).toEqual([uri('src/player/track.ts')]);
	});

	test('a file the editor has open is not shown again, and is left open when the search is over', async () => {
		native.install('typescript', { textDocumentSync: 2, workspaceSymbolProvider: true });
		await open('src/main.ts');
		const server = native.server('typescript');

		expect(await lsp.cover(await files())).toEqual({ covered: ['TypeScript and JavaScript'], without: [] });
		await flush();
		lsp.uncover();
		await flush();
		expect(opened(server)).toEqual([uri('src/main.ts')]);
		expect(closed(server)).toEqual([]);
	});

	test('the editor opening the file the search showed takes that copy\'s place', async () => {
		native.install('typescript', { textDocumentSync: 2, workspaceSymbolProvider: true });
		await lsp.cover(await files());
		await flush();
		const server = native.server('typescript');
		server.clear();

		const model = await open('src/main.ts');
		expect(server.received.map((m) => [m.method, (m.params as { textDocument: { uri: string } }).textDocument.uri])).toEqual([
			['textDocument/didClose', uri('src/main.ts')],
			['textDocument/didOpen', uri('src/main.ts')],
		]);
		// It is the editor's now: the end of the search does not close it, and its edits are followed.
		lsp.uncover();
		model.type('x');
		await vi.advanceTimersByTimeAsync(300);
		expect(server.methods()).toEqual(['textDocument/didClose', 'textDocument/didOpen', 'textDocument/didChange']);
	});

	test('symbols come from every server of the checkout that can search, as places in it', async () => {
		expect(await lsp.findSymbols('que')).toBeNull();

		native.install('typescript', { textDocumentSync: 2, workspaceSymbolProvider: true });
		native.install('rust', { textDocumentSync: 2, workspaceSymbolProvider: true });
		native.install('php', { textDocumentSync: 2 });
		await addFile('native/lib.rs', 'fn queue_up() {}\n');
		await addFile('web/index.php', '<?php\n');
		await open('src/main.ts');
		await open('native/lib.rs');
		await open('web/index.php');
		native.server('typescript').reply('workspace/symbol', () => [
			{ name: 'Queue', kind: 5, containerName: 'queue', location: { uri: uri('src/player/queue.ts'), range: span(2, 13, 18) } },
			// Only the file is named until asked for more: the top of it.
			{ name: 'queue', kind: 13, location: { uri: uri('src/main.ts') } },
			{ name: 'queueMicrotask', kind: 12, location: { uri: 'file:///usr/lib/node_modules/typescript/lib/lib.dom.d.ts', range: span(0, 0, 1) } },
		]);
		native.server('rust').reply('workspace/symbol', () => [{ name: 'queue_up', kind: 12, location: { uri: uri('native/lib.rs'), range: span(0, 3, 11) } }]);

		expect(await lsp.findSymbols('que')).toEqual([
			{ name: 'Queue', kind: 4, container: 'queue', path: 'src/player/queue.ts', line: 3, column: 14 },
			{ name: 'queue', kind: 12, container: '', path: 'src/main.ts', line: 1, column: 1 },
			{ name: 'queue_up', kind: 11, container: '', path: 'native/lib.rs', line: 1, column: 4 },
		]);
		expect(native.server('typescript').sent('workspace/symbol')).toEqual([{ query: 'que' }]);
		expect(asked(native.server('php'))).toEqual([]);
	});
});
