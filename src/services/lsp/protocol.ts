/**
 * The part of the language-server client that needs neither Monaco nor the
 * window: JSON-RPC bookkeeping, the `initialize` handshake, and turning the
 * protocol's answers into the plain shapes Monaco takes (1-based ranges).
 *
 * `scripts/lsp-smoke.mjs` loads this file straight into Node and runs it
 * against real servers over stdio, so keep it free of imports and of syntax
 * Node cannot strip (enums, constructor parameter properties, decorators).
 */

export interface LspPosition {
	line: number;
	character: number;
}
export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}
export interface LspMessage {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string } | null;
}
/** A request the asker may give up on. Monaco's CancellationToken has this shape. */
export interface Cancel {
	isCancellationRequested: boolean;
	onCancellationRequested(listener: () => void): { dispose(): void };
}
export interface LspDiagnostic {
	range: LspRange;
	message: string;
	severity?: number;
	source?: string;
	code?: string | number | { value: string | number };
	tags?: number[];
}

/** What `lsp_start` answers; see `Started` in src-tauri/src/lsp.rs. */
export interface Started {
	/** Names this server process in `lsp_send` and in `lsp-message` events. */
	key: string;
	/** The checkout folder the server was started in. */
	root: string;
	/** False when it was already running (and so is already initialised). */
	fresh: boolean;
	/** Which server it is: `typescript`, `php`, `csharp`, `rust`, ... */
	server: string;
	/** Its name for people: `TypeScript and JavaScript`, `C#`, ... */
	label?: string;
	/** Whose copy it is: the project's own, the one the app installed, or one on PATH. */
	source?: 'project' | 'managed' | 'path';
	/** Sent as `initializationOptions`; worked out natively because it is mostly paths. */
	initializationOptions: unknown;
}

/** A range as Monaco counts it: lines and columns from 1. */
export interface EditorRange {
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}
export interface EditorLocation {
	uri: string;
	range: EditorRange;
}
export interface EditorSymbol {
	name: string;
	detail: string;
	kind: number;
	tags: number[];
	range: EditorRange;
	selectionRange: EditorRange;
	children: EditorSymbol[];
}
export interface EditorMarker extends EditorRange {
	message: string;
	severity: number;
	source?: string;
	code?: string;
	tags?: number[];
}

/**
 * Monaco says `typescript` for .ts and .tsx alike; the protocol wants the React
 * flavours named, or the server reads JSX as a syntax error.
 */
export function languageId(monacoLanguage: string, path: string): string {
	const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
	if (monacoLanguage === 'typescript' && extension === 'tsx') {
		return 'typescriptreact';
	}
	if (monacoLanguage === 'javascript' && extension === 'jsx') {
		return 'javascriptreact';
	}
	return monacoLanguage;
}

/**
 * The Monaco language id of a file the editor has not opened (an agent's changed files, checked
 * when its turn ends), for the languages there is a server for. Open files get theirs from Monaco.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	ts: 'typescript',
	tsx: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	rs: 'rust',
	py: 'python',
	go: 'go',
	php: 'php',
	cs: 'csharp',
};

export function languageOf(path: string): string | null {
	const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
	return (extension && LANGUAGE_BY_EXTENSION[extension]) || null;
}

function folderName(root: string): string {
	return root.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace';
}

/** The `initialize` request. `capabilities` is src/services/lsp/capabilities.json. */
export function initializeParams(started: Pick<Started, 'root' | 'initializationOptions'>, rootUri: string, capabilities: unknown, server?: string): Record<string, unknown> {
	const params: Record<string, unknown> = {
		processId: null,
		clientInfo: { name: 'Melodic Studio' },
		rootPath: started.root,
		rootUri,
		workspaceFolders: [{ uri: rootUri, name: folderName(started.root) }],
		capabilities,
	};
	const ours = OPTIONS[server ?? ''];
	if (ours || (started.initializationOptions !== null && started.initializationOptions !== undefined)) {
		params.initializationOptions = { ...ours, ...(started.initializationOptions as Record<string, unknown> | null) };
	}
	return params;
}

/** `initializationOptions` that are about behaviour, by server (the native side adds the ones that are paths). */
const OPTIONS: Record<string, Record<string, unknown>> = {
	// Renaming a function where it is used renames it everywhere. TypeScript's default instead leaves
	// the function alone and aliases the import (`import { greet as welcome }`), which is rarely what was meant.
	typescript: { preferences: { providePrefixAndSuffixTextForRename: false } },
};

/**
 * What we answer `workspace/configuration` with, by server and then section. Everything else
 * gets null, which the protocol reads as "no setting: use your default".
 */
const SETTINGS: Record<string, Record<string, unknown>> = {
	// csharp-ls falls over null for its own section (it logs a NullReferenceException); an empty object it takes.
	csharp: { csharp: {} },
};

/** One running server: request/response bookkeeping over whatever carries the messages. */
export class Client {
	readonly key: string;
	readonly root: string;
	readonly server: string;
	readonly rootUri: string;
	/** Resolves once the handshake is over; false when the server did not accept it. */
	ready: Promise<boolean> = Promise.resolve(false);
	/** What the server said it can do, from its `initialize` answer. */
	capabilities: Record<string, unknown> = {};
	/** True from a successful handshake until the server is gone. */
	live = false;
	/** The message of the last error answer, e.g. why `initialize` was refused. */
	error: string | null = null;

	private readonly _started: Started;
	private readonly _send: (message: unknown) => Promise<void>;
	/** Methods the server asked to be told about after the handshake (`client/registerCapability`). */
	readonly registered = new Set<string>();

	/**
	 * Requests from the server that take doing something (`workspace/applyEdit`): return a promise
	 * of the answer, or undefined to leave the request to the stock answers below.
	 */
	handler: ((method: string, params: unknown) => Promise<unknown> | undefined) | null = null;

	private _next = 1;
	private readonly _pending = new Map<number, (result: unknown) => void>();
	private _queue: Promise<void> = Promise.resolve();

	constructor(started: Started, rootUri: string, send: (message: unknown) => Promise<void>) {
		this._started = started;
		this.key = started.key;
		this.root = started.root;
		this.server = started.server;
		this.rootUri = rootUri;
		this._send = send;
	}

	/**
	 * One message at a time, in the order asked. The carrier's calls may overtake each other, and an
	 * edit must not arrive after the question about it (or, sent as a change, after the next edit).
	 */
	private send(message: unknown): Promise<void> {
		const sent = this._queue.then(() => this._send(message));
		this._queue = sent.catch(() => undefined);
		return sent;
	}

	/**
	 * Resolves to null on an error answer, a dead server, no answer in `timeout` ms, or when `cancel`
	 * fires; the server is then told to stop working on it.
	 */
	request<T>(method: string, params: unknown, timeout = 15_000, cancel?: Cancel): Promise<T | null> {
		if (cancel?.isCancellationRequested) {
			return Promise.resolve(null);
		}
		const id = this._next++;
		return new Promise((resolve) => {
			const abandon = (): void => {
				if (this._pending.has(id)) {
					this.settle(id, null);
					this.notify('$/cancelRequest', { id });
				}
			};
			// A server that never answers must not leave the editor waiting.
			const timer = setTimeout(abandon, timeout);
			const watch = cancel?.onCancellationRequested(abandon);
			this._pending.set(id, (result) => {
				clearTimeout(timer);
				watch?.dispose();
				resolve(result as T | null);
			});
			this.send({ jsonrpc: '2.0', id, method, params }).catch(() => this.settle(id, null));
		});
	}

	notify(method: string, params: unknown): void {
		void this.send({ jsonrpc: '2.0', method, params }).catch(() => undefined);
	}

	/** `initialize`, then `initialized`. A slow first start (a big solution, a cold cache) gets a minute. */
	initialize(capabilities: unknown): Promise<boolean> {
		this.ready = this.request<{ capabilities?: Record<string, unknown> }>('initialize', initializeParams(this._started, this.rootUri, capabilities, this.server), 60_000).then((result) => {
			if (!result) {
				return false;
			}
			this.capabilities = result.capabilities ?? {};
			this.live = true;
			this.notify('initialized', {});
			return true;
		});
		return this.ready;
	}

	private settle(id: number, result: unknown): void {
		const resolve = this._pending.get(id);
		if (resolve) {
			this._pending.delete(id);
			resolve(result);
		}
	}

	/** Returns the message when it is a notification the caller should look at. */
	receive(message: LspMessage): LspMessage | null {
		if (message.method === undefined) {
			// Not for a request already given up on: its "cancelled" answer says nothing about the server.
			if (message.error && typeof message.id === 'number' && this._pending.has(message.id)) {
				this.error = message.error.message ?? `Error ${message.error.code ?? ''}`.trim();
			}
			if (typeof message.id === 'number') {
				this.settle(message.id, message.error ? null : (message.result ?? null));
			}
			return null;
		}
		if (message.id !== undefined && message.id !== null) {
			// The server is asking us something. Answer so it carries on.
			const id = message.id;
			const work = this.handler?.(message.method, message.params);
			if (work) {
				work.then(
					(result) => this.send({ jsonrpc: '2.0', id, result }),
					(e: unknown) => this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } })
				).catch(() => undefined);
			} else {
				void this.send({ jsonrpc: '2.0', id, result: this.answer(message) }).catch(() => undefined);
			}
			return null;
		}
		return message;
	}

	private answer(message: LspMessage): unknown {
		switch (message.method) {
			case 'workspace/configuration': {
				const items = (message.params as { items?: { section?: string }[] } | undefined)?.items;
				return (items ?? []).map((item) => SETTINGS[this.server]?.[item?.section ?? ''] ?? null);
			}
			case 'workspace/workspaceFolders':
				return [{ uri: this.rootUri, name: folderName(this.root) }];
			case 'client/registerCapability':
			case 'client/unregisterCapability': {
				// The second one's list really is spelled "unregisterations" in the protocol.
				const p = (message.params ?? {}) as { registrations?: { method?: string }[]; unregisterations?: { method?: string }[] };
				(p.registrations ?? []).forEach((r) => r.method && this.registered.add(r.method));
				(p.unregisterations ?? []).forEach((r) => r.method && this.registered.delete(r.method));
				return null;
			}
			default:
				// window/workDoneProgress/create, window/showMessageRequest, ...
				return null;
		}
	}

	/** The server is gone: nothing more will be answered. */
	close(): void {
		this.live = false;
		[...this._pending.keys()].forEach((id) => this.settle(id, null));
	}
}

// ---- answers, in the shapes Monaco takes ---------------------------------------

export function editorRange(r: LspRange): EditorRange {
	return { startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 };
}

/** A hover's `contents` (MarkupContent, MarkedString or a list of them) as markdown strings. */
export function hoverContents(contents: unknown): string[] {
	const parts = Array.isArray(contents) ? contents : [contents];
	return parts
		.map((part: unknown) => {
			if (typeof part === 'string') {
				return part;
			}
			const p = (part ?? {}) as { kind?: string; language?: string; value?: string };
			return p.language ? `\`\`\`${p.language}\n${p.value ?? ''}\n\`\`\`` : (p.value ?? '');
		})
		.filter((value) => value.trim() !== '');
}

/** Definition / references answers: a Location, a list of them, or LocationLinks. */
export function locations(result: unknown): EditorLocation[] {
	interface Loc {
		uri?: string;
		range?: LspRange;
		targetUri?: string;
		targetRange?: LspRange;
		targetSelectionRange?: LspRange;
	}
	const list = !result ? [] : Array.isArray(result) ? (result as Loc[]) : [result as Loc];
	const out: EditorLocation[] = [];
	for (const l of list) {
		const uri = l.targetUri ?? l.uri;
		const range = l.targetSelectionRange ?? l.targetRange ?? l.range;
		if (uri && range) {
			out.push({ uri, range: editorRange(range) });
		}
	}
	return out;
}

/** Document symbols, hierarchical (DocumentSymbol) or flat (SymbolInformation). */
export function documentSymbols(result: unknown): EditorSymbol[] {
	interface Sym {
		name: string;
		detail?: string;
		kind: number;
		tags?: number[];
		range?: LspRange;
		selectionRange?: LspRange;
		location?: { range: LspRange };
		children?: Sym[];
	}
	const convert = (s: Sym): EditorSymbol | null => {
		const range = s.range ?? s.location?.range;
		if (!range) {
			return null;
		}
		return {
			name: s.name || '(anonymous)',
			detail: s.detail ?? '',
			// The protocol counts symbol kinds from 1, Monaco from 0.
			kind: s.kind - 1,
			tags: s.tags ?? [],
			range: editorRange(range),
			selectionRange: editorRange(s.selectionRange ?? range),
			children: (s.children ?? []).map(convert).filter((c): c is EditorSymbol => c !== null),
		};
	};
	return (Array.isArray(result) ? (result as Sym[]) : []).map(convert).filter((c): c is EditorSymbol => c !== null);
}

/** Protocol severity (1 error .. 4 hint) to Monaco's MarkerSeverity (8 error, 4 warning, 2 info, 1 hint). */
const MARKER_SEVERITY = [8, 8, 4, 2, 1];

export function markers(diagnostics: LspDiagnostic[]): EditorMarker[] {
	return diagnostics.map((d) => {
		const code = typeof d.code === 'object' && d.code !== null ? d.code.value : d.code;
		return {
			...editorRange(d.range),
			message: d.message,
			severity: MARKER_SEVERITY[d.severity ?? 1] ?? 8,
			source: d.source,
			code: code === undefined ? undefined : String(code),
			// Unnecessary (1) and deprecated (2) are numbered the same on both sides.
			tags: d.tags,
		};
	});
}

// ---- keeping the server's copy of a document in step ---------------------------

export function lspRange(r: EditorRange): LspRange {
	return { start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } };
}

interface SyncOptions {
	change?: number;
	save?: boolean | { includeText?: boolean };
}

/** How the server wants edits: 0 not at all, 1 the whole text every time, 2 only what changed. */
export function syncKind(capabilities: Record<string, unknown>): 0 | 1 | 2 {
	const sync = capabilities.textDocumentSync as number | SyncOptions | undefined;
	const kind = typeof sync === 'number' ? sync : (sync?.change ?? 0);
	return kind === 1 || kind === 2 ? kind : 0;
}

/** Whether the server wants to hear about saves, and with the text or without. */
export function saveWanted(capabilities: Record<string, unknown>): { includeText: boolean } | null {
	const sync = capabilities.textDocumentSync as number | SyncOptions | undefined;
	if (typeof sync === 'number') {
		// The short form: a server that follows documents at all also follows their saves.
		return sync === 0 ? null : { includeText: false };
	}
	const save = sync?.save;
	return save ? { includeText: typeof save === 'object' && save.includeText === true } : null;
}

/** One edit as Monaco reports it: the range it replaced (in the text before it) and what went in. */
export interface EditorChange {
	range: EditorRange;
	text: string;
}

/**
 * The `contentChanges` of a `didChange`. `edits` are in the order they were made, each against the text
 * the one before it left (Monaco lists the edits of one keystroke bottom-up, which is that order);
 * null means they were not kept (the whole text was replaced, or there were too many), so send it all.
 */
export function contentChanges(kind: 0 | 1 | 2, edits: EditorChange[] | null, text: () => string): unknown[] {
	if (kind === 2 && edits) {
		return edits.map((e) => ({ range: lspRange(e.range), text: e.text }));
	}
	return [{ text: text() }];
}

// ---- work the server reports on (indexing, loading a solution) -----------------

export interface Progress {
	token: string;
	kind: 'begin' | 'report' | 'end';
	title?: string;
	message?: string;
	percentage?: number;
}

/** The params of a `$/progress` notification, when it is about work in progress. */
export function progress(params: unknown): Progress | null {
	const p = (params ?? {}) as { token?: string | number; value?: { kind?: string; title?: string; message?: string; percentage?: number } };
	const kind = p.value?.kind;
	if (p.token === undefined || (kind !== 'begin' && kind !== 'report' && kind !== 'end')) {
		return null;
	}
	return { token: String(p.token), kind, title: p.value?.title, message: p.value?.message, percentage: typeof p.value?.percentage === 'number' ? p.value.percentage : undefined };
}

// ---- completion ----------------------------------------------------------------

/** Documentation as Monaco takes it: plain text as a string, Markdown as `{ value }`. */
export type EditorDoc = string | { value: string };

function documentation(doc: unknown): EditorDoc | undefined {
	if (typeof doc === 'string') {
		return doc || undefined;
	}
	const d = (doc ?? {}) as { kind?: string; value?: string };
	if (!d.value) {
		return undefined;
	}
	return d.kind === 'markdown' ? { value: d.value } : d.value;
}

export interface EditorTextEdit {
	range: EditorRange;
	text: string;
}

export function textEdits(edits: unknown): EditorTextEdit[] {
	return (Array.isArray(edits) ? (edits as { range?: LspRange; newText?: string }[]) : []).filter((e) => e?.range).map((e) => ({ range: editorRange(e.range as LspRange), text: e.newText ?? '' }));
}

/** Where a completion goes when it does not say: `insert` up to the cursor, `replace` to the end of the word. */
export interface CompletionRanges {
	insert: EditorRange;
	replace: EditorRange;
}

export interface EditorCompletion {
	label: string | { label: string; detail?: string; description?: string };
	kind: number;
	tags?: number[];
	detail?: string;
	documentation?: EditorDoc;
	sortText?: string;
	filterText?: string;
	preselect?: boolean;
	insertText: string;
	insertTextRules?: number;
	range: EditorRange | CompletionRanges;
	commitCharacters?: string[];
	additionalTextEdits?: EditorTextEdit[];
	command?: { id: string; title: string };
	/** The server's own item, which `completionItem/resolve` wants back. */
	item: unknown;
}

/**
 * Completion kinds, protocol (index, from 1) to Monaco's CompletionItemKind. The two lists hold the
 * same names in different orders; protocol.test.ts checks this against Monaco's own enum.
 */
export const COMPLETION_KIND = [18, 18, 0, 1, 2, 3, 4, 5, 7, 8, 9, 12, 13, 15, 17, 28, 19, 20, 21, 23, 16, 14, 6, 10, 11, 24];

/** Commands a completion may run once accepted. Only the editor's own; a server's would need the server. */
const EDITOR_COMMANDS = ['editor.action.triggerSuggest', 'editor.action.triggerParameterHints'];

interface LspCompletionItem {
	label: string;
	labelDetails?: { detail?: string; description?: string };
	kind?: number;
	tags?: number[];
	deprecated?: boolean;
	detail?: string;
	documentation?: unknown;
	sortText?: string;
	filterText?: string;
	preselect?: boolean;
	insertText?: string;
	insertTextFormat?: number;
	textEdit?: { range?: LspRange; insert?: LspRange; replace?: LspRange; newText: string };
	additionalTextEdits?: unknown;
	commitCharacters?: string[];
	command?: { command?: string; title?: string };
}

function completion(item: LspCompletionItem, fallback: CompletionRanges): EditorCompletion {
	const edit = item.textEdit;
	const range = edit?.insert && edit.replace ? { insert: editorRange(edit.insert), replace: editorRange(edit.replace) } : edit?.range ? editorRange(edit.range) : fallback;
	const details = item.labelDetails;
	const out: EditorCompletion = {
		label: details?.detail || details?.description ? { label: item.label, detail: details.detail, description: details.description } : item.label,
		kind: COMPLETION_KIND[item.kind ?? 1] ?? 18,
		insertText: edit?.newText ?? item.insertText ?? item.label,
		range,
		item,
	};
	// Only what the server gave: a list can hold thousands of these.
	if (item.tags?.includes(1) || item.deprecated) {
		out.tags = [1];
	}
	if (item.detail) {
		out.detail = item.detail;
	}
	const doc = documentation(item.documentation);
	if (doc) {
		out.documentation = doc;
	}
	if (item.sortText) {
		out.sortText = item.sortText;
	}
	if (item.filterText) {
		out.filterText = item.filterText;
	}
	if (item.preselect) {
		out.preselect = true;
	}
	if (item.insertTextFormat === 2) {
		out.insertTextRules = 4; // a snippet: tab stops and placeholders, same syntax on both sides
	}
	if (item.commitCharacters?.length) {
		out.commitCharacters = item.commitCharacters;
	}
	const extra = textEdits(item.additionalTextEdits);
	if (extra.length) {
		out.additionalTextEdits = extra;
	}
	if (item.command?.command && EDITOR_COMMANDS.includes(item.command.command)) {
		out.command = { id: item.command.command, title: item.command.title ?? '' };
	}
	return out;
}

/** A `textDocument/completion` answer: a list of items, or a CompletionList. */
export function completions(result: unknown, fallback: CompletionRanges): { suggestions: EditorCompletion[]; incomplete: boolean } {
	const list = (Array.isArray(result) ? { items: result } : (result ?? {})) as { isIncomplete?: boolean; items?: LspCompletionItem[] };
	return { suggestions: (list.items ?? []).filter((item) => typeof item?.label === 'string').map((item) => completion(item, fallback)), incomplete: list.isIncomplete === true };
}

/** What `completionItem/resolve` added to an item: the slow parts (documentation, the import to add). */
export function resolved(shown: EditorCompletion, answer: unknown): EditorCompletion {
	if (!answer) {
		return shown;
	}
	const full = completion(answer as LspCompletionItem, 'insert' in shown.range ? shown.range : { insert: shown.range, replace: shown.range });
	const out = { ...shown, item: answer };
	if (full.detail) {
		out.detail = full.detail;
	}
	if (full.documentation) {
		out.documentation = full.documentation;
	}
	if (full.additionalTextEdits) {
		out.additionalTextEdits = full.additionalTextEdits;
	}
	return out;
}

/** The characters a server wants completion (or signature help) to open on by itself. */
export function triggerCharacters(capabilities: Record<string, unknown>, provider: 'completionProvider' | 'signatureHelpProvider'): string[] {
	const p = capabilities[provider] as { triggerCharacters?: string[]; retriggerCharacters?: string[] } | undefined;
	return [...(p?.triggerCharacters ?? []), ...(p?.retriggerCharacters ?? [])];
}

// ---- signature help and highlights ---------------------------------------------

export interface EditorSignatureHelp {
	signatures: { label: string; documentation?: EditorDoc; parameters: { label: string | [number, number]; documentation?: EditorDoc }[]; activeParameter?: number }[];
	activeSignature: number;
	activeParameter: number;
	/** The server's own answer, which it wants back when asked again while this is showing. */
	raw: unknown;
}

export function signatureHelp(result: unknown): EditorSignatureHelp | null {
	interface Param {
		label: string | [number, number];
		documentation?: unknown;
	}
	interface Sig {
		label: string;
		documentation?: unknown;
		parameters?: Param[];
		activeParameter?: number | null;
	}
	const r = (result ?? {}) as { signatures?: Sig[]; activeSignature?: number; activeParameter?: number | null };
	if (!r.signatures?.length) {
		return null;
	}
	return {
		signatures: r.signatures.map((s) => ({
			label: s.label,
			documentation: documentation(s.documentation),
			parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: documentation(p.documentation) })),
			activeParameter: typeof s.activeParameter === 'number' ? s.activeParameter : undefined,
		})),
		activeSignature: Math.min(r.activeSignature ?? 0, r.signatures.length - 1),
		activeParameter: r.activeParameter ?? 0,
		raw: result,
	};
}

/** `textDocument/documentHighlight`: the other places the name under the cursor is used in this file. */
export function highlights(result: unknown): { range: EditorRange; kind: number }[] {
	// Kinds (text, read, write) count from 1 in the protocol and from 0 in Monaco.
	return (Array.isArray(result) ? (result as { range?: LspRange; kind?: number }[]) : []).filter((h) => h?.range).map((h) => ({ range: editorRange(h.range as LspRange), kind: (h.kind ?? 1) - 1 }));
}

// ---- what a change touched, and what is new since it -----------------------------

/** Lines `from`..`to` of a file (1-based, inclusive). */
export type Span = [from: number, to: number];

/**
 * The parts of the old file a unified diff touches: each removed line, and for lines put in between
 * two old ones the pair they went between (so only a symbol holding both counts as touched: a
 * function added after another one is not a change to it). Not the hunks' own ranges, which carry
 * three lines of context either side and would make the neighbours of a change look changed.
 */
export function oldSpans(diff: string): Span[] {
	const out: Span[] = [];
	let old = 0;
	let inHunk = false;
	let removing = false;
	for (const line of diff.split('\n')) {
		const head = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
		if (head) {
			// With nothing on the old side, the number is the line the new ones come after.
			old = Number(head[1]) + (head[2] === '0' ? 1 : 0);
			inHunk = true;
			removing = false;
		} else if (!inHunk || line.startsWith('\\')) {
			continue; // the file header, or "\ No newline at end of file"
		} else if (line.startsWith('-')) {
			out.push([old, old]);
			old++;
			removing = true;
		} else if (line.startsWith('+')) {
			// Right after removed lines it is their replacement, which those already stand for.
			const last = out[out.length - 1];
			if (!removing && !(last && last[0] === old - 1 && last[1] === old)) {
				out.push([old - 1, old]);
			}
		} else if (line.startsWith(' ') || line === '') {
			old++;
			removing = false;
		} else {
			inHunk = false; // the next file's header
		}
	}
	return out;
}

/** The innermost symbols of an outline that hold one of `spans` whole, each once, in outline order. */
export function symbolsAt(symbols: EditorSymbol[], spans: Span[]): EditorSymbol[] {
	const out: EditorSymbol[] = [];
	const holds = (symbol: EditorSymbol, span: Span): boolean => span[0] >= symbol.range.startLineNumber && span[1] <= symbol.range.endLineNumber;
	const visit = (symbol: EditorSymbol, mine: Span[]): void => {
		const inside = mine.filter((span) => holds(symbol, span));
		if (!inside.length) {
			return;
		}
		const before = out.length;
		symbol.children.forEach((child) => visit(child, inside));
		// A span in no child is the symbol's own (its signature, a member added to it).
		if (inside.some((span) => !symbol.children.some((child) => holds(child, span)))) {
			out.splice(before, 0, symbol);
		}
	};
	symbols.forEach((symbol) => visit(symbol, spans));
	return out;
}

/** An error with what identifies it across two versions of a file: lines move, the code and the message do not. */
export interface Located {
	path: string;
	line: number;
	message: string;
	/** The line of code it is on, trimmed. */
	code: string;
}

/**
 * The errors in `after` that `before` does not account for. An error is the same one when it is in the
 * same file, says the same thing and sits on the same code, wherever that line has moved to; each
 * earlier error accounts for one later one.
 */
export function newSince<T extends Located>(before: Located[], after: T[]): T[] {
	const key = (e: Located): string => `${e.path}\n${e.message}\n${e.code}`;
	const had = new Map<string, number>();
	before.forEach((e) => had.set(key(e), (had.get(key(e)) ?? 0) + 1));
	return after.filter((e) => {
		const left = had.get(key(e)) ?? 0;
		if (left > 0) {
			had.set(key(e), left - 1);
			return false;
		}
		return true;
	});
}

// ---- files that change on disk without the editor ---------------------------------

/**
 * The servers that hear of files changing on disk only from the client (`workspace/didChangeWatchedFiles`).
 * The others (TypeScript, rust-analyzer, Pyright) watch the disk themselves, and stop doing so when
 * a client offers to tell them, so the offer is made to these alone.
 */
const TOLD_OF_CHANGES = ['go', 'php', 'csharp'];
export const WATCHED_FILES = 'workspace/didChangeWatchedFiles';

/** capabilities.json, as it is sent to one server. */
export function clientCapabilities(base: Record<string, unknown>, server: string): Record<string, unknown> {
	if (!TOLD_OF_CHANGES.includes(server)) {
		return base;
	}
	return { ...base, workspace: { ...(base.workspace as Record<string, unknown> | undefined), didChangeWatchedFiles: { dynamicRegistration: true } } };
}

/** A file of a checkout that came (1), changed (2) or went (3) on disk. `path` is repository-relative. */
export interface DiskChange {
	path: string;
	type: 1 | 2 | 3;
}

interface StatusEntry {
	path: string;
	oldPath?: string | null;
	status: string;
}

/** What a list of changes relative to a commit says happened to the files since that commit. */
export function changesSince(files: StatusEntry[]): DiskChange[] {
	const out: DiskChange[] = [];
	for (const file of files) {
		if (file.status === 'renamed' && file.oldPath) {
			out.push({ path: file.oldPath, type: 3 });
		}
		out.push({ path: file.path, type: file.status === 'deleted' ? 3 : file.status === 'modified' || file.status === 'conflicted' ? 2 : 1 });
	}
	return out;
}

/**
 * What happened on disk between two looks at a checkout's status, with the same commit checked out
 * both times. A file that is no longer listed went back to how the commit has it. One that stays
 * listed the same way may have changed again all the same: status cannot tell, and neither can this.
 */
export function statusChanges(before: StatusEntry[], after: StatusEntry[]): DiskChange[] {
	const out = new Map<string, DiskChange>();
	const put = (change: DiskChange): void => void out.set(change.path, change);
	const was = new Map(before.map((f) => [f.path, f]));
	const now = new Map(after.map((f) => [f.path, f]));
	for (const file of before) {
		if (!now.has(file.path)) {
			// New and gone again: deleted. Deleted and back: restored. Anything else was reverted.
			put({ path: file.path, type: file.status === 'untracked' || file.status === 'added' || file.status === 'renamed' ? 3 : file.status === 'deleted' ? 1 : 2 });
			if (file.status === 'renamed' && file.oldPath && !now.has(file.oldPath)) {
				put({ path: file.oldPath, type: 1 });
			}
		}
	}
	for (const file of after) {
		const old = was.get(file.path);
		if (!old) {
			changesSince([file]).forEach(put);
		} else if (old.status !== file.status) {
			put({ path: file.path, type: file.status === 'deleted' ? 3 : old.status === 'deleted' ? 1 : 2 });
		}
	}
	return [...out.values()];
}

// ---- edits a server asks for across files (rename, quick fixes) -------------------

export interface LspTextEdit {
	range: LspRange;
	newText: string;
}

/**
 * `edits` applied to `text`, all of them against the text as it is (as the protocol has it).
 * Null when two of them overlap or one lies outside the text, which a server should never send
 * and which is no time to guess.
 */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string | null {
	// Where each line starts, and how long it is without its line ending.
	const starts = [0];
	for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) {
		starts.push(at + 1);
	}
	const offset = (p: LspPosition): number | null => {
		if (p.line < 0 || p.character < 0 || p.line > starts.length) {
			return null;
		}
		if (p.line === starts.length) {
			return p.character === 0 ? text.length : null; // one past the last line: the very end
		}
		const end = p.line + 1 < starts.length ? starts[p.line + 1] - 1 : text.length;
		const length = end - starts[p.line] - (end > starts[p.line] && text[end - 1] === '\r' ? 1 : 0);
		// A column past the end of a line means the end of that line.
		return starts[p.line] + Math.min(p.character, length);
	};
	const spans: { from: number; to: number; text: string }[] = [];
	for (const edit of edits) {
		const from = offset(edit.range.start);
		const to = offset(edit.range.end);
		if (from === null || to === null || to < from) {
			return null;
		}
		spans.push({ from, to, text: edit.newText });
	}
	// Edits at the same place keep the order they came in (sort is stable).
	spans.sort((a, b) => a.from - b.from);
	let out = '';
	let at = 0;
	for (const span of spans) {
		if (span.from < at) {
			return null;
		}
		out += text.slice(at, span.from) + span.text;
		at = span.to;
	}
	return out + text.slice(at);
}

export interface FileEdits {
	uri: string;
	edits: LspTextEdit[];
}

/**
 * The text edits of a WorkspaceEdit, by file. Null when it also wants files created, renamed or
 * deleted: that is not done from here, and half an edit is worse than none.
 */
export function workspaceEdit(edit: unknown): FileEdits[] | null {
	const e = (edit ?? {}) as { changes?: Record<string, LspTextEdit[]>; documentChanges?: { kind?: string; textDocument?: { uri?: string }; edits?: LspTextEdit[] }[] };
	const byFile = new Map<string, LspTextEdit[]>();
	const add = (uri: string, edits: LspTextEdit[]): void => void byFile.set(uri, [...(byFile.get(uri) ?? []), ...edits.filter((x) => x?.range && typeof x.newText === 'string')]);
	if (Array.isArray(e.documentChanges)) {
		for (const change of e.documentChanges) {
			if (change.kind || !change.textDocument?.uri) {
				return null;
			}
			add(change.textDocument.uri, change.edits ?? []);
		}
	} else {
		Object.entries(e.changes ?? {}).forEach(([uri, edits]) => add(uri, edits ?? []));
	}
	return [...byFile].filter(([, edits]) => edits.length).map(([uri, edits]) => ({ uri, edits }));
}

/** A quick fix or refactoring a server offers. `raw` is its own object, which it wants back to resolve or run it. */
export interface EditorAction {
	title: string;
	kind?: string;
	isPreferred?: boolean;
	/** Why it cannot be used here, when the server says so. */
	disabled?: string;
	raw: { title?: string; edit?: unknown; command?: { command?: string; arguments?: unknown[] }; data?: unknown };
}

/** A `textDocument/codeAction` answer: CodeActions, bare Commands, or a mix. */
export function codeActions(result: unknown): EditorAction[] {
	interface Item {
		title?: string;
		kind?: string;
		isPreferred?: boolean;
		disabled?: { reason?: string };
		edit?: unknown;
		command?: string | { command?: string; arguments?: unknown[] };
		arguments?: unknown[];
	}
	const out: EditorAction[] = [];
	for (const item of Array.isArray(result) ? (result as Item[]) : []) {
		if (!item?.title) {
			continue;
		}
		if (typeof item.command === 'string') {
			// A bare command: the same thing as an action that does nothing but run it.
			out.push({ title: item.title, raw: { title: item.title, command: { command: item.command, arguments: item.arguments } } });
			continue;
		}
		const action: EditorAction = { title: item.title, raw: item as EditorAction['raw'] };
		if (item.kind) {
			action.kind = item.kind;
		}
		if (item.isPreferred) {
			action.isPreferred = true;
		}
		if (item.disabled?.reason) {
			action.disabled = item.disabled.reason;
		}
		out.push(action);
	}
	return out;
}

/** Whether two protocol ranges touch (an empty one at the edge of the other counts). */
export function touches(a: LspRange, b: LspRange): boolean {
	const before = (p: LspPosition, q: LspPosition): boolean => p.line < q.line || (p.line === q.line && p.character < q.character);
	return !before(a.end, b.start) && !before(b.end, a.start);
}

export interface EditorInlayHint {
	position: { lineNumber: number; column: number };
	label: string;
	/** 1 a type, 2 a parameter name: the same numbers on both sides. */
	kind?: number;
	paddingLeft?: boolean;
	paddingRight?: boolean;
	tooltip?: EditorDoc;
}

export function inlayHints(result: unknown): EditorInlayHint[] {
	interface Hint {
		position?: LspPosition;
		label?: string | { value?: string }[];
		kind?: number;
		paddingLeft?: boolean;
		paddingRight?: boolean;
		tooltip?: unknown;
	}
	const out: EditorInlayHint[] = [];
	for (const hint of Array.isArray(result) ? (result as Hint[]) : []) {
		const label = typeof hint?.label === 'string' ? hint.label : (hint?.label ?? []).map((part) => part.value ?? '').join('');
		if (!hint?.position || !label) {
			continue;
		}
		out.push({ position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 }, label, kind: hint.kind, paddingLeft: hint.paddingLeft, paddingRight: hint.paddingRight, tooltip: documentation(hint.tooltip) });
	}
	return out;
}

export interface FoundSymbol {
	name: string;
	/** Monaco's SymbolKind (the protocol's, minus one). */
	kind: number;
	/** What it is in: a class, a module, a namespace. */
	container: string;
	uri: string;
	/** Null when the server only names the file until asked for more. */
	range: EditorRange | null;
}

/** A `workspace/symbol` answer: SymbolInformation or WorkspaceSymbol items. */
export function workspaceSymbols(result: unknown): FoundSymbol[] {
	interface Sym {
		name?: string;
		kind?: number;
		containerName?: string;
		location?: { uri?: string; range?: LspRange };
	}
	const out: FoundSymbol[] = [];
	for (const s of Array.isArray(result) ? (result as Sym[]) : []) {
		if (s?.name && s.location?.uri) {
			out.push({ name: s.name, kind: (s.kind ?? 1) - 1, container: s.containerName ?? '', uri: s.location.uri, range: s.location.range ? editorRange(s.location.range) : null });
		}
	}
	return out;
}
