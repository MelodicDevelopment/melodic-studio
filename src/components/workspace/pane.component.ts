import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, repeat } from '@melodicdev/core/template';
import { WorkspaceStore, panesOf, type Conversation, type Drop, type Pane } from '../../services/workspace.store';
import { isMac } from '../../services/backend.service';
import { paneStyles } from './workspace.styles';
import { stateDot } from './conversation-state';

/** How long a pane's size has to hold still before its program is told about it. */
const SETTLE_MS = 60;
/** A press on a tab becomes a drag after the pointer moves this far. */
const DRAG_PX = 5;
/** The part of a pane's width or height, at each edge, that splits rather than adds to it. */
const EDGE = 0.25;

/** Every pane on screen, for finding the one under a dragged tab. */
const panesOnScreen = new Map<string, HTMLElement>();

/** Which pane, and which part of it, is under the pointer. */
function dropAt(x: number, y: number): { pane: string; drop: Drop } | null {
	for (const [pane, el] of panesOnScreen) {
		const r = el.getBoundingClientRect();
		if (x < r.left || x > r.right || y < r.top || y > r.bottom) {
			continue;
		}
		const fx = (x - r.left) / r.width;
		const fy = (y - r.top) / r.height;
		// The tab strip itself (about 32px) always means "into this pane".
		if (y - r.top < 32) {
			return { pane, drop: 'center' };
		}
		const edges: [Drop, number][] = [
			['left', fx],
			['right', 1 - fx],
			['top', fy],
			['bottom', 1 - fy],
		];
		const [drop, distance] = edges.sort((a, b) => a[1] - b[1])[0];
		return { pane, drop: distance < EDGE ? drop : 'center' };
	}
	return null;
}

function tab(self: PaneComponent, pane: Pane, c: Conversation) {
	const on = c.id === pane.active;
	return html`
		<div
			class="ptab ${on ? 'on' : ''} ${c.unread ? 'unread' : ''} ${c.state}"
			title=${`${c.title}\n${c.cwd}${c.branch ? ` · ${c.branch}` : ''}`}
			@pointerdown=${(e: PointerEvent) => self.press(e, c.id)}
			@auxclick=${(e: MouseEvent) => (e.button === 1 ? self.store.close(c.id) : undefined)}
		>
			${c.kind === 'shell' ? html`<ml-icon icon="terminal-window" size="xs"></ml-icon>` : stateDot(c)}
			<span class="name">${c.title}</span>
			<button title=${c.kind === 'shell' ? 'Close terminal' : 'Close (the conversation is kept and can be resumed)'} @pointerdown=${(e: Event) => e.stopPropagation()} @click=${(e: Event) => (e.stopPropagation(), self.store.close(c.id))}>
				<ml-icon icon="x" size="xs"></ml-icon>
			</button>
		</div>
	`;
}

function body(self: PaneComponent, pane: Pane, conv: Conversation | null) {
	if (!conv) {
		return html`
			<div class="start">
				<button class="big" @click=${() => self.store.newClaude({ pane: pane.id })}>
					<ml-icon icon="sparkle" size="md"></ml-icon><span><b>New Claude conversation</b><small>Claude Code in ${self.store.checkoutName()}</small></span>
				</button>
				<button class="big" @click=${() => self.store.newShell(pane.id)}>
					<ml-icon icon="terminal-window" size="md"></ml-icon><span><b>New terminal</b><small>Your shell, in the same folder</small></span>
				</button>
				<p class="hint">Drag a tab here from another pane, or onto a pane's edge to split it.</p>
			</div>
		`;
	}
	if (conv.state === 'saved') {
		return html`
			<div class="start">
				<div class="resume">
					<ml-icon icon="clock-counter-clockwise" size="lg"></ml-icon>
					<h3>${conv.title}</h3>
					${conv.lastSaid ? html`<p class="said">${conv.lastSaid}</p>` : ''}
					<ml-button variant="primary" @ml:click=${() => self.store.resume(conv.id)}><ml-icon slot="icon-start" icon="play"></ml-icon>Resume conversation</ml-button>
					<p class="hint">Continues it with <code>claude --resume</code> in ${conv.cwd}</p>
				</div>
			</div>
		`;
	}
	return '';
}

/**
 * One pane of the workspace: a tab strip and the element its active screen is
 * shown in. The screens belong to ScreenPool and only visit; the pane can be
 * rebuilt or handed another pane id at any time.
 */
@MelodicComponent({
	selector: 'ms-ws-pane',
	template: (self: PaneComponent) => {
		const store = self.store;
		const layout = store.layout();
		const pane = layout ? panesOf(layout).find((p) => p.id === self.paneId) : undefined;
		if (!pane) {
			return html`<div class="pane"><div class="screens"></div></div>`;
		}
		const convs = pane.tabs.map((t) => store.get(t)).filter((c): c is Conversation => !!c);
		const active = pane.active ? store.get(pane.active) : null;
		const drag = store.dragging();
		const target = drag && drag.pane === pane.id ? drag.drop : null;
		const several = panesOf(layout!).length > 1;
		const mod = isMac() ? '⌘' : 'Ctrl+';
		return html`
			<div class="pane ${store.focusedPane() === pane.id && several ? 'focused' : ''}" @pointerdown=${() => store.focusedPane.set(pane.id)}>
				<div class="head">
					<div class="tabs">
						${repeat(
							convs,
							(c) => c.id,
							(c) => tab(self, pane, c),
						)}
						<button class="tool" title="New Claude conversation" @click=${() => store.newClaude({ pane: pane.id })}><ml-icon icon="plus" size="sm"></ml-icon></button>
					</div>
					<button class="tool" title="New terminal here" @click=${() => store.newShell(pane.id)}><ml-icon icon="terminal-window" size="sm"></ml-icon></button>
					<button class="tool" title=${`Split right (${mod}\\)`} @click=${() => store.split(pane.id, 'row')}><ml-icon icon="square-split-horizontal" size="sm"></ml-icon></button>
					<button class="tool" title="Split down" @click=${() => store.split(pane.id, 'column')}><ml-icon icon="square-split-vertical" size="sm"></ml-icon></button>
					${several ? html`<button class="tool" title="Close this pane (its tabs move next door)" @click=${() => store.closePane(pane.id)}><ml-icon icon="x" size="sm"></ml-icon></button>` : ''}
				</div>
				${active?.state === 'waiting' ? html`<div class="asking"><ml-icon icon="hand" size="sm"></ml-icon><span>${active.waitingFor}</span></div>` : ''}
				<div class="screens"></div>
				${body(self, pane, active)}
				${target ? html`<div class="drop ${target}"></div>` : ''}
			</div>
		`;
	},
	styles: paneStyles,
})
export class PaneComponent {
	@Service(WorkspaceStore) readonly store!: WorkspaceStore;

	paneId = '';
	elementRef!: HTMLElement;

	private _attached = '';
	private _screens: HTMLElement | null = null;
	private _settle = 0;
	/** Created with the component: the first render (and so the first onRender) can come before onCreate. */
	private readonly _observer = new ResizeObserver(() => {
		window.clearTimeout(this._settle);
		this._settle = window.setTimeout(() => this.store.showPane(this.paneId), SETTLE_MS);
	});
	private _press: { id: string; x: number; y: number; dragging: boolean } | null = null;

	/** The pane id or the screens element can change with any render: follow both. */
	onRender(): void {
		const screens = this.elementRef.shadowRoot?.querySelector<HTMLElement>('.screens') ?? null;
		if (screens === this._screens && this.paneId === this._attached) {
			return;
		}
		if (this._screens) {
			this._observer.unobserve(this._screens);
			this.store.detachPane(this._attached, this._screens);
		}
		panesOnScreen.delete(this._attached);
		this._screens = screens;
		this._attached = this.paneId;
		if (screens && this.paneId) {
			panesOnScreen.set(this.paneId, this.elementRef);
			this._observer.observe(screens);
			this.store.attachPane(this.paneId, screens);
		}
	}

	onDestroy(): void {
		window.clearTimeout(this._settle);
		this._observer.disconnect();
		if (this._screens) {
			this.store.detachPane(this._attached, this._screens);
		}
		if (panesOnScreen.get(this._attached) === this.elementRef) {
			panesOnScreen.delete(this._attached);
		}
		this.endDrag();
	}

	// ---- tabs: click to select, drag to move or split ----

	press(e: PointerEvent, id: string): void {
		if (e.button !== 0) {
			return;
		}
		this._press = { id, x: e.clientX, y: e.clientY, dragging: false };
		window.addEventListener('pointermove', this.move);
		window.addEventListener('pointerup', this.release);
		window.addEventListener('pointercancel', this.cancel);
	}

	private readonly move = (e: PointerEvent): void => {
		const p = this._press;
		if (!p) {
			return;
		}
		if (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_PX) {
			return;
		}
		p.dragging = true;
		const at = dropAt(e.clientX, e.clientY);
		this.store.dragging.set({ tab: p.id, pane: at?.pane ?? null, drop: at?.drop ?? null });
	};

	private readonly release = (e: PointerEvent): void => {
		const p = this._press;
		this.endDrag();
		if (!p) {
			return;
		}
		if (!p.dragging) {
			this.store.select(p.id);
			return;
		}
		const at = dropAt(e.clientX, e.clientY);
		if (at) {
			this.store.place(p.id, at.pane, at.drop);
		}
	};

	private readonly cancel = (): void => this.endDrag();

	private endDrag(): void {
		this._press = null;
		window.removeEventListener('pointermove', this.move);
		window.removeEventListener('pointerup', this.release);
		window.removeEventListener('pointercancel', this.cancel);
		if (this.store.dragging()) {
			this.store.dragging.set(null);
		}
	}
}
