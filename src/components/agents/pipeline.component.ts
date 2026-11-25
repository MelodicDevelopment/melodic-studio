import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { AgentsStore, type AgentSession } from '../../services/agents.store';
import { PipelineStore } from '../../services/pipeline.store';
import { DEFAULT_MODELS, MODELS, STEPS, STEP_LABELS, kindOf, loopWords, modelFor, spentOf, type ClaudeStep, type Pipeline, type StepName, type StepRecord } from '../../shared/pipeline';
import { evidenceOf, evidenceText, hasEvidence, type Evidence, type Mark, type Proof, type ProofLine } from '../../shared/evidence';
import { relativeTime } from '../../shared/format';
import { richText } from './rich-text';

/** What each of Claude's steps does, after the model's name. */
const DOES: Record<ClaudeStep, string> = { plan: 'writes the plan, reads only', code: 'commits and pushes to its branch', review: 'read-only', fix: 'then Review and Test again' };

function money(n: number): string {
	return `$${n.toFixed(2)}`;
}

/** Under a pad: what the step cost, or what it is when it has not run. */
function padSub(name: StepName, r: StepRecord): string {
	if (r.state === 'skip') {
		return 'skipped';
	}
	if (name === 'test') {
		return 'free';
	}
	if (name === 'ship') {
		return r.state === 'done' ? 'merged' : 'you';
	}
	return r.cost ? money(r.cost) : r.state === 'run' ? '…' : '';
}

function pad(self: PipelineComponent, s: AgentSession, p: Pipeline, name: StepName, picked: StepName) {
	const r = p.steps[name];
	const state = r.state;
	return html`
		<button class="pad ${state} ${name === picked ? 'on' : ''}" aria-pressed=${name === picked ? 'true' : 'false'} title=${r.summary || STEP_LABELS[name]} @click=${() => self.pick(s.id, name)}>
			<span class="pname">
				${state === 'run' ? html`<span class="eq" aria-hidden="true"><b></b><b></b><b></b></span>` : ''}
				${state === 'done' ? html`<ml-icon icon="check" size="xs"></ml-icon>` : ''}
				${STEP_LABELS[name]}
			</span>
			<span class="psub">${padSub(name, r)}</span>
		</button>
	`;
}

/** Who does a step: Claude with the model to pick, Studio, or the user. */
function who(self: PipelineComponent, s: AgentSession, p: Pipeline, name: StepName) {
	if (name === 'test') {
		return html`<span class="who run">Studio · on this machine, free</span>`;
	}
	if (name === 'ship') {
		return html`<span class="who you">You · merge or pull request</span>`;
	}
	const step = name as ClaudeStep;
	if (p.steps[step].state === 'skip') {
		return html`<span class="who">Not part of a ${kindOf(p.kind).name.toLowerCase()}</span>`;
	}
	const model = modelFor(p, step);
	const changed = model !== DEFAULT_MODELS[step];
	return html`
		<span class="who ai">
			<label for="model-${step}">Claude</label>
			<span class="pick">
				<select id="model-${step}" .value=${model} ?disabled=${p.step === 'done'} title=${changed ? `Changed from ${DEFAULT_MODELS[step]} for this task` : 'The model for this step of this task'} @change=${(e: Event) => self.pipelines.setModel(s.id, step, (e.target as HTMLSelectElement).value)}>
					${MODELS.map((m) => html`<option value=${m.id} ?selected=${m.id === model}>${m.name}</option>`)}
				</select>
				<ml-icon icon="caret-down" size="xs"></ml-icon>
			</span>
			<span>${DOES[step]}</span>
		</span>
	`;
}

/** The buttons for what the pipeline is waiting on. `said`: its note is already said by what is around it (the evidence's verdict at Ship). */
function waiting(self: PipelineComponent, s: AgentSession, p: Pipeline, said = false) {
	const pipes = self.pipelines;
	const choices = p.reason === 'approve' ? (s.brief?.choices ?? []) : [];
	return html`
		<div class="ask">
			${said ? '' : html`<p>${p.note}</p>`}
			${choices.length
				? html`<div class="acts">${choices.map((c) => html`<ml-button variant="outline" size="sm" title="Approve the plan with this answer" @ml:click=${() => void pipes.approve(s.id, c)}>${c}</ml-button>`)}</div>`
				: ''}
			<div class="acts">
				${p.reason === 'approve'
					? html`<ml-button variant="primary" size="sm" @ml:click=${() => void pipes.approve(s.id)}>Approve plan</ml-button>
						<span class="hint">Or write changes to the plan in the box below.</span>`
					: p.reason === 'ship'
						? html`<ml-button variant="primary" size="sm" @ml:click=${() => self.emit('merge')}><ml-icon slot="icon-start" icon="git-merge"></ml-icon>Merge…</ml-button>
							<ml-button variant="outline" size="sm" @ml:click=${() => self.emit('pr')}><ml-icon slot="icon-start" icon="git-pull-request"></ml-icon>Open a pull request…</ml-button>
							<ml-button variant="outline" size="sm" @ml:click=${() => void self.agents.review(s)}><ml-icon slot="icon-start" icon="git-diff"></ml-icon>See the changes</ml-button>`
						: p.reason === 'limit'
							? html`<ml-button variant="primary" size="sm" @ml:click=${() => void pipes.oneMoreRound(s.id)}>One more round</ml-button>
								<ml-button variant="outline" size="sm" title="Go to its worktree, on the Changes tab" @ml:click=${() => void self.agents.review(s)}>Take over</ml-button>
								<ml-button variant="ghost" size="sm" title="It needs nothing more. Its worktree and branch stay." @ml:click=${() => self.agents.markDone(s.id)}>Mark done</ml-button>`
							: html`<ml-button variant="primary" size="sm" @ml:click=${() => void pipes.carryOn(s.id)}>Carry on</ml-button>
								<ml-button variant="outline" size="sm" title="Go to its worktree, on the Changes tab" @ml:click=${() => void self.agents.review(s)}>Take over</ml-button>`}
			</div>
		</div>
	`;
}

/** Give the task up: an inline yes/no, since it deletes the worktree and the branch. */
function discard(self: PipelineComponent, s: AgentSession) {
	if (self.discarding !== s.id) {
		return html`<div class="foot"><button class="discard" @click=${() => (self.discarding = s.id)}>Discard task…</button></div>`;
	}
	return html`
		<div class="confirm">
			<p>Stop it and delete its worktree and the branch <b>${s.branch ?? ''}</b>, here and on the remote? Nothing is merged, and work that is not merged is lost.</p>
			<div class="acts">
				<ml-button variant="danger" size="sm" @ml:click=${() => ((self.discarding = null), void self.pipelines.discard(s.id))}>Discard</ml-button>
				<ml-button variant="ghost" size="sm" @ml:click=${() => (self.discarding = null)}>Keep it</ml-button>
			</div>
		</div>
	`;
}

const MARK_ICONS: Record<Exclude<Mark, 'run'>, string> = { ok: 'check-circle', warn: 'warning', bad: 'warning-circle', none: 'minus-circle' };
const MARK_WORDS: Record<Mark, string> = { ok: 'Passed', warn: 'Passed, with something to judge', bad: 'Found a problem', none: 'Not checked', run: 'Checking now' };

function mark(m: Mark) {
	return html`<span class="mark ${m}" role="img" aria-label=${MARK_WORDS[m]} title=${MARK_WORDS[m]}>${m === 'run' ? html`<span class="eq" aria-hidden="true"><b></b><b></b><b></b></span>` : html`<ml-icon icon=${MARK_ICONS[m]} size="sm"></ml-icon>`}</span>`;
}

/** A line of a proof: a place in the task's checkout opens there. Its words are a program's or Claude's: text only. */
function proofLine(self: PipelineComponent, s: AgentSession, l: ProofLine) {
	const place = l.place;
	return html`<li>${place ? html`<button class="place" title="Open it in the task's checkout" @click=${() => void self.agents.openPlace(s, place.path, place.line)}>${l.text}</button>` : l.text}${l.detail ? html`<span class="more">${l.detail}</span>` : ''}</li>`;
}

function proof(self: PipelineComponent, s: AgentSession, x: Proof) {
	const head = html`${mark(x.mark)}<span class="ptitle">${x.title}</span><span class="says">${x.says}</span>`;
	if (!x.lines.length && !x.printed) {
		return html`<div class="proof" data-proof=${x.id}><div class="phead">${head}</div></div>`;
	}
	return html`
		<details class="proof" data-proof=${x.id}>
			<summary class="phead">${head}<ml-icon class="chev" icon="caret-right" size="xs"></ml-icon></summary>
			<div class="pbody">
				${x.lines.length ? html`<ul>${x.lines.map((l) => proofLine(self, s, l))}</ul>` : ''}
				${x.printed ? html`<pre>${x.printed}</pre>` : ''}
			</div>
		</details>
	`;
}

/**
 * Why the change can be trusted, on the Ship step: one verdict, then what nothing checked and whether the
 * work moved since, then each proof (`shared/evidence.ts`). Shown as soon as a check has run. `ask` is what
 * the step waits with (Merge…, Open a pull request…): it sits under the verdict and above the proofs, so the
 * buttons are never scrolled away by what proves them.
 */
function evidence(self: PipelineComponent, s: AgentSession, p: Pipeline, ask: unknown) {
	const e: Evidence = evidenceOf({ pipeline: p, check: s.check, checksOn: self.agents.checksOn(), tree: self.pipelines.trees()[s.id] ?? null });
	return html`
		<div class="ev ${e.mark}">
			<div class="verdict">
				${mark(e.mark)}
				<strong>${e.headline}</strong>
				<span class="grow"></span>
				${e.at ? html`<span class="when" title=${new Date(e.at).toLocaleString()}>Checked ${relativeTime(e.at)}${e.head ? html` at <code>${e.head.slice(0, 7)}</code>` : ''}</span>` : ''}
			</div>
			${e.stale
				? html`<div class="stale">
						<p>${e.stale} What is below is about the work as it was.</p>
						<ml-button variant="outline" size="sm" title="Commit what is in the worktree, then review and test it again" @ml:click=${() => void self.pipelines.recheck(s.id)}><ml-icon slot="icon-start" icon="arrows-clockwise"></ml-icon>Check again</ml-button>
					</div>`
				: ''}
			${e.gaps.length ? html`<ul class="gaps" aria-label="What nothing checked">${e.gaps.map((g) => html`<li>${g}</li>`)}</ul>` : ''}
			${ask}
			<div class="proofs">${e.proofs.map((x) => proof(self, s, x))}</div>
			<div class="evfoot">
				<button class="copy" title="The verdict, each proof in a line and what was not checked, as text: for a pull request or a message" @click=${() => self.copy(s.id, evidenceText(e))}>${self.copied === s.id ? 'Copied' : 'Copy as text'}</button>
			</div>
		</div>
	`;
}

function detail(self: PipelineComponent, s: AgentSession, p: Pipeline, name: StepName) {
	const r = p.steps[name];
	const here = p.step === name;
	const running = here && !p.waiting && (r.state === 'run' || s.status === 'running');
	const links = { files: false, commits: false, root: s.cwd };
	return html`
		<section class="detail">
			<header>
				<h3>${STEP_LABELS[name]}</h3>
				${who(self, s, p, name)}
				<span class="grow"></span>
				${name !== 'test' && name !== 'ship' && r.cost ? html`<span class="cost">${money(r.cost)}</span>` : ''}
			</header>
			${r.summary && !(here && p.waiting && r.summary.startsWith(p.note ?? '\u0000'))
				? html`<p class="sum">${r.summary}</p>`
				: r.summary || (here && p.waiting)
					? ''
					: html`<p class="sum dim">${r.state === 'skip' ? 'This kind of work leaves this step out.' : r.state === 'run' ? 'Starting…' : name === 'ship' && hasEvidence(p) ? 'Not reached yet. The checks so far:' : 'Not reached yet.'}</p>`}
			${name === 'plan' && p.plan ? html`<div class="plan">${richText(p.plan, links, self.follow(s))}</div>` : ''}
			${r.lines.length ? html`<ul>${r.lines.map((l) => html`<li>${l}</li>`)}</ul>` : ''}
			${name === 'test' && p.tests && !p.tests.ok && p.tests.output ? html`<details><summary>What the tests printed</summary><pre>${p.tests.output}</pre></details>` : ''}
			${name === 'ship' && hasEvidence(p) ? evidence(self, s, p, here && p.waiting ? waiting(self, s, p, p.reason === 'ship') : '') : here && p.waiting ? waiting(self, s, p) : ''}
			${running ? html`<div class="acts"><ml-button variant="outline" size="sm" @ml:click=${() => void self.pipelines.stop(s.id)}>Stop</ml-button></div>` : ''}
			${p.step === 'done' ? '' : discard(self, s)}
		</section>
	`;
}

/**
 * A task's pipeline at the top of its session pane: the six steps as pads (the one picked shows below),
 * the loop under Code to Fix, and the picked step's detail with the model for Claude's steps and the
 * buttons for whatever it waits on. Everything from Claude or a program is text (the plan through rich-text).
 */
@MelodicComponent({
	selector: 'ms-pipeline',
	template: (self: PipelineComponent) => {
		const s = self.agents.sessions().find((x) => x.id === self.sessionId);
		const p = s?.pipeline;
		if (!s || !p) {
			return html`<span hidden></span>`;
		}
		const current: StepName = p.step === 'done' ? 'ship' : p.step;
		// A pick holds while the pipeline stays on the step it was made at; when it moves on, the new step shows.
		const pick = self.picked[s.id];
		const picked = pick && pick.at === current ? pick.step : current;
		return html`
			<div class="wrap">
				<div class="line">
					<span class="kind">${kindOf(p.kind).name}</span>
					<span class="spent">${money(spentOf(p, s.cost))} so far</span>
				</div>
				<div class="track">
					${STEPS.map((name) => pad(self, s, p, name, picked))}
					<div class="loop"><span class="bracket"></span><span class="words"><ml-icon icon="arrows-clockwise" size="xs"></ml-icon>${loopWords(p)}</span></div>
				</div>
				${detail(self, s, p, picked)}
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: block;
			flex: none;
			border-bottom: 1px solid var(--ml-color-border);
			max-height: 55vh;
			overflow-y: auto;
		}
		.wrap {
			display: flex;
			flex-direction: column;
			gap: 12px;
			padding: 12px 16px 14px;
		}
		.grow {
			flex: 1;
		}
		.line {
			display: flex;
			align-items: center;
			gap: 10px;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.kind {
			padding: 1px 8px;
			border-radius: 999px;
			background: var(--ms-hover);
			color: var(--ml-color-text-secondary);
			font-weight: 600;
		}
		.spent {
			font-family: var(--ml-font-mono);
		}
		.track {
			display: grid;
			grid-template-columns: repeat(6, minmax(0, 1fr));
			gap: 6px;
		}
		.pad {
			all: unset;
			grid-row: 1;
			display: flex;
			flex-direction: column;
			gap: 2px;
			min-width: 0;
			padding: 7px 10px;
			border-radius: 8px;
			border: 1px dashed var(--ml-color-border-strong);
			color: var(--ml-color-text-muted);
			cursor: pointer;
		}
		.pad:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: 2px;
		}
		.pad.done {
			border: 1px solid var(--ml-color-border);
			background: var(--ml-color-surface-raised);
			color: var(--ml-color-text-secondary);
		}
		.pad.run {
			border: 1px solid color-mix(in srgb, var(--ms-run) 55%, transparent);
			background: color-mix(in srgb, var(--ms-run) 12%, transparent);
			color: var(--ms-run-text);
		}
		.pad.you {
			border: 1px solid var(--ms-you);
			background: color-mix(in srgb, var(--ms-you) 13%, transparent);
			color: var(--ml-color-text-link);
		}
		.pad.warn {
			border: 1px solid color-mix(in srgb, var(--ml-color-warning) 50%, transparent);
			background: var(--ml-color-warning-subtle);
			color: var(--ml-color-warning);
		}
		.pad.skip {
			opacity: 0.55;
			text-decoration: line-through;
		}
		.pad.on {
			box-shadow:
				0 0 0 2px var(--ml-color-background),
				0 0 0 4px var(--ml-color-text);
		}
		.pname {
			display: flex;
			align-items: center;
			gap: 5px;
			font-weight: 600;
			font-size: 12.5px;
			white-space: nowrap;
			overflow: hidden;
		}
		.psub {
			font-family: var(--ml-font-mono);
			font-size: 11px;
			opacity: 0.85;
			min-height: 14px;
		}
		.loop {
			grid-row: 2;
			grid-column: 2 / span 4;
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 3px;
		}
		.bracket {
			align-self: stretch;
			height: 8px;
			border: 2px solid color-mix(in srgb, var(--ms-run) 50%, transparent);
			border-top: 0;
			border-radius: 0 0 7px 7px;
		}
		.words {
			display: inline-flex;
			align-items: center;
			gap: 5px;
			font-size: 11.5px;
			font-weight: 600;
			color: var(--ms-run-text);
			text-align: center;
		}
		.detail {
			display: flex;
			flex-direction: column;
			gap: 8px;
			padding: 12px 14px;
			border: 1px solid var(--ml-color-border);
			border-radius: 10px;
			background: var(--ml-color-surface-raised);
		}
		.detail header {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 8px;
		}
		h3 {
			margin: 0;
			font-family: var(--ms-font-display);
			font-size: 16px;
			font-weight: 600;
		}
		.who {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 2px 10px;
			border-radius: 999px;
			font-size: 12px;
			font-weight: 600;
			background: var(--ms-hover);
			color: var(--ml-color-text-secondary);
		}
		.who.ai {
			padding: 2px 10px 2px 10px;
			background: var(--ms-ai-subtle);
			color: var(--ms-ai);
		}
		.who.run {
			background: color-mix(in srgb, var(--ms-run) 12%, transparent);
			color: var(--ms-run-text);
		}
		.who.you {
			background: color-mix(in srgb, var(--ms-you) 13%, transparent);
			color: var(--ml-color-text-link);
		}
		.pick {
			position: relative;
			display: inline-flex;
			align-items: center;
		}
		.pick select {
			appearance: none;
			-webkit-appearance: none;
			font: inherit;
			font-weight: 600;
			color: var(--ml-color-text);
			background: var(--ml-color-surface);
			border: 1px solid var(--ms-ai-border);
			border-radius: 999px;
			padding: 2px 28px 2px 12px;
			min-height: 24px;
			cursor: pointer;
		}
		.pick select:disabled {
			cursor: default;
			opacity: 0.7;
		}
		.pick select:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: 2px;
		}
		.pick ml-icon {
			position: absolute;
			right: 10px;
			pointer-events: none;
			color: var(--ms-ai);
		}
		.cost {
			font-family: var(--ml-font-mono);
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		p {
			margin: 0;
			line-height: 1.5;
			overflow-wrap: anywhere;
		}
		.sum.dim {
			color: var(--ml-color-text-muted);
		}
		.plan {
			padding: 8px 12px;
			border-radius: 8px;
			background: var(--ml-color-surface);
			border: 1px solid var(--ml-color-border-muted);
			font-size: 13px;
		}
		ul {
			margin: 0;
			padding-left: 18px;
			display: flex;
			flex-direction: column;
			gap: 3px;
			font-size: 12.5px;
			color: var(--ml-color-text-secondary);
			overflow-wrap: anywhere;
		}
		details summary {
			cursor: pointer;
			font-size: 12.5px;
			color: var(--ml-color-text-muted);
		}
		pre {
			margin: 6px 0 0;
			max-height: 240px;
			overflow: auto;
			padding: 8px 10px;
			border-radius: 6px;
			background: var(--ml-color-surface-sunken);
			font-family: var(--ml-font-mono);
			font-size: 11.5px;
			white-space: pre-wrap;
		}
		.ask {
			display: flex;
			flex-direction: column;
			gap: 8px;
			padding: 10px 12px;
			border-radius: 8px;
			border: 1px solid var(--ms-you);
			background: color-mix(in srgb, var(--ms-you) 6%, transparent);
		}
		.acts {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 6px;
		}
		.hint {
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.foot {
			display: flex;
			justify-content: flex-end;
		}
		.discard {
			all: unset;
			font-size: 12px;
			color: var(--ml-color-text-muted);
			cursor: pointer;
			padding: 2px 4px;
			border-radius: 4px;
		}
		.discard:hover {
			color: var(--ms-del);
		}
		.discard:focus-visible {
			outline: 2px solid var(--ml-color-primary);
		}
		.confirm {
			display: flex;
			flex-direction: column;
			gap: 8px;
			padding: 10px 12px;
			border-radius: 8px;
			border: 1px solid color-mix(in srgb, var(--ms-del) 50%, transparent);
			background: var(--ml-color-danger-subtle);
		}
		.confirm b {
			font-family: var(--ml-font-mono);
			font-weight: 600;
		}
		.ev {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}
		.verdict {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 8px;
			font-size: 14px;
		}
		.verdict strong {
			font-family: var(--ms-font-display);
			font-weight: 600;
		}
		.when {
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.when code {
			font-family: var(--ml-font-mono);
		}
		.mark {
			display: inline-flex;
			align-items: center;
			flex: none;
			color: var(--ml-color-text-muted);
		}
		.mark.ok {
			color: var(--ml-color-success);
		}
		.mark.warn {
			color: var(--ml-color-warning);
		}
		.mark.bad {
			color: var(--ms-del);
		}
		.mark.run {
			color: var(--ms-run-text);
		}
		.stale {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 8px 12px;
			padding: 8px 12px;
			border-radius: 8px;
			border: 1px solid color-mix(in srgb, var(--ml-color-warning) 50%, transparent);
			background: var(--ml-color-warning-subtle);
		}
		.stale p {
			flex: 1 1 260px;
			font-size: 13px;
		}
		.gaps {
			padding: 8px 12px 8px 28px;
			border-radius: 8px;
			background: var(--ml-color-warning-subtle);
			color: var(--ml-color-text);
		}
		.proofs {
			display: flex;
			flex-direction: column;
			border: 1px solid var(--ml-color-border-muted);
			border-radius: 8px;
			background: var(--ml-color-surface);
		}
		.proof + .proof {
			border-top: 1px solid var(--ml-color-border-muted);
		}
		.phead {
			display: flex;
			align-items: baseline;
			gap: 8px;
			padding: 7px 12px;
			font-size: 13px;
			list-style: none;
		}
		.phead .mark {
			align-self: center;
		}
		summary.phead {
			cursor: pointer;
			color: inherit;
		}
		summary.phead::-webkit-details-marker {
			display: none;
		}
		summary.phead:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: -2px;
			border-radius: 8px;
		}
		.ptitle {
			flex: none;
			min-width: 118px;
			font-weight: 600;
		}
		.says {
			flex: 1;
			min-width: 0;
			color: var(--ml-color-text-secondary);
			overflow-wrap: anywhere;
		}
		.chev {
			align-self: center;
			color: var(--ml-color-text-muted);
			transition: transform 0.12s ease;
		}
		details[open] > summary .chev {
			transform: rotate(90deg);
		}
		.pbody {
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 0 12px 10px 38px;
		}
		.pbody ul {
			padding-left: 0;
			list-style: none;
		}
		.pbody pre {
			margin: 0;
		}
		.place {
			all: unset;
			cursor: pointer;
			color: var(--ml-color-text-link);
			overflow-wrap: anywhere;
		}
		.place:hover {
			text-decoration: underline;
		}
		.place:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			border-radius: 3px;
		}
		.more {
			display: block;
			color: var(--ml-color-text-muted);
		}
		.evfoot {
			display: flex;
			justify-content: flex-end;
		}
		.copy {
			all: unset;
			font-size: 12px;
			color: var(--ml-color-text-muted);
			cursor: pointer;
			padding: 2px 4px;
			border-radius: 4px;
		}
		.copy:hover {
			color: var(--ml-color-text);
		}
		.copy:focus-visible {
			outline: 2px solid var(--ml-color-primary);
		}
		@media (prefers-reduced-motion: reduce) {
			.chev {
				transition: none;
			}
		}
		.eq {
			display: inline-flex;
			align-items: flex-end;
			gap: 2px;
			height: 10px;
		}
		.eq b {
			display: block;
			width: 2px;
			height: 4px;
			border-radius: 1px;
			background: currentColor;
			animation: pl-eq 0.9s ease-in-out infinite;
		}
		.eq b:nth-child(2) {
			animation-delay: 0.25s;
		}
		.eq b:nth-child(3) {
			animation-delay: 0.5s;
		}
		@keyframes pl-eq {
			0%,
			100% {
				height: 3px;
			}
			50% {
				height: 10px;
			}
		}
		@media (prefers-reduced-motion: reduce) {
			.eq b {
				animation: none;
				height: 7px;
			}
		}
	`,
})
export class PipelineComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(PipelineStore) readonly pipelines!: PipelineStore;

	elementRef!: HTMLElement;
	/** The session whose Discard is asking for a yes. */
	discarding: string | null = null;
	/** The session whose pipeline this shows. */
	sessionId: string | null = null;
	/** The step picked on each session's track; the current one when none is. Memory only. */
	picked: Record<string, { step: StepName; at: StepName }> = {};

	/** The session whose evidence was just copied, for a moment. */
	copied: string | null = null;
	private readonly _focus = (): void => this.look(true);

	onCreate(): void {
		window.addEventListener('focus', this._focus);
	}

	onDestroy(): void {
		window.removeEventListener('focus', this._focus);
	}

	onRender(): void {
		this.look();
	}

	/** While the task waits at Ship, see whether its worktree is still what the checks saw (a terminal or an editor may have changed it). */
	private look(force = false): void {
		const p = this.sessionId ? this.agents.get(this.sessionId)?.pipeline : null;
		if (this.sessionId && p?.step === 'ship' && p.waiting) {
			void this.pipelines.look(this.sessionId, force);
		}
	}

	/** Straight from the click, which WebKit requires of the clipboard. */
	copy(id: string, text: string): void {
		void navigator.clipboard.writeText(text).then(
			() => {
				this.copied = id;
				setTimeout(() => (this.copied = this.copied === id ? null : this.copied), 1600);
			},
			() => undefined
		);
	}

	pick(id: string, step: StepName): void {
		const p = this.agents.get(id)?.pipeline;
		const at: StepName = !p || p.step === 'done' ? 'ship' : p.step;
		this.picked = { ...this.picked, [id]: { step, at } };
	}

	follow(s: AgentSession) {
		return (ref: Parameters<AgentsStore['follow']>[1]): void => void this.agents.follow(s, ref);
	}

	emit(name: 'merge' | 'pr'): void {
		this.elementRef.dispatchEvent(new CustomEvent(name));
	}
}

