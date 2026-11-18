import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { AgentsStore, scopeOf, type AgentSession } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import { HostStore } from '../../services/host.store';
import { DialogService } from '@melodicdev/components/dialog';
import type { AgentMode } from '../../services/backend.service';
import { samePath } from '../../services/agent-paths';
import { AGENT_MODES } from './agents.component';
import { richText, richTextStyles, type RichOptions } from './rich-text';

type DialogId = Parameters<DialogService['close']>[0];

const TOOL_ICONS: Record<string, string> = { Read: 'file-text', Edit: 'pencil-simple', Write: 'file-plus', Bash: 'terminal-window', Grep: 'magnifying-glass', Glob: 'magnifying-glass', WebFetch: 'globe', WebSearch: 'globe', Task: 'robot', Agent: 'robot' };

/** Which references in a session's answers become links. They open in the checkout on screen, so a task's only count while its checkout is that one. */
function linking(self: AgentSessionComponent, s: AgentSession): RichOptions {
	const repo = self.repos.repo();
	const here = !!repo && repo.id === s.repoId && samePath(s.cwd, repo.worktree ?? repo.path);
	return { files: s.kind === 'ask' || here, commits: s.kind === 'ask' && scopeOf(s) === 'history', root: s.cwd };
}

/** The "into" choice that makes a new branch instead of picking one. */
const NEW_BRANCH = '\u0000new';

/** Where an agent's branch goes: a branch the user picks (or a new one), or a pull request for a protected one. */
function mergeDialog(self: AgentSessionComponent, s: AgentSession, uncommitted: number) {
	const trees = self.agents.worktrees();
	const main = trees.find((w) => w.isMain);
	const holderOf = (name: string) => trees.find((w) => w.branch === name);
	const locals = self.repos.branches().filter((b) => !b.isRemote && b.name !== s.branch);
	const options = [
		...locals.map((b) => {
			const holder = holderOf(b.name);
			return { value: b.name, label: holder ? `${b.name} (${holder.isMain ? 'main checkout' : 'in a worktree'})` : b.name };
		}),
		{ value: NEW_BRANCH, label: 'New branch…' },
	];
	const creating = self.into === NEW_BRANCH;
	const target = creating ? self.newName.trim() : self.into;
	const holder = creating ? null : holderOf(self.into);
	const blocked = !creating && !holder && !!main?.changes;
	const host = self.repos.status()?.host;
	const pr = host?.pulls ? host.pullsLabel.toLowerCase().replace(/s$/, '') : null;
	let where = '';
	if (creating) {
		where = target ? `Creates ${target} from ${self.newFrom} in the main checkout, which switches to it, then merges.` : '';
	} else if (holder?.isMain) {
		where = `Merges in the main checkout, which has ${self.into} checked out.`;
	} else if (holder) {
		where = `Merges in the worktree that has ${self.into} checked out.`;
	} else if (self.into) {
		where = `The main checkout switches from ${main?.branch ?? 'its current commit'} to ${self.into}, then merges.`;
	}
	return html`
		<ml-dialog #agent-merge style="--ml-dialog-max-width: 520px">
			<h3 slot="dialog-header">Merge ${s.branch ?? ''}</h3>
			<div class="dlg">
				<ml-select label="Into" .options=${options} .value=${self.into} @ml:change=${(e: CustomEvent) => (self.into = e.detail.value)}></ml-select>
				${creating
					? html`
						<ml-input label="New branch" .value=${self.newName} @ml:input=${(e: CustomEvent) => (self.newName = String(e.detail.value).replace(/\s+/g, '-'))}></ml-input>
						<ml-select label="Starting from" .options=${locals.map((b) => ({ value: b.name, label: b.name }))} .value=${self.newFrom} @ml:change=${(e: CustomEvent) => (self.newFrom = e.detail.value)}></ml-select>
					`
					: ''}
				${where ? html`<p class="hint">${where}</p>` : ''}
				${blocked ? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>The main checkout has uncommitted changes. Commit or stash them before it switches to ${self.into}.</span></p>` : ''}
				${uncommitted
					? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>The agent's worktree has ${uncommitted} uncommitted ${uncommitted === 1 ? 'change' : 'changes'}. Only committed work is merged: review and commit first.</span></p>`
					: ''}
				${pr ? html`<p class="hint">Branch protected? Push ${s.branch} and open a ${pr} instead.</p>` : ''}
			</div>
			<div slot="dialog-footer" class="foot">
				${pr ? html`<ml-button variant="outline" @ml:click=${() => self.openPr(s)}><ml-icon slot="icon-start" icon="git-pull-request"></ml-icon>Open a ${pr}…</ml-button>` : ''}
				<span class="grow"></span>
				<ml-button variant="outline" @ml:click=${() => self.closeMerge()}>Cancel</ml-button>
				<ml-button variant="primary" ?disabled=${!target || blocked || (creating && !self.newFrom)} ?loading=${self.repos.busy() === 'merge'} @ml:click=${() => self.merge(s)}>Merge</ml-button>
			</div>
		</ml-dialog>
	`;
}

/** Main pane of the Agents tab: one session's transcript and the box to send it more, a new question, or a comparison of attempts. */
@MelodicComponent({
	selector: 'ms-agent-session',
	template: (self: AgentSessionComponent) => {
		const agents = self.agents;
		const cli = agents.cli();
		if (agents.asking()) {
			return html`<ms-ask></ms-ask>`;
		}
		const group = agents.comparing();
		if (group && agents.current().some((x) => x.group === group)) {
			return html`<ms-attempts></ms-attempts>`;
		}
		const s = agents.selected();
		if (!s) {
			return html`
				<div class="empty">
					<ml-icon icon="robot" size="xl"></ml-icon>
					<h2>Agents</h2>
					<p>Hand a task to Claude Code. Each agent gets its own worktree and branch, so several can work at once while your checkout stays as you left it. When one finishes, review its diff like any other change, then merge it.</p>
					<p>Or just ask: a read-only chat answers questions about the code and its history, with links straight to the files and commits it mentions.</p>
					<div class="starts">
						<ml-button variant="outline" size="sm" ?disabled=${cli === null} @ml:click=${() => agents.openAsk('code')}><ml-icon slot="icon-start" icon="chat-circle-dots"></ml-icon>Ask about the code</ml-button>
						<ml-button variant="outline" size="sm" ?disabled=${cli === null} @ml:click=${() => agents.openAsk('history')}><ml-icon slot="icon-start" icon="clock-counter-clockwise"></ml-icon>Ask about its history</ml-button>
					</div>
					${cli === null ? html`<p class="bad">The <b>claude</b> command was not found. Install Claude Code, then restart Melodic Studio.</p>` : cli ? html`<p class="dim">Using Claude Code ${cli}</p>` : ''}
				</div>
			`;
		}
		const running = s.status === 'running';
		const ask = s.kind === 'ask';
		const tree = agents.worktrees().find((w) => samePath(w.path, s.cwd));
		const mainBranch = agents.worktrees().find((w) => w.isMain)?.branch;
		const links = linking(self, s);
		const follow = self.follow;
		return html`
			<div class="head">
				<div class="grow">
					<h2>${s.title}</h2>
					<div class="meta">
						${ask
							? html`<span title=${`It can use: ${(s.tools ?? []).join(', ')}`}><ml-icon icon="lock-simple" size="sm"></ml-icon>Read-only${scopeOf(s) === 'history' ? ', with git history' : ''}</span>`
							: ''}
						<span><ml-icon icon="git-branch" size="sm"></ml-icon>${s.branch ?? 'detached'}</span>
						${ask ? '' : s.isolated ? html`<span title=${s.cwd}><ml-icon icon="tree-structure" size="sm"></ml-icon>own worktree</span>` : html`<span><ml-icon icon="house" size="sm"></ml-icon>main checkout</span>`}
						${s.group ? html`<span>Attempt ${s.attempt}</span>` : ''}
						${!ask && tree?.changes ? html`<span><ml-icon icon="files" size="sm"></ml-icon>${tree.changes} uncommitted</span>` : ''}
						${s.cost ? html`<span>$${s.cost.toFixed(2)}</span>` : ''}
					</div>
				</div>
				${s.group ? html`<ml-button variant="outline" size="sm" @ml:click=${() => agents.compare(s.group!)}><ml-icon slot="icon-start" icon="columns"></ml-icon>Compare attempts</ml-button>` : ''}
				${ask
					? html`<ml-button variant="outline" size="sm" @ml:click=${() => agents.openAsk(scopeOf(s))}><ml-icon slot="icon-start" icon="plus"></ml-icon>New question</ml-button>`
					: html`<ml-button variant="outline" size="sm" ?disabled=${running} @ml:click=${() => agents.review(s)}><ml-icon slot="icon-start" icon="git-diff"></ml-icon>Review changes</ml-button>`}
				${!ask && s.isolated && s.branch && s.branch !== mainBranch
					? html`<ml-button variant="outline" size="sm" ?disabled=${running || !!self.repos.busy()} title=${`Merge ${s.branch} into a branch you choose, or open a pull request. Commit the agent's work first.`} @ml:click=${() => self.openMerge(s)}><ml-icon slot="icon-start" icon="git-merge"></ml-icon>Merge…</ml-button>`
					: ''}
			</div>
			${mergeDialog(self, s, tree?.changes ?? 0)}

			<div class="log">
				${s.items.map((item) =>
					item.kind === 'tool'
						? html`<div class="tool"><ml-icon icon=${TOOL_ICONS[item.text] ?? 'wrench'} size="sm"></ml-icon><b>${item.text}</b><span>${item.detail ?? ''}</span></div>`
						: item.kind === 'text'
							? html`<div class="msg text">${richText(item.text, links, follow)}</div>`
							: html`<div class="msg ${item.kind}">${item.text}</div>`
				)}
				${running ? html`<div class="working"><ml-spinner size="sm"></ml-spinner>${ask ? 'Reading…' : 'Working…'}</div>` : ''}
			</div>

			<div class="composer" @keydown=${self.keydown}>
				<ml-textarea rows="3" placeholder=${running ? (ask ? 'Looking for the answer…' : 'The agent is working…') : ask ? 'Ask a follow-up question' : 'Ask for a change, a fix, or an explanation'} .value=${self.draft} @ml:input=${(e: CustomEvent) => (self.draft = e.detail.value)}></ml-textarea>
				<div class="row">
					${ask
						? html`<span class="note"><ml-icon icon="lock-simple" size="sm"></ml-icon>Read-only: it can search and read${scopeOf(s) === 'history' ? ' the files and the git history' : ' the files'}, and change nothing.</span>`
						: html`<ml-select size="sm" .options=${AGENT_MODES} .value=${s.mode} ?disabled=${running} @ml:change=${(e: CustomEvent) => agents.setMode(s.id, e.detail.value as AgentMode)}></ml-select>`}
					<span class="grow"></span>
					${running
						? html`<ml-button variant="danger" size="sm" @ml:click=${() => agents.stop(s.id)}>Stop</ml-button>`
						: html`<ml-button variant="primary" size="sm" ?disabled=${!self.draft.trim()} @ml:click=${() => self.send()}>${ask ? 'Ask' : 'Send'}</ml-button>`}
				</div>
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
			flex: 1;
			min-height: 0;
		}
		ms-ask,
		ms-attempts {
			flex: 1;
			min-height: 0;
		}
		.grow {
			flex: 1;
			min-width: 0;
		}
		.empty {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 10px;
			padding: 32px;
			text-align: center;
		}
		.empty > ml-icon {
			color: var(--ml-color-primary);
		}
		.empty h2 {
			margin: 0;
			font-size: 20px;
			font-weight: 600;
		}
		.empty p {
			margin: 0;
			max-width: 480px;
			color: var(--ml-color-text-muted);
		}
		.empty .bad {
			color: var(--ml-color-danger);
		}
		.empty .dim {
			font-size: 12px;
		}
		.starts {
			display: flex;
			flex-wrap: wrap;
			justify-content: center;
			gap: 8px;
			margin: 6px 0;
		}
		.head {
			flex: none;
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 12px 16px;
			border-bottom: 1px solid var(--ml-color-border);
		}
		.head h2 {
			margin: 0;
			font-size: 15px;
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.meta {
			display: flex;
			flex-wrap: wrap;
			gap: 4px 14px;
			margin-top: 4px;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.meta span {
			display: inline-flex;
			align-items: center;
			gap: 5px;
		}
		.log {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			display: flex;
			flex-direction: column;
			gap: 8px;
			padding: 16px;
			user-select: text;
			-webkit-user-select: text;
		}
		.msg {
			max-width: 760px;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			line-height: 1.55;
		}
		/* What the agent wrote is laid out by its own markup, not by its line breaks. */
		.msg.text {
			width: 100%;
			white-space: normal;
		}
		${richTextStyles}
		.msg.user {
			align-self: flex-end;
			padding: 8px 12px;
			border-radius: 10px;
			background: var(--ml-color-primary-subtle);
		}
		.msg.error {
			padding: 8px 12px;
			border-radius: 8px;
			background: var(--ms-diff-del-bg);
			color: var(--ms-del);
		}
		.tool {
			display: flex;
			align-items: center;
			gap: 7px;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.tool ml-icon {
			flex: none;
		}
		.tool b {
			flex: none;
			font-weight: 600;
			color: var(--ml-color-text-secondary);
		}
		.tool span {
			min-width: 0;
			font-family: var(--ml-font-mono);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.working {
			display: flex;
			align-items: center;
			gap: 8px;
			color: var(--ml-color-text-muted);
		}
		.composer {
			flex: none;
			display: flex;
			flex-direction: column;
			gap: 8px;
			padding: 12px 16px;
			border-top: 1px solid var(--ml-color-border);
		}
		.row {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.row ml-select {
			width: 320px;
		}
		.note {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		h3 {
			margin: 0;
			font-size: 16px;
			font-weight: 600;
		}
		.dlg {
			display: flex;
			flex-direction: column;
			gap: 14px;
			color: var(--ml-color-text-secondary);
		}
		.dlg p {
			margin: 0;
			line-height: 1.5;
		}
		.dlg .hint {
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.warn {
			display: flex;
			gap: 8px;
			padding: 9px 11px;
			border-radius: 8px;
			background: var(--ml-color-warning-subtle);
			color: var(--ml-color-text);
		}
		.warn ml-icon {
			flex: none;
			margin-top: 1px;
			color: var(--ml-color-warning);
		}
		.foot {
			display: flex;
			align-items: center;
			gap: 8px;
			width: 100%;
		}
	`,
})
export class AgentSessionComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	@Service(HostStore) readonly host!: HostStore;
	@Service(DialogService) private readonly _dialogs!: DialogService;
	elementRef!: HTMLElement;

	draft = '';
	/** Merge dialog: the branch picked (or NEW_BRANCH), and the new branch's name and starting point. */
	into = '';
	newName = '';
	newFrom = '';
	private _seen = 0;
	private _shown: string | null = null;

	/** Keep the newest message in view as the transcript grows, and count what is on screen as read. */
	onRender(): void {
		const agents = this.agents;
		const s = agents.asking() || agents.comparing() ? null : agents.selected();
		const count = s?.items.length ?? 0;
		if (count !== this._seen || (s?.id ?? null) !== this._shown) {
			this._seen = count;
			this._shown = s?.id ?? null;
			const log = this.elementRef.shadowRoot?.querySelector('.log');
			if (log) {
				log.scrollTop = log.scrollHeight;
			}
		}
		if (s?.unread && document.visibilityState === 'visible') {
			const id = s.id;
			queueMicrotask(() => agents.seen(id));
		}
	}

	/** A link in an answer was clicked. */
	readonly follow = (ref: Parameters<AgentsStore['follow']>[1]): void => {
		const s = this.agents.selected();
		if (s) {
			void this.agents.follow(s, ref);
		}
	};

	async openMerge(s: AgentSession): Promise<void> {
		await Promise.all([this.repos.loadBranches(), this.agents.loadWorktrees()]);
		const main = this.agents.worktrees().find((w) => w.isMain)?.branch ?? '';
		const tail = (s.branch ?? '').split('/').pop() ?? '';
		this.into = main && main !== s.branch ? main : NEW_BRANCH;
		this.newName = tail ? `feature/${tail}` : '';
		this.newFrom = main || (this.repos.branches().find((b) => !b.isRemote && b.name !== s.branch)?.name ?? '');
		this._dialogs.open('agent-merge' as DialogId);
	}

	closeMerge(): void {
		this._dialogs.close('agent-merge' as DialogId);
	}

	async merge(s: AgentSession): Promise<void> {
		const creating = this.into === NEW_BRANCH;
		const into = creating ? this.newName.trim() : this.into;
		if (await this.agents.merge(s, into, creating ? this.newFrom : null)) {
			this.closeMerge();
		}
	}

	/** A pull request is made from the checkout on screen, so the agent's worktree becomes it first. */
	async openPr(s: AgentSession): Promise<void> {
		this.closeMerge();
		await this.agents.view(s.cwd, 'changes');
		this.host.openPr();
	}

	send(): void {
		const s = this.agents.selected();
		if (s && this.draft.trim()) {
			void this.agents.send(s.id, this.draft);
			this.draft = '';
		}
	}

	/** Cmd/Ctrl+Enter sends. */
	readonly keydown = (e: KeyboardEvent): void => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			this.send();
		}
	};
}
