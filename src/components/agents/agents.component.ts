import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css, repeat } from '@melodicdev/core/template';
import { DialogService } from '@melodicdev/components/dialog';
import { AgentsStore, DRAFT_IMAGES, MAX_ATTEMPTS, attemptBranch, branchFor, scopeOf, stateLabel, stateOf, type AgentSession } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import { HostStore } from '../../services/host.store';
import type { AgentMode, ClaudeSession, Worktree } from '../../services/backend.service';
import { fileName, relativeTime } from '../../shared/format';
import { workspace, type Conversation } from '../../services/workspace.store';
import { baseName } from '../../services/agent-paths';
import { BUCKETS, bucketOf, mostPressing, type Bucket } from '../../shared/attention';
import { CONV_STATE_LABELS } from '../workspace/conversation-state';
import { convAgentState, stateStyles } from './agent-state';

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

/** A row of the list: a session (or the attempts of one task), a Claude conversation, or a session started in a terminal. */
type Row = { bucket: Bucket; at: number; key: string } & (
	| { kind: 'agents'; group: string | null; sessions: AgentSession[] }
	| { kind: 'conversation'; conv: Conversation }
	| { kind: 'outside'; repoId: string; session: ClaudeSession }
);

/** Outside sessions shown before "Show more". */
const ELSEWHERE_SHOWN = 8;
/** With every repository listed, outside sessions are the last few days' only, a few per repository. */
const ELSEWHERE_DAYS = 3;
const ELSEWHERE_PER_REPO = 5;
/** A transcript that changed this recently may belong to a session still open in a terminal. */
const RECENT_MS = 10 * 60_000;

/** Everything the tab lists, with where it stands. `hidden` is how many outside sessions wait behind "Show more". */
function rowsOf(self: AgentsComponent): { rows: Row[]; hidden: number } {
	const agents = self.agents;
	const all = agents.listScope() === 'all';
	const repoId = self.repos.repo()?.id ?? '';
	const rows: Row[] = [];
	for (const g of grouped(all ? agents.sessions() : agents.current())) {
		rows.push({
			kind: 'agents',
			key: g.group ?? g.sessions[0].id,
			group: g.group,
			sessions: g.sessions,
			bucket: mostPressing(g.sessions.map((s) => bucketOf(stateOf(s), s.unread))),
			at: Math.max(...g.sessions.map((s) => s.updated)),
		});
	}
	for (const c of workspace().conversations()) {
		if (c.kind === 'claude' && (all || c.repoId === repoId)) {
			rows.push({ kind: 'conversation', key: c.id, conv: c, bucket: bucketOf(convAgentState(c), c.unread), at: c.updated });
		}
	}
	let hidden = 0;
	const since = Date.now() - ELSEWHERE_DAYS * 86_400_000;
	for (const r of (self.repos.app()?.repos ?? []).filter((x) => all || x.id === repoId)) {
		const found = workspace().elsewhereIn(r.id);
		const shown = all ? found.filter((s) => s.modified >= since).slice(0, ELSEWHERE_PER_REPO) : self.allElsewhere ? found : found.slice(0, ELSEWHERE_SHOWN);
		if (!all) {
			hidden = found.length - shown.length;
		}
		for (const s of shown) {
			rows.push({ kind: 'outside', key: `outside:${s.id}`, repoId: r.id, session: s, bucket: 'done', at: s.modified });
		}
	}
	return { rows: rows.sort((a, b) => b.at - a.at), hidden };
}

/** The repository a row belongs to, said only while every repository is listed. */
function where(self: AgentsComponent, repoId: string) {
	if (self.agents.listScope() !== 'all') {
		return '';
	}
	const repo = self.repos.app()?.repos.find((r) => r.id === repoId);
	return html`<span class="repo" title=${repo?.path ?? 'No longer in Melodic Studio'}>${repo?.name ?? baseName(repoId)}</span>`;
}

function sessionRow(self: AgentsComponent, s: AgentSession, nested: boolean) {
	const agents = self.agents;
	const state = stateOf(s);
	const here = s.repoId === self.repos.repo()?.id;
	const known = here || !!self.repos.app()?.repos.some((r) => r.id === s.repoId);
	const on = here && s.id === agents.selectedId() && !agents.comparing() && !agents.asking();
	return html`
		<div class="session ${on ? 'sel' : ''} ${nested ? 'nested' : ''} ${s.unread ? 'unread' : ''}" @click=${() => (here ? agents.select(s.id) : void agents.open(s.id))}>
			<div class="top">
				${state === 'working' ? html`<span class="eq" aria-label="Working"><b></b><b></b><b></b></span>` : html`<span class="dot ${state} ${s.kind === 'investigate' ? 'you' : ''}" title=${stateLabel(s)}></span>`}
				<span class="title">${nested ? `Attempt ${s.attempt}` : s.title}</span>
				${s.unread ? html`<span class="new" title="Finished since you last looked"></span>` : ''}
				${here
					? html`<button class="x" title="Remove agent…" @click=${(e: Event) => (e.stopPropagation(), self.askRemove(s))}><ml-icon icon="x" size="xs"></ml-icon></button>`
					: known
						? ''
						: html`<button class="x" title="Forget this agent (its repository is no longer in Melodic Studio)" @click=${(e: Event) => (e.stopPropagation(), agents.remove(s, false))}><ml-icon icon="x" size="xs"></ml-icon></button>`}
			</div>
			<div class="meta">
				${where(self, s.repoId)}
				${s.kind === 'investigate'
					? html`<ml-icon icon="sparkle" size="xs"></ml-icon><span class="branch said ${state}">${stateLabel(s)}</span>`
					: s.kind === 'ask'
						? html`<ml-icon icon="chat-circle-dots" size="xs"></ml-icon><span class="branch">${scopeOf(s) === 'history' ? 'Question about history' : 'Question about the code'}</span>`
						: html`<ml-icon icon="git-branch" size="xs"></ml-icon><span class="branch">${s.branch ?? 'detached'}</span>`}
				<span>${relativeTime(s.updated)}</span>
			</div>
		</div>
	`;
}

/** A Claude conversation of the workspace: clicking it shows its tab there. */
function convRow(self: AgentsComponent, c: Conversation) {
	const state = convAgentState(c);
	return html`
		<div class="session ${c.unread ? 'unread' : ''}" title="Show this conversation in the Claude pane" @click=${() => workspace().open(c.id)}>
			<div class="top">
				${state === 'working' ? html`<span class="eq" aria-label="Working"><b></b><b></b><b></b></span>` : html`<span class="dot ${state} ${c.state === 'waiting' ? 'you' : ''}" title=${CONV_STATE_LABELS[c.state]}></span>`}
				<span class="title">${c.title}</span>
				${c.unread ? html`<span class="new" title="Something happened since you last looked"></span>` : ''}
				<button class="x" title=${c.state === 'saved' ? 'Forget this conversation (Claude Code keeps its transcript)' : 'End and forget this conversation'} @click=${(e: Event) => (e.stopPropagation(), workspace().close(c.id, true))}><ml-icon icon="x" size="xs"></ml-icon></button>
			</div>
			<div class="meta">
				${where(self, c.repoId)}
				<ml-icon icon="sparkle" size="xs"></ml-icon><span class="branch ${c.state === 'waiting' ? 'said review' : ''}">${c.state === 'waiting' ? (c.waitingFor ?? 'Needs you') : `Claude conversation · ${c.branch ?? CONV_STATE_LABELS[c.state]}`}</span>
				<span>${relativeTime(c.updated)}</span>
			</div>
		</div>
	`;
}

/** A Claude Code session started outside the app: clicking it adds it to the workspace, ready to resume. */
function elsewhereRow(self: AgentsComponent, repoId: string, s: ClaudeSession) {
	const recent = Date.now() - s.modified < RECENT_MS;
	return html`
		<div class="session" title=${`${s.prompt}\n\nStarted outside Melodic Studio. Click to continue it in the Claude pane.`} @click=${() => workspace().adopt(repoId, s)}>
			<div class="top">
				<ml-icon class="lead" icon="terminal-window" size="xs"></ml-icon>
				<span class="title">${s.title ?? s.prompt}</span>
				${recent ? html`<span class="live" title="Its transcript changed in the last few minutes: it may still be open in a terminal">active</span>` : ''}
			</div>
			<div class="meta">
				${where(self, repoId)}
				<ml-icon icon="git-branch" size="xs"></ml-icon><span class="branch">${s.branch ?? 'In a terminal'}</span>
				<span>${relativeTime(s.modified)}</span>
			</div>
		</div>
	`;
}

function row(self: AgentsComponent, r: Row) {
	if (r.kind === 'conversation') {
		return convRow(self, r.conv);
	}
	if (r.kind === 'outside') {
		return elsewhereRow(self, r.repoId, r.session);
	}
	if (!r.group) {
		return sessionRow(self, r.sessions[0], false);
	}
	const agents = self.agents;
	const first = r.sessions[0];
	const here = first.repoId === self.repos.repo()?.id;
	return html`
		<div class="attempts ${here && agents.comparing() === r.group ? 'sel' : ''}" title="Compare the attempts side by side" @click=${() => (here ? agents.compare(r.group!) : void agents.open(first.id))}>
			<ml-icon icon="columns" size="sm"></ml-icon>
			<span class="title">${first.title}</span>
			<span class="count">${r.sessions.length} attempts</span>
		</div>
		${repeat(
			r.sessions,
			(s) => s.id,
			(s) => sessionRow(self, s, true)
		)}
	`;
}

/** The New button's list: everything that can be started, in one place. */
function newMenu(self: AgentsComponent) {
	const agents = self.agents;
	const off = agents.cli() === null;
	const issues = self.repos.status()?.host?.issues ? (self.repos.status()?.host?.issuesLabel ?? 'Issues') : null;
	return html`
		<ml-popover id="new-pop" placement="bottom-end" offset="4">
			<button slot="trigger" class="newbtn" title="Start a task, a question, an investigation or a Claude conversation">
				<ml-icon icon="plus" size="xs"></ml-icon>New<ml-icon icon="caret-down" size="xs"></ml-icon>
			</button>
			<div class="menu">
				<button class="mitem" ?disabled=${off} title="Claude Code works on its own branch, in a worktree of its own" @click=${() => self.pick(() => self.openNew())}><ml-icon icon="robot" size="sm"></ml-icon><span class="grow">Task for an agent…</span><small>own worktree</small></button>
				<button class="mitem" ?disabled=${off} title="A read-only chat about the code: nothing is changed" @click=${() => self.pick(() => agents.openAsk('code'))}><ml-icon icon="chat-circle-dots" size="sm"></ml-icon><span class="grow">Ask about the code…</span><small>read-only</small></button>
				<button class="mitem" ?disabled=${off} title="A read-only chat that can also read the git history" @click=${() => self.pick(() => agents.openAsk('history'))}><ml-icon icon="clock-counter-clockwise" size="sm"></ml-icon><span class="grow">Ask about its history…</span><small>read-only</small></button>
				<button class="mitem ai" ?disabled=${off} title="Claude reproduces a bug in a worktree of its own, finds the cause and proposes a fix. Your files are not touched." @click=${() => self.pick(() => agents.openInvestigate())}><ml-icon icon="sparkle" size="sm"></ml-icon><span class="grow">Investigate a bug…</span></button>
				${issues ? html`<button class="mitem" title="Start an agent on an issue from the host" @click=${() => self.pick(() => self.host.openIssues())}><ml-icon icon="list-checks" size="sm"></ml-icon><span class="grow">Start from ${issues.toLowerCase()}…</span></button>` : ''}
				<div class="sep"></div>
				<button class="mitem ai" ?disabled=${off} title=${`Claude Code itself, in a terminal, in ${workspace().checkoutName()}`} @click=${() => self.pick(() => void workspace().newClaude())}><ml-icon icon="sparkle" size="sm"></ml-icon><span class="grow">Claude conversation</span><small>Claude pane</small></button>
			</div>
		</ml-popover>
	`;
}

/** Sidebar "Agents" tab: every agent session and Claude conversation, by how it stands, and the dialogs for starting and removing them. */
@MelodicComponent({
	selector: 'ms-agents',
	template: (self: AgentsComponent) => {
		const agents = self.agents;
		const all = agents.listScope() === 'all';
		const repo = self.repos.repo();
		if (repo && !(repo.id in workspace().elsewhere())) {
			// First look at this repository (the tab outlives a repository switch): read its sessions now, not at the next poll.
			queueMicrotask(() => void workspace().loadElsewhere(repo.id));
		}
		const { rows, hidden } = rowsOf(self);
		const trees = agents.worktrees();
		const treesShown = agents.treesShown();
		const doomed = self.doomed;
		return html`
			<div class="head">
				<div class="scope" role="group" aria-label="Which repositories to list">
					<button class=${all ? '' : 'on'} title="This repository's agents and conversations" @click=${() => self.setScope('repo')}><span class="name">${repo?.name ?? ''}</span></button>
					<button class=${all ? 'on' : ''} title="Every repository in Melodic Studio" @click=${() => self.setScope('all')}>All<span class="long">&nbsp;repositories</span></button>
				</div>
				<span class="grow"></span>
				${newMenu(self)}
			</div>
			<div class="list">
				${rows.length === 0 ? html`<div class="none">Nothing here yet. <b>New</b> starts a task for an agent, a question, an investigation or a Claude conversation.</div>` : ''}
				${BUCKETS.map((b) => {
					const mine = rows.filter((r) => r.bucket === b.key);
					return mine.length
						? html`
							<div class="group ${b.key}">${b.label} · ${mine.length}</div>
							${repeat(
								mine,
								(r) => r.key,
								(r) => row(self, r)
							)}
						`
						: '';
				})}
				${hidden > 0 ? html`<div class="more" @click=${() => (self.allElsewhere = true)}>Show ${hidden} more from the terminal</div>` : ''}

				${!all && trees.length > 1
					? html`
						<button class="group fold" title=${treesShown ? 'Fold the worktrees away' : 'Show the worktrees'} @click=${() => agents.treesShown.set(!treesShown)}>
							<ml-icon icon=${treesShown ? 'caret-down' : 'caret-right'} size="xs"></ml-icon>Worktrees · ${trees.length}
						</button>
						${treesShown
							? trees.map(
									(w) => html`
										<div class="tree ${w.active ? 'on' : ''}" title=${w.path} @click=${() => agents.view(w.isMain ? null : w.path, 'agents')}>
											<ml-icon icon=${w.active ? 'check' : w.isMain ? 'house' : 'tree-structure'} size="sm"></ml-icon>
											<span class="title">${w.branch ?? fileName(w.path)}${w.isMain ? html`<span class="dim"> · main checkout</span>` : ''}</span>
											${w.changes ? html`<span class="count">${w.changes}</span>` : ''}
											${w.isMain ? '' : html`<button class="x" title="Remove worktree…" @click=${(e: Event) => (e.stopPropagation(), self.askRemoveTree(w))}><ml-icon icon="trash" size="xs"></ml-icon></button>`}
										</div>
									`
								)
							: ''}
					`
					: ''}
			</div>

			<ml-dialog #new-agent style="--ml-dialog-max-width: 540px">
				<h3 slot="dialog-header">New agent task</h3>
				<div class="dlg">
					<ml-textarea label="Task" rows="5" placeholder="Describe what you want done. Be as specific as you would be with a colleague." .value=${self.task} @ml:input=${(e: CustomEvent) => self.setTask(e.detail.value)}></ml-textarea>
					<ms-attach .box=${DRAFT_IMAGES.task} .pick=${true}></ms-attach>
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
					<ml-button variant="primary" ?disabled=${!self.task.trim() || (self.isolate && !self.branch) || !!agents.attaching()[DRAFT_IMAGES.task]} ?loading=${agents.busy()} @ml:click=${() => self.start()}>${self.isolate && self.attempts > 1 ? `Start ${self.attempts} agents` : 'Start agent'}</ml-button>
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
		${stateStyles}
		.head {
			flex: none;
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 2px 8px 8px 10px;
			border-bottom: 1px solid var(--ml-color-border);
			/* "All repositories" is spelled out only where the sidebar has the room. */
			container-type: inline-size;
		}
		/* This repository, or every one. */
		.scope {
			min-width: 0;
			display: flex;
			gap: 2px;
			padding: 2px;
			border: 1px solid var(--ml-color-border);
			border-radius: 8px;
		}
		.scope button {
			all: unset;
			flex: none;
			display: flex;
			align-items: center;
			box-sizing: border-box;
			height: 22px;
			padding: 0 8px;
			border-radius: 6px;
			font-size: 12px;
			font-weight: 500;
			white-space: nowrap;
			color: var(--ml-color-text-muted);
		}
		.scope button:first-child {
			flex: 0 1 auto;
			min-width: 0;
		}
		.scope .name {
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.scope button:hover {
			color: var(--ml-color-text);
		}
		.scope button.on {
			background: var(--ms-seg-on);
			box-shadow: var(--ms-seg-shadow);
			color: var(--ml-color-text);
		}
		.scope .long {
			display: none;
		}
		@container (min-width: 270px) {
			.scope .long {
				display: inline;
			}
		}
		button:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: -2px;
		}
		/* New: the tab's one main action. */
		.newbtn {
			all: unset;
			flex: none;
			display: flex;
			align-items: center;
			gap: 5px;
			height: 26px;
			padding: 0 8px;
			border-radius: 7px;
			background: var(--ml-color-primary);
			color: var(--ml-color-text-inverse);
			font-size: 12.5px;
			font-weight: 600;
		}
		.newbtn:hover {
			background: var(--ml-color-primary-hover);
		}
		ml-popover {
			display: flex;
			--ml-popover-padding-x: 0;
			--ml-popover-padding-y: 0;
			--ml-popover-radius: 10px;
		}
		.menu {
			display: flex;
			flex-direction: column;
			gap: 1px;
			width: 270px;
			box-sizing: border-box;
			padding: 6px;
			font-size: 13px;
			color: var(--ml-color-text);
		}
		.mitem {
			all: unset;
			display: flex;
			align-items: center;
			gap: 9px;
			padding: 7px 8px;
			border-radius: 6px;
		}
		.mitem:hover {
			background: var(--ms-hover);
		}
		.mitem[disabled] {
			opacity: 0.5;
			pointer-events: none;
		}
		.mitem ml-icon {
			flex: none;
			color: var(--ml-color-text-muted);
		}
		/* Purple: it hands the work to Claude itself. */
		.mitem.ai ml-icon {
			color: var(--ms-ai);
		}
		.mitem small {
			flex: none;
			font-size: 11.5px;
			color: var(--ml-color-text-muted);
		}
		.sep {
			height: 1px;
			margin: 5px 2px;
			background: var(--ml-color-border);
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
		/* ---- groups of parallel attempts ---- */
		.attempts {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 7px 8px 7px 12px;
			border-bottom: 1px solid var(--ml-color-border-muted);
		}
		.attempts > ml-icon {
			flex: none;
			color: var(--ml-color-primary);
		}
		/* An investigation's state in words: magenta while it waits for an OK, green once the cause is found. */
		.said.review {
			color: var(--ml-color-text-link);
		}
		.said.finished {
			color: var(--ms-add);
		}
		.said.failed {
			color: var(--ms-del);
		}
		.attempts:hover {
			background: var(--ms-hover);
		}
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
		/* Waiting on the user: magenta. */
		.dot.review {
			background: var(--ms-you);
		}
		/* Working: the equalizer bars (agent-state.ts), in the place a dot would take. */
		.top > .eq {
			flex: none;
			margin: 0 4px;
			color: var(--ms-run);
		}
		/* The repository's name, while every repository is listed. */
		.repo {
			flex: none;
			max-width: 45%;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-weight: 600;
		}
		.repo::after {
			content: ' ·';
			font-weight: 400;
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
		/* What waits on the user is named in magenta, like everything else that does. */
		.group.needs {
			color: var(--ml-color-text-link);
		}
		.group.fold {
			all: unset;
			display: flex;
			align-items: center;
			gap: 5px;
			box-sizing: border-box;
			width: 100%;
			padding: 14px 12px 5px 8px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
			border-bottom: 1px solid var(--ml-color-border-muted);
		}
		.group.fold:hover {
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

	elementRef!: HTMLElement;

	/** Every outside session, not just the newest few. */
	allElsewhere = false;

	/** This repository, or every one: the others' sessions started in a terminal are read when they are first asked for. */
	setScope(scope: 'repo' | 'all'): void {
		this.agents.listScope.set(scope);
		if (scope === 'all') {
			for (const r of this.repos.app()?.repos ?? []) {
				void workspace().loadElsewhere(r.id);
			}
		}
	}

	/** Something picked from the New list: the list goes first, or it would sit on top of the dialog. */
	pick(start: () => void): void {
		(this.elementRef.shadowRoot?.querySelector('#new-pop') as (HTMLElement & { component?: { close(): void } }) | null)?.component?.close();
		start();
	}
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
		this.agents.takeAttached(DRAFT_IMAGES.task);
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
		const agents = this.agents;
		// Not while an image is still being made ready: the task would go without it.
		if (agents.attaching()[DRAFT_IMAGES.task]) {
			return;
		}
		// They stay in the dialog until the task has started, so a failed start loses nothing.
		const images = agents.attached()[DRAFT_IMAGES.task] ?? [];
		if (await agents.start({ task: this.task, branch: this.isolate ? this.branch : '', mode: this.mode, attempts: this.isolate ? this.attempts : 1, images })) {
			agents.takeAttached(DRAFT_IMAGES.task);
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
