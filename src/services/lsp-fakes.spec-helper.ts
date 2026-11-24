/**
 * What lsp.service.spec.ts stands on: a Monaco that is only its bookkeeping (models, providers,
 * markers, commands), since the real one cannot run in a pretend browser, and a native side that
 * plays the language servers: it answers `lsp_start` / `lsp_send` / `lsp_stop` and sends the
 * `lsp-message` and `lsp-closed` events the way src-tauri/src/lsp.rs does.
 *
 * Nothing in here knows what LspService does with either; the spec says what should happen.
 */
import type { LspDiagnostic, LspMessage } from './lsp/protocol';
import type { World } from '../test/world';

// ---- Monaco ------------------------------------------------------------------------

export interface Disposable {
	dispose(): void;
}
export interface Position {
	lineNumber: number;
	column: number;
}
export interface Range {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}
export interface Edit {
	range: Range;
	text: string | null;
}
interface ContentEvent {
	changes: { range: Range; rangeLength: number; text: string }[];
	isFlush: boolean;
	isEolChange: boolean;
	versionId: number;
}

export class FakeUri {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;

	private constructor(scheme: string, authority: string, path: string) {
		this.scheme = scheme;
		this.authority = authority;
		this.path = path;
	}

	static file(path: string): FakeUri {
		const slashed = path.replace(/\\/g, '/');
		return new FakeUri('file', '', slashed.startsWith('/') ? slashed : `/${slashed}`);
	}

	static parse(text: string): FakeUri {
		const found = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)/.exec(text);
		return found ? new FakeUri(found[1], found[2] ?? '', decodeURIComponent(found[3])) : new FakeUri('file', '', text);
	}

	get fsPath(): string {
		return this.path;
	}

	toString(): string {
		return `${this.scheme}://${this.authority}${this.path.split('/').map(encodeURIComponent).join('/')}`;
	}
}

class FakeEmitter<T> {
	private readonly _listeners = new Set<(value: T) => void>();
	readonly event = (listener: (value: T) => void): Disposable => {
		this._listeners.add(listener);
		return { dispose: () => void this._listeners.delete(listener) };
	};
	fire(value: T): void {
		[...this._listeners].forEach((listener) => listener(value));
	}
}

const LANGUAGES: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	rs: 'rust',
	py: 'python',
	go: 'go',
	php: 'php',
	cs: 'csharp',
	md: 'markdown',
	json: 'json',
	css: 'css',
	html: 'html',
};

export class FakeModel {
	readonly uri: FakeUri;
	/** What was done to it, in order: `stop` (an undo stop), `edit`, `set` (the whole text replaced). */
	readonly history: string[] = [];
	private readonly _editor: FakeEditor;
	private readonly _language: string;
	private readonly _changed = new FakeEmitter<ContentEvent>();
	private _text: string;
	private _version = 1;
	private _disposed = false;

	constructor(editor: FakeEditor, text: string, language: string | undefined, uri: FakeUri) {
		this._editor = editor;
		this._text = text;
		this.uri = uri;
		this._language = language ?? LANGUAGES[/\.([^./]+)$/.exec(uri.path)?.[1] ?? ''] ?? 'plaintext';
	}

	getLanguageId(): string {
		return this._language;
	}
	isDisposed(): boolean {
		return this._disposed;
	}
	getValue(): string {
		return this._text;
	}
	getValueLength(): number {
		return this._text.length;
	}
	getEOL(): string {
		return '\n';
	}
	getVersionId(): number {
		return this._version;
	}
	getAlternativeVersionId(): number {
		return this._version;
	}
	getLineCount(): number {
		return this._text.split('\n').length;
	}
	getLineContent(line: number): string {
		return this._text.split('\n')[line - 1] ?? '';
	}
	onDidChangeContent(listener: (e: ContentEvent) => void): Disposable {
		return this._changed.event(listener);
	}

	private offset(line: number, column: number): number {
		const lines = this._text.split('\n');
		let at = 0;
		for (let n = 0; n < line - 1 && n < lines.length; n++) {
			at += lines[n].length + 1;
		}
		return Math.min(this._text.length, at + column - 1);
	}

	getValueInRange(range: Range): string {
		return this._text.slice(this.offset(range.startLineNumber, range.startColumn), this.offset(range.endLineNumber, range.endColumn));
	}

	getWordAtPosition(position: Position): { word: string; startColumn: number; endColumn: number } | null {
		const line = this.getLineContent(position.lineNumber);
		for (const found of line.matchAll(/[\w$]+/g)) {
			const start = found.index + 1;
			const end = start + found[0].length;
			if (start <= position.column && position.column <= end) {
				return { word: found[0], startColumn: start, endColumn: end };
			}
		}
		return null;
	}

	getWordUntilPosition(position: Position): { word: string; startColumn: number; endColumn: number } {
		const word = this.getWordAtPosition(position);
		return word ? { word: word.word.slice(0, position.column - word.startColumn), startColumn: word.startColumn, endColumn: position.column } : { word: '', startColumn: position.column, endColumn: position.column };
	}

	setValue(text: string): void {
		const all = { startLineNumber: 1, startColumn: 1, endLineNumber: this.getLineCount(), endColumn: this.getLineContent(this.getLineCount()).length + 1 };
		const before = this._text.length;
		this._text = text;
		this.history.push('set');
		this._changed.fire({ changes: [{ range: all, rangeLength: before, text }], isFlush: true, isEolChange: false, versionId: ++this._version });
	}

	pushStackElement(): void {
		this.history.push('stop');
	}

	pushEditOperations(_before: unknown, edits: Edit[], _cursor: unknown): null {
		this.applyEdits(edits);
		return null;
	}

	/** Edits against the text as it is. Reported bottom-up, as Monaco does, so each is against the text the one before it left. */
	applyEdits(edits: Edit[]): void {
		const sorted = [...edits].sort((a, b) => b.range.startLineNumber - a.range.startLineNumber || b.range.startColumn - a.range.startColumn);
		const changes: ContentEvent['changes'] = [];
		for (const edit of sorted) {
			const from = this.offset(edit.range.startLineNumber, edit.range.startColumn);
			const to = this.offset(edit.range.endLineNumber, edit.range.endColumn);
			this._text = this._text.slice(0, from) + (edit.text ?? '') + this._text.slice(to);
			changes.push({ range: edit.range, rangeLength: to - from, text: edit.text ?? '' });
		}
		this.history.push('edit');
		this._changed.fire({ changes, isFlush: false, isEolChange: false, versionId: ++this._version });
	}

	/** Text typed at a place (the start of the file unless said). */
	type(text: string, line = 1, column = 1): void {
		this.applyEdits([{ range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column }, text }]);
	}

	dispose(): void {
		if (!this._disposed) {
			this._editor.disposing.fire(this);
			this._disposed = true;
			this._editor.models.delete(this.uri.toString());
		}
	}
}

export interface FakeCodeEditor {
	getModel(): FakeModel | null;
	setPosition(position: Position): void;
	revealPositionInCenter(position: Position): void;
	focus(): void;
}

class FakeEditor {
	readonly models = new Map<string, FakeModel>();
	readonly created = new FakeEmitter<FakeModel>();
	readonly disposing = new FakeEmitter<FakeModel>();
	readonly markers = new Map<string, unknown[]>();
	readonly commands = new Map<string, (...args: unknown[]) => unknown>();
	readonly openers: { openCodeEditor(source: FakeCodeEditor, resource: FakeUri, target?: Range | Position): boolean | Promise<boolean> }[] = [];

	createModel = (text: string, language: string | undefined, uri: FakeUri): FakeModel => {
		const model = new FakeModel(this, text, language, uri);
		this.models.set(uri.toString(), model);
		this.created.fire(model);
		return model;
	};
	getModel = (uri: FakeUri): FakeModel | null => this.models.get(uri.toString()) ?? null;
	getModels = (): FakeModel[] => [...this.models.values()];
	getEditors = (): FakeCodeEditor[] => [];
	onDidCreateModel = (listener: (model: FakeModel) => void): Disposable => this.created.event(listener);
	onWillDisposeModel = (listener: (model: FakeModel) => void): Disposable => this.disposing.event(listener);
	setModelMarkers = (model: FakeModel, owner: string, markers: unknown[]): void => void this.markers.set(`${model.uri.toString()}|${owner}`, markers);
	getModelMarkers = (filter: { resource: FakeUri; owner: string }): unknown[] => this.markers.get(`${filter.resource.toString()}|${filter.owner}`) ?? [];
	registerCommand = (id: string, handler: (...args: unknown[]) => unknown): Disposable => {
		this.commands.set(id, handler);
		return { dispose: () => void this.commands.delete(id) };
	};
	registerEditorOpener = (opener: FakeEditor['openers'][number]): Disposable => {
		this.openers.push(opener);
		return { dispose: () => void this.openers.splice(this.openers.indexOf(opener), 1) };
	};
}

/** The kinds of provider LspService registers: `register<Kind>Provider`. */
const PROVIDERS = [
	'CompletionItem',
	'SignatureHelp',
	'Hover',
	'DocumentHighlight',
	'Declaration',
	'Definition',
	'TypeDefinition',
	'Implementation',
	'Reference',
	'DocumentSymbol',
	'DocumentFormattingEdit',
	'DocumentRangeFormattingEdit',
	'Rename',
	'CodeAction',
	'InlayHints',
] as const;
export type ProviderKind = (typeof PROVIDERS)[number];

/** A provider as it was registered: its methods and whatever else it carries (trigger characters, an event). */
export type FakeProvider = Record<string, unknown>;
interface Registered {
	provider: FakeProvider;
	metadata: unknown;
}

/** A cancellation token a test can fire. */
export interface FakeToken {
	isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): Disposable;
	cancel(): void;
}

export function token(): FakeToken {
	const fired = new FakeEmitter<void>();
	const out: FakeToken = {
		isCancellationRequested: false,
		onCancellationRequested: (listener) => fired.event(listener),
		cancel: () => {
			out.isCancellationRequested = true;
			fired.fire();
		},
	};
	return out;
}

export interface FakeMonaco {
	Uri: typeof FakeUri;
	Emitter: typeof FakeEmitter;
	editor: FakeEditor;
	languages: Record<string, unknown> & { CompletionTriggerKind: { Invoke: 0; TriggerCharacter: 1; TriggerForIncompleteCompletions: 2 } };
	/** What a test looks at; none of it is Monaco's. */
	fake: {
		/** Every `setBuiltInTypeScript(on)` so far. */
		builtIns: boolean[];
		/** The provider of a kind registered for a language (the last one registered), or null. */
		provider(kind: ProviderKind, language: string): FakeProvider | null;
		/** What it was registered with besides itself (a code action provider's kinds). */
		metadata(kind: ProviderKind, language: string): unknown;
		/** Call a provider's method the way the editor would. */
		ask(kind: ProviderKind, language: string, method: string, ...args: unknown[]): Promise<unknown>;
		/** Run an editor command registered with `registerCommand`. */
		run(id: string, ...args: unknown[]): unknown;
		markers(model: FakeModel, owner?: string): unknown[];
	};
}

function createMonaco(): FakeMonaco {
	const editor = new FakeEditor();
	const registered = new Map<string, Registered>();
	const languages: FakeMonaco['languages'] = { CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 } };
	for (const kind of PROVIDERS) {
		languages[`register${kind}Provider`] = (language: string, provider: FakeProvider, metadata?: unknown): Disposable => {
			const slot = `${kind}|${language}`;
			registered.set(slot, { provider, metadata });
			return { dispose: () => void (registered.get(slot)?.provider === provider && registered.delete(slot)) };
		};
	}
	return {
		Uri: FakeUri,
		Emitter: FakeEmitter,
		editor,
		languages,
		fake: {
			builtIns: [],
			provider: (kind, language) => registered.get(`${kind}|${language}`)?.provider ?? null,
			metadata: (kind, language) => registered.get(`${kind}|${language}`)?.metadata,
			ask: async (kind, language, method, ...args) => {
				const provider = registered.get(`${kind}|${language}`)?.provider;
				const call = provider?.[method];
				if (typeof call !== 'function') {
					throw new Error(`no ${kind} provider with ${method} for ${language}`);
				}
				return (call as (...a: unknown[]) => unknown).apply(provider, args);
			},
			run: (id, ...args) => {
				const command = editor.commands.get(id);
				if (!command) {
					throw new Error(`no command ${id}`);
				}
				return command(null, ...args);
			},
			markers: (model, owner = 'lsp') => editor.markers.get(`${model.uri.toString()}|${owner}`) ?? [],
		},
	};
}

/**
 * What stands in for src/shared/monaco.ts:
 * `vi.mock('../shared/monaco', async () => (await import('./lsp-fakes.spec-helper')).monacoModule())`.
 * A mocked module outlives `vi.resetModules()`, so `renew()` (which the real module does not have)
 * gives the next test's app a Monaco of its own.
 */
export function monacoModule(): Record<string, unknown> {
	let monaco = createMonaco();
	return {
		loadMonaco: () => Promise.resolve(monaco),
		setBuiltInTypeScript: (on: boolean) => void monaco.fake.builtIns.push(on),
		adoptMonacoStyles: () => Promise.resolve(),
		releaseMonacoStyles: () => undefined,
		renew: () => (monaco = createMonaco()),
	};
}

// ---- the native side and its servers ------------------------------------------------

/** A server as src-tauri/src/lsp/servers.rs knows it, and how this copy of it behaves. */
export interface ServerSpec {
	/** `typescript`, `php`, `csharp`, `rust`, `python`, `go`. */
	server: string;
	label: string;
	program: string;
	/** The Monaco languages it answers for. */
	languages: string[];
	/** Whose copy `lsp_start` found. */
	source: 'project' | 'managed' | 'path';
	/** What it answers `initialize` with. */
	capabilities: Record<string, unknown>;
	initializationOptions: unknown;
	/** What it does with `initialize`: answers, answers with an error, says nothing, or exits. */
	handshake: 'accept' | 'refuse' | 'silent' | 'die';
	/** The error it refuses with, or its last words when it exits. */
	says: string;
}

const KNOWN: Record<string, Pick<ServerSpec, 'label' | 'program' | 'languages'>> = {
	typescript: { label: 'TypeScript and JavaScript', program: 'typescript-language-server', languages: ['typescript', 'javascript'] },
	php: { label: 'PHP', program: 'intelephense', languages: ['php'] },
	csharp: { label: 'C#', program: 'csharp-ls', languages: ['csharp'] },
	rust: { label: 'Rust', program: 'rust-analyzer', languages: ['rust'] },
	python: { label: 'Python', program: 'pyright-langserver', languages: ['python'] },
	go: { label: 'Go', program: 'gopls', languages: ['go'] },
};

type Reply = (params: never, message: LspMessage) => unknown;

/** One server process: what the client sent it, and the means to answer and to speak first. */
export class FakeServer {
	readonly key: string;
	readonly root: string;
	readonly slot: string;
	readonly spec: ServerSpec;
	alive = true;
	/** Every message the client sent, in the order it arrived. */
	readonly received: LspMessage[] = [];
	private readonly _w: World;
	private readonly _replies = new Map<string, Reply>();
	private readonly _errors = new Map<string, string>();
	private readonly _held = new Set<string>();
	private readonly _answered = new Set<number | string>();
	private readonly _watchers: ((message: LspMessage) => void)[] = [];
	private _next = 1;

	constructor(w: World, spec: ServerSpec, root: string, n: number) {
		this._w = w;
		this.spec = spec;
		this.root = root;
		this.slot = `${spec.program}@${root}`;
		this.key = `${this.slot}#${n}`;
	}

	/** A message from the client has arrived. */
	take(message: LspMessage): void {
		this.received.push(message);
		if (message.method === undefined) {
			return; // its answer to something this server asked
		}
		this._watchers.forEach((watcher) => watcher(message));
		if (message.id === undefined || message.id === null) {
			return; // a notification
		}
		if (message.method === 'initialize') {
			if (this.spec.handshake === 'accept') {
				this.respond(message.id, { capabilities: this.spec.capabilities });
			} else if (this.spec.handshake === 'refuse') {
				this.respond(message.id, undefined, this.spec.says);
			} else if (this.spec.handshake === 'die') {
				this.die(this.spec.says);
			}
			return;
		}
		if (this._held.has(message.method)) {
			return;
		}
		const error = this._errors.get(message.method);
		const reply = this._replies.get(message.method);
		this.respond(message.id, error || !reply ? null : reply(message.params as never, message), error);
	}

	private respond(id: number | string, result: unknown, error?: string): void {
		this._answered.add(id);
		// Not in the same breath as the message arriving: a real answer is another event.
		queueMicrotask(() => this.alive && this._w.emit('lsp-message', { key: this.key, message: error === undefined ? { jsonrpc: '2.0', id, result } : { jsonrpc: '2.0', id, error: { code: -32603, message: error } } }));
	}

	/** Answer every request of `method` with what `answer` makes of its params. Anything not set up is answered null. */
	reply(method: string, answer: Reply): void {
		this._errors.delete(method);
		this._held.delete(method);
		this._replies.set(method, answer);
	}

	/** Answer every request of `method` with an error. */
	refuse(method: string, message: string): void {
		this._errors.set(method, message);
	}

	/** Leave requests of `method` unanswered until `release`. */
	hold(method: string): void {
		this._held.add(method);
	}

	/** Answer the requests of `method` that were left waiting, and answer the next ones at once again. */
	release(method: string, result: unknown = null): void {
		this._held.delete(method);
		for (const message of this.requests(method)) {
			if (!this._answered.has(message.id!)) {
				this.respond(message.id!, result);
			}
		}
	}

	/** Called with every request and notification of `method` as it arrives. */
	on(method: string, watcher: (params: never) => void): void {
		this._watchers.push((message) => message.method === method && watcher(message.params as never));
	}

	/** The requests of a method, whole (for their ids). */
	requests(method: string): LspMessage[] {
		return this.received.filter((m) => m.method === method && m.id !== undefined && m.id !== null);
	}

	/** The params of every request and notification of a method, in order. */
	sent<T = Record<string, unknown>>(method: string): T[] {
		return this.received.filter((m) => m.method === method).map((m) => m.params as T);
	}

	/** The methods of everything the client sent, in order (its answers to this server's own requests left out). */
	methods(): string[] {
		return this.received.flatMap((m) => (m.method === undefined ? [] : [m.method]));
	}

	/** Forget what was received so far. */
	clear(): void {
		this.received.length = 0;
	}

	/** A notification from the server. */
	notify(method: string, params: unknown): void {
		this._w.emit('lsp-message', { key: this.key, message: { jsonrpc: '2.0', method, params } });
	}

	/** A request from the server; resolves nothing by itself, see `answer`. */
	ask(method: string, params: unknown): number {
		const id = this._next++;
		this._w.emit('lsp-message', { key: this.key, message: { jsonrpc: '2.0', id, method, params } });
		return id;
	}

	/** What the client answered a request of this server with: its `result`, or undefined while it has not. */
	answer(id: number): unknown {
		const found = this.received.find((m) => m.method === undefined && m.id === id);
		return found ? (found.error ? { error: found.error } : found.result) : undefined;
	}

	publish(uri: string, diagnostics: LspDiagnostic[]): void {
		this.notify('textDocument/publishDiagnostics', { uri, diagnostics });
	}

	progress(token: string | number, value: Record<string, unknown>): void {
		this.notify('$/progress', { token, value });
	}

	/** It exits by itself. */
	die(error: string | null = null): void {
		this.alive = false;
		this._w.emit('lsp-closed', { key: this.key, server: this.spec.server, label: this.spec.label, expected: false, error });
	}

	/** The app stopped it. */
	stopped(): void {
		if (this.alive) {
			this.alive = false;
			queueMicrotask(() => this._w.emit('lsp-closed', { key: this.key, server: this.spec.server, label: this.spec.label, expected: true, error: null }));
		}
	}
}

/** `lsp_start`, `lsp_send` and `lsp_stop`, answered the way src-tauri/src/lsp.rs does. */
export class FakeNative {
	/** Every server process started, in order; the dead ones too. */
	readonly started: FakeServer[] = [];
	/** Called with each new process before it is sent anything, to set up how it answers. */
	readonly starting: ((server: FakeServer) => void)[] = [];
	/** How long the carrier takes over a message, in ms. Nothing by default. */
	delay: (message: LspMessage) => number = () => 0;
	/** The most `lsp_send` calls that were ever under way at once. */
	busiest = 0;
	private _sending = 0;
	private readonly _w: World;
	private readonly _specs = new Map<string, ServerSpec>();

	/** `root`: the active checkout, where a server starts when `lsp_start` names no folder. */
	constructor(w: World, root: () => string) {
		this._w = w;
		w.on('lsp_start', (args) => {
			const spec = [...this._specs.values()].find((s) => s.languages.includes(String(args.language)));
			if (!spec) {
				return null; // no server for that language is installed
			}
			const at = (args.cwd as string | undefined) ?? root();
			const running = this.started.find((s) => s.alive && s.slot === `${spec.program}@${at}`);
			const server = running ?? new FakeServer(w, spec, at, this.started.length + 1);
			if (!running) {
				this.started.push(server);
				this.starting.forEach((prepare) => prepare(server));
			}
			return { key: server.key, root: at, fresh: !running, server: spec.server, label: spec.label, source: spec.source, initializationOptions: spec.initializationOptions };
		});
		w.on('lsp_send', async (args) => {
			const message = args.message as LspMessage;
			const server = this.started.find((s) => s.alive && s.key === args.key);
			if (!server) {
				throw { kind: 'error', message: 'That language server is not running', paths: [] };
			}
			this.busiest = Math.max(this.busiest, ++this._sending);
			const wait = this.delay(message);
			if (wait > 0) {
				await new Promise((done) => setTimeout(done, wait));
			}
			this._sending--;
			server.take(message);
		});
		w.on('lsp_stop', (args) => this.started.find((s) => s.key === args.key)?.stopped());
	}

	/** Make a server available: one of the known ones by name, answering `initialize` with `capabilities`. */
	install(server: string, capabilities: Record<string, unknown> = {}, more: Partial<ServerSpec> = {}): ServerSpec {
		const spec: ServerSpec = { server, ...KNOWN[server], source: 'managed', capabilities, initializationOptions: null, handshake: 'accept', says: '', ...more };
		this._specs.set(server, spec);
		return spec;
	}

	uninstall(server: string): void {
		this._specs.delete(server);
	}

	/** A server process that is up before the app asks for one (left over from before a reload). */
	leftover(server: string, root: string): FakeServer {
		const process = new FakeServer(this._w, this._specs.get(server)!, root, this.started.length + 1);
		this.started.push(process);
		return process;
	}

	/** The running process of a server, the one started last; throws when there is none. */
	server(name: string, root?: string): FakeServer {
		const found = [...this.started].reverse().find((s) => s.alive && s.spec.server === name && (root === undefined || s.root === root));
		if (!found) {
			throw new Error(`no ${name} server is running${root ? ` in ${root}` : ''}`);
		}
		return found;
	}

	/** The running processes. */
	running(): FakeServer[] {
		return this.started.filter((s) => s.alive);
	}
}
