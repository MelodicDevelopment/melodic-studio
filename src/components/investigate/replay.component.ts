import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { AgentsStore, type AgentSession } from '../../services/agents.store';
import { BackendService, asAppError } from '../../services/backend.service';
import { buildReplay, openingStep, stepSource, type ReplayStep, type ReplayView } from '../../shared/replay';
import { fileName } from '../../shared/paths';
import { richText, richTextStyles } from '../agents/rich-text';

/** How long each step stays on screen while playing. */
const PLAY_MS = 1200;
/** More steps than this and the timeline is a slider instead of a dot per step. */
const MAX_DOTS = 60;

function tone(step: ReplayStep, index: number, at: number): string {
	return step.kind ?? (index <= at ? 'passed' : 'ahead');
}

/**
 * Replay: one recorded run of an investigation, scrubbed forwards and backwards. On the left
 * what ran, in order; in the middle the code of the current step with the values recorded there;
 * at the bottom the controls and a timeline. It opens on the cause, not on the first step.
 *
 * Step names, file names and values are what the program recorded: untrusted, shown as text.
 * Claude's notes go through rich-text.ts.
 */
@MelodicComponent({
	selector: 'ms-replay',
	template: (self: ReplayComponent) => {
		const s = self.agents.selected();
		const view = self.view;
		const back = html`<button class="back" @click=${() => self.agents.replaying.set(null)}><ml-icon icon="arrow-left" size="sm"></ml-icon>Report</button>`;
		if (!s || !view || !view.steps.length) {
			return html`
				<div class="bar">${back}<span class="title">Replay</span></div>
				<div class="empty">
					${self.error
						? html`<ml-icon icon="warning" size="lg"></ml-icon><p>${self.error}</p>`
						: view
							? html`<ml-icon icon="film-strip" size="lg"></ml-icon><p>This run recorded nothing. Ask Claude in the report to record it again.</p>`
							: html`<ml-spinner size="md"></ml-spinner>`}
				</div>
			`;
		}
		const at = Math.min(self.at, view.steps.length - 1);
		const step = view.steps[at];
		const lines = stepSource(view, at);
		const total = view.steps.length;
		const where = `${step.file ? fileName(step.file) : step.fileLabel}${step.line ? `:${step.line}` : ''}`;
		const links = { files: true, commits: false, root: s.cwd };
		return html`
			<div class="bar">
				${back}
				<span class="title">Replay · run ${self.run}</span>
				<span class="hint">Arrow keys step, Space plays</span>
			</div>
			<div class="body">
				<nav class="ran" aria-label="What ran, in order">
					<h2>What ran, in order</h2>
					<div class="list">
						${view.steps.map((st, i) => {
							const label = `${st.file ? fileName(st.file) : st.fileLabel}${st.line ? `:${st.line}` : ''}${st.kind ? `  · ${st.kind}` : ''}`;
							return html`
								<button class="step ${tone(st, i, at)} ${i === at ? 'on' : ''}" style="padding-left: ${10 + Math.min(st.depth, 8) * 16}px" aria-current=${i === at ? 'step' : 'false'} @click=${() => self.go(i)}>
									<span class="n">${i + 1}</span>
									<span class="what"><span class="fn">${st.fn}</span><span class="at">${label}</span></span>
								</button>
							`;
						})}
					</div>
				</nav>
				<main>
					<div class="head">
						<span class="fnname">${step.fn}</span>
						${step.file
							? html`<a href="#" class="loc" title="Open in the Files tab" @click=${(e: Event) => (e.preventDefault(), self.open(s, step))}>${where}</a>`
							: html`<span class="loc">${where}</span>`}
						<span class="grow"></span>
						<span class="hint">Values are what the recording saw on this run</span>
					</div>
					${lines.length
						? html`
							<div class="code ${step.kind ?? ''}">
								${lines.map(
									(l) => html`
										<div class="line ${l.current ? 'cur' : ''}">
											<span class="no">${l.n}</span>
											<span class="src">${l.text}</span>
											${l.values ? html`<span class="val" title=${l.values}>${l.values}</span>` : ''}
										</div>
									`
								)}
							</div>
						`
						: html`
							<div class="code">
								<div class="nosrc">No copy of ${step.fileLabel || 'this file'} was kept for this run, so there is no code to show for this step.</div>
								${step.values.map(([name, value]) => html`<div class="line"><span class="no"></span><span class="src">${name}</span><span class="val">${value}</span></div>`)}
							</div>
						`}
					${step.note
						? html`<div class="note ${step.kind ?? ''}"><ml-icon icon="sparkle" size="sm"></ml-icon><div>${richText(step.note, links, self.follow)}</div></div>`
						: ''}
				</main>
			</div>
			<footer>
				<div class="ctl">
					<button aria-label="Step back" title="Step back (←)" ?disabled=${at === 0} @click=${() => self.go(at - 1)}><ml-icon icon="caret-left" format="bold" size="sm"></ml-icon></button>
					<button class="play" aria-label=${self.playing ? 'Pause' : 'Play'} title=${self.playing ? 'Pause (Space)' : 'Play (Space)'} @click=${() => self.toggle()}>
						<ml-icon icon=${self.playing ? 'pause' : 'play'} format="fill" size="sm"></ml-icon>
					</button>
					<button aria-label="Step forward" title="Step forward (→)" ?disabled=${at >= total - 1} @click=${() => self.go(at + 1)}><ml-icon icon="caret-right" format="bold" size="sm"></ml-icon></button>
				</div>
				<div class="time">
					${total <= MAX_DOTS
						? html`
							<div class="track">
								<div class="rail"></div>
								<div class="fill" style="width: ${total > 1 ? (at / (total - 1)) * 100 : 0}%"></div>
								${view.steps.map((st, i) => html`<button class="dot ${tone(st, i, at)} ${i === at ? 'on' : ''}" aria-label=${`Step ${i + 1}, ${st.fn}${st.line ? ` line ${st.line}` : ''}`} @click=${() => self.go(i)}></button>`)}
							</div>
						`
						: html`<input class="slide" type="range" min="0" max=${total - 1} .value=${String(at)} aria-label="Step" @input=${(e: Event) => self.go(Number((e.target as HTMLInputElement).value))} />`}
					<div class="labels">
						<span>${view.steps[0].fn}</span>
						${view.cause >= 0 ? html`<button class="cause" @click=${() => self.go(view.cause)}>Cause · step ${view.cause + 1}</button>` : ''}
						${view.crash >= 0 ? html`<button class="crash" @click=${() => self.go(view.crash)}>Crash · step ${view.crash + 1}</button>` : html`<span></span>`}
					</div>
				</div>
				<div class="count">Step <b>${at + 1}</b> of ${total}</div>
			</footer>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
			flex: 1;
			min-height: 0;
			background: var(--ml-color-surface);
			outline: none;
		}
		button {
			all: unset;
			box-sizing: border-box;
			cursor: default;
		}
		button:focus-visible,
		a:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: 1px;
		}
		.grow {
			flex: 1;
		}
		.bar {
			flex: none;
			display: flex;
			align-items: center;
			gap: 12px;
			height: 44px;
			padding: 0 16px;
			border-bottom: 1px solid var(--ml-color-border);
		}
		.back {
			display: inline-flex;
			align-items: center;
			gap: 6px;
			height: 30px;
			padding: 0 10px 0 8px;
			border: 1px solid var(--ml-color-border-strong);
			border-radius: 8px;
			font-size: 12px;
		}
		.back:hover {
			background: var(--ms-hover);
		}
		.title {
			flex: 1;
			font-family: var(--ms-font-display);
			font-size: 15px;
			font-weight: 600;
		}
		.hint {
			font-size: 12px;
			color: var(--ml-color-text-muted);
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
			color: var(--ml-color-text-muted);
		}
		.empty p {
			margin: 0;
			max-width: 420px;
		}
		.body {
			flex: 1;
			min-height: 0;
			display: flex;
		}

		/* ---- what ran, in order ---- */
		.ran {
			flex: none;
			width: 300px;
			display: flex;
			flex-direction: column;
			border-right: 1px solid var(--ml-color-border);
			background: var(--ms-sidebar-bg);
		}
		h2 {
			margin: 0;
			padding: 14px 16px 8px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
		}
		.list {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
			padding: 0 8px 10px;
		}
		.step {
			display: flex;
			align-items: center;
			gap: 10px;
			width: 100%;
			min-height: 44px;
			padding: 6px 10px;
			border-radius: 8px;
			color: var(--ml-color-text-secondary);
		}
		.step:hover {
			background: var(--ms-hover);
		}
		.step.on {
			background: var(--ms-selected);
			color: var(--ms-selected-fg);
		}
		.n {
			flex: none;
			display: grid;
			place-items: center;
			width: 22px;
			height: 22px;
			border: 1.5px solid var(--tone);
			border-radius: 50%;
			font-size: 11px;
			font-weight: 600;
			color: var(--tone-text);
		}
		.step.on .n {
			background: var(--tone);
			color: var(--ml-color-text-inverse);
		}
		.what {
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 1px;
			font-family: var(--ml-font-mono);
		}
		.fn {
			font-size: 12px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.at {
			font-size: 11px;
			color: var(--ml-color-text-muted);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		/* Azure for what has run, purple for the cause, red for the crash, grey for what is still ahead. */
		.passed {
			--tone: var(--ms-run);
			--tone-text: var(--ms-run-text);
		}
		.ahead {
			--tone: var(--ml-color-border-strong);
			--tone-text: var(--ml-color-text-muted);
		}
		.cause {
			--tone: var(--ms-ai);
			--tone-text: var(--ms-ai);
		}
		.crash {
			--tone: var(--ml-color-danger);
			--tone-text: var(--ml-color-danger);
		}
		.step.cause .at {
			color: var(--ms-ai);
		}
		.step.crash .at {
			color: var(--ml-color-danger);
		}

		/* ---- the code of the current step ---- */
		main {
			flex: 1;
			min-width: 0;
			overflow-y: auto;
			padding: 0 24px 20px;
		}
		.head {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 14px 0 10px;
		}
		.fnname {
			font-family: var(--ml-font-mono);
			font-size: 14px;
			font-weight: 500;
			user-select: text;
			-webkit-user-select: text;
		}
		.loc {
			padding: 2px 8px;
			border-radius: 6px;
			background: var(--ml-color-surface-raised);
			font-family: var(--ml-font-mono);
			font-size: 11px;
			color: var(--ml-color-text-secondary);
			text-decoration: none;
		}
		a.loc:hover {
			color: var(--ml-color-text-link);
		}
		.code {
			--mark: var(--ms-run);
			--mark-bg: color-mix(in srgb, var(--ms-run) 10%, transparent);
			--mark-text: var(--ms-run-text);
			padding: 12px 0;
			border: 1px solid var(--ml-color-border);
			border-radius: 10px;
			background: var(--ml-color-surface-sunken);
			font-family: var(--ml-font-mono);
			font-size: 13px;
			line-height: 26px;
			tab-size: 4;
			overflow-x: auto;
			user-select: text;
			-webkit-user-select: text;
		}
		.code.cause {
			--mark: var(--ms-ai);
			--mark-bg: color-mix(in srgb, var(--ms-ai) 12%, transparent);
			--mark-text: var(--ms-ai);
		}
		.code.crash {
			--mark: var(--ml-color-danger);
			--mark-bg: color-mix(in srgb, var(--ml-color-danger) 12%, transparent);
			--mark-text: var(--ml-color-danger);
		}
		.line {
			display: flex;
			align-items: center;
			gap: 0;
			padding-right: 16px;
			color: var(--ml-color-text-secondary);
		}
		.line.cur {
			background: var(--mark-bg);
			box-shadow: inset 3px 0 0 var(--mark);
			color: var(--ml-color-text);
		}
		.no {
			flex: none;
			width: 58px;
			padding-right: 18px;
			text-align: right;
			color: var(--ml-color-text-subtle);
			user-select: none;
			-webkit-user-select: none;
		}
		.cur .no {
			color: var(--ml-color-text);
		}
		.src {
			flex: 1 0 auto;
			white-space: pre;
			padding-right: 24px;
		}
		.val {
			flex: 0 1 auto;
			max-width: 46%;
			padding: 0 10px;
			border-radius: 6px;
			background: var(--ml-color-surface-raised);
			font-size: 12px;
			line-height: 22px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.cur .val {
			background: var(--mark-bg);
			color: var(--mark-text);
		}
		.nosrc {
			padding: 4px 18px 10px;
			font-family: var(--ml-font-sans);
			color: var(--ml-color-text-muted);
		}
		.note {
			display: flex;
			gap: 10px;
			margin-top: 16px;
			padding: 14px 16px;
			border: 1px solid var(--ms-ai-border);
			border-radius: 10px;
			background: var(--ms-ai-subtle);
			font-size: 14px;
			user-select: text;
			-webkit-user-select: text;
		}
		.note > ml-icon {
			flex: none;
			margin-top: 3px;
			color: var(--ms-ai);
		}
		.note.cause {
			border-color: var(--ms-ai);
		}
		.note.crash {
			border-color: color-mix(in srgb, var(--ml-color-danger) 40%, transparent);
			background: var(--ms-diff-del-bg);
		}
		${richTextStyles}

		/* ---- controls and timeline ---- */
		footer {
			flex: none;
			display: flex;
			align-items: center;
			gap: 18px;
			height: 92px;
			padding: 0 28px;
			border-top: 1px solid var(--ml-color-border);
			background: var(--ms-sidebar-bg);
		}
		.ctl {
			display: flex;
			gap: 6px;
		}
		.ctl button {
			display: grid;
			place-items: center;
			width: 44px;
			height: 44px;
			border: 1px solid var(--ml-color-border-strong);
			border-radius: 10px;
			background: var(--ml-color-surface-raised);
		}
		.ctl button[disabled] {
			opacity: 0.4;
		}
		.ctl button:hover:not([disabled]) {
			border-color: var(--ml-color-text-muted);
		}
		.ctl .play {
			border-color: color-mix(in srgb, var(--ms-run) 50%, transparent);
			background: var(--ml-color-info-subtle);
			color: var(--ms-run);
		}
		.time {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 8px;
		}
		.track {
			position: relative;
			display: flex;
			align-items: center;
			justify-content: space-between;
			height: 24px;
		}
		.rail,
		.fill {
			position: absolute;
			left: 0;
			top: 11px;
			height: 2px;
		}
		.rail {
			right: 0;
			background: var(--ml-color-border);
		}
		.fill {
			background: var(--ms-run);
		}
		.dot {
			position: relative;
			flex: none;
			width: 14px;
			height: 14px;
			border: 2px solid var(--tone);
			border-radius: 50%;
			background: var(--tone);
		}
		.dot.ahead {
			background: var(--ms-sidebar-bg);
		}
		.dot.on {
			width: 20px;
			height: 20px;
			border-color: var(--ml-color-text);
		}
		/* A bigger target than the dot itself. */
		.dot::after {
			content: '';
			position: absolute;
			inset: -8px -3px;
		}
		.slide {
			width: 100%;
			height: 24px;
			margin: 0;
			accent-color: var(--ms-run);
		}
		.labels {
			display: flex;
			justify-content: space-between;
			gap: 12px;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.labels span {
			min-width: 0;
			font-family: var(--ml-font-mono);
			font-size: 11px;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.labels .cause {
			color: var(--ms-ai);
		}
		.labels .crash {
			color: var(--ml-color-danger);
		}
		.labels button:hover {
			text-decoration: underline;
		}
		.count {
			flex: none;
			width: 110px;
			text-align: right;
			color: var(--ml-color-text-secondary);
		}
		.count b {
			color: var(--ml-color-text);
		}
	`,
})
export class ReplayComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(BackendService) private readonly _backend!: BackendService;
	elementRef!: HTMLElement;

	view: ReplayView | null = null;
	run = 0;
	at = 0;
	playing = false;
	error = '';
	private _for = '';
	private _timer = 0;
	private _shown = -1;

	onCreate(): void {
		// The keys work wherever the focus is inside Replay; the host takes it so they work at once.
		this.elementRef.tabIndex = -1;
		this.elementRef.addEventListener('keydown', this.onKey);
		queueMicrotask(() => this.elementRef.focus());
	}

	onDestroy(): void {
		this.elementRef.removeEventListener('keydown', this.onKey);
		this.stop();
	}

	onRender(): void {
		const s = this.agents.selected();
		const report = s?.investigation?.report;
		const key = s && report?.run ? `${s.id}:${report.run}:${s.investigation?.ended ?? 0}` : '';
		if (key !== this._for) {
			this._for = key;
			this.stop();
			this.view = null;
			this.error = '';
			if (s && report?.run) {
				void this.load(s, report.run, key);
			}
		}
		// Keep the current step in sight in the list as it moves.
		if (this.view && this.at !== this._shown) {
			this._shown = this.at;
			this.elementRef.shadowRoot?.querySelector('.step.on')?.scrollIntoView({ block: 'nearest' });
		}
	}

	private async load(s: AgentSession, run: number, key: string): Promise<void> {
		const report = s.investigation?.report;
		try {
			const data = await this._backend.replayRead(s.repoId, s.cwd, run);
			if (this._for !== key) {
				return;
			}
			const view = buildReplay(data.events, data.files, { causeSeq: report?.causeSeq ?? null, crashSeq: report?.crashSeq ?? null, notes: report?.notes ?? {} });
			this.run = data.run;
			this.at = openingStep(view);
			this._shown = -1;
			this.view = view;
		} catch (e) {
			if (this._for === key) {
				this.error = asAppError(e).message;
			}
		}
	}

	/** Go to a step. Anything the user does by hand ends playback. */
	go(index: number): void {
		this.stop();
		this.show(index);
	}

	private show(index: number): void {
		const last = (this.view?.steps.length ?? 1) - 1;
		this.at = Math.max(0, Math.min(last, index));
	}

	toggle(): void {
		if (this.playing) {
			this.stop();
			return;
		}
		const steps = this.view?.steps.length ?? 0;
		if (!steps) {
			return;
		}
		// From the end, play starts over.
		if (this.at >= steps - 1) {
			this.at = 0;
		}
		this.playing = true;
		this._timer = window.setInterval(() => {
			if (this.at >= steps - 1) {
				this.stop();
			} else {
				this.show(this.at + 1);
			}
		}, PLAY_MS);
	}

	private stop(): void {
		window.clearInterval(this._timer);
		this.playing = false;
	}

	private readonly onKey = (e: KeyboardEvent): void => {
		if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement | null)?.tagName === 'INPUT') {
			return;
		}
		if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
			this.go(this.at - 1);
		} else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
			this.go(this.at + 1);
		} else if (e.key === ' ') {
			this.toggle();
		} else if (e.key === 'Escape') {
			this.agents.replaying.set(null);
		} else {
			return;
		}
		e.preventDefault();
	};

	/** A link in one of Claude's notes. */
	readonly follow = (ref: Parameters<AgentsStore['follow']>[1]): void => {
		const s = this.agents.selected();
		if (s) {
			void this.agents.follow(s, ref);
		}
	};

	open(s: AgentSession, step: ReplayStep): void {
		if (step.file) {
			void this.agents.openFile(s, step.file, step.line || null);
		}
	}
}
