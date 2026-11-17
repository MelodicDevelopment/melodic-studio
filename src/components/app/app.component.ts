import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { ToastService } from '@melodicdev/components/toast';
import { RepoStore } from '../../services/repo.store';
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
	@Service(ToastService) private readonly _toast!: ToastService;

	sidebarWidth = savedWidth();
	resizing = false;
	private _resize: { startX: number; startW: number } | null = null;

	onCreate(): void {
		this._toast.setPosition('bottom-right');
		void this.store.init();
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

	async copyHash(hash: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(hash);
			this._toast.success('Commit hash copied');
		} catch {
			this._toast.error('Could not copy the hash');
		}
	}
}
