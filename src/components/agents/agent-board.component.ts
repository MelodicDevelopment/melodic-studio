import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css, repeat } from '@melodicdev/core/template';
import { DialogService } from '@melodicdev/components/dialog';
import { AgentsStore, lastSaid, scopeOf, stateOf, type AgentSession } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import { baseName } from '../../services/agent-paths';
import { plural, relativeTime } from '../../shared/format';
import { convChip, stateChip, stateStyles } from './agent-state';
import { workspace, type Conversation } from '../../services/workspace.store';
import type { ClaudeSession } from '../../services/backend.service';

/** The board shows outside sessions from the last few days only, a few per repository: the Agents tab has them all. */
const ELSEWHERE_DAYS = 3;
const ELSEWHERE_PER_REPO = 5;
const RECENT_MS = 10 * 60_000;

type DialogId = Parameters<DialogService['close']>[0];

interface RepoGroup {
	id: string;
	name: string;
	path: string;
	/** The repository on screen. */
	open: boolean;
	/** Still one of the app's repositories. */
	known: boolean;
	sessions: AgentSession[];
	/** Claude Code conversations of the workspace (not shells). */
	conversations: Conversation[];
	/** Recent Claude Code sessions started outside the app. */
	elsewhere: ClaudeSession[];
}

/** The workspace's Claude conversations, for the board. */
function conversations(): Conversation[] {
	return workspace().conversations().filter((c) => c.kind === 'claude');
}

/** Every session, by repository: the open one first, then whichever has agents working, then by name. Newest first within each, attempts of one task together. */
function byRepo(self: AgentBoardComponent): RepoGroup[] {
	const repos = self.repos.app()?.repos ?? [];
	const open = self.repos.repo()?.id;
	const groups = new Map<string, RepoGroup>();
	const groupOf = (repoId: string): RepoGroup => {
		let g = groups.get(repoId);
		if (!g) {
			const repo = repos.find((r) => r.id === repoId);
			g = { id: repoId, name: repo?.name ?? baseName(repoId), path: repo?.path ?? repoId, open: repoId === open, known: !!repo, sessions: [], conversations: [], elsewhere: [] };
			groups.set(repoId, g);
		}
		return g;
	};
	for (const s of self.agents.sessions()) {
		groupOf(s.repoId).sessions.push(s);
	}
	for (const c of conversations()) {
		groupOf(c.repoId).conversations.push(c);
	}
	const since = Date.now() - ELSEWHERE_DAYS * 86_400_000;
	for (const r of repos) {
		const recent = workspace()
			.elsewhereIn(r.id)
			.filter((s) => s.modified >= since)
			.slice(0, ELSEWHERE_PER_REPO);
		if (recent.length) {
			groupOf(r.id).elsewhere = recent;
		}
	}
	const working = (g: RepoGroup) => g.sessions.filter((s) => s.status === 'running').length + g.conversations.filter((c) => c.state === 'working').length;
	const newest = new Map<string, number>();
	for (const s of self.agents.sessions()) {
		if (s.group) {
			newest.set(s.group, Math.max(newest.get(s.group) ?? 0, s.updated));
		}
	}
	const when = (s: AgentSession) => (s.group ? (newest.get(s.group) ?? s.updated) : s.updated);
	for (const g of groups.values()) {
		g.sessions.sort((a, b) => when(b) - when(a) || (a.group ?? '').localeCompare(b.group ?? '') || a.attempt - b.attempt);
		// Running ones first (needing you before working), then the newest.
		const live = (c: Conversation) => (c.state === 'waiting' ? 3 : c.state === 'working' || c.state === 'starting' ? 2 : c.state === 'idle' ? 1 : 0);
		g.conversations.sort((a, b) => live(b) - live(a) || b.updated - a.updated);
	}
	return [...groups.values()].sort((a, b) => Number(b.open) - Number(a.open) || Number(b.known) - Number(a.known) || working(b) - working(a) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** "2 conversations · 1 needs you" for a repository's Claude conversations. */
function convTally(convs: Conversation[]): string {
	if (!convs.length) {
		return '';
	}
	const n = (...states: Conversation['state'][]) => convs.filter((c) => states.includes(c.state)).length;
	const parts = [
		[n('waiting'), n('waiting') === 1 ? 'needs you' : 'need you'],
		[n('working', 'starting'), 'working'],
	] as const;
	return [plural(convs.length, 'conversation'), ...parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`)].join(' · ');
}

function tally(sessions: AgentSession[]): string {
	const n = (state: string) => sessions.filter((s) => stateOf(s) === state).length;
	const parts = [
		[n('working'), 'working'],
		[n('review'), n('review') === 1 ? 'needs review' : 'need review'],
		[n('failed'), 'failed'],
		[n('finished') + n('stopped'), 'finished'],
	] as const;
	return parts
		.filter(([count]) => count > 0)
		.map(([count, label]) => `${count} ${label}`)
		.join(' · ');
}

function card(self: AgentBoardComponent, s: AgentSession, known: boolean) {
	const ask = s.kind === 'ask';
	const said = lastSaid(s);
	return html`
		<div class="card ${s.unread ? 'unread' : ''} ${known ? '' : 'orphan'}" title=${known ? 'Go to this agent' : ''} @click=${() => self.go(s, known)}>
			<div class="line">
				${stateChip(s)}
				<span class="title">${s.title}</span>
				${s.unread ? html`<span class="new" title="Finished since you last looked"></span>` : ''}
				<span class="when">${relativeTime(s.updated)}</span>
				${known ? '' : html`<button class="x" title="Forget this agent" @click=${(e: Event) => (e.stopPropagation(), self.agents.remove(s, false))}><ml-icon icon="x" size="xs"></ml-icon></button>`}
			</div>
			<div class="line meta">
				<span class="where"><ml-icon icon=${ask ? 'chat-circle-dots' : 'git-branch'} size="xs"></ml-icon><span>${ask ? (scopeOf(s) === 'history' ? 'Question about history' : 'Question about the code') : (s.branch ?? 'detached')}</span></span>
				${s.group ? html`<span>Attempt ${s.attempt}</span>` : ''}
				${s.cost ? html`<span>$${s.cost.toFixed(2)}</span>` : ''}
			</div>
			${said ? html`<div class="said">${said}</div>` : ''}
		</div>
	`;
}

function convCard(self: AgentBoardComponent, c: Conversation, known: boolean) {
	const said = c.state === 'waiting' ? c.waitingFor : c.lastSaid;
	const subagents = c.subagents.filter((s) => s.running).length;
	return html`
		<div class="card ${c.unread ? 'unread' : ''} ${known ? '' : 'orphan'}" title=${known ? 'Go to this conversation' : ''} @click=${() => self.goConversation(c, known)}>
			<div class="line">
				${convChip(c)}
				<span class="title">${c.title}</span>
				${c.unread ? html`<span class="new" title="Something happened since you last looked"></span>` : ''}
				<span class="when">${relativeTime(c.updated)}</span>
			</div>
			<div class="line meta">
				<span class="where"><ml-icon icon="sparkle" size="xs"></ml-icon><span>Claude conversation${c.branch ? ` · ${c.branch}` : ''}</span></span>
				${subagents ? html`<span>${plural(subagents, 'subagent')} running</span>` : ''}
			</div>
			${said ? html`<div class="said">${said}</div>` : ''}
		</div>
	`;
}

function elsewhereCard(self: AgentBoardComponent, repoId: string, s: ClaudeSession) {
	const recent = Date.now() - s.modified < RECENT_MS;
	return html`
		<div class="card" title="Started outside Melodic Studio. Click to continue it in the Claude workspace." @click=${() => self.goElsewhere(repoId, s)}>
			<div class="line">
				<span class="chip ${recent ? 'working' : 'stopped'}"><ml-icon icon="terminal-window" size="xs"></ml-icon>${recent ? 'Active' : 'Terminal'}</span>
				<span class="title">${s.title ?? s.prompt}</span>
				<span class="when">${relativeTime(s.modified)}</span>
			</div>
			<div class="line meta">
				<span class="where"><ml-icon icon="git-branch" size="xs"></ml-icon><span>Started in a terminal${s.branch ? ` · ${s.branch}` : ''}</span></span>
			</div>
			${s.lastSaid ? html`<div class="said">${s.lastSaid}</div>` : ''}
		</div>
	`;
}

/**
 * The toolbar's agents button and the board it opens: every agent session and every Claude
 * conversation of the workspace in every repository, grouped by repository, with its status,
 * branch, cost, the last thing it said and how long ago. Clicking one goes to it. The button counts the agents working right now
 * and carries a dot while one has finished unseen.
 */
@MelodicComponent({
	selector: 'ms-agent-board',
	template: (self: AgentBoardComponent) => {
		const agents = self.agents;
		const running = agents.running();
		const unread = agents.unread();
		const groups = self.shown ? byRepo(self) : [];
		const convs = self.shown ? conversations() : [];
		const outside = groups.reduce((n, g) => n + g.elsewhere.length, 0);
		const total = agents.sessions().length + convs.length + outside;
		const summary = [
			agents.sessions().length ? plural(agents.sessions().length, 'agent') : '',
			convs.length ? plural(convs.length, 'conversation') : '',
			outside ? `${plural(outside, 'recent terminal session')}` : '',
		]
			.filter(Boolean)
			.join(', ');
		return html`
			<button class="tool" title=${running || unread ? `Agents: ${[running ? `${running} working` : '', unread ? `${unread} finished since you last looked` : ''].filter(Boolean).join(', ')}` : 'Agents in every repository'} @click=${() => self.open()}>
				<ml-icon icon="robot" size="md"></ml-icon>
				${running ? html`<span class="count">${running}</span>` : ''}
				${unread ? html`<span class="badge"></span>` : ''}
			</button>

			<ml-dialog #agent-board style="--ml-dialog-max-width: 820px" @ml:close=${() => (self.shown = false)}>
				<h3 slot="dialog-header">Agents</h3>
				<div class="board">
					${total === 0
						? html`<div class="none"><ml-icon icon="robot" size="lg"></ml-icon><div>No agents or Claude conversations yet. Start one from the Agents tab or the Claude workspace of any repository and it shows up here.</div></div>`
						: html`<div class="summary">${summary} in ${groups.length === 1 ? '1 repository' : `${groups.length} repositories`}${tally(agents.sessions()) ? ` · ${tally(agents.sessions())}` : ''}</div>`}
					${repeat(
						groups,
						(g) => g.id,
						(g) => html`
							<div class="repo">
								<div class="repohead">
									<ml-icon icon=${g.known ? 'folder-simple' : 'warning'} size="sm"></ml-icon>
									<b>${g.name}</b>
									${g.open ? html`<span class="tag">open</span>` : ''}
									<span class="path">${g.known ? g.path : 'No longer in Melodic Studio'}</span>
									<span class="dim">${[convTally(g.conversations), g.elsewhere.length ? `${g.elsewhere.length} from the terminal` : '', tally(g.sessions)].filter(Boolean).join(' · ')}</span>
								</div>
								${repeat(
									g.conversations,
									(c) => c.id,
									(c) => convCard(self, c, g.known)
								)}
								${repeat(
									g.elsewhere,
									(s) => s.id,
									(s) => elsewhereCard(self, g.id, s)
								)}
								${repeat(
									g.sessions,
									(s) => s.id,
									(s) => card(self, s, g.known)
								)}
							</div>
						`
					)}
				</div>
				<div slot="dialog-footer" class="foot">
					<ml-button variant="outline" @ml:click=${() => self.close()}>Close</ml-button>
				</div>
			</ml-dialog>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			align-items: center;
		}
		${stateStyles}
		.tool {
			all: unset;
			position: relative;
			display: grid;
			place-items: center;
			width: 38px;
			height: 38px;
			border-radius: 10px;
			color: var(--ms-toolbar-muted);
		}
		.tool:hover {
			background: var(--ms-toolbar-hover);
			color: var(--ms-toolbar-fg);
		}
		.tool:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: -2px;
		}
		.count {
			position: absolute;
			top: 2px;
			right: 0;
			min-width: 16px;
			padding: 0 4px;
			box-sizing: border-box;
			border-radius: 999px;
			background: var(--ms-run);
			color: #0b0814;
			font-size: 10px;
			font-weight: 700;
			line-height: 16px;
			text-align: center;
		}
		.badge {
			position: absolute;
			bottom: 6px;
			right: 5px;
			width: 8px;
			height: 8px;
			border: 2px solid var(--ms-toolbar-bg);
			border-radius: 50%;
			background: var(--ms-you);
		}
		h3 {
			margin: 0;
			font-family: var(--ms-font-display);
			font-size: 18px;
			letter-spacing: -0.01em;
			font-weight: 600;
		}
		.board {
			display: flex;
			flex-direction: column;
			gap: 16px;
			min-height: 160px;
			color: var(--ml-color-text);
		}
		.summary,
		.dim {
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.none {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 10px;
			padding: 28px;
			text-align: center;
			color: var(--ml-color-text-muted);
		}
		.repo {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}
		.repohead {
			display: flex;
			align-items: center;
			gap: 8px;
			padding-bottom: 2px;
		}
		.repohead > ml-icon {
			flex: none;
			color: var(--ml-color-text-muted);
		}
		.repohead b {
			flex: none;
			font-weight: 600;
		}
		.path {
			flex: 1;
			min-width: 0;
			font-size: 12px;
			color: var(--ml-color-text-muted);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.tag {
			flex: none;
			padding: 0 7px;
			border-radius: 999px;
			background: var(--ml-color-primary-subtle);
			color: var(--ml-color-primary);
			font-size: 11px;
			font-weight: 600;
			line-height: 17px;
		}
		.card {
			display: flex;
			flex-direction: column;
			gap: 4px;
			padding: 9px 12px;
			border: 1px solid var(--ml-color-border);
			border-radius: 9px;
			background: var(--ml-color-surface);
		}
		.card:hover {
			border-color: var(--ml-color-border-strong, var(--ml-color-border));
			background: var(--ms-hover);
		}
		.card.orphan {
			opacity: 0.75;
		}
		.line {
			display: flex;
			align-items: center;
			gap: 9px;
		}
		.title {
			flex: 1;
			min-width: 0;
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.unread .title {
			font-weight: 700;
		}
		.new {
			flex: none;
			width: 7px;
			height: 7px;
			border-radius: 50%;
			background: var(--ml-color-primary);
		}
		.when {
			flex: none;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.meta {
			gap: 14px;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.where {
			min-width: 0;
			display: inline-flex;
			align-items: center;
			gap: 5px;
		}
		.where span {
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.said {
			font-size: 12px;
			line-height: 18px;
			color: var(--ml-color-text-secondary);
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
			overflow-wrap: anywhere;
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
		}
		.x:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
		.foot {
			display: flex;
			justify-content: flex-end;
			width: 100%;
		}
	`,
})
export class AgentBoardComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	@Service(DialogService) private readonly _dialogs!: DialogService;

	/** The board is open. Its rows are only built while it is, and "how long ago" is fresh each time. */
	shown = false;

	onCreate(): void {
		// Agents report back as events; someone has to be listening from the start, whichever tab is open.
		void this.agents.init();
	}

	open(): void {
		this.shown = true;
		for (const r of this.repos.app()?.repos ?? []) {
			void workspace().loadElsewhere(r.id);
		}
		this._dialogs.open('agent-board' as DialogId);
	}

	close(): void {
		this.shown = false;
		this._dialogs.close('agent-board' as DialogId);
	}

	/** Go to a conversation: its repository becomes the open one and the workspace shows its tab. */
	goConversation(c: Conversation, known: boolean): void {
		if (!known) {
			return;
		}
		this.close();
		void workspace().open(c.id);
	}

	/** Continue an outside session: it becomes a saved conversation in the workspace, ready to resume. */
	goElsewhere(repoId: string, s: ClaudeSession): void {
		this.close();
		void workspace().adopt(repoId, s);
	}

	/** Go to a session: its repository becomes the open one, on the Agents tab, with it selected. */
	go(session: AgentSession, known: boolean): void {
		if (!known) {
			return;
		}
		this.close();
		void this.agents.open(session.id);
	}
}
