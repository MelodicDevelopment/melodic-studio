import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { ToastService } from '@melodicdev/components/toast';
import { HostWorkStore } from '../../services/host-work.store';
import { BackendService, type HostCli } from '../../services/backend.service';
import { RepoStore } from '../../services/repo.store';
import { TerminalStore } from '../../services/terminal.store';
import { toolGuide } from '../../shared/host-tools';

/**
 * Settings › Accounts: each host's command-line tool, who it is signed in as, and what to run when it is
 * missing or signed out. Plus the Jira project of the open repository. No tokens are kept here: each
 * tool holds its own sign-in.
 */
@MelodicComponent({
	selector: 'ms-accounts',
	template: (self: AccountsComponent) => {
		const work = self.work;
		const clis = work.clis();
		const repo = self.repos.repo();
		const jira = work.jiraConfig() ?? (repo ? work.jiraConfigs()[repo.id] : undefined) ?? { site: '', project: '' };
		return html`
			<p class="dim">Melodic Studio talks to GitHub, Azure DevOps, GitLab and Jira only through their own command-line tools, signed in by you. It stores no passwords or tokens.</p>
			${clis === null ? html`<div class="center"><ml-spinner size="md"></ml-spinner></div>` : clis.map((c) => row(self, c))}
			<div class="end">
				${work.dismissed().length ? html`<ml-button variant="ghost" size="sm" @ml:click=${() => work.undismissAll()}>Show hidden notices again</ml-button>` : ''}
				<ml-button variant="outline" size="sm" ?loading=${work.clisLoading()} @ml:click=${() => work.loadClis(true)}><ml-icon slot="icon-start" icon="arrows-clockwise"></ml-icon>Check again</ml-button>
			</div>
			${repo
				? html`
					<h4>Jira for ${repo.name}</h4>
					<div class="pair">
						<ml-input label="Site" placeholder="team.atlassian.net" .value=${jira.site} @ml:change=${(e: CustomEvent) => work.setJiraConfig({ ...jira, site: e.detail.value })}></ml-input>
						<ml-input label="Project key" placeholder="ABC" .value=${jira.project} @ml:change=${(e: CustomEvent) => work.setJiraConfig({ ...jira, project: e.detail.value })}></ml-input>
					</div>
					<small>Issue keys in branch names (ABC-123-…) are offered in the commit message.</small>
				`
				: ''}
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
			gap: 10px;
		}
		.dim,
		small {
			margin: 0;
			color: var(--ml-color-text-muted);
			line-height: 1.45;
		}
		.center {
			display: grid;
			place-items: center;
			padding: 30px;
		}
		.tool {
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 10px 12px;
			border: 1px solid var(--ml-color-border);
			border-radius: 10px;
		}
		.head {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.head b {
			color: var(--ml-color-text);
		}
		.head .who {
			margin-left: auto;
			color: var(--ml-color-text-muted);
			font-size: 12px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
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
		}
		.row,
		.end {
			display: flex;
			flex-wrap: wrap;
			gap: 6px;
		}
		.end {
			justify-content: flex-end;
		}
		.dot {
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background: var(--ml-color-text-muted);
		}
		.dot.ok {
			background: var(--ms-add);
		}
		.dot.warn {
			background: var(--ms-mod);
		}
		h4 {
			margin: 8px 0 0;
			color: var(--ml-color-text);
		}
		.pair {
			display: grid;
			grid-template-columns: 1fr 140px;
			gap: 10px;
		}
	`,
})
export class AccountsComponent {
	@Service(HostWorkStore) readonly work!: HostWorkStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	@Service(BackendService) private readonly _backend!: BackendService;
	@Service(TerminalStore) private readonly _terminals!: TerminalStore;
	@Service(ToastService) private readonly _toast!: ToastService;

	/** Set by Settings while this tab is on screen; checking the tools waits until then (az is slow to answer). */
	set active(on: boolean) {
		if (on) {
			void this.work.loadClis();
		}
	}
	get active(): boolean {
		return false;
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

	typeInTerminal(command: string): void {
		this.repos.closeDialog('settings');
		void this._terminals.add(null, command);
	}
}

function cmd(self: AccountsComponent, text: string) {
	return html`<div class="cmd"><code>${text}</code><button title="Copy" @click=${() => self.copy(text)}><ml-icon icon="copy" size="sm"></ml-icon></button></div>`;
}

function row(self: AccountsComponent, c: HostCli) {
	const guide = toolGuide(c.provider);
	if (!guide) {
		return '';
	}
	const state = c.signedIn ? 'ok' : c.installed ? 'warn' : '';
	return html`
		<div class="tool">
			<div class="head">
				<span class="dot ${state}"></span>
				<b>${c.name}</b><span class="dim">${guide.tool}</span>
				<span class="who">${c.signedIn ? (c.account ? `Signed in as ${c.account}` : 'Signed in') : c.installed ? 'Installed, not signed in' : 'Not installed'}</span>
			</div>
			${c.signedIn
				? ''
				: html`
					<small>${guide.unlocks}</small>
					${!c.installed && guide.install ? cmd(self, guide.install) : ''}
					${!c.installed && guide.extra ? cmd(self, guide.extra) : ''}
					${c.installed ? cmd(self, guide.signIn) : ''}
					<div class="row">
						${!c.installed ? html`<ml-button variant="outline" size="xs" @ml:click=${() => self.openPage(guide.installPage)}>Install page</ml-button>` : ''}
						${c.installed && self.repos.repo() ? html`<ml-button variant="outline" size="xs" @ml:click=${() => self.typeInTerminal(guide.signIn)}>Type it in the terminal</ml-button>` : ''}
					</div>
				`}
		</div>
	`;
}
