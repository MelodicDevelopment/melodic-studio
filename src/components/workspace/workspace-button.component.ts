import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { WorkspaceStore } from '../../services/workspace.store';
import { isMac } from '../../services/backend.service';

/**
 * The toolbar's Claude button: shows or hides the workspace (Cmd/Ctrl+Shift+K),
 * with a badge for conversations waiting on the user and a dot while any is working.
 */
@MelodicComponent({
	selector: 'ms-workspace-button',
	template: (self: WorkspaceButtonComponent) => {
		const store = self.store;
		const waiting = store.waiting().length;
		const shown = store.view() !== 'hidden';
		const key = `${isMac() ? '⌘' : 'Ctrl+'}Shift+K`;
		const title = waiting ? `${waiting} conversation${waiting === 1 ? '' : 's'} waiting for you (${key})` : `${shown ? 'Hide' : 'Show'} the Claude workspace (${key})`;
		return html`
			<button class="tool ${shown ? 'on' : ''}" title=${title} @click=${() => (waiting && !shown ? store.open(store.waiting()[0].id) : store.toggle())}>
				<ml-icon icon="sparkle" size="md"></ml-icon>
				${waiting ? html`<span class="count">${waiting}</span>` : store.working() ? html`<span class="busy"></span>` : store.unread() ? html`<span class="unread"></span>` : ''}
			</button>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
		}
		.tool {
			all: unset;
			position: relative;
			display: grid;
			place-items: center;
			width: 48px;
			color: var(--ms-toolbar-muted);
		}
		.tool:hover {
			background: var(--ms-toolbar-hover);
			color: var(--ms-toolbar-fg);
		}
		.tool.on {
			color: var(--ms-toolbar-fg);
		}
		.tool:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: -2px;
		}
		.count {
			position: absolute;
			top: 7px;
			right: 4px;
			min-width: 16px;
			padding: 0 4px;
			box-sizing: border-box;
			border-radius: 999px;
			background: var(--ms-mod);
			color: var(--ml-color-text-inverse);
			font-size: 10px;
			font-weight: 700;
			line-height: 16px;
			text-align: center;
		}
		.busy,
		.unread {
			position: absolute;
			top: 11px;
			right: 11px;
			width: 7px;
			height: 7px;
			border-radius: 50%;
			background: var(--ml-color-primary);
		}
		.busy {
			animation: pulse 1.2s ease-in-out infinite;
		}
		@keyframes pulse {
			50% {
				opacity: 0.3;
			}
		}
		@media (prefers-reduced-motion: reduce) {
			.busy {
				animation: none;
			}
		}
	`,
})
export class WorkspaceButtonComponent {
	@Service(WorkspaceStore) readonly store!: WorkspaceStore;

	onCreate(): void {
		window.addEventListener('keydown', this.onKey, true);
	}

	onDestroy(): void {
		window.removeEventListener('keydown', this.onKey, true);
	}

	/** Caught first, so a focused terminal does not get it. */
	private readonly onKey = (e: KeyboardEvent): void => {
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'KeyK') {
			e.preventDefault();
			e.stopPropagation();
			this.store.toggle();
		}
	};
}
