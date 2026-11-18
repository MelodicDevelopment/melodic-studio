import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css, repeat } from '@melodicdev/core/template';
import { DialogService } from '@melodicdev/components/dialog';
import { AgentsStore, MAX_ATTEMPTS, STATE_LABELS, attemptBranch, branchFor, scopeOf, stateOf, type AgentSession } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import { HostStore } from '../../services/host.store';
import type { AgentMode, ClaudeSession, Worktree } from '../../services/backend.service';
import { fileName, plural, relativeTime } from '../../shared/format';
import { workspace, type Conversation } from '../../services/workspace.store';
import { CONV_STATE_LABELS } from '../workspace/conversation-state';
import { convAgentState } from './agent-state';

type DialogId = Parameters<DialogService['close']>[0];

export const AGENT_MODES = [
	{ value: 'acceptEdits', label: 'Edit files (asks nothing, cannot run commands it is not allowed)' },
	{ value: 'plan', label: 'Plan only (reads, changes nothing)' },
	{ value: 'bypassPermissions', label: 'Full auto (runs any command without asking)' },
];

/** Sessions in list order, with the attempts of one group kept together where the newest of them falls. */
function grouped(sessions: AgentSession[]): { group: string | null; sessions: AgentSession[] }[] {
	const out: { group: string | null; sessions: AgentSession[] }[] = [];
	const seen = new Set<string>();
	for (const s of sessions) {
		if (!s.group) {
			out.push({ group: null, sessions: [s] });
		} else if (!seen.has(s.group)) {
			seen.add(s.group);
			out.push({ group: s.group, sessions: sessions.filter((x) => x.group === s.group).sort((a, b) => a.attempt - b.attempt) });
		}
	}
	return out;
}

function sessionRow(self: AgentsComponent, s: AgentSession, nested: boolean) {
	const agents = self.agents;
	const state = stateOf(s);
	const on = s.id === agents.selectedId() && !agents.comparing() && !agents.asking();
	return html`
		<div class="session ${on ? 'sel' : ''} ${nested ? 'nested' : ''} ${s.unread ? 'unread' : ''}" @click=${() => agents.select(s.id)}>
			<div class="top">
				${s.status === 'running' ? html`<ml-spinner size="xs"></ml-spinner>` : html`<span class="dot ${state}" title=${STATE_LABELS[state]}></span>`}
				<span class="title">${nested ? `Attempt ${s.attempt}` : s.title}</span>
				${s.unread ? html`<span class="new" title="Finished since you last looked"></span>` : ''}
				<button class="x" title="Remove agent…" @click=${(e: Event) => (e.stopPropagation(), self.askRemove(s))}><ml-icon icon="x" size="xs"></ml-icon></button>
			</div>
			<div class="meta">
				${s.kind === 'ask'
					? html`<ml-icon icon="chat-circle-dots" size="xs"></ml-icon><span class="branch">${scopeOf(s) === 'history' ? 'Question about history' : 'Question about the code'}</span>`
					: html`<ml-icon icon="git-branch" size="xs"></ml-icon><span class="branch">${s.branch ?? 'detached'}</span>`}
				<span>${relativeTime(s.updated)}</span>
			</div>
		</div>
	`;
}

/** A Claude conversation of the workspace: clicking it shows its tab there. */
function convRow(c: Conversation) {
	const state = convAgentState(c);
	return html`
		<div class="session ${c.unread ? 'unread' : ''}" title="Show this conversation in the Claude workspace" @click=${() => workspace().open(c.id)}>
			<div class="top">
				${state === 'working' ? html`<ml-spinner size="xs"></ml-spinner>` : html`<span class="dot ${state}" title=${CONV_STATE_LABELS[c.state]}></span>`}
				<span class="title">${c.title}</span>
				${c.unread ? html`<span class="new" title="Something happened since you last looked"></span>` : ''}
			</div>
			<div class="meta">
				<ml-icon icon="sparkle" size="xs"></ml-icon><span class="branch">${c.state === 'waiting' ? 'Needs you' : (c.branch ?? CONV_STATE_LABELS[c.state])}</span>
				<span>${relativeTime(c.updated)}</span>
			</div>
		</div>
	`;
}

/** Outside sessions shown before "Show more". */
const ELSEWHERE_SHOWN = 8;
/** A transcript that changed this recently may belong to a session still open in a terminal. */
const RECENT_MS = 10 * 60_000;

/** A Claude Code session started outside the app: clicking it adds it to the workspace, ready to resume. */
function elsewhereRow(repoId: string, s: ClaudeSession) {
	const recent = Date.now() - s.modified < RECENT_MS;
	return html`
		<div class="session" title=${`${s.prompt}\n\nStarted outside Melodic Studio. Click to continue it in the Claude workspace.`} @click=${() => workspace().adopt(repoId, s)}>
			<div class="top">
				<ml-icon class="lead" icon="terminal-window" size="xs"></ml-icon>
				<span class="title">${s.title ?? s.prompt}</span>
				${recent ? html`<span class="live" title="Its transcript changed in the last few minutes: it may still be open in a terminal">active</span>` : ''}
			</div>
			<div class="meta">
				<ml-icon icon="git-branch" size="xs"></ml-icon><span class="branch">${s.branch ?? 'In a terminal'}</span>
				<span>${relativeTime(s.modified)}</span>
			</div>
		</div>
	`;
}

/** Sidebar "Agents" tab: sessions for this repository, its worktrees, and the dialogs for both. */
@MelodicComponent({
	selector: 'ms-agents',
	template: (self: AgentsComponent) => {
		const agents = self.agents;
		const sessions = agents.current();
		const repoId = self.repos.repo()?.id;
		const convs = workspace()
			.conversations()
			.filter((c) => c.kind === 'claude' && c.repoId === repoId)
			.sort((a, b) => b.updated - a.updated);
		if (repoId && !(repoId in workspace().elsewhere())) {
			// First look at this repository (the tab outlives a repository switch): read its sessions now, not at the next poll.
			queueMicrotask(() => void workspace().loadElsewhere(repoId));
		}
		const elsewhere = repoId ? workspace().elsewhereIn(repoId) : [];
		const shownElsewhere = self.allElsewhere ? elsewhere : elsewhere.slice(0, ELSEWHERE_SHOWN);
		const comparing = agents.comparing();
		const trees = agents.worktrees();
		const doomed = self.doomed;
		return html`
			<div class="head">
				<span class="grow">${plural(sessions.length, 'agent')}</span>
				${self.repos.status()?.host?.issues ? html`<ml-button variant="outline" size="xs" title="Start an agent on an issue from the host" @ml:click=${() => self.host.openIssues()}><ml-icon slot="icon-start" icon="list-checks"></ml-icon>${self.repos.status()?.host?.issuesLabel ?? 'Issues'}</ml-button>` : ''}
				<ml-button variant="primary" size="xs" ?disabled=${agents.cli() === null} @ml:click=${() => self.openNew()}><ml-icon slot="icon-start" icon="plus"></ml-icon>New task</ml-button>
			</div>
			<div class="list">
				<div class="askrow ${agents.asking() ? 'sel' : ''}" title="A read-only chat about the code: nothing is changed" @click=${() => agents.openAsk('code')}>
					<ml-icon icon="chat-circle-dots" size="sm"></ml-icon><span class="title">Ask about this repository…</span>
				</div>
				${sessions.length === 0 ? html`<div class="none">No agents yet. Give one a task and it works on its own branch while you carry on.</div>` : ''}
				${repeat(
					grouped(sessions),
					(g) => g.group ?? g.sessions[0].id,
					(g) =>
						g.group
							? html`
							<div class="attempts ${comparing === g.group ? 'sel' : ''}" title="Compare the attempts side by side" @click=${() => agents.compare(g.group!)}>
								<ml-icon icon="columns" size="sm"></ml-icon>
								<span class="title">${g.sessions[0].title}</span>
								<span class="count">${g.sessions.length} attempts</span>
							</div>
							${repeat(
								g.sessions,
								(s) => s.id,
								(s) => sessionRow(self, s, true)
							)}
						`
							: sessionRow(self, g.sessions[0], false)
				)}

				${convs.length || elsewhere.length
					? html`
						<div class="group">Claude conversations</div>
						${repeat(
							convs,
							(c) => c.id,
							(c) => convRow(c)
						)}
						${repeat(
							shownElsewhere,
							(s) => s.id,
							(s) => elsewhereRow(repoId!, s)
						)}
						${elsewhere.length > shownElsewhere.length
							? html`<div class="more" @click=${() => (self.allElsewhere = true)}>Show ${elsewhere.length - shownElsewhere.length} more from the terminal</div>`
							: ''}
					`
					: ''}

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
					${self.isolate
						? html`
							<div class="pick">
								<span class="lbl">Attempts</span>
								<div class="seg">
									${Array.from({ length: MAX_ATTEMPTS }, (_, i) => i + 1).map((n) => html`<button class=${n === self.attempts ? 'on' : ''} @click=${() => (self.attempts = n)}>${n}</button>`)}
								</div>
								<span class="hint">
									${self.attempts > 1
										? `The same task runs ${self.attempts} times at once, on ${Array.from({ length: self.attempts }, (_, i) => attemptBranch(self.branch || 'branch', i + 1)).join(', ')}. Compare the results side by side and keep the best.`
										: 'Run the task more than once to compare different results.'}
								</span>
							</div>
						`
						: ''}
					<ml-select label="Permissions" .options=${AGENT_MODES} .value=${self.mode} @ml:change=${(e: CustomEvent) => (self.mode = e.detail.value as AgentMode)}></ml-select>
					${self.mode === 'bypassPermissions' ? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>Full auto lets the agent run any shell command on this computer, not just inside its worktree.</span></p>` : ''}
				</div>
				<div slot="dialog-footer" class="foot">
					<ml-button variant="outline" @ml:click=${() => self.close('new-agent')}>Cancel</ml-button>
					<ml-button variant="primary" ?disabled=${!self.task.trim() || (self.isolate && !self.branch)} ?loading=${agents.busy()} @ml:click=${() => self.start()}>${self.isolate && self.attempts > 1 ? `Start ${self.attempts} agents` : 'Start agent'}</ml-button>
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
		/* ---- asking, and groups of parallel attempts ---- */
		.askrow,
		.attempts {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 7px 8px 7px 12px;
			border-bottom: 1px solid var(--ml-color-border-muted);
		}
		.askrow {
			color: var(--ml-color-text-secondary);
		}
		.askrow .title {
			font-weight: 400;
		}
		.askrow > ml-icon,
		.attempts > ml-icon {
			flex: none;
			color: var(--ml-color-primary);
		}
		.askrow:hover,
		.attempts:hover {
			background: var(--ms-hover);
		}
		.askrow.sel,
		.attempts.sel {
			background: var(--ms-selected);
			color: var(--ms-selected-fg);
		}
		.session.nested {
			padding-left: 30px;
		}
		.session.unread .title {
			font-weight: 700;
		}
		.new {
			flex: none;
			width: 7px;
			height: 7px;
			border-radius: 50%;
			background: var(--ml-color-primary);
		}
		.session:hover .new {
			display: none;
		}
		.lead {
			flex: none;
			margin: 0 1px;
			color: var(--ml-color-text-muted);
		}
		.live {
			flex: none;
			padding: 0 6px;
			border-radius: 999px;
			font-size: 10px;
			font-weight: 600;
			line-height: 16px;
			color: var(--ms-run-text);
			background: color-mix(in srgb, var(--ms-run) 14%, transparent);
		}
		.more {
			padding: 7px 12px;
			font-size: 12px;
			color: var(--ml-color-text-link);
			cursor: pointer;
			border-bottom: 1px solid var(--ml-color-border-muted);
		}
		.more:hover {
			background: var(--ms-hover);
		}
		.dot.review {
			background: var(--ms-mod);
		}
		.dot.stopped {
			background: var(--ml-color-text-muted);
		}
		.pick {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 6px 12px;
		}
		.lbl {
			font-weight: 500;
			color: var(--ml-color-text);
		}
		.seg {
			display: inline-flex;
			border: 1px solid var(--ml-color-border);
			border-radius: 7px;
			overflow: hidden;
		}
		.seg button {
			all: unset;
			min-width: 34px;
			padding: 4px 0;
			text-align: center;
			color: var(--ml-color-text-secondary);
		}
		.seg button + button {
			border-left: 1px solid var(--ml-color-border);
		}
		.seg button:hover {
			background: var(--ms-hover);
		}
		.seg button.on {
			background: var(--ml-color-primary);
			color: var(--ml-color-text-inverse);
			font-weight: 600;
		}
		.seg button:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: -2px;
		}
		.hint {
			flex: 1 1 100%;
			font-size: 12px;
			color: var(--ml-color-text-muted);
			overflow-wrap: anywhere;
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
	@Service(HostStore) readonly host!: HostStore;
	@Service(DialogService) private readonly _dialogs!: DialogService;

	task = '';
	branch = '';
	isolate = true;
	mode: AgentMode = 'acceptEdits';
	/** How many times to run the task in parallel, each in its own worktree. */
	attempts = 1;
	/** What the remove dialog is about. */
	doomed: { session?: AgentSession; tree?: Worktree } | null = null;
	alsoTree = false;
	/** The branch field follows the task text until it is edited by hand. */
	private _branchTouched = false;

	/** Every outside session, not just the newest few. */
	allElsewhere = false;
	private _poll: ReturnType<typeof setInterval> | null = null;
	private readonly _refresh = (): void => {
		const id = this.repos.repo()?.id;
		if (id && !document.hidden) {
			void workspace().loadElsewhere(id);
		}
	};

	onCreate(): void {
		void this.agents.init();
		// Sessions started in a terminal come and go without telling us: look again now and then, and on focus.
		this._refresh();
		this._poll = setInterval(this._refresh, 20_000);
		window.addEventListener('focus', this._refresh);
	}

	onDestroy(): void {
		if (this._poll) {
			clearInterval(this._poll);
		}
		window.removeEventListener('focus', this._refresh);
	}

	close(id: string): void {
		this._dialogs.close(id as DialogId);
	}

	openNew(): void {
		this.task = '';
		this.branch = '';
		this.attempts = 1;
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
		if (await this.agents.start({ task: this.task, branch: this.isolate ? this.branch : '', mode: this.mode, attempts: this.isolate ? this.attempts : 1 })) {
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
