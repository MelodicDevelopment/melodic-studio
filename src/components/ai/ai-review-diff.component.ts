import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { nothing } from './ai-entry';
import { AiFeaturesStore } from '../../services/ai-features.store';
import { dirName, fileName, plural } from '../../shared/format';

/**
 * The main pane while a review finding is open: that file's diff over what was
 * reviewed, with every finding for the file shown at its line.
 */
@MelodicComponent({
	selector: 'ms-ai-review-diff',
	template: (self: AiReviewDiffComponent) => {
		const ai = self.ai;
		const view = ai.reviewView();
		if (!view) {
			return nothing();
		}
		const notes = ai.reviewNotes();
		const rv = ai.reviewed();
		const range = rv?.range;
		// What the diff runs over: the commits of a push or a branch, or the work in the checkout up to the files as they are.
		const over = !range ? '' : rv?.request.scope === 'work' ? ' in the reviewed changes' : ` in ${plural(range.commits.length, rv?.request.scope === 'push' ? 'unpushed commit' : 'commit')}`;
		return html`
			<div class="head">
				<button class="icon" title="Back to what you were looking at" @click=${() => ai.closeReviewView()}><ml-icon icon="arrow-left" size="sm"></ml-icon></button>
				<span class="path" title=${view.path}><span class="dir">${dirName(view.path)}</span><span class="file">${fileName(view.path)}</span></span>
				<span class="what">${plural(notes.length, 'finding')}${over}</span>
				<ml-button variant="ghost" size="sm" @ml:click=${() => ai.closeReviewView()}>Close</ml-button>
			</div>
			<ms-diff .diff=${view.diff} .notes=${notes} .focusLine=${view.line} .emptyText=${'This file has no changes in what was reviewed.'}></ms-diff>
		`;
	},
	styles: () => css`
		:host {
			flex: 1;
			min-height: 0;
			display: flex;
			flex-direction: column;
		}
		.head {
			flex: none;
			display: flex;
			align-items: center;
			gap: 9px;
			height: 36px;
			padding: 0 8px 0 6px;
			border-bottom: 1px solid var(--ms-ai-border);
			background: var(--ms-ai-subtle);
		}
		.icon {
			all: unset;
			display: grid;
			place-items: center;
			width: 26px;
			height: 26px;
			border-radius: 5px;
		}
		.icon:hover {
			background: var(--ms-hover);
		}
		.path {
			flex: 1;
			min-width: 0;
			display: flex;
			white-space: nowrap;
		}
		.dir {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			color: var(--ml-color-text-muted);
		}
		.file {
			flex: none;
			font-weight: 600;
		}
		.what {
			flex: none;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		ms-diff {
			flex: 1;
			height: auto;
			min-height: 0;
		}
	`,
})
export class AiReviewDiffComponent {
	@Service(AiFeaturesStore) readonly ai!: AiFeaturesStore;
}
