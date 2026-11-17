import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { DialogService } from '@melodicdev/components/dialog';
import { AgentsStore, branchFor, type AgentSession } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import type { AgentMode, Worktree } from '../../services/backend.service';
import { fileName, plural, relativeTime } from '../../shared/format';

type DialogId = Parameters<DialogService['close']>[0];

export const AGENT_MODES = [
	{ value: 'acceptEdits', label: 'Edit files (asks nothing, cannot run commands it is not allowed)' },
	{ value: 'plan', label: 'Plan only (reads, changes nothing)' },
	{ value: 'bypassPermissions', label: 'Full auto (runs any command without asking)' },
];

/** Sidebar "Agents" tab: sessions for this repository, its worktrees, and the dialogs for both. */
@MelodicComponent({
	selector: 'ms-agents',
	template: (self: AgentsComponent) => {
		const agents = self.agents;
		const sessions = agents.current();
		const selected = agents.selectedId();
		const trees = agents.worktrees();
		const doomed = self.doomed;
		return html`
			<div class="head">
				<span class="grow">${plural(sessions.length, 'agent')}</span>
				<ml-button variant="primary" size="xs" ?disabled=${agents.cli() === null} @ml:click=${() => self.openNew()}><ml-icon slot="icon-start" icon="plus"></ml-icon>New task</ml-button>
			</div>
			<div class="list">
				${sessions.length === 0 ? html`<div class="none">No agents yet. Give one a task and it works on its own branch while you carry on.</div>` : ''}
				${sessions.map(
					(s) => html`
						<div class="session ${s.id === selected ? 'sel' : ''}" @click=${() => agents.selectedId.set(s.id)}>
							<div class="top">
								${s.status === 'running' ? html`<ml-spinner size="xs"></ml-spinner>` : html`<span class="dot ${s.status}"></span>`}
								<span class="title">${s.title}</span>
								<button class="x" title="Remove agent…" @click=${(e: Event) => (e.stopPropagation(), self.askRemove(s))}><ml-icon icon="x" size="xs"></ml-icon></button>
							</div>
							<div class="meta"><ml-icon icon="git-branch" size="xs"></ml-icon><span class="branch">${s.branch ?? 'detached'}</span><span>${relativeTime(s.updated)}</span></div>
						</div>
					`
				)}

				${trees.length > 1
					? html`
						<div class="group">Worktrees</div>
						${trees.map(
							(w) => html`
								<div class="tree ${w.active ? 'on' : ''}" title=${w.path} @click=${() => agents.view(w.isMain ? null : w.path, 'agents')}>
									<ml-icon icon=${w.active ? 'check' : w.isMain ? 'house' : 'tree-structure'} size="sm"></ml-icon>
									<span class="title">${w.branch ?? fileName(w.path)}${w.isMain ? html`<span class="dim"> · main checkout</span>` : ''}</span>
									${w.changes ? html`<span class="count">${w.changes}</span>` : ''}
									${w.isMain ? '' : html`<button class="x" title="Remove worktree…" @click=${(e: Event) => (e.stopPropagation(), self.askRemoveTree(w))}><ml-icon icon="trash" size="xs"></ml-icon></button>`}
								</div>
							`
						)}
					`
					: ''}
			</div>

			<ml-dialog #new-agent style="--ml-dialog-max-width: 540px">
				<h3 slot="dialog-header">New agent task</h3>
				<div class="dlg">
					<ml-textarea label="Task" rows="5" placeholder="Describe what you want done. Be as specific as you would be with a colleague." .value=${self.task} @ml:input=${(e: CustomEvent) => self.setTask(e.detail.value)}></ml-textarea>
					<ml-checkbox label="Work in a separate worktree on a new branch" hint="Recommended: the agent cannot disturb your checkout, and several can run at once." .checked=${self.isolate} @ml:change=${(e: CustomEvent) => (self.isolate = e.detail.checked)}></ml-checkbox>
					${self.isolate
						? html`<ml-input label="Branch" hint=${`Starts from ${self.repos.status()?.branch ?? 'the current commit'}`} .value=${self.branch} @ml:input=${(e: CustomEvent) => self.setBranch(e.detail.value)}></ml-input>`
						: html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>The agent will edit the checkout you are looking at, alongside your own uncommitted changes.</span></p>`}
					<ml-select label="Permissions" .options=${AGENT_MODES} .value=${self.mode} @ml:change=${(e: CustomEvent) => (self.mode = e.detail.value as AgentMode)}></ml-select>
					${self.mode === 'bypassPermissions' ? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>Full auto lets the agent run any shell command on this computer, not just inside its worktree.</span></p>` : ''}
				</div>
				<div slot="dialog-footer" class="foot">
					<ml-button variant="outline" @ml:click=${() => self.close('new-agent')}>Cancel</ml-button>
					<ml-button variant="primary" ?disabled=${!self.task.trim() || (self.isolate && !self.branch)} ?loading=${agents.busy()} @ml:click=${() => self.start()}>Start agent</ml-button>
				</div>
			</ml-dialog>

			<ml-dialog #remove-agent style="--ml-dialog-max-width: 460px">
				<h3 slot="dialog-header">${doomed?.session ? 'Remove agent' : 'Remove worktree'}</h3>
				<div class="dlg">
					${doomed?.session
						? html`
							<p>Remove <b>${doomed.session.title}</b> and its conversation?</p>
							${doomed.session.isolated
								? html`<ml-checkbox label=${`Also delete its worktree and the branch ${doomed.session.branch ?? ''}`} hint="Uncommitted and unmerged work on that branch is lost." .checked=${self.alsoTree} @ml:change=${(e: CustomEvent) => (self.alsoTree = e.detail.checked)}></ml-checkbox>`
								: ''}
						`
						: html`<p>Delete the worktree for <b>${doomed?.tree?.branch ?? ''}</b> and the branch itself? Uncommitted and unmerged work on it is lost.</p>`}
				</div>
				<div slot="dialog-footer" class="foot">
					<ml-button variant="outline" @ml:click=${() => self.close('remove-agent')}>Cancel</ml-button>
					<ml-button variant="danger" @ml:click=${() => self.confirmRemove()}>Remove</ml-button>
				</div>
			</ml-dialog>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
			flex: 1;
			min-height: 0;
		}
		.grow {
			flex: 1;
			min-width: 0;
		}
		.head {
			flex: none;
			display: flex;
			align-items: center;
			gap: 8px;
			height: 34px;
			padding: 0 8px 0 10px;
			border-bottom: 1px solid var(--ml-color-border);
			color: var(--ml-color-text-secondary);
			font-weight: 500;
		}
		.list {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
		}
		.none {
			padding: 22px 16px;
			text-align: center;
			color: var(--ml-color-text-muted);
		}
		.session,
		.tree {
			padding: 7px 8px 7px 12px;
			border-bottom: 1px solid var(--ml-color-border-muted);
		}
		.session:hover,
		.tree:hover {
			background: var(--ms-hover);
		}
		.session.sel {
			background: var(--ms-selected);
			color: var(--ms-selected-fg);
		}
		.top,
		.tree {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.title {
			flex: 1;
			min-width: 0;
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.tree .title {
			font-weight: 400;
		}
		.tree.on .title {
			font-weight: 600;
		}
		.tree > ml-icon {
			flex: none;
			color: var(--ml-color-text-muted);
		}
		.tree.on > ml-icon {
			color: var(--ml-color-primary);
		}
		.dim {
			font-weight: 400;
			color: var(--ml-color-text-muted);
		}
		.dot {
			flex: none;
			width: 8px;
			height: 8px;
			margin: 0 4px;
			border-radius: 50%;
			background: var(--ms-add);
		}
		.dot.failed {
			background: var(--ms-del);
		}
		.meta {
			display: flex;
			align-items: center;
			gap: 5px;
			margin-top: 2px;
			padding-left: 24px;
			font-size: 11px;
			color: var(--ml-color-text-muted);
		}
		.sel .meta {
			color: inherit;
			opacity: 0.75;
		}
		.branch {
			flex: 1;
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.x {
			all: unset;
			flex: none;
			display: grid;
			place-items: center;
			width: 20px;
			height: 20px;
			border-radius: 4px;
			color: var(--ml-color-text-muted);
			visibility: hidden;
		}
		.session:hover .x,
		.tree:hover .x {
			visibility: visible;
		}
		.x:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
		.group {
			padding: 14px 12px 5px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
			border-bottom: 1px solid var(--ml-color-border-muted);
		}
		.count {
			flex: none;
			padding: 0 7px;
			border-radius: 999px;
			background: var(--ml-color-primary-subtle);
			color: var(--ml-color-primary);
			font-size: 11px;
			font-weight: 600;
			line-height: 17px;
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
		.dlg b {
			color: var(--ml-color-text);
			font-weight: 600;
			overflow-wrap: anywhere;
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
			justify-content: flex-end;
			gap: 8px;
			width: 100%;
		}
	`,
})
export class AgentsComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	@Service(DialogService) private readonly _dialogs!: DialogService;

	task = '';
	branch = '';
	isolate = true;
	mode: AgentMode = 'acceptEdits';
	/** What the remove dialog is about. */
	doomed: { session?: AgentSession; tree?: Worktree } | null = null;
	alsoTree = false;
	/** The branch field follows the task text until it is edited by hand. */
	private _branchTouched = false;

	onCreate(): void {
		void this.agents.init();
	}

	close(id: string): void {
		this._dialogs.close(id as DialogId);
	}

	openNew(): void {
		this.task = '';
		this.branch = '';
		this._branchTouched = false;
		this._dialogs.open('new-agent' as DialogId);
	}

	setTask(value: string): void {
		this.task = value;
		if (!this._branchTouched) {
			this.branch = branchFor(value);
		}
	}

	setBranch(value: string): void {
		this._branchTouched = true;
		this.branch = value.replace(/\s+/g, '-');
	}

	async start(): Promise<void> {
		if (await this.agents.start({ task: this.task, branch: this.isolate ? this.branch : '', mode: this.mode })) {
			this.close('new-agent');
		}
	}

	askRemove(session: AgentSession): void {
		this.doomed = { session };
		this.alsoTree = false;
		this._dialogs.open('remove-agent' as DialogId);
	}

	askRemoveTree(tree: Worktree): void {
		this.doomed = { tree };
		this._dialogs.open('remove-agent' as DialogId);
	}

	async confirmRemove(): Promise<void> {
		const doomed = this.doomed;
		this.close('remove-agent');
		if (doomed?.session) {
			await this.agents.remove(doomed.session, this.alsoTree);
		} else if (doomed?.tree) {
			await this.agents.removeWorktree(doomed.tree.path, true);
		}
	}
}
