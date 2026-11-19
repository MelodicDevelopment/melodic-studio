import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { RunStore, foundIn, groupTargets, targetTitle } from '../../services/run.store';
import { RepoStore } from '../../services/repo.store';
import type { RunTarget } from '../../services/backend.service';

/**
 * The toolbar's Run control: the selected target's name with the list of every target Studio
 * found, then Run (Restart while it runs) and Stop. While the target runs, the control has
 * azure equalizer bars and a magenta border.
 */
@MelodicComponent({
	selector: 'ms-run-control',
	template: (self: RunControlComponent) => {
		const run = self.run;
		const targets = run.targets();
		const selected = run.selected();
		const current = run.current();
		const running = current?.state === 'running';
		const live = new Set(
			run
				.here()
				.filter((r) => r.state === 'running')
				.map((r) => r.target.id)
		);
		const none = targets !== null && targets.length === 0;
		return html`
			<div class="run ${running ? 'on' : ''}">
				<ml-popover id="run-pop" placement="bottom-start" offset="0" @ml:open=${() => run.load(true)}>
					<button slot="trigger" class="name" title=${selected ? selected.argv.join(' ') : 'Run targets'}>
						${running ? html`<span class="eq" aria-hidden="true"><b></b><b></b><b></b></span>` : html`<ml-icon icon="play" size="sm"></ml-icon>`}
						<span class="v">${selected ? targetTitle(selected) : 'Run'}</span>
						<ml-icon icon="caret-down" size="xs"></ml-icon>
					</button>
					<div class="panel">
						<div class="list">
							${targets === null ? html`<div class="none"><ml-spinner size="sm"></ml-spinner></div>` : ''}
							${none
								? html`<div class="none">Nothing to run was found in this checkout. Studio looks for .NET launch profiles and test projects, package.json scripts, Cargo binaries, Go main packages and Python projects.</div>`
								: ''}
							${groupTargets(targets ?? []).map(
								(g) => html`
									<div class="group">${g.group}</div>
									${g.targets.map(
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
									)}
								`
							)}
						</div>
						${targets?.length ? html`<div class="foot">${foundIn(targets)} Nothing to set up.</div>` : ''}
					</div>
				</ml-popover>
				${running
					? html`
						<button class="act" title="Restart" aria-label="Restart" @click=${() => run.restart()}><ml-icon icon="arrow-clockwise" size="sm"></ml-icon></button>
						<button class="act stop" title="Stop" aria-label="Stop" @click=${() => run.stop()}><ml-icon icon="stop" format="fill" size="sm"></ml-icon></button>
					`
					: html`<button class="act" title=${selected ? `Run ${targetTitle(selected)}` : 'Nothing to run'} aria-label="Run" ?disabled=${!selected} @click=${() => run.start()}><ml-icon icon="play" format="fill" size="sm"></ml-icon></button>`}
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			flex: none;
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
		.group {
			padding: 8px 10px 4px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.06em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
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
		.foot {
			padding: 10px 16px;
			border-top: 1px solid var(--ml-color-border);
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
	`,
})
export class RunControlComponent {
	@Service(RunStore) readonly run!: RunStore;
	@Service(RepoStore) readonly repos!: RepoStore;
	elementRef!: HTMLElement;

	/** The targets belong to the checkout on screen, which changes without this component being rebuilt. */
	onRender(): void {
		// Read here so a repository or worktree switch renders again; the load itself is keyed and does nothing twice.
		this.repos.repo();
		queueMicrotask(() => void this.run.load());
	}

	private close(): void {
		const el = this.elementRef.shadowRoot?.querySelector('#run-pop') as (HTMLElement & { component?: { close(): void } }) | null;
		el?.component?.close();
	}

	/** Choose a target from the list; with `start`, run it straight away. */
	pick(target: RunTarget, start = false): void {
		this.run.select(target);
		this.close();
		if (start) {
			void this.run.start(target);
		}
	}
}
