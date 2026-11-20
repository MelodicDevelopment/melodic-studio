import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, type TemplateResult } from '@melodicdev/core/template';
import { WorkspaceStore, panesOf, type LayoutNode } from '../../services/workspace.store';
import { workspaceStyles } from './workspace.styles';
import './pane.component';

/** The least share of a split one side can be dragged down to. */
const MIN_SHARE = 0.08;

function tree(self: WorkspaceComponent, node: LayoutNode): TemplateResult {
	if (node.type === 'pane') {
		return html`<ms-ws-pane .paneId=${node.id}></ms-ws-pane>`;
	}
	return html`
		<div class="split ${node.dir}" data-split=${node.id}>
			${node.children.map(
				(child, i): TemplateResult => html`
					${i ? html`<div class="divider" @pointerdown=${(e: PointerEvent) => self.startResize(e, node.id, i, node.sizes)} @pointermove=${self.moveResize} @pointerup=${self.endResize} @pointercancel=${self.endResize}></div>` : ''}
					<div class="cell" style="flex: ${node.sizes[i] ?? 1} 1 0">${tree(self, child)}</div>
				`,
			)}
		</div>
	`;
}

/**
 * The Claude workspace: Claude Code conversations and terminals in split panes
 * (one layout per repository). It has no bar of its own: every pane's tab row
 * carries the buttons (ms-ws-pane), and the top right one the workspace's.
 */
@MelodicComponent({
	selector: 'ms-workspace',
	template: (self: WorkspaceComponent) => {
		const store = self.store;
		const layout = store.layout() ?? store.ensureLayout();
		return html`<div class="root ${self.resizing ? 'resizing' : ''}">${layout ? tree(self, layout) : ''}</div>`;
	},
	styles: workspaceStyles,
})
export class WorkspaceComponent {
	@Service(WorkspaceStore) readonly store!: WorkspaceStore;

	resizing = false;
	private _resize: { split: string; at: number; start: number[]; origin: number; length: number; row: boolean } | null = null;

	onCreate(): void {
		window.addEventListener('keydown', this.onKey, true);
	}

	onDestroy(): void {
		window.removeEventListener('keydown', this.onKey, true);
	}

	/** Cmd/Ctrl+\ splits the focused pane. Caught first, or a focused terminal would take it. */
	private readonly onKey = (e: KeyboardEvent): void => {
		if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key !== '\\') {
			return;
		}
		const layout = this.store.layout();
		const pane = layout && (panesOf(layout).find((p) => p.id === this.store.focusedPane()) ?? panesOf(layout)[0]);
		if (pane) {
			e.preventDefault();
			e.stopPropagation();
			this.store.split(pane.id, 'row');
		}
	};

	// ---- dragging a divider ----

	readonly startResize = (e: PointerEvent, split: string, at: number, sizes: number[]): void => {
		const el = (e.currentTarget as HTMLElement).parentElement;
		if (!el) {
			return;
		}
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		(e.currentTarget as HTMLElement).classList.add('moving');
		const row = el.classList.contains('row');
		const rect = el.getBoundingClientRect();
		const total = sizes.reduce((a, b) => a + b, 0) || 1;
		this._resize = { split, at, start: sizes.map((s) => s / total), origin: row ? e.clientX : e.clientY, length: row ? rect.width : rect.height, row };
		this.resizing = true;
	};

	readonly moveResize = (e: PointerEvent): void => {
		const r = this._resize;
		if (!r || !r.length) {
			return;
		}
		const delta = ((r.row ? e.clientX : e.clientY) - r.origin) / r.length;
		const sizes = [...r.start];
		const pair = sizes[r.at - 1] + sizes[r.at];
		const before = Math.min(pair - MIN_SHARE, Math.max(MIN_SHARE, sizes[r.at - 1] + delta));
		sizes[r.at - 1] = before;
		sizes[r.at] = pair - before;
		this.store.resize(r.split, sizes);
	};

	readonly endResize = (e: PointerEvent): void => {
		(e.currentTarget as HTMLElement).classList.remove('moving');
		if (this._resize) {
			this._resize = null;
			this.resizing = false;
			this.store.saveLayouts();
		}
	};
}
