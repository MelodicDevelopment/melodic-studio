import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { LspService } from '../../services/lsp.service';
import { nothing } from '../ai/ai-entry';

/**
 * "Rust: Indexing 42%" in the editor's header while a language server of the checkout on screen
 * reports work. Until it is done its answers can be partial, which otherwise looks like a broken editor.
 */
@MelodicComponent({
	selector: 'ms-lsp-status',
	template: (self: LspStatusComponent) => {
		const work = self.lsp.busy()[0];
		if (!work) {
			return nothing();
		}
		// The server's own words: text only.
		const what = [work.title, work.message].filter(Boolean).join(' ');
		const percent = work.percentage === null ? '' : ` ${Math.round(work.percentage)}%`;
		return html`<span class="status" title=${`The ${work.label} language server is still working. Suggestions and errors may be incomplete until it is done.`}><ml-spinner size="xs"></ml-spinner><span class="text">${work.label}${what ? `: ${what}` : ''}${percent}</span></span>`;
	},
	styles: () => css`
		:host {
			flex: 0 1 auto;
			min-width: 0;
			display: flex;
		}
		.status {
			display: flex;
			align-items: center;
			gap: 6px;
			min-width: 0;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		ml-spinner {
			flex: none;
		}
		.text {
			max-width: 320px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
	`,
})
export class LspStatusComponent {
	@Service(LspService) readonly lsp!: LspService;
}
