import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { signal } from '@melodicdev/core/signals';
import { html, css } from '@melodicdev/core/template';
import { RepoStore } from '../../services/repo.store';
import { ExplorerStore } from '../../services/explorer.store';
import { FileIndexStore } from '../../services/file-index.store';
import { WorkspaceStore } from '../../services/workspace.store';
import { LspService, type SymbolHit } from '../../services/lsp.service';
import { isMac } from '../../services/backend.service';
import { marked, parseGoTo, rankFiles, type Ranked } from '../../shared/fuzzy';
import { nothing } from '../ai/ai-entry';

/** Whether the box is showing, and what it starts with: `''` for files, `'@'` for symbols. */
const goTo = signal<{ start: string } | null>(null);

/** Open the "Go to" box: on files (Cmd/Ctrl+P), or on symbols (Cmd/Ctrl+T, the same as typing `@` first). */
export function openGoTo(mode: 'files' | 'symbols' = 'files'): void {
	goTo.set({ start: mode === 'symbols' ? '@' : '' });
}

/** Monaco's SymbolKind, as a word for the row. */
const KINDS = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];
const SHOWN = 50;

/**
 * Go to a file by name, or with `@` to a symbol, anywhere in the checkout on screen: a box at the
 * top of the window with the answers under it. File names are matched here (shared/fuzzy.ts) against
 * the list `FileIndexStore` keeps; symbols are the language servers' answers. Names and paths come
 * from the repository and the servers: text only.
 */
@MelodicComponent({
	selector: 'ms-go-to',
	template: (self: GoToComponent) => {
		if (!goTo()) {
			return nothing();
		}
		// Read so the list arriving, or a file being deleted, shows without another keystroke.
		self.files.list();
		const symbols = self.symbols;
		const files = self.mode === 'files' ? self.fileHits() : [];
		const recent = new Set(self.query.trim() ? [] : self.files.recent());
		const note = self.mode === 'files' ? self.fileNote(files.length) : self.note;
		const piece = (p: { text: string; hit: boolean }) => (p.hit ? html`<b>${p.text}</b>` : p.text);
		return html`
			<div class="veil" @mousedown=${() => self.close()}></div>
			<div class="box" @keydown=${self.keydown}>
				<input type="text" placeholder="Go to a file by name    @ for a symbol    :12 for a line" aria-label="Go to a file or symbol" spellcheck="false" autocomplete="off" .value=${self.query} @input=${(e: Event) => self.typed((e.target as HTMLInputElement).value)} />
				${note ? html`<div class="note">${note}</div>` : ''}
				${self.mode === 'files' && files.length
					? html`
						<div class="hits">
							${files.map((hit, at) => {
								const cut = hit.path.lastIndexOf('/') + 1;
								return html`
									<button class="hit ${at === self.active ? 'on' : ''}" title=${hit.path} @mousemove=${() => (self.active = at)} @click=${() => self.openFile(hit.path)}>
										<span class="name">${marked(hit.path.slice(cut), cut, hit.at).map(piece)}</span>
										<span class="dir"><bdi>${marked(hit.path.slice(0, Math.max(0, cut - 1)), 0, hit.at).map(piece)}</bdi></span>
										${recent.has(hit.path) ? html`<span class="tag">opened lately</span>` : ''}
									</button>
								`;
							})}
						</div>
					`
					: ''}
				${self.mode === 'symbols' && symbols.length
					? html`
						<div class="hits">
							${symbols.slice(0, SHOWN).map(
								(hit, at) => html`
									<button class="hit ${at === self.active ? 'on' : ''}" @mousemove=${() => (self.active = at)} @click=${() => self.go(hit)}>
										<span class="name">${hit.name}</span>
										<span class="kind">${KINDS[hit.kind] ?? ''}${hit.container ? ` in ${hit.container}` : ''}</span>
										<span class="where">${hit.path}:${hit.line}</span>
									</button>
								`
							)}
						</div>
					`
					: ''}
			</div>
		`;
	},
	styles: () => css`
		.veil {
			position: fixed;
			inset: 0;
			z-index: 900;
		}
		.box {
			position: fixed;
			z-index: 901;
			top: 64px;
			left: 50%;
			width: min(640px, calc(100vw - 48px));
			transform: translateX(-50%);
			display: flex;
			flex-direction: column;
			border: 1px solid var(--ml-color-border);
			border-radius: 10px;
			background: var(--ml-color-surface-raised, var(--ml-color-surface));
			box-shadow: var(--ml-shadow-xl);
			overflow: hidden;
		}
		input {
			height: 42px;
			padding: 0 14px;
			border: 0;
			outline: none;
			background: none;
			font: inherit;
			font-size: 14px;
			color: var(--ml-color-text);
		}
		input::placeholder {
			color: var(--ml-color-text-muted);
		}
		.note {
			padding: 10px 14px 12px;
			border-top: 1px solid var(--ml-color-border);
			font-size: 12.5px;
			line-height: 1.5;
			color: var(--ml-color-text-muted);
		}
		.hits {
			max-height: min(420px, 60vh);
			overflow-y: auto;
			border-top: 1px solid var(--ml-color-border);
			padding: 4px;
		}
		.hit {
			display: flex;
			align-items: baseline;
			gap: 10px;
			width: 100%;
			padding: 6px 10px;
			border: 0;
			border-radius: 6px;
			background: none;
			font: inherit;
			font-size: 13px;
			text-align: left;
			color: var(--ml-color-text);
			cursor: pointer;
		}
		.hit.on {
			background: var(--ms-hover);
		}
		.name {
			flex: none;
			max-width: 50%;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-family: var(--ml-font-mono);
		}
		.kind {
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.name b,
		.dir b {
			font-weight: 700;
			color: var(--ml-color-primary);
		}
		.dir {
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			direction: rtl;
			text-align: left;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.tag {
			flex: none;
			font-size: 11px;
			color: var(--ml-color-text-muted);
		}
		.where {
			flex: none;
			max-width: 45%;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			direction: rtl;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
	`,
})
export class GoToComponent {
	@Service(LspService) private readonly _lsp!: LspService;
	@Service(ExplorerStore) private readonly _explorer!: ExplorerStore;
	@Service(RepoStore) private readonly _repos!: RepoStore;
	@Service(WorkspaceStore) private readonly _workspace!: WorkspaceStore;
	@Service(FileIndexStore) readonly files!: FileIndexStore;
	elementRef!: HTMLElement;

	query = '';
	symbols: SymbolHit[] = [];
	active = 0;
	/** What to say under the box while looking for a symbol: a hint, "nothing found", or why it cannot search. */
	note = '';

	private _asked = 0;
	private _timer = 0;
	private _shown: { start: string } | null = null;

	get mode(): 'files' | 'symbols' {
		return this.query.startsWith('@') ? 'symbols' : 'files';
	}

	private readonly onKey = (e: KeyboardEvent): void => {
		const key = e.key.toLowerCase();
		if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (key === 'p' || key === 't')) {
			// A terminal has its own use for the keys (and off the Mac, so does the shell in it).
			const inTerminal = e.composedPath().some((node) => node instanceof HTMLElement && (node.tagName === 'MS-TERMINAL' || node.tagName === 'MS-WORKSPACE'));
			if (!this._repos.repo() || !this._repos.status() || (inTerminal && !isMac())) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			const wanted = key === 't' ? 'symbols' : 'files';
			if (goTo() && this.mode === wanted) {
				this.close(); // the same key again puts it away
			} else {
				openGoTo(wanted);
			}
		}
	};

	onCreate(): void {
		window.addEventListener('keydown', this.onKey, true);
	}

	onDestroy(): void {
		window.removeEventListener('keydown', this.onKey, true);
		window.clearTimeout(this._timer);
	}

	/** Each request to open starts the box over (the other key while it is open swaps what it looks for). */
	onRender(): void {
		const open = goTo();
		if (open && open !== this._shown) {
			this.symbols = [];
			this.active = 0;
			this.note = '';
			this.typed(open.start);
			// Files come and go: what is listed is read again each time the box opens, behind the list already known.
			void this.files.load();
			queueMicrotask(() => this.elementRef.shadowRoot?.querySelector('input')?.focus());
		}
		this._shown = open;
	}

	close(): void {
		goTo.set(null);
	}

	typed(value: string): void {
		this.query = value;
		this.active = 0;
		window.clearTimeout(this._timer);
		if (this.mode === 'symbols') {
			if (!value.slice(1).trim()) {
				this.symbols = [];
				this._asked++;
				this.note = 'Searches what the language server knows: open a file in the Files tab first, and it covers that language.';
			} else {
				this._timer = window.setTimeout(() => void this.search(), 150);
			}
		}
	}

	// ---- files ----

	/** The best files for what is typed, without the ones deleted since the last commit (git still lists those). */
	fileHits(): Ranked[] {
		const listed = this.files.list();
		if (!listed) {
			return [];
		}
		const deleted = new Set((this._repos.status()?.files ?? []).filter((f) => f.status === 'deleted').map((f) => f.path));
		const ranked = rankFiles(listed.index, parseGoTo(this.query).query, this.files.recent(), SHOWN + deleted.size);
		return (deleted.size ? ranked.filter((r) => !deleted.has(r.path)) : ranked).slice(0, SHOWN);
	}

	fileNote(found: number): string {
		const listed = this.files.list();
		const typed = parseGoTo(this.query).query;
		if (!listed) {
			return 'Reading the list of files…';
		}
		if (!found) {
			return typed ? `No file named like "${typed}". Files that .gitignore leaves out are not listed.` : 'This checkout has no files yet.';
		}
		return listed.truncated ? `Only the first ${listed.index.paths.length.toLocaleString('en-US')} files of this checkout are listed.` : '';
	}

	openFile(path: string): void {
		const { line, column } = parseGoTo(this.query);
		this.close();
		this._repos.setTab('files');
		this._workspace.revealMain();
		if (line) {
			void this._explorer.openAt(path, line, column ?? 1);
		} else {
			// Line the store up with the checkout first: the Files tab may not have been on screen yet.
			this._explorer.sync();
			this._explorer.open(path, true);
		}
	}

	// ---- symbols ----

	private async search(): Promise<void> {
		const query = parseGoTo(this.query).query;
		const asked = ++this._asked;
		if (!query || this.mode !== 'symbols') {
			return;
		}
		const found = await this._lsp.findSymbols(query);
		if (asked !== this._asked) {
			return; // a later keystroke's answer is the one wanted
		}
		this.active = 0;
		if (found === null) {
			this.symbols = [];
			this.note = 'No language server is running for this checkout yet. Open a file in the Files tab, and its language can be searched.';
			return;
		}
		// The servers' own order is by how well a name matches; names that start with what was typed come first within it.
		const starts = (hit: SymbolHit): number => (hit.name.toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1);
		this.symbols = [...found].sort((a, b) => starts(a) - starts(b));
		this.note = found.length ? (found.length > SHOWN ? `The first ${SHOWN} of ${found.length}. Type more to narrow it down.` : '') : `Nothing named like "${query}".`;
	}

	readonly keydown = (e: KeyboardEvent): void => {
		const files = this.mode === 'files' ? this.fileHits() : [];
		const shown = this.mode === 'files' ? files.length : Math.min(this.symbols.length, SHOWN);
		if (e.key === 'Escape') {
			e.preventDefault();
			this.close();
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			if (shown) {
				this.active = (this.active + (e.key === 'ArrowDown' ? 1 : shown - 1)) % shown;
				queueMicrotask(() => this.elementRef.shadowRoot?.querySelector('.hit.on')?.scrollIntoView({ block: 'nearest' }));
			}
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (this.mode === 'files') {
				const hit = files[Math.min(this.active, files.length - 1)];
				if (hit) {
					this.openFile(hit.path);
				}
			} else {
				const hit = this.symbols[this.active];
				if (hit) {
					this.go(hit);
				}
			}
		}
	};

	go(hit: SymbolHit): void {
		this.close();
		this._repos.setTab('files');
		this._workspace.revealMain();
		void this._explorer.openAt(hit.path, hit.line, hit.column);
	}
}
