import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { effect, untracked } from '@melodicdev/core/signals';
import { html, css } from '@melodicdev/core/template';
import { RepoStore } from '../../services/repo.store';
import { ExplorerStore } from '../../services/explorer.store';
import { SearchStore } from '../../services/search.store';
import { WorkspaceStore } from '../../services/workspace.store';
import { isMac } from '../../services/backend.service';
import { SEARCH_LIMIT, byFile, marks, matcher, pieces, summary, type SearchMatch, type SearchOptions } from '../../shared/search';

/**
 * Find in files: the box at the top of the Files tab's sidebar and, while it has text, the
 * results in the tree's place (ms-explorer hides the tree). Everything shown comes from the
 * repository's files: text bindings only.
 */
@MelodicComponent({
	selector: 'ms-find-in-files',
	template: (self: FindInFilesComponent) => {
		const search = self.search;
		const query = search.query();
		const options = search.options();
		const result = search.result();
		const error = search.error();
		const folded = search.folded();
		const opened = search.opened();
		search.focusAsked(); // read so a request for the keyboard renders (see onRender)
		const option = (key: keyof SearchOptions, label: string, title: string) => html`
			<button class="opt ${options[key] ? 'on' : ''} ${key}" title=${title} aria-label=${title} aria-pressed=${options[key] ? 'true' : 'false'} @click=${() => search.setOption(key, !options[key])}>${label}</button>
		`;
		const re = result ? matcher(query, options) : null;
		const hit = (m: SearchMatch) => html`
			<button class="hit ${opened === `${m.path}:${m.line}` ? 'sel' : ''}" title=${`${m.path}:${m.line}`} @click=${() => self.open(m)}>
				<span class="ln">${m.line}</span>
				<span class="text">${pieces(m.text, marks(m.text, re)).map((p) => (p.hit ? html`<b>${p.text}</b>` : p.text))}</span>
			</button>
		`;
		return html`
			<div class="box ${error ? 'bad' : ''}">
				<ml-icon icon="magnifying-glass" size="sm"></ml-icon>
				<input
					type="text"
					placeholder=${`Find in files (${isMac() ? '⇧⌘F' : 'Ctrl+Shift+F'})`}
					aria-label="Find in files"
					spellcheck="false"
					autocomplete="off"
					.value=${query}
					@input=${(e: Event) => search.type((e.target as HTMLInputElement).value)}
					@keydown=${(e: KeyboardEvent) => self.boxKey(e)}
				/>
				${search.busy() ? html`<ml-spinner size="sm"></ml-spinner>` : query ? html`<button class="opt" title="Clear (Esc)" aria-label="Clear the search" @click=${() => self.clear()}><ml-icon icon="x" size="xs"></ml-icon></button>` : ''}
				${option('matchCase', 'Aa', 'Match case')}
				${option('wholeWord', 'ab', 'Whole word')}
				${option('regex', '.*', 'Regular expression')}
			</div>
			${!query
				? ''
				: html`
					<div class="status ${error ? 'bad' : ''}" role="status">${error ? error : result ? summary(result, SEARCH_LIMIT) : 'Searching…'}</div>
					<div class="results" @keydown=${(e: KeyboardEvent) => self.listKey(e)}>
						${byFile(result?.matches ?? []).map(
							(f) => html`
								<button class="file" title=${f.path} aria-expanded=${folded.has(f.path) ? 'false' : 'true'} @click=${() => search.fold(f.path)}>
									<ml-icon icon=${folded.has(f.path) ? 'caret-right' : 'caret-down'} size="xs"></ml-icon>
									<span class="name">${f.name}</span>
									<span class="dir">${f.dir.replace(/\/$/, '')}</span>
									<span class="count">${f.matches.length}</span>
								</button>
								${folded.has(f.path) ? '' : f.matches.map(hit)}
							`,
						)}
					</div>
				`}
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
			min-height: 0;
		}
		button {
			all: unset;
			box-sizing: border-box;
		}
		.box {
			flex: none;
			display: flex;
			align-items: center;
			gap: 2px;
			height: 28px;
			margin: 6px 8px;
			padding: 0 3px 0 8px;
			border: 1px solid var(--ml-color-border);
			border-radius: 7px;
			background: var(--ml-color-surface);
			color: var(--ml-color-text-muted);
		}
		.box:focus-within {
			border-color: var(--ml-color-primary);
		}
		.box.bad {
			border-color: var(--ms-del);
		}
		input {
			flex: 1;
			min-width: 0;
			height: 100%;
			margin-left: 4px;
			border: 0;
			outline: none;
			background: transparent;
			color: var(--ml-color-text);
			font: inherit;
		}
		input::placeholder {
			color: var(--ml-color-text-muted);
		}
		ml-spinner {
			flex: none;
			margin: 0 4px;
		}
		.opt {
			flex: none;
			display: grid;
			place-items: center;
			min-width: 22px;
			height: 22px;
			border-radius: 5px;
			font-family: var(--ml-font-mono);
			font-size: 11px;
			color: var(--ml-color-text-muted);
		}
		.opt.wholeWord {
			text-decoration: underline;
			text-underline-offset: 2px;
		}
		.opt:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
		.opt.on {
			background: color-mix(in srgb, var(--ml-color-primary) 22%, transparent);
			color: var(--ml-color-text);
		}
		button:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: -2px;
		}
		.status {
			flex: none;
			padding: 0 12px 6px;
			font-size: 11.5px;
			color: var(--ml-color-text-muted);
			overflow-wrap: anywhere;
		}
		.status.bad {
			color: var(--ms-del);
		}
		.results {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			padding-bottom: 6px;
		}
		.file,
		.hit {
			display: flex;
			align-items: center;
			width: calc(100% - 12px);
			margin: 0 6px;
			border-radius: 6px;
			white-space: nowrap;
		}
		.file {
			gap: 5px;
			min-height: 24px;
			padding: 0 8px 0 4px;
		}
		.file:hover,
		.hit:hover {
			background: var(--ms-hover);
		}
		.file ml-icon {
			flex: none;
			color: var(--ml-color-text-muted);
		}
		.name {
			flex: none;
			max-width: 100%;
			overflow: hidden;
			text-overflow: ellipsis;
			font-weight: 500;
		}
		.dir {
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			color: var(--ml-color-text-muted);
			font-size: 11.5px;
		}
		.count {
			flex: none;
			min-width: 16px;
			padding: 0 5px;
			border-radius: 999px;
			background: var(--ml-color-surface-sunken);
			color: var(--ml-color-text-muted);
			font-size: 10.5px;
			line-height: 16px;
			text-align: center;
		}
		.hit {
			gap: 8px;
			min-height: 22px;
			padding: 0 8px 0 22px;
			font-family: var(--ml-font-mono);
			font-size: 11.5px;
			color: var(--ml-color-text-secondary);
		}
		.hit.sel {
			background: var(--ms-selected);
			color: var(--ms-selected-fg);
			box-shadow: inset 0 0 0 1px var(--ms-selected-ring);
		}
		.ln {
			flex: none;
			min-width: 3ch;
			text-align: right;
			color: var(--ml-color-text-muted);
			font-variant-numeric: tabular-nums;
		}
		.hit.sel .ln {
			color: inherit;
			opacity: 0.7;
		}
		.text {
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: pre;
		}
		.text b {
			font-weight: inherit;
			border-radius: 2px;
			background: color-mix(in srgb, var(--ml-color-primary) 34%, transparent);
			color: var(--ml-color-text);
		}
	`,
})
export class FindInFilesComponent {
	@Service(SearchStore) readonly search!: SearchStore;
	@Service(RepoStore) private readonly _repos!: RepoStore;
	@Service(ExplorerStore) private readonly _explorer!: ExplorerStore;
	@Service(WorkspaceStore) private readonly _workspace!: WorkspaceStore;
	elementRef!: HTMLElement;

	onCreate(): void {
		// Another repository or worktree on screen: the results were the old one's.
		effect(() => {
			const repo = this._repos.repo();
			void repo?.id;
			void repo?.worktree;
			untracked(() => this.search.checkoutChanged());
		});
	}

	/** Cmd/Ctrl+Shift+F asked for the keyboard, perhaps before this component existed. */
	onRender(): void {
		const asked = this.search.focusAsked();
		if (asked !== this.search.focused) {
			this.search.focused = asked;
			queueMicrotask(() => {
				const input = this.input();
				input?.focus();
				input?.select();
			});
		}
	}

	private input(): HTMLInputElement | null {
		return this.elementRef.shadowRoot?.querySelector('input') ?? null;
	}

	clear(): void {
		this.search.clear();
		this.input()?.focus();
	}

	boxKey(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			e.preventDefault();
			void this.search.run();
		} else if (e.key === 'Escape' && this.search.query()) {
			e.preventDefault();
			this.search.clear();
		} else if (e.key === 'ArrowDown') {
			const first = this.elementRef.shadowRoot?.querySelector<HTMLElement>('.results button');
			if (first) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	/** Up and down walk the rows; up from the first goes back to the box. */
	listKey(e: KeyboardEvent): void {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
			return;
		}
		const rows = [...(this.elementRef.shadowRoot?.querySelectorAll<HTMLElement>('.results button') ?? [])];
		const at = rows.indexOf(this.elementRef.shadowRoot?.activeElement as HTMLElement);
		if (at < 0) {
			return;
		}
		e.preventDefault();
		const next = at + (e.key === 'ArrowDown' ? 1 : -1);
		if (next < 0) {
			this.input()?.focus();
		} else {
			rows[Math.min(next, rows.length - 1)].focus();
		}
	}

	open(m: SearchMatch): void {
		this.search.opened.set(`${m.path}:${m.line}`);
		this._workspace.revealMain();
		void this._explorer.openAt(m.path, m.line, m.column);
	}
}
