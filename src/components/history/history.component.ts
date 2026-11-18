import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { ToastService } from '@melodicdev/components/toast';
import { RepoStore } from '../../services/repo.store';
import { AgentsStore } from '../../services/agents.store';
import type { Commit } from '../../services/backend.service';
import { ctxStyles } from '../changes/changes.styles';
import { plural, relativeTime } from '../../shared/format';

/** One commit in a list. */
function commitRow(self: HistoryComponent, c: Commit) {
	return html`
		<div class="commit ${c.hash === self.store.selectedHash() ? 'sel' : ''}" @click=${() => self.pick(c.hash)} @contextmenu=${(e: MouseEvent) => self.openMenu(e, c)}>
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
	`;
}

/** "3↓ 1↑": how far the current branch is behind and ahead of `name`, once counted. */
function counts(self: HistoryComponent, name: string) {
	const c = self.store.compareCounts().get(name);
	return c ? html`<span class="counts" title="${c.behind} behind, ${c.ahead} ahead">${c.behind}<ml-icon icon="arrow-down" size="xs"></ml-icon>${c.ahead}<ml-icon icon="arrow-up" size="xs"></ml-icon></span>` : '';
}

/** The branch picker that replaces the list while the compare box has focus. */
function picker(self: HistoryComponent) {
	const { primary, others } = self.candidates();
	const row = (name: string) => html`
		<div class="branch ${name === self.highlighted() ? 'hl' : ''}" @mousedown=${(e: MouseEvent) => e.preventDefault()} @click=${() => self.choose(name)}>
			<ml-icon icon="git-branch" size="sm"></ml-icon><span class="name">${name}</span>${counts(self, name)}
		</div>
	`;
	return html`
		<div class="list">
			${primary ? html`<div class="group">Default branch</div>${row(primary)}` : ''}
			${others.length ? html`<div class="group">${primary ? 'Other branches' : 'Branches'}</div>${others.map(row)}` : ''}
			${!primary && !others.length ? html`<div class="none">${self.filter ? 'No branches match.' : 'There is no other branch to compare with.'}</div>` : ''}
		</div>
	`;
}

/** The comparison with the chosen branch: behind / ahead tabs, their commits, and the merge button. */
function comparison(self: HistoryComponent, branch: string) {
	const store = self.store;
	const st = store.status();
	const ahead = store.compareAhead();
	const c = store.compareCounts().get(branch);
	const commits = store.compareCommits();
	const current = st?.detached ? 'this commit' : (st?.branch ?? 'this branch');
	const behind = c?.behind ?? (ahead ? null : commits.length);
	return html`
		<div class="sides">
			<button class=${ahead ? '' : 'on'} @click=${() => store.setCompareAhead(false)}>Behind${c ? ` (${c.behind})` : ''}</button>
			<button class=${ahead ? 'on' : ''} @click=${() => store.setCompareAhead(true)}>Ahead${c ? ` (${c.ahead})` : ''}</button>
		</div>
		<div class="list">
			${!store.compareLoaded()
				? html`<div class="state"><ml-spinner size="md"></ml-spinner></div>`
				: commits.length
					? commits.map((x) => commitRow(self, x))
					: html`<div class="none">${ahead ? `${current} has no commits that ${branch} lacks.` : `${current} already has every commit on ${branch}.`}</div>`}
			${store.compareLoaded() && !store.compareEnd() ? html`<div class="more"><ml-button variant="ghost" size="sm" @ml:click=${() => store.loadCompare(false)}>Load more</ml-button></div>` : ''}
		</div>
		${!ahead && behind
			? html`
				<div class="merge">
					<ml-button variant="primary" size="sm" ?disabled=${!!store.busy() || !!st?.detached || !!st?.mergeInProgress} ?loading=${store.busy() === 'merge'} @ml:click=${() => store.merge(branch)}>
						Merge into ${st?.branch ?? 'this branch'}
					</ml-button>
					<small>${st?.detached ? 'Check out a branch to merge into it.' : `Brings ${plural(behind, 'commit')} from ${branch} into ${current}.`}</small>
					${st?.detached
						? ''
						: html`
							<div class="ways">
								<a @click=${() => store.ask('merge-branch', { branch, squash: true })}>Squash and merge…</a>
								<a @click=${() => store.ask('cherry-pick', { branch })}>Cherry-pick…</a>
								<a @click=${() => store.ask('merge-branch', { branch, rebase: true })}>Rebase…</a>
							</div>
						`}
				</div>
			`
			: ''}
	`;
}

/** Sidebar "History" tab: the current branch's commits, newest first, or a comparison with another branch. */
@MelodicComponent({
	selector: 'ms-history',
	template: (self: HistoryComponent) => {
		const store = self.store;
		const commits = store.commits();
		const m = self.menu?.commit ?? null;
		const foreign = !!self.menu?.foreign;
		const st = store.status();
		const here = st?.detached ? 'this commit' : (st?.branch ?? 'this branch');
		const idle = !st?.operation;
		const host = store.status()?.host ?? null;
		const branch = store.compareBranch();
		if (!store.historyLoaded()) {
			return html`<div class="state"><ml-spinner size="md"></ml-spinner></div>`;
		}
		const only = store.historyPath();
		const fileBar = only
			? html`
				<div class="compare">
					<div class="chosen" title=${`Commits that touched ${only}`}>
						<ml-icon icon="file" size="sm"></ml-icon><span class="name">${only}</span>
						<button title="Show every commit" @click=${() => store.showFileHistory(null)}><ml-icon icon="x" size="sm"></ml-icon></button>
					</div>
				</div>
			`
			: '';
		if (!commits.length) {
			return only ? html`${fileBar}<div class="state">No commits touched this file yet.</div>` : html`<div class="state">No commits yet.</div>`;
		}
		return html`
			<ms-ai-review-banner></ms-ai-review-banner>
			<ms-ask-button .scope=${'history'} .look=${'bar'}></ms-ask-button>
			${fileBar}
			<div class="compare" style=${only ? 'display: none' : ''}>
				${branch
					? html`
						<div class="chosen" title="Comparing with ${branch}">
							<ml-icon icon="git-branch" size="sm"></ml-icon><span class="name">${branch}</span>
							<button title="Stop comparing (Esc)" @click=${() => self.clear()}><ml-icon icon="x" size="sm"></ml-icon></button>
						</div>
					`
					: html`
						<label class="box ${self.picking ? 'focus' : ''}">
							<ml-icon icon="git-branch" size="sm"></ml-icon>
							<input
								placeholder="Select branch to compare…"
								spellcheck="false"
								.value=${self.filter}
								@focus=${() => self.startPicking()}
								@blur=${() => (self.picking = false)}
								@input=${(e: Event) => self.setFilter((e.target as HTMLInputElement).value)}
								@keydown=${(e: KeyboardEvent) => self.onKey(e)}
							/>
						</label>
					`}
			</div>
			${branch
				? comparison(self, branch)
				: self.picking
					? picker(self)
					: html`
						<div class="list">
							${commits.map((c) => commitRow(self, c))}
							${store.historyEnd() ? '' : html`<div class="more"><ml-button variant="ghost" size="sm" @ml:click=${() => store.loadHistory(false)}>Load more</ml-button></div>`}
						</div>
					`}
			${m
				? html`
					<div class="ctx" style="left: ${self.menu!.x}px; top: ${self.menu!.y}px">
						${foreign
							? html`
								<div class="ctx-item ${idle && !st?.detached ? '' : 'off'}" @click=${() => idle && !st?.detached && store.cherryPick([m.hash])}><ml-icon icon="git-commit" size="sm"></ml-icon>Cherry-pick onto ${here}</div>
								<div class="ctx-item ${idle && !st?.detached ? '' : 'off'}" @click=${() => idle && !st?.detached && store.ask('cherry-pick', { branch: branch!, hashes: [m.hash] })}><ml-icon icon="list-checks" size="sm"></ml-icon>Cherry-pick several…</div>
								<div class="ctx-sep"></div>
							`
							: html`
								<div class="ctx-item" @click=${() => store.revertCommit(m.hash)}><ml-icon icon="arrow-u-up-left" size="sm"></ml-icon>Revert changes in commit</div>
								<div class="ctx-item ${idle ? '' : 'off'}" @click=${() => idle && store.ask('rebase-interactive', { upstream: m.parents[0] ?? null, commit: m, hashes: [m.hash] })}><ml-icon icon="pencil-simple" size="sm"></ml-icon>Edit commit message…</div>
								<div class="ctx-item ${idle ? '' : 'off'}" @click=${() => idle && store.ask('rebase-interactive', { upstream: m.parents[0] ?? null, commit: m })}><ml-icon icon="stack" size="sm"></ml-icon>Squash, reorder or drop from here…</div>
							`}
						<div class="ctx-item" @click=${() => store.ask('new-branch', { commit: m })}><ml-icon icon="git-branch" size="sm"></ml-icon>Create branch from commit…</div>
						<div class="ctx-item" @click=${() => store.ask('new-tag', { commit: m })}><ml-icon icon="tag" size="sm"></ml-icon>Create tag…</div>
						${m.refs
							.filter((r) => r.startsWith('tag: '))
							.map((r) => html`<div class="ctx-item" @click=${() => store.deleteTag(r.slice(5))}><ml-icon icon="tag" size="sm"></ml-icon>Delete tag ${r.slice(5)}</div>`)}
						<div class="ctx-item" @click=${() => store.checkoutCommit(m.hash)}><ml-icon icon="sign-in" size="sm"></ml-icon>Checkout commit</div>
						<div class="ctx-sep"></div>
						${foreign ? '' : html`<div class="ctx-item danger" @click=${() => store.ask('reset', { commit: m })}><ml-icon icon="clock-counter-clockwise" size="sm"></ml-icon>Reset branch to this commit…</div><div class="ctx-sep"></div>`}
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
			margin: 1px 6px;
			padding: 7px 10px;
			border-radius: 8px;
		}
		.commit:hover {
			background: var(--ms-hover);
		}
		.commit.sel {
			background: var(--ms-selected);
			color: var(--ms-selected-fg);
			box-shadow: inset 0 0 0 1px var(--ms-selected-ring);
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
		.compare {
			flex: none;
			padding: 8px 10px;
			border-bottom: 1px solid var(--ml-color-border);
		}
		.box,
		.chosen {
			display: flex;
			align-items: center;
			gap: 6px;
			height: 28px;
			padding: 0 8px;
			border: 1px solid var(--ml-color-border);
			border-radius: 8px;
			background: var(--ml-color-surface);
			color: var(--ml-color-text-muted);
		}
		.box.focus {
			border-color: var(--ml-color-primary);
		}
		.box input {
			all: unset;
			flex: 1;
			min-width: 0;
			font-size: 12px;
			color: var(--ml-color-text);
		}
		.box input::placeholder {
			color: var(--ml-color-text-muted);
		}
		.chosen {
			color: var(--ml-color-text);
		}
		.chosen .name,
		.branch .name {
			flex: 1;
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.chosen button {
			all: unset;
			display: grid;
			place-items: center;
			width: 20px;
			height: 20px;
			border-radius: 4px;
			color: var(--ml-color-text-muted);
		}
		.chosen button:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
		.group {
			padding: 10px 12px 4px;
			font-size: 11px;
			font-weight: 600;
			letter-spacing: 0.04em;
			text-transform: uppercase;
			color: var(--ml-color-text-muted);
		}
		.branch {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 6px 12px;
			cursor: default;
		}
		.branch:hover,
		.branch.hl {
			background: var(--ms-hover);
		}
		.branch > ml-icon {
			flex: none;
			color: var(--ml-color-text-muted);
		}
		.counts {
			flex: none;
			display: flex;
			align-items: center;
			gap: 1px;
			font-size: 11px;
			font-variant-numeric: tabular-nums;
			color: var(--ml-color-text-muted);
		}
		.counts ml-icon + * {
			margin-left: 4px;
		}
		.none {
			padding: 18px 14px;
			text-align: center;
			color: var(--ml-color-text-muted);
		}
		.sides {
			flex: none;
			display: flex;
			border-bottom: 1px solid var(--ml-color-border);
		}
		.sides button {
			all: unset;
			flex: 1;
			text-align: center;
			padding: 7px 0;
			font-size: 12px;
			color: var(--ml-color-text-secondary);
			border-bottom: 2px solid transparent;
		}
		.sides button:hover {
			color: var(--ml-color-text);
		}
		.sides button.on {
			color: var(--ml-color-text);
			font-weight: 600;
			border-bottom-color: var(--ml-color-primary);
		}
		.merge {
			flex: none;
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 10px 12px;
			border-top: 1px solid var(--ml-color-border);
		}
		.merge ml-button {
			display: block;
		}
		.merge small {
			color: var(--ml-color-text-muted);
			font-size: 11px;
		}
		.ways {
			display: flex;
			flex-wrap: wrap;
			gap: 4px 12px;
			font-size: 12px;
		}
		.ways a {
			color: var(--ml-color-primary);
			cursor: pointer;
		}
		.ways a:hover {
			text-decoration: underline;
		}
		.ctx-item.off {
			opacity: 0.45;
			pointer-events: none;
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
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(ToastService) private readonly _toast!: ToastService;

	/** Right-click menu on a commit. */
	menu: { commit: Commit; x: number; y: number; foreign: boolean } | null = null;
	/** The compare box has focus: the list shows branches to pick from. */
	picking = false;
	filter = '';
	/** Branch the arrow keys are on in the picker. */
	private _hl: string | null = null;

	elementRef!: HTMLElement;

	/** Esc stops comparing while the History tab is on screen (not while typing in a field or a dialog is open). */
	private readonly _esc = (e: KeyboardEvent): void => {
		const target = e.composedPath()[0] as HTMLElement | undefined;
		if (e.key === 'Escape' && this.store.compareBranch() && !this.menu && !(target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) && !target?.isContentEditable && !document.querySelector('ml-dialog[open]')) {
			this.clear();
		}
	};

	private readonly _dismiss = (): void => {
		this.menu = null;
	};

	onCreate(): void {
		window.addEventListener('click', this._dismiss);
		window.addEventListener('blur', this._dismiss);
		window.addEventListener('keydown', this._esc);
	}

	onDestroy(): void {
		window.removeEventListener('click', this._dismiss);
		window.removeEventListener('blur', this._dismiss);
		window.removeEventListener('keydown', this._esc);
	}

	/** Branches to compare with, filtered: the default branch first, then the rest by most recent commit. */
	candidates(): { primary: string | null; others: string[] } {
		const st = this.store.status();
		const all = this.store.branches();
		const current = all.find((b) => b.isCurrent);
		const q = this.filter.trim().toLowerCase();
		// A remote branch that a local one tracks adds nothing; the current branch and its upstream (that is Pull) are left out.
		const tracked = new Set(all.filter((b) => !b.isRemote && b.upstream).map((b) => b.upstream));
		const names = all
			.filter((b) => !b.isCurrent && b.name !== current?.upstream && (!b.isRemote || !tracked.has(b.name)))
			.map((b) => b.name)
			.filter((n) => !q || n.toLowerCase().includes(q));
		const def = st?.defaultBranch;
		const primary = def ? (names.find((n) => n === def) ?? names.find((n) => n === `${st?.remote ?? 'origin'}/${def}`) ?? null) : null;
		return { primary, others: names.filter((n) => n !== primary) };
	}

	private flat(): string[] {
		const { primary, others } = this.candidates();
		return primary ? [primary, ...others] : others;
	}

	highlighted(): string | null {
		const list = this.flat();
		return this._hl && list.includes(this._hl) ? this._hl : (list[0] ?? null);
	}

	startPicking(): void {
		this.picking = true;
		void this.store.loadCompareCounts(this.flat().filter((n) => !this.store.compareCounts().has(n)));
	}

	setFilter(value: string): void {
		this.filter = value;
		this._hl = null;
	}

	onKey(e: KeyboardEvent): void {
		const list = this.flat();
		const at = list.indexOf(this.highlighted() ?? '');
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const next = list[Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))];
			this._hl = next ?? null;
			this.picking = true;
			requestAnimationFrame(() => this.elementRef.shadowRoot?.querySelector('.branch.hl')?.scrollIntoView({ block: 'nearest' }));
		} else if (e.key === 'Enter') {
			const name = this.highlighted();
			if (name) {
				this.choose(name);
			}
		} else if (e.key === 'Escape') {
			this.filter = '';
			(e.target as HTMLInputElement).blur();
		}
	}

	choose(name: string): void {
		this.filter = '';
		this._hl = null;
		this.picking = false;
		void this.store.setCompare(name);
	}

	clear(): void {
		void this.store.setCompare(null);
	}

	/** Show a commit in the main pane, in place of a docked history question. */
	pick(hash: string): void {
		this.store.selectCommit(hash);
		this.agents.hideHistoryChat();
	}

	openMenu(ev: MouseEvent, commit: Commit): void {
		ev.preventDefault();
		this.pick(commit.hash);
		// In the Behind list of a comparison the commit is on the other branch, not this one.
		const foreign = !!this.store.compareBranch() && !this.store.compareAhead();
		this.menu = { commit, x: Math.min(ev.clientX, window.innerWidth - 290), y: Math.min(ev.clientY, window.innerHeight - 340), foreign };
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
