import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { effect, untracked } from '@melodicdev/core/signals';
import { RunStore, filterTargets, foundIn, groupTargets, targetTitle } from '../../services/run.store';
import { RepoStore } from '../../services/repo.store';
import type { RunTarget } from '../../services/backend.service';

/** More targets than this and the list gets a filter box and groups that fold. */
const LONG = 8;

/**
 * The toolbar's Run control: the selected target's name with the list of every target Studio
 * found, then Run (Restart while it runs) and Stop. While the target runs, the control has
 * azure equalizer bars and a magenta border. A checkout with nothing to run has no control.
 */
@MelodicComponent({
	selector: 'ms-run-control',
	template: (self: RunControlComponent) => {
		const run = self.run;
		const targets = run.targets() ?? [];
		if (!targets.length) {
			// Not an empty template: Melodic would never show the control afterwards.
			return html`<span hidden></span>`;
		}
		const selected = run.selected();
		const current = run.current();
		const running = current?.state === 'running';
		const live = new Set(
			run
				.here()
				.filter((r) => r.state === 'running')
				.map((r) => r.target.id)
		);
		const long = targets.length > LONG;
		const filtering = long && !!self.filter.trim();
		const groups = groupTargets(filtering ? filterTargets(targets, self.filter) : targets);
		const folds = self.folds && !filtering;
		return html`
			<div class="run ${running ? 'on' : ''}">
				<ml-popover id="run-pop" placement="bottom-end" offset="0" @ml:open=${() => self.opening()}>
					<button slot="trigger" class="name" title=${selected ? selected.argv.join(' ') : 'Run targets'}>
						${running ? html`<span class="eq" aria-hidden="true"><b></b><b></b><b></b></span>` : html`<ml-icon icon="play" size="sm"></ml-icon>`}
						<span class="v">${selected ? targetTitle(selected) : 'Run'}</span>
						<ml-icon icon="caret-down" size="xs"></ml-icon>
					</button>
					<div class="panel">
						${long
							? html`
								<div class="filter" @keydown=${(e: KeyboardEvent) => self.filterKey(e, groups[0]?.targets[0])}>
									<ml-input size="sm" placeholder="Filter targets" .value=${self.filter} @ml:input=${(e: CustomEvent) => (self.filter = e.detail.value)}>
										<ml-icon slot="prefix" icon="magnifying-glass" size="sm"></ml-icon>
									</ml-input>
								</div>
							`
							: ''}
						<div class="list">
							${groups.length === 0 ? html`<div class="none">No targets match.</div>` : ''}
							${groups.map((g) => {
								const open = !folds || self.isOpen(g.group, g.targets, live);
								return html`
									<div class="group ${folds ? 'fold' : ''}" title=${foundIn(g.targets)} @click=${() => self.toggle(g.group, open)}>
										${folds ? html`<ml-icon icon=${open ? 'caret-down' : 'caret-right'} size="xs"></ml-icon>` : ''}
										<span class="g">${g.group}</span>
										${!open && g.targets.some((t) => live.has(t.id)) ? html`<span class="live">running</span>` : ''}
										${folds ? html`<span class="n">${g.targets.length}</span>` : ''}
									</div>
									${open
										? g.targets.map(
												(t) => html`
													<div class="item ${t.id === selected?.id ? 'current' : ''}" @click=${() => self.pick(t)}>
														${t.id === selected?.id ? html`<ml-icon icon="check" size="sm"></ml-icon>` : html`<span class="gap"></span>`}
														<span class="what"><span class="t">${t.name}</span><span class="cmd">${t.argv.join(' ')}</span></span>
														${live.has(t.id) ? html`<span class="live">running</span>` : ''}
														<button class="go" title=${live.has(t.id) ? 'Restart' : 'Run'} @click=${(e: Event) => (e.stopPropagation(), self.pick(t, true))}>
															<ml-icon icon=${live.has(t.id) ? 'arrow-clockwise' : 'play'} size="sm"></ml-icon>
														</button>
													</div>
												`
											)
										: ''}
								`;
							})}
						</div>
					</div>
				</ml-popover>
				${running
					? html`
						<button class="act" title="Restart" aria-label="Restart" @click=${() => run.restart()}><ml-icon icon="arrow-clockwise" size="sm"></ml-icon></button>
						<button class="act stop" title="Stop" aria-label="Stop" @click=${() => run.stop()}><ml-icon icon="stop" format="fill" size="sm"></ml-icon></button>
					`
					: html`<button class="act" title=${selected ? `Run ${targetTitle(selected)}` : 'Nothing to run'} aria-label="Run" ?disabled=${!selected} @click=${() => run.start()}><ml-icon icon="play" format="fill" size="sm"></ml-icon></button>`}
			</div>
			<span class="rule"></span>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			align-items: center;
			gap: 6px;
			flex: none;
		}
		/* Nothing to run here (set in onRender): no control, and no gap where it would be. */
		:host([hidden]) {
			display: none;
		}
		/* Sets the control apart from the icon buttons after it. */
		.rule {
			flex: none;
			width: 1px;
			height: 22px;
			margin: 0 2px;
			background: var(--ms-toolbar-border);
		}
		.run {
			display: flex;
			align-items: stretch;
			height: 38px;
			border: 1px solid var(--ms-toolbar-border);
			border-radius: 10px;
			background: var(--ms-toolbar-raised);
			color: var(--ms-toolbar-fg);
		}
		/* Running: the magenta border says this is yours to stop. */
		.run.on {
			border-color: var(--ms-you);
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
		.name {
			display: flex;
			align-items: center;
			gap: 8px;
			max-width: 240px;
			/* Not 100%: the popover wraps its trigger, so there is no height to take a share of. */
			height: 36px;
			padding: 0 10px 0 11px;
			border-radius: 9px 0 0 9px;
		}
		.name > ml-icon:first-child {
			color: var(--ms-toolbar-muted);
		}
		.v {
			min-width: 0;
			font-size: 13px;
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.act {
			display: grid;
			place-items: center;
			width: 34px;
			border-left: 1px solid var(--ms-toolbar-border);
			color: var(--ms-toolbar-fg);
		}
		.act:last-child {
			border-radius: 0 9px 9px 0;
		}
		.act.stop {
			color: var(--ml-color-danger);
		}
		.act[disabled] {
			opacity: 0.45;
		}
		.name:hover,
		.act:hover:not([disabled]) {
			background: var(--ms-toolbar-hover);
		}
		button:focus-visible {
			outline: 2px solid var(--ml-color-primary);
			outline-offset: -2px;
		}

		/* The equalizer bars of the Melodic mark, in azure: something is running. */
		.eq {
			display: inline-flex;
			align-items: flex-end;
			gap: 2px;
			height: 12px;
			color: var(--ms-run);
		}
		.eq b {
			width: 3px;
			height: 100%;
			border-radius: 1px;
			background: currentColor;
			transform-origin: bottom;
			animation: ms-eq 1s ease-in-out infinite;
		}
		.eq b:nth-child(2) {
			animation-delay: 0.2s;
		}
		.eq b:nth-child(3) {
			animation-delay: 0.4s;
		}
		@keyframes ms-eq {
			0%,
			100% {
				transform: scaleY(0.4);
			}
			50% {
				transform: scaleY(1);
			}
		}
		@media (prefers-reduced-motion: reduce) {
			.eq b {
				animation: none;
			}
		}

		/* ---- the list of targets ---- */
		.panel {
			width: 420px;
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
		.filter {
			padding: 10px;
			border-bottom: 1px solid var(--ml-color-border);
		}
		.group {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 8px 10px 4px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
		}
		.group.fold {
			padding-left: 6px;
			cursor: pointer;
			user-select: none;
		}
		.group.fold:hover {
			color: var(--ml-color-text);
		}
		.g {
			flex: 1;
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.n {
			font-weight: 400;
		}
		.group .live {
			font-weight: 400;
			letter-spacing: 0;
			text-transform: none;
		}
		.none {
			display: grid;
			place-items: center;
			padding: 18px 14px;
			text-align: center;
			line-height: 1.5;
			color: var(--ml-color-text-muted);
		}
		.item {
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 7px 8px 7px 10px;
			border-radius: 8px;
		}
		.item:hover {
			background: var(--ms-hover);
		}
		.item.current {
			background: var(--ms-selected);
		}
		.item > ml-icon {
			flex: none;
			color: var(--ml-color-text-link);
		}
		.gap {
			flex: none;
			width: 16px;
		}
		.what {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
			gap: 2px;
		}
		.t {
			font-size: 13px;
		}
		.item.current .t {
			font-weight: 600;
		}
		.t,
		.cmd {
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.cmd {
			font-family: var(--ml-font-mono);
			font-size: 11px;
			color: var(--ml-color-text-muted);
		}
		.live {
			flex: none;
			font-size: 11px;
			color: var(--ms-run-text);
		}
		.go {
			flex: none;
			display: grid;
			place-items: center;
			width: 26px;
			height: 26px;
			border-radius: 6px;
			color: var(--ml-color-text-muted);
			visibility: hidden;
		}
		.item:hover .go,
		.go:focus-visible {
			visibility: visible;
		}
		.go:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
	`,
})
export class RunControlComponent {
	@Service(RunStore) readonly run!: RunStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	elementRef!: HTMLElement;

	filter = '';
	/** The groups opened or folded by hand, by heading; the others follow `isOpen`. */
	byHand: Record<string, boolean> = {};

	/** A long list in more than one group folds its groups. */
	get folds(): boolean {
		const targets = this.run.targets() ?? [];
		return targets.length > LONG && new Set(targets.map((t) => t.group)).size > 1;
	}

	/** A folding group is open when the user opened it, or else when it holds the selected target or one that is running. */
	isOpen(group: string, targets: RunTarget[], live: Set<string>): boolean {
		const selected = this.run.selected()?.id;
		return this.byHand[group] ?? targets.some((t) => t.id === selected || live.has(t.id));
	}

	toggle(group: string, open: boolean): void {
		if (this.folds && !this.filter.trim()) {
			this.byHand = { ...this.byHand, [group]: !open };
		}
	}

	/** A hidden control cannot be opened to look again, so it looks whenever the window comes back. */
	private readonly _focus = (): void => {
		if (!this.run.targets()?.length) {
			void this.run.load(true);
		}
	};

	onCreate(): void {
		window.addEventListener('focus', this._focus);
		// A repository, worktree or branch switch looks again. An effect, because what `onRender` reads is not
		// followed: a branch checkout, which does not rebuild this control, used to go unnoticed until the list was opened.
		effect(() => {
			this.repos.repo();
			this.repos.status();
			untracked(() => void this.run.load());
		});
	}

	onDestroy(): void {
		window.removeEventListener('focus', this._focus);
	}

	/** The targets belong to the checkout on screen, which changes without this component being rebuilt. */
	onRender(): void {
		this.elementRef.toggleAttribute('hidden', !this.run.targets()?.length);
		queueMicrotask(() => void this.run.load());
	}

	/** The list is opening: look again, and start from the whole list with the filter ready to type in. */
	opening(): void {
		this.filter = '';
		void this.run.load(true);
		const input = this.elementRef.shadowRoot?.querySelector('#run-pop ml-input');
		requestAnimationFrame(() => (input?.shadowRoot?.querySelector('input') as HTMLInputElement | null)?.focus());
	}

	/** Enter in the filter takes the first target left. */
	filterKey(e: KeyboardEvent, first: RunTarget | undefined): void {
		if (e.key === 'Enter' && first && this.filter.trim()) {
			this.pick(first);
		}
	}

	private close(): void {
		const el = this.elementRef.shadowRoot?.querySelector('#run-pop') as (HTMLElement & { component?: { close(): void } }) | null;
		el?.component?.close();
	}

	/** Choose a target from the list; with `start`, run it straight away. */
	pick(target: RunTarget, start = false): void {
		this.run.select(target);
		this.close();
		this.filter = '';
		if (start) {
			void this.run.start(target);
		}
	}
}
