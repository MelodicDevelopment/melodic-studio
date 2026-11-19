import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { TerminalStore } from '../../services/terminal.store';
import { RunStore, frameInCheckout, type Run, type RunError } from '../../services/run.store';
import { AgentsStore } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import { ExplorerStore } from '../../services/explorer.store';
import { samePath } from '../../services/agent-paths';
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
	@Service(RunStore) readonly runs!: RunStore;
	@Service(AgentsStore) private readonly _agents!: AgentsStore;
	@Service(RepoStore) private readonly _repos!: RepoStore;
	@Service(ExplorerStore) private readonly _explorer!: ExplorerStore;

	/** Which of the run's open errors the bar shows: 0 is the newest. */
	errorAt = 0;

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

	/** The open repository (and so its terminals) can change without this component being rebuilt. */
	private _shown: string | null | undefined = undefined;
	onRender(): void {
		const active = this.terminals.active();
		if (active !== this._shown) {
			this._shown = active;
			this.terminals.layout();
		}
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

	// ---- the "Error spotted" bar ----

	inCheckout(run: Run, file: string): boolean {
		return frameInCheckout(file, run.checkout, run.target.cwd) !== null;
	}

	/** Open a stack frame in the Files tab, when the run's checkout is still the one on screen. */
	openFrame(run: Run, file: string, line: number, column: number | null): void {
		const path = frameInCheckout(file, run.checkout, run.target.cwd);
		const repo = this._repos.repo();
		if (!path || !repo || !samePath(run.checkout, repo.worktree || repo.path)) {
			return;
		}
		this._repos.setTab('files');
		void this._explorer.openAt(path, line, column ?? 1);
	}

	dismiss(run: Run, error: RunError): void {
		this.runs.dismiss(run.id, error.id);
		this.errorAt = 0;
	}

	/** Hand the error to Claude: it reproduces it in a worktree of its own. */
	investigate(run: Run, error: RunError): void {
		void this._agents.investigate({ description: '', error, target: run.target, command: run.command, exitCode: run.exitCode });
	}

	/** The text selected in the terminal on screen (or nothing) goes into the box for describing a bug. */
	investigateSelection(): void {
		this._agents.openInvestigate(this.terminals.selection());
	}

	closeOnMiddleClick(e: MouseEvent, id: string): void {
		if (e.button === 1) {
			e.preventDefault();
			this.terminals.close(id);
		}
	}
}
