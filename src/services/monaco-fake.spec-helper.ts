/**
 * A stand-in for Monaco in store tests: `src/shared/monaco.ts` loads the real one, which needs
 * workers and a layout happy-dom does not have. Only what the stores call is here.
 *
 *   vi.mock('../shared/monaco', async () => (await import('./monaco-fake.spec-helper')).monacoModule());
 *   ...
 *   const monaco = await fakeMonaco();   // after world(): the one the stores get, emptied
 *
 * `vi.resetModules()` (in `world()`) does not run a mock's factory again, so the one fake lasts the
 * whole spec file; `fakeMonaco()` empties it (models, editors, formatters, listeners) for the next test.
 */

export interface FakeUri {
	scheme: string;
	fsPath: string;
	path: string;
	toString(): string;
}

interface Range {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}

interface Disposable {
	dispose(): void;
}

function uriOf(scheme: string, path: string): FakeUri {
	return { scheme, fsPath: path, path, toString: () => `${scheme}://${path}` };
}

export class FakeModel {
	disposed = false;
	private _text: string;
	private _version = 1;
	private _alt = 1;
	/** What an undo goes back to: the text and the version it had. */
	private _undo: { text: string; alt: number }[] = [];
	private readonly _changed = new Set<() => void>();

	constructor(text: string, readonly uri: FakeUri, private readonly _gone: (model: FakeModel) => void) {
		this._text = text;
	}

	getValue(): string {
		return this._text;
	}

	/** As in Monaco: the text is replaced and the undo history is gone. */
	setValue(text: string): void {
		this._undo = [];
		this._text = text;
		this._alt = ++this._version;
		this.changed();
	}

	getAlternativeVersionId(): number {
		return this._alt;
	}

	getValueLength(): number {
		return this._text.length;
	}

	getEOL(): string {
		return '\n';
	}

	getLanguageId(): string {
		return 'plaintext';
	}

	getLineCount(): number {
		return this._text.split('\n').length;
	}

	getLineContent(line: number): string {
		return this._text.split('\n')[line - 1] ?? '';
	}

	getFullModelRange(): Range {
		const lines = this.getLineCount();
		return { startLineNumber: 1, startColumn: 1, endLineNumber: lines, endColumn: this.getLineContent(lines).length + 1 };
	}

	onDidChangeContent(listener: () => void): Disposable {
		this._changed.add(listener);
		return { dispose: () => void this._changed.delete(listener) };
	}

	/** Edits by range, as one undo step. */
	pushEditOperations(_before: unknown, edits: { range: Range; text: string | null }[], _after: unknown): null {
		const lines = this._text.split('\n');
		const offset = (line: number, column: number): number => lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0) + column - 1;
		let text = this._text;
		const placed = edits.map((e) => ({ from: offset(e.range.startLineNumber, e.range.startColumn), to: offset(e.range.endLineNumber, e.range.endColumn), text: e.text ?? '' }));
		for (const edit of placed.sort((a, b) => b.from - a.from)) {
			text = text.slice(0, edit.from) + edit.text + text.slice(edit.to);
		}
		this.edit(text);
		return null;
	}

	isDisposed(): boolean {
		return this.disposed;
	}

	dispose(): void {
		if (!this.disposed) {
			this.disposed = true;
			this._gone(this);
		}
	}

	// ---- for tests ----

	/** The person types: the whole text becomes `text`, as one step that can be undone. */
	type(text: string): void {
		this.edit(text);
	}

	/** Cmd/Ctrl+Z: the text and the version it had before the last step. */
	undo(): void {
		const before = this._undo.pop();
		if (before) {
			this._text = before.text;
			this._alt = before.alt;
			this._version++;
			this.changed();
		}
	}

	private edit(text: string): void {
		this._undo.push({ text: this._text, alt: this._alt });
		this._text = text;
		this._alt = ++this._version;
		this.changed();
	}

	private changed(): void {
		this._changed.forEach((listener) => listener());
	}
}

export class FakeEditor {
	position: { lineNumber: number; column: number } | null = null;
	revealed: { lineNumber: number; column: number } | null = null;
	focused = false;
	private _model: FakeModel | null;
	private readonly _swapped = new Set<() => void>();

	constructor(model: FakeModel | null) {
		this._model = model;
	}

	getModel(): FakeModel | null {
		return this._model;
	}

	setModel(model: FakeModel | null): void {
		this._model = model;
		this._swapped.forEach((listener) => listener());
	}

	onDidChangeModel(listener: () => void): Disposable {
		this._swapped.add(listener);
		return { dispose: () => void this._swapped.delete(listener) };
	}

	setPosition(position: { lineNumber: number; column: number }): void {
		this.position = position;
	}

	revealPositionInCenter(position: { lineNumber: number; column: number }): void {
		this.revealed = position;
	}

	focus(): void {
		this.focused = true;
	}
}

export interface FakeFormatter {
	selector: { scheme?: string; pattern?: string } | string;
	provider: { displayName?: string; provideDocumentFormattingEdits(model: unknown, options: unknown, token: unknown): unknown };
	disposed: boolean;
}

export interface FakeMonaco {
	Uri: { file(path: string): FakeUri; parse(text: string): FakeUri };
	editor: {
		createModel(text: string, language: string | undefined, uri: FakeUri): FakeModel;
		getModel(uri: FakeUri): FakeModel | null;
		getModels(): FakeModel[];
		getEditors(): FakeEditor[];
		onDidCreateModel(listener: (model: FakeModel) => void): Disposable;
		onWillDisposeModel(listener: (model: FakeModel) => void): Disposable;
		onDidCreateEditor(listener: (editor: FakeEditor) => void): Disposable;
	};
	languages: {
		registerDocumentFormattingEditProvider(selector: FakeFormatter['selector'], provider: FakeFormatter['provider']): Disposable;
	};
	/** For tests: what the fake holds, and the things a person or the editor component would do. */
	fake: {
		/** Every model ever made, disposed ones included. */
		made: FakeModel[];
		/** Every formatter ever registered, in order, disposed ones included. */
		formatters: FakeFormatter[];
		/** The formatters still registered for exactly this file, in the order they were registered. */
		formattersOf(model: FakeModel): FakeFormatter[];
		/** An editor on screen showing `model`. */
		show(model: FakeModel | null): FakeEditor;
		/** Back to nothing: what an earlier test made or listened for is gone. */
		reset(): void;
	};
}

export function makeMonaco(): FakeMonaco {
	const models = new Map<string, FakeModel>();
	const made: FakeModel[] = [];
	const editors: FakeEditor[] = [];
	const formatters: FakeFormatter[] = [];
	const modelMade = new Set<(model: FakeModel) => void>();
	const modelGoing = new Set<(model: FakeModel) => void>();
	const editorMade = new Set<(editor: FakeEditor) => void>();
	const listen = <T>(set: Set<T>, listener: T): Disposable => {
		set.add(listener);
		return { dispose: () => void set.delete(listener) };
	};

	return {
		Uri: {
			file: (path) => uriOf('file', path),
			parse: (text) => {
				const at = text.indexOf('://');
				return at < 0 ? uriOf('file', text) : uriOf(text.slice(0, at), text.slice(at + 3));
			},
		},
		editor: {
			createModel: (text, _language, uri) => {
				if (models.has(uri.toString())) {
					throw new Error(`a model for ${uri.toString()} already exists`); // as Monaco does
				}
				const model = new FakeModel(text, uri, (gone) => {
					modelGoing.forEach((listener) => listener(gone));
					models.delete(gone.uri.toString());
				});
				models.set(uri.toString(), model);
				made.push(model);
				modelMade.forEach((listener) => listener(model));
				return model;
			},
			getModel: (uri) => models.get(uri.toString()) ?? null,
			getModels: () => [...models.values()],
			getEditors: () => [...editors],
			onDidCreateModel: (listener) => listen(modelMade, listener),
			onWillDisposeModel: (listener) => listen(modelGoing, listener),
			onDidCreateEditor: (listener) => listen(editorMade, listener),
		},
		languages: {
			registerDocumentFormattingEditProvider: (selector, provider) => {
				const entry: FakeFormatter = { selector, provider, disposed: false };
				formatters.push(entry);
				return { dispose: () => void (entry.disposed = true) };
			},
		},
		fake: {
			made,
			formatters,
			formattersOf: (model) => formatters.filter((f) => !f.disposed && typeof f.selector !== 'string' && f.selector.pattern === model.uri.fsPath),
			show: (model) => {
				const editor = new FakeEditor(model);
				editors.push(editor);
				editorMade.forEach((listener) => listener(editor));
				return editor;
			},
			reset: () => {
				// A store of an earlier test that still holds one of these (a timer of its own that fires late) finds it closed.
				made.forEach((model) => (model.disposed = true));
				models.clear();
				made.length = 0;
				editors.length = 0;
				formatters.length = 0;
				modelMade.clear();
				modelGoing.clear();
				editorMade.clear();
			},
		},
	};
}

/** What `vi.mock('../shared/monaco', ...)` answers with: the module's exports, over one fake. */
export function monacoModule(): Record<string, unknown> {
	const monaco = makeMonaco();
	return {
		loadMonaco: () => Promise.resolve(monaco),
		setBuiltInTypeScript: () => undefined,
		adoptMonacoStyles: () => Promise.resolve(),
		releaseMonacoStyles: () => undefined,
	};
}

/** The fake the stores of this test will get, emptied. Call after `world()`, before any store is made. */
export async function fakeMonaco(): Promise<FakeMonaco> {
	const { loadMonaco } = await import('../shared/monaco');
	const monaco = (await loadMonaco()) as unknown as FakeMonaco;
	monaco.fake.reset();
	return monaco;
}
