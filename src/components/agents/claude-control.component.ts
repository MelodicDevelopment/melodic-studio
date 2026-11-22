import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css, repeat } from '@melodicdev/core/template';
import { PipelineStore } from '../../services/pipeline.store';
import { AgentsStore, nameOf, plainSummary, scopeOf, stateOf, summary, type AgentSession } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import { WorkspaceStore, type Conversation } from '../../services/workspace.store';
import { isMac } from '../../services/backend.service';
import { baseName } from '../../services/agent-paths';
import { bucketOf, type Bucket } from '../../shared/attention';
import { plural, relativeTime } from '../../shared/format';
import { convAgentState, convChip, stateChip, stateStyles } from './agent-state';

/** One thing the list shows: an agent session or a Claude conversation, with where it stands. */
type Entry = { bucket: Bucket; at: number; key: string } & ({ session: AgentSession; conv?: undefined } | { conv: Conversation; session?: undefined });

/** Every session and conversation of the repositories still in the app, newest first. */
function entries(self: ClaudeControlComponent): Entry[] {
	const known = new Set((self.repos.app()?.repos ?? []).map((r) => r.id));
	const out: Entry[] = [];
	for (const s of self.agents.sessions()) {
		if (known.has(s.repoId)) {
			out.push({ session: s, key: s.id, at: s.updated, bucket: bucketOf(stateOf(s), s.unread) });
		}
	}
	for (const c of self.store.conversations()) {
		if (c.kind === 'claude' && known.has(c.repoId)) {
			out.push({ conv: c, key: c.id, at: c.updated, bucket: bucketOf(convAgentState(c), c.unread) });
		}
	}
	return out.sort((a, b) => b.at - a.at);
}

function repoName(self: ClaudeControlComponent, repoId: string): string {
	return self.repos.app()?.repos.find((r) => r.id === repoId)?.name ?? baseName(repoId);
}

function sessionCard(self: ClaudeControlComponent, s: AgentSession) {
	const ask = s.kind === 'ask';
	const investigation = s.kind === 'investigate';
	// An investigation's last message is its report as JSON: what it found says more. Anything else: its brief.
	const sum = investigation ? null : summary(s);
	const said = investigation ? plainSummary(s.investigation?.report?.summary || s.investigation?.thinking || '') : (sum?.needs ?? sum?.now ?? sum?.did ?? '');
	return html`
		<div class="card ${s.unread ? 'unread' : ''}" title="Go to this agent" @click=${() => self.go(s)}>
			<div class="line">
				${stateChip(s)}
				<span class="title" title=${s.title}>${nameOf(s)}</span>
				<span class="when">${relativeTime(s.updated)}</span>
			</div>
			<div class="line meta">
				<span class="where"><b>${repoName(self, s.repoId)}</b></span>
				<span class="where"><ml-icon icon=${ask ? 'chat-circle-dots' : investigation ? 'sparkle' : 'git-branch'} size="xs"></ml-icon><span>${ask ? (scopeOf(s) === 'history' ? 'Question about history' : 'Question about the code') : (s.branch ?? 'detached')}</span></span>
				${s.cost ? html`<span>$${s.cost.toFixed(2)}</span>` : ''}
			</div>
			${said ? html`<div class="said ${sum?.needs ? 'ask' : ''}">${said}</div>` : ''}
		</div>
	`;
}

function convCard(self: ClaudeControlComponent, c: Conversation) {
	const said = c.state === 'waiting' ? c.waitingFor : c.lastSaid;
	const subagents = c.subagents.filter((s) => s.running).length;
	return html`
		<div class="card ${c.unread ? 'unread' : ''}" title="Go to this conversation" @click=${() => self.goConversation(c)}>
			<div class="line">
				${convChip(c)}
				<span class="title">${c.title}</span>
				<span class="when">${relativeTime(c.updated)}</span>
			</div>
			<div class="line meta">
				<span class="where"><b>${repoName(self, c.repoId)}</b></span>
				<span class="where"><ml-icon icon="sparkle" size="xs"></ml-icon><span>Claude conversation${c.branch ? ` · ${c.branch}` : ''}</span></span>
				${subagents ? html`<span>${plural(subagents, 'subagent')} running</span>` : ''}
			</div>
			${said ? html`<div class="said ${c.state === 'waiting' ? 'ask' : ''}">${said}</div>` : ''}
		</div>
	`;
}

function group(self: ClaudeControlComponent, label: string, key: Bucket, list: Entry[]) {
	return list.length
		? html`
			<div class="group ${key}">${label} · ${list.length}</div>
			${repeat(
				list,
				(e) => e.key,
				(e) => (e.session ? sessionCard(self, e.session) : convCard(self, e.conv))
			)}
		`
		: '';
}

/**
 * The toolbar's Claude control, in two halves. The sparkle shows or hides the Claude pane
 * (Cmd/Ctrl+Shift+K). The count beside it is everything waiting on the user in every
 * repository (agents with work to review, conversations asking for something, anything that
 * ended unseen), and opens the list of those and of what is still working. Everything else
 * is in the Agents tab, which the list's last row goes to.
 */
@MelodicComponent({
	selector: 'ms-claude-control',
	template: (self: ClaudeControlComponent) => {
		const store = self.store;
		const all = entries(self);
		const needs = all.filter((e) => e.bucket === 'needs');
		const working = all.filter((e) => e.bucket === 'working');
		const shown = store.shown() !== 'hidden';
		const key = `${isMac() ? '⌘' : 'Ctrl+'}Shift+K`;
		const what = needs.length ? `${needs.length} waiting for you` : working.length ? `${working.length} working` : 'Nothing is waiting for you';
		return html`
			<div class="ctl">
				<button class="pane ${shown ? 'on' : ''}" title=${`${shown ? 'Hide' : 'Show'} the Claude pane (${key})`} aria-label=${`${shown ? 'Hide' : 'Show'} the Claude pane`} aria-pressed=${shown ? 'true' : 'false'} @click=${() => store.toggle()}>
					<ml-icon icon="sparkle" size="md"></ml-icon>
				</button>
				<ml-popover id="claude-pop" placement="bottom-end" offset="0" @ml:open=${() => (self.shown = true)} @ml:close=${() => (self.shown = false)}>
					<button slot="trigger" class="count" title=${`Agents and Claude conversations in every repository: ${what.toLowerCase()}`} aria-label=${`Agents and Claude conversations: ${what.toLowerCase()}`}>
						${needs.length ? html`<span class="n">${needs.length}</span>` : working.length ? html`<span class="eq" aria-hidden="true"><b></b><b></b><b></b></span>` : ''}
						<ml-icon icon="caret-down" size="xs"></ml-icon>
					</button>
					<div class="panel">
						<div class="list">
							${self.shown ? html`${group(self, 'Needs you', 'needs', needs)}${group(self, 'Working', 'working', working)}` : ''}
							${needs.length + working.length === 0 ? html`<div class="none">Nothing is waiting for you, and nothing is running.</div>` : ''}
						</div>
						<div class="foot">
							<button class="item" ?disabled=${!self.repos.repo()} title=${`Every repository's agents and conversations on one page (${isMac() ? '⌘' : 'Ctrl+'}Shift+A)`} @click=${() => self.everything()}>
								<ml-icon icon="list-checks" size="sm"></ml-icon><span class="grow">Everything, in every repository</span><small>Agents page</small>
							</button>
						</div>
					</div>
				</ml-popover>
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			align-items: center;
			flex: none;
		}
		${stateStyles}
		.ctl {
			display: flex;
			align-items: stretch;
			height: 38px;
			box-sizing: border-box;
			border: 1px solid var(--ms-toolbar-border);
			border-radius: 10px;
			background: var(--ms-toolbar-raised);
		}
		ml-popover {
			display: flex;
			--ml-popover-padding-x: 0;
			--ml-popover-padding-y: 0;
			--ml-popover-content-overflow: hidden;
			--ml-popover-radius: 12px;
		}
		button {
			all: unset;
			box-sizing: border-box;
			cursor: default;
		}
		button:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: -2px;
		}
		/* The sparkle is Claude's purple; it sits on a lit half while the pane is on screen. */
		.pane {
			display: grid;
			place-items: center;
			width: 40px;
			border-radius: 9px 0 0 9px;
			color: var(--ms-ai);
		}
		.pane.on {
			background: var(--ms-toolbar-hover);
		}
		.count {
			display: flex;
			align-items: center;
			gap: 6px;
			/* Not 100%: the popover wraps its trigger, so there is no height to take a share of. */
			height: 36px;
			padding: 0 9px;
			border-left: 1px solid var(--ms-toolbar-border);
			border-radius: 0 9px 9px 0;
			color: var(--ms-toolbar-muted);
		}
		.pane:hover,
		.count:hover {
			background: var(--ms-toolbar-hover);
			color: var(--ms-toolbar-fg);
		}
		.pane:hover {
			color: var(--ms-ai);
		}
		/* Waiting on the user: magenta, like everything else that is. */
		.n {
			min-width: 20px;
			box-sizing: border-box;
			padding: 0 6px;
			border-radius: 999px;
			background: var(--ms-you);
			color: #ffffff;
			font-size: 11px;
			font-weight: 700;
			line-height: 18px;
			text-align: center;
		}
		.count > .eq {
			height: 11px;
			color: var(--ms-run);
		}

		/* ---- the list ---- */
		.panel {
			width: 400px;
			max-width: calc(100vw - 24px);
			max-height: min(70vh, 560px);
			display: flex;
			flex-direction: column;
			color: var(--ml-color-text);
		}
		.list {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			padding: 6px;
		}
		.group {
			padding: 8px 8px 4px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
		}
		.group.needs {
			color: var(--ml-color-text-link);
		}
		.none {
			padding: 22px 14px;
			text-align: center;
			color: var(--ml-color-text-muted);
		}
		.card {
			display: flex;
			flex-direction: column;
			gap: 4px;
			padding: 8px;
			border-radius: 8px;
		}
		.card:hover {
			background: var(--ms-hover);
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
		.when {
			flex: none;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.meta {
			gap: 12px;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.where {
			min-width: 0;
			display: inline-flex;
			align-items: center;
			gap: 5px;
		}
		.where b {
			font-weight: 600;
			white-space: nowrap;
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
		/* What a conversation is asking for. */
		.said.ask {
			color: var(--ml-color-text-link);
			font-weight: 500;
		}
		.foot {
			padding: 6px;
			border-top: 1px solid var(--ml-color-border);
		}
		.item {
			display: flex;
			align-items: center;
			gap: 9px;
			width: 100%;
			padding: 7px 8px;
			border-radius: 7px;
		}
		.item:hover {
			background: var(--ms-hover);
		}
		.item[disabled] {
			opacity: 0.5;
			pointer-events: none;
		}
		.item ml-icon {
			flex: none;
			color: var(--ml-color-text-muted);
		}
		.grow {
			flex: 1;
			min-width: 0;
		}
		.item small {
			flex: none;
			font-size: 11.5px;
			color: var(--ml-color-text-muted);
		}
	`,
})
export class ClaudeControlComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	@Service(WorkspaceStore) readonly store!: WorkspaceStore;

	elementRef!: HTMLElement;
	/** The list is open. Its rows are only built while it is, and "how long ago" is fresh each time. */
	shown = false;

	@Service(PipelineStore) private readonly _pipelines!: PipelineStore;

	onCreate(): void {
		// Agents report back as events; someone has to be listening from the start, whichever tab is open.
		void this.agents.init();
		// Tasks run their steps whether or not anything shows them.
		this._pipelines.init();
		window.addEventListener('keydown', this.onKey, true);
	}

	onDestroy(): void {
		window.removeEventListener('keydown', this.onKey, true);
	}

	/** Cmd/Ctrl+Shift+K shows or hides the Claude pane. Caught first, so a focused terminal does not get it. */
	private readonly onKey = (e: KeyboardEvent): void => {
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'KeyK') {
			e.preventDefault();
			e.stopPropagation();
			this.store.toggle();
		}
	};

	private close(): void {
		(this.elementRef.shadowRoot?.querySelector('#claude-pop') as (HTMLElement & { component?: { close(): void } }) | null)?.component?.close();
	}

	/** Go to a session: its repository becomes the open one, on the Agents tab, with it selected. */
	go(session: AgentSession): void {
		this.close();
		void this.agents.open(session.id);
	}

	/** Go to a conversation: its repository becomes the open one and the Claude pane shows its tab. */
	goConversation(c: Conversation): void {
		this.close();
		void this.store.open(c.id);
	}

	/** The whole list: the Agents page, every repository's sessions and conversations. */
	everything(): void {
		this.close();
		this.repos.showOverview(true);
	}
}
