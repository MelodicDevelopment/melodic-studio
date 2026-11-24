import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appError, world, type World } from '../test/world';
import { fakeMonaco, type FakeModel, type FakeMonaco } from './monaco-fake.spec-helper';
import type { FormatterService } from './formatter.service';
import type { RepoStore } from './repo.store';
import type { FormatTool } from './backend.service';

/** The language servers' formatter, which a file the project's own formatter does not know is handed on to. */
const lsp = vi.hoisted(() => ({ asked: [] as unknown[][], edits: [] as unknown[] }));

vi.mock('../shared/monaco', async () => (await import('./monaco-fake.spec-helper')).monacoModule());
vi.mock('./lsp.service', () => ({
	LspService: class {
		format(...args: unknown[]): Promise<unknown[]> {
			lsp.asked.push(args);
			return Promise.resolve(lsp.edits);
		}
	},
}));

const HARMONY = '/Users/demo/Source/harmony';
const TREE = '/Users/demo/Source/harmony.worktrees/shuffle';
const PRETTIER: FormatTool = { name: 'Prettier', version: '3.10.1' };
const OPTIONS = { tabSize: 4, insertSpaces: false };
const TOKEN = { isCancellationRequested: false };

let w: World;
let repos: RepoStore;
let formatter: FormatterService;
let monaco: FakeMonaco;
/** What the project brings for a file: `format_tool`'s answer. */
let tool: FormatTool | null;
/** What the app hooked onto the window in this test, unhooked after it: the window outlives the test. */
const hooked: [string, EventListenerOrEventListenerObject][] = [];
const hook = window.addEventListener.bind(window);

/** The clock is held in every test here (the service looks at a file again two seconds after it opens): waiting is advancing it. */
const pause = async (): Promise<void> => {
	await vi.advanceTimersByTimeAsync(1);
};

async function start(tab: 'files' | 'changes' = 'files'): Promise<void> {
	vi.useFakeTimers();
	w = await world();
	vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
		hooked.push([type, listener]);
		hook(type, listener, options);
	});
	monaco = await fakeMonaco();
	tool = PRETTIER;
	lsp.asked = [];
	lsp.edits = [];
	w.on('format_tool', () => tool);
	w.on('format_file', (args) => `formatted: ${String(args.text)}`);
	// The stand-in above is a plain class, the same one in every test: this test's injector has to be told of it.
	const { Injectable } = await import('@melodicdev/core/injection');
	Injectable()((await import('./lsp.service')).LspService);
	repos = w.get((await import('./repo.store')).RepoStore);
	await repos.init();
	repos.tab.set(tab);
	formatter = w.get((await import('./formatter.service')).FormatterService);
	await pause();
}

/** The editor opens a file of the checkout on screen. */
async function opened(path: string, text = 'const a=1\n', root = HARMONY): Promise<FakeModel> {
	const model = monaco.editor.createModel(text, undefined, monaco.Uri.file(`${root}/${path}`));
	await pause();
	return model;
}

/** Format Document, as Monaco does it: the provider registered last among those that match the file. */
function format(model: FakeModel, token = TOKEN): Promise<{ range: unknown; text: string }[]> {
	const provider = monaco.fake.formattersOf(model).at(-1)!.provider;
	return provider.provideDocumentFormattingEdits(model, OPTIONS, token) as Promise<{ range: unknown; text: string }[]>;
}

const asMonaco = (model: FakeModel) => model as never;
const looks = () => w.sent('format_tool').map((c) => c.args);

async function showWorktree(path: string | null): Promise<void> {
	const { BackendService } = await import('./backend.service');
	await w.get(BackendService).selectWorktree(HARMONY, path);
	await repos.switchContext();
	await pause();
}

afterEach(() => {
	hooked.forEach(([type, listener]) => window.removeEventListener(type, listener));
	hooked.length = 0;
	vi.useRealTimers();
});

describe('which files format with the project\'s own formatter', () => {
	beforeEach(() => start());

	test('a file whose project brings Prettier gets a formatter of its own, by its exact path', async () => {
		const model = await opened('src/main.ts');
		expect(looks()).toEqual([{ id: HARMONY, path: 'src/main.ts' }]);
		const mine = monaco.fake.formattersOf(model);
		expect(mine.length).toBe(1);
		expect(mine[0].selector).toEqual({ scheme: 'file', pattern: `${HARMONY}/src/main.ts` });
		expect(mine[0].provider.displayName).toBe('Prettier');
		expect(formatter.toolFor(asMonaco(model))).toBe('Prettier');
	});

	test('a file whose project brings none gets nothing: it formats as before', async () => {
		tool = null;
		const model = await opened('src/main.ts');
		expect(looks().length).toBe(1);
		expect(monaco.fake.formatters).toEqual([]);
		expect(formatter.toolFor(asMonaco(model))).toBeNull();
		expect(await formatter.ready(asMonaco(model))).toBeNull();
	});

	test('a look that fails counts as no formatter, and is not said', async () => {
		w.on('format_tool', () => {
			throw appError('error', 'node_modules cannot be read');
		});
		const model = await opened('src/main.ts');
		expect(monaco.fake.formatters).toEqual([]);
		expect(formatter.toolFor(asMonaco(model))).toBeNull();
		expect(w.toasts).toEqual([]);
	});

	test('each file is looked up by itself: one project\'s formatter is not another file\'s', async () => {
		w.on('format_tool', (args) => (String(args.path).startsWith('web/') ? PRETTIER : null));
		const web = await opened('web/app.ts');
		const api = await opened('api/main.rs');
		expect(formatter.toolFor(asMonaco(web))).toBe('Prettier');
		expect(formatter.toolFor(asMonaco(api))).toBeNull();
		expect(monaco.fake.formattersOf(api)).toEqual([]);
	});

	test('a file outside the checkout on screen, or one that is not a file at all, is not asked about', async () => {
		const outside = await opened('notes.md', 'x', '/Users/demo/Desktop');
		const untitled = monaco.editor.createModel('x', undefined, monaco.Uri.parse('inmemory://model/1'));
		const root = monaco.editor.createModel('x', undefined, monaco.Uri.file(HARMONY));
		await pause();
		expect(looks()).toEqual([]);
		expect(monaco.fake.formatters).toEqual([]);
		expect(formatter.toolFor(asMonaco(outside))).toBeNull();
		expect(formatter.toolFor(asMonaco(untitled))).toBeNull();
		expect(formatter.toolFor(asMonaco(root))).toBeNull();
		expect(formatter.toolFor(null)).toBeNull();
	});

	test('in a worktree the file is found from the worktree\'s folder', async () => {
		await showWorktree(TREE);
		const theirs = await opened('src/main.ts', 'const a=1\n', TREE);
		const mains = await opened('src/main.ts');
		expect(looks()).toEqual([{ id: HARMONY, path: 'src/main.ts' }]);
		expect(formatter.toolFor(asMonaco(theirs))).toBe('Prettier');
		expect(formatter.toolFor(asMonaco(mains))).toBeNull();
		await format(theirs);
		expect(w.sent('format_file')[0].args).toMatchObject({ id: HARMONY, root: TREE, path: 'src/main.ts' });
	});

	test('a file that is closed lets go of its formatter', async () => {
		const model = await opened('src/main.ts');
		const mine = monaco.fake.formatters[0];
		model.dispose();
		expect(mine.disposed).toBe(true);
		expect(formatter.toolFor(asMonaco(model))).toBeNull();
	});

	test('a file closed while its project was being looked at gets no formatter', async () => {
		const model = monaco.editor.createModel('x', undefined, monaco.Uri.file(`${HARMONY}/src/main.ts`));
		model.dispose();
		await pause();
		expect(monaco.fake.formatters.filter((f) => !f.disposed)).toEqual([]);
		expect(formatter.toolFor(asMonaco(model))).toBeNull();
	});

	test('files already open when the Files tab first shows are looked at too', async () => {
		await start('changes');
		const model = await opened('src/main.ts');
		expect(looks()).toEqual([]);
		expect(monaco.fake.formatters).toEqual([]);
		repos.tab.set('files');
		await pause();
		expect(looks()).toEqual([{ id: HARMONY, path: 'src/main.ts' }]);
		expect(formatter.toolFor(asMonaco(model))).toBe('Prettier');
	});
});

describe('being the formatter Monaco picks: the one registered last', () => {
	beforeEach(() => start());

	/** The file's own formatter is registered, alone, and after everything registered before `since`. */
	function registeredAgain(model: FakeModel, since: number): void {
		const live = monaco.fake.formattersOf(model);
		expect(live.length).toBe(1);
		expect(monaco.fake.formatters.indexOf(live[0])).toBeGreaterThanOrEqual(since);
		expect(monaco.fake.formatters.slice(0, since).every((f) => f.disposed)).toBe(true);
	}

	test('it is registered again when the file is shown in an editor', async () => {
		const editor = monaco.fake.show(null);
		const model = await opened('src/main.ts');
		const before = monaco.fake.formatters.length;
		editor.setModel(model);
		await pause();
		registeredAgain(model, before);
	});

	test('an editor made later is followed as well', async () => {
		const model = await opened('src/main.ts');
		const editor = monaco.fake.show(null);
		const before = monaco.fake.formatters.length;
		editor.setModel(model);
		await pause();
		registeredAgain(model, before);
	});

	test('it is registered again when the window comes back to the front, and a project that lost its formatter loses it here', async () => {
		const model = await opened('src/main.ts');
		const before = monaco.fake.formatters.length;
		window.dispatchEvent(new Event('focus'));
		await pause();
		registeredAgain(model, before);

		tool = null; // node_modules was removed meanwhile
		window.dispatchEvent(new Event('focus'));
		await pause();
		expect(monaco.fake.formattersOf(model)).toEqual([]);
		expect(formatter.toolFor(asMonaco(model))).toBeNull();
	});

	test('a project that gained its formatter (an npm install) is noticed when the window comes back', async () => {
		tool = null;
		const model = await opened('src/main.ts');
		tool = PRETTIER;
		window.dispatchEvent(new Event('focus'));
		await pause();
		expect(formatter.toolFor(asMonaco(model))).toBe('Prettier');
		expect(monaco.fake.formattersOf(model).length).toBe(1);
	});

	test('right before a format on save it is registered again, and its name is the answer', async () => {
		const model = await opened('src/main.ts');
		const before = monaco.fake.formatters.length;
		expect(await formatter.ready(asMonaco(model))).toBe('Prettier');
		registeredAgain(model, before);
	});

	test('two looks at the same file at once are one look', async () => {
		const model = await opened('src/main.ts');
		const before = looks().length;
		await Promise.all([formatter.ready(asMonaco(model)), formatter.ready(asMonaco(model))]);
		expect(looks().length).toBe(before + 1);
		expect(monaco.fake.formattersOf(model).length).toBe(1);
	});

	test('a format on save before the Files tab was ever shown still finds the formatter', async () => {
		await start('changes');
		const model = monaco.editor.createModel('x', undefined, monaco.Uri.file(`${HARMONY}/src/main.ts`));
		expect(await formatter.ready(asMonaco(model))).toBe('Prettier');
		expect(monaco.fake.formattersOf(model).length).toBe(1);
	});
});

describe('two seconds after a file opens', () => {
	beforeEach(() => start());

	test('it is registered once more, after a language\'s own formatter that came late', async () => {
		const model = await opened('src/main.ts');
		expect(monaco.fake.formatters.length).toBe(1);
		monaco.languages.registerDocumentFormattingEditProvider('typescript', { provideDocumentFormattingEdits: () => [] });
		await vi.advanceTimersByTimeAsync(1900);
		expect(monaco.fake.formatters.length).toBe(2);
		await vi.advanceTimersByTimeAsync(200);
		const live = monaco.fake.formattersOf(model);
		expect(live.length).toBe(1);
		expect(monaco.fake.formatters.indexOf(live[0])).toBe(2);
		expect(monaco.fake.formatters[0].disposed).toBe(true);
	});
});

describe('formatting', () => {
	beforeEach(() => start());

	test('the editor\'s text, unsaved edits and all, is what the formatter gets; the file on disk is not written', async () => {
		const model = await opened('src/main.ts', 'const a=1\n');
		model.type('const a=1;const b=2\n');
		const edits = await format(model);
		expect(w.sent('format_file').map((c) => c.args)).toEqual([{ id: HARMONY, root: HARMONY, path: 'src/main.ts', text: 'const a=1;const b=2\n' }]);
		expect(edits).toEqual([{ range: model.getFullModelRange(), text: 'formatted: const a=1;const b=2\n' }]);
		expect(w.sent('write_file')).toEqual([]);
		expect(lsp.asked).toEqual([]);
	});

	test('text that is already as the formatter writes it changes nothing', async () => {
		w.on('format_file', (args) => args.text);
		const model = await opened('src/main.ts');
		expect(await format(model)).toEqual([]);
		expect(w.toasts).toEqual([]);
	});

	test('a file the formatter has no parser for is handed on to its language server', async () => {
		w.on('format_file', () => null);
		lsp.edits = [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 }, text: 'fn' }];
		const model = await opened('src/lib.rs', 'fn  main(){}\n');
		const edits = await format(model);
		expect(edits).toEqual(lsp.edits);
		expect(lsp.asked).toEqual([[model, OPTIONS, TOKEN]]);
		expect(w.toasts).toEqual([]);
	});

	test('a failure is said in the formatter\'s words, and nothing else formats in its place', async () => {
		w.on('format_file', () => {
			throw appError('error', 'SyntaxError: \';\' expected. (3:14)');
		});
		const model = await opened('src/main.ts');
		expect(await format(model)).toEqual([]);
		expect(w.toasts).toEqual([{ kind: 'warning', title: 'Prettier could not format main.ts', message: 'SyntaxError: \';\' expected. (3:14)' }]);
		expect(lsp.asked).toEqual([]);
	});

	test('a failure that is an Error, or just text, is said the same way', async () => {
		const model = await opened('src/main.ts');
		w.on('format_file', () => {
			throw new Error('timed out after 15 s');
		});
		await format(model);
		w.on('format_file', () => Promise.reject('node is not installed'));
		await format(model);
		expect(w.toasts.map((t) => t.message)).toEqual(['timed out after 15 s', 'node is not installed']);
	});

	test('what was typed while the formatter ran is kept: its answer was for text that is gone', async () => {
		const model = await opened('src/main.ts');
		w.on('format_file', (args) => {
			model.type('const a=1\n// typed meanwhile\n');
			return `formatted: ${String(args.text)}`;
		});
		expect(await format(model)).toEqual([]);
		expect(model.getValue()).toBe('const a=1\n// typed meanwhile\n');
	});

	test('a format that was cancelled, or whose file was closed meanwhile, changes nothing', async () => {
		const model = await opened('src/main.ts');
		const token = { isCancellationRequested: false };
		w.on('format_file', (args) => {
			token.isCancellationRequested = true;
			return `formatted: ${String(args.text)}`;
		});
		expect(await format(model, token)).toEqual([]);

		w.on('format_file', () => null);
		const provider = monaco.fake.formattersOf(model)[0].provider;
		const formatting = provider.provideDocumentFormattingEdits(model, OPTIONS, TOKEN) as Promise<unknown[]>;
		model.dispose();
		expect(await formatting).toEqual([]);
		expect(lsp.asked).toEqual([]);
	});

	test('a file that is no longer in the checkout on screen is left alone', async () => {
		const model = await opened('src/main.ts');
		const provider = monaco.fake.formattersOf(model)[0].provider;
		await showWorktree(TREE);
		expect(await provider.provideDocumentFormattingEdits(model, OPTIONS, TOKEN)).toEqual([]);
		expect(w.sent('format_file')).toEqual([]);
	});
});

describe('the same complaint about the same file', () => {
	beforeEach(async () => {
		await start();
		w.on('format_file', (args) => {
			throw appError('error', `SyntaxError in ${String(args.path)}`);
		});
	});

	test('is not said again within 30 seconds, as a format at every save would', async () => {
		const model = await opened('src/main.ts');
		await format(model);
		await vi.advanceTimersByTimeAsync(5_000);
		await format(model);
		await vi.advanceTimersByTimeAsync(24_000);
		await format(model);
		expect(w.toasts.length).toBe(1);
	});

	test('is said again once 30 seconds have passed', async () => {
		const model = await opened('src/main.ts');
		await format(model);
		await vi.advanceTimersByTimeAsync(30_000);
		await format(model);
		expect(w.toasts.length).toBe(2);
		// And the half minute starts over from there.
		await vi.advanceTimersByTimeAsync(29_000);
		await format(model);
		expect(w.toasts.length).toBe(2);
	});

	test('another file\'s complaint, or another complaint about the same file, is said at once', async () => {
		const main = await opened('src/main.ts');
		const other = await opened('src/other.ts');
		await format(main);
		await format(other);
		w.on('format_file', () => {
			throw appError('error', 'Invalid .prettierrc');
		});
		await format(other);
		expect(w.toasts.map((t) => `${t.title}: ${t.message}`)).toEqual([
			'Prettier could not format main.ts: SyntaxError in src/main.ts',
			'Prettier could not format other.ts: SyntaxError in src/other.ts',
			'Prettier could not format other.ts: Invalid .prettierrc',
		]);
	});
});
