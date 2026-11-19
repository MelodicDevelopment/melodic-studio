import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { AgentsStore, scopeOf, type AgentSession, type WorkCheck } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import { LspService } from '../../services/lsp.service';
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
	// Accepting an investigation's fix commits it first (as the user, with this message), then merges like any agent's branch.
	const fix = s.kind === 'investigate';
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
			<h3 slot="dialog-header">${fix ? 'Accept the fix' : `Merge ${s.branch ?? ''}`}</h3>
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
				${fix && uncommitted
					? html`<ml-input label="Commit message" hint=${`The fix is committed on ${s.branch ?? 'its branch'} as you, then merged.`} .value=${self.fixMessage} @ml:input=${(e: CustomEvent) => (self.fixMessage = e.detail.value)}></ml-input>`
					: uncommitted
						? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>The agent's worktree has ${uncommitted} uncommitted ${uncommitted === 1 ? 'change' : 'changes'}. Only committed work is merged: review and commit first.</span></p>`
						: ''}
				${pr ? html`<p class="hint">Branch protected? Push ${s.branch} and open a ${pr} instead.</p>` : ''}
			</div>
			<div slot="dialog-footer" class="foot">
				${pr ? html`<ml-button variant="outline" @ml:click=${() => self.openPr(s)}><ml-icon slot="icon-start" icon="git-pull-request"></ml-icon>Open a ${pr}…</ml-button>` : ''}
				<span class="grow"></span>
				<ml-button variant="outline" @ml:click=${() => self.closeMerge()}>Cancel</ml-button>
				<ml-button variant="primary" ?disabled=${!target || blocked || (creating && !self.newFrom) || (fix && !!uncommitted && !self.fixMessage.trim())} ?loading=${self.repos.busy() === 'merge' || self.accepting} @ml:click=${() => self.merge(s, fix && !!uncommitted)}>${fix ? 'Commit and merge' : 'Merge'}</ml-button>
			</div>
		</ml-dialog>
	`;
}

/** Main pane of the Agents tab: one session's transcript and the box to send it more, a new question, or a comparison of attempts. */
/** How many of the errors, and of the places something is used, are listed before "and N more". */
const PROBLEMS_SHOWN = 6;
/** The transcript shows its last items; a long one is not rendered whole on every streamed event. */
const SHOWN_ITEMS = 300;
const USES_SHOWN = 8;

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "the 3 files it changed and 2 that use them" */
function looked(check: WorkCheck): string {
	const changed = check.files === 1 ? 'the file it changed' : `the ${check.files} files it changed`;
	return check.users ? `${changed} and ${check.users} that use ${check.files === 1 ? 'it' : 'them'}` : changed;
}

/** What the change touched that the rest of the code uses: folded away until asked for. */
function impactList(self: AgentSessionComponent, s: AgentSession, check: WorkCheck) {
	const uses = check.impact.flatMap((i) => i.uses.map((use) => ({ ...use, symbol: i.symbol })));
	if (!uses.length) {
		return '';
	}
	const names = check.impact.map((i) => i.symbol);
	return html`
		<details>
			<summary>It changed <b>${names.slice(0, 3).join(', ')}</b>${names.length > 3 ? ` and ${names.length - 3} more` : ''}, used in ${count(uses.length, 'place')} it did not touch</summary>
			<ul>
				${uses.slice(0, USES_SHOWN).map((use) => html`<li><button title="Open in the Files tab of this agent's checkout" @click=${() => self.agents.openPlace(s, use.path, use.line)}>${use.path}:${use.line}</button><span>uses ${use.symbol}</span></li>`)}
				${uses.length > USES_SHOWN ? html`<li class="more">and ${uses.length - USES_SHOWN} more</li>` : ''}
			</ul>
		</details>
	`;
}

/**
 * What the language servers made of the task's change, between the header and the transcript.
 * Their messages are compiler output, and so are symbol names: text bindings only.
 */
function checkStrip(self: AgentSessionComponent, s: AgentSession) {
	const check = s.check;
	if (!check || s.kind !== 'task') {
		return '';
	}
	if (check.state === 'checking') {
		// What the server says it is busy with ("cargo check"), when it says.
		const work = self.lsp.workAt(s.cwd)[0];
		const doing = work ? ` (${[work.label, work.title].filter(Boolean).join(': ')})` : '';
		return html`<div class="check"><ml-spinner size="xs"></ml-spinner><span>Checking the change with the language server${doing}…</span></div>`;
	}
	// Kept short: the pane is often narrow. The server's name says whose verdict it is.
	const servers = `(${check.servers.join(', ')})`;
	const partial = check.finished ? '' : ' The language server was still working when the time ran out, so there may be more.';
	const known = check.known ? ` ${count(check.known, 'error was', 'errors were')} already there.` : '';
	const found = check.problems;
	if (!found.length) {
		return html`
			<div class="check ok">
				<div class="line"><ml-icon icon="check-circle" size="sm"></ml-icon><span class="grow" title="From the language server: the files as the agent left them, compared with the commit it started from">No new errors in ${looked(check)} ${servers}.${known}${partial}</span></div>
				${impactList(self, s, check)}
			</div>
		`;
	}
	const running = s.status === 'running';
	return html`
		<div class="check bad">
			<div class="line">
				<ml-icon icon="warning" size="sm"></ml-icon>
				<span class="grow" title="From the language server: the files as the agent left them, compared with the commit it started from"><b>${count(found.length, 'new error')}</b> in ${looked(check)} ${servers}.${known}${partial}</span>
				<ml-button variant="primary" size="sm" ?disabled=${running} title="Sends this list to the agent as its next turn" @ml:click=${() => self.agents.fixProblems(s.id)}>Ask Claude to fix ${found.length === 1 ? 'it' : 'them'}</ml-button>
			</div>
			<ul>
				${found.slice(0, PROBLEMS_SHOWN).map(
					(p) => html`<li><button title="Open in the Files tab of this agent's checkout" @click=${() => self.agents.openPlace(s, p.path, p.line, p.column)}>${p.path}:${p.line}</button>${p.changed ? '' : html`<i>a file it did not change</i>`}<span class="said" title=${p.message}>${p.message.split('\n')[0]}</span></li>`
				)}
				${found.length > PROBLEMS_SHOWN ? html`<li class="more">and ${found.length - PROBLEMS_SHOWN} more</li>` : ''}
			</ul>
			${impactList(self, s, check)}
		</div>
	`;
}

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
		const tree = agents.worktrees().find((w) => samePath(w.path, s.cwd));
		if (s.kind === 'investigate') {
			// Its own view: the checklist while it runs, then the report and Replay. The Merge dialog is the same one.
			return html`
				<ms-investigation @accept=${() => self.openMerge(s)} @discard=${() => self.askDiscard()}></ms-investigation>
				${mergeDialog(self, s, tree?.changes ?? 0)}
				<ml-dialog #investigate-discard style="--ml-dialog-max-width: 460px">
					<h3 slot="dialog-header">Discard this investigation</h3>
					<div class="dlg"><p>Its worktree and the branch <b>${s.branch ?? ''}</b> are deleted, with the fix and the recordings in them. Your own checkout was never changed, so nothing there is lost.</p></div>
					<div slot="dialog-footer" class="foot">
						<span class="grow"></span>
						<ml-button variant="outline" @ml:click=${() => self.closeDialog('investigate-discard')}>Cancel</ml-button>
						<ml-button variant="danger" @ml:click=${() => self.discard(s)}>Discard</ml-button>
					</div>
				</ml-dialog>
			`;
		}
		const running = s.status === 'running';
		const ask = s.kind === 'ask';
		// Items before this one wait behind "Show earlier".
		const hidden = Math.max(0, s.items.length - SHOWN_ITEMS - self.earlier);
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
			${checkStrip(self, s)}

			<div class="log">
				${hidden ? html`<button class="earlier" @click=${() => self.showEarlier()}>Show earlier (${hidden.toLocaleString('en-US')} more)</button>` : ''}
				${s.items.slice(hidden).map((item) =>
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
		ms-attempts,
		ms-investigation {
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
		.check {
			flex: none;
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px 16px;
			border-bottom: 1px solid var(--ml-color-border);
			font-size: 12.5px;
			color: var(--ml-color-text-secondary);
		}
		.check.ok ml-icon {
			flex: none;
			color: var(--ml-color-success);
		}
		.check.ok,
		.check.bad {
			flex-direction: column;
			align-items: stretch;
			gap: 6px;
		}
		.check.bad {
			background: var(--ml-color-warning-subtle);
			color: var(--ml-color-text);
		}
		/* The button drops under the sentence when the pane is too narrow for both. */
		.check .line {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 6px 8px;
		}
		.check .line .grow {
			flex: 1 1 220px;
		}
		.check details {
			padding-left: 24px;
		}
		.check summary {
			cursor: pointer;
			color: var(--ml-color-text-secondary);
		}
		.check details ul {
			padding: 4px 0 2px 14px;
		}
		.check.bad .line ml-icon {
			flex: none;
			color: var(--ml-color-warning);
		}
		.check ul {
			margin: 0;
			padding: 0 0 2px 24px;
			list-style: none;
			display: flex;
			flex-direction: column;
			gap: 3px;
		}
		.check li {
			display: flex;
			gap: 10px;
			min-width: 0;
		}
		.check li button {
			flex: none;
			padding: 0;
			border: 0;
			background: none;
			font: inherit;
			font-family: var(--ml-font-mono);
			color: var(--ml-color-primary);
			cursor: pointer;
		}
		.check li button:hover {
			text-decoration: underline;
		}
		.check li span {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.check li i {
			flex: none;
			font-style: normal;
			color: var(--ml-color-text-muted);
		}
		/* An error's message gets a line of its own: it is what matters, and the pane is often narrow. */
		.check li:has(.said) {
			flex-wrap: wrap;
			gap: 0 10px;
		}
		.check li .said {
			flex: 1 1 100%;
		}
		.check li.more {
			color: var(--ml-color-text-muted);
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
		.earlier {
			all: unset;
			align-self: center;
			flex: none;
			padding: 4px 12px;
			border: 1px solid var(--ml-color-border);
			border-radius: 999px;
			font-size: 12px;
			color: var(--ml-color-text-secondary);
			user-select: none;
			-webkit-user-select: none;
		}
		.earlier:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
		.earlier:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: 1px;
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
	@Service(LspService) readonly lsp!: LspService;
	@Service(DialogService) private readonly _dialogs!: DialogService;
	elementRef!: HTMLElement;

	draft = '';
	/** Merge dialog: the branch picked (or NEW_BRANCH), and the new branch's name and starting point. */
	into = '';
	newName = '';
	newFrom = '';
	/** Accept fix: the message the fix is committed with, and whether that commit is being made. */
	fixMessage = '';
	accepting = false;
	/** How many more items than the last `SHOWN_ITEMS` the transcript shows ("Show earlier"). */
	earlier = 0;
	private _seen = 0;
	private _shown: string | null = null;
	/** Set by "Show earlier": how far the view was from the end, to put it back there once the older items are in. */
	private _fromEnd: number | null = null;

	/** Older items come in above what is on screen, which stays where it is. */
	showEarlier(): void {
		const log = this.elementRef.shadowRoot?.querySelector('.log');
		this._fromEnd = log ? log.scrollHeight - log.scrollTop : null;
		this.earlier += SHOWN_ITEMS;
	}

	/** Keep the newest message in view as the transcript grows, and count what is on screen as read. */
	onRender(): void {
		const agents = this.agents;
		const s = agents.asking() || agents.comparing() ? null : agents.selected();
		const count = s?.items.length ?? 0;
		const log = this.elementRef.shadowRoot?.querySelector('.log');
		if ((s?.id ?? null) !== this._shown && this.earlier) {
			this.earlier = 0; // another session starts from its last items again
		}
		if (this._fromEnd !== null) {
			if (log) {
				log.scrollTop = log.scrollHeight - this._fromEnd;
			}
			this._fromEnd = null;
			this._seen = count;
		} else if (count !== this._seen || (s?.id ?? null) !== this._shown) {
			this._seen = count;
			this._shown = s?.id ?? null;
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
		// A commit subject from the cause: its first clause, cut at a word. The user edits it in the dialog.
		const cause = (s.investigation?.report?.summary ?? s.title).split('\n')[0];
		const clause = cause.split(/[:;.]\s|,\s(?:and|which|so)\s/)[0];
		this.fixMessage = `Fix: ${clause.length > 66 ? `${clause.slice(0, 66).replace(/\s+\S*$/, '')}…` : clause}`;
		this._dialogs.open('agent-merge' as DialogId);
	}

	closeDialog(id: string): void {
		this._dialogs.close(id as DialogId);
	}

	askDiscard(): void {
		this._dialogs.open('investigate-discard' as DialogId);
	}

	async discard(s: AgentSession): Promise<void> {
		this.closeDialog('investigate-discard');
		await this.agents.discard(s);
	}

	closeMerge(): void {
		this._dialogs.close('agent-merge' as DialogId);
	}

	async merge(s: AgentSession, commitFirst = false): Promise<void> {
		const creating = this.into === NEW_BRANCH;
		const into = creating ? this.newName.trim() : this.into;
		if (commitFirst) {
			const test = s.investigation?.report?.test;
			this.accepting = true;
			const committed = await this.agents.commitFix(s, this.fixMessage.trim(), test ? `Adds the test ${test.name}.` : '');
			this.accepting = false;
			if (!committed) {
				return;
			}
		}
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
