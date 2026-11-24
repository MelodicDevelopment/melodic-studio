import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { effect, untracked } from '@melodicdev/core/signals';
import { html, css } from '@melodicdev/core/template';
import { AgentsStore, DRAFT_IMAGES, type AskScope } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';
import { isMac } from '../../services/backend.service';

const SCOPES: { scope: AskScope; label: string; icon: string; about: string }[] = [
	{ scope: 'code', label: 'The code', icon: 'file-code', about: 'Claude searches and reads the files in this checkout.' },
	{ scope: 'history', label: 'The code and its history', icon: 'clock-counter-clockwise', about: 'Claude also reads the git history (log, show, diff, blame) to find when and why things changed.' },
];

const EXAMPLES: Record<AskScope, string[]> = {
	code: ['Where is authentication handled?', 'How is this project laid out, and where should I start reading?', 'Where are errors shown to the user?'],
	history: ['When did this behaviour change, and why?', 'What changed in the last two weeks, and why?', 'Which commits touched the build setup most recently?'],
};

/** Main pane of the Agents tab while a new question is being written: a read-only chat about the code or its history. */
@MelodicComponent({
	selector: 'ms-ask',
	template: (self: AskComponent) => {
		const agents = self.agents;
		const scope = agents.asking()?.scope ?? 'code';
		const about = SCOPES.find((s) => s.scope === scope)!;
		const cli = agents.cli();
		const branch = self.repos.status()?.branch ?? '';
		return html`
			<div class="pane" @keydown=${self.keydown}>
				<ml-icon icon="chat-circle-dots" size="xl"></ml-icon>
				<h2>Ask about ${self.repos.repo()?.name ?? 'this repository'}</h2>
				<p>A read-only chat about ${branch ? html`<b>${branch}</b>` : 'this checkout'}. Nothing is changed and no worktree is made. Files and commits in the answer are links: they open in the Files and History tabs.</p>
				<div class="seg">
					${SCOPES.map((s) => html`<button class=${s.scope === scope ? 'on' : ''} @click=${() => self.setScope(s.scope)}><ml-icon icon=${s.icon} size="sm"></ml-icon>${s.label}</button>`)}
				</div>
				<ms-attach .box=${DRAFT_IMAGES.ask}></ms-attach>
				<ml-textarea rows="4" placeholder=${scope === 'history' ? 'When did this behaviour change, and why?' : 'Where is authentication handled?'} .value=${self.question} @ml:input=${(e: CustomEvent) => (self.question = e.detail.value)}></ml-textarea>
				<div class="row">
					<span class="note"><ml-icon icon="lock-simple" size="sm"></ml-icon>${about.about}</span>
					<ms-attach-button .box=${DRAFT_IMAGES.ask}></ms-attach-button>
					<ml-button variant="outline" size="sm" @ml:click=${() => agents.cancelAsk()}>Cancel</ml-button>
					<ml-button variant="primary" size="sm" ?disabled=${!self.question.trim() || cli === null || !!agents.attaching()[DRAFT_IMAGES.ask]} ?loading=${self.sending} title=${isMac() ? '⌘ Enter' : 'Ctrl+Enter'} @ml:click=${() => self.submit()}>Ask</ml-button>
				</div>
				${cli === null ? html`<p class="bad">The <b>claude</b> command was not found. Install Claude Code, then restart Melodic Studio.</p>` : ''}
				<div class="examples">
					${EXAMPLES[scope].map((q) => html`<button @click=${() => (self.question = q)}>${q}</button>`)}
				</div>
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
			overflow-y: auto;
		}
		.pane {
			box-sizing: border-box;
			width: min(640px, 100%);
			margin: auto;
			padding: 32px 24px;
			display: flex;
			flex-direction: column;
			align-items: center;
			gap: 12px;
			text-align: center;
		}
		.pane > ml-icon {
			color: var(--ml-color-primary);
		}
		h2 {
			margin: 0;
			font-size: 20px;
			font-weight: 600;
		}
		p {
			margin: 0;
			color: var(--ml-color-text-muted);
		}
		p b {
			color: var(--ml-color-text);
			font-weight: 600;
		}
		.bad {
			color: var(--ml-color-danger);
		}
		ml-textarea,
		ms-attach {
			align-self: stretch;
			text-align: left;
		}
		.seg {
			display: inline-flex;
			border: 1px solid var(--ml-color-border);
			border-radius: 8px;
			overflow: hidden;
		}
		.seg button {
			all: unset;
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 5px 12px;
			color: var(--ml-color-text-secondary);
		}
		.seg button + button {
			border-left: 1px solid var(--ml-color-border);
		}
		.seg button:hover {
			background: var(--ms-hover);
		}
		.seg button.on {
			background: var(--ms-selected);
			color: var(--ms-selected-fg);
			font-weight: 600;
		}
		.seg button:focus-visible,
		.examples button:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: -2px;
		}
		.row {
			align-self: stretch;
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.note {
			flex: 1;
			min-width: 0;
			display: flex;
			align-items: center;
			gap: 6px;
			text-align: left;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.note ml-icon {
			flex: none;
		}
		.examples {
			display: flex;
			flex-wrap: wrap;
			justify-content: center;
			gap: 6px;
			margin-top: 6px;
		}
		.examples button {
			all: unset;
			padding: 4px 11px;
			border: 1px solid var(--ml-color-border);
			border-radius: 999px;
			font-size: 12px;
			color: var(--ml-color-text-secondary);
		}
		.examples button:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
	`,
})
export class AskComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	elementRef!: HTMLElement;

	question = '';
	sending = false;

	onCreate(): void {
		// Opened with a question already written, possibly while this is on screen. (The effect ends with the component.)
		effect(() => {
			const seed = this.agents.asking()?.seed;
			untracked(() => {
				if (seed) {
					this.question = seed;
				}
			});
		});
		requestAnimationFrame(() => (this.elementRef.shadowRoot?.querySelector('ml-textarea')?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement | null)?.focus());
	}

	setScope(scope: AskScope): void {
		this.agents.asking.set({ scope, seed: '' });
	}

	async submit(): Promise<void> {
		const scope = this.agents.asking()?.scope ?? 'code';
		// Not while an image is still being made ready: the question would go without it.
		if (!this.question.trim() || this.sending || this.agents.attaching()[DRAFT_IMAGES.ask]) {
			return;
		}
		this.sending = true;
		try {
			await this.agents.ask(this.question, scope, this.agents.takeAttached(DRAFT_IMAGES.ask));
		} finally {
			this.sending = false;
		}
	}

	/** Cmd/Ctrl+Enter asks. */
	readonly keydown = (e: KeyboardEvent): void => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void this.submit();
		}
	};
}

/** The commit a link last selected that the History list has already scrolled to. */
let scrolledTo = 0;

/**
 * The way into a question from another tab. `look` is `icon` (a small button for a header,
 * as in the Files tab) or `bar` (a full-width row above a list, as in the History tab).
 * Used as `<ms-ask-button .scope=${'history'} .look=${'bar'}></ms-ask-button>`.
 */
@MelodicComponent({
	selector: 'ms-ask-button',
	template: (self: AskButtonComponent) => {
		self.agents.commitShown();
		const history = self.scope === 'history';
		const title = history ? 'Ask when and why something changed: a read-only chat that can read the git history' : 'Ask about this code: a read-only chat, nothing is changed';
		const chat = history ? self.agents.docked() : null;
		const back = chat?.id && !chat.open ? html`<button class="back" title="Show the conversation again" @click=${() => self.agents.showHistoryChat()}><ml-icon icon="arrow-u-up-left" size="sm"></ml-icon>Back to conversation</button>` : '';
		return self.look === 'bar'
			? html`<div class="row"><button class="bar" title=${title} @click=${() => self.open()}><ml-icon icon="chat-circle-dots" size="sm"></ml-icon><span>${history ? 'Ask about this history…' : 'Ask about this code…'}</span></button>${back}</div>`
			: html`<button class="icon" title=${title} @click=${() => self.open()}><ml-icon icon="chat-circle-dots" size="sm"></ml-icon></button>`;
	},
	styles: () => css`
		:host {
			display: block;
			flex: none;
		}
		button {
			all: unset;
			box-sizing: border-box;
		}
		button:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: -2px;
		}
		.icon {
			display: grid;
			place-items: center;
			width: 26px;
			height: 26px;
			border-radius: 5px;
			color: var(--ml-color-text-muted);
		}
		.icon:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
		.row {
			display: flex;
			border-bottom: 1px solid var(--ml-color-border);
		}
		.back {
			flex: none;
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 0 12px;
			font-size: 12px;
			color: var(--ml-color-primary);
			border-left: 1px solid var(--ml-color-border);
		}
		.back:hover {
			background: var(--ms-hover);
		}
		.bar {
			flex: 1;
			min-width: 0;
			display: flex;
			align-items: center;
			gap: 8px;
			width: 100%;
			height: 34px;
			padding: 0 12px;
			color: var(--ml-color-text-secondary);
		}
		.bar:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
		.bar ml-icon {
			flex: none;
			color: var(--ml-color-primary);
		}
		.bar span {
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
	`,
})
export class AskButtonComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	elementRef!: HTMLElement;

	scope: AskScope = 'code';
	look: 'icon' | 'bar' = 'icon';

	open(): void {
		this.agents.openAsk(this.scope);
	}

	/**
	 * In the History tab this sits above the commit list. When a link in an answer selects a
	 * commit, the list (a sibling in the same shadow root) may have it far out of view: bring it in.
	 */
	onRender(): void {
		const shown = this.agents.commitShown();
		if (this.scope !== 'history' || shown === scrolledTo) {
			return;
		}
		scrolledTo = shown;
		const list = this.elementRef.getRootNode() as ShadowRoot | Document;
		setTimeout(() => list.querySelector('.commit.sel')?.scrollIntoView({ block: 'center' }), 60);
	}
}
