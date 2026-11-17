/**
 * Language servers for the Files tab's editor: hover, go to definition, find
 * references, the symbol outline and diagnostics, from the server for the
 * language (see src-tauri/src/lsp/servers.rs for the list, and Settings for
 * installing them).
 *
 * The native side only starts the process and relays messages; the Language
 * Server Protocol is spoken here and in ./lsp/protocol.ts (the half that needs
 * no Monaco, so it can be run against real servers outside the app). This
 * service attaches itself to Monaco the first time the Files tab opens, and
 * follows Monaco's models from then on, so the editor component does not need
 * to know it exists.
 */
import type * as Monaco from 'monaco-editor';
import { Injectable, Injector } from '@melodicdev/core/injection';
import { effect, signal } from '@melodicdev/core/signals';
import { ToastService } from '@melodicdev/components/toast';
import { BackendService } from './backend.service';
import { RepoStore } from './repo.store';
import { ExplorerStore } from './explorer.store';
import { loadMonaco, setBuiltInTypeScript, type MonacoApi } from '../shared/monaco';
import { Client, documentSymbols, editorRange, hoverContents, languageId, locations, markers, type LspDiagnostic, type LspMessage, type LspPosition, type LspRange, type Started } from './lsp/protocol';
// As text, so the same file can be read by the Rust end-to-end tests and by scripts/lsp-smoke.mjs.
import capabilities from './lsp/capabilities.json?raw';

/** Monaco language ids we look for a server for. */
const LANGUAGES = ['typescript', 'javascript', 'rust', 'python', 'go', 'php', 'csharp'];

/** The `lsp-closed` event; see `Closed` in src-tauri/src/lsp.rs. */
interface Closed {
	key: string;
	server: string;
	label: string;
	/** True when the app stopped it; false when it exited or crashed by itself. */
	expected: boolean;
	error: string | null;
}

/** One attempt to get a server for a language in a checkout. */
interface Start {
	promise: Promise<Client | null>;
	/** Unset until the attempt settles; null when there is no server (none installed, or it failed). */
	result?: Client | null;
}

interface Doc {
	client: Client;
	version: number;
	timer: ReturnType<typeof setTimeout> | null;
	/** Stops listening to the model's edits. */
	listener: Monaco.IDisposable;
}

@Injectable()
export class LspService {
	/** Server keys that are up, for anything that wants to show it. */
	readonly running = signal<string[]>([]);
	/**
	 * Servers that would not start or that died, by name (`typescript`, `rust`, ...), with what they
	 * said. Such a server is not started again until `refresh()`; Settings shows these.
	 */
	readonly failures = signal<Record<string, string>>({});

	private _monaco: MonacoApi | null = null;
	private _attaching = false;
	private readonly _clients = new Map<string, Client>();
	/** In-flight or settled starts, by `root|language`, so a server is only started once. */
	private readonly _starts = new Map<string, Start>();
	/** Open documents by model URI. */
	private readonly _docs = new Map<string, Doc>();
	/** Servers that went by themselves, by key: the reason may arrive before or after we notice. */
	private readonly _exits = new Map<string, Closed>();
	private readonly _told = new Set<string>();

	constructor() {
		effect(() => {
			if (this.repos.tab() === 'files') {
				void this.attach();
			}
		});
		effect(() => {
			// Another repository or worktree on screen: a different server answers for it, or none.
			this.repos.repo();
			this.syncBuiltIns();
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

	/**
	 * A file URI as a path inside the checkout on screen (`/` separated), or null when it is not in it.
	 * Compared as URI paths, so Windows separators and drive letters come out the same on both sides.
	 */
	private relative(uri: Monaco.Uri): string | null {
		const at = this.root();
		if (!at || !this._monaco || uri.scheme !== 'file') {
			return null;
		}
		const root = this._monaco.Uri.file(at.root).path.replace(/\/+$/, '');
		const path = uri.path;
		const windows = /^\/[a-z]:/i.test(root);
		const inside = windows ? path.toLowerCase().startsWith(`${root.toLowerCase()}/`) : path.startsWith(`${root}/`);
		return inside ? path.slice(root.length + 1) : null;
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
				this.diagnostics(note.params as { uri: string; diagnostics: LspDiagnostic[] });
			}
		});
		await this.backend.listen<Closed>('lsp-closed', (closed) => this.closed(closed));

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
				const path = this.relative(resource);
				if (path === null) {
					return false;
				}
				Injector.get(ExplorerStore).open(path, true);
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

	/**
	 * Monaco's own TypeScript features answer only while no TypeScript server does for the
	 * checkout on screen; with both, every hover, definition and error would show twice.
	 */
	private syncBuiltIns(): void {
		if (!this._monaco) {
			return; // nothing registered yet, and Monaco starts with its own features on
		}
		const root = this.root()?.root;
		setBuiltInTypeScript(![...this._clients.values()].some((client) => client.live && client.server === 'typescript' && client.root === root));
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
			const attempt: Start = { promise: Promise.resolve(null) };
			attempt.promise = this.start(at.id, language)
				.catch(() => null)
				.then((client) => (attempt.result = client));
			this._starts.set(slot, (start = attempt));
		}
		return start.promise;
	}

	private async launch(id: string, language: string): Promise<Started | null> {
		return (await this.backend.call<Started | null | undefined>('lsp_start', { id, language })) ?? null;
	}

	private async start(id: string, language: string): Promise<Client | null> {
		let started = await this.launch(id, language);
		if (!started) {
			return null;
		}
		const known = this._clients.get(started.key);
		if (known) {
			// One server for two languages (TypeScript and JavaScript): the other one started it.
			return (await known.ready) ? known : null;
		}
		if (!started.fresh) {
			// Left over from before a reload: it is already initialised by a client that is gone. Start clean.
			await this.backend.lspStop(started.key);
			started = await this.launch(id, language);
			if (!started) {
				return null;
			}
		}
		const key = started.key;
		const client = new Client(started, this._monaco!.Uri.file(started.root).toString(), (message) => this.backend.lspSend(key, message));
		this._clients.set(key, client);
		if (!(await client.initialize(JSON.parse(capabilities)))) {
			// It refused, never answered, or was gone before it could (a stand-in binary, a missing runtime).
			const why = client.error ?? (await this.exit(key))?.error ?? 'It did not answer.';
			this._clients.delete(key);
			void this.backend.lspStop(key).catch(() => undefined);
			this.failed(started.server, started.label ?? started.server, why);
			return null;
		}
		this.running.set([...this._clients.keys()]);
		this.syncBuiltIns();
		return client;
	}

	/** Why a server went, if it went by itself. The event can trail the failed request by a moment. */
	private async exit(key: string): Promise<Closed | null> {
		for (let tries = 0; tries < 15 && !this._exits.has(key); tries++) {
			await new Promise((done) => setTimeout(done, 100));
		}
		return this._exits.get(key) ?? null;
	}

	/** Note that a server is out of action, and say so once; it is not started again until `refresh()`. */
	private failed(server: string, label: string, why: string): void {
		this.failures.set({ ...this.failures(), [server]: why });
		if (!this._told.has(server)) {
			this._told.add(server);
			Injector.get(ToastService).warning(`The ${label} language server is not running`, `${why.length > 300 ? `${why.slice(0, 300)}…` : why} See Language servers in Settings.`);
		}
	}

	private closed(closed: Closed): void {
		if (!closed.expected) {
			this._exits.set(closed.key, closed);
			if (this._exits.size > 16) {
				this._exits.delete(this._exits.keys().next().value as string);
			}
		}
		const client = this._clients.get(closed.key);
		if (!client) {
			return;
		}
		// Gone before the handshake finished: `start()` is still waiting on it, and reports that itself.
		const served = client.live;
		client.close();
		this._clients.delete(closed.key);
		for (const [slot, start] of this._starts) {
			if (start.result !== client) {
				continue;
			}
			if (closed.expected) {
				// We stopped it (it was removed in Settings): another copy may take over.
				this._starts.delete(slot);
			} else {
				// It died. Starting it again for every file opened would only repeat that.
				start.promise = Promise.resolve(null);
				start.result = null;
			}
		}
		for (const [uri, doc] of this._docs) {
			if (doc.client === client) {
				this.forget(uri, doc);
			}
		}
		this.running.set([...this._clients.keys()]);
		this.syncBuiltIns();
		if (closed.expected) {
			this._monaco?.editor.getModels().forEach((model) => void this.opened(model));
		} else if (served) {
			this.failed(closed.server, closed.label, closed.error ?? 'It stopped unexpectedly.');
		}
	}

	/**
	 * Try again for the files that are open: forget which servers were missing or broken, and start
	 * what can be started now. Settings calls this after installing or removing a server, and to restart one.
	 */
	async refresh(): Promise<void> {
		this.failures.set({});
		this._told.clear();
		for (const [slot, start] of this._starts) {
			// Only attempts that ended with no server; one still in flight is not a failure yet.
			if (start.result === null) {
				this._starts.delete(slot);
			}
		}
		await Promise.all(this._monaco?.editor.getModels().map((model) => this.opened(model)) ?? []);
	}

	// ---- documents ----------------------------------------------------------

	private async opened(model: Monaco.editor.ITextModel): Promise<void> {
		const language = model.getLanguageId();
		const path = this.relative(model.uri);
		if (path === null || !LANGUAGES.includes(language)) {
			return;
		}
		const client = await this.client(language);
		const uri = model.uri.toString();
		if (!client || model.isDisposed() || this._docs.has(uri)) {
			return;
		}
		const doc: Doc = {
			client,
			version: 1,
			timer: null,
			listener: model.onDidChangeContent(() => {
				if (doc.timer === null) {
					doc.timer = setTimeout(() => this.flush(model), 300);
				}
			}),
		};
		this._docs.set(uri, doc);
		client.notify('textDocument/didOpen', { textDocument: { uri, languageId: languageId(language, path), version: doc.version, text: model.getValue() } });
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

	/** Stop following a document, and take down what its server had marked in it. */
	private forget(uri: string, doc: Doc): void {
		if (doc.timer !== null) {
			clearTimeout(doc.timer);
		}
		doc.listener.dispose();
		this._docs.delete(uri);
		const monaco = this._monaco;
		const model = monaco?.editor.getModel(monaco.Uri.parse(uri));
		if (monaco && model && !model.isDisposed()) {
			monaco.editor.setModelMarkers(model, 'lsp', []);
		}
	}

	private disposed(model: Monaco.editor.ITextModel): void {
		const uri = model.uri.toString();
		const doc = this._docs.get(uri);
		if (doc) {
			this.forget(uri, doc);
			doc.client.notify('textDocument/didClose', { textDocument: { uri } });
		}
	}

	/** The client for a model, with the model's latest text delivered. */
	private async ready(model: Monaco.editor.ITextModel): Promise<Client | null> {
		const doc = this._docs.get(model.uri.toString());
		if (!doc || !(await doc.client.ready)) {
			return null;
		}
		this.flush(model);
		return doc.client;
	}

	// ---- features -----------------------------------------------------------
	// Each answers null/empty for a file no server follows, and Monaco's own providers (if any) answer instead.

	private where(model: Monaco.editor.ITextModel, position: Monaco.Position): { textDocument: { uri: string }; position: LspPosition } {
		return { textDocument: { uri: model.uri.toString() }, position: { line: position.lineNumber - 1, character: position.column - 1 } };
	}

	async hover(model: Monaco.editor.ITextModel, position: Monaco.Position): Promise<Monaco.languages.Hover | null> {
		const client = await this.ready(model);
		const result = await client?.request<{ contents: unknown; range?: LspRange }>('textDocument/hover', this.where(model, position));
		const contents = hoverContents(result?.contents).map((value) => ({ value }));
		return contents.length ? { contents, range: result?.range ? editorRange(result.range) : undefined } : null;
	}

	async locations(method: string, model: Monaco.editor.ITextModel, position: Monaco.Position, extra: object = {}): Promise<Monaco.languages.Location[]> {
		const client = await this.ready(model);
		const result = await client?.request<unknown>(method, { ...this.where(model, position), ...extra });
		return locations(result).map((l) => ({ uri: this._monaco!.Uri.parse(l.uri), range: l.range }));
	}

	async symbols(model: Monaco.editor.ITextModel): Promise<Monaco.languages.DocumentSymbol[]> {
		const client = await this.ready(model);
		const result = await client?.request<unknown>('textDocument/documentSymbol', { textDocument: { uri: model.uri.toString() } });
		// Kinds and tags are plain numbers in protocol.ts, already on Monaco's scale.
		return documentSymbols(result) as Monaco.languages.DocumentSymbol[];
	}

	private diagnostics(params: { uri: string; diagnostics: LspDiagnostic[] }): void {
		const monaco = this._monaco!;
		const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
		if (model) {
			monaco.editor.setModelMarkers(model, 'lsp', markers(params.diagnostics ?? []) as Monaco.editor.IMarkerData[]);
		}
	}
}

// Nothing injects this service, so bring it to life here; it stays idle until the Files tab opens.
queueMicrotask(() => Injector.get(LspService));
