import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { TerminalStore } from '../../services/terminal.store';
import { terminalTemplate } from './terminal.template';
import { terminalStyles } from './terminal.styles';

/** How long the panel's size has to hold still before the shell is told about it. */
const SETTLE_MS = 60;

/**
 * The terminal panel under the main pane: tabs, a top edge to drag, and the
 * element the screens are shown in. The terminals themselves belong to
 * TerminalStore, so they outlive this component.
 */
@MelodicComponent({
	selector: 'ms-terminal',
	template: terminalTemplate,
	styles: terminalStyles,
})
export class TerminalComponent {
	@Service(TerminalStore) readonly terminals!: TerminalStore;

	elementRef!: HTMLElement;
	dragging = false;

	private _drag: { startY: number; startH: number } | null = null;
	private _screens: HTMLElement | null = null;
	private _observer: ResizeObserver | null = null;
	private _settle = 0;

	onCreate(): void {
		// Capture phase: a focused terminal would otherwise send the key to the shell.
		window.addEventListener('keydown', this.onKey, true);
		const screens = this.elementRef.shadowRoot?.querySelector<HTMLElement>('.screens');
		if (!screens) {
			return;
		}
		this._screens = screens;
		this.terminals.attach(screens);
		// Covers the window, the sidebar and this panel being resized, and the panel being shown.
		this._observer = new ResizeObserver(() => {
			window.clearTimeout(this._settle);
			this._settle = window.setTimeout(() => this.terminals.layout(), SETTLE_MS);
		});
		this._observer.observe(screens);
	}

	onDestroy(): void {
		window.removeEventListener('keydown', this.onKey, true);
		window.clearTimeout(this._settle);
		this._observer?.disconnect();
		if (this._screens) {
			this.terminals.detach(this._screens);
		}
	}

	/** Ctrl+` shows or hides the panel, Ctrl+Shift+` opens another terminal. Ctrl on every OS, as in VS Code. */
	private readonly onKey = (e: KeyboardEvent): void => {
		if (e.code !== 'Backquote' || !e.ctrlKey || e.metaKey || e.altKey) {
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		if (e.shiftKey) {
			void this.terminals.add();
		} else {
			this.terminals.toggle();
		}
	};

	// ---- drag the top edge ----

	readonly startDrag = (e: PointerEvent): void => {
		e.preventDefault();
		// Captured, so the drag keeps going over the editor and the terminal itself.
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		this._drag = { startY: e.clientY, startH: this.terminals.height() };
		this.dragging = true;
	};

	readonly moveDrag = (e: PointerEvent): void => {
		if (this._drag) {
			this.terminals.setHeight(this._drag.startH + this._drag.startY - e.clientY);
		}
	};

	readonly endDrag = (): void => {
		if (this._drag) {
			this._drag = null;
			this.dragging = false;
			this.terminals.saveHeight();
		}
	};

	closeOnMiddleClick(e: MouseEvent, id: string): void {
		if (e.button === 1) {
			e.preventDefault();
			this.terminals.close(id);
		}
	}
}
