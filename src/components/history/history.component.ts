import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { ToastService } from '@melodicdev/components/toast';
import { RepoStore } from '../../services/repo.store';
import type { Commit } from '../../services/backend.service';
import { ctxStyles } from '../changes/changes.styles';
import { relativeTime } from '../../shared/format';

/** Sidebar "History" tab: the current branch's commits, newest first. */
@MelodicComponent({
	selector: 'ms-history',
	template: (self: HistoryComponent) => {
		const store = self.store;
		const commits = store.commits();
		const selected = store.selectedHash();
		const m = self.menu?.commit ?? null;
		const host = store.status()?.host ?? null;
		if (!store.historyLoaded()) {
			return html`<div class="state"><ml-spinner size="md"></ml-spinner></div>`;
		}
		if (!commits.length) {
			return html`<div class="state">No commits yet.</div>`;
		}
		return html`
			<ms-ai-review-banner></ms-ai-review-banner>
			<ms-ask-button .scope=${'history'} .look=${'bar'}></ms-ask-button>
			<div class="list">
				${commits.map(
					(c) => html`
						<div class="commit ${c.hash === selected ? 'sel' : ''}" @click=${() => store.selectCommit(c.hash)} @contextmenu=${(e: MouseEvent) => self.openMenu(e, c)}>
							<div class="top">
								<span class="summary">${c.summary}</span>
								${c.unpushed ? html`<ml-icon icon="arrow-up" size="xs" title="Not pushed yet"></ml-icon>` : ''}
							</div>
							<div class="meta">
								<span class="who">${c.authorName} · ${relativeTime(c.date)}</span>
								${c.refs
									.filter((r) => r.startsWith('tag: '))
									.map((r) => html`<ml-badge size="xs" variant="primary">${r.slice(5)}</ml-badge>`)}
							</div>
						</div>
					`
				)}
				${store.historyEnd() ? '' : html`<div class="more"><ml-button variant="ghost" size="sm" @ml:click=${() => store.loadHistory(false)}>Load more</ml-button></div>`}
			</div>
			${m
				? html`
					<div class="ctx" style="left: ${self.menu!.x}px; top: ${self.menu!.y}px">
						<div class="ctx-item" @click=${() => store.revertCommit(m.hash)}><ml-icon icon="arrow-u-up-left" size="sm"></ml-icon>Revert changes in commit</div>
						<div class="ctx-item" @click=${() => store.ask('new-branch', { commit: m })}><ml-icon icon="git-branch" size="sm"></ml-icon>Create branch from commit…</div>
						<div class="ctx-item" @click=${() => store.ask('new-tag', { commit: m })}><ml-icon icon="tag" size="sm"></ml-icon>Create tag…</div>
						${m.refs
							.filter((r) => r.startsWith('tag: '))
							.map((r) => html`<div class="ctx-item" @click=${() => store.deleteTag(r.slice(5))}><ml-icon icon="tag" size="sm"></ml-icon>Delete tag ${r.slice(5)}</div>`)}
						<div class="ctx-item" @click=${() => store.checkoutCommit(m.hash)}><ml-icon icon="sign-in" size="sm"></ml-icon>Checkout commit</div>
						<div class="ctx-sep"></div>
						<div class="ctx-item danger" @click=${() => store.ask('reset', { commit: m })}><ml-icon icon="clock-counter-clockwise" size="sm"></ml-icon>Reset branch to this commit…</div>
						<div class="ctx-sep"></div>
						${host && host.provider !== 'other' && !m.unpushed ? html`<div class="ctx-item" @click=${() => store.openIn('commit', m.hash)}><ml-icon icon="globe" size="sm"></ml-icon>View on ${host.name}</div>` : ''}
						<div class="ctx-item" @click=${() => self.copy(m.hash)}><ml-icon icon="copy" size="sm"></ml-icon>Copy SHA</div>
					</div>
				`
				: ''}
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
			flex: 1;
			min-height: 0;
		}
		.state {
			flex: 1;
			display: grid;
			place-items: center;
			color: var(--ml-color-text-muted);
		}
		.list {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
		}
		.commit {
			padding: 7px 12px;
			border-bottom: 1px solid var(--ml-color-border-muted);
		}
		.commit:hover {
			background: var(--ms-hover);
		}
		.commit.sel {
			background: var(--ms-selected);
			color: var(--ms-selected-fg);
		}
		.top {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		.summary {
			flex: 1;
			min-width: 0;
			font-weight: 500;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.top ml-icon {
			flex: none;
			color: var(--ml-color-primary);
		}
		.meta {
			display: flex;
			align-items: center;
			gap: 6px;
			margin-top: 2px;
			font-size: 11px;
			color: var(--ml-color-text-muted);
		}
		.sel .meta {
			color: inherit;
			opacity: 0.75;
		}
		.who {
			flex: 1;
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		${ctxStyles}
		.more {
			display: grid;
			place-items: center;
			padding: 10px;
		}
	`,
})
export class HistoryComponent {
	@Service(RepoStore) readonly store!: RepoStore;
	@Service(ToastService) private readonly _toast!: ToastService;

	/** Right-click menu on a commit. */
	menu: { commit: Commit; x: number; y: number } | null = null;

	private readonly _dismiss = (): void => {
		this.menu = null;
	};

	onCreate(): void {
		window.addEventListener('click', this._dismiss);
		window.addEventListener('blur', this._dismiss);
	}

	onDestroy(): void {
		window.removeEventListener('click', this._dismiss);
		window.removeEventListener('blur', this._dismiss);
	}

	openMenu(ev: MouseEvent, commit: Commit): void {
		ev.preventDefault();
		this.store.selectCommit(commit.hash);
		this.menu = { commit, x: Math.min(ev.clientX, window.innerWidth - 270), y: Math.min(ev.clientY, window.innerHeight - 300) };
	}

	async copy(hash: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(hash);
			this._toast.success('SHA copied');
		} catch {
			this._toast.error('Could not copy the SHA');
		}
	}
}
