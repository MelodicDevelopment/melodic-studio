import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { ToastService } from '@melodicdev/components/toast';
import { HostWorkStore } from '../../services/host-work.store';
import { BackendService } from '../../services/backend.service';
import { TerminalStore } from '../../services/terminal.store';
import { RepoStore } from '../../services/repo.store';
import { nothing } from '../ai/ai-entry';
import { toolGuide } from '../../shared/host-tools';

/**
 * "Install the GitHub CLI to see pull requests here": shown where a host feature would be, while the
 * tool for that host is missing or signed out. Never a modal; dismissed per tool (unless `always`).
 */
@MelodicComponent({
	selector: 'ms-cli-notice',
	template: (self: CliNoticeComponent) => {
		const guide = toolGuide(self.provider);
		const cli = self.work.clis()?.find((c) => c.provider === self.provider);
		if (!guide || !cli || cli.signedIn || (!self.always && self.work.dismissed().includes(guide.tool))) {
			return nothing();
		}
		const missing = !cli.installed;
		return html`
			<div class="notice">
				<ml-icon icon="terminal-window" size="md"></ml-icon>
				<div class="grow">
					<b>${missing ? `Install the ${guide.name} to see ${self.what || 'this'} here` : `Sign in to ${guide.tool} to see ${self.what || 'this'} here`}</b>
					<p>${guide.unlocks}</p>
					${missing && guide.install ? html`<div class="cmd"><code>${guide.install}</code><button title="Copy" @click=${() => self.copy(guide.install!)}><ml-icon icon="copy" size="sm"></ml-icon></button></div>` : ''}
					${missing && guide.extra ? html`<div class="cmd"><code>${guide.extra}</code><button title="Copy" @click=${() => self.copy(guide.extra!)}><ml-icon icon="copy" size="sm"></ml-icon></button></div>` : ''}
					${!missing
						? html`<div class="cmd"><code>${guide.signIn}</code><button title="Copy" @click=${() => self.copy(guide.signIn)}><ml-icon icon="copy" size="sm"></ml-icon></button></div>`
						: ''}
					<div class="row">
						${missing ? html`<ml-button variant="outline" size="xs" @ml:click=${() => self.openPage(guide.installPage)}>Install page</ml-button>` : ''}
						${!missing && self.repos.repo() ? html`<ml-button variant="outline" size="xs" @ml:click=${() => self.typeInTerminal(guide.signIn)}>Type it in the terminal</ml-button>` : ''}
						<ml-button variant="outline" size="xs" ?loading=${self.work.clisLoading()} @ml:click=${() => self.recheck()}>Check again</ml-button>
						${self.always ? '' : html`<ml-button variant="ghost" size="xs" @ml:click=${() => self.work.dismiss(guide.tool)}>Not now</ml-button>`}
					</div>
					<p class="dim">Nothing is installed for you, and Melodic Studio keeps no tokens: the tool holds its own sign-in.</p>
				</div>
			</div>
		`;
	},
	styles: () => css`
		.notice {
			display: flex;
			gap: 12px;
			padding: 12px 14px;
			border: 1px solid var(--ml-color-border);
			border-radius: 10px;
			background: var(--ml-color-surface-raised, var(--ml-color-surface));
			color: var(--ml-color-text-secondary);
		}
		.notice > ml-icon {
			color: var(--ml-color-text-muted);
		}
		.grow {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 6px;
		}
		b {
			color: var(--ml-color-text);
		}
		p {
			margin: 0;
			line-height: 1.45;
		}
		.dim {
			color: var(--ml-color-text-muted);
			font-size: 12px;
		}
		.cmd {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		code {
			padding: 3px 7px;
			border-radius: 5px;
			background: var(--ms-hover);
			color: var(--ml-color-text);
			font-family: var(--ml-font-mono);
			font-size: 12px;
			user-select: text;
			-webkit-user-select: text;
		}
		.cmd button {
			all: unset;
			display: grid;
			place-items: center;
			width: 22px;
			height: 22px;
			border-radius: 5px;
			cursor: pointer;
			color: var(--ml-color-text-muted);
		}
		.cmd button:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
		.row {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
		}
	`,
})
export class CliNoticeComponent {
	@Service(HostWorkStore) readonly work!: HostWorkStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	@Service(BackendService) private readonly _backend!: BackendService;
	@Service(TerminalStore) private readonly _terminals!: TerminalStore;
	@Service(ToastService) private readonly _toast!: ToastService;

	/** github | azure | gitlab | jira */
	provider = '';
	/** What it would show, for the sentence: "pull requests". */
	what = '';
	/** Show even after "Not now" (inside the feature's own dialog). */
	always = false;

	private readonly _focus = (): void => {
		// Back from a terminal where the user installed or signed in: look again, so the notice can go.
		const cli = this.work.clis()?.find((c) => c.provider === this.provider);
		if (cli && !cli.signedIn && !this.work.clisLoading()) {
			void this.work.loadClis(true);
		}
	};

	onCreate(): void {
		void this.work.loadClis();
		window.addEventListener('focus', this._focus);
	}

	onDestroy(): void {
		window.removeEventListener('focus', this._focus);
	}

	async copy(text: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			this._toast.success('Copied', 'Paste it into a terminal.');
		} catch {
			this._toast.error('Could not copy');
		}
	}

	openPage(url: string): void {
		void this._backend.openUrl(url).catch((e) => this.repos.fail(e));
	}

	/** Opens the terminal panel with the command on the prompt, not run: the user presses Enter. */
	typeInTerminal(command: string): void {
		void this._terminals.add(null, command);
	}

	async recheck(): Promise<void> {
		await this.work.loadClis(true);
	}
}
