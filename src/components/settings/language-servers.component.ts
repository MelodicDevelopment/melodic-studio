import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import type { LanguageServer } from '../../services/backend.service';
import { LanguageServersStore } from '../../services/language-servers.store';
import { LspService } from '../../services/lsp.service';

const WHERE: Record<NonNullable<LanguageServer['source']>, string> = {
	project: "This project's own copy",
	managed: 'Installed by Melodic Studio',
	path: 'Found on your PATH',
};

const NEEDS: Record<string, string> = { npm: 'npm (it comes with Node.js)', dotnet: 'the .NET SDK' };

function row(self: LanguageServersComponent, server: LanguageServer) {
	const job = self.store.busy()[server.name];
	const failed = self.store.errors()[server.name];
	// A copy that will not run at all is known up front; one that refused the project or died, only once a file was opened.
	const stopped = server.problem ? undefined : self.lsp.failures()[server.name];
	const usable = !!server.source && !server.problem;
	const state = job ? 'busy' : usable && !stopped ? 'ok' : server.source ? 'bad' : 'none';
	return html`
		<div class="row">
			<div class="what">
				<div class="name">${server.label}</div>
				<div class="status ${state}">
					${job === 'install'
						? html`<ml-spinner size="xs"></ml-spinner><span>Installing ${server.program}. This can take a minute.</span>`
						: job === 'remove'
							? html`<ml-spinner size="xs"></ml-spinner><span>Removing ${server.program}</span>`
							: server.source
								? html`<ml-icon icon=${usable && !stopped ? 'check-circle' : 'warning'} size="xs"></ml-icon><span title=${server.path ?? ''}>${WHERE[server.source]}: ${server.program}${server.version ? ` ${server.version}` : ''}</span>`
								: html`<span>Not installed</span>`}
				</div>
				${server.problem ? html`<div class="trouble">It does not run: ${server.problem}</div>` : ''}
				${stopped ? html`<div class="trouble">It is not running: ${stopped}</div>` : ''}
				${failed ? html`<div class="trouble output">${failed}</div>` : ''}
				${!usable && !server.installable && server.hint ? html`<div class="hint">Install it with <code>${server.hint}</code></div>` : ''}
				${!usable && server.installable && !server.prerequisiteFound
					? html`<div class="hint">Installing it needs ${NEEDS[server.prerequisite ?? ''] ?? server.prerequisite}, which was not found on this computer.</div>`
					: ''}
			</div>
			<div class="acts">
				${stopped ? html`<ml-button variant="outline" size="sm" ?disabled=${!!job} @ml:click=${() => self.store.restart()}>Restart</ml-button>` : ''}
				${server.installable && (!usable || (stopped && !server.managed))
					? html`<ml-button variant="primary" size="sm" ?disabled=${!server.prerequisiteFound || job === 'remove'} ?loading=${job === 'install'} @ml:click=${() => self.store.install(server.name)}>Install</ml-button>`
					: ''}
				${server.managed ? html`<ml-button variant="outline" size="sm" ?disabled=${job === 'install'} ?loading=${job === 'remove'} @ml:click=${() => self.store.remove(server.name)}>Remove</ml-button>` : ''}
			</div>
		</div>
	`;
}

/** The "Language servers" section of Settings: what is installed, with Install and Remove per server. */
@MelodicComponent({
	selector: 'ms-language-servers',
	template: (self: LanguageServersComponent) => {
		const servers = self.store.servers();
		return html`
			<div class="title">Language servers</div>
			<p>Hover, go to definition and errors in the Files tab. A project's own copy is used first; otherwise Melodic Studio installs one into its own folder, never system-wide.</p>
			${servers === null ? html`<div class="row"><ml-spinner size="xs"></ml-spinner></div>` : servers.map((server) => row(self, server))}
		`;
	},
	styles: () => css`
		:host {
			display: block;
			padding-top: 12px;
			border-top: 1px solid var(--ml-color-border);
		}
		.title {
			color: var(--ml-color-text);
			font-weight: 600;
		}
		p {
			margin: 4px 0 6px;
			font-size: 12px;
			line-height: 1.5;
			color: var(--ml-color-text-muted);
		}
		.row {
			display: flex;
			align-items: flex-start;
			gap: 12px;
			padding: 9px 0;
			border-top: 1px solid var(--ml-color-border-muted);
		}
		.what {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 3px;
			font-size: 12px;
		}
		.name {
			font-size: 13px;
			color: var(--ml-color-text);
		}
		.status {
			display: flex;
			align-items: center;
			gap: 5px;
			color: var(--ml-color-text-muted);
			overflow-wrap: anywhere;
		}
		.status ml-icon {
			flex: none;
		}
		.status.ok ml-icon {
			color: var(--ml-color-success);
		}
		.status.bad ml-icon {
			color: var(--ml-color-warning);
		}
		.trouble {
			color: var(--ml-color-danger);
			overflow-wrap: anywhere;
			user-select: text;
			-webkit-user-select: text;
		}
		.output {
			max-height: 96px;
			overflow: auto;
			white-space: pre-wrap;
			font-family: var(--ml-font-mono);
			font-size: 11px;
		}
		.hint {
			color: var(--ml-color-text-secondary);
		}
		code {
			font-family: var(--ml-font-mono);
			color: var(--ml-color-text);
			user-select: text;
			-webkit-user-select: text;
		}
		.acts {
			flex: none;
			display: flex;
			gap: 6px;
		}
	`,
})
export class LanguageServersComponent {
	@Service(LanguageServersStore) readonly store!: LanguageServersStore;
	@Service(LspService) readonly lsp!: LspService;

	elementRef!: HTMLElement;
	private _dialog: Element | null = null;
	private readonly _opened = (): void => void this.store.load();

	onCreate(): void {
		// Look again every time Settings opens: servers come and go outside the app too.
		this._dialog = this.elementRef.closest('ml-dialog');
		this._dialog?.addEventListener('ml:open', this._opened);
	}

	onDestroy(): void {
		this._dialog?.removeEventListener('ml:open', this._opened);
	}
}
