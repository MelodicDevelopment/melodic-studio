import { html } from '@melodicdev/core/template';
import type { HostDialogsComponent } from './host-dialogs.component';
import type { AgentMode, HostCliStatus, HostIssue } from '../../services/backend.service';
import { AGENT_MODES } from '../agents/agents.component';
import { issueBranch } from '../../services/host.store';
import { DRAFT_IMAGES } from '../../services/agents.store';
import { plural, relativeTime } from '../../shared/format';

/** Azure DevOps cuts a pull request description off here. */
const AZURE_MAX_DESCRIPTION = 4000;

/** A hint with its `commands` set in code type. Everything is text; nothing here is markup from outside. */
function hintText(hint: string) {
	return hint.split('`').map((part, i) => (i % 2 ? html`<code>${part}</code>` : part));
}

/** Why the host's tool cannot be used, and the way out. */
function setup(self: HostDialogsComponent, cli: HostCliStatus | null, what: string) {
	const host = self.host;
	const title = !cli
		? 'This repository has no remote on a host Melodic Studio knows'
		: !cli.tool
			? `${what} from ${cli.hostName} open in your browser`
			: !cli.installed
				? `The ${cli.hostName} command-line tool (${cli.tool}) is not installed`
				: `${cli.tool} is not ready to use`;
	return html`
		<div class="setup">
			<ml-icon icon=${cli?.tool ? 'terminal-window' : 'globe'} size="lg"></ml-icon>
			<b>${title}</b>
			${cli?.tool ? html`<ms-cli-notice .provider=${cli.provider} .what=${what.toLowerCase()} .always=${true}></ms-cli-notice>` : cli?.hint ? html`<p class="selectable">${hintText(cli.hint)}</p>` : ''}
			<p class="dim">Melodic Studio keeps no passwords or tokens. It reads ${what.toLowerCase()} through the tool you sign in to yourself.</p>
			${cli?.tool ? html`<ml-button variant="outline" size="sm" ?loading=${host.cliLoading()} @ml:click=${() => host.recheck()}><ml-icon slot="icon-start" icon="arrows-clockwise"></ml-icon>Check again</ml-button>` : ''}
		</div>
	`;
}

function issueRow(self: HostDialogsComponent, issue: HostIssue, selected: string | null) {
	return html`
		<div class="issue ${issue.id === selected ? 'sel' : ''}" @click=${() => self.selectIssue(issue.id)}>
			<div class="line"><span class="num">#${issue.id}</span><span class="title">${issue.title}</span></div>
			<div class="meta">
				${issue.kind === 'issue' ? '' : html`<span>${issue.kind}</span>`}
				${issue.labels.slice(0, 3).map((l) => html`<span class="label">${l}</span>`)}
				<span class="grow"></span>
				<span>${relativeTime(issue.updated)}</span>
			</div>
		</div>
	`;
}

/** Text from the host is shown as text: no HTML, no markdown rendering. */
function issueDetail(self: HostDialogsComponent, issue: HostIssue) {
	const work = self.work;
	const busy = work.issueBusy();
	const open = issue.state === 'open' || !['closed', 'done', 'resolved', 'removed', 'completed'].includes(issue.state.toLowerCase());
	return html`
		<div class="detail">
			<h4 class="selectable">${issue.title}</h4>
			<div class="facts">
				<ml-badge size="xs" variant=${issue.state === 'open' ? 'success' : 'default'}>${issue.kind === 'issue' ? issue.state : `${issue.kind} · ${issue.state}`}</ml-badge>
				<span>#${issue.id}</span>
				${issue.assignee ? html`<span><ml-icon icon="user" size="xs"></ml-icon>${issue.assignee}</span>` : html`<span>Unassigned</span>`}
				${issue.updated ? html`<span><ml-icon icon="clock" size="xs"></ml-icon>${relativeTime(issue.updated)}</span>` : ''}
			</div>
			${issue.labels.length ? html`<div class="labels">${issue.labels.map((l) => html`<span class="label">${l}</span>`)}</div>` : ''}
			${issue.body.trim() ? html`<div class="body selectable">${issue.body}</div>` : html`<div class="body none">No description.</div>`}
			<div class="acts">
				<ml-textarea rows="3" placeholder="Comment (posted on the host as you)" .value=${work.issueComment()} ?disabled=${!!busy} @ml:input=${(e: CustomEvent) => work.issueComment.set(e.detail.value)}></ml-textarea>
				<div class="under">
					<ml-button variant="outline" size="xs" ?disabled=${!!busy || !work.issueComment().trim()} ?loading=${busy === 'comment'} @ml:click=${() => work.commentOnIssue(issue.id)}>Comment</ml-button>
					<ml-button variant="outline" size="xs" ?disabled=${!!busy} ?loading=${busy === 'close' || busy === 'reopen'} @ml:click=${() => work.setIssueOpen(issue.id, !open)}>${open ? 'Close' : 'Reopen'}</ml-button>
					<span class="grow"></span>
					<ml-button variant="outline" size="xs" title=${issueBranch(issue)} @ml:click=${() => self.branchFor(issue)}><ml-icon slot="icon-start" icon="git-branch"></ml-icon>Create branch</ml-button>
				</div>
			</div>
		</div>
	`;
}

function newIssueForm(self: HostDialogsComponent, label: string) {
	const work = self.work;
	const draft = work.newIssue()!;
	const azure = self.repos.status()?.host?.provider === 'azure';
	return html`
		<div class="detail form">
			<p class="dim">New ${label.toLowerCase().replace(/s$/, '')}. It is created on the host as you when you press Create.</p>
			${azure ? html`<ml-select label="Type" .options=${['Task', 'Bug', 'User Story', 'Feature', 'Issue'].map((v) => ({ value: v, label: v }))} .value=${draft.kind} @ml:change=${(e: CustomEvent) => work.editNewIssue({ kind: e.detail.value })}></ml-select>` : ''}
			<ml-input label="Title" .value=${draft.title} @ml:input=${(e: CustomEvent) => work.editNewIssue({ title: e.detail.value })}></ml-input>
			<ml-textarea label="Description" rows="10" .value=${draft.body} @ml:input=${(e: CustomEvent) => work.editNewIssue({ body: e.detail.value })}></ml-textarea>
		</div>
	`;
}

function taskForm(self: HostDialogsComponent) {
	const host = self.host;
	const task = host.task();
	if (!task) {
		return '';
	}
	const where = self.repos.status()?.host?.name ?? 'the host';
	return html`
		<div class="detail form">
			<p class="dim">The agent works in its own worktree on a new branch. Read the task first: the description below was written on ${where} and becomes part of what the agent is told.</p>
			<ml-textarea label="Task" rows="11" .value=${task.task} @ml:input=${(e: CustomEvent) => host.editTask({ task: e.detail.value })}></ml-textarea>
			<ms-attach .box=${DRAFT_IMAGES.issue} .pick=${true}></ms-attach>
			<ml-input label="Branch" hint=${`Starts from ${self.repos.status()?.branch ?? 'the current commit'}`} .value=${task.branch} @ml:input=${(e: CustomEvent) => self.setBranch(e.detail.value)}></ml-input>
			<ml-select label="Permissions" .options=${AGENT_MODES} .value=${task.mode} @ml:change=${(e: CustomEvent) => host.editTask({ mode: e.detail.value as AgentMode })}></ml-select>
			${task.mode === 'bypassPermissions' ? html`<p class="note warn"><ml-icon icon="warning" size="sm"></ml-icon><span>Full auto lets the agent run any shell command on this computer. With a task that quotes text from ${where}, prefer one of the other modes.</span></p>` : ''}
			${self.agents.cli() === null ? html`<p class="note warn"><ml-icon icon="warning" size="sm"></ml-icon><span>Claude Code was not found on this computer, so an agent cannot start. Install it, then restart Melodic Studio.</span></p>` : ''}
		</div>
	`;
}

function issuesDialog(self: HostDialogsComponent) {
	const host = self.host;
	const st = self.repos.status();
	const cli = host.cli();
	const label = cli?.issuesLabel ?? st?.host?.issuesLabel ?? 'Issues';
	const where = cli?.hostName ?? st?.host?.name ?? 'the host';
	const issues = host.issues();
	const issue = host.selectedIssue();
	const task = host.task();
	const loading = host.issuesLoading();
	const error = host.issuesError();
	const ready = host.ready();
	return html`
		<ml-dialog #host-issues style="--ml-dialog-max-width: 980px">
			<h3 slot="dialog-header">${label} on ${where}</h3>
			<div class="dlg">
				${cli === undefined
					? html`<div class="setup"><ml-spinner size="md"></ml-spinner><p class="dim">Looking for the ${where} command-line tool…</p></div>`
					: !ready
						? setup(self, cli, label)
						: html`
							<div class="browse">
								<div class="side">
									<div class="search">
										<ml-input size="sm" placeholder=${`Search open ${label.toLowerCase()}`} .value=${host.query()} @ml:input=${(e: CustomEvent) => host.setQuery(e.detail.value)}>
											<ml-icon slot="prefix" icon="magnifying-glass" size="sm"></ml-icon>
										</ml-input>
										<button class="icon" title="Reload" ?disabled=${loading} @click=${() => host.loadIssues()}>${loading ? html`<ml-spinner size="xs"></ml-spinner>` : html`<ml-icon icon="arrows-clockwise" size="sm"></ml-icon>`}</button>
										<button class="icon" title="New" @click=${() => self.work.startNewIssue()}><ml-icon icon="plus" size="sm"></ml-icon></button>
									</div>
									<div class="rows">
										${error ? html`<div class="none selectable"><b>The list could not be loaded.</b><br />${hintText(error)}</div>` : ''}
										${!error && !issues.length ? html`<div class="none">${loading ? 'Loading…' : host.query().trim() ? `No open ${label.toLowerCase()} match.` : `No open ${label.toLowerCase()}.`}</div>` : ''}
										${issues.map((i) => issueRow(self, i, issue?.id ?? null))}
									</div>
								</div>
								${self.work.newIssue() ? newIssueForm(self, label) : task ? taskForm(self) : issue ? issueDetail(self, issue) : html`<div class="detail"><div class="body none">${issues.length ? `Pick one on the left.` : ''}</div></div>`}
							</div>
						`}
			</div>
			<div slot="dialog-footer" class="foot">
				${st?.host?.issues ? html`<ml-button variant="outline" @ml:click=${() => self.openIssuesPage()}><ml-icon slot="icon-start" icon="arrow-square-out"></ml-icon>All ${label.toLowerCase()} on ${where}</ml-button>` : ''}
				<span class="grow"></span>
				${self.work.newIssue()
					? html`
						<ml-button variant="outline" @ml:click=${() => self.work.newIssue.set(null)}>Back</ml-button>
						<ml-button variant="primary" ?disabled=${!self.work.newIssue()!.title.trim()} ?loading=${self.work.issueBusy() === 'create'} @ml:click=${() => self.work.createIssue()}>Create</ml-button>
					`
					: task
					? html`
						<ml-button variant="outline" @ml:click=${() => host.task.set(null)}>Back</ml-button>
						<ml-button variant="primary" ?disabled=${!task.task.trim() || !task.branch.trim() || self.agents.cli() === null || !!self.agents.attaching()[DRAFT_IMAGES.issue]} ?loading=${self.agents.busy()} @ml:click=${() => host.startAgent()}><ml-icon slot="icon-start" icon="robot"></ml-icon>Start agent</ml-button>
					`
					: html`
						<ml-button variant="outline" @ml:click=${() => host.close('host-issues')}>Close</ml-button>
						${ready && issue
							? html`
								<ml-button variant="outline" @ml:click=${() => host.openUrl(issue.url)}><ml-icon slot="icon-start" icon="arrow-square-out"></ml-icon>Open on ${where}</ml-button>
								<ml-button variant="primary" @ml:click=${() => host.prepareTask()}><ml-icon slot="icon-start" icon="robot"></ml-icon>Start agent on this</ml-button>
							`
							: ''}
					`}
			</div>
		</ml-dialog>
	`;
}

function prDialog(self: HostDialogsComponent) {
	const host = self.host;
	const st = self.repos.status();
	const cli = host.cli();
	const where = cli?.hostName ?? st?.host?.name ?? 'the host';
	const word = host.prWord;
	const ctx = host.pr();
	const changes = host.prChanges();
	const busy = host.prBusy();
	const created = host.prCreated();
	const existing = host.prExisting();
	const note = host.prNote();
	const error = host.prError();
	const drafting = busy === 'draft';
	const remote = st?.remote ?? 'the remote';
	const needsPush = !!ctx?.branch && (!ctx.onRemote || ctx.unpushed > 0);
	const bases = ctx ? [...new Set([host.prBase(), ...ctx.bases])].filter(Boolean).map((b) => ({ value: b, label: b })) : [];
	const body = host.prBody();
	const canWeb = !!st?.host && st.host.provider !== 'other' && !!ctx?.branch;

	return html`
		<ml-dialog #host-pr style="--ml-dialog-max-width: 700px" @ml:close=${() => host.closedPr()}>
			<h3 slot="dialog-header">${created ? `${word[0].toUpperCase()}${word.slice(1)} created` : `Create a ${word}`}</h3>
			<div class="dlg">
				${created
					? html`
						<div class="setup done">
							<ml-icon icon="check-circle" size="lg"></ml-icon>
							<b>#${created.id} ${created.title}</b>
							<p class="selectable link">${created.url}</p>
						</div>
					`
					: !ctx
						? html`<div class="setup">${error ? html`<p class="selectable">${error}</p>` : html`<ml-spinner size="md"></ml-spinner>`}</div>`
						: !ctx.branch
							? html`<div class="setup"><ml-icon icon="git-branch" size="lg"></ml-icon><b>Check out a branch first</b><p class="dim">A ${word} comes from a branch, and HEAD is detached.</p></div>`
							: html`
								<div class="route">
									<span class="branch" title=${ctx.branch}><ml-icon icon="git-branch" size="sm"></ml-icon>${ctx.branch}</span>
									<ml-icon icon="arrow-right" size="sm"></ml-icon>
									<ml-select size="sm" .options=${bases} .value=${host.prBase()} ?disabled=${!!busy} @ml:change=${(e: CustomEvent) => host.setPrBase(e.detail.value)}></ml-select>
									<span class="grow"></span>
									<span class="dim">${changes ? plural(changes.count, 'commit') : ''}</span>
								</div>

								${existing
									? html`<p class="note"><ml-icon icon="git-pull-request" size="sm"></ml-icon><span>A ${word} from this branch is already open: <b>#${existing.id} ${existing.title}</b></span><ml-button variant="outline" size="xs" @ml:click=${() => host.openUrl(existing.url)}>Open</ml-button></p>`
									: ''}
								${needsPush
									? html`<p class="note warn"><ml-icon icon="warning" size="sm"></ml-icon><span>${ctx.onRemote ? `${plural(ctx.unpushed, 'commit')} on ${ctx.branch} ${ctx.unpushed === 1 ? 'is' : 'are'} not on ${remote} yet.` : `${ctx.branch} is not on ${remote} yet.`} Push it before creating the ${word}.</span><ml-button variant="outline" size="xs" ?loading=${busy === 'push'} ?disabled=${!!busy && busy !== 'push'} @ml:click=${() => host.pushBranch()}>Push branch</ml-button></p>`
									: ''}
								${cli !== undefined && !host.ready()
									? html`<p class="note"><ml-icon icon="terminal-window" size="sm"></ml-icon><span class="selectable">${cli?.hint ? hintText(cli.hint) : 'No command-line tool covers this host.'} Until then, open the ${word} on ${where} and finish it there.</span>${cli?.tool ? html`<ml-button variant="outline" size="xs" ?loading=${host.cliLoading()} @ml:click=${() => host.recheck()}>Check again</ml-button>` : ''}</p>`
									: ''}
								${note ? html`<p class="note"><ml-icon icon="info" size="sm"></ml-icon><span class="selectable">${note}</span></p>` : ''}
								${error ? html`<p class="note bad"><ml-icon icon="warning-circle" size="sm"></ml-icon><span class="selectable">${hintText(error)}</span></p>` : ''}

								<ml-input label="Title" placeholder=${drafting ? 'Claude is writing…' : ''} .value=${host.prTitle()} ?disabled=${drafting} @ml:input=${(e: CustomEvent) => host.setPrTitle(e.detail.value)}></ml-input>
								<ml-textarea label="Description" rows="12" placeholder=${drafting ? 'Claude is writing…' : 'What changes, and why'} .value=${body} ?disabled=${drafting} @ml:input=${(e: CustomEvent) => host.setPrBody(e.detail.value)}></ml-textarea>
								<div class="under">
									<ml-button variant="outline" size="xs" ?loading=${drafting} ?disabled=${(!!busy && !drafting) || !changes?.count} @ml:click=${() => host.draft()}><ml-icon slot="icon-start" icon="sparkle"></ml-icon>${host.prTitle() || body ? 'Regenerate' : 'Draft with Claude'}</ml-button>
									<span class="dim">${drafting ? 'Claude is reading the commits and the diff stat…' : 'Drafted from the commits and the diff stat. Edit freely.'}</span>
									<span class="grow"></span>
									<ml-checkbox label="Draft" .checked=${host.prDraft()} @ml:change=${(e: CustomEvent) => host.prDraft.set(e.detail.checked)}></ml-checkbox>
								</div>
								${st?.host?.provider === 'azure' && body.length > AZURE_MAX_DESCRIPTION ? html`<p class="dim">Azure DevOps keeps the first ${AZURE_MAX_DESCRIPTION.toLocaleString()} characters of a description; this one has ${body.length.toLocaleString()}.</p>` : ''}
							`}
			</div>
			<div slot="dialog-footer" class="foot">
				${created
					? html`
						<span class="grow"></span>
						<ml-button variant="outline" @ml:click=${() => host.openUrl(created.url)}><ml-icon slot="icon-start" icon="arrow-square-out"></ml-icon>Open on ${where}</ml-button>
						<ml-button variant="primary" @ml:click=${() => host.close('host-pr')}>Done</ml-button>
					`
					: html`
						${ctx?.branch ? html`<ml-button variant="outline" ?disabled=${drafting || (!host.prTitle().trim() && !body.trim())} @ml:click=${() => host.copyPr()}><ml-icon slot="icon-start" icon="copy"></ml-icon>Copy</ml-button>` : ''}
						${canWeb ? html`<ml-button variant="outline" ?disabled=${needsPush || (!!busy && busy !== 'open')} ?loading=${busy === 'open'} @ml:click=${() => host.openPrOnWeb()}><ml-icon slot="icon-start" icon="arrow-square-out"></ml-icon>Open on ${where}</ml-button>` : ''}
						<span class="grow"></span>
						<ml-button variant="outline" @ml:click=${() => host.close('host-pr')}>Cancel</ml-button>
						<ml-button variant="primary" ?disabled=${!host.canCreate()} ?loading=${busy === 'create'} @ml:click=${() => host.createPr()}>Create ${word}</ml-button>
					`}
			</div>
		</ml-dialog>
	`;
}

export function hostDialogsTemplate(self: HostDialogsComponent) {
	return html`${issuesDialog(self)}${prDialog(self)}`;
}
