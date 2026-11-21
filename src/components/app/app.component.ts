import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { ToastService } from '@melodicdev/components/toast';
import { RepoStore } from '../../services/repo.store';
import { AgentsStore } from '../../services/agents.store';
import { HostStore } from '../../services/host.store';
import { WorkspaceStore } from '../../services/workspace.store';
import { MenuService } from '../../services/menu.service';
import { OpenedService } from '../../services/opened.service';
import { SearchStore } from '../../services/search.store';
import { appTemplate } from './app.template';
import { appStyles } from './app.styles';

const WIDTH_KEY = 'studio.sidebar';
const MIN_W = 220;
const MAX_W = 520;
const DEFAULT_W = 300;

function savedWidth(): number {
	try {
		const w = Number(localStorage.getItem(WIDTH_KEY));
		return w >= MIN_W && w <= MAX_W ? w : DEFAULT_W;
	} catch {
		return DEFAULT_W;
	}
}

@MelodicComponent({
	selector: 'ms-app',
	template: appTemplate,
	styles: appStyles,
})
export class AppComponent {
	@Service(RepoStore) readonly store!: RepoStore;
	@Service(HostStore) readonly host!: HostStore;
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(WorkspaceStore) readonly workspace!: WorkspaceStore;
	@Service(ToastService) private readonly _toast!: ToastService;
	@Service(MenuService) private readonly _menu!: MenuService;
	@Service(OpenedService) private readonly _opened!: OpenedService;
	@Service(SearchStore) private readonly _search!: SearchStore;

	elementRef!: HTMLElement;

	sidebarWidth = savedWidth();
	resizing = false;
	private _resize: { startX: number; startW: number } | null = null;

	/** The row the main pane and the Claude pane share. Its width decides whether both fit (WorkspaceStore.setRoom). */
	private _upper: HTMLElement | null = null;
	/** Created with the component: the first render (and so the first onRender) can come before onCreate. */
	private readonly _room = new ResizeObserver((entries) => {
		const width = entries[entries.length - 1]?.contentRect.width ?? 0;
		if (width > 0) {
			this.workspace.setRoom(Math.round(width), window.innerWidth);
		}
	});

	onCreate(): void {
		this._toast.setPosition('bottom-right');
		// A repository picked from the Dock can only be found once the list of repositories is there.
		void this.store.init().then(() => this._opened.start());
		this._menu.start();
		window.addEventListener('keydown', this.onKey, true);
	}

	/**
	 * Cmd/Ctrl+Shift+F: find in files, from anywhere. Cmd/Ctrl+Shift+A: the Agents page and back.
	 * Caught first, so the editor or a terminal does not get them.
	 */
	private readonly onKey = (e: KeyboardEvent): void => {
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'KeyA' && this.store.ready() && (this.store.overview() || this.store.repo())) {
			e.preventDefault();
			e.stopPropagation();
			this.store.showOverview();
			return;
		}
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'KeyF' && this.store.repo() && this.store.status()) {
			e.preventDefault();
			e.stopPropagation();
			this.store.setTab('files');
			this._search.ask();
		}
	};

	/** The row is only there while a repository is open, and is rebuilt when one is: follow it. */
	onRender(): void {
		const upper = this.elementRef.shadowRoot?.querySelector<HTMLElement>('.upper') ?? null;
		if (upper !== this._upper) {
			if (this._upper) {
				this._room.unobserve(this._upper);
			}
			this._upper = upper;
			if (upper) {
				this._room.observe(upper);
			}
		}
	}

	onDestroy(): void {
		this.stopResize();
		this._room.disconnect();
		window.removeEventListener('keydown', this.onKey, true);
	}

	// ---- resizable sidebar ----

	readonly startResize = (e: PointerEvent): void => {
		e.preventDefault();
		this._resize = { startX: e.clientX, startW: this.sidebarWidth };
		this.resizing = true;
		window.addEventListener('pointermove', this.moveResize);
		window.addEventListener('pointerup', this.stopResize);
	};

	private readonly moveResize = (e: PointerEvent): void => {
		if (this._resize) {
			this.sidebarWidth = Math.min(MAX_W, Math.max(MIN_W, this._resize.startW + e.clientX - this._resize.startX));
		}
	};

	private readonly stopResize = (): void => {
		window.removeEventListener('pointermove', this.moveResize);
		window.removeEventListener('pointerup', this.stopResize);
		if (this._resize) {
			this._resize = null;
			this.resizing = false;
			try {
				localStorage.setItem(WIDTH_KEY, String(this.sidebarWidth));
			} catch {
				/* ignore */
			}
		}
	};

	resetWidth(): void {
		this.sidebarWidth = DEFAULT_W;
		try {
			localStorage.removeItem(WIDTH_KEY);
		} catch {
			/* ignore */
		}
	}

	/** A sidebar tab, with the main pane on screen to show it (the workspace may be filling the window). */
	showTab(tab: 'files' | 'changes' | 'history' | 'agents'): void {
		if (this.workspace.view() === 'full' && this.store.tab() === tab) {
			this.workspace.setView('side');
		}
		this.store.setTab(tab);
	}

	// ---- workspace width (its left edge) ----

	wsResizing = false;
	private _ws: { startX: number; startW: number } | null = null;

	readonly startWsResize = (e: PointerEvent): void => {
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		this._ws = { startX: e.clientX, startW: this.workspace.width() };
		this.wsResizing = true;
	};

	readonly moveWsResize = (e: PointerEvent): void => {
		if (this._ws) {
			this.workspace.setWidth(this._ws.startW - (e.clientX - this._ws.startX));
		}
	};

	readonly endWsResize = (): void => {
		if (this._ws) {
			this._ws = null;
			this.wsResizing = false;
			this.workspace.saveWidth();
		}
	};

	async copyHash(hash: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(hash);
			this._toast.success('Commit hash copied');
		} catch {
			this._toast.error('Could not copy the hash');
		}
	}
}
