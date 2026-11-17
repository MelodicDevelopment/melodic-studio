/**
 * Language servers for the Files tab's editor: hover, go to definition, find
 * references, the symbol outline and diagnostics, from whatever server the
 * user has installed for the language (see src-tauri/src/lsp.rs for the list).
 *
 * The native side only starts the process and relays messages; the Language
 * Server Protocol is spoken here. This service attaches itself to Monaco the
 * first time the Files tab opens, and follows Monaco's models from then on, so
 * the editor component does not need to know it exists.
 */
import type * as Monaco from 'monaco-editor';
import { Injectable, Injector } from '@melodicdev/core/injection';
import { effect, signal } from '@melodicdev/core/signals';
import { BackendService } from './backend.service';
import { RepoStore } from './repo.store';
import { ExplorerStore } from './explorer.store';
import { loadMonaco, type MonacoApi } from '../shared/monaco';

/** Monaco language ids we look for a server for. */
const LANGUAGES = ['typescript', 'javascript', 'rust', 'python', 'go', 'php', 'csharp'];

interface LspPosition {
	line: number;
	character: number;
}
interface LspRange {
	start: LspPosition;
	end: LspPosition;
}
interface LspLocation {
	uri?: string;
	range?: LspRange;
	targetUri?: string;
	targetSelectionRange?: LspRange;
}
interface LspMessage {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

/** One running server: request/response bookkeeping over the relay. */
class Client {
	private _next = 1;
	private readonly _pending = new Map<number, (result: unknown) => void>();
	ready: Promise<void> = Promise.resolve();

	constructor(
		readonly key: string,
		readonly root: string,
		private readonly _send: (message: unknown) => Promise<void>
	) {}

	request<T>(method: string, params: unknown): Promise<T | null> {
		const id = this._next++;
		return new Promise((resolve) => {
			this._pending.set(id, resolve as (result: unknown) => void);
			this._send({ jsonrpc: '2.0', id, method, params }).catch(() => this.settle(id, null));
			// A server that never answers must not leave the editor waiting.
			setTimeout(() => this.settle(id, null), 15_000);
		});
	}

	notify(method: string, params: unknown): void {
		void this._send({ jsonrpc: '2.0', method, params }).catch(() => undefined);
	}

	private settle(id: number, result: unknown): void {
		const resolve = this._pending.get(id);
		if (resolve) {
			this._pending.delete(id);
			resolve(result);
		}
	}

	/** Returns the message when it is a notification the service should look at. */
	receive(message: LspMessage): LspMessage | null {
		if (message.method === undefined) {
			if (typeof message.id === 'number') {
				this.settle(message.id, message.error ? null : (message.result ?? null));
			}
			return null;
		}
		if (message.id !== undefined) {
			// The server is asking us something. Answer with "nothing special" so it carries on.
			const items = (message.params as { items?: unknown[] } | undefined)?.items;
			const result = message.method === 'workspace/configuration' ? (items ?? []).map(() => null) : null;
			void this._send({ jsonrpc: '2.0', id: message.id, result }).catch(() => undefined);
			return null;
		}
		return message;
	}

	close(): void {
		[...this._pending.keys()].forEach((id) => this.settle(id, null));
	}
}

@Injectable()
export class LspService {
	/** Server keys that are up, for anything that wants to show it. */
	readonly running = signal<string[]>([]);

	private _monaco: MonacoApi | null = null;
	private _attaching = false;
	private readonly _clients = new Map<string, Client>();
	/** In-flight or settled starts, by `root|language`, so a server is only started once. */
	private readonly _starts = new Map<string, Promise<Client | null>>();
	/** Open documents by model URI. */
	private readonly _docs = new Map<string, { client: Client; version: number; timer: ReturnType<typeof setTimeout> | null }>();

	constructor() {
		effect(() => {
			if (this.repos.tab() === 'files') {
				void this.attach();
			}
		});
	}

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
	}

	/** The checkout the app is looking at. */
	private root(): { id: string; root: string } | null {
		const repo = this.repos.repo();
		return repo ? { id: repo.id, root: repo.worktree || repo.path } : null;
	}

	// ---- wiring into Monaco -------------------------------------------------

	private async attach(): Promise<void> {
		if (this._attaching) {
			return;
		}
		this._attaching = true;
		const monaco = (this._monaco = await loadMonaco());

		await this.backend.listen<{ key: string; message: LspMessage }>('lsp-message', ({ key, message }) => {
			const note = this._clients.get(key)?.receive(message);
			if (note?.method === 'textDocument/publishDiagnostics') {
				this.diagnostics(note.params as { uri: string; diagnostics: { range: LspRange; message: string; severity?: number; source?: string }[] });
			}
		});
		await this.backend.listen<string>('lsp-closed', (key) => this.closed(key));

		for (const language of LANGUAGES) {
			monaco.languages.registerHoverProvider(language, { provideHover: (model, position) => this.hover(model, position) });
			monaco.languages.registerDefinitionProvider(language, { provideDefinition: (model, position) => this.locations('textDocument/definition', model, position) });
			monaco.languages.registerReferenceProvider(language, {
				provideReferences: (model, position) => this.locations('textDocument/references', model, position, { context: { includeDeclaration: true } }),
			});
			monaco.languages.registerDocumentSymbolProvider(language, { provideDocumentSymbols: (model) => this.symbols(model) });
		}

		// Go to definition in another file: Monaco only knows models, the Files tab knows how to open a path.
		monaco.editor.registerEditorOpener({
			openCodeEditor: (source, resource, target) => {
				const at = this.root();
				const path = resource.fsPath;
				if (!at || !path.startsWith(`${at.root}/`)) {
					return false;
				}
				Injector.get(ExplorerStore).open(path.slice(at.root.length + 1), true);
				this.reveal(source, resource, target);
				return true;
			},
		});

		monaco.editor.onDidCreateModel((model) => void this.opened(model));
		monaco.editor.onWillDisposeModel((model) => this.disposed(model));
		monaco.editor.getModels().forEach((model) => void this.opened(model));
	}

	/** Once the editor has swapped to the file, put the cursor where the definition is. */
	private reveal(editor: Monaco.editor.ICodeEditor, resource: Monaco.Uri, target?: Monaco.IRange | Monaco.IPosition): void {
		const wanted = resource.toString();
		let tries = 0;
		const timer = setInterval(() => {
			if (editor.getModel()?.uri.toString() === wanted) {
				clearInterval(timer);
				if (target) {
					const position = 'startLineNumber' in target ? { lineNumber: target.startLineNumber, column: target.startColumn } : target;
					editor.setPosition(position);
					editor.revealPositionInCenter(position);
				}
				editor.focus();
			} else if (++tries > 40) {
				clearInterval(timer);
			}
		}, 50);
	}

	// ---- servers ------------------------------------------------------------

	private client(language: string): Promise<Client | null> {
		const at = this.root();
		if (!at) {
			return Promise.resolve(null);
		}
		const slot = `${at.root}|${language}`;
		let start = this._starts.get(slot);
		if (!start) {
			start = this.start(at.id, language).catch(() => null);
			this._starts.set(slot, start);
		}
		return start;
	}

	private async start(id: string, language: string): Promise<Client | null> {
		let started = await this.backend.lspStart(id, language);
		if (!started) {
			return null;
		}
		const known = this._clients.get(started.key);
		if (known) {
			return known;
		}
		if (!started.fresh) {
			// Left over from before a reload: it is already initialised by a client that is gone. Start clean.
			await this.backend.lspStop(started.key);
			started = await this.backend.lspStart(id, language);
			if (!started) {
				return null;
			}
		}
		const key = started.key;
		const client = new Client(key, started.root, (message) => this.backend.lspSend(key, message));
		this._clients.set(key, client);
		const rootUri = this._monaco!.Uri.file(started.root).toString();
		client.ready = client
			.request('initialize', {
				processId: null,
				clientInfo: { name: 'Melodic Studio' },
				rootUri,
				workspaceFolders: [{ uri: rootUri, name: started.root.split('/').pop() ?? 'workspace' }],
				capabilities: {
					workspace: { configuration: true, workspaceFolders: true },
					textDocument: {
						synchronization: { didSave: false },
						hover: { contentFormat: ['markdown', 'plaintext'] },
						definition: { linkSupport: true },
						references: {},
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						publishDiagnostics: {},
					},
				},
			})
			.then(() => client.notify('initialized', {}));
		await client.ready;
		this.running.set([...this._clients.keys()]);
		return client;
	}

	private closed(key: string): void {
		const client = this._clients.get(key);
		if (!client) {
			return;
		}
		client.close();
		this._clients.delete(key);
		for (const [slot, start] of this._starts) {
			void start.then((c) => {
				if (c === client) {
					this._starts.delete(slot);
				}
			});
		}
		for (const [uri, doc] of this._docs) {
			if (doc.client === client) {
				this._docs.delete(uri);
			}
		}
		this.running.set([...this._clients.keys()]);
	}

	// ---- documents ----------------------------------------------------------

	private async opened(model: Monaco.editor.ITextModel): Promise<void> {
		const language = model.getLanguageId();
		const at = this.root();
		if (model.uri.scheme !== 'file' || !LANGUAGES.includes(language) || !at || !model.uri.fsPath.startsWith(`${at.root}/`)) {
			return;
		}
		const client = await this.client(language);
		const uri = model.uri.toString();
		if (!client || model.isDisposed() || this._docs.has(uri)) {
			return;
		}
		const doc = { client, version: 1, timer: null as ReturnType<typeof setTimeout> | null };
		this._docs.set(uri, doc);
		client.notify('textDocument/didOpen', { textDocument: { uri, languageId: language, version: doc.version, text: model.getValue() } });
		model.onDidChangeContent(() => {
			if (doc.timer === null) {
				doc.timer = setTimeout(() => this.flush(model), 300);
			}
		});
	}

	/** Send the model's current text if the server has not seen it yet. */
	private flush(model: Monaco.editor.ITextModel): void {
		const doc = this._docs.get(model.uri.toString());
		if (doc?.timer != null) {
			clearTimeout(doc.timer);
			doc.timer = null;
			doc.client.notify('textDocument/didChange', { textDocument: { uri: model.uri.toString(), version: ++doc.version }, contentChanges: [{ text: model.getValue() }] });
		}
	}

	private disposed(model: Monaco.editor.ITextModel): void {
		const uri = model.uri.toString();
		const doc = this._docs.get(uri);
		if (doc) {
			if (doc.timer !== null) {
				clearTimeout(doc.timer);
			}
			this._docs.delete(uri);
			doc.client.notify('textDocument/didClose', { textDocument: { uri } });
		}
	}

	/** The client for a model, with the model's latest text delivered. */
	private async ready(model: Monaco.editor.ITextModel): Promise<Client | null> {
		const doc = this._docs.get(model.uri.toString());
		if (!doc) {
			return null;
		}
		await doc.client.ready;
		this.flush(model);
		return doc.client;
	}

	// ---- features -----------------------------------------------------------

	private range(r: LspRange): Monaco.IRange {
		return { startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 };
	}

	private where(model: Monaco.editor.ITextModel, position: Monaco.Position): { textDocument: { uri: string }; position: LspPosition } {
		return { textDocument: { uri: model.uri.toString() }, position: { line: position.lineNumber - 1, character: position.column - 1 } };
	}

	private async hover(model: Monaco.editor.ITextModel, position: Monaco.Position): Promise<Monaco.languages.Hover | null> {
		const client = await this.ready(model);
		const result = await client?.request<{ contents: unknown; range?: LspRange }>('textDocument/hover', this.where(model, position));
		if (!result?.contents) {
			return null;
		}
		const parts = Array.isArray(result.contents) ? result.contents : [result.contents];
		const contents = parts
			.map((part: unknown) => {
				if (typeof part === 'string') {
					return part;
				}
				const p = part as { kind?: string; language?: string; value?: string };
				return p.language ? `\`\`\`${p.language}\n${p.value ?? ''}\n\`\`\`` : (p.value ?? '');
			})
			.filter(Boolean)
			.map((value) => ({ value }));
		return contents.length ? { contents, range: result.range ? this.range(result.range) : undefined } : null;
	}

	private async locations(method: string, model: Monaco.editor.ITextModel, position: Monaco.Position, extra: object = {}): Promise<Monaco.languages.Location[]> {
		const client = await this.ready(model);
		const result = await client?.request<LspLocation | LspLocation[]>(method, { ...this.where(model, position), ...extra });
		const list = !result ? [] : Array.isArray(result) ? result : [result];
		const out: Monaco.languages.Location[] = [];
		for (const l of list) {
			const uri = l.targetUri ?? l.uri;
			const range = l.targetSelectionRange ?? l.range;
			if (uri && range) {
				out.push({ uri: this._monaco!.Uri.parse(uri), range: this.range(range) });
			}
		}
		return out;
	}

	private async symbols(model: Monaco.editor.ITextModel): Promise<Monaco.languages.DocumentSymbol[]> {
		interface Sym {
			name: string;
			detail?: string;
			kind: number;
			range?: LspRange;
			selectionRange?: LspRange;
			location?: { range: LspRange };
			children?: Sym[];
		}
		const client = await this.ready(model);
		const result = await client?.request<Sym[]>('textDocument/documentSymbol', { textDocument: { uri: model.uri.toString() } });
		const convert = (s: Sym): Monaco.languages.DocumentSymbol | null => {
			const range = s.range ?? s.location?.range;
			if (!range) {
				return null;
			}
			return {
				name: s.name,
				detail: s.detail ?? '',
				// The protocol counts symbol kinds from 1, Monaco from 0.
				kind: (s.kind - 1) as Monaco.languages.SymbolKind,
				tags: [],
				range: this.range(range),
				selectionRange: this.range(s.selectionRange ?? range),
				children: (s.children ?? []).map(convert).filter((c): c is Monaco.languages.DocumentSymbol => c !== null),
			};
		};
		return (result ?? []).map(convert).filter((c): c is Monaco.languages.DocumentSymbol => c !== null);
	}

	private diagnostics(params: { uri: string; diagnostics: { range: LspRange; message: string; severity?: number; source?: string }[] }): void {
		const monaco = this._monaco!;
		const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
		if (!model) {
			return;
		}
		const severity = [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint];
		monaco.editor.setModelMarkers(
			model,
			'lsp',
			params.diagnostics.map((d) => ({ ...this.range(d.range), message: d.message, source: d.source, severity: severity[d.severity ?? 1] ?? monaco.MarkerSeverity.Error }))
		);
	}
}

// Nothing injects this service, so bring it to life here; it stays idle until the Files tab opens.
queueMicrotask(() => Injector.get(LspService));
