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

function folderName(root: string): string {
	return root.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace';
}

/** The `initialize` request. `capabilities` is src/services/lsp/capabilities.json. */
export function initializeParams(started: Pick<Started, 'root' | 'initializationOptions'>, rootUri: string, capabilities: unknown): Record<string, unknown> {
	const params: Record<string, unknown> = {
		processId: null,
		clientInfo: { name: 'Melodic Studio' },
		rootPath: started.root,
		rootUri,
		workspaceFolders: [{ uri: rootUri, name: folderName(started.root) }],
		capabilities,
	};
	if (started.initializationOptions !== null && started.initializationOptions !== undefined) {
		params.initializationOptions = started.initializationOptions;
	}
	return params;
}

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
	private _next = 1;
	private readonly _pending = new Map<number, (result: unknown) => void>();

	constructor(started: Started, rootUri: string, send: (message: unknown) => Promise<void>) {
		this._started = started;
		this.key = started.key;
		this.root = started.root;
		this.server = started.server;
		this.rootUri = rootUri;
		this._send = send;
	}

	/** Resolves to null on an error answer, a dead server, or no answer in `timeout` ms. */
	request<T>(method: string, params: unknown, timeout = 15_000): Promise<T | null> {
		const id = this._next++;
		return new Promise((resolve) => {
			// A server that never answers must not leave the editor waiting.
			const timer = setTimeout(() => this.settle(id, null), timeout);
			this._pending.set(id, (result) => {
				clearTimeout(timer);
				resolve(result as T | null);
			});
			this._send({ jsonrpc: '2.0', id, method, params }).catch(() => this.settle(id, null));
		});
	}

	notify(method: string, params: unknown): void {
		void this._send({ jsonrpc: '2.0', method, params }).catch(() => undefined);
	}

	/** `initialize`, then `initialized`. A slow first start (a big solution, a cold cache) gets a minute. */
	initialize(capabilities: unknown): Promise<boolean> {
		this.ready = this.request<{ capabilities?: Record<string, unknown> }>('initialize', initializeParams(this._started, this.rootUri, capabilities), 60_000).then((result) => {
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
			if (message.error) {
				this.error = message.error.message ?? `Error ${message.error.code ?? ''}`.trim();
			}
			if (typeof message.id === 'number') {
				this.settle(message.id, message.error ? null : (message.result ?? null));
			}
			return null;
		}
		if (message.id !== undefined && message.id !== null) {
			// The server is asking us something. Answer so it carries on.
			void this._send({ jsonrpc: '2.0', id: message.id, result: this.answer(message) }).catch(() => undefined);
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
			default:
				// client/registerCapability, window/workDoneProgress/create, window/showMessageRequest, ...
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
