import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { AgentsStore } from '../../services/agents.store';
import { isDesktop } from '../../services/backend.service';
import { imagesIn } from '../../services/agent-images';
import { IMAGE_TYPES } from '../../shared/images';
import { hits } from '../../shared/hit';

/**
 * The images waiting to go with a message to Claude, wherever one is written: a session's
 * composer, the new-task dialog, a new question, a bug to investigate, an issue's task.
 * It shows them as thumbnails and takes new ones for its `box` (a session's id, or one of
 * `DRAFT_IMAGES` while there is no session yet; `AgentsStore.attached` holds them): pasted
 * while the keyboard is in its `zone`, or dropped on it. The zone is the element this sits
 * in unless one is given. With `pick` it also shows the Image button under the thumbnails;
 * where that button belongs in a row of others, `ms-attach-button` is that button alone.
 *
 * `<ms-attach .box=${DRAFT_IMAGES.task} .pick=${true}></ms-attach>`
 */
@MelodicComponent({
	selector: 'ms-attach',
	template: (self: AttachComponent) => {
		const agents = self.agents;
		const waiting = agents.attached()[self.box] ?? [];
		const adding = agents.attaching()[self.box] ?? 0;
		if (!waiting.length && !adding && !self.dropping && !self.pick) {
			// Not an empty template: Melodic would never show the images afterwards.
			return html`<span hidden></span>`;
		}
		return html`
			${waiting.length || adding || self.dropping
				? html`
					<div class="shots">
						${waiting.map(
							(a) => html`
								<span class="shot">
									<img src=${a.url} alt="Image to send" />
									<button title="Remove this image" aria-label="Remove this image" @click=${() => agents.detach(self.box, a.name)}><ml-icon icon="x" size="xs"></ml-icon></button>
								</span>
							`
						)}
						${adding ? html`<span class="shot wait"><ml-spinner size="sm"></ml-spinner></span>` : ''}
						${self.dropping ? html`<span class="shot wait drop"><ml-icon icon="image" size="sm"></ml-icon>Drop the image here</span>` : ''}
					</div>
				`
				: ''}
			${self.pick ? html`<div class="row"><ms-attach-button .box=${self.box}></ms-attach-button><span class="hint">or paste a screenshot, or drop an image here</span></div>` : ''}
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
			gap: 8px;
			min-width: 0;
		}
		:host([hidden]) {
			display: none;
		}
		.shots {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
		}
		.shot {
			position: relative;
			display: inline-flex;
		}
		.shot img {
			display: block;
			height: 64px;
			max-width: 160px;
			object-fit: cover;
			border-radius: 6px;
			border: 1px solid var(--ml-color-border);
			background: var(--ml-color-surface);
		}
		.shot button {
			all: unset;
			position: absolute;
			top: -6px;
			right: -6px;
			display: grid;
			place-items: center;
			width: 18px;
			height: 18px;
			border-radius: 50%;
			border: 1px solid var(--ml-color-border-strong);
			background: var(--ml-color-surface-raised);
			cursor: pointer;
		}
		.shot button:hover {
			background: var(--ms-hover);
		}
		.shot button:focus-visible {
			outline: 2px solid var(--ml-color-primary);
		}
		.shot.wait {
			align-items: center;
			justify-content: center;
			gap: 6px;
			box-sizing: border-box;
			min-width: 64px;
			height: 64px;
			padding: 0 10px;
			border-radius: 6px;
			border: 1px dashed var(--ml-color-border-strong);
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.shot.drop {
			border-color: var(--ml-color-primary);
			color: var(--ml-color-text);
		}
		.row {
			display: flex;
			align-items: center;
			gap: 6px;
			min-width: 0;
		}
		.hint {
			font-size: 12px;
			color: var(--ml-color-text-muted);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
	`,
})
export class AttachComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	elementRef!: HTMLElement;

	/** Whose images these are: a session's id, or one of `DRAFT_IMAGES`. */
	box = '';
	/** Where a paste or a drop counts. The element this sits in when not given. */
	zone: HTMLElement | null = null;
	/** Show the Image button too. */
	pick = false;
	/** Files are being dragged over the zone. */
	dropping = false;
	private _unlistenDrop: (() => void) | null = null;

	private area(): HTMLElement | null {
		return this.zone ?? this.elementRef.parentElement;
	}

	/** The event happened in the zone, wherever in it (the text box is inside another component). */
	private mine(e: Event): boolean {
		const area = this.area();
		return !!this.box && !!area && e.composedPath().includes(area);
	}

	onCreate(): void {
		document.addEventListener('paste', this.paste);
		document.addEventListener('dragover', this.htmlOver);
		document.addEventListener('dragleave', this.htmlLeave);
		document.addEventListener('drop', this.htmlDrop);
		void this.listenForDrops();
	}

	onDestroy(): void {
		document.removeEventListener('paste', this.paste);
		document.removeEventListener('dragover', this.htmlOver);
		document.removeEventListener('dragleave', this.htmlLeave);
		document.removeEventListener('drop', this.htmlDrop);
		this._unlistenDrop?.();
		this._unlistenDrop = null;
	}

	/** With nothing to show it takes no room, not even a gap of the column it is in. */
	onRender(): void {
		const agents = this.agents;
		this.elementRef.toggleAttribute('hidden', !this.pick && !this.dropping && !agents.attached()[this.box]?.length && !agents.attaching()[this.box]);
	}

	/** A screenshot on the clipboard goes with the message; text is pasted as ever. */
	private readonly paste = (e: ClipboardEvent): void => {
		const images = imagesIn(e.clipboardData);
		if (images.length && this.mine(e)) {
			e.preventDefault();
			void this.agents.attach(this.box, images);
		}
	};

	/** In the app, files dropped from outside arrive from the window with their paths (the explorer does the same). */
	private async listenForDrops(): Promise<void> {
		if (!isDesktop()) {
			return; // the browser preview uses HTML drop events instead
		}
		const { getCurrentWebview } = await import('@tauri-apps/api/webview');
		const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
			const p = event.payload;
			if (p.type === 'leave') {
				this.dropping = false;
				return;
			}
			// Positions arrive in physical pixels. A dialog over the zone takes the drop, not the zone under it.
			const over = !!this.box && hits(this.area(), p.position.x / window.devicePixelRatio, p.position.y / window.devicePixelRatio);
			if (p.type === 'drop') {
				this.dropping = false;
				if (over && p.paths.length) {
					void this.agents.attachFiles(this.box, p.paths);
				}
			} else if (over !== this.dropping) {
				this.dropping = over;
			}
		});
		if (this._unlistenDrop === null && this.elementRef.isConnected) {
			this._unlistenDrop = unlisten;
		} else {
			unlisten();
		}
	}

	private readonly htmlOver = (e: DragEvent): void => {
		if (isDesktop() || !e.dataTransfer?.types.includes('Files')) {
			return;
		}
		const over = this.mine(e);
		if (over) {
			e.preventDefault();
		}
		if (over !== this.dropping) {
			this.dropping = over;
		}
	};

	/** Left the window altogether. */
	private readonly htmlLeave = (e: DragEvent): void => {
		if (!isDesktop() && !e.relatedTarget) {
			this.dropping = false;
		}
	};

	private readonly htmlDrop = (e: DragEvent): void => {
		if (isDesktop() || !this.mine(e)) {
			return;
		}
		e.preventDefault();
		this.dropping = false;
		const images = imagesIn(e.dataTransfer);
		if (images.length) {
			void this.agents.attach(this.box, images);
		}
	};
}

/** The Image button of a composer: picks image files for `box`. */
@MelodicComponent({
	selector: 'ms-attach-button',
	template: (self: AttachButtonComponent) => html`
		<input type="file" accept=${Object.keys(IMAGE_TYPES).join(',')} multiple hidden @change=${self.picked} />
		<ml-button variant="ghost" size="sm" title="Attach an image. You can also paste one, or drop it here." @ml:click=${() => self.choose()}><ml-icon slot="icon-start" icon="paperclip" size="sm"></ml-icon>Image</ml-button>
	`,
	styles: () => css`
		:host {
			display: inline-flex;
			flex: none;
		}
	`,
})
export class AttachButtonComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	elementRef!: HTMLElement;

	box = '';

	choose(): void {
		this.elementRef.shadowRoot?.querySelector<HTMLInputElement>('input')?.click();
	}

	readonly picked = (e: Event): void => {
		const input = e.target as HTMLInputElement;
		if (this.box && input.files?.length) {
			void this.agents.attach(this.box, [...input.files]);
		}
		input.value = ''; // the same file can be picked again
	};
}
