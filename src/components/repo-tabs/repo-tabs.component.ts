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
			border-radius: 7px;
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

	/** A tab being dragged to a new place. Pointer events, not HTML drag and drop (the window handles file drops). */
	private _drag: { id: string; el: HTMLElement; tabs: HTMLElement[]; rects: DOMRect[]; from: number; to: number; startX: number; moved: boolean } | null = null;
	/** Set for the click that ends a drag, so dropping a tab does not also select it. */
	dragged = false;

	down(e: PointerEvent, id: string): void {
		if (e.button !== 0 || (e.target as Element).closest('button')) {
			return;
		}
		const el = e.currentTarget as HTMLElement;
		const tabs = [...(el.parentElement?.querySelectorAll<HTMLElement>('.tab') ?? [])];
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
		d.to = d.rects.filter((r, i) => i !== d.from && r.left + r.width / 2 < centre).length;
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
