import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { AgentsStore, scopeOf, type AgentSession } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import type { AgentMode } from '../../services/backend.service';
import { samePath } from '../../services/agent-paths';
import { AGENT_MODES } from './agents.component';
import { richText, richTextStyles, type RichOptions } from './rich-text';

const TOOL_ICONS: Record<string, string> = { Read: 'file-text', Edit: 'pencil-simple', Write: 'file-plus', Bash: 'terminal-window', Grep: 'magnifying-glass', Glob: 'magnifying-glass', WebFetch: 'globe', WebSearch: 'globe', Task: 'robot', Agent: 'robot' };

/** Which references in a session's answers become links. They open in the checkout on screen, so a task's only count while its checkout is that one. */
function linking(self: AgentSessionComponent, s: AgentSession): RichOptions {
	const repo = self.repos.repo();
	const here = !!repo && repo.id === s.repoId && samePath(s.cwd, repo.worktree ?? repo.path);
	return { files: s.kind === 'ask' || here, commits: s.kind === 'ask' && scopeOf(s) === 'history', root: s.cwd };
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
				${!ask && s.isolated && mainBranch && mainBranch !== s.branch
					? html`<ml-button variant="outline" size="sm" ?disabled=${running || !!self.repos.busy()} title=${`Merge ${s.branch} into ${mainBranch}. Commit the agent's work first.`} @ml:click=${() => agents.merge(s)}><ml-icon slot="icon-start" icon="git-merge"></ml-icon>Merge into ${mainBranch}</ml-button>`
					: ''}
			</div>

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
	`,
})
export class AgentSessionComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	elementRef!: HTMLElement;

	draft = '';
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
