/**
 * State behind the Files tab: the folder tree, the files open in the editor,
 * and their text buffers. Kept per repository, so switching away and back
 * finds the same folders open and unsaved edits intact.
 */
import type * as Monaco from 'monaco-editor';
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal, computed } from '@melodicdev/core/signals';
import { BackendService, type FileContent, type TreeEntry } from './backend.service';
import { RepoStore } from './repo.store';
import { loadMonaco } from '../shared/monaco';

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

	readonly activeTab = computed<OpenFile | null>(() => this.tabs().find((t) => t.path === this.active()) ?? null);

	/** The checkout on screen: the active worktree's folder, or the repository's own. Keys all state. */
	private _repoId: string | null = null;
	/** The repository id the backend knows; it resolves to the active checkout itself. */
	private _callId = '';
	private readonly _snapshots = new Map<string, Snapshot>();
	private readonly _buffers = new Map<string, Buffer>();
	private _scan = 0;

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repo(): RepoStore {
		return Injector.get(RepoStore);
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
	sync(): void {
		const repo = this.repo.repo();
		// A linked worktree is a different set of files under the same repository id.
		const id = repo ? repo.worktree || repo.id : null;
		this._callId = repo?.id ?? '';
		if (id !== this._repoId) {
			if (this._repoId) {
				this._snapshots.set(this._repoId, { children: this.children(), expanded: this.expanded(), tabs: this.tabs(), active: this.active(), preview: this.preview() });
			}
			this._repoId = id;
			const saved = id ? this._snapshots.get(id) : undefined;
			this.children.set(saved?.children ?? new Map());
			this.expanded.set(saved?.expanded ?? new Set());
			this.tabs.set(saved?.tabs ?? []);
			this.active.set(saved?.active ?? null);
			this.preview.set(saved?.preview ?? null);
			this.notice.set(null);
		}
		void this.rescan();
	}

	/** Re-read every folder that is open and every file that has no unsaved edits. */
	async rescan(): Promise<void> {
		const id = this._repoId;
		if (!id) {
			return;
		}
		const scan = ++this._scan;
		await Promise.all(['', ...this.expanded()].map((dir) => this.loadDir(dir)));
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
				const uri = monaco.Uri.file(`${id}/${path}`);
				const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(buf.disk, undefined, uri);
				buf.model = model;
				buf.savedVersion = model.getAlternativeVersionId();
				model.onDidChangeContent(() => {
					if (!buf.quiet && id === this._repoId) {
						this.setDirty(path, model.getAlternativeVersionId() !== buf.savedVersion);
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
			const text = buf.model.getValue();
			const version = buf.model.getAlternativeVersionId();
			if (id !== this._repoId) {
				return false; // the checkout changed while this was in flight
			}
			await this.backend.writeFile(this._callId, path, text, id);
			buf.disk = text;
			buf.savedVersion = version;
			this.setDirty(path, buf.model.getAlternativeVersionId() !== version);
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
			this.patch(path, { kind: kindOf(file), dirty: false });
		} catch {
			this.close(path, true);
		}
		if (this.notice()?.path === path) {
			this.notice.set(null);
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
}
