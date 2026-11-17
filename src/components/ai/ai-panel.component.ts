import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { ToastService } from '@melodicdev/components/toast';
import { AiFeaturesStore } from '../../services/ai-features.store';
import { aiPanelTemplate } from './ai-panel.template';
import { aiPanelStyles } from './ai-panel.styles';

const WIDTH_KEY = 'studio.ai-panel';
const MIN_W = 280;
const MAX_W = 640;
const DEFAULT_W = 380;

function savedWidth(): number {
	try {
		const w = Number(localStorage.getItem(WIDTH_KEY));
		return w >= MIN_W && w <= MAX_W ? w : DEFAULT_W;
	} catch {
		return DEFAULT_W;
	}
}

/**
 * The panel beside the diff: an explanation of a change and/or the findings of a
 * pre-push review, as two tabs when both exist. It never covers the code.
 */
@MelodicComponent({
	selector: 'ms-ai-panel',
	template: aiPanelTemplate,
	styles: aiPanelStyles,
})
export class AiPanelComponent {
	@Service(AiFeaturesStore) readonly ai!: AiFeaturesStore;
	@Service(ToastService) private readonly _toast!: ToastService;
	elementRef!: HTMLElement;

	width = savedWidth();
	private _resize: { startX: number; startW: number } | null = null;

	onCreate(): void {
		this.elementRef.style.width = `${this.width}px`;
	}

	onDestroy(): void {
		this.stopResize();
	}

	/** Drag the left edge to resize. */
	readonly startResize = (e: PointerEvent): void => {
		e.preventDefault();
		this._resize = { startX: e.clientX, startW: this.width };
		window.addEventListener('pointermove', this.moveResize);
		window.addEventListener('pointerup', this.stopResize);
	};

	private readonly moveResize = (e: PointerEvent): void => {
		if (this._resize) {
			this.width = Math.min(MAX_W, Math.max(MIN_W, this._resize.startW + this._resize.startX - e.clientX));
			this.elementRef.style.width = `${this.width}px`;
		}
	};

	private readonly stopResize = (): void => {
		window.removeEventListener('pointermove', this.moveResize);
		window.removeEventListener('pointerup', this.stopResize);
		if (this._resize) {
			this._resize = null;
			try {
				localStorage.setItem(WIDTH_KEY, String(this.width));
			} catch {
				/* ignore */
			}
		}
	};

	async copy(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			this._toast.success('Copied');
		} catch {
			this._toast.error('Could not copy');
		}
	}
}
