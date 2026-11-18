import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { HostWorkStore } from '../../services/host-work.store';
import { HostStore } from '../../services/host.store';
import { relativeTime } from '../../shared/format';
import { nothing } from '../ai/ai-entry';

const LABEL: Record<string, string> = { pass: 'passed', fail: 'failed', pending: 'running', skipped: 'skipped' };
const ICON: Record<string, string> = { pass: 'check-circle', fail: 'x-circle', pending: 'circle-notch', skipped: 'minus-circle' };

/** The toolbar's CI dot for the current branch, with the latest runs in a popover. Hidden when there are none. */
@MelodicComponent({
	selector: 'ms-ci-status',
	template: (self: CiStatusComponent) => {
		const work = self.work;
		const state = work.ciState();
		const runs = work.runs();
		if (!state) {
			return nothing();
		}
		return html`
			<ml-popover placement="bottom-end">
				<button slot="trigger" class="tool ${state}" title=${`CI ${LABEL[state]} on ${work.runsBranch() ?? ''}`}>
					<ml-icon icon=${ICON[state]} size="md"></ml-icon>
				</button>
				<div class="menu">
					<div class="group">CI on ${work.runsBranch()}</div>
					${runs.map(
						(r) => html`
							<div class="run">
								<ml-icon class=${r.state} icon=${ICON[r.state]} size="sm"></ml-icon>
								<div class="grow">
									<span class="name">${r.name}</span>
									<span class="dim">${r.title} · ${r.created ? relativeTime(r.created) : ''}</span>
								</div>
								${r.state === 'fail' ? html`<button class="mini" title="Run the failed jobs again" @click=${() => work.rerun(r)}><ml-icon icon="arrow-clockwise" size="sm"></ml-icon></button>` : ''}
								${r.url ? html`<button class="mini" title="Open" @click=${() => self.host.openUrl(r.url)}><ml-icon icon="arrow-square-out" size="sm"></ml-icon></button>` : ''}
							</div>
						`,
					)}
					<div class="foot"><button class="mini wide" ?disabled=${work.runsLoading()} @click=${() => work.loadRuns()}><ml-icon icon="arrows-clockwise" size="sm"></ml-icon>Refresh</button></div>
				</div>
			</ml-popover>
		`;
	},
	styles: () => css`
		:host {
			display: contents;
		}
		.tool {
			all: unset;
			display: grid;
			place-items: center;
			width: 30px;
			height: 30px;
			border-radius: 7px;
			cursor: pointer;
		}
		.tool:hover {
			background: var(--ms-hover);
		}
		.pass {
			color: var(--ms-add);
		}
		.fail {
			color: var(--ms-del);
		}
		.pending {
			color: var(--ms-mod);
		}
		.skipped {
			color: var(--ml-color-text-muted);
		}
		.menu {
			display: flex;
			flex-direction: column;
			gap: 2px;
			min-width: 300px;
			max-width: 420px;
			padding: 6px;
		}
		.group {
			padding: 4px 6px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
		}
		.run {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 5px 6px;
			border-radius: 6px;
		}
		.grow {
			flex: 1;
			min-width: 0;
			display: flex;
			flex-direction: column;
		}
		.name {
			color: var(--ml-color-text);
		}
		.dim {
			color: var(--ml-color-text-muted);
			font-size: 12px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.mini {
			all: unset;
			display: inline-flex;
			align-items: center;
			gap: 6px;
			padding: 4px;
			border-radius: 5px;
			cursor: pointer;
			color: var(--ml-color-text-muted);
		}
		.mini:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
		.foot {
			display: flex;
			justify-content: flex-end;
			border-top: 1px solid var(--ml-color-border);
			padding-top: 4px;
			margin-top: 2px;
		}
	`,
})
export class CiStatusComponent {
	@Service(HostWorkStore) readonly work!: HostWorkStore;
	@Service(HostStore) readonly host!: HostStore;

	onCreate(): void {
		this.work.watch();
	}
}
