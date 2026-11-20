import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { nothing } from './ai-entry';
import { AiFeaturesStore } from '../../services/ai-features.store';

/**
 * "Review  [3 uncommitted] [2 to push] [vs main]": a strip for the Changes and History sidebars
 * with one button for each thing Claude can review in this checkout (`AiFeaturesStore.offers`).
 * Takes no room when there is none.
 */
@MelodicComponent({
	selector: 'ms-ai-review-banner',
	template: (self: AiReviewBannerComponent) => {
		const ai = self.ai;
		const offers = ai.offers();
		if (!offers.length) {
			return nothing();
		}
		const off = ai.unavailable();
		return html`
			<div class="strip">
				<span class="what"><ml-icon icon="sparkle" size="sm"></ml-icon>Review</span>
				${offers.map((o) => {
					const busy = ai.reviewing(o.request);
					return html`
						<ml-button variant="outline" size="xs" title=${off || o.detail} ?disabled=${!!off} @ml:click=${() => ai.review(o.request)}>
							${busy ? html`<ml-spinner slot="icon-start" size="sm"></ml-spinner>` : ''}${busy ? 'Reviewing…' : o.chip}
						</ml-button>
					`;
				})}
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: block;
			flex: none;
		}
		.strip {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 4px;
			padding: 5px 5px 5px 7px;
			border-top: 1px solid var(--ml-color-border);
			border-bottom: 1px solid var(--ml-color-border);
			margin-bottom: -1px;
			font-size: 12px;
			color: var(--ml-color-text-secondary);
		}
		.what {
			display: inline-flex;
			align-items: center;
			gap: 5px;
			white-space: nowrap;
		}
		.what ml-icon {
			color: var(--ms-ai);
		}
		ml-button {
			white-space: nowrap;
		}
	`,
})
export class AiReviewBannerComponent {
	@Service(AiFeaturesStore) readonly ai!: AiFeaturesStore;

	onCreate(): void {
		this.ai.init();
	}
}
