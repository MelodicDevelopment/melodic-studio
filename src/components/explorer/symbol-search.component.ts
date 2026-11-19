import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { signal } from '@melodicdev/core/signals';
import { html, css } from '@melodicdev/core/template';
import { RepoStore } from '../../services/repo.store';
import { ExplorerStore } from '../../services/explorer.store';
import { LspService, type SymbolHit } from '../../services/lsp.service';
import { isMac } from '../../services/backend.service';
import { nothing } from '../ai/ai-entry';

/** Whether the search is showing. The Files tab's header button sets it; so does Cmd/Ctrl+T. */
export const symbolSearchOpen = signal(false);

/** Monaco's SymbolKind, as a word for the row. */
const KINDS = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter'];
const SHOWN = 50;

/**
 * Go to a symbol by name, anywhere in the checkout on screen: a box at the top of the window, the
 * language servers' answers under it. Names and paths come from the server and the repository: text only.
 */
@MelodicComponent({
	selector: 'ms-symbol-search',
	template: (self: SymbolSearchComponent) => {
		if (!symbolSearchOpen()) {
			return nothing();
		}
		const hits = self.hits;
		return html`
			<div class="veil" @mousedown=${() => self.close()}></div>
			<div class="box" @keydown=${self.keydown}>
				<input type="text" placeholder="Go to a function, class or type by name" spellcheck="false" .value=${self.query} @input=${(e: Event) => self.typed((e.target as HTMLInputElement).value)} />
				${self.note ? html`<div class="note">${self.note}</div>` : ''}
				${hits.length
					? html`
						<div class="hits">
							${hits.slice(0, SHOWN).map(
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
export class SymbolSearchComponent {
	@Service(LspService) private readonly _lsp!: LspService;
	@Service(ExplorerStore) private readonly _explorer!: ExplorerStore;
	@Service(RepoStore) private readonly _repos!: RepoStore;
	elementRef!: HTMLElement;

	query = '';
	hits: SymbolHit[] = [];
	active = 0;
	/** What to say under the box: a hint, "nothing found", or why it cannot search. */
	note = '';

	private _asked = 0;
	private _timer = 0;
	private _wasOpen = false;

	private readonly onKey = (e: KeyboardEvent): void => {
		if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
			// A terminal has its own use for the key (and off the Mac, so does the shell in it).
			const inTerminal = e.composedPath().some((node) => node instanceof HTMLElement && (node.tagName === 'MS-TERMINAL' || node.tagName === 'MS-WORKSPACE'));
			if (!this._repos.repo() || (inTerminal && !isMac())) {
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			symbolSearchOpen.set(!symbolSearchOpen());
		}
	};

	onCreate(): void {
		window.addEventListener('keydown', this.onKey, true);
	}

	onDestroy(): void {
		window.removeEventListener('keydown', this.onKey, true);
		window.clearTimeout(this._timer);
	}

	onRender(): void {
		const open = symbolSearchOpen();
		if (open && !this._wasOpen) {
			this.query = '';
			this.hits = [];
			this.active = 0;
			this.note = 'Searches what the language server knows: open a file in the Files tab first, and it covers that language.';
			queueMicrotask(() => this.elementRef.shadowRoot?.querySelector('input')?.focus());
		}
		this._wasOpen = open;
	}

	close(): void {
		symbolSearchOpen.set(false);
	}

	typed(value: string): void {
		this.query = value;
		window.clearTimeout(this._timer);
		this._timer = window.setTimeout(() => void this.search(), 150);
	}

	private async search(): Promise<void> {
		const query = this.query.trim();
		const asked = ++this._asked;
		if (!query) {
			this.hits = [];
			this.note = '';
			return;
		}
		const found = await this._lsp.findSymbols(query);
		if (asked !== this._asked) {
			return; // a later keystroke's answer is the one wanted
		}
		this.active = 0;
		if (found === null) {
			this.hits = [];
			this.note = 'No language server is running for this checkout yet. Open a file in the Files tab, and its language can be searched.';
			return;
		}
		// The servers' own order is by how well a name matches; names that start with what was typed come first within it.
		const starts = (hit: SymbolHit): number => (hit.name.toLowerCase().startsWith(query.toLowerCase()) ? 0 : 1);
		this.hits = [...found].sort((a, b) => starts(a) - starts(b));
		this.note = found.length ? (found.length > SHOWN ? `The first ${SHOWN} of ${found.length}. Type more to narrow it down.` : '') : `Nothing named like "${query}".`;
	}

	readonly keydown = (e: KeyboardEvent): void => {
		const shown = Math.min(this.hits.length, SHOWN);
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
			const hit = this.hits[this.active];
			if (hit) {
				this.go(hit);
			}
		}
	};

	go(hit: SymbolHit): void {
		this.close();
		this._repos.setTab('files');
		void this._explorer.openAt(hit.path, hit.line, hit.column);
	}
}
