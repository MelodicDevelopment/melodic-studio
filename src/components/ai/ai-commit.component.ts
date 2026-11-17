import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { nothing } from './ai-entry';
import { AiFeaturesStore } from '../../services/ai-features.store';
import { RepoStore } from '../../services/repo.store';

/** The sparkle in the Summary field: writes the commit message from the checked files. Click again to stop. */
@MelodicComponent({
	selector: 'ms-ai-commit-button',
	template: (self: AiCommitButtonComponent) => {
		const ai = self.ai;
		const off = ai.unavailable();
		const writing = ai.writing();
		const none = self.repos.includedFiles().length === 0;
		const title = off || (writing ? 'Stop writing the commit message' : none ? 'Check the files to commit, then let Claude write the message' : 'Write the summary and description from the checked files');
		return html`
			<span class="wrap" title=${title}>
				<button aria-label=${title} ?disabled=${!!off || (none && !writing)} @click=${() => ai.writeCommitMessage()}>
					${writing ? html`<ml-spinner size="sm"></ml-spinner>` : html`<ml-icon icon="sparkle" size="sm"></ml-icon>`}
				</button>
			</span>
		`;
	},
	styles: () => css`
		:host {
			display: inline-flex;
			margin: -5px -7px -5px 0;
		}
		.wrap {
			display: inline-flex;
		}
		button {
			all: unset;
			display: grid;
			place-items: center;
			width: 24px;
			height: 24px;
			border-radius: 5px;
			color: var(--ml-color-primary);
		}
		button:hover:not([disabled]) {
			background: var(--ms-hover);
		}
		button:focus-visible {
			outline: 2px solid var(--ml-color-primary);
		}
		button[disabled] {
			color: var(--ml-color-text-muted);
			opacity: 0.5;
		}
	`,
})
export class AiCommitButtonComponent {
	@Service(AiFeaturesStore) readonly ai!: AiFeaturesStore;
	@Service(RepoStore) readonly repos!: RepoStore;

	onCreate(): void {
		this.ai.init();
	}
}

/**
 * A written message the user has not taken yet. It only appears when the commit form
 * already held their own text, which is never replaced without asking.
 */
@MelodicComponent({
	selector: 'ms-ai-commit-suggestion',
	template: (self: AiCommitSuggestionComponent) => {
		const s = self.ai.suggestion();
		if (!s) {
			return nothing();
		}
		return html`
			<div class="box">
				<div class="k"><ml-icon icon="sparkle" size="xs"></ml-icon>Suggested message</div>
				<div class="s">${s.summary}</div>
				${s.description ? html`<div class="d">${s.description}</div>` : ''}
				<div class="row">
					<ml-button variant="outline" size="sm" @ml:click=${() => self.ai.takeSuggestion()}>Replace mine</ml-button>
					<ml-button variant="ghost" size="sm" @ml:click=${() => self.ai.suggestion.set(null)}>Dismiss</ml-button>
				</div>
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: block;
			flex: none;
		}
		.box {
			padding: 9px 10px 10px;
			border-top: 1px solid var(--ml-color-border);
			background: var(--ml-color-primary-subtle);
		}
		.k {
			display: flex;
			align-items: center;
			gap: 5px;
			font-size: 11px;
			font-weight: 600;
			color: var(--ml-color-primary);
		}
		.s {
			margin-top: 4px;
			font-weight: 600;
			overflow-wrap: anywhere;
			user-select: text;
			-webkit-user-select: text;
		}
		.d {
			margin-top: 3px;
			max-height: 110px;
			overflow-y: auto;
			white-space: pre-wrap;
			overflow-wrap: anywhere;
			font-size: 12px;
			color: var(--ml-color-text-secondary);
			user-select: text;
			-webkit-user-select: text;
		}
		.row {
			display: flex;
			gap: 6px;
			margin-top: 8px;
		}
	`,
})
export class AiCommitSuggestionComponent {
	@Service(AiFeaturesStore) readonly ai!: AiFeaturesStore;
}
