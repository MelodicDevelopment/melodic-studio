/**
 * Language servers for the Files tab's editor: completion, signature help,
 * hover, go to definition / type definition / implementation, find references,
 * highlights, the symbol outline, formatting and diagnostics, from the server
 * for the language (see src-tauri/src/lsp/servers.rs for the list, and Settings
 * for installing them).
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
import { effect, signal, untracked } from '@melodicdev/core/signals';
import { ToastService } from '@melodicdev/components/toast';
import { BackendService, type FileChange } from './backend.service';
import { RepoStore } from './repo.store';
import { ExplorerStore } from './explorer.store';
import { loadMonaco, setBuiltInTypeScript, type MonacoApi } from '../shared/monaco';
import { joinPath } from '../shared/paths';
import {
	applyTextEdits,
	changesSince,
	Client,
	clientCapabilities,
	codeActions,
	completions,
	contentChanges,
	documentSymbols,
	editorRange,
	highlights,
	hoverContents,
	inlayHints,
	languageId,
	languageOf,
	lspRange,
	newSince,
	oldSpans,
	symbolsAt,
	locations,
	markers,
	progress,
	resolved,
	saveWanted,
	signatureHelp,
	statusChanges,
	syncKind,
	touches,
	triggerCharacters,
	WATCHED_FILES,
	workspaceEdit,
	workspaceSymbols,
	type EditorAction,
	type DiskChange,
	type EditorChange,
	type EditorCompletion,
	type EditorMarker,
	type FileEdits,
	type Located,
	type LspDiagnostic,
	type LspMessage,
	type LspPosition,
	type LspRange,
	type Started,
} from './lsp/protocol';
// As text, so the same file can be read by the Rust end-to-end tests and by scripts/lsp-smoke.mjs.
import capabilities from './lsp/capabilities.json?raw';

/** Monaco language ids we look for a server for. */
const LANGUAGES = ['typescript', 'javascript', 'rust', 'python', 'go', 'php', 'csharp'];

/**
 * Every character some server opens completion on. Monaco wants the list when the provider is
 * registered, before any server has said which are its own; `complete()` drops the others.
 */
const COMPLETION_TRIGGERS = ['.', '"', "'", '`', '/', '@', '<', '>', '#', ' ', ':', '$', '\\', '*', '(', '[', '-'];
/** More edits than this between two messages to the server and the whole text is sent instead. */
const MAX_EDITS = 200;

/** Work a server says it is doing (indexing, loading a solution), for the editor's status line. */
export interface ServerWork {
	/** The checkout the server runs in. */
	root: string;
	/** The server's name for people. */
	label: string;
	title: string;
	message: string;
	percentage: number | null;
}

/** An error a language server reports in a file. `message` is the compiler's own text: show it as text only. */
export interface Problem {
	/** Repository-relative. */
	path: string;
	line: number;
	column: number;
	message: string;
	/** Who says so (`ts`, `rustc`, ...), when the server names it. */
	source: string | null;
	/** In a file the change itself touched. False: in a file that uses something it changed. */
	changed: boolean;
}

/** Something a change touched (a function, a class, a member) that files it did not touch use. */
export interface Impact {
	symbol: string;
	/** Where the symbol was before the change. */
	path: string;
	line: number;
	uses: { path: string; line: number }[];
}

/** A file of the change `LspService.check` is asked about: what `worktree_diff` says of it. */
export interface CheckedFile {
	path: string;
	oldPath: string | null;
	/** modified | added | deleted | renamed | untracked */
	status: string;
	/** Its unified diff, from which the touched symbols are worked out. May be empty. */
	diff: string;
}

/** What `LspService.check` found. */
export interface CheckResult {
	/** Errors that were not there at the commit the change started from. */
	problems: Problem[];
	/** How many errors the same files had before the change (and still have). */
	known: number;
	impact: Impact[];
	/** The servers that looked, by their names for people. Empty: no installed server knows these files. */
	servers: string[];
	/** How many changed files a server was shown, and how many files that use them. */
	files: number;
	users: number;
	/** False when a server was still working when the time ran out, so there may be more. */
	finished: boolean;
}

/** A symbol the workspace search found, as a place in the checkout on screen. */
export interface SymbolHit {
	name: string;
	/** Monaco's SymbolKind. */
	kind: number;
	container: string;
	path: string;
	line: number;
	column: number;
}

/** How applying a server's edit went: the files it changed, or why nothing was. */
type Applied = { ok: true; files: string[]; unsaved: string[] } | { ok: false; reason: string };

/**
 * A server whose checkout has not been on screen for this long is stopped (rust-analyzer holds half a
 * gigabyte for a toy project, and every repository visited used to keep its servers for good). It is
 * started again when a file of that checkout is next shown.
 */
const IDLE_MS = 10 * 60_000;

/** The editor command a quick fix runs when picked; see `runAction`. */
const APPLY_ACTION = 'melodic.lsp.applyAction';

/** A check gives up after this long without the server reporting work in progress, */
const CHECK_QUIET_MS = 60_000;
/** and after this long whatever it reports (a cold `cargo check` can take minutes). */
const CHECK_LIMIT_MS = 300_000;
/** How long a server has to stay quiet to count as done: once it has reported on every file asked about, */
const SETTLED_MS = 1200;
/** and when it has not, which is also what a file with nothing new to say about looks like. */
const UNCHANGED_MS = 3000;
/** References are asked for at most this many touched symbols, and at most this many files using them are opened. */
const MAX_SYMBOLS = 25;
const MAX_USERS = 30;
/**
 * Diagnostics from these come from a build of the files on disk (rust-analyzer's `cargo check`), not
 * from the text the server was shown, so "as it was before" cannot be asked of them.
 */
const DISK_SOURCES = ['rustc', 'clippy'];

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
	/** How the server wants edits; see `syncKind`. */
	sync: 0 | 1 | 2;
	/** Edits the server has not been sent yet, oldest first; null when only the whole text will do. */
	edits: EditorChange[] | null;
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
	/** What the servers are busy with right now, by `server key|progress token`. */
	readonly working = signal<Record<string, ServerWork>>({});

	private _monaco: MonacoApi | null = null;
	private _attached: Promise<void> | null = null;
	private readonly _clients = new Map<string, Client>();
	/** In-flight or settled starts, by `root|language`, so a server is only started once. */
	private readonly _starts = new Map<string, Start>();
	/** Open documents by model URI. */
	private readonly _docs = new Map<string, Doc>();
	/** Servers that went by themselves, by key: the reason may arrive before or after we notice. */
	private readonly _exits = new Map<string, Closed>();
	private readonly _told = new Set<string>();
	/** Server keys to their names for people. */
	private readonly _labels = new Map<string, string>();
	/** Server keys to the repository they were started for. */
	private readonly _repoIds = new Map<string, string>();
	/** What each server last reported on an open file, by URI as Monaco spells it: a quick fix is asked for by its diagnostic. */
	private readonly _reported = new Map<string, LspDiagnostic[]>();
	/** Which server a suggestion on screen came from, for `completionItem/resolve`. */
	private readonly _suggested = new WeakMap<object, Client>();
	/** Files `check()` has open with a server, by URI: where that server's diagnostics for them go. */
	private readonly _checking = new Map<string, (diagnostics: LspDiagnostic[]) => void>();
	/** The status of the checkout on screen as last seen, to tell what has changed on disk since. */
	private _status: { root: string; head: string | null; files: FileChange[] } | null = null;
	/** When each checkout with a server was last on screen, and which one is now. */
	private readonly _seen = new Map<string, number>();
	private _onScreen: string | null = null;
	private _hintsStale: () => void = () => undefined;
	private _hintsTimer = 0;
	/** Checks under way, counted by checkout: the last one out stops the servers it started. */
	private readonly _checks = new Map<string, number>();

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
			untracked(() => this.shown());
		});
		effect(() => {
			const status = this.repos.status();
			untracked(() => void this.statusSeen(status ? { head: status.head, files: status.files } : null));
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
		return at ? this.relativeIn(at.root, uri) : null;
	}

	/** The same for any checkout folder. */
	private relativeIn(folder: string, uri: Monaco.Uri): string | null {
		if (!this._monaco || uri.scheme !== 'file') {
			return null;
		}
		const root = this._monaco.Uri.file(folder).path.replace(/\/+$/, '');
		const path = uri.path;
		const windows = /^\/[a-z]:/i.test(root);
		const inside = windows ? path.toLowerCase().startsWith(`${root.toLowerCase()}/`) : path.startsWith(`${root}/`);
		return inside ? path.slice(root.length + 1) : null;
	}

	// ---- wiring into Monaco -------------------------------------------------

	private attach(): Promise<void> {
		return (this._attached ??= this.wire());
	}

	private async wire(): Promise<void> {
		const monaco = (this._monaco = await loadMonaco());

		await this.backend.listen<{ key: string; message: LspMessage }>('lsp-message', ({ key, message }) => {
			const client = this._clients.get(key);
			const note = client?.receive(message);
			if (note?.method === 'textDocument/publishDiagnostics') {
				this.diagnostics(note.params as { uri: string; diagnostics: LspDiagnostic[] });
			} else if (client && note?.method === '$/progress') {
				this.progressed(client, note.params);
			}
		});
		await this.backend.listen<Closed>('lsp-closed', (closed) => this.closed(closed));

		// The editor asks for inlay hints when a file is shown, which is before a server has read the
		// project: it is told to ask again once a server is up, has finished some work, or says so itself.
		const hintsChanged = new monaco.Emitter<void>();
		this._hintsStale = () => {
			window.clearTimeout(this._hintsTimer);
			this._hintsTimer = window.setTimeout(() => hintsChanged.fire(), 400);
		};
		for (const language of LANGUAGES) {
			monaco.languages.registerCompletionItemProvider(language, {
				triggerCharacters: COMPLETION_TRIGGERS,
				provideCompletionItems: (model, position, context, token) => this.complete(model, position, context, token),
				resolveCompletionItem: (item, token) => this.resolve(item, token),
			});
			monaco.languages.registerSignatureHelpProvider(language, {
				signatureHelpTriggerCharacters: ['(', ',', '<'],
				signatureHelpRetriggerCharacters: [')'],
				provideSignatureHelp: (model, position, token, context) => this.signature(model, position, context, token),
			});
			monaco.languages.registerHoverProvider(language, { provideHover: (model, position, token) => this.hover(model, position, token) });
			monaco.languages.registerDocumentHighlightProvider(language, { provideDocumentHighlights: (model, position, token) => this.highlight(model, position, token) });
			monaco.languages.registerDeclarationProvider(language, { provideDeclaration: (model, position, token) => this.locations('declaration', model, position, token) });
			monaco.languages.registerDefinitionProvider(language, { provideDefinition: (model, position, token) => this.locations('definition', model, position, token) });
			monaco.languages.registerTypeDefinitionProvider(language, { provideTypeDefinition: (model, position, token) => this.locations('typeDefinition', model, position, token) });
			monaco.languages.registerImplementationProvider(language, { provideImplementation: (model, position, token) => this.locations('implementation', model, position, token) });
			monaco.languages.registerReferenceProvider(language, {
				provideReferences: (model, position, _context, token) => this.locations('references', model, position, token, { context: { includeDeclaration: true } }),
			});
			monaco.languages.registerDocumentSymbolProvider(language, { provideDocumentSymbols: (model, token) => this.symbols(model, token) });
			monaco.languages.registerDocumentFormattingEditProvider(language, { provideDocumentFormattingEdits: (model, options, token) => this.format(model, options, token) });
			monaco.languages.registerDocumentRangeFormattingEditProvider(language, { provideDocumentRangeFormattingEdits: (model, range, options, token) => this.format(model, options, token, range) });
			monaco.languages.registerRenameProvider(language, {
				provideRenameEdits: (model, position, newName, token) => this.rename(model, position, newName, token),
				resolveRenameLocation: (model, position, token) => this.renameAt(model, position, token),
			});
			monaco.languages.registerCodeActionProvider(language, { provideCodeActions: (model, range, context, token) => this.actions(model, range, context, token) });
			monaco.languages.registerInlayHintsProvider(language, { onDidChangeInlayHints: hintsChanged.event, provideInlayHints: (model, range, token) => this.hints(model, range, token) });
		}
		// What a picked quick fix runs: Monaco would apply a fix's edit itself, but only to files it has open.
		monaco.editor.registerCommand(APPLY_ACTION, (_accessor, key: string, action: EditorAction['raw']) => void this.runAction(key, action));
		Injector.get(ExplorerStore).afterSave.push((model) => this.saved(model));

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

		window.setInterval(() => this.stopIdle(), 60_000);
		monaco.editor.onDidCreateModel((model) => void this.opened(model));
		monaco.editor.onWillDisposeModel((model) => this.disposed(model));
		monaco.editor.getModels().forEach((model) => void this.opened(model));
	}

	/**
	 * Another checkout is on screen (or the same one, read again). Coming back to one whose servers
	 * were stopped for being idle, its open files are handed to fresh ones.
	 */
	private shown(): void {
		const root = this.root()?.root ?? null;
		const now = Date.now();
		if (this._onScreen) {
			this._seen.set(this._onScreen, now);
		}
		if (root && root !== this._onScreen) {
			this._seen.set(root, now);
			this._monaco?.editor.getModels().forEach((model) => void this.opened(model));
		}
		this._onScreen = root;
	}

	/** Stop the servers of checkouts nobody has looked at for a while. A check in flight keeps its own. */
	private stopIdle(): void {
		const now = Date.now();
		const here = this.root()?.root;
		for (const client of this._clients.values()) {
			if (client.live && client.root !== here && !this._checks.has(client.root) && now - (this._seen.get(client.root) ?? now) > IDLE_MS) {
				void this.backend.lspStop(client.key).catch(() => undefined);
			}
		}
		[...this._seen.keys()].filter((root) => root !== here && ![...this._clients.values()].some((client) => client.root === root)).forEach((root) => this._seen.delete(root));
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

	/** The server for a language in the checkout on screen. */
	private client(language: string): Promise<Client | null> {
		const at = this.root();
		return at ? this.clientAt(at.id, at.root, language) : Promise.resolve(null);
	}

	/** The server for a language in `root`; with `elsewhere`, a checkout that need not be the one on screen. */
	private clientAt(id: string, root: string, language: string, elsewhere = false): Promise<Client | null> {
		const slot = `${root}|${language}`;
		let start = this._starts.get(slot);
		if (!start) {
			const attempt: Start = { promise: Promise.resolve(null) };
			attempt.promise = this.start(id, language, elsewhere ? root : undefined)
				.catch(() => null)
				.then((client) => (attempt.result = client));
			this._starts.set(slot, (start = attempt));
		}
		return start.promise;
	}

	/** `cwd`: the checkout to start it in, when that is not the active one. */
	private async launch(id: string, language: string, cwd?: string): Promise<Started | null> {
		return (await this.backend.call<Started | null | undefined>('lsp_start', { id, language, cwd })) ?? null;
	}

	private async start(id: string, language: string, cwd?: string): Promise<Client | null> {
		let started = await this.launch(id, language, cwd);
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
			started = await this.launch(id, language, cwd);
			if (!started) {
				return null;
			}
		}
		const key = started.key;
		const client = new Client(started, this._monaco!.Uri.file(started.root).toString(), (message) => this.backend.lspSend(key, message));
		this._clients.set(key, client);
		this._labels.set(key, started.label ?? started.server);
		this._repoIds.set(key, id);
		if (!this._seen.has(started.root)) {
			this._seen.set(started.root, Date.now());
		}
		// A refactoring the server works out itself comes back as a request to apply an edit.
		client.handler = (method, params) => {
			if (method === 'workspace/inlayHint/refresh') {
				this._hintsStale();
				return Promise.resolve(null);
			}
			return method === 'workspace/applyEdit' ? this.applyEdit(client, (params as { edit?: unknown } | undefined)?.edit).then((done) => (done.ok ? { applied: true } : { applied: false, failureReason: done.reason })) : undefined;
		};
		if (!(await client.initialize(clientCapabilities(JSON.parse(capabilities), started.server)))) {
			// It refused, never answered, or was gone before it could (a stand-in binary, a missing runtime).
			const why = client.error ?? (await this.exit(key))?.error ?? 'It did not answer.';
			this._clients.delete(key);
			void this.backend.lspStop(key).catch(() => undefined);
			this.failed(started.server, started.label ?? started.server, why);
			return null;
		}
		this.running.set([...this._clients.keys()]);
		this.syncBuiltIns();
		this._hintsStale();
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
		this._labels.delete(closed.key);
		this._repoIds.delete(closed.key);
		this.working.set(Object.fromEntries(Object.entries(this.working()).filter(([id]) => !id.startsWith(`${closed.key}|`))));
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
		// A check has this file open with the server for a moment; opening it twice would confuse the two.
		for (let tries = 0; tries < 600 && this._checking.has(uri); tries++) {
			await new Promise((done) => setTimeout(done, 200));
		}
		if (!client || model.isDisposed() || this._docs.has(uri)) {
			return;
		}
		const doc: Doc = {
			client,
			version: 1,
			sync: syncKind(client.capabilities),
			edits: [],
			timer: null,
			listener: model.onDidChangeContent((e) => {
				// Each edit is against the text the one before it left, so they are kept in order or not at all.
				if (doc.edits && !e.isFlush && !e.isEolChange && doc.edits.length + e.changes.length <= MAX_EDITS) {
					doc.edits.push(...e.changes.map((c) => ({ range: c.range, text: c.text })));
				} else {
					doc.edits = null;
				}
				if (doc.timer === null) {
					doc.timer = setTimeout(() => this.flush(model), 300);
				}
			}),
		};
		this._docs.set(uri, doc);
		client.notify('textDocument/didOpen', { textDocument: { uri, languageId: languageId(language, path), version: doc.version, text: model.getValue() } });
	}

	/** Send the edits the server has not seen yet. */
	private flush(model: Monaco.editor.ITextModel): void {
		const doc = this._docs.get(model.uri.toString());
		if (doc?.timer != null) {
			clearTimeout(doc.timer);
			doc.timer = null;
			const edits = doc.edits;
			doc.edits = [];
			if (doc.sync !== 0) {
				doc.client.notify('textDocument/didChange', { textDocument: { uri: model.uri.toString(), version: ++doc.version }, contentChanges: contentChanges(doc.sync, edits, () => model.getValue()) });
			}
		}
	}

	// ---- files that change on disk without the editor -------------------------------

	/** The servers of a checkout that asked to be told when files change on disk. */
	private told(root: string): Client[] {
		return [...this._clients.values()].filter((client) => client.live && client.root === root && client.registered.has(WATCHED_FILES));
	}

	/**
	 * Files of the checkout at `root` came, changed or went on disk, by something other than the
	 * editor. The servers that watch the disk themselves have noticed; the ones that asked us are told.
	 */
	changed(root: string, changes: DiskChange[]): void {
		const clients = changes.length && this._monaco ? this.told(root) : [];
		if (!clients.length) {
			return;
		}
		const monaco = this._monaco!;
		const list = changes.map((change) => ({ uri: monaco.Uri.file(joinPath(root, change.path)).toString(), type: change.type }));
		for (const client of clients) {
			client.notify(WATCHED_FILES, { changes: list });
			// csharp-ls takes the files in but looks at an open document again only when that is edited:
			// its errors about a class that now exists would stay. So each open document is sent once
			// more, as it is (seen against the real server; intelephense does not need it and does not mind).
			for (const [uri, doc] of this._docs) {
				const model = doc.client === client && doc.sync !== 0 ? monaco.editor.getModel(monaco.Uri.parse(uri)) : null;
				if (model) {
					this.flush(model);
					client.notify('textDocument/didChange', { textDocument: { uri, version: ++doc.version }, contentChanges: [{ text: model.getValue() }] });
				}
			}
		}
	}

	/**
	 * The status of the checkout on screen was read again (every few seconds, and after anything the app
	 * does): what differs from last time changed on disk. After another commit was checked out or made,
	 * everything that differs from the earlier one did. What this cannot see is a file that was already
	 * modified being changed again from outside the app; an agent's turn reports its own files (`checkWork`).
	 */
	private async statusSeen(status: { head: string | null; files: FileChange[] } | null): Promise<void> {
		const at = this.root();
		const before = this._status;
		this._status = at && status ? { root: at.root, ...status } : before;
		if (!at || !status || !before || before.root !== at.root || !this.told(at.root).length) {
			return;
		}
		if (before.head === status.head) {
			this.changed(at.root, statusChanges(before.files, status.files));
		} else if (before.head) {
			try {
				// Everything the checkout holds that the commit it was at does not, both ways round.
				this.changed(at.root, changesSince((await this.backend.worktreeDiff(at.id, at.root, before.head)).files));
			} catch {
				/* the earlier commit is gone (a rewritten history): the next server start reads the disk anyway */
			}
		}
	}

	/** A file's edits are on disk. Some servers only run their slower checks then (rust-analyzer's `cargo check`). */
	private saved(model: Monaco.editor.ITextModel): void {
		const doc = this._docs.get(model.uri.toString());
		const wanted = doc?.client.live ? saveWanted(doc.client.capabilities) : null;
		if (doc && wanted) {
			this.flush(model);
			doc.client.notify('textDocument/didSave', { textDocument: { uri: model.uri.toString() }, ...(wanted.includeText ? { text: model.getValue() } : {}) });
		}
	}

	private progressed(client: Client, params: unknown): void {
		const p = progress(params);
		if (!p) {
			return;
		}
		const id = `${client.key}|${p.token}`;
		const all = { ...this.working() };
		if (p.kind === 'end') {
			delete all[id];
			this._hintsStale();
		} else {
			const was = all[id];
			all[id] = {
				root: client.root,
				label: this._labels.get(client.key) ?? client.server,
				title: p.title ?? was?.title ?? '',
				message: p.message ?? (p.kind === 'begin' ? '' : (was?.message ?? '')),
				percentage: p.percentage ?? (p.kind === 'begin' ? null : (was?.percentage ?? null)),
			};
		}
		this.working.set(all);
	}

	/** What the servers of the checkout on screen are busy with, the longest-running first. */
	busy(): ServerWork[] {
		const root = this.root()?.root;
		return root ? this.workAt(root) : [];
	}

	/** The same for any checkout (an agent's, while its change is being checked). */
	workAt(root: string): ServerWork[] {
		return Object.values(this.working()).filter((work) => work.root === root);
	}

	/** Stop following a document, and take down what its server had marked in it. */
	private forget(uri: string, doc: Doc): void {
		if (doc.timer !== null) {
			clearTimeout(doc.timer);
		}
		doc.listener.dispose();
		this._docs.delete(uri);
		this._reported.delete(uri);
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

	async complete(model: Monaco.editor.ITextModel, position: Monaco.Position, context: Monaco.languages.CompletionContext, token: Monaco.CancellationToken): Promise<Monaco.languages.CompletionList | null> {
		const client = await this.ready(model);
		if (!client?.capabilities.completionProvider) {
			return null;
		}
		const typed = context.triggerKind === this._monaco!.languages.CompletionTriggerKind.TriggerCharacter;
		if (typed && !triggerCharacters(client.capabilities, 'completionProvider').includes(context.triggerCharacter ?? '')) {
			return null; // a character another language's server opens completion on
		}
		// The protocol counts trigger kinds from 1, Monaco from 0.
		const result = await client.request<unknown>('textDocument/completion', { ...this.where(model, position), context: { triggerKind: context.triggerKind + 1, triggerCharacter: typed ? context.triggerCharacter : undefined } }, 15_000, token);
		if (!result) {
			return null;
		}
		// Where an item goes that does not say: over the word being typed.
		const before = model.getWordUntilPosition(position);
		const insert = { startLineNumber: position.lineNumber, startColumn: before.startColumn, endLineNumber: position.lineNumber, endColumn: position.column };
		const list = completions(result, { insert, replace: { ...insert, endColumn: model.getWordAtPosition(position)?.endColumn ?? position.column } });
		list.suggestions.forEach((suggestion) => this._suggested.set(suggestion, client));
		return list as Monaco.languages.CompletionList;
	}

	/** The parts of a suggestion its server leaves until it is looked at: documentation, the import it adds. */
	async resolve(item: Monaco.languages.CompletionItem, token: Monaco.CancellationToken): Promise<Monaco.languages.CompletionItem> {
		const client = this._suggested.get(item);
		if (!client?.live || !(client.capabilities.completionProvider as { resolveProvider?: boolean } | undefined)?.resolveProvider) {
			return item;
		}
		const shown = item as unknown as EditorCompletion;
		return resolved(shown, await client.request<unknown>('completionItem/resolve', shown.item, 5_000, token)) as Monaco.languages.CompletionItem;
	}

	async signature(model: Monaco.editor.ITextModel, position: Monaco.Position, context: Monaco.languages.SignatureHelpContext, token: Monaco.CancellationToken): Promise<Monaco.languages.SignatureHelpResult | null> {
		const client = await this.ready(model);
		if (!client?.capabilities.signatureHelpProvider) {
			return null;
		}
		// Trigger kinds are numbered the same on both sides. What is showing goes back as the server gave it.
		const showing = (context.activeSignatureHelp as { raw?: unknown } | undefined)?.raw;
		const value = signatureHelp(
			await client.request<unknown>(
				'textDocument/signatureHelp',
				{ ...this.where(model, position), context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger, activeSignatureHelp: showing } },
				15_000,
				token
			)
		);
		return value ? { value, dispose: () => undefined } : null;
	}

	async hover(model: Monaco.editor.ITextModel, position: Monaco.Position, token?: Monaco.CancellationToken): Promise<Monaco.languages.Hover | null> {
		const client = await this.ready(model);
		const result = await client?.request<{ contents: unknown; range?: LspRange }>('textDocument/hover', this.where(model, position), 15_000, token);
		const contents = hoverContents(result?.contents).map((value) => ({ value }));
		return contents.length ? { contents, range: result?.range ? editorRange(result.range) : undefined } : null;
	}

	async highlight(model: Monaco.editor.ITextModel, position: Monaco.Position, token?: Monaco.CancellationToken): Promise<Monaco.languages.DocumentHighlight[]> {
		const client = await this.ready(model);
		if (!client?.capabilities.documentHighlightProvider) {
			return [];
		}
		return highlights(await client.request<unknown>('textDocument/documentHighlight', this.where(model, position), 5_000, token));
	}

	/** `what` is the request (`textDocument/<what>`); a server that does not offer it (`<what>Provider`) is not asked. */
	async locations(what: 'declaration' | 'definition' | 'typeDefinition' | 'implementation' | 'references', model: Monaco.editor.ITextModel, position: Monaco.Position, token?: Monaco.CancellationToken, extra: object = {}): Promise<Monaco.languages.Location[]> {
		const client = await this.ready(model);
		if (!client?.capabilities[`${what}Provider`]) {
			return [];
		}
		const result = await client.request<unknown>(`textDocument/${what}`, { ...this.where(model, position), ...extra }, 15_000, token);
		return locations(result).map((l) => ({ uri: this._monaco!.Uri.parse(l.uri), range: l.range }));
	}

	/** The server's formatting of the whole file, or of `range`; none (and Monaco's own, if any) when it cannot format. */
	async format(model: Monaco.editor.ITextModel, options: Monaco.languages.FormattingOptions, token?: Monaco.CancellationToken, range?: Monaco.IRange): Promise<Monaco.languages.TextEdit[]> {
		const client = await this.ready(model);
		if (!client?.capabilities[range ? 'documentRangeFormattingProvider' : 'documentFormattingProvider']) {
			return [];
		}
		const params = { textDocument: { uri: model.uri.toString() }, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces }, ...(range ? { range: lspRange(range) } : {}) };
		const edits = await client.request<{ range: LspRange; newText: string }[] | null>(range ? 'textDocument/rangeFormatting' : 'textDocument/formatting', params, 15_000, token);
		return (edits ?? []).map((e) => ({ range: editorRange(e.range), text: e.newText }));
	}

	async hints(model: Monaco.editor.ITextModel, range: Monaco.IRange, token?: Monaco.CancellationToken): Promise<Monaco.languages.InlayHintList | null> {
		const client = await this.ready(model);
		if (!client?.capabilities.inlayHintProvider) {
			return null;
		}
		const hints = inlayHints(await client.request<unknown>('textDocument/inlayHint', { textDocument: { uri: model.uri.toString() }, range: lspRange(range) }, 10_000, token));
		return { hints: hints as Monaco.languages.InlayHint[], dispose: () => undefined };
	}

	// ---- rename and quick fixes: edits a server asks for, across files ---------------

	/** Where a rename would start: the name under the cursor, as the server sees it. */
	async renameAt(model: Monaco.editor.ITextModel, position: Monaco.Position, token?: Monaco.CancellationToken): Promise<(Monaco.languages.RenameLocation & Monaco.languages.Rejection) | null> {
		const client = await this.ready(model);
		const word = model.getWordAtPosition(position);
		const here = word ? { range: { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn }, text: word.word } : null;
		if (!client?.capabilities.renameProvider) {
			return null;
		}
		if (!(client.capabilities.renameProvider as { prepareProvider?: boolean }).prepareProvider) {
			return here;
		}
		const found = await client.request<{ start?: LspPosition; end?: LspPosition; range?: LspRange; placeholder?: string; defaultBehavior?: boolean }>('textDocument/prepareRename', this.where(model, position), 10_000, token);
		const range = found?.range ?? (found?.start && found.end ? { start: found.start, end: found.end } : null);
		if (range) {
			return { range: editorRange(range), text: found?.placeholder ?? model.getValueInRange(editorRange(range)) };
		}
		return found?.defaultBehavior && here ? here : { range: here?.range ?? { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }, text: here?.text ?? '', rejectReason: 'This cannot be renamed.' };
	}

	/**
	 * Rename the name under the cursor everywhere the server finds it. The edit is applied here
	 * (see `applyEdit`), so what goes back to Monaco is empty, or the reason nothing was renamed.
	 */
	async rename(model: Monaco.editor.ITextModel, position: Monaco.Position, newName: string, token?: Monaco.CancellationToken): Promise<(Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection) | null> {
		const client = await this.ready(model);
		if (!client?.capabilities.renameProvider) {
			return null;
		}
		client.error = null;
		const edit = await client.request<unknown>('textDocument/rename', { ...this.where(model, position), newName }, 30_000, token);
		if (!edit) {
			return { edits: [], rejectReason: client.error ?? 'The language server found nothing to rename here.' };
		}
		const done = await this.applyEdit(client, edit);
		if (!done.ok) {
			return { edits: [], rejectReason: done.reason };
		}
		const unsaved = done.unsaved.length ? ` ${done.unsaved.length === 1 ? `${done.unsaved[0]} had unsaved edits and still has` : `${done.unsaved.length} files had unsaved edits and still have`}: save to finish.` : '';
		Injector.get(ToastService).success(`Renamed to ${newName}`, `${done.files.length === 1 ? 'In 1 file' : `In ${done.files.length} files`}, which ${done.files.length === 1 ? 'is' : 'are'} in Changes to review.${unsaved}`);
		return { edits: [] };
	}

	/**
	 * Apply an edit a server asked for, to the checkout on screen. Everything is checked first and
	 * nothing is changed unless all of it can be. A file open in the editor is edited there (so it can
	 * be undone) and saved if it had no unsaved edits before; any other file is rewritten on disk.
	 * Either way the result is in the Changes tab, which is where an edit across files gets reviewed.
	 */
	private async applyEdit(client: Client, edit: unknown): Promise<Applied> {
		const monaco = this._monaco!;
		const at = this.root();
		const id = this._repoIds.get(client.key);
		if (!at || !id || at.id !== id || at.root !== client.root) {
			return { ok: false, reason: 'Its checkout is not the one on screen any more, so nothing was changed.' };
		}
		const files = workspaceEdit(edit);
		if (!files) {
			return { ok: false, reason: 'It needs files created, renamed or deleted, which is not done from here yet. Nothing was changed.' };
		}
		const explorer = Injector.get(ExplorerStore);
		const plans: { path: string; model: Monaco.editor.ITextModel | null; wasDirty: boolean; edits: FileEdits['edits']; text: string }[] = [];
		for (const file of files) {
			const resource = monaco.Uri.parse(file.uri);
			const path = this.relativeIn(client.root, resource);
			if (path === null) {
				return { ok: false, reason: `It would change ${resource.path.split('/').pop() ?? 'a file'}, which is outside this checkout. Nothing was changed.` };
			}
			const model = monaco.editor.getModel(resource);
			if (model && !model.isDisposed()) {
				plans.push({ path, model, wasDirty: !!explorer.tabs().find((tab) => tab.path === path)?.dirty, edits: file.edits, text: '' });
				continue;
			}
			const now = await this.backend.readFile(id, path).catch(() => null);
			const text = now && !now.binary && !now.tooLarge ? applyTextEdits(now.text, file.edits) : null;
			if (text === null) {
				return { ok: false, reason: `${path} could not be read or edited. Nothing was changed.` };
			}
			plans.push({ path, model: null, wasDirty: false, edits: file.edits, text });
		}
		const unsaved: string[] = [];
		try {
			for (const plan of plans) {
				if (!plan.model) {
					await this.backend.writeFile(id, plan.path, plan.text, client.root);
					continue;
				}
				plan.model.pushStackElement();
				plan.model.pushEditOperations(
					null,
					plan.edits.map((e) => ({ range: editorRange(e.range), text: e.newText })),
					() => null
				);
				plan.model.pushStackElement();
				if (plan.wasDirty || !(await explorer.save(plan.path))) {
					unsaved.push(plan.path);
				}
			}
		} catch (e) {
			return { ok: false, reason: `It stopped part way: ${e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e)}. Look at Changes for what was done.` };
		}
		// The files rewritten on disk: a server that does not watch it is told, and Changes shows them.
		this.changed(client.root, plans.filter((plan) => !plan.model).map((plan) => ({ path: plan.path, type: 2 as const })));
		void this.repos.refresh();
		return { ok: true, files: plans.map((plan) => plan.path), unsaved };
	}

	async actions(model: Monaco.editor.ITextModel, range: Monaco.Range, context: Monaco.languages.CodeActionContext, token?: Monaco.CancellationToken): Promise<Monaco.languages.CodeActionList | null> {
		const client = await this.ready(model);
		if (!client?.capabilities.codeActionProvider) {
			return null;
		}
		const where = lspRange(range);
		// The server's own diagnostics at this place: a fix is asked for by the error it fixes.
		const diagnostics = (this._reported.get(model.uri.toString()) ?? []).filter((d) => touches(d.range, where));
		const found = codeActions(
			await client.request<unknown>('textDocument/codeAction', { textDocument: { uri: model.uri.toString() }, range: where, context: { diagnostics, only: context.only ? [context.only] : undefined, triggerKind: context.trigger } }, 10_000, token)
		);
		return {
			actions: found.map((action) => ({ title: action.title, kind: action.kind, isPreferred: action.isPreferred, disabled: action.disabled, command: { id: APPLY_ACTION, title: action.title, arguments: [client.key, action.raw] } })),
			dispose: () => undefined,
		};
	}

	/** A quick fix was picked: get its edit if the server left that for later, apply it, then run its command if it has one. */
	private async runAction(key: string, raw: EditorAction['raw']): Promise<void> {
		const client = this._clients.get(key);
		if (!client?.live) {
			return;
		}
		let action = raw;
		if (!action.edit && !action.command && (client.capabilities.codeActionProvider as { resolveProvider?: boolean } | undefined)?.resolveProvider) {
			action = (await client.request<EditorAction['raw']>('codeAction/resolve', action, 15_000)) ?? action;
		}
		if (action.edit) {
			const done = await this.applyEdit(client, action.edit);
			if (!done.ok) {
				Injector.get(ToastService).warning(`"${raw.title ?? 'That fix'}" was not applied`, done.reason);
				return;
			}
		}
		if (action.command?.command) {
			// The server does it, and asks for an edit to be applied if it comes to one (`workspace/applyEdit`).
			await client.request('workspace/executeCommand', { command: action.command.command, arguments: action.command.arguments }, 30_000);
		}
	}

	/**
	 * Symbols by name across the checkout on screen, from the servers running in it (the ones a file
	 * has been opened for). Null when none of them can search.
	 */
	async findSymbols(query: string): Promise<SymbolHit[] | null> {
		const at = this.root();
		const monaco = this._monaco;
		const clients = at && monaco ? [...this._clients.values()].filter((client) => client.live && client.root === at.root && client.capabilities.workspaceSymbolProvider) : [];
		if (!at || !monaco || !clients.length) {
			return null;
		}
		const hits: SymbolHit[] = [];
		for (const found of await Promise.all(clients.map((client) => client.request<unknown>('workspace/symbol', { query }, 10_000)))) {
			for (const symbol of workspaceSymbols(found)) {
				const path = this.relativeIn(at.root, monaco.Uri.parse(symbol.uri));
				if (path !== null) {
					hits.push({ name: symbol.name, kind: symbol.kind, container: symbol.container, path, line: symbol.range?.startLineNumber ?? 1, column: symbol.range?.startColumn ?? 1 });
				}
			}
		}
		return hits;
	}

	async symbols(model: Monaco.editor.ITextModel, token?: Monaco.CancellationToken): Promise<Monaco.languages.DocumentSymbol[]> {
		const client = await this.ready(model);
		const result = await client?.request<unknown>('textDocument/documentSymbol', { textDocument: { uri: model.uri.toString() } }, 15_000, token);
		// Kinds and tags are plain numbers in protocol.ts, already on Monaco's scale.
		return documentSymbols(result) as Monaco.languages.DocumentSymbol[];
	}

	// ---- checking files the editor does not have open -----------------------------

	/**
	 * What the language servers make of a change to the checkout at `root` (which need not be the one
	 * on screen: an agent's worktree, when its turn has ended): the errors it brought, and where what
	 * it touched is used.
	 *
	 * Each server is first shown the changed files as they were at `base`, which with everything else
	 * on disk is the project as it was. The symbols on the changed lines are looked up and their
	 * references asked for; the files those are in are opened too. Then the changed files are swapped
	 * for what is on disk now. Errors reported the second time and not the first are the change's own:
	 * ones that were already there, and ones the checkout itself causes (no `node_modules` in a new
	 * worktree), are in both.
	 *
	 * A server says nothing when it is done, so each step waits until the files have been reported on
	 * and the server has been quiet, with no work in progress, for a moment. Everything opened is
	 * closed again, and a server started only for this is stopped.
	 */
	async check(id: string, root: string, files: CheckedFile[], base: string): Promise<CheckResult> {
		await this.attach();
		const result: CheckResult = { problems: [], known: 0, impact: [], servers: [], files: 0, users: 0, finished: true };
		const running = new Set(this._clients.values());
		const groups = new Map<Client, CheckedFile[]>();
		this._checks.set(root, (this._checks.get(root) ?? 0) + 1);
		try {
			for (const file of files) {
				const language = languageOf(file.path);
				const client = language ? await this.clientAt(id, root, language, true) : null;
				if (client) {
					groups.set(client, [...(groups.get(client) ?? []), file]);
				}
			}
			const touched = new Set(files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])));
			await Promise.all([...groups].map(([client, mine]) => this.checkWith(client, id, root, mine, base, touched, result)));
		} finally {
			const others = (this._checks.get(root) ?? 1) - 1;
			if (others > 0) {
				this._checks.set(root, others);
			} else {
				this._checks.delete(root);
			}
			for (const client of groups.keys()) {
				// Started for this alone, in a checkout nobody is looking at: it would only hold memory.
				if (!others && !running.has(client) && client.live && client.root !== this.root()?.root && ![...this._docs.values()].some((doc) => doc.client === client)) {
					void this.backend.lspStop(client.key).catch(() => undefined);
				}
			}
		}
		const order = (a: { path: string; line: number }, b: { path: string; line: number }): number => a.path.localeCompare(b.path) || a.line - b.line;
		result.problems.sort((a, b) => Number(b.changed) - Number(a.changed) || order(a, b));
		result.impact.sort(order);
		return result;
	}

	/** One server's share of `check`; adds what it finds to `result`. */
	private async checkWith(client: Client, id: string, root: string, files: CheckedFile[], base: string, touched: Set<string>, result: CheckResult): Promise<void> {
		const monaco = this._monaco!;
		const label = this._labels.get(client.key) ?? client.server;
		if (!result.servers.includes(label)) {
			result.servers.push(label);
		}
		const uriOf = (path: string): string => monaco.Uri.file(joinPath(root, path)).toString();
		const read = async (path: string, rev?: string): Promise<string | null> => {
			const file = await this.backend.worktreeRead(id, root, path, rev).catch(() => null);
			return file && !file.binary && !file.tooLarge ? file.text : null;
		};
		const errors = (path: string, changed: boolean, text: string | null, list: EditorMarker[]): (Problem & Located)[] => {
			const lines = text?.split('\n');
			return list.filter((m) => m.severity === 8).map((m) => ({ path, line: m.startLineNumber, column: m.startColumn, message: m.message, source: m.source ?? null, changed, code: (lines?.[m.startLineNumber - 1] ?? '').trim() }));
		};

		// ---- what the server has open for this check, and what it last said of each ----
		const open = new Map<string, { path: string; changed: boolean; text: string; version: number }>();
		const said = new Map<string, LspDiagnostic[]>();
		const saidAt = new Map<string, number>();
		let last = Date.now();
		const show = (uri: string, path: string, changed: boolean, text: string): void => {
			const doc = open.get(uri);
			if (doc) {
				// The whole text: a change without a range replaces it, whichever way the server takes edits.
				client.notify('textDocument/didChange', { textDocument: { uri, version: ++doc.version }, contentChanges: [{ text }] });
				doc.text = text;
				return;
			}
			this._checking.set(uri, (list) => {
				said.set(uri, list);
				saidAt.set(uri, (last = Date.now()));
			});
			open.set(uri, { path, changed, text, version: 1 });
			client.notify('textDocument/didOpen', { textDocument: { uri, languageId: languageId(languageOf(path) ?? client.server, path), version: 1, text } });
		};
		const hide = (uri: string): void => {
			if (open.delete(uri)) {
				this._checking.delete(uri);
				said.delete(uri);
				client.notify('textDocument/didClose', { textDocument: { uri } });
			}
		};
		const now = (): (Problem & Located)[] => [...open].flatMap(([uri, doc]) => errors(doc.path, doc.changed, doc.text, markers(said.get(uri) ?? [])));

		// ---- waiting for a server that never says "done" ----
		const hard = Date.now() + CHECK_LIMIT_MS;
		let deadline = Date.now() + CHECK_QUIET_MS;
		/**
		 * Until the server has had its say on `uris` since `since`: every one reported on and a moment
		 * of quiet, or, as a server does not report on a file again when nothing about it changed, a
		 * longer quiet after it has answered a question asked behind the edits (so it has read them).
		 */
		const settle = async (since: number, uris: string[]): Promise<void> => {
			last = Math.max(last, since);
			let read = 0;
			void client.request('textDocument/documentSymbol', { textDocument: { uri: uris[0] ?? [...open.keys()][0] } }, 30_000).then(() => (read = Date.now()));
			for (;;) {
				const busy = Object.keys(this.working()).some((work) => work.startsWith(`${client.key}|`));
				const quiet = Date.now() - Math.max(last, read);
				const all = uris.every((uri) => (saidAt.get(uri) ?? 0) >= since);
				if (!client.live || (!busy && ((all && quiet >= SETTLED_MS) || (read && quiet >= UNCHANGED_MS)))) {
					return;
				}
				if (busy) {
					deadline = Math.min(hard, Math.max(deadline, Date.now() + 20_000));
				}
				if (Date.now() > deadline) {
					result.finished = false;
					return;
				}
				await new Promise((done) => setTimeout(done, 200));
			}
		};

		try {
			// ---- the changed files, as they were and as they are ----
			const plans: { file: CheckedFile; was: string; wasUri: string; uri: string; before: string | null; after: string | null }[] = [];
			for (const file of files) {
				const uri = uriOf(file.path);
				if (this._docs.has(uri)) {
					// Open in the editor, so its text is the editor's to change: what the server last said of it stands.
					result.files++;
					result.problems.push(...errors(file.path, true, null, monaco.editor.getModelMarkers({ resource: monaco.Uri.parse(uri), owner: 'lsp' }) as EditorMarker[]).map(({ code: _code, ...problem }) => problem));
					continue;
				}
				const was = file.oldPath ?? file.path;
				const wasUri = uriOf(was);
				if (this._checking.has(uri) || this._checking.has(wasUri)) {
					continue; // another check has it
				}
				const before = file.status === 'added' || file.status === 'untracked' ? null : await read(was, base);
				const after = file.status === 'deleted' ? null : await read(file.path);
				if (before !== null || after !== null) {
					plans.push({ file, was, wasUri, uri, before, after });
				}
			}
			if (!plans.length || !client.live) {
				return;
			}

			// ---- as it was ----
			const start = Date.now();
			plans.forEach((plan) => plan.before !== null && show(plan.wasUri, plan.was, true, plan.before));
			let before: Located[] = [];
			if (open.size) {
				await settle(start, [...open.keys()]);
				await this.impactOf(client, root, plans, touched, result);
				const users = [...new Set(result.impact.flatMap((i) => i.uses.map((use) => use.path)))].filter((path) => languageOf(path) !== null && !open.has(uriOf(path))).slice(0, MAX_USERS);
				const opened = Date.now();
				for (const path of users) {
					const uri = uriOf(path);
					const text = this._docs.has(uri) || this._checking.has(uri) ? null : await read(path);
					if (text !== null) {
						show(uri, path, false, text);
						result.users++;
					}
				}
				if (result.users) {
					await settle(opened, [...open].filter(([, doc]) => !doc.changed).map(([uri]) => uri));
				}
				// What a build of the disk says is about the files as they are now, whatever the server was shown.
				before = now().filter((e) => !DISK_SOURCES.includes(e.source ?? ''));
			}

			// ---- as it is ----
			const flip = Date.now();
			const flipped: string[] = [];
			for (const plan of plans) {
				if (plan.before !== null && (plan.after === null || plan.wasUri !== plan.uri)) {
					hide(plan.wasUri);
				}
				if (plan.after !== null) {
					show(plan.uri, plan.file.path, true, plan.after);
					flipped.push(plan.uri);
				}
			}
			const save = saveWanted(client.capabilities);
			if (save) {
				// The checks a server only runs on a save (rust-analyzer's `cargo check`): the files are saved, it was not told.
				flipped.forEach((uri) => client.notify('textDocument/didSave', { textDocument: { uri }, ...(save.includeText ? { text: open.get(uri)?.text } : {}) }));
			}
			await settle(flip, flipped);
			const after = now();
			const fresh = newSince(before, after);
			result.files += plans.length;
			result.known += after.length - fresh.length;
			result.problems.push(...fresh.map(({ code: _code, ...problem }) => problem));
		} finally {
			[...open.keys()].forEach(hide);
		}
	}

	/** Where the symbols on a change's lines are used, in files the change did not touch. Asked of the files as they were. */
	private async impactOf(client: Client, root: string, plans: { file: CheckedFile; was: string; wasUri: string; before: string | null }[], touched: Set<string>, result: CheckResult): Promise<void> {
		const monaco = this._monaco!;
		if (!client.capabilities.documentSymbolProvider || !client.capabilities.referencesProvider) {
			return;
		}
		let asked = 0;
		for (const plan of plans) {
			const spans = plan.before === null ? [] : oldSpans(plan.file.diff);
			if (!spans.length) {
				continue;
			}
			const lines = (plan.before ?? '').split('\n');
			const outline = documentSymbols(await client.request<unknown>('textDocument/documentSymbol', { textDocument: { uri: plan.wasUri } }));
			for (const symbol of symbolsAt(outline, spans)) {
				if (asked++ >= MAX_SYMBOLS || !client.live) {
					return;
				}
				// The name as written (an outline may add its parameters), and where it stands: a flat outline only gives the declaration's start.
				const name = symbol.name.split(/[\s(<]/)[0];
				let line = symbol.selectionRange.startLineNumber;
				let column = symbol.selectionRange.startColumn;
				if (name && !(lines[line - 1] ?? '').startsWith(name, column - 1)) {
					for (let n = symbol.range.startLineNumber; n <= Math.min(symbol.range.endLineNumber, symbol.range.startLineNumber + 5); n++) {
						const at = (lines[n - 1] ?? '').indexOf(name);
						if (at >= 0) {
							line = n;
							column = at + 1;
							break;
						}
					}
				}
				const found = locations(await client.request<unknown>('textDocument/references', { textDocument: { uri: plan.wasUri }, position: { line: line - 1, character: column - 1 }, context: { includeDeclaration: false } }));
				const uses = new Map<string, { path: string; line: number }>();
				for (const location of found) {
					const path = this.relativeIn(root, monaco.Uri.parse(location.uri));
					if (path !== null && !touched.has(path)) {
						uses.set(`${path}:${location.range.startLineNumber}`, { path, line: location.range.startLineNumber });
					}
				}
				if (uses.size) {
					result.impact.push({ symbol: name || symbol.name, path: plan.was, line, uses: [...uses.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line) });
				}
			}
		}
	}

	private diagnostics(params: { uri: string; diagnostics: LspDiagnostic[] }): void {
		const monaco = this._monaco!;
		// As Monaco spells it: a server may send a URI back escaped differently from how it was given.
		this._checking.get(monaco.Uri.parse(params.uri).toString())?.(params.diagnostics ?? []);
		const model = monaco.editor.getModel(monaco.Uri.parse(params.uri));
		if (model) {
			this._reported.set(model.uri.toString(), params.diagnostics ?? []);
			monaco.editor.setModelMarkers(model, 'lsp', markers(params.diagnostics ?? []) as Monaco.editor.IMarkerData[]);
		}
	}
}

// Nothing injects this service, so bring it to life here; it stays idle until the Files tab opens.
queueMicrotask(() => Injector.get(LspService));
