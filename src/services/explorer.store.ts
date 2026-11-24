/**
 * State behind the Files tab: the folder tree, the files open in the editor,
 * and their text buffers. Kept per repository, so switching away and back
 * finds the same folders open and unsaved edits intact.
 */
import type * as Monaco from 'monaco-editor';
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal, computed } from '@melodicdev/core/signals';
import { BackendService, type FileContent, type OnConflict, type Placed, type TreeEntry } from './backend.service';
import { RepoStore } from './repo.store';
import { loadMonaco } from '../shared/monaco';
import { joinPath } from '../shared/paths';
import { EditorSettingsStore } from './editor-settings.store';
import { FileIndexStore } from './file-index.store';
import { editorConfigFor, parseEditorConfig, type EditorConfig, type ParsedEditorConfig } from '../shared/editorconfig';

export interface OpenFile {
	path: string;
	/** `text` is the only kind the editor shows; the rest get a message. */
	kind: 'loading' | 'text' | 'binary' | 'large' | 'missing';
	dirty: boolean;
}

/** A question about one open file, asked in a bar above the editor. */
export interface Notice {
	path: string;
	/** `close`: closing with unsaved edits. `conflict`: saving over a file that changed on disk. */
	kind: 'close' | 'conflict';
}

interface Buffer {
	/** The file's text as last read from or written to disk. */
	disk: string;
	model: Monaco.editor.ITextModel | null;
	/** The model version that matches `disk`. */
	savedVersion: number;
	/** Unsaved text to start the model with (a file renamed while it had edits). */
	pending?: string;
	view: Monaco.editor.ICodeEditorViewState | null;
	/** Set while the model is being replaced from disk, so that is not seen as an edit. */
	quiet: boolean;
}

interface Snapshot {
	children: ReadonlyMap<string, TreeEntry[]>;
	expanded: ReadonlySet<string>;
	tabs: OpenFile[];
	active: string | null;
	preview: string | null;
}

function kindOf(file: FileContent): OpenFile['kind'] {
	return file.tooLarge ? 'large' : file.binary ? 'binary' : 'text';
}

@Injectable()
export class ExplorerStore {
	/** Folder path (`''` is the root) to its entries, for every folder loaded so far. */
	readonly children = signal<ReadonlyMap<string, TreeEntry[]>>(new Map());
	readonly expanded = signal<ReadonlySet<string>>(new Set());
	readonly tabs = signal<OpenFile[]>([]);
	readonly active = signal<string | null>(null);
	/** The tab that the next single click replaces, as in VS Code. Editing or double-clicking keeps it. */
	readonly preview = signal<string | null>(null);
	readonly notice = signal<Notice | null>(null);
	readonly saving = signal<string | null>(null);
	/** Called with a file's model once its edits are on disk (language servers are told about saves). */
	readonly afterSave: ((model: Monaco.editor.ITextModel) => void)[] = [];
	/** Rows picked in the tree (Cmd/Ctrl- and Shift-click); the context menu and keys act on all of them. */
	readonly selected = signal<ReadonlySet<string>>(new Set());

	readonly activeTab = computed<OpenFile | null>(() => this.tabs().find((t) => t.path === this.active()) ?? null);

	/** The checkout on screen: the active worktree's folder, or the repository's own. Keys all state. */
	private _repoId: string | null = null;
	/** The repository id the backend knows; it resolves to the active checkout itself. */
	private _callId = '';
	private readonly _snapshots = new Map<string, Snapshot>();
	private readonly _buffers = new Map<string, Buffer>();
	private _scan = 0;
	/** Each checkout's `.editorconfig`, read on every rescan. */
	private readonly _editorconfig = new Map<string, ParsedEditorConfig>();
	private readonly _autoSave = new Map<string, ReturnType<typeof setTimeout>>();
	private _blurHooked = false;

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repo(): RepoStore {
		return Injector.get(RepoStore);
	}
	private get settings(): EditorSettingsStore {
		return Injector.get(EditorSettingsStore);
	}
	private key(path: string, id = this._repoId): string {
		return `${id}\n${path}`;
	}
	private buffer(path: string): Buffer | undefined {
		return this._buffers.get(this.key(path));
	}

	// ---- lifecycle ----------------------------------------------------------

	/**
	 * Line up with the current repository, then re-read what is on screen. The
	 * Files components call this when they appear and whenever the status changes.
	 */
	/** A repository-relative path spelled as an absolute one in the checkout on screen, or null with no repository. */
	absolutePath(path: string): string | null {
		const repo = this.repo.repo();
		return repo ? joinPath(repo.worktree || repo.path, path) : null;
	}

	sync(): void {
		const repo = this.repo.repo();
		// A linked worktree is a different set of files under the same repository id.
		const id = repo ? repo.worktree || repo.id : null;
		this._callId = repo?.id ?? '';
		if (id !== this._repoId) {
			if (this._repoId) {
				this._snapshots.set(this._repoId, { children: this.children(), expanded: this.expanded(), tabs: this.tabs(), active: this.active(), preview: this.preview() });
				this.rest(this._repoId);
			}
			this._repoId = id;
			const saved = id ? this._snapshots.get(id) : undefined;
			this.children.set(saved?.children ?? new Map());
			this.expanded.set(saved?.expanded ?? new Set());
			this.tabs.set(saved?.tabs ?? []);
			this.active.set(saved?.active ?? null);
			this.preview.set(saved?.preview ?? null);
			this.selected.set(new Set());
			this.notice.set(null);
			// A file whose read was under way when this checkout went off screen: its answer was dropped then,
			// and a rescan leaves a tab that is loading alone, so nothing else would ask again.
			for (const tab of this.tabs()) {
				if (tab.kind === 'loading') {
					void this.read(tab.path, false);
				}
			}
		}
		void this.rescan();
	}

	/**
	 * A checkout went off screen: its editor models go, and with them the copies Monaco's workers
	 * and the language servers' client keep. The tabs stay, with each file's text as last read and
	 * its scroll position, so coming back makes the models again. A file with unsaved edits keeps
	 * its model: the edits and their undo history are only there.
	 */
	private rest(checkout: string): void {
		const prefix = `${checkout}\n`;
		for (const [key, buf] of this._buffers) {
			if (key.startsWith(prefix) && buf.model && buf.model.getAlternativeVersionId() === buf.savedVersion) {
				buf.model.dispose();
				buf.model = null;
			}
		}
	}

	/** Re-read every folder that is open and every file that has no unsaved edits. */
	async rescan(): Promise<void> {
		const id = this._repoId;
		if (!id) {
			return;
		}
		const scan = ++this._scan;
		this.hookBlur();
		await Promise.all([...['', ...this.expanded()].map((dir) => this.loadDir(dir)), this.loadEditorConfig(id)]);
		if (scan !== this._scan || id !== this._repoId) {
			return;
		}
		await Promise.all(
			this.tabs()
				.filter((t) => !t.dirty && t.kind !== 'loading')
				.map((t) => this.read(t.path, true))
		);
	}

	// ---- tree ---------------------------------------------------------------

	private async loadDir(dir: string): Promise<void> {
		const id = this._repoId;
		if (!id) {
			return;
		}
		let entries: TreeEntry[] | null;
		try {
			entries = await this.backend.listDir(this._callId, dir);
		} catch {
			entries = null; // the folder is gone
		}
		if (id !== this._repoId) {
			return;
		}
		const current = this.children().get(dir);
		if (entries) {
			if (!current || JSON.stringify(current) !== JSON.stringify(entries)) {
				this.children.set(new Map(this.children()).set(dir, entries));
			}
			return;
		}
		if (dir) {
			const next = new Map(this.children());
			next.delete(dir);
			this.children.set(next);
			this.expanded.set(new Set([...this.expanded()].filter((d) => d !== dir && !d.startsWith(`${dir}/`))));
		} else if (!current || current.length) {
			this.children.set(new Map(this.children()).set('', []));
		}
	}

	toggle(dir: string): void {
		const next = new Set(this.expanded());
		if (next.delete(dir)) {
			this.expanded.set(next);
			return;
		}
		this.expanded.set(next.add(dir));
		void this.loadDir(dir);
	}

	collapseAll(): void {
		this.expanded.set(new Set());
	}

	// ---- open files ---------------------------------------------------------

	/** Show a file. A single click opens it as the preview tab; `keep` (a double click) gives it its own. */
	open(path: string, keep = false): void {
		const tabs = this.tabs();
		if (tabs.some((t) => t.path === path)) {
			if (keep && this.preview() === path) {
				this.preview.set(null);
			}
		} else {
			const fresh: OpenFile = { path, kind: 'loading', dirty: false };
			const old = this.preview();
			if (old && tabs.some((t) => t.path === old && !t.dirty)) {
				this.tabs.set(tabs.map((t) => (t.path === old ? fresh : t)));
				this.forget(old);
			} else {
				this.tabs.set([...tabs, fresh]);
			}
			this.preview.set(keep ? null : path);
			void this.read(path, false);
		}
		this.active.set(path);
		Injector.get(FileIndexStore).opened(path);
	}

	/**
	 * Show a file with the cursor on a line (1-based), for links that point into the code.
	 * The Files tab has to be the one on screen; the editor swaps to the file once it has
	 * loaded, so this waits for that (as LspService.reveal does) before moving the cursor.
	 * Resolves to whether the cursor got there.
	 */
	async openAt(path: string, line: number, column = 1): Promise<boolean> {
		this.sync();
		const id = this._repoId;
		if (!id) {
			return false;
		}
		this.open(path, true);
		const monaco = await loadMonaco();
		// The same address `model()` gives the file.
		const wanted = monaco.Uri.file(joinPath(id, path)).toString();
		return new Promise((resolve) => {
			let tries = 0;
			const timer = setInterval(() => {
				const editor = monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === wanted);
				if (editor) {
					clearInterval(timer);
					const position = { lineNumber: Math.min(Math.max(1, line), editor.getModel()?.getLineCount() ?? 1), column: Math.max(1, column) };
					editor.setPosition(position);
					editor.revealPositionInCenter(position);
					editor.focus();
					resolve(true);
				} else if (++tries > 160 || id !== this._repoId || !this.tabs().some((t) => t.path === path && (t.kind === 'loading' || t.kind === 'text'))) {
					clearInterval(timer); // closed, not text, or the editor never came up
					resolve(false);
				}
			}, 50);
		});
	}

	/** Load a file from disk into its tab. With `quietly`, a file that is gone just closes. */
	private async read(path: string, quietly: boolean): Promise<void> {
		const id = this._repoId;
		if (!id) {
			return;
		}
		let file: FileContent | null;
		try {
			file = await this.backend.readFile(this._callId, path);
		} catch {
			file = null;
		}
		const tab = this.tabs().find((t) => t.path === path);
		if (id !== this._repoId || !tab || tab.dirty) {
			return;
		}
		if (!file) {
			if (quietly) {
				this.close(path, true);
			} else {
				this.patch(path, { kind: 'missing' });
			}
			return;
		}
		const kind = kindOf(file);
		if (kind === 'text') {
			const buf = this.buffer(path);
			if (!buf) {
				this._buffers.set(this.key(path), { disk: file.text, model: null, savedVersion: 0, view: null, quiet: false });
			} else if (buf.disk !== file.text) {
				this.replace(buf, file.text);
			}
		}
		this.patch(path, { kind });
	}

	/** Put new text from disk into a buffer without it counting as an edit. */
	private replace(buf: Buffer, text: string): void {
		buf.disk = text;
		if (buf.model) {
			buf.quiet = true;
			buf.model.setValue(text);
			buf.quiet = false;
			buf.savedVersion = buf.model.getAlternativeVersionId();
		}
	}

	private patch(path: string, change: Partial<OpenFile>): void {
		const tabs = this.tabs();
		const tab = tabs.find((t) => t.path === path);
		if (tab && (Object.keys(change) as (keyof OpenFile)[]).some((k) => tab[k] !== change[k])) {
			this.tabs.set(tabs.map((t) => (t === tab ? { ...t, ...change } : t)));
		}
	}

	/**
	 * `patch` for a tab of `checkout`, which may have gone off screen while a save or a read was under way:
	 * its tabs are then in its snapshot, and the tab of the same path in the checkout on screen is another file.
	 */
	private patchIn(checkout: string, path: string, change: Partial<OpenFile>): void {
		if (checkout === this._repoId) {
			this.patch(path, change);
			return;
		}
		const kept = this._snapshots.get(checkout);
		if (kept) {
			this._snapshots.set(checkout, { ...kept, tabs: kept.tabs.map((t) => (t.path === path ? { ...t, ...change } : t)) });
		}
	}

	private forget(path: string): void {
		const key = this.key(path);
		this._buffers.get(key)?.model?.dispose();
		this._buffers.delete(key);
	}

	/** The Monaco model for an open text file, created the first time the editor asks. */
	async model(path: string): Promise<Monaco.editor.ITextModel | null> {
		const id = this._repoId;
		const buf = this.buffer(path);
		if (!id || !buf) {
			return null;
		}
		if (!buf.model) {
			const monaco = await loadMonaco();
			if (this._buffers.get(this.key(path, id)) !== buf) {
				return null; // closed while Monaco was loading
			}
			if (!buf.model) {
				// The real path gives Monaco the file's language, and keeps two repositories' files apart.
				const uri = monaco.Uri.file(joinPath(id, path));
				const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(buf.pending ?? buf.disk, undefined, uri);
				buf.model = model;
				// Text carried over from before a rename is an edit until it is saved.
				buf.savedVersion = buf.pending !== undefined && buf.pending !== buf.disk ? -1 : model.getAlternativeVersionId();
				buf.pending = undefined;
				model.onDidChangeContent(() => {
					if (!buf.quiet && id === this._repoId) {
						this.setDirty(path, model.getAlternativeVersionId() !== buf.savedVersion);
						this.scheduleAutoSave(path);
					}
				});
			}
		}
		return buf.model;
	}

	private setDirty(path: string, dirty: boolean): void {
		this.patch(path, { dirty });
		if (dirty && this.preview() === path) {
			this.preview.set(null);
		}
	}

	saveView(path: string, view: Monaco.editor.ICodeEditorViewState | null): void {
		const buf = this.buffer(path);
		if (buf) {
			buf.view = view;
		}
	}

	view(path: string): Monaco.editor.ICodeEditorViewState | null {
		return this.buffer(path)?.view ?? null;
	}

	/**
	 * Write a file's edits to disk. Unless `overwrite` is set, a file that changed on
	 * disk since it was read is not written; the editor asks what to do instead.
	 */
	async save(path: string, overwrite = false): Promise<boolean> {
		const id = this._repoId;
		const buf = this.buffer(path);
		if (!id || !buf?.model || this.saving()) {
			return false;
		}
		this.saving.set(path);
		try {
			if (!overwrite) {
				const now = await this.backend.readFile(this._callId, path).catch(() => null);
				if (now && (kindOf(now) !== 'text' || now.text !== buf.disk)) {
					this.active.set(path);
					this.notice.set({ path, kind: 'conflict' });
					return false;
				}
			}
			this.tidyModel(path, buf.model);
			const text = buf.model.getValue();
			const version = buf.model.getAlternativeVersionId();
			if (id !== this._repoId) {
				return false; // the checkout changed while this was in flight
			}
			await this.backend.writeFile(this._callId, path, text, id);
			buf.disk = text;
			buf.savedVersion = version;
			const saved = buf.model;
			this.afterSave.forEach((listener) => listener(saved));
			const dirty = buf.model.getAlternativeVersionId() !== version;
			if (id !== this._repoId) {
				// The checkout went off screen while the file was written: the tab that is saved is its own.
				this.patchIn(id, path, { dirty });
				this.rest(id);
				return true;
			}
			this.setDirty(path, dirty);
			if (this.notice()?.path === path) {
				this.notice.set(null);
			}
			void this.repo.refresh(); // the Changes tab now has something new
			return true;
		} catch (e) {
			this.repo.fail(e);
			return false;
		} finally {
			this.saving.set(null);
		}
	}

	/** Throw the edits away and show the file as it is on disk. */
	async revert(path: string): Promise<void> {
		const id = this._repoId;
		const buf = this.buffer(path);
		if (!id || !buf) {
			return;
		}
		try {
			const file = await this.backend.readFile(this._callId, path);
			if (kindOf(file) === 'text') {
				buf.disk = '\u0000'; // force the replace even if the text matches what was last read
				this.replace(buf, file.text);
			}
			if (id !== this._repoId) {
				this.patchIn(id, path, { kind: kindOf(file), dirty: false }); // its checkout went off screen meanwhile
				this.rest(id);
				return;
			}
			this.patch(path, { kind: kindOf(file), dirty: false });
		} catch {
			if (id !== this._repoId) {
				return;
			}
			this.close(path, true);
		}
		if (this.notice()?.path === path) {
			this.notice.set(null);
		}
	}

	/**
	 * A file was rewritten on disk by the app itself (an edit a language server asked for): its tab,
	 * if it has one without edits of its own, shows what is there now.
	 */
	async reload(path: string): Promise<void> {
		const tab = this.tabs().find((t) => t.path === path);
		const buf = this.buffer(path);
		if (tab && !tab.dirty && buf) {
			// Text carried over from before a rename is older than what was just written.
			buf.pending = undefined;
			await this.revert(path);
		}
	}

	/** Close a tab. One with unsaved edits asks first, unless `discard` is set. */
	close(path: string, discard = false): void {
		const tabs = this.tabs();
		const at = tabs.findIndex((t) => t.path === path);
		if (at < 0) {
			return;
		}
		if (tabs[at].dirty && !discard) {
			this.active.set(path);
			this.notice.set({ path, kind: 'close' });
			return;
		}
		const rest = tabs.filter((t) => t.path !== path);
		this.tabs.set(rest);
		if (this.active() === path) {
			this.active.set(rest[Math.min(at, rest.length - 1)]?.path ?? null);
		}
		if (this.preview() === path) {
			this.preview.set(null);
		}
		if (this.notice()?.path === path) {
			this.notice.set(null);
		}
		this.forget(path);
	}

	async saveAndClose(path: string): Promise<void> {
		if (await this.save(path)) {
			this.close(path, true);
		}
	}

	dismissNotice(): void {
		this.notice.set(null);
	}


	// ---- .editorconfig, tidying on save, auto-save -----------------------------

	private async loadEditorConfig(id: string): Promise<void> {
		let text = '';
		try {
			const file = await this.backend.readFile(this._callId, '.editorconfig');
			text = file.binary || file.tooLarge ? '' : file.text;
		} catch {
			/* none */
		}
		this._editorconfig.set(id, parseEditorConfig(text));
	}

	/** What the repository's `.editorconfig` says about one file (nothing when Settings turns it off). */
	configFor(path: string): EditorConfig {
		const parsed = this._repoId ? this._editorconfig.get(this._repoId) : undefined;
		return parsed && this.settings.settings().editorconfig ? editorConfigFor(parsed, path) : {};
	}

	/** Trailing whitespace and the final newline, as Settings and `.editorconfig` ask, as edits (undoable, cursor kept). */
	private tidyModel(path: string, model: Monaco.editor.ITextModel): void {
		const s = this.settings.settings();
		const ec = this.configFor(path);
		const trim = ec.trimTrailingWhitespace ?? s.trimTrailing;
		const finalNewline = ec.insertFinalNewline ?? s.finalNewline;
		if (!trim && !finalNewline) {
			return;
		}
		const edits: Monaco.editor.IIdentifiedSingleEditOperation[] = [];
		const lines = model.getLineCount();
		if (trim) {
			for (let n = 1; n <= lines; n++) {
				const line = model.getLineContent(n);
				const kept = line.replace(/[ \t]+$/, '').length;
				if (kept < line.length) {
					edits.push({ range: { startLineNumber: n, startColumn: kept + 1, endLineNumber: n, endColumn: line.length + 1 }, text: '' });
				}
			}
		}
		const last = model.getLineContent(lines);
		if (finalNewline && model.getValueLength() > 0 && last.replace(trim ? /[ \t]+$/ : /$^/, '').length > 0) {
			edits.push({ range: { startLineNumber: lines, startColumn: last.length + 1, endLineNumber: lines, endColumn: last.length + 1 }, text: model.getEOL() });
		}
		if (edits.length) {
			model.pushEditOperations(null, edits, () => null);
		}
	}

	private scheduleAutoSave(path: string): void {
		if (this.settings.settings().autoSave !== 'delay') {
			return;
		}
		const key = this.key(path);
		clearTimeout(this._autoSave.get(key));
		const id = this._repoId;
		this._autoSave.set(
			key,
			setTimeout(() => {
				this._autoSave.delete(key);
				if (id === this._repoId && this.tabs().some((t) => t.path === path && t.dirty)) {
					void this.save(path);
				}
			}, 1000)
		);
	}

	/** Every tab with unsaved edits, saved (auto-save on leaving the window). */
	async saveAll(): Promise<void> {
		for (const tab of this.tabs().filter((t) => t.dirty && t.kind === 'text')) {
			await this.save(tab.path);
		}
	}

	private hookBlur(): void {
		if (this._blurHooked || typeof window === 'undefined') {
			return;
		}
		this._blurHooked = true;
		window.addEventListener('blur', () => {
			if (this.settings.settings().autoSave === 'focus') {
				void this.saveAll();
			}
		});
	}

	// ---- file operations ----------------------------------------------------

	/** The checkout on screen, absolute; every file operation names it so a worktree switch in between refuses. */
	get root(): string {
		return this._repoId ?? '';
	}

	select(paths: Iterable<string>): void {
		this.selected.set(new Set(paths));
	}

	/** Tabs open on `path` or anything under it. */
	openUnder(path: string): OpenFile[] {
		return this.tabs().filter((t) => t.path === path || t.path.startsWith(`${path}/`));
	}

	/** Reload the folders an operation touched and let the Changes tab know. */
	private async touched(dirs: string[]): Promise<void> {
		const open = this.expanded();
		await Promise.all([...new Set(dirs)].filter((d) => d === '' || open.has(d) || this.children().has(d)).map((d) => this.loadDir(d)));
		void this.repo.refresh();
	}

	private expand(dir: string): void {
		const next = new Set(this.expanded());
		for (let i = dir.indexOf('/'); i > 0; i = dir.indexOf('/', i + 1)) {
			next.add(dir.slice(0, i));
		}
		if (dir) {
			next.add(dir);
		}
		this.expanded.set(next);
	}

	/** A new empty file (opened) or folder in `dir`. Resolves to its path, or null when refused. */
	async create(dir: string, name: string, isDir: boolean): Promise<string | null> {
		try {
			const path = await this.backend.createEntry(this._callId, this.root, dir, name.trim(), isDir);
			this.expand(dir);
			await this.touched([dir]);
			this.select([path]);
			if (!isDir) {
				this.open(path, true);
			}
			return path;
		} catch (e) {
			this.repo.fail(e);
			return null;
		}
	}

	/**
	 * Move entries into folder `to` (`rename`: the one entry's new name). With `onConflict` 'ask' a clash changes
	 * nothing and comes back in `conflicts`, for the caller to ask about. Open tabs follow what moved.
	 */
	async move(paths: string[], to: string, rename: string | null, onConflict: OnConflict = 'ask'): Promise<Placed | null> {
		// Moving a folder and something inside it: the folder brings it along.
		const roots = paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(`${q}/`)));
		try {
			const placed = await this.backend.moveEntries(this._callId, this.root, roots, to, rename, onConflict);
			if (placed.conflicts.length) {
				return placed;
			}
			placed.done.forEach((dest, i) => this.renamed(placed.sources[i], dest));
			if (to) {
				this.expand(to);
			}
			await this.touched([to, ...roots.map(parent)]);
			this.select(placed.done);
			return placed;
		} catch (e) {
			this.repo.fail(e);
			return null;
		}
	}

	/** Copy files dropped from outside the app into folder `to`. Same conflict handling as `move`. */
	async importFiles(sources: string[], to: string, onConflict: OnConflict = 'ask'): Promise<Placed | null> {
		try {
			const placed = await this.backend.importEntries(this._callId, this.root, sources, to, onConflict);
			if (placed.conflicts.length) {
				return placed;
			}
			this.expand(to);
			await this.touched([to]);
			this.select(placed.done);
			return placed;
		} catch (e) {
			this.repo.fail(e);
			return null;
		}
	}

	async duplicate(path: string): Promise<string | null> {
		try {
			const copy = await this.backend.duplicateEntry(this._callId, this.root, path);
			await this.touched([parent(path)]);
			this.select([copy]);
			return copy;
		} catch (e) {
			this.repo.fail(e);
			return null;
		}
	}

	/** Move entries to the OS trash and close their tabs (edits included: the caller has asked). */
	async trash(paths: string[]): Promise<boolean> {
		try {
			await this.backend.trashEntries(this._callId, this.root, paths);
			for (const p of paths) {
				for (const tab of this.openUnder(p)) {
					this.close(tab.path, true);
				}
			}
			this.select([]);
			await this.touched(paths.map(parent));
			return true;
		} catch (e) {
			this.repo.fail(e);
			await this.touched(paths.map(parent));
			return false;
		}
	}

	/** Show entries selected in Finder / Explorer / the file manager. */
	async reveal(paths: string[]): Promise<void> {
		try {
			await this.backend.openIn(this._callId, 'reveal', paths.join('\n'));
		} catch (e) {
			this.repo.fail(e);
		}
	}

	/** Tabs, buffers and folder state that were under `from` now live under `to`. */
	private renamed(from: string, to: string): void {
		const move = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
		const tabs = this.tabs();
		if (tabs.some((t) => move(t.path) !== t.path)) {
			for (const tab of tabs) {
				const next = move(tab.path);
				if (next === tab.path) {
					continue;
				}
				const buf = this.buffer(tab.path);
				if (buf) {
					// The model is keyed by its path, so it is made again under the new one, edits and all.
					buf.pending = buf.model ? buf.model.getValue() : buf.pending;
					buf.model?.dispose();
					buf.model = null;
					buf.view = null;
					this._buffers.delete(this.key(tab.path));
					this._buffers.set(this.key(next), buf);
				}
			}
			this.tabs.set(tabs.map((t) => ({ ...t, path: move(t.path) })));
			const active = this.active();
			if (active) {
				this.active.set(move(active));
			}
			const preview = this.preview();
			if (preview) {
				this.preview.set(move(preview));
			}
			const notice = this.notice();
			if (notice) {
				this.notice.set({ ...notice, path: move(notice.path) });
			}
		}
		const expanded = [...this.expanded()];
		if (expanded.some((d) => move(d) !== d)) {
			this.expanded.set(new Set(expanded.map(move)));
		}
	}
}

const parent = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));

