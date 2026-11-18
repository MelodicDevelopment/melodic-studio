import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { nothing } from './ai-entry';
import { AiFeaturesStore } from '../../services/ai-features.store';
import { plural } from '../../shared/format';

/**
 * "2 commits to push · Review": a strip for the Changes and History sidebars, shown
 * while there are commits a push would send. Takes no room otherwise.
 */
@MelodicComponent({
	selector: 'ms-ai-review-banner',
	template: (self: AiReviewBannerComponent) => {
		const ai = self.ai;
		const waiting = ai.unpushed();
		if (!waiting) {
			return nothing();
		}
		const off = ai.unavailable();
		const state = ai.reviewed()?.state;
		const busy = state === 'collecting' || state === 'running';
		return html`
			<div class="strip">
				<ml-icon icon="arrow-up" size="sm"></ml-icon>
				<span class="grow">${waiting.count ? `${plural(waiting.count, 'commit')} to push` : 'Commits to push'}</span>
				<ml-button variant="ghost" size="sm" title=${off || 'Let Claude review everything a push would send'} ?disabled=${!!off} @ml:click=${() => ai.review()}>
					${busy ? html`<ml-spinner slot="icon-start" size="sm"></ml-spinner>` : html`<ml-icon slot="icon-start" icon="sparkle" size="sm"></ml-icon>`}${busy ? 'Reviewing…' : 'Review'}
				</ml-button>
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
			align-items: center;
			gap: 8px;
			padding: 3px 4px 3px 10px;
			border-top: 1px solid var(--ml-color-border);
			border-bottom: 1px solid var(--ml-color-border);
			margin-bottom: -1px;
			font-size: 12px;
			color: var(--ml-color-text-secondary);
		}
		.strip > ml-icon {
			flex: none;
			color: var(--ms-ai);
		}
		.grow {
			flex: 1;
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
	`,
})
export class AiReviewBannerComponent {
	@Service(AiFeaturesStore) readonly ai!: AiFeaturesStore;

	onCreate(): void {
		this.ai.init();
	}
}
