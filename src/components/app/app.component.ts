import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { ToastService } from '@melodicdev/components/toast';
import { RepoStore } from '../../services/repo.store';
import { AgentsStore } from '../../services/agents.store';
import { HostStore } from '../../services/host.store';
import { WorkspaceStore } from '../../services/workspace.store';
import { MenuService } from '../../services/menu.service';
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

	sidebarWidth = savedWidth();
	resizing = false;
	private _resize: { startX: number; startW: number } | null = null;

	onCreate(): void {
		this._toast.setPosition('bottom-right');
		void this.store.init();
		this._menu.start();
	}

	onDestroy(): void {
		this.stopResize();
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
