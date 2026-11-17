import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { RepoStore } from '../../services/repo.store';
import { AgentsStore } from '../../services/agents.store';
import { isDesktop, isMac } from '../../services/backend.service';

/**
 * Repositories open side by side as tabs across the top of the window, like
 * macOS window tabs but the same on every OS. Hidden until a second repository
 * is opened in a tab; each tab remembers what it was showing (RepoStore keeps that).
 */
@MelodicComponent({
	selector: 'ms-repo-tabs',
	template: (self: RepoTabsComponent) => {
		const store = self.store;
		if (!store.showRepoTabs()) {
			// Not a bare html``: Melodic cannot switch a component away from a completely empty first template.
			return html`<span hidden></span>`;
		}
		const current = store.repo()?.id;
		const working = new Set(
			self.agents
				.sessions()
				.filter((s) => s.status === 'running')
				.map((s) => s.repoId)
		);
		return html`
			<div class="strip drag ${self.mac ? 'mac' : ''}" @mousedown=${self.drag}>
				${store.repoTabList().map(
					(r) => html`
						<div class="tab ${r.id === current ? 'on' : ''}" title=${r.path} @click=${() => store.selectRepo(r.id)} @auxclick=${(e: MouseEvent) => (e.button === 1 ? store.closeRepoTab(r.id) : undefined)}>
							${working.has(r.id) ? html`<ml-spinner size="xs"></ml-spinner>` : html`<ml-icon icon=${r.missing ? 'warning' : 'folder-simple'} size="sm"></ml-icon>`}
							<span class="name">${r.name}</span>
							<button title="Close tab" @click=${(e: Event) => (e.stopPropagation(), store.closeRepoTab(r.id))}><ml-icon icon="x" size="xs"></ml-icon></button>
						</div>
					`
				)}
				<button class="add" title="Open another repository in a new tab" @click=${() => store.ask('add-repo', { newTab: true })}><ml-icon icon="plus" size="sm"></ml-icon></button>
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: block;
			flex: none;
		}
		.strip {
			display: flex;
			align-items: stretch;
			height: 36px;
			background: var(--ms-toolbar-bg);
			border-bottom: 1px solid var(--ms-toolbar-border);
			color: var(--ms-toolbar-muted);
		}
		.strip.mac {
			padding-left: 84px;
		}
		.tab {
			flex: 0 1 220px;
			min-width: 90px;
			display: flex;
			align-items: center;
			gap: 7px;
			padding: 0 8px 0 12px;
			border-right: 1px solid var(--ms-toolbar-border);
			font-size: 12px;
			box-shadow: inset 0 2px 0 transparent;
		}
		.strip.mac .tab:first-child {
			border-left: 1px solid var(--ms-toolbar-border);
		}
		.tab:hover {
			background: var(--ms-toolbar-hover);
			color: var(--ms-toolbar-fg);
		}
		.tab.on {
			background: var(--ms-toolbar-hover);
			color: var(--ms-toolbar-fg);
			font-weight: 600;
			box-shadow: inset 0 2px 0 var(--ml-color-primary);
		}
		.tab > ml-icon,
		.tab > ml-spinner {
			flex: none;
		}
		.name {
			flex: 1;
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		button {
			all: unset;
			flex: none;
			display: grid;
			place-items: center;
			width: 20px;
			height: 20px;
			border-radius: 4px;
		}
		.tab button {
			visibility: hidden;
		}
		.tab:hover button,
		.tab.on button {
			visibility: visible;
		}
		button:hover {
			background: var(--ms-toolbar-border);
			color: var(--ms-toolbar-fg);
		}
		button:focus-visible {
			outline: 2px solid var(--ml-color-primary);
		}
		.add {
			align-self: center;
			width: 26px;
			height: 26px;
			margin: 0 6px;
		}
	`,
})
export class RepoTabsComponent {
	@Service(RepoStore) readonly store!: RepoStore;
	@Service(AgentsStore) readonly agents!: AgentsStore;

	/** Leave room for the traffic lights the overlay title bar draws over the top row. */
	readonly mac = isDesktop() && isMac();

	/** Ctrl+Tab and Ctrl+Shift+Tab move between tabs, on every OS. */
	private readonly _keys = (e: KeyboardEvent): void => {
		if (e.key === 'Tab' && e.ctrlKey && !e.altKey && !e.metaKey && this.store.showRepoTabs()) {
			e.preventDefault();
			this.store.cycleRepoTab(e.shiftKey ? -1 : 1);
		}
	};

	onCreate(): void {
		window.addEventListener('keydown', this._keys, true);
	}

	onDestroy(): void {
		window.removeEventListener('keydown', this._keys, true);
	}

	/** The empty part of the strip moves the window; a double click zooms it. */
	readonly drag = (e: MouseEvent): void => {
		if (e.button !== 0 || !isDesktop() || !(e.target as HTMLElement).classList?.contains('drag')) {
			return;
		}
		void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => (e.detail === 2 ? getCurrentWindow().toggleMaximize() : getCurrentWindow().startDragging()));
	};
}
