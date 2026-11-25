import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { RepoStore } from '../../services/repo.store';
import { AgentsStore, stateOf } from '../../services/agents.store';
import { bucketOf } from '../../shared/attention';
import { isDesktop, isMac, type RepoSummary } from '../../services/backend.service';
import { groupByOrigin, hostIcon, type HostGroup } from '../../shared/repo-groups';

/** The plus: every repository already set up, to open in a tab of its own, and below them the way to add another. */
function picker(self: RepoTabsComponent) {
	const inTab = new Set(self.store.repoTabs());
	const groups = self.groups;
	return html`
		<ml-popover id="add-pop" placement="bottom-start" offset="0" @ml:open=${self.opened}>
			<button slot="trigger" class="add" title="Open a repository in a new tab"><ml-icon icon="plus" size="sm"></ml-icon></button>
			<div class="panel">
				<div class="filter">
					<ml-input size="sm" placeholder="Open a repository" .value=${self.filter} @ml:input=${(e: CustomEvent) => (self.filter = e.detail.value)} @keydown=${self.enter}>
						<ml-icon slot="prefix" icon="magnifying-glass" size="sm"></ml-icon>
					</ml-input>
				</div>
				<div class="list">
					${groups.length === 0 ? html`<div class="none">No repositories${self.filter.trim() ? ' match' : ' yet'}.</div>` : ''}
					${groups.map(
						(g) => html`
							<div class="grp">
								<ml-icon icon=${hostIcon(g.provider)} size="sm"></ml-icon>
								<span class="grp-name">${g.label}</span>
							</div>
							${g.owners.map(
								(o) => html`
									${o.owner ? html`<div class="grp owner"><span class="grp-name">${o.owner}</span></div>` : ''}
									${o.items.map(
										(r) => html`
											<div class="item ${o.owner ? 'deep' : ''}" title=${inTab.has(r.id) ? 'Already open: go to its tab' : 'Open in a new tab'} @click=${() => self.pick(r)}>
												<ml-icon icon=${r.missing ? 'warning' : 'folder-simple'} size="sm"></ml-icon>
												<span class="name">${r.name}<span class="path">${r.missing ? 'Folder not found' : r.path}</span></span>
												${inTab.has(r.id) ? html`<span class="when">Open</span>` : ''}
											</div>
										`
									)}
								`
							)}
						`
					)}
				</div>
				<div class="foot">
					<ml-button variant="outline" size="sm" full-width @ml:click=${self.add}><ml-icon slot="icon-start" icon="plus"></ml-icon>Add repository…</ml-button>
				</div>
			</div>
		</ml-popover>
	`;
}

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
		const overview = store.overview();
		const current = overview ? null : store.repo()?.id;
		// What waits on the user in every repository: the Agents tab's badge.
		const needs = self.agents.sessions().filter((s) => bucketOf(stateOf(s), s.unread) === 'needs').length;
		const working = new Set(
			self.agents
				.sessions()
				.filter((s) => s.status === 'running')
				.map((s) => s.repoId)
		);
		return html`
			<div class="strip drag ${self.mac ? 'mac' : ''}" @mousedown=${self.drag}>
				<div class="tab pinned ${overview ? 'on' : ''}" title=${`Every repository's agents on one page (${isMac() ? '⌘' : 'Ctrl+'}Shift+A)`} @click=${() => store.showOverview(true)}>
					<ml-icon icon="sparkle" size="sm"></ml-icon>
					<span class="name">Agents</span>
					${needs ? html`<span class="n" aria-label=${`${needs} waiting for you`}>${needs}</span>` : ''}
				</div>
				${store.repoTabList().map(
					(r) => html`
						<div
							class="tab ${r.id === current ? 'on' : ''}"
							title=${r.path}
							@pointerdown=${(e: PointerEvent) => self.down(e, r.id)}
							@pointermove=${self.move}
							@pointerup=${self.up}
							@pointercancel=${self.cancel}
							@click=${() => (self.dragged ? undefined : store.selectRepo(r.id))} @auxclick=${(e: MouseEvent) => (e.button === 1 ? store.closeRepoTab(r.id) : undefined)}>
							${working.has(r.id) ? html`<ml-spinner size="xs"></ml-spinner>` : html`<ml-icon icon=${r.missing ? 'warning' : 'folder-simple'} size="sm"></ml-icon>`}
							<span class="name">${r.name}</span>
							<button title="Close tab" @click=${(e: Event) => (e.stopPropagation(), store.closeRepoTab(r.id))}><ml-icon icon="x" size="xs"></ml-icon></button>
						</div>
					`
				)}
				${picker(self)}
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
			align-items: flex-end;
			gap: 2px;
			height: 38px;
			padding: 0 8px;
			background: var(--ms-strip-bg);
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
			height: 31px;
			padding: 0 8px 0 12px;
			border-radius: 9px 9px 0 0;
			font-size: 12px;
			transition: transform 120ms ease;
		}
		/* Dragged to reorder: it follows the pointer, the others slide aside (RepoTabsComponent.move). */
		.tab.dragging {
			position: relative;
			z-index: 1;
			transition: none;
			background: var(--ms-toolbar-hover);
			color: var(--ms-toolbar-fg);
			cursor: grabbing;
		}
		.tab:hover {
			background: var(--ms-toolbar-hover);
			color: var(--ms-toolbar-fg);
		}
		/* The open tab is cut from the toolbar below it. */
		.tab.on {
			background: var(--ms-toolbar-bg);
			color: var(--ms-toolbar-fg);
			font-weight: 600;
		}
		.tab.on::before {
			content: '';
			flex: none;
			width: 6px;
			height: 6px;
			border-radius: 50%;
			background: var(--ms-you);
		}
		.tab > ml-icon,
		.tab > ml-spinner {
			flex: none;
		}
		/* The Agents page: always first, not dragged or closed, a little apart from the repositories. */
		.tab.pinned {
			flex: 0 0 auto;
			min-width: 0;
			padding-right: 10px;
			margin-right: 6px;
		}
		.tab.pinned > ml-icon {
			color: var(--ms-ai);
		}
		.tab.pinned .name {
			flex: none;
		}
		.tab .n {
			flex: none;
			min-width: 16px;
			padding: 0 5px;
			box-sizing: border-box;
			border-radius: 999px;
			background: var(--ms-you);
			color: #fff;
			font-size: 10.5px;
			font-weight: 600;
			line-height: 16px;
			text-align: center;
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
		#add-pop {
			flex: none;
			align-self: center;
			margin: 0 6px;
		}
		.add {
			border-radius: 7px;
			width: 26px;
			height: 26px;
		}

		/* ---- the plus's list: the toolbar's repository list, without folding ---- */
		.panel {
			width: 340px;
			max-height: min(70vh, 560px);
			display: flex;
			flex-direction: column;
			font-size: 13px;
			color: var(--ml-color-text);
		}
		.filter {
			padding: 10px;
			border-bottom: 1px solid var(--ml-color-border);
		}
		.list {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			padding: 6px 0;
		}
		.grp {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 8px 14px 4px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
			user-select: none;
		}
		.grp.owner {
			padding: 4px 14px 2px 28px;
			text-transform: none;
			letter-spacing: 0;
			font-size: 12px;
		}
		.grp-name {
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.none {
			padding: 18px 14px;
			text-align: center;
			color: var(--ml-color-text-muted);
		}
		.item {
			display: flex;
			align-items: center;
			gap: 9px;
			min-height: 32px;
			padding: 4px 10px 4px 14px;
		}
		.item.deep {
			padding-left: 28px;
		}
		.item:hover {
			background: var(--ms-hover);
		}
		.item > ml-icon {
			flex: none;
			color: var(--ml-color-text-muted);
		}
		.path {
			display: block;
			font-size: 11px;
			color: var(--ml-color-text-muted);
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.when {
			flex: none;
			font-size: 11px;
			color: var(--ml-color-text-muted);
		}
		.foot {
			padding: 10px;
			border-top: 1px solid var(--ml-color-border);
		}
	`,
})
export class RepoTabsComponent {
	@Service(RepoStore) readonly store!: RepoStore;
	@Service(AgentsStore) readonly agents!: AgentsStore;

	elementRef!: HTMLElement;

	/** Leave room for the traffic lights the overlay title bar draws over the top row. */
	readonly mac = isDesktop() && isMac();

	/** What is typed in the plus's list. */
	filter = '';

	/** The repositories the plus offers: all of them, the ones already in a tab too (picking one goes to its tab). */
	get groups(): HostGroup<RepoSummary>[] {
		const q = this.filter.trim().toLowerCase();
		const repos = this.store.app()?.repos ?? [];
		return groupByOrigin(q ? repos.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : repos);
	}

	private closePicker(): void {
		(this.elementRef.shadowRoot?.querySelector('#add-pop') as (HTMLElement & { component?: { close(): void } }) | null)?.component?.close();
		this.filter = '';
	}

	/** Put the cursor in the filter box as the list opens. */
	readonly opened = (): void => {
		const input = this.elementRef.shadowRoot?.querySelector('#add-pop ml-input');
		requestAnimationFrame(() => (input?.shadowRoot?.querySelector('input') as HTMLInputElement | null)?.focus());
	};

	pick(repo: RepoSummary): void {
		this.closePicker();
		void this.store.selectRepo(repo.id, true);
	}

	/** Enter opens the first repository listed. */
	readonly enter = (e: KeyboardEvent): void => {
		const first = this.groups[0]?.owners[0]?.items[0];
		if (e.key === 'Enter' && first) {
			e.preventDefault();
			this.pick(first);
		}
	};

	/** A repository that is not set up yet: the Add a repository dialog, whose result gets a tab of its own. */
	readonly add = (): void => {
		this.closePicker();
		this.store.ask('add-repo', { newTab: true });
	};

	/** A tab being dragged to a new place. Pointer events, not HTML drag and drop (the window handles file drops). */
	private _drag: { id: string; el: HTMLElement; tabs: HTMLElement[]; rects: DOMRect[]; from: number; to: number; startX: number; moved: boolean } | null = null;
	/** Set for the click that ends a drag, so dropping a tab does not also select it. */
	dragged = false;

	down(e: PointerEvent, id: string): void {
		if (e.button !== 0 || (e.target as Element).closest('button')) {
			return;
		}
		const el = e.currentTarget as HTMLElement;
		const tabs = [...(el.parentElement?.querySelectorAll<HTMLElement>('.tab:not(.pinned)') ?? [])];
		const from = tabs.indexOf(el);
		if (from < 0 || tabs.length < 2) {
			return;
		}
		this._drag = { id, el, tabs, rects: tabs.map((t) => t.getBoundingClientRect()), from, to: from, startX: e.clientX, moved: false };
		el.setPointerCapture(e.pointerId);
	}

	readonly move = (e: PointerEvent): void => {
		const d = this._drag;
		if (!d) {
			return;
		}
		let dx = e.clientX - d.startX;
		if (!d.moved && Math.abs(dx) < 5) {
			return;
		}
		d.moved = true;
		d.el.classList.add('dragging');
		const own = d.rects[d.from];
		dx = Math.max(d.rects[0].left - own.left, Math.min(d.rects[d.rects.length - 1].right - own.right, dx));
		d.el.style.transform = `translateX(${dx}px)`;
		const centre = own.left + own.width / 2 + dx;
		// A tab to the right counts as passed once the centres meet: the drag is held inside the strip, so the
		// dragged tab's centre can reach the last tab's but never go beyond it, and the last place must be reachable.
		d.to = d.rects.filter((r, i) => i !== d.from && (i > d.from ? r.left + r.width / 2 <= centre : r.left + r.width / 2 < centre)).length;
		// The tabs between the old and the new place make room by one slot.
		const slot = d.from + 1 < d.rects.length ? d.rects[d.from + 1].left - own.left : own.left - d.rects[d.from - 1].left;
		d.tabs.forEach((t, i) => {
			if (i !== d.from) {
				const shift = d.from < d.to && i > d.from && i <= d.to ? -slot : d.to < d.from && i >= d.to && i < d.from ? slot : 0;
				t.style.transform = shift ? `translateX(${shift}px)` : '';
			}
		});
	};

	readonly up = (): void => {
		const d = this.finish();
		if (d?.moved) {
			this.dragged = true;
			setTimeout(() => (this.dragged = false));
			this.store.moveRepoTab(d.id, d.to);
		}
	};

	readonly cancel = (): void => {
		this.finish();
	};

	private finish(): typeof this._drag {
		const d = this._drag;
		this._drag = null;
		if (d) {
			d.el.classList.remove('dragging');
			// No slide back: the strip re-renders in the new order.
			for (const t of d.tabs) {
				t.style.transition = 'none';
				t.style.transform = '';
				requestAnimationFrame(() => (t.style.transition = ''));
			}
		}
		return d;
	}

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
