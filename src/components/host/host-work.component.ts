import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { BackendService } from '../../services/backend.service';
import { html, css } from '@melodicdev/core/template';
import { HostStore } from '../../services/host.store';
import { HostWorkStore, jiraBranch } from '../../services/host-work.store';
import { AiFeaturesStore } from '../../services/ai-features.store';
import { RepoStore } from '../../services/repo.store';
import type { HostCheck, HostNote, JiraIssue, MergeMethod, PrScope, PrSummary } from '../../services/backend.service';
import { relativeTime } from '../../shared/format';
import { hostDialogsStyles } from './host-dialogs.styles';

const SCOPES: { value: PrScope; label: string }[] = [
	{ value: 'open', label: 'All open' },
	{ value: 'mine', label: 'Mine' },
	{ value: 'review', label: 'To review' },
];
const METHODS: { value: MergeMethod; label: string }[] = [
	{ value: 'squash', label: 'Squash and merge' },
	{ value: 'merge', label: 'Merge commit' },
	{ value: 'rebase', label: 'Rebase and merge' },
];
const JIRA_STATUSES = ['To Do', 'In Progress', 'In Review', 'Done'];

function hintText(hint: string) {
	return hint.split('`').map((part, i) => (i % 2 ? html`<code>${part}</code>` : part));
}

const CHECK_ICON: Record<string, string> = { pass: 'check-circle', fail: 'x-circle', pending: 'circle-dashed', skipped: 'minus-circle' };

function checkIcon(state: string) {
	return state ? html`<ml-icon class="state ${state}" icon=${CHECK_ICON[state] ?? 'circle'} size="sm"></ml-icon>` : '';
}

function prRow(self: HostWorkComponent, pr: PrSummary, selected: string | null) {
	return html`
		<div class="issue ${pr.id === selected ? 'sel' : ''}" @click=${() => self.work.selectPr(pr.id)}>
			<div class="line"><span class="num">#${pr.id}</span><span class="title">${pr.title}</span></div>
			<div class="meta">
				${pr.draft ? html`<span class="label">draft</span>` : ''}
				${pr.review === 'approved' ? html`<span class="label ok">approved</span>` : pr.review === 'changes' ? html`<span class="label bad">changes asked</span>` : pr.review === 'required' ? html`<span class="label">review needed</span>` : ''}
				<span>${pr.author}</span>
				<span class="grow"></span>
				${checkIcon(pr.checks)}
				<span>${relativeTime(pr.updated)}</span>
			</div>
		</div>
	`;
}

function note(n: HostNote) {
	return html`
		<div class="note-item ${n.kind}">
			<div class="who"><b>${n.author || 'someone'}</b>${n.kind === 'approved' ? ' approved' : n.kind === 'changes' ? ' asked for changes' : ''}<span class="dim">${n.created ? relativeTime(n.created) : ''}</span></div>
			${n.body.trim() ? html`<div class="text selectable">${n.body}</div>` : ''}
		</div>
	`;
}

function check(self: HostWorkComponent, c: HostCheck) {
	return html`<div class="check">${checkIcon(c.state)}<span class="grow">${c.name}</span>${c.url ? html`<button class="icon" title="Open" @click=${() => self.host.openUrl(c.url)}><ml-icon icon="arrow-square-out" size="sm"></ml-icon></button>` : ''}</div>`;
}

function prDetail(self: HostWorkComponent) {
	const work = self.work;
	const d = work.prDetail();
	const busy = work.prBusy();
	if (!d) {
		return html`<div class="detail"><div class="body none">${work.prDetailLoading() ? html`<ml-spinner size="md"></ml-spinner>` : 'Pick one on the left.'}</div></div>`;
	}
	const p = d.summary;
	const word = self.host.prWord;
	return html`
		<div class="detail">
			<h4 class="selectable">${p.title}</h4>
			<div class="facts">
				<ml-badge size="xs" variant=${p.state === 'open' ? 'success' : p.state === 'merged' ? 'primary' : 'default'}>${p.draft ? 'draft' : p.state}</ml-badge>
				<span>#${p.id}</span>
				<span><ml-icon icon="user" size="xs"></ml-icon>${p.author}</span>
				<span class="branchy"><ml-icon icon="git-branch" size="xs"></ml-icon>${p.head} → ${p.base}</span>
				${p.updated ? html`<span><ml-icon icon="clock" size="xs"></ml-icon>${relativeTime(p.updated)}</span>` : ''}
			</div>
			${d.mergeable === false ? html`<p class="note warn"><ml-icon icon="warning" size="sm"></ml-icon><span>This ${word} has conflicts with ${p.base}.</span></p>` : ''}
			${d.body.trim() ? html`<div class="body selectable">${d.body}</div>` : html`<div class="body none">No description.</div>`}
			${d.checks.length ? html`<h5>Checks</h5><div class="checks">${d.checks.map((c) => check(self, c))}</div>` : ''}
			${d.files.length ? html`<h5>${d.files.length} files</h5><div class="files">${d.files.map((f) => html`<div class="file"><span class="grow path">${f.path}</span><span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span></div>`)}</div>` : ''}
			${d.notes.length ? html`<h5>Conversation</h5>${d.notes.map(note)}` : ''}
			${p.state === 'open'
				? html`
					<h5>Your review</h5>
					<ml-textarea rows="3" placeholder="Leave a comment (it is posted on the host as you)" .value=${work.reviewText()} ?disabled=${!!busy} @ml:input=${(e: CustomEvent) => work.reviewText.set(e.detail.value)}></ml-textarea>
					<div class="row">
						<ml-button variant="outline" size="sm" ?disabled=${!!busy || !work.reviewText().trim()} ?loading=${busy === 'comment'} @ml:click=${() => work.review('comment')}>Comment</ml-button>
						<ml-button variant="outline" size="sm" ?disabled=${!!busy || !work.reviewText().trim()} ?loading=${busy === 'request-changes'} @ml:click=${() => work.review('request-changes')}>Request changes</ml-button>
						<ml-button variant="outline" size="sm" ?disabled=${!!busy} ?loading=${busy === 'approve'} @ml:click=${() => work.review('approve')}><ml-icon slot="icon-start" icon="check"></ml-icon>Approve</ml-button>
					</div>
					${work.confirmMerge()
						? html`
							<div class="merge">
								<ml-select size="sm" .options=${METHODS} .value=${work.mergeMethod()} @ml:change=${(e: CustomEvent) => work.mergeMethod.set(e.detail.value as MergeMethod)}></ml-select>
								<ml-checkbox label=${`Delete ${p.head} afterwards`} .checked=${work.deleteBranch()} @ml:change=${(e: CustomEvent) => work.deleteBranch.set(e.detail.checked)}></ml-checkbox>
								<span class="grow"></span>
								<ml-button variant="outline" size="sm" @ml:click=${() => work.confirmMerge.set(false)}>Cancel</ml-button>
								<ml-button variant="primary" size="sm" ?loading=${busy === 'merge'} ?disabled=${!!busy && busy !== 'merge'} @ml:click=${() => work.merge()}>Merge into ${p.base}</ml-button>
							</div>
						`
						: ''}
				`
				: ''}
		</div>
	`;
}

function pullsDialog(self: HostWorkComponent) {
	const work = self.work;
	const host = self.host;
	const cli = host.cli();
	const st = self.repos.status();
	const label = cli?.pullsLabel ?? st?.host?.pullsLabel ?? 'Pull requests';
	const where = cli?.hostName ?? st?.host?.name ?? 'the host';
	const prs = work.prs();
	const selected = work.selectedPr();
	const d = work.prDetail();
	const busy = work.prBusy();
	return html`
		<ml-dialog #host-pulls style="--ml-dialog-max-width: 1040px">
			<h3 slot="dialog-header">${label} on ${where}</h3>
			<div class="dlg">
				${cli === undefined
					? html`<div class="setup"><ml-spinner size="md"></ml-spinner></div>`
					: !host.ready()
						? html`<ms-cli-notice .provider=${st?.host?.provider ?? ''} .what=${label.toLowerCase()} .always=${true}></ms-cli-notice>`
						: html`
							<div class="browse">
								<div class="side">
									<div class="search">
										<ml-select size="sm" .options=${SCOPES} .value=${work.prScope()} @ml:change=${(e: CustomEvent) => work.setScope(e.detail.value as PrScope)}></ml-select>
										<span class="grow"></span>
										<button class="icon" title="Reload" ?disabled=${work.prsLoading()} @click=${() => work.loadPrs()}>${work.prsLoading() ? html`<ml-spinner size="xs"></ml-spinner>` : html`<ml-icon icon="arrows-clockwise" size="sm"></ml-icon>`}</button>
									</div>
									<div class="rows">
										${work.prsError() ? html`<div class="none selectable"><b>The list could not be loaded.</b><br />${hintText(work.prsError()!)}</div>` : ''}
										${!work.prsError() && !prs.length ? html`<div class="none">${work.prsLoading() ? 'Loading…' : `No open ${label.toLowerCase()} here.`}</div>` : ''}
										${prs.map((p) => prRow(self, p, selected))}
									</div>
								</div>
								${prDetail(self)}
							</div>
						`}
			</div>
			<div slot="dialog-footer" class="foot">
				${st?.host?.pulls ? html`<ml-button variant="outline" @ml:click=${() => self.repos.openIn('pulls')}><ml-icon slot="icon-start" icon="arrow-square-out"></ml-icon>All on ${where}</ml-button>` : ''}
				<span class="grow"></span>
				<ml-button variant="outline" @ml:click=${() => work.closePulls()}>Close</ml-button>
				${d
					? html`
						<ml-button variant="outline" @ml:click=${() => host.openUrl(d.summary.url)}><ml-icon slot="icon-start" icon="arrow-square-out"></ml-icon>Open on ${where}</ml-button>
						<ml-button variant="outline" ?loading=${busy === 'checkout'} ?disabled=${!!busy && busy !== 'checkout'} @ml:click=${() => work.checkout()}><ml-icon slot="icon-start" icon="git-branch"></ml-icon>Check out</ml-button>
						<ml-button variant="outline" title=${self.ai.unavailable() || `Checks it out in its own worktree, then Claude looks for bugs and risks in everything it adds to ${d.summary.base}. Nothing is posted to ${where}.`} ?loading=${busy === 'claude'} ?disabled=${(!!busy && busy !== 'claude') || !!self.ai.unavailable()} @ml:click=${() => self.reviewWithClaude()}><ml-icon slot="icon-start" icon="sparkle"></ml-icon>Review with Claude</ml-button>
						${d.summary.state === 'open' && !work.confirmMerge() ? html`<ml-button variant="primary" ?disabled=${!!busy || d.summary.draft} @ml:click=${() => work.confirmMerge.set(true)}><ml-icon slot="icon-start" icon="git-merge"></ml-icon>Merge…</ml-button>` : ''}
					`
					: ''}
			</div>
		</ml-dialog>
	`;
}

function jiraRow(self: HostWorkComponent, j: JiraIssue, selected: string | null) {
	return html`
		<div class="issue ${j.key === selected ? 'sel' : ''}" @click=${() => self.work.selectJira(j.key)}>
			<div class="line"><span class="num">${j.key}</span><span class="title">${j.title}</span></div>
			<div class="meta"><span>${j.kind}</span><span class="label">${j.status}</span><span class="grow"></span><span>${j.updated ? relativeTime(j.updated) : ''}</span></div>
		</div>
	`;
}

function jiraDialog(self: HostWorkComponent) {
	const work = self.work;
	const config = work.jiraConfig();
	const jira = work.clis()?.find((c) => c.provider === 'jira');
	const issues = work.jiraIssues();
	const sel = issues.find((i) => i.key === work.selectedJira()) ?? null;
	const busy = work.jiraBusy();
	return html`
		<ml-dialog #host-jira style="--ml-dialog-max-width: 980px" @ml:open=${(e: Event) => e.target === e.currentTarget && void work.loadClis()}>
			<h3 slot="dialog-header">Jira${config ? ` · ${config.project}` : ''}</h3>
			<div class="dlg">
				${jira && !jira.signedIn ? html`<ms-cli-notice .provider=${'jira'} .what=${'Jira issues'} .always=${true}></ms-cli-notice>` : ''}
				${!config
					? html`
						<div class="setup">
							<ml-icon icon="kanban" size="lg"></ml-icon>
							<b>Which Jira project belongs to ${self.repos.repo()?.name ?? 'this repository'}?</b>
							<p class="dim">Set the site and project key in Settings › Accounts. Issues are read through Atlassian's own CLI (acli); Melodic Studio keeps no Jira token.</p>
							<ml-button variant="outline" size="sm" @ml:click=${() => self.openAccounts()}>Open Settings › Accounts</ml-button>
						</div>
					`
					: html`
						<div class="browse">
							<div class="side">
								<div class="search">
									<ml-input size="sm" placeholder="Search, or an issue key" .value=${work.jiraQuery()} @ml:input=${(e: CustomEvent) => work.setJiraQuery(e.detail.value)}>
										<ml-icon slot="prefix" icon="magnifying-glass" size="sm"></ml-icon>
									</ml-input>
									<button class="icon" title="Reload" ?disabled=${work.jiraLoading()} @click=${() => work.loadJira()}>${work.jiraLoading() ? html`<ml-spinner size="xs"></ml-spinner>` : html`<ml-icon icon="arrows-clockwise" size="sm"></ml-icon>`}</button>
								</div>
								<div class="rows">
									${work.jiraError() ? html`<div class="none selectable"><b>The list could not be loaded.</b><br />${hintText(work.jiraError()!)}</div>` : ''}
									${!work.jiraError() && !issues.length ? html`<div class="none">${work.jiraLoading() ? 'Loading…' : 'Nothing open that is yours or moved lately.'}</div>` : ''}
									${issues.map((j) => jiraRow(self, j, sel?.key ?? null))}
								</div>
							</div>
							${sel
								? html`
									<div class="detail">
										<h4 class="selectable">${sel.title}</h4>
										<div class="facts">
											<ml-badge size="xs">${sel.status}</ml-badge>
											<span>${sel.key}</span>
											<span>${sel.kind}</span>
											${sel.assignee ? html`<span><ml-icon icon="user" size="xs"></ml-icon>${sel.assignee}</span>` : html`<span>Unassigned</span>`}
										</div>
										${sel.body.trim() ? html`<div class="body selectable">${sel.body}</div>` : html`<div class="body none">No description.</div>`}
										<h5>Move to</h5>
										<div class="row">${JIRA_STATUSES.filter((s) => s !== sel.status).map((s) => html`<ml-button variant="outline" size="sm" ?disabled=${!!busy} @ml:click=${() => work.jiraMove(sel.key, s)}>${s}</ml-button>`)}</div>
										<h5>Comment</h5>
										<ml-textarea rows="3" .value=${work.jiraComment()} ?disabled=${!!busy} @ml:input=${(e: CustomEvent) => work.jiraComment.set(e.detail.value)}></ml-textarea>
										<div class="row"><ml-button variant="outline" size="sm" ?disabled=${!!busy || !work.jiraComment().trim()} ?loading=${busy === 'comment'} @ml:click=${() => work.jiraPostComment(sel.key)}>Post comment</ml-button></div>
									</div>
								`
								: html`<div class="detail"><div class="body none">Pick one on the left.</div></div>`}
						</div>
					`}
			</div>
			<div slot="dialog-footer" class="foot">
				<span class="grow"></span>
				<ml-button variant="outline" @ml:click=${() => work.closeJira()}>Close</ml-button>
				${sel
					? html`
						<ml-button variant="outline" @ml:click=${() => self.openJiraPage(sel.url)}><ml-icon slot="icon-start" icon="arrow-square-out"></ml-icon>Open in Jira</ml-button>
						<ml-button variant="primary" @ml:click=${() => self.branchForJira(sel)}><ml-icon slot="icon-start" icon="git-branch"></ml-icon>Create branch</ml-button>
					`
					: ''}
			</div>
		</ml-dialog>
	`;
}

/**
 * The Pull requests browser and the Jira dialog. Both are opened through HostWorkStore (`openPulls()`,
 * `openJira()`), which holds their state.
 */
@MelodicComponent({
	selector: 'ms-host-work',
	template: (self: HostWorkComponent) => html`${pullsDialog(self)}${jiraDialog(self)}`,
	styles: () => css`
		${hostDialogsStyles()}
		h5 {
			margin: 8px 0 0;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
		}
		.row,
		.merge {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 8px;
		}
		.merge {
			padding: 10px;
			border: 1px solid var(--ml-color-border);
			border-radius: 8px;
		}
		.checks,
		.files {
			display: flex;
			flex-direction: column;
			gap: 2px;
		}
		.check,
		.file {
			display: flex;
			align-items: center;
			gap: 8px;
			min-height: 24px;
		}
		.file .path {
			font-family: var(--ml-font-mono);
			font-size: 12px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.add {
			color: var(--ms-add);
			font-family: var(--ml-font-mono);
			font-size: 12px;
		}
		.del {
			color: var(--ms-del);
			font-family: var(--ml-font-mono);
			font-size: 12px;
		}
		.state.pass {
			color: var(--ms-add);
		}
		.state.fail {
			color: var(--ms-del);
		}
		.state.pending {
			color: var(--ms-mod);
		}
		.state.skipped {
			color: var(--ml-color-text-muted);
		}
		.label.ok {
			color: var(--ms-add);
		}
		.label.bad {
			color: var(--ms-del);
		}
		.branchy {
			font-family: var(--ml-font-mono);
			font-size: 12px;
		}
		.note-item {
			padding: 8px 10px;
			border: 1px solid var(--ml-color-border);
			border-radius: 8px;
		}
		.note-item.approved {
			border-color: var(--ms-add);
		}
		.note-item.changes {
			border-color: var(--ms-del);
		}
		.note-item .who {
			display: flex;
			gap: 6px;
			align-items: baseline;
		}
		.note-item .text {
			margin-top: 4px;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
		}
	`,
})
export class HostWorkComponent {
	@Service(HostWorkStore) readonly work!: HostWorkStore;
	@Service(HostStore) readonly host!: HostStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	@Service(AiFeaturesStore) readonly ai!: AiFeaturesStore;
	@Service(BackendService) private readonly _backend!: BackendService;

	/**
	 * The selected pull request, reviewed by Claude: its branch is checked out in a worktree of its
	 * own and compared with the branch it is to be merged into. The findings stay in the app.
	 */
	async reviewWithClaude(): Promise<void> {
		const pr = this.work.prDetail()?.summary;
		if (!pr) {
			return;
		}
		const word = this.host.prWord;
		if (await this.work.checkout('claude')) {
			await this.ai.review({ scope: 'branch', base: pr.base, label: `${word[0].toUpperCase()}${word.slice(1)} #${pr.id}` });
		}
	}

	onCreate(): void {
		this.work.watch();
	}

	openAccounts(): void {
		this.work.closeJira();
		this.repos.ask('settings', { settingsTab: 'accounts' });
	}

	/** Jira pages are on the user's own site, not the repository's host, so they open as plain links. */
	openJiraPage(url: string): void {
		if (/^https:\/\/[A-Za-z0-9.-]+\/browse\/[A-Z][A-Z0-9_]*-\d+$/.test(url)) {
			void this._backend.openUrl(url).catch((e) => this.repos.fail(e));
		}
	}

	async branchForJira(issue: JiraIssue): Promise<void> {
		this.work.closeJira();
		await this.work.branchFor(jiraBranch(issue));
	}
}
