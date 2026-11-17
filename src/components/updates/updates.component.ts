import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { UpdatesService } from '../../services/updates.service';

/** Toolbar pill that appears once a newer version has been downloaded: one click restarts into it. */
@MelodicComponent({
	selector: 'ms-update-pill',
	template: (self: UpdatePillComponent) => {
		const staged = self.updates.staged();
		const restarting = self.updates.state() === 'restarting';
		// Not a bare html``: Melodic cannot switch a component away from a completely empty first template.
		if (!staged) {
			return html`<span hidden></span>`;
		}
		return html`
			<button class="pill" ?disabled=${restarting} title=${`You have ${staged.currentVersion}. Restart to finish updating.`} @click=${() => self.updates.restart()}>
				${restarting ? html`<ml-spinner size="xs"></ml-spinner>` : html`<ml-icon icon="arrow-circle-up" size="sm" format="bold"></ml-icon>`}
				<span>${restarting ? 'Restarting…' : `Version ${staged.version} is ready`}</span>
				${restarting ? '' : html`<b>Restart to update</b>`}
			</button>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			align-items: center;
		}
		.pill {
			all: unset;
			display: flex;
			align-items: center;
			gap: 7px;
			margin: 0 8px;
			padding: 5px 12px;
			border-radius: 999px;
			border: 1px solid var(--ml-color-primary);
			background: var(--ml-color-primary-subtle);
			color: var(--ms-toolbar-fg);
			font-size: 12px;
			white-space: nowrap;
		}
		.pill:hover:not([disabled]) {
			background: var(--ml-color-primary);
			color: var(--ml-color-text-inverse);
		}
		.pill:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: 2px;
		}
		.pill ml-icon {
			color: var(--ml-color-primary);
		}
		.pill:hover:not([disabled]) ml-icon {
			color: inherit;
		}
		b {
			font-weight: 600;
		}
	`,
})
export class UpdatePillComponent {
	@Service(UpdatesService) readonly updates!: UpdatesService;

	onCreate(): void {
		this.updates.start();
	}
}

/** The "Updates" row in Settings: what the updater is doing, and a button to check now. */
@MelodicComponent({
	selector: 'ms-update-status',
	template: (self: UpdateStatusComponent) => {
		const u = self.updates;
		const state = u.state();
		const staged = u.staged();
		const text = !u.supported
			? 'Updates are checked in the installed app, not in a development build.'
			: state === 'checking'
				? 'Checking for updates…'
				: state === 'downloading'
					? 'Downloading the new version…'
					: state === 'ready' || state === 'restarting'
						? `Version ${staged?.version ?? ''} is downloaded and ready.`
						: state === 'current'
							? 'You have the latest version.'
							: state === 'failed'
								? `Could not check for updates: ${u.error()}`
								: 'Melodic Studio checks for updates by itself and downloads them in the background.';
		return html`
			<div class="row">
				<span class="text ${state === 'failed' ? 'bad' : ''}">${text}</span>
				${state === 'ready' || state === 'restarting'
					? html`<ml-button variant="primary" size="sm" ?loading=${state === 'restarting'} @ml:click=${() => u.restart()}>Restart to update</ml-button>`
					: html`<ml-button variant="outline" size="sm" ?disabled=${!u.supported} ?loading=${state === 'checking' || state === 'downloading'} @ml:click=${() => u.check()}>Check now</ml-button>`}
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: block;
		}
		.row {
			display: flex;
			align-items: center;
			gap: 12px;
		}
		.text {
			flex: 1;
			min-width: 0;
			font-size: 12px;
			line-height: 1.45;
			color: var(--ml-color-text-muted);
			overflow-wrap: anywhere;
		}
		.text.bad {
			color: var(--ml-color-danger);
		}
	`,
})
export class UpdateStatusComponent {
	@Service(UpdatesService) readonly updates!: UpdatesService;
}
