import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css, repeat } from '@melodicdev/core/template';
import { DialogService } from '@melodicdev/components/dialog';
import { AgentsStore, lastSaid, scopeOf, stateOf, type AgentSession } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import { baseName } from '../../services/agent-paths';
import { plural, relativeTime } from '../../shared/format';
import { stateChip, stateStyles } from './agent-state';

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
}

/** Every session, by repository: the open one first, then whichever has agents working, then by name. Newest first within each, attempts of one task together. */
function byRepo(self: AgentBoardComponent): RepoGroup[] {
	const repos = self.repos.app()?.repos ?? [];
	const open = self.repos.repo()?.id;
	const groups = new Map<string, RepoGroup>();
	for (const s of self.agents.sessions()) {
		let g = groups.get(s.repoId);
		if (!g) {
			const repo = repos.find((r) => r.id === s.repoId);
			g = { id: s.repoId, name: repo?.name ?? baseName(s.repoId), path: repo?.path ?? s.repoId, open: s.repoId === open, known: !!repo, sessions: [] };
			groups.set(s.repoId, g);
		}
		g.sessions.push(s);
	}
	const working = (g: RepoGroup) => g.sessions.filter((s) => s.status === 'running').length;
	const newest = new Map<string, number>();
	for (const s of self.agents.sessions()) {
		if (s.group) {
			newest.set(s.group, Math.max(newest.get(s.group) ?? 0, s.updated));
		}
	}
	const when = (s: AgentSession) => (s.group ? (newest.get(s.group) ?? s.updated) : s.updated);
	for (const g of groups.values()) {
		g.sessions.sort((a, b) => when(b) - when(a) || (a.group ?? '').localeCompare(b.group ?? '') || a.attempt - b.attempt);
	}
	return [...groups.values()].sort((a, b) => Number(b.open) - Number(a.open) || Number(b.known) - Number(a.known) || working(b) - working(a) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
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

/**
 * The toolbar's agents button and the board it opens: every agent session in every
 * repository, grouped by repository, with its status, branch, cost, the last thing it said
 * and how long ago. Clicking one goes to it. The button counts the agents working right now
 * and carries a dot while one has finished unseen.
 */
@MelodicComponent({
	selector: 'ms-agent-board',
	template: (self: AgentBoardComponent) => {
		const agents = self.agents;
		const running = agents.running();
		const unread = agents.unread();
		const groups = self.shown ? byRepo(self) : [];
		const total = agents.sessions().length;
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
						? html`<div class="none"><ml-icon icon="robot" size="lg"></ml-icon><div>No agents yet. Start one from the Agents tab of any repository and it shows up here.</div></div>`
						: html`<div class="summary">${plural(total, 'agent')} in ${groups.length === 1 ? '1 repository' : `${groups.length} repositories`}${tally(agents.sessions()) ? ` · ${tally(agents.sessions())}` : ''}</div>`}
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
									<span class="dim">${tally(g.sessions)}</span>
								</div>
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
		this._dialogs.open('agent-board' as DialogId);
	}

	close(): void {
		this.shown = false;
		this._dialogs.close('agent-board' as DialogId);
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
