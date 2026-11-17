import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { AgentsStore } from '../../services/agents.store';
import { RepoStore } from '../../services/repo.store';

/** A strip across the top while the app is looking at a linked worktree instead of the main checkout. */
@MelodicComponent({
	selector: 'rm-worktree-banner',
	template: (self: WorktreeBannerComponent) => {
		const path = self.repos.repo()?.worktree;
		if (!path) {
			return html``;
		}
		return html`
			<div class="bar">
				<ml-icon icon="tree-structure" size="sm"></ml-icon>
				<span class="grow">Viewing the worktree for <b>${self.repos.status()?.branch ?? ''}</b>. Changes, History and Files all show this checkout.</span>
				<a @click=${() => self.agents.view(null)}>Back to main checkout</a>
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: block;
			flex: none;
		}
		.bar {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 6px 14px;
			background: var(--ml-color-primary-subtle);
			border-bottom: 1px solid var(--ml-color-border);
			font-size: 12px;
		}
		.grow {
			flex: 1;
			min-width: 0;
		}
		ml-icon {
			color: var(--ml-color-primary);
		}
		a {
			color: var(--ml-color-primary);
			text-decoration: underline;
			cursor: pointer;
		}
	`,
})
export class WorktreeBannerComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(RepoStore) readonly repos!: RepoStore;
}
