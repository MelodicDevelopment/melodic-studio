import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css, repeat } from '@melodicdev/core/template';
import { AgentsStore, nameOf, stateLabel, stateOf, summary, type AgentSession } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import { PipelineStore } from '../../services/pipeline.store';
import { COLUMNS, STEPS, STEP_LABELS, columnOf, kindOf, spentOf, statusOf, type Pipeline } from '../../shared/pipeline';
import { WorkspaceStore, type Conversation } from '../../services/workspace.store';
import { isMac } from '../../services/backend.service';
import { baseName } from '../../services/agent-paths';
import { bucketOf, type Bucket } from '../../shared/attention';
import { relativeTime } from '../../shared/format';
import { CONV_STATE_LABELS } from '../workspace/conversation-state';
import { convAgentState, stateStyles } from './agent-state';

/** One card or row: an agent session or a Claude conversation, with where it stands. */
type Entry = { bucket: Bucket; at: number; key: string; repoId: string } & ({ session: AgentSession; conv?: undefined } | { conv: Conversation; session?: undefined });

/** Every session and conversation of the repositories in the app (or of `repoId` alone), newest first. */
function entries(self: AgentsOverviewComponent): Entry[] {
	const known = new Set((self.repos.app()?.repos ?? []).map((r) => r.id).filter((id) => !self.repoId || id === self.repoId));
	const out: Entry[] = [];
	for (const s of self.agents.sessions()) {
		if (known.has(s.repoId)) {
			out.push({ session: s, key: s.id, repoId: s.repoId, at: s.updated, bucket: bucketOf(stateOf(s), s.unread) });
		}
	}
	for (const c of self.workspace.conversations()) {
		if (c.kind === 'claude' && known.has(c.repoId)) {
			out.push({ conv: c, key: c.id, repoId: c.repoId, at: c.updated, bucket: bucketOf(convAgentState(c), c.unread) });
		}
	}
	return out.sort((a, b) => b.at - a.at);
}

function startOfToday(): number {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function repoChip(self: AgentsOverviewComponent, repoId: string) {
	// The desk shows one repository: naming it on every card says nothing.
	if (self.repoId) {
		return '';
	}
	const repo = self.repos.app()?.repos.find((r) => r.id === repoId);
	return html`<span class="repo" title=${repo?.path ?? repoId}>${repo?.name ?? baseName(repoId)}</span>`;
}

function mark(bucket: Bucket) {
	return bucket === 'working' ? html`<span class="eq" aria-label="Working"><b></b><b></b><b></b></span>` : html`<span class="dot ${bucket}" aria-hidden="true"></span>`;
}

/** A task's six steps as a row of small pads. */
function miniTrack(p: Pipeline) {
	return html`<div class="mini" aria-hidden="true">${STEPS.map((name) => html`<span class="mp ${p.steps[name].state}">${p.steps[name].state === 'run' ? html`<span class="eq"><b></b><b></b><b></b></span>` : ''}${STEP_LABELS[name]}</span>`)}</div>`;
}

/** What a task's card offers for what its pipeline waits on. Shipping opens it: the Merge dialog lives in its pane. */
function pipelineActs(self: AgentsOverviewComponent, s: AgentSession, p: Pipeline) {
	const pipes = self.pipelines;
	const running = s.status === 'running' || (!p.waiting && p.step !== 'done');
	if (running) {
		return html`<ml-button variant="outline" size="sm" @ml:click=${() => void pipes.stop(s.id)}>Stop</ml-button>`;
	}
	if (!p.waiting) {
		return '';
	}
	switch (p.reason) {
		case 'approve':
			return html`${(s.brief?.choices ?? []).map((c) => html`<ml-button variant="outline" size="sm" title="Approve the plan with this answer" @ml:click=${() => void pipes.approve(s.id, c)}>${c}</ml-button>`)}
				<ml-button variant="primary" size="sm" @ml:click=${() => void pipes.approve(s.id)}>Approve plan</ml-button>`;
		case 'ship':
			return html`<ml-button variant="primary" size="sm" title="Open it to merge or open a pull request" @ml:click=${() => self.open(s)}>Ship…</ml-button>`;
		case 'limit':
			return html`<ml-button variant="primary" size="sm" @ml:click=${() => void pipes.oneMoreRound(s.id)}>One more round</ml-button>`;
		default:
			return html`<ml-button variant="primary" size="sm" @ml:click=${() => void pipes.carryOn(s.id)}>Carry on</ml-button>`;
	}
}

/** A task on the board: compact, in the column of the step it is at. */
function boardCard(self: AgentsOverviewComponent, s: AgentSession, p: Pipeline) {
	const running = s.status === 'running' || (!p.waiting && p.step !== 'done');
	const tone = p.waiting ? 'needs' : running ? 'working' : 'done';
	return html`
		<button class="bcard ${tone}" title=${`${s.task ?? s.title}\n\nOpen this task`} @click=${() => self.open(s)}>
			<span class="btop"><span class="bkind">${kindOf(p.kind).name}</span>${repoChip(self, s.repoId)}<span class="grow"></span><span class="bcost">$${spentOf(p, s.cost).toFixed(2)}</span></span>
			<span class="bname">${nameOf(s)}</span>
			<span class="bstat ${tone}">${running ? html`<span class="eq" aria-hidden="true"><b></b><b></b><b></b></span>` : ''}${statusOf(p, s.status === 'running')}</span>
		</button>
	`;
}

/** Every task with a pipeline, in the column of its step: Plan, Code, Review, Test, Fix, Ship, Done. */
function board(self: AgentsOverviewComponent, all: Entry[]) {
	const tasks = all.filter((e): e is Entry & { session: AgentSession } => !!e.session?.pipeline);
	const today = startOfToday();
	const others = all.length - tasks.length;
	return html`
		<div class="boardwrap">
			<div class="board">
				<div class="loopband"><span class="words"><ml-icon icon="arrows-clockwise" size="xs"></ml-icon>The loop: Code → Review → Test → Fix, until every test passes. After 3 fixes it asks you.</span><span class="bracket"></span></div>
				${COLUMNS.map((name, i) => {
					// Done shows today's; older ones are in the list.
					const cards = tasks.filter((e) => columnOf(e.session.pipeline!) === i && (i < 6 || e.at >= today));
					return html`
						<section class="col" aria-label=${name}>
							<h2 class="colh">${name} <span>${cards.length}</span></h2>
							${repeat(
								cards,
								(e) => e.key,
								(e) => boardCard(self, e.session, e.session.pipeline!)
							)}
							${cards.length ? '' : html`<span class="empty">Nothing here</span>`}
						</section>
					`;
				})}
			</div>
			${others ? html`<p class="others">${others} open-ended ${others === 1 ? 'session or conversation is' : 'sessions and conversations are'} in the list.</p>` : ''}
		</div>
	`;
}

/** The box for answering a session from its card, without going to it. */
function replyBox(self: AgentsOverviewComponent, s: AgentSession) {
	return html`
		<div class="reply">
			<ml-input size="sm" placeholder=${`Reply to ${nameOf(s)}`} .value=${self.replyText} @ml:input=${(e: CustomEvent) => (self.replyText = e.detail.value)} @keydown=${(e: KeyboardEvent) => self.replyKey(e, s)}></ml-input>
			<ml-button variant="primary" size="sm" ?disabled=${!self.replyText.trim()} @ml:click=${() => self.sendReply(s)}>Send</ml-button>
			<ml-button variant="ghost" size="sm" @ml:click=${() => self.cancelReply()}>Cancel</ml-button>
		</div>
	`;
}

/** An agent session as a card: its brief, and what can be done about it from here. Claude's words: text bindings only. */
function sessionCard(self: AgentsOverviewComponent, e: Entry & { session: AgentSession }) {
	const s = e.session;
	const sum = summary(s);
	const running = s.status === 'running';
	const investigation = s.kind === 'investigate';
	const lead = sum.needs ?? sum.now ?? (investigation ? stateLabel(s) : sum.did);
	const canReply = !running && !investigation;
	const replying = self.replying === s.id;
	return html`
		<article class="card ${e.bucket}">
			<header>
				${mark(e.bucket)}
				<button class="name" title=${`${s.title}\n\nOpen this agent`} @click=${() => self.open(s)}>${nameOf(s)}${s.group ? html`<small> · attempt ${s.attempt}</small>` : ''}</button>
				<span class="when">${relativeTime(s.updated)}</span>
			</header>
			${s.pipeline ? miniTrack(s.pipeline) : ''}
			<div class="where">${repoChip(self, s.repoId)}${s.kind === 'task' && s.branch ? html`<span class="branch" title=${s.branch}>${s.branch}</span>` : s.kind === 'ask' ? html`<span class="branch">Question</span>` : ''}${s.cost ? html`<span>$${s.cost.toFixed(2)}</span>` : ''}</div>
			${lead ? html`<p class="lead ${sum.needs ? 'needs' : running ? 'now' : ''}">${running && !sum.needs ? html`<span class="eq" aria-hidden="true"><b></b><b></b><b></b></span>` : ''}<span>${lead}</span></p>` : ''}
			${sum.needs && sum.did ? html`<p class="did"><b>Did</b> ${sum.did}</p>` : ''}
			${sum.asked ? html`<p class="asked"><b>Asked</b> ${sum.asked}</p>` : ''}
			${replying
				? replyBox(self, s)
				: s.pipeline
					? html`<div class="acts">${pipelineActs(self, s, s.pipeline)}${canReply ? html`<ml-button variant="outline" size="sm" title="Answer it from here" @ml:click=${() => self.startReply(s)}>Reply…</ml-button>` : ''}<span class="grow"></span><ml-button variant="ghost" size="sm" @ml:click=${() => self.open(s)}>Open<ml-icon slot="icon-end" icon="arrow-right" size="xs"></ml-icon></ml-button></div>`
					: html`
					<div class="acts">
						${sum.choices.map((c) => html`<ml-button variant="primary" size="sm" title="Send this as your reply" @ml:click=${() => void self.agents.send(s.id, c)}>${c}</ml-button>`)}
						${s.review && !running && !sum.choices.length ? html`<ml-button variant="primary" size="sm" title="Go to its checkout, on the Changes tab" @ml:click=${() => self.review(s)}>Review changes</ml-button>` : ''}
						${canReply ? html`<ml-button variant="outline" size="sm" title="Answer it from here" @ml:click=${() => self.startReply(s)}>Reply…</ml-button>` : ''}
						${running ? html`<ml-button variant="outline" size="sm" @ml:click=${() => void self.agents.stop(s.id)}>Stop</ml-button>` : ''}
						${(s.review || s.unread || s.brief?.needs) && !running ? html`<ml-button variant="ghost" size="sm" title="It needs nothing more from you. Its worktree and branch stay." @ml:click=${() => self.agents.markDone(s.id)}>Mark done</ml-button>` : ''}
						<span class="grow"></span>
						<ml-button variant="ghost" size="sm" @ml:click=${() => self.open(s)}>Open<ml-icon slot="icon-end" icon="arrow-right" size="xs"></ml-icon></ml-button>
					</div>
				`}
		</article>
	`;
}

/** A Claude conversation as a card. It lives in a terminal, so it is answered there: Open goes to it. */
function convCard(self: AgentsOverviewComponent, e: Entry & { conv: Conversation }) {
	const c = e.conv;
	const lead = c.state === 'waiting' ? (c.waitingFor ?? 'Needs you') : c.state === 'working' || c.state === 'starting' ? 'Working' : c.lastSaid || CONV_STATE_LABELS[c.state];
	return html`
		<article class="card ${e.bucket}">
			<header>
				${mark(e.bucket)}
				<button class="name" title="Show this conversation in the Claude pane" @click=${() => self.openConversation(c)}>${c.title}</button>
				<span class="when">${relativeTime(c.updated)}</span>
			</header>
			<div class="where">${repoChip(self, c.repoId)}<span class="branch">Claude conversation${c.branch ? ` · ${c.branch}` : ''}</span></div>
			${lead ? html`<p class="lead ${c.state === 'waiting' ? 'needs' : e.bucket === 'working' ? 'now' : ''}"><span>${lead}</span></p>` : ''}
			${c.state === 'waiting' && c.lastSaid ? html`<p class="did"><b>Said</b> ${c.lastSaid}</p>` : ''}
			<div class="acts">
				<span class="grow"></span>
				<ml-button variant=${c.state === 'waiting' ? 'primary' : 'ghost'} size="sm" @ml:click=${() => self.openConversation(c)}>Open<ml-icon slot="icon-end" icon="arrow-right" size="xs"></ml-icon></ml-button>
			</div>
		</article>
	`;
}

/** Something finished: one line. */
function doneRow(self: AgentsOverviewComponent, e: Entry) {
	const s = e.session;
	const name = s ? nameOf(s) : e.conv!.title;
	const said = s ? (s.kind === 'investigate' ? stateLabel(s) : summary(s).did) : (e.conv!.lastSaid ?? '');
	return html`
		<button class="row" title=${s ? 'Open this agent' : 'Show this conversation in the Claude pane'} @click=${() => (s ? self.open(s) : self.openConversation(e.conv!))}>
			<span class="tick" aria-hidden="true"><ml-icon icon="check" size="xs"></ml-icon></span>
			<span class="rname">${name}</span>
			${repoChip(self, e.repoId)}
			<span class="rsaid">${said}</span>
			<span class="when">${relativeTime(e.at)}</span>
		</button>
	`;
}

function section(label: string, key: Bucket, list: Entry[], body: unknown) {
	return list.length ? html`<h2 class="group ${key}">${label} · ${list.length}</h2>${body}` : '';
}

/**
 * The Agents page: every repository's agent sessions and Claude conversations on one page, by how they
 * stand. A card says what the agent was asked, what it did or is doing, and what it needs, and the
 * common answers (a suggested choice, a reply, Mark done, Stop) are given from the card itself; only
 * Open and Review changes go to the repository. Shown by RepoStore.overview in place of the sidebar and
 * panes: the toolbar list's last row, the sidebar's "All repositories", the pinned tab, Cmd/Ctrl+Shift+A.
 * With `repoId` set it is the desk instead: the same cards for one repository, in the Agents tab's main pane.
 */
@MelodicComponent({
	selector: 'ms-agents-overview',
	template: (self: AgentsOverviewComponent) => {
		const all = entries(self);
		const needs = all.filter((e) => e.bucket === 'needs');
		const working = all.filter((e) => e.bucket === 'working');
		const done = all.filter((e) => e.bucket === 'done');
		const today = startOfToday();
		const doneToday = done.filter((e) => e.at >= today);
		const earlier = done.length - doneToday.length;
		const shownDone = self.showEarlier ? done : doneToday;
		const repo = self.repos.repo();
		const card = (e: Entry) => (e.session ? sessionCard(self, e as Entry & { session: AgentSession }) : convCard(self, e as Entry & { conv: Conversation }));
		const cards = (list: Entry[]) => html`<div class="grid">${repeat(list, (e) => e.key, card)}</div>`;
		const desk = !!self.repoId;
		const toggle = html`
			<div class="views" role="group" aria-label="View">
				<button class=${self.view === 'list' ? 'on' : ''} aria-pressed=${self.view === 'list' ? 'true' : 'false'} @click=${() => self.setView('list')}><ml-icon icon="rows" size="xs"></ml-icon>List</button>
				<button class=${self.view === 'board' ? 'on' : ''} aria-pressed=${self.view === 'board' ? 'true' : 'false'} @click=${() => self.setView('board')}><ml-icon icon="kanban" size="xs"></ml-icon>Board</button>
			</div>
		`;
		if (self.view === 'board') {
			return html`
				<div class="page wide ${desk ? 'desk' : ''}">
					<div class="top">
						${desk ? html`<span></span>` : html`<div class="titles"><h1>Agents</h1><p>Every repository's tasks, by the step they are at.</p></div>`}
						<div class="topacts">${toggle}${!desk && repo ? html`<ml-button variant="outline" size="sm" @ml:click=${() => self.repos.showOverview(false)}><ml-icon slot="icon-start" icon="arrow-left"></ml-icon>Back to ${repo.name}</ml-button>` : ''}</div>
					</div>
					${board(self, all)}
				</div>
			`;
		}
		return html`
			<div class="page ${desk ? 'desk' : ''}">
				${desk ? html`<div class="top"><span></span><div class="topacts">${toggle}</div></div>` : ''}
				${desk ? '' : html`<div class="top">
					<div class="titles">
						<h1>Agents</h1>
						<p>Every repository in Melodic Studio. Answer from a card, or open it to see the whole conversation.</p>
					</div>
					<div class="topacts">
						${toggle}
						${repo
							? html`<ml-button variant="outline" size="sm" title=${`Back to ${repo.name} (${isMac() ? '⌘' : 'Ctrl+'}Shift+A)`} @ml:click=${() => self.repos.showOverview(false)}><ml-icon slot="icon-start" icon="arrow-left"></ml-icon>Back to ${repo.name}</ml-button>`
							: ''}
					</div>
				</div>`}
				${needs.length + working.length === 0
					? html`<div class="calm"><h2>Nothing is waiting on you</h2><p>No agent is working either. ${desk ? html`<b>New</b> in the sidebar starts one.` : 'Start one from the Agents tab of a repository.'}</p></div>`
					: ''}
				${section('Needs you', 'needs', needs, cards(needs))}
				${section('Working', 'working', working, cards(working))}
				${done.length
					? html`
						${shownDone.length ? html`<h2 class="group done">${self.showEarlier ? `Done · ${shownDone.length}` : `Done today · ${shownDone.length}`}</h2>` : ''}
						<div class="rows">${repeat(shownDone, (e) => e.key, (e) => doneRow(self, e))}</div>
						${earlier ? html`<button class="more" @click=${() => (self.showEarlier = !self.showEarlier)}>${self.showEarlier ? 'Show today only' : shownDone.length ? `Show ${earlier} earlier` : `Show ${earlier} finished earlier`}</button>` : ''}
					`
					: ''}
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: block;
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			background: var(--ml-color-background);
		}
		${stateStyles}
		.grow {
			flex: 1;
			min-width: 0;
		}
		.page {
			max-width: 1240px;
			margin: 0 auto;
			padding: 24px 28px 40px;
			display: flex;
			flex-direction: column;
			gap: 10px;
		}
		.page.desk {
			max-width: none;
			margin: 0;
			padding: 14px 20px 28px;
			gap: 6px;
		}
		.page.desk .calm {
			padding-top: 8px;
		}
		.top {
			display: flex;
			flex-wrap: wrap;
			align-items: flex-start;
			justify-content: space-between;
			gap: 12px 24px;
			margin-bottom: 6px;
		}
		h1 {
			margin: 0 0 2px;
			font-family: var(--ms-font-display);
			font-size: 24px;
			font-weight: 600;
			letter-spacing: -0.01em;
		}
		.titles p {
			margin: 0;
			color: var(--ml-color-text-muted);
		}
		.calm {
			padding: 28px 0 8px;
		}
		.calm h2 {
			margin: 0 0 4px;
			font-family: var(--ms-font-display);
			font-size: 18px;
			font-weight: 600;
		}
		.calm p {
			margin: 0;
			color: var(--ml-color-text-muted);
		}
		.group {
			margin: 14px 0 2px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
		}
		.group.needs {
			color: var(--ml-color-text-link);
		}
		.grid {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
			gap: 12px;
		}
		.card {
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 8px;
			padding: 12px 14px;
			border: 1px solid var(--ml-color-border);
			border-radius: 10px;
			background: var(--ml-color-surface-raised);
		}
		.card.needs {
			border-color: color-mix(in srgb, var(--ms-you) 45%, var(--ml-color-border));
		}
		.card header {
			display: flex;
			align-items: center;
			gap: 9px;
			min-width: 0;
		}
		.name {
			all: unset;
			flex: 1;
			min-width: 0;
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			cursor: pointer;
		}
		.name small {
			font-weight: 400;
			color: var(--ml-color-text-muted);
		}
		.name:hover {
			text-decoration: underline;
		}
		.name:focus-visible,
		.row:focus-visible,
		.more:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: 2px;
			border-radius: 4px;
		}
		.when {
			flex: none;
			font-size: 12px;
			color: var(--ml-color-text-subtle);
			white-space: nowrap;
		}
		.dot {
			flex: none;
			width: 8px;
			height: 8px;
			margin: 0 3px;
			border-radius: 50%;
			background: var(--ml-color-text-subtle);
		}
		.dot.needs {
			background: var(--ms-you);
		}
		header > .eq {
			flex: none;
			color: var(--ms-run);
		}
		.where {
			display: flex;
			align-items: center;
			gap: 8px;
			min-width: 0;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.repo {
			flex: none;
			max-width: 50%;
			padding: 0 7px;
			border-radius: 5px;
			background: var(--ms-hover);
			color: var(--ml-color-text-secondary);
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.branch {
			min-width: 0;
			font-family: var(--ml-font-mono);
			font-size: 11.5px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		p {
			margin: 0;
			min-width: 0;
			overflow-wrap: anywhere;
		}
		.lead {
			display: flex;
			align-items: baseline;
			gap: 8px;
			font-size: 14px;
			color: var(--ml-color-text);
		}
		.lead .eq {
			flex: none;
			align-self: center;
		}
		.lead.needs {
			color: var(--ml-color-text-link);
			font-weight: 500;
		}
		.lead.now {
			color: var(--ms-run-text);
		}
		.did,
		.asked {
			font-size: 12.5px;
			color: var(--ml-color-text-muted);
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
		}
		.did b,
		.asked b {
			font-weight: 600;
			font-size: 10.5px;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: var(--ml-color-text-subtle);
			margin-right: 4px;
		}
		.acts,
		.reply {
			margin-top: auto;
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 6px;
		}
		.reply ml-input {
			flex: 1 1 180px;
			min-width: 0;
		}
		.rows {
			display: flex;
			flex-direction: column;
		}
		.row {
			all: unset;
			display: flex;
			align-items: center;
			gap: 10px;
			min-width: 0;
			padding: 7px 8px;
			border-radius: 7px;
			cursor: pointer;
		}
		.row:hover {
			background: var(--ms-hover);
		}
		.tick {
			flex: none;
			display: inline-flex;
			color: var(--ml-color-text-subtle);
		}
		.rname {
			flex: 0 1 auto;
			max-width: 38%;
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.rsaid {
			flex: 1;
			min-width: 0;
			font-size: 12.5px;
			color: var(--ml-color-text-muted);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.more {
			all: unset;
			align-self: flex-start;
			padding: 4px 8px;
			font-size: 12.5px;
			color: var(--ml-color-text-muted);
			cursor: pointer;
		}
		.more:hover {
			color: var(--ml-color-text);
		}
		.page.wide {
			max-width: none;
		}
		.topacts {
			display: flex;
			align-items: center;
			gap: 10px;
		}
		.views {
			display: flex;
			gap: 2px;
			padding: 2px;
			border: 1px solid var(--ml-color-border);
			border-radius: 8px;
		}
		.views button {
			all: unset;
			display: inline-flex;
			align-items: center;
			gap: 5px;
			height: 24px;
			padding: 0 10px;
			border-radius: 6px;
			font-size: 12px;
			font-weight: 600;
			color: var(--ml-color-text-muted);
			cursor: pointer;
		}
		.views button.on {
			background: var(--ms-seg-on);
			box-shadow: var(--ms-seg-shadow);
			color: var(--ml-color-text);
		}
		.views button:focus-visible,
		.bcard:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: 2px;
		}
		/* A task's steps on its card. */
		.mini {
			display: grid;
			grid-template-columns: repeat(6, minmax(0, 1fr));
			gap: 3px;
		}
		.mp {
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 4px;
			height: 20px;
			border-radius: 5px;
			font-size: 10.5px;
			font-weight: 600;
			border: 1px dashed var(--ml-color-border-strong);
			color: var(--ml-color-text-subtle);
			overflow: hidden;
		}
		.mp.done {
			border: 1px solid var(--ml-color-border);
			background: var(--ml-color-surface);
			color: var(--ml-color-text-secondary);
		}
		.mp.run {
			border: 1px solid color-mix(in srgb, var(--ms-run) 55%, transparent);
			background: color-mix(in srgb, var(--ms-run) 12%, transparent);
			color: var(--ms-run-text);
		}
		.mp.you {
			border: 1px solid var(--ms-you);
			background: color-mix(in srgb, var(--ms-you) 13%, transparent);
			color: var(--ml-color-text-link);
		}
		.mp.warn {
			border: 1px solid color-mix(in srgb, var(--ml-color-warning) 50%, transparent);
			color: var(--ml-color-warning);
		}
		.mp.skip {
			opacity: 0.5;
			text-decoration: line-through;
		}
		/* ---- the board ---- */
		.boardwrap {
			overflow-x: auto;
			padding-bottom: 6px;
		}
		.board {
			display: grid;
			grid-template-columns: repeat(7, minmax(180px, 1fr));
			gap: 10px;
		}
		.loopband {
			grid-row: 1;
			grid-column: 2 / span 4;
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 3px;
		}
		.loopband .words {
			display: inline-flex;
			align-items: center;
			gap: 5px;
			font-size: 11.5px;
			font-weight: 600;
			color: var(--ms-run-text);
			text-align: center;
		}
		.loopband .bracket {
			align-self: stretch;
			height: 8px;
			border: 2px solid color-mix(in srgb, var(--ms-run) 50%, transparent);
			border-bottom: 0;
			border-radius: 7px 7px 0 0;
		}
		.col {
			grid-row: 2;
			min-width: 0;
			min-height: 260px;
			display: flex;
			flex-direction: column;
			gap: 8px;
			padding: 10px;
			border: 1px solid var(--ml-color-border-muted);
			border-radius: 12px;
			background: var(--ml-color-surface);
		}
		.colh {
			margin: 0 2px 2px;
			font-family: var(--ms-font-display);
			font-size: 14px;
			font-weight: 600;
		}
		.colh span {
			font-family: var(--ml-font-sans);
			font-size: 12px;
			font-weight: 500;
			color: var(--ml-color-text-muted);
		}
		.empty {
			padding: 12px 6px;
			border: 1px dashed var(--ml-color-border);
			border-radius: 8px;
			font-size: 12px;
			text-align: center;
			color: var(--ml-color-text-subtle);
		}
		.bcard {
			all: unset;
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 10px;
			border-radius: 9px;
			border: 1px solid var(--ml-color-border);
			background: var(--ml-color-surface-raised);
			cursor: pointer;
		}
		.bcard.needs {
			border-color: var(--ms-you);
		}
		.bcard.working {
			border-color: color-mix(in srgb, var(--ms-run) 45%, var(--ml-color-border));
		}
		.bcard.done {
			opacity: 0.8;
		}
		.bcard:hover {
			background: var(--ms-hover);
		}
		.btop {
			display: flex;
			align-items: center;
			gap: 6px;
			min-width: 0;
		}
		.bkind {
			flex: none;
			padding: 0 7px;
			border-radius: 999px;
			background: var(--ms-hover);
			font-size: 11px;
			font-weight: 600;
			color: var(--ml-color-text-secondary);
		}
		.bcost {
			flex: none;
			font-family: var(--ml-font-mono);
			font-size: 11px;
			color: var(--ml-color-text-muted);
		}
		.bname {
			font-weight: 600;
			line-height: 1.35;
			overflow-wrap: anywhere;
		}
		.bstat {
			display: flex;
			align-items: center;
			gap: 6px;
			font-size: 12px;
			line-height: 1.35;
			color: var(--ml-color-text-muted);
		}
		.bstat.needs {
			color: var(--ml-color-text-link);
		}
		.bstat.working {
			color: var(--ms-run-text);
		}
		.others {
			margin-top: 10px;
			font-size: 12.5px;
			color: var(--ml-color-text-muted);
		}
	`,
})
export class AgentsOverviewComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	@Service(WorkspaceStore) readonly workspace!: WorkspaceStore;
	@Service(PipelineStore) readonly pipelines!: PipelineStore;

	/** List or board, remembered (localStorage `studio.agents.view`). */
	view: 'list' | 'board' = (() => {
		try {
			return localStorage.getItem('studio.agents.view') === 'board' ? 'board' : 'list';
		} catch {
			return 'list';
		}
	})();

	setView(view: 'list' | 'board'): void {
		this.view = view;
		try {
			localStorage.setItem('studio.agents.view', view);
		} catch {
			/* it holds for this run */
		}
	}

	/**
	 * Set: the desk, the Agents tab's main pane while no session is open, listing this repository only,
	 * with no page title or repository chips. Unset: the Agents page, every repository.
	 */
	repoId: string | null = null;
	/** Finished ones from before today too. Memory only. */
	showEarlier = false;
	/** The session whose card shows the reply box, and what is typed in it. */
	replying: string | null = null;
	replyText = '';

	onCreate(): void {
		void this.agents.init();
	}

	open(s: AgentSession): void {
		this.repos.showOverview(false);
		void this.agents.open(s.id);
	}

	review(s: AgentSession): void {
		this.repos.showOverview(false);
		void this.agents.review(s);
	}

	openConversation(c: Conversation): void {
		this.repos.showOverview(false);
		void this.workspace.open(c.id);
	}

	startReply(s: AgentSession): void {
		this.replying = s.id;
		this.replyText = '';
		// The box is there after this render.
		requestAnimationFrame(() => (this.elementRef.shadowRoot?.querySelector('.reply ml-input') as HTMLElement | null)?.focus());
	}

	cancelReply(): void {
		this.replying = null;
		this.replyText = '';
	}

	sendReply(s: AgentSession): void {
		const text = this.replyText.trim();
		if (!text) {
			return;
		}
		this.cancelReply();
		void (s.pipeline ? this.pipelines.message(s.id, text) : this.agents.send(s.id, text));
	}

	replyKey(e: KeyboardEvent, s: AgentSession): void {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			this.sendReply(s);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			this.cancelReply();
		}
	}

	elementRef!: HTMLElement;
}
