import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { nothing } from './ai-entry';
import { AiFeaturesStore } from '../../services/ai-features.store';
import { RepoStore } from '../../services/repo.store';
import { plural } from '../../shared/format';
import { markdownStyles, renderMarkdown } from './markdown';

/**
 * A conflicted file's proposed resolution, in place of its diff: what Claude would
 * change, as a diff against the file as it is, with Accept and Discard. Until it is
 * accepted nothing has been written.
 */
@MelodicComponent({
	selector: 'ms-ai-proposal',
	template: (self: AiProposalComponent) => {
		const ai = self.ai;
		const p = ai.proposal();
		if (!p) {
			return nothing();
		}
		const ready = p.state === 'ready' || p.state === 'applying';
		return html`
			<div class="bar ${ready ? 'ready' : ''}">
				${ready
					? html`
						<ml-icon icon="sparkle" size="md"></ml-icon>
						<div class="grow">
							<div class="t">Proposed resolution for ${plural(p.conflicts, 'conflict')}</div>
							${p.summary ? html`<div class="s">${renderMarkdown(p.summary)}</div>` : ''}
							<div class="hint">This is a preview: the file has not been changed. Accepting writes it and marks the conflict resolved.</div>
						</div>
						<ml-button variant="outline" size="sm" ?disabled=${p.state === 'applying'} @ml:click=${() => ai.discardProposal()}>Discard</ml-button>
						<ml-button variant="primary" size="sm" ?loading=${p.state === 'applying'} @ml:click=${() => ai.acceptProposal()}>Accept</ml-button>
					`
					: html`
						<ml-spinner size="sm"></ml-spinner>
						<div class="grow">
							<div class="t">${p.state === 'reading' ? 'Reading the conflicts…' : `Claude is working out a resolution for ${plural(p.conflicts, 'conflict')}…`}</div>
							<div class="hint">The file is not touched while this runs.</div>
						</div>
						<ml-button variant="outline" size="sm" @ml:click=${() => ai.discardProposal()}><ml-icon slot="icon-start" icon="stop" size="sm"></ml-icon>Stop</ml-button>
					`}
			</div>
			<ms-diff .diff=${ready ? p.diff : self.repos.diff()} .emptyText=${ready ? 'The proposal is the same as the file.' : 'No content changes.'}></ms-diff>
		`;
	},
	styles: () => css`
		:host {
			flex: 1;
			min-height: 0;
			display: flex;
			flex-direction: column;
		}
		.bar {
			flex: none;
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 9px 12px 9px 14px;
			border-bottom: 1px solid var(--ml-color-border);
			background: var(--ml-color-background);
		}
		.bar.ready {
			align-items: flex-start;
			background: var(--ms-ai-subtle);
		}
		.bar > ml-icon {
			flex: none;
			margin-top: 1px;
			color: var(--ms-ai);
		}
		.bar > ml-button {
			flex: none;
		}
		.grow {
			flex: 1;
			min-width: 0;
		}
		.t {
			font-weight: 600;
		}
		.s {
			margin-top: 3px;
			max-height: 96px;
			overflow-y: auto;
			font-size: 12.5px;
		}
		.s .md p:last-child {
			margin-bottom: 0;
		}
		.hint {
			margin-top: 3px;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		ms-diff {
			flex: 1;
			height: auto;
			min-height: 0;
		}
		${markdownStyles}
	`,
})
export class AiProposalComponent {
	@Service(AiFeaturesStore) readonly ai!: AiFeaturesStore;
	@Service(RepoStore) readonly repos!: RepoStore;
}
