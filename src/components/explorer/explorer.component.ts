import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { effect, untracked } from '@melodicdev/core/signals';
import { html, css } from '@melodicdev/core/template';
import { ToastService } from '@melodicdev/components/toast';
import { DialogService } from '@melodicdev/components/dialog';
import { RepoStore } from '../../services/repo.store';
import { WorkspaceStore } from '../../services/workspace.store';
import { ExplorerStore } from '../../services/explorer.store';
import { TerminalStore } from '../../services/terminal.store';
import { isDesktop, isMac, isWindows, type FileChange, type FileStatus, type OnConflict, type Placed, type TreeEntry } from '../../services/backend.service';
import { plural } from '../../shared/format';
import { statusMark } from '../../shared/format';
import { ctxStyles, listStyles } from '../changes/changes.styles';

const INDENT = 14;

const ICONS: Record<string, string> = {
	png: 'file-image',
	jpg: 'file-image',
	jpeg: 'file-image',
	gif: 'file-image',
	webp: 'file-image',
	svg: 'file-image',
	ico: 'file-image',
	md: 'file-text',
	txt: 'file-text',
	log: 'file-text',
	ts: 'file-code',
	tsx: 'file-code',
	js: 'file-code',
	jsx: 'file-code',
	mjs: 'file-code',
	cjs: 'file-code',
	rs: 'file-code',
	py: 'file-code',
	go: 'file-code',
	java: 'file-code',
	cs: 'file-code',
	c: 'file-code',
	h: 'file-code',
	cpp: 'file-code',
	rb: 'file-code',
	php: 'file-code',
	swift: 'file-code',
	kt: 'file-code',
	sh: 'file-code',
	html: 'file-code',
	css: 'file-code',
	scss: 'file-code',
	json: 'file-code',
	yml: 'file-code',
	yaml: 'file-code',
	toml: 'file-code',
	xml: 'file-code',
	sql: 'file-code',
};

function fileIcon(name: string): string {
	return ICONS[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'file';
}

/** Sidebar "Files" tab: the working tree as folders and files. Clicking a file opens it in the editor. */
@MelodicComponent({
	selector: 'ms-explorer',
	template: explorerTemplate,
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
			flex: 1;
			min-height: 0;
		}
		${listStyles}
		.head {
			flex: none;
			display: flex;
			align-items: center;
			gap: 4px;
			height: 34px;
			padding: 0 6px 0 10px;
			border-bottom: 1px solid var(--ml-color-border);
			color: var(--ml-color-text-secondary);
			font-weight: 500;
		}
		.head .grow {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.icon {
			all: unset;
			display: grid;
			place-items: center;
			width: 26px;
			height: 26px;
			border-radius: 5px;
			color: var(--ml-color-text-muted);
		}
		.icon:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
		.list {
			padding: 4px 0;
		}
		.row {
			gap: 5px;
			min-height: 24px;
			padding-right: 10px;
			border-bottom: 0;
		}
		.row ml-icon {
			flex: none;
			color: var(--ml-color-text-muted);
		}
		.row.sel ml-icon {
			color: inherit;
		}
		.caret {
			flex: none;
			display: grid;
			place-items: center;
			width: 14px;
		}
		.name {
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.row.ignored .name,
		.row.ignored ml-icon {
			opacity: 0.5;
		}
		.row.add:not(.sel) .name {
			color: var(--ms-add);
		}
		.row.mod:not(.sel) .name {
			color: var(--ms-mod);
		}
		.row.ren:not(.sel) .name {
			color: var(--ms-ren);
		}
		.row.con:not(.sel) .name {
			color: var(--ms-del);
		}
		.dot {
			flex: none;
			width: 7px;
			height: 7px;
			margin-right: 4px;
			border-radius: 50%;
			background: var(--ms-mod);
		}
		.note {
			padding: 14px 12px;
			color: var(--ml-color-text-muted);
		}
		.row.drop {
			background: var(--ms-hover);
			box-shadow: inset 0 0 0 1px var(--ml-color-primary);
			border-radius: 4px;
		}
		.list.drop {
			box-shadow: inset 0 0 0 1px var(--ml-color-primary);
		}
		.list:focus {
			outline: none;
		}
		.row.dragging {
			opacity: 0.55;
		}
		.edit {
			flex: 1;
			min-width: 0;
			font: inherit;
			color: var(--ml-color-text);
			background: var(--ml-color-surface);
			border: 1px solid var(--ml-color-primary);
			border-radius: 4px;
			padding: 1px 4px;
			outline: none;
		}
		.ctx {
			max-height: calc(100vh - 16px);
			overflow-y: auto;
		}
		.ctx-item.off {
			opacity: 0.45;
			pointer-events: none;
		}
		.ctx .key {
			margin-left: auto;
			padding-left: 16px;
			color: var(--ml-color-text-muted);
			font-size: 0.85em;
		}
		.dlg p {
			margin: 0 0 10px;
		}
		.dlg ul {
			margin: 0 0 10px;
			padding-left: 18px;
			max-height: 160px;
			overflow-y: auto;
		}
		.foot {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
		}
		${ctxStyles}
	`,
})
export class ExplorerComponent {
	@Service(RepoStore) readonly store!: RepoStore;
	@Service(ExplorerStore) readonly explorer!: ExplorerStore;
	@Service(ToastService) private readonly _toast!: ToastService;
	@Service(WorkspaceStore) private readonly _workspace!: WorkspaceStore;
	@Service(TerminalStore) private readonly _terminals!: TerminalStore;
	@Service(DialogService) private readonly _dialogs!: DialogService;
	elementRef!: HTMLElement;

	/** Right-click menu: on a row, or (entry null) on the empty space below them, meaning the root folder. */
	menu: { entry: TreeEntry | null; x: number; y: number } | null = null;
	/** A name being typed in the tree: a rename, or a new entry in `dir`. */
	editing: { kind: 'rename' | 'file' | 'folder'; dir: string; path: string | null; value: string } | null = null;
	/** Waiting for an answer: these entries would replace namesakes in `dir`. */
	conflict: { names: string[]; dir: string; retry: (how: OnConflict) => Promise<Placed | null> } | null = null;
	/** Entries the delete dialog is asking about. */
	deleting: string[] = [];
	/** The folder a drag would drop into (`''` is the root), while dragging over the tree. */
	dropTarget: string | null = null;
	/** Rows being dragged inside the tree. */
	dragging: string[] = [];

	/** Rows in the order they are on screen, for Shift-click and the arrow keys. Written while rendering, so not a reactive field. */
	readonly order: { rows: TreeEntry[] } = { rows: [] };
	get visible(): TreeEntry[] {
		return this.order.rows;
	}
	private _anchor: string | null = null;
	private _press: { path: string; x: number; y: number; id: number } | null = null;
	private _dragged = false;
	private _hoverTimer: ReturnType<typeof setTimeout> | null = null;
	private _hoverDir: string | null = null;
	private _unlistenDrop: (() => void) | null = null;

	readonly trashName = isWindows() ? 'Recycle Bin' : 'Trash';
	readonly revealLabel = isMac() ? 'Reveal in Finder' : isWindows() ? 'Show in File Explorer' : 'Show in file manager';
	readonly mod = isMac() ? '⌘' : 'Ctrl+';

	private readonly _dismiss = (): void => {
		this.menu = null;
	};
	private readonly _focus = (): void => this.explorer.sync();

	onCreate(): void {
		// Anything that changes the working tree (a save, a checkout, a pull) shows up as a new status.
		effect(() => {
			this.store.repo();
			this.store.status();
			untracked(() => this.explorer.sync());
		});
		window.addEventListener('focus', this._focus);
		window.addEventListener('click', this._dismiss);
		window.addEventListener('blur', this._dismiss);
		void this.listenForDrops();
	}

	onDestroy(): void {
		window.removeEventListener('focus', this._focus);
		window.removeEventListener('click', this._dismiss);
		window.removeEventListener('blur', this._dismiss);
		this.endPress();
		this._unlistenDrop?.();
		this._unlistenDrop = null;
	}

	// ---- clicks and selection ----

	click(ev: MouseEvent | null, entry: TreeEntry, keep = false): void {
		if (this._dragged) {
			this._dragged = false;
			return;
		}
		const picked = this.explorer.selected();
		if (ev && (ev.metaKey || ev.ctrlKey)) {
			const next = new Set(picked);
			if (!next.delete(entry.path)) {
				next.add(entry.path);
			}
			this.explorer.select(next);
			this._anchor = entry.path;
			return;
		}
		if (ev?.shiftKey && this._anchor) {
			const from = this.visible.findIndex((e) => e.path === this._anchor);
			const to = this.visible.findIndex((e) => e.path === entry.path);
			if (from >= 0 && to >= 0) {
				this.explorer.select(this.visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((e) => e.path));
				return;
			}
		}
		this.explorer.select([entry.path]);
		this._anchor = entry.path;
		if (!entry.isDir) {
			this.explorer.open(entry.path, keep);
			this._workspace.revealMain();
		} else if (!keep) {
			this.explorer.toggle(entry.path);
		}
	}

	/** What the menu and keys act on: the selection when the row is part of it, else just the row. */
	targets(entry: TreeEntry | null): string[] {
		if (!entry) {
			return [];
		}
		const picked = this.explorer.selected();
		return picked.has(entry.path) && picked.size > 1 ? this.visible.filter((e) => picked.has(e.path)).map((e) => e.path) : [entry.path];
	}

	openMenu(ev: MouseEvent, entry: TreeEntry | null): void {
		ev.preventDefault();
		ev.stopPropagation();
		if (entry && !this.explorer.selected().has(entry.path)) {
			this.explorer.select([entry.path]);
			this._anchor = entry.path;
		}
		this.menu = { entry, x: Math.min(ev.clientX, window.innerWidth - 240), y: Math.max(8, Math.min(ev.clientY, window.innerHeight - 440)) };
	}

	onKey(ev: KeyboardEvent): void {
		if (this.editing || (ev.target as HTMLElement | null)?.tagName === 'INPUT') {
			return;
		}
		const picked = this.visible.filter((e) => this.explorer.selected().has(e.path));
		const one = picked.length === 1 ? picked[0] : null;
		if (ev.key === 'Delete' || (ev.key === 'Backspace' && (ev.metaKey || ev.ctrlKey))) {
			if (picked.length) {
				ev.preventDefault();
				this.askDelete(picked.map((e) => e.path));
			}
		} else if ((ev.key === 'F2' || (ev.key === 'Enter' && isMac())) && one) {
			ev.preventDefault();
			this.startRename(one);
		} else if (ev.key === 'Enter' && one) {
			ev.preventDefault();
			this.click(null, one, true);
		} else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
			ev.preventDefault();
			const at = this.visible.findIndex((e) => e.path === (one ?? picked[picked.length - 1])?.path);
			const next = this.visible[Math.max(0, Math.min(this.visible.length - 1, at + (ev.key === 'ArrowDown' ? 1 : -1)))];
			if (next) {
				this.explorer.select([next.path]);
				this._anchor = next.path;
				this.elementRef.shadowRoot?.querySelector(`[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: 'nearest' });
			}
		} else if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && one?.isDir) {
			const open = this.explorer.expanded().has(one.path);
			if (open !== (ev.key === 'ArrowRight')) {
				this.explorer.toggle(one.path);
			}
		} else if (ev.key === 'Escape') {
			this.explorer.select([]);
		}
	}

	// ---- names typed in the tree ----

	startRename(entry: TreeEntry): void {
		this.menu = null;
		this.editing = { kind: 'rename', dir: parent(entry.path), path: entry.path, value: entry.name };
		this.focusEdit(entry.isDir ? entry.name.length : Math.max(0, entry.name.lastIndexOf('.')) || entry.name.length);
	}

	startNew(kind: 'file' | 'folder', dir: string): void {
		this.menu = null;
		if (dir && !this.explorer.expanded().has(dir)) {
			this.explorer.toggle(dir);
		}
		this.editing = { kind, dir, path: null, value: '' };
		this.focusEdit(0);
	}

	private focusEdit(selectTo: number): void {
		requestAnimationFrame(() => {
			const input = this.elementRef.shadowRoot?.querySelector<HTMLInputElement>('input.edit');
			input?.focus();
			input?.setSelectionRange(0, selectTo);
		});
	}

	editKey(ev: KeyboardEvent): void {
		ev.stopPropagation();
		if (ev.key === 'Enter') {
			ev.preventDefault();
			void this.finishEdit();
		} else if (ev.key === 'Escape') {
			ev.preventDefault();
			this.editing = null;
			this.focusList();
		}
	}

	async finishEdit(): Promise<void> {
		const edit = this.editing;
		if (!edit) {
			return;
		}
		this.editing = null;
		const name = edit.value.trim();
		if (!name || (edit.kind === 'rename' && edit.path && name === base(edit.path))) {
			this.focusList();
			return;
		}
		if (edit.kind === 'rename' && edit.path) {
			await this.moveWithConflicts([edit.path], edit.dir, name);
		} else {
			await this.explorer.create(edit.dir, name, edit.kind === 'folder');
		}
		this.focusList();
	}

	private focusList(): void {
		requestAnimationFrame(() => this.elementRef.shadowRoot?.querySelector<HTMLElement>('.list')?.focus({ preventScroll: true }));
	}

	// ---- operations ----

	askDelete(paths: string[]): void {
		this.menu = null;
		this.deleting = paths;
		this._dialogs.open('files-delete' as DialogId);
	}

	/** Tabs with unsaved edits that deleting `deleting` would throw away. */
	unsavedIn(paths: string[]): string[] {
		return paths.flatMap((p) => this.explorer.openUnder(p).filter((t) => t.dirty).map((t) => t.path));
	}

	async confirmDelete(): Promise<void> {
		const paths = this.deleting;
		this._dialogs.close('files-delete' as DialogId);
		this.deleting = [];
		if (paths.length && (await this.explorer.trash(paths))) {
			this._toast.success(paths.length === 1 ? `${base(paths[0])} moved to the ${this.trashName}` : `${paths.length} items moved to the ${this.trashName}`);
		}
		this.focusList();
	}

	cancelDelete(): void {
		this._dialogs.close('files-delete' as DialogId);
		this.deleting = [];
	}

	/** Move entries, asking first when that would replace something. */
	async moveWithConflicts(paths: string[], to: string, rename: string | null = null): Promise<void> {
		const placed = await this.explorer.move(paths, to, rename, 'ask');
		if (placed?.conflicts.length) {
			this.askConflict(placed.conflicts, to, (how) => this.explorer.move(paths, to, rename, how));
		}
	}

	async importWithConflicts(sources: string[], to: string): Promise<void> {
		const placed = await this.explorer.importFiles(sources, to, 'ask');
		if (placed?.conflicts.length) {
			this.askConflict(placed.conflicts, to, (how) => this.explorer.importFiles(sources, to, how));
		} else if (placed?.done.length) {
			this._toast.success(placed.done.length === 1 ? `Added ${base(placed.done[0])}` : `Added ${placed.done.length} items to ${to || 'the repository'}`);
		}
	}

	private askConflict(names: string[], dir: string, retry: (how: OnConflict) => Promise<Placed | null>): void {
		this.conflict = { names, dir, retry };
		this._dialogs.open('files-conflict' as DialogId);
	}

	async resolveConflict(how: OnConflict | null): Promise<void> {
		const pending = this.conflict;
		this._dialogs.close('files-conflict' as DialogId);
		this.conflict = null;
		if (pending && how) {
			await pending.retry(how);
		}
	}

	async duplicate(path: string): Promise<void> {
		this.menu = null;
		await this.explorer.duplicate(path);
	}

	reveal(paths: string[]): void {
		this.menu = null;
		void this.explorer.reveal(paths);
	}

	openTerminal(entry: TreeEntry | null): void {
		this.menu = null;
		const dir = !entry ? '' : entry.isDir ? entry.path : parent(entry.path);
		void this._terminals.add(dir || null);
	}

	async ignore(path: string): Promise<void> {
		this.menu = null;
		if (await this.store.ignoreFile(path)) {
			this._toast.success(`${path} added to .gitignore`);
			void this.explorer.rescan();
		}
	}

	discard(changes: FileChange[]): void {
		this.menu = null;
		this.store.ask('discard', { files: changes });
	}

	fileHistory(path: string): void {
		this.menu = null;
		void this.store.showFileHistory(path);
		this._workspace.revealMain();
	}

	async copyPath(paths: string[]): Promise<void> {
		this.menu = null;
		try {
			await navigator.clipboard.writeText(paths.join('\n'));
			this._toast.success(paths.length === 1 ? 'Path copied' : `${paths.length} paths copied`);
		} catch {
			this._toast.error('Could not copy the path');
		}
	}

	/** Jump to this file's diff in the Changes tab. */
	showChanges(path: string): void {
		this.menu = null;
		this.store.setTab('changes');
		this.store.selectFile(path);
		this._workspace.revealMain();
	}

	// ---- dragging rows inside the tree (pointer events: the window's file-drop handling rules out HTML drag and drop) ----

	press(ev: PointerEvent, entry: TreeEntry): void {
		if (ev.button !== 0 || this.editing) {
			return;
		}
		this._press = { path: entry.path, x: ev.clientX, y: ev.clientY, id: ev.pointerId };
		window.addEventListener('pointermove', this.pressMove);
		window.addEventListener('pointerup', this.pressUp);
		window.addEventListener('pointercancel', this.endPress);
	}

	private readonly pressMove = (ev: PointerEvent): void => {
		const press = this._press;
		if (!press) {
			return;
		}
		if (!this.dragging.length) {
			if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < 5) {
				return;
			}
			const entry = this.visible.find((e) => e.path === press.path);
			this.dragging = entry ? this.targets(entry) : [press.path];
			this.menu = null;
		}
		this.setDropTarget(this.folderAt(ev.clientX, ev.clientY, this.dragging));
	};

	private readonly pressUp = (): void => {
		const paths = this.dragging;
		const to = this.dropTarget;
		const dragged = paths.length > 0;
		this.endPress();
		if (dragged) {
			this._dragged = true;
			setTimeout(() => (this._dragged = false), 0);
			if (to !== null && paths.some((p) => parent(p) !== to)) {
				void this.moveWithConflicts(paths, to);
			}
		}
	};

	private readonly endPress = (): void => {
		window.removeEventListener('pointermove', this.pressMove);
		window.removeEventListener('pointerup', this.pressUp);
		window.removeEventListener('pointercancel', this.endPress);
		this._press = null;
		this.dragging = [];
		this.setDropTarget(null);
	};

	/**
	 * The folder under a point: a folder row is itself, a file row is its folder, the empty space below the rows is
	 * the root. Null outside the tree, or where `moving` cannot go (into itself).
	 */
	folderAt(x: number, y: number, moving: string[] = []): string | null {
		const root = this.elementRef.shadowRoot;
		const list = root?.querySelector<HTMLElement>('.list');
		const box = list?.getBoundingClientRect();
		if (!root || !list || !box || !box.width || x < box.left || x > box.right || y < box.top || y > box.bottom) {
			return null;
		}
		const row = (root.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('[data-path]');
		const dir = row ? (row.dataset.dir === '1' ? row.dataset.path! : parent(row.dataset.path!)) : '';
		return moving.some((p) => dir === p || dir.startsWith(`${p}/`)) ? null : dir;
	}

	private setDropTarget(dir: string | null): void {
		if (dir !== this.dropTarget) {
			this.dropTarget = dir;
		}
		// Hovering over a closed folder opens it, so a drop can go deeper.
		if (dir !== this._hoverDir) {
			this._hoverDir = dir;
			if (this._hoverTimer) {
				clearTimeout(this._hoverTimer);
				this._hoverTimer = null;
			}
			if (dir && !this.explorer.expanded().has(dir)) {
				this._hoverTimer = setTimeout(() => {
					if (this._hoverDir === dir && !this.explorer.expanded().has(dir)) {
						this.explorer.toggle(dir);
					}
				}, 700);
			}
		}
	}

	// ---- files dropped from outside the app ----

	private async listenForDrops(): Promise<void> {
		if (!isDesktop()) {
			return; // the browser preview uses HTML drop events instead (`htmlDrop`)
		}
		const { getCurrentWebview } = await import('@tauri-apps/api/webview');
		const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
			const p = event.payload;
			if (p.type === 'leave') {
				this.setDropTarget(null);
				return;
			}
			// Positions arrive in physical pixels.
			const x = p.position.x / window.devicePixelRatio;
			const y = p.position.y / window.devicePixelRatio;
			const dir = this.store.repo() ? this.folderAt(x, y) : null;
			if (p.type === 'drop') {
				this.setDropTarget(null);
				if (dir !== null && p.paths.length) {
					void this.importWithConflicts(p.paths, dir);
				}
			} else {
				this.setDropTarget(dir);
			}
		});
		if (this._unlistenDrop === null && this.elementRef.isConnected) {
			this._unlistenDrop = unlisten;
		} else {
			unlisten();
		}
	}

	htmlOver(ev: DragEvent): void {
		if (isDesktop() || !ev.dataTransfer?.types.includes('Files')) {
			return;
		}
		ev.preventDefault();
		this.setDropTarget(this.folderAt(ev.clientX, ev.clientY));
	}

	htmlDrop(ev: DragEvent): void {
		if (isDesktop()) {
			return;
		}
		ev.preventDefault();
		const dir = this.folderAt(ev.clientX, ev.clientY);
		const names = [...(ev.dataTransfer?.files ?? [])].map((f) => `/Users/demo/Desktop/${f.name}`);
		this.setDropTarget(null);
		if (dir !== null && names.length) {
			void this.importWithConflicts(names, dir);
		}
	}
}

type DialogId = Parameters<DialogService['close']>[0];

const parent = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function explorerTemplate(self: ExplorerComponent) {
	const store = self.store;
	const explorer = self.explorer;
	const children = explorer.children();
	const expanded = explorer.expanded();
	const active = explorer.active();
	const picked = explorer.selected();
	const root = children.get('');
	const edit = self.editing;
	const dragging = new Set(self.dragging);

	// What git says about each file, and which folders hold a change somewhere below them.
	const changed = new Map<string, FileStatus>();
	const changes = new Map<string, FileChange>();
	const touched = new Set<string>();
	for (const f of store.status()?.files ?? []) {
		changes.set(f.path, f);
		if (f.status === 'deleted') {
			continue; // not in the tree
		}
		changed.set(f.path, f.status);
		for (let i = f.path.indexOf('/'); i > 0; i = f.path.indexOf('/', i + 1)) {
			touched.add(f.path.slice(0, i));
		}
	}

	const visible: TreeEntry[] = [];
	const newRow = (dir: string, depth: number) =>
		edit && edit.kind !== 'rename' && edit.dir === dir
			? html`
				<div class="row" style="padding-left: ${8 + depth * INDENT}px">
					<span class="caret"></span>
					<ml-icon icon=${edit.kind === 'folder' ? 'folder' : 'file'} size="sm"></ml-icon>
					${editInput(self)}
				</div>
			`
			: '';
	const rows = (dir: string, depth: number): unknown[] => [
		newRow(dir, depth),
		...(children.get(dir) ?? []).flatMap((e) => {
			visible.push(e);
			const open = e.isDir && expanded.has(e.path);
			const status = e.isDir ? undefined : changed.get(e.path);
			const mark = status ? statusMark(status) : null;
			const renaming = edit?.kind === 'rename' && edit.path === e.path;
			const sel = picked.has(e.path) || (!picked.size && e.path === active);
			const row = html`
				<div
					class="row ${sel ? 'sel' : ''} ${e.ignored ? 'ignored' : ''} ${mark?.tone ?? ''} ${e.isDir && self.dropTarget === e.path ? 'drop' : ''} ${dragging.has(e.path) ? 'dragging' : ''}"
					style="padding-left: ${8 + depth * INDENT}px"
					title=${e.path}
					data-path=${e.path}
					data-dir=${e.isDir ? '1' : '0'}
					@pointerdown=${(ev: PointerEvent) => self.press(ev, e)}
					@click=${(ev: MouseEvent) => !renaming && self.click(ev, e)}
					@dblclick=${(ev: MouseEvent) => !renaming && !ev.metaKey && !ev.ctrlKey && !ev.shiftKey && self.click(null, e, true)}
					@contextmenu=${(ev: MouseEvent) => self.openMenu(ev, e)}
				>
					<span class="caret">${e.isDir ? html`<ml-icon icon=${open ? 'caret-down' : 'caret-right'} size="xs"></ml-icon>` : ''}</span>
					<ml-icon icon=${e.isDir ? (open ? 'folder-open' : 'folder') : fileIcon(e.name)} size="sm"></ml-icon>
					${renaming ? editInput(self) : html`<span class="name">${e.name}</span>`}
					${mark ? html`<span class="mark ${mark.tone}" title=${mark.label}>${mark.letter}</span>` : e.isDir && touched.has(e.path) ? html`<span class="dot" title="Contains changes"></span>` : ''}
				</div>
			`;
			return open ? [row, ...rows(e.path, depth + 1)] : [row];
		}),
	];
	const tree = root ? rows('', 0) : [];
	self.order.rows = visible;

	return html`
		<div class="head">
			<span class="grow">${store.repo()?.name ?? ''}</span>
			<ms-ask-button .scope=${'code'}></ms-ask-button>
			<button class="icon" title="New file" @click=${() => self.startNew('file', newDir(self))}><ml-icon icon="file-plus" size="sm"></ml-icon></button>
			<button class="icon" title="New folder" @click=${() => self.startNew('folder', newDir(self))}><ml-icon icon="folder-plus" size="sm"></ml-icon></button>
			<button class="icon" title="Collapse all folders" @click=${() => explorer.collapseAll()}><ml-icon icon="arrows-in-line-vertical" size="sm"></ml-icon></button>
			<button class="icon" title="Refresh" @click=${() => explorer.rescan()}><ml-icon icon="arrows-clockwise" size="sm"></ml-icon></button>
		</div>
		<div
			class="list ${self.dropTarget === '' ? 'drop' : ''}"
			tabindex="0"
			@keydown=${(ev: KeyboardEvent) => self.onKey(ev)}
			@contextmenu=${(ev: MouseEvent) => self.openMenu(ev, null)}
			@click=${(ev: MouseEvent) => ev.target === ev.currentTarget && explorer.select([])}
			@dragover=${(ev: DragEvent) => self.htmlOver(ev)}
			@dragleave=${() => (self.dropTarget = null)}
			@drop=${(ev: DragEvent) => self.htmlDrop(ev)}
		>
			${!root ? '' : root.length || edit ? tree : html`<div class="note">This repository has no files yet. Drop files here to add them.</div>`}
		</div>
		${menuTemplate(self, changed, changes)}
		${dialogsTemplate(self)}
	`;
}

/** Where the header's New file / New folder buttons put it: the selected folder, a selected file's folder, or the root. */
function newDir(self: ExplorerComponent): string {
	const picked = [...self.explorer.selected()];
	if (picked.length !== 1) {
		return '';
	}
	const entry = self.visible.find((e) => e.path === picked[0]);
	return !entry ? '' : entry.isDir ? entry.path : parent(entry.path);
}

function editInput(self: ExplorerComponent) {
	return html`<input
		class="edit"
		spellcheck="false"
		placeholder=${self.editing?.kind === 'folder' ? 'Folder name' : self.editing?.kind === 'file' ? 'File name' : ''}
		.value=${self.editing?.value ?? ''}
		@input=${(e: Event) => self.editing && (self.editing = { ...self.editing, value: (e.target as HTMLInputElement).value })}
		@keydown=${(e: KeyboardEvent) => self.editKey(e)}
		@blur=${() => void self.finishEdit()}
		@click=${(e: Event) => e.stopPropagation()}
		@pointerdown=${(e: Event) => e.stopPropagation()}
	/>`;
}

function menuTemplate(self: ExplorerComponent, changed: Map<string, FileStatus>, changes: Map<string, FileChange>) {
	const menu = self.menu;
	if (!menu) {
		return '';
	}
	const explorer = self.explorer;
	const m = menu.entry;
	const expanded = explorer.expanded();
	const targets = self.targets(m);
	const many = targets.length > 1;
	const dir = !m ? '' : m.isDir ? m.path : parent(m.path);
	const item = (icon: string, label: string, run: () => void, extra = '', key = '') =>
		html`<div class="ctx-item ${extra}" @click=${run}><ml-icon icon=${icon} size="sm"></ml-icon>${label}${key ? html`<span class="key">${key}</span>` : ''}</div>`;
	const sep = html`<div class="ctx-sep"></div>`;
	const fileChanges = targets.map((p) => changes.get(p)).filter((c): c is FileChange => !!c);
	const del = isMac() ? `${self.mod}⌫` : 'Delete';
	const style = `left: ${menu.x}px; top: ${menu.y}px`;

	if (many) {
		return html`
			<div class="ctx" style=${style} @click=${(e: Event) => e.stopPropagation()}>
				${item('folder-open', self.revealLabel, () => self.reveal(targets))}
				${fileChanges.length ? item('arrow-counter-clockwise', `Discard changes (${fileChanges.length})…`, () => self.discard(fileChanges)) : ''}
				${sep}
				${item('copy', 'Copy paths', () => self.copyPath(targets.map((p) => explorer.absolutePath(p) ?? p)))}
				${item('copy', 'Copy relative paths', () => self.copyPath(targets))}
				${sep}
				${item('trash', `Move ${plural(targets.length, 'item')} to ${self.trashName}…`, () => self.askDelete(targets), 'danger', del)}
			</div>
		`;
	}

	const change = m ? changes.get(m.path) : undefined;
	return html`
		<div class="ctx" style=${style} @click=${(e: Event) => e.stopPropagation()}>
			${m && m.isDir ? item(expanded.has(m.path) ? 'folder' : 'folder-open', expanded.has(m.path) ? 'Collapse' : 'Expand', () => ((self.menu = null), explorer.toggle(m.path))) : ''}
			${m && !m.isDir ? item('browsers', 'Open in new tab', () => ((self.menu = null), self.click(null, m, true))) : ''}
			${!m || m.isDir ? html`${item('file-plus', 'New file…', () => self.startNew('file', dir))}${item('folder-plus', 'New folder…', () => self.startNew('folder', dir))}` : ''}
			${m && changed.has(m.path) ? item('git-diff', 'View changes', () => self.showChanges(m.path)) : ''}
			${m && !m.isDir ? item('clock-counter-clockwise', 'View file history', () => self.fileHistory(m.path)) : ''}
			${sep}
			${m ? item('pencil-simple', 'Rename…', () => self.startRename(m), '', isMac() ? '↩' : 'F2') : ''}
			${m ? item('copy-simple', 'Duplicate', () => void self.duplicate(m.path)) : ''}
			${m ? item('trash', `Move to ${self.trashName}…`, () => self.askDelete(targets), 'danger', del) : ''}
			${m ? sep : ''}
			${item('folder-open', self.revealLabel, () => self.reveal(m ? [m.path] : ['']))}
			${item('terminal-window', 'Open in terminal', () => self.openTerminal(m))}
			${sep}
			${item('copy', 'Copy path', () => self.copyPath([explorer.absolutePath(m?.path ?? '') ?? m?.path ?? '']))}
			${m ? item('copy', 'Copy relative path', () => self.copyPath([m.path])) : ''}
			${m && !m.isDir && !m.ignored && change?.status === 'untracked' ? html`${sep}${item('eye-slash', 'Add to .gitignore', () => void self.ignore(m.path))}` : ''}
			${m && m.isDir && !m.ignored ? html`${sep}${item('eye-slash', 'Add folder to .gitignore', () => void self.ignore(m.path))}` : ''}
			${change && change.status !== 'conflicted' ? html`${sep}${item('arrow-counter-clockwise', 'Discard changes…', () => self.discard([change]), 'danger')}` : ''}
		</div>
	`;
}

function dialogsTemplate(self: ExplorerComponent) {
	const deleting = self.deleting;
	const unsaved = self.unsavedIn(deleting);
	const conflict = self.conflict;
	return html`
		<ml-dialog #files-delete style="--ml-dialog-max-width: 440px">
			<h3 slot="dialog-header">Move to ${self.trashName}</h3>
			<div class="dlg">
				<p>${deleting.length === 1 ? html`Move <b>${deleting[0]}</b> to the ${self.trashName}?` : html`Move <b>${plural(deleting.length, 'item')}</b> to the ${self.trashName}?`}</p>
				${deleting.length > 1 ? html`<ul>${deleting.slice(0, 50).map((p) => html`<li>${p}</li>`)}</ul>` : ''}
				${unsaved.length ? html`<p>Unsaved edits in ${unsaved.length === 1 ? unsaved[0] : plural(unsaved.length, 'open file')} will be lost.</p>` : ''}
				<p>You can get ${deleting.length === 1 ? 'it' : 'them'} back from the ${self.trashName}.</p>
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => self.cancelDelete()}>Cancel</ml-button>
				<ml-button variant="danger" @ml:click=${() => void self.confirmDelete()}>Move to ${self.trashName}</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #files-conflict style="--ml-dialog-max-width: 460px">
			<h3 slot="dialog-header">Already there</h3>
			<div class="dlg">
				<p>${conflict?.names.length === 1 ? html`<b>${conflict.names[0]}</b> already exists in ${conflict.dir || 'the repository root'}.` : html`These already exist in ${conflict?.dir || 'the repository root'}:`}</p>
				${(conflict?.names.length ?? 0) > 1 ? html`<ul>${conflict!.names.slice(0, 50).map((n) => html`<li>${n}</li>`)}</ul>` : ''}
				<p>Replacing moves the existing ${conflict?.names.length === 1 ? 'one' : 'ones'} to the ${self.trashName}.</p>
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => void self.resolveConflict(null)}>Cancel</ml-button>
				<ml-button variant="outline" @ml:click=${() => void self.resolveConflict('skip')}>Skip</ml-button>
				<ml-button variant="outline" @ml:click=${() => void self.resolveConflict('keep-both')}>Keep both</ml-button>
				<ml-button variant="danger" @ml:click=${() => void self.resolveConflict('replace')}>Replace</ml-button>
			</div>
		</ml-dialog>
	`;
}
