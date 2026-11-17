import { html } from '@melodicdev/core/template';
import type { ToolbarComponent } from './toolbar.component';
import { relativeTime } from '../../shared/format';
import type { Branch } from '../../services/backend.service';
import { terminals } from '../../services/terminal.store';

function hostIcon(provider: string): string {
	return provider === 'github' ? 'github-logo' : provider === 'gitlab' ? 'gitlab-logo' : provider === 'azure' ? 'windows-logo' : 'globe';
}

function branchRow(self: ToolbarComponent, b: Branch) {
	return html`
		<div class="item ${b.isCurrent ? 'current' : ''}" @click=${() => self.pickBranch(b)} @contextmenu=${(e: MouseEvent) => self.branchMenu(e, b)}>
			<ml-icon icon=${b.isCurrent ? 'check' : b.isRemote ? 'cloud' : 'git-branch'} size="sm"></ml-icon>
			<span class="name">${b.name}</span>
			<span class="when">${relativeTime(b.date)}</span>
			${b.isRemote
				? html`
					<span class="acts">
						<button title="Merge into current branch" @click=${(e: Event) => self.ask('branch-pop', 'merge-branch', { branch: b.name }, e)}><ml-icon icon="git-merge" size="sm"></ml-icon></button>
						<button title="Delete on the remote" @click=${(e: Event) => self.ask('branch-pop', 'delete-branch', { branch: b.name, remote: true }, e)}><ml-icon icon="trash" size="sm"></ml-icon></button>
					</span>
				`
				: html`
					<span class="acts">
						${b.isCurrent
							? ''
							: html`
								<button title="Merge into current branch" @click=${(e: Event) => self.ask('branch-pop', 'merge-branch', { branch: b.name }, e)}><ml-icon icon="git-merge" size="sm"></ml-icon></button>
								<button title="Rebase current branch onto this one" @click=${(e: Event) => self.ask('branch-pop', 'merge-branch', { branch: b.name, rebase: true }, e)}><ml-icon icon="arrow-bend-double-up-right" size="sm"></ml-icon></button>
							`}
						<button title="Rename" @click=${(e: Event) => self.ask('branch-pop', 'rename-branch', { branch: b.name }, e)}><ml-icon icon="pencil-simple" size="sm"></ml-icon></button>
						${b.isCurrent
							? ''
							: html`<button title="Delete" @click=${(e: Event) => self.ask('branch-pop', 'delete-branch', { branch: b.name }, e)}><ml-icon icon="trash" size="sm"></ml-icon></button>`}
					</span>
				`}
		</div>
	`;
}

function contextMenu(self: ToolbarComponent) {
	const store = self.store;
	const m = self.menu;
	const host = store.status()?.host ?? null;
	if (!m) {
		return '';
	}
	if (m.kind === 'repo') {
		const r = m.repo;
		const current = r.id === store.repo()?.id;
		return html`
			<div class="ctx-item" @click=${() => self.copy(r.name, 'Name')}><ml-icon icon="copy" size="sm"></ml-icon>Copy repo name</div>
			<div class="ctx-item" @click=${() => self.copy(r.path, 'Path')}><ml-icon icon="copy" size="sm"></ml-icon>Copy repo path</div>
			${r.missing
				? ''
				: html`
					${current ? '' : html`<div class="ctx-sep"></div><div class="ctx-item" @click=${() => store.openRepoTab(r.id)}><ml-icon icon="browsers" size="sm"></ml-icon>Open in a new tab</div>`}
					<div class="ctx-sep"></div>
					${current && !host ? '' : html`<div class="ctx-item" @click=${() => store.openIn('remote', null, r.id)}><ml-icon icon=${current ? hostIcon(host!.provider) : 'globe'} size="sm"></ml-icon>${current ? `View on ${host!.name}` : 'View in browser'}</div>`}
					<div class="ctx-item" @click=${() => store.openIn('terminal', null, r.id)}><ml-icon icon="terminal-window" size="sm"></ml-icon>Open in terminal</div>
					<div class="ctx-item" @click=${() => store.openIn('finder', null, r.id)}><ml-icon icon="folder-open" size="sm"></ml-icon>${self.reveal}</div>
					<div class="ctx-item" @click=${() => store.openIn('editor', null, r.id)}><ml-icon icon="code" size="sm"></ml-icon>Open in editor</div>
				`}
			<div class="ctx-sep"></div>
			<div class="ctx-item danger" @click=${() => self.menuAsk('remove-repo', { repo: r })}><ml-icon icon="x" size="sm"></ml-icon>Remove…</div>
		`;
	}
	const b = m.branch;
	const onRemote = self.remoteName(b);
	const canDelete = b.isRemote || !b.isCurrent || !!store.fallbackBranch(b.name);
	return html`
		${b.isRemote ? '' : html`<div class="ctx-item" @click=${() => self.menuAsk('rename-branch', { branch: b.name })}><ml-icon icon="pencil-simple" size="sm"></ml-icon>Rename…</div>`}
		<div class="ctx-item" @click=${() => self.copy(b.name, 'Branch name')}><ml-icon icon="copy" size="sm"></ml-icon>Copy branch name</div>
		${host && host.provider !== 'other' && onRemote
			? html`<div class="ctx-item" @click=${() => store.openIn('branch', onRemote)}><ml-icon icon=${hostIcon(host.provider)} size="sm"></ml-icon>View branch on ${host.name}</div>`
			: ''}
		${canDelete
			? html`
				<div class="ctx-sep"></div>
				<div class="ctx-item danger" @click=${() => self.menuAsk('delete-branch', b.isRemote ? { branch: b.name, remote: true } : { branch: b.name })}><ml-icon icon="trash" size="sm"></ml-icon>${b.isRemote ? 'Delete on the remote…' : 'Delete…'}</div>
			`
			: ''}
	`;
}

export function toolbarTemplate(self: ToolbarComponent) {
	const store = self.store;
	const repo = store.repo();
	const st = store.status();
	const sync = store.sync();
	const busy = store.busy();
	const syncing = busy === 'fetch' || busy === 'pull' || busy === 'push';
	const local = self.localBranches;
	const remote = self.remoteBranches;

	return html`
		<div class="bar drag ${self.mac && !store.showRepoTabs() ? 'mac' : ''}" @mousedown=${self.drag}>
			<ml-popover id="repo-pop" placement="bottom-start" offset="0" @ml:open=${() => self.opened('repo-pop')}>
				<button slot="trigger" class="seg" @contextmenu=${(e: MouseEvent) => self.repoMenu(e)}>
					<ml-icon icon="folder-simple" size="md"></ml-icon>
					<span class="txt"><span class="k">Current repository</span><span class="v">${repo?.name ?? 'None'}</span></span>
					<ml-icon icon="caret-down" size="xs"></ml-icon>
				</button>
				<div class="panel">
					<div class="filter">
						<ml-input size="sm" placeholder="Filter repositories" .value=${self.repoFilter} @ml:input=${(e: CustomEvent) => (self.repoFilter = e.detail.value)}>
							<ml-icon slot="prefix" icon="magnifying-glass" size="sm"></ml-icon>
						</ml-input>
					</div>
					<div class="list">
						${self.repos.length === 0 ? html`<div class="none">No repositories${self.repoFilter ? ' match' : ' yet'}.</div>` : ''}
						${self.repos.map(
							(r) => html`
								<div class="item ${r.id === repo?.id ? 'current' : ''}" @click=${(e: MouseEvent) => self.pickRepo(r, e.metaKey || e.ctrlKey)} @contextmenu=${(e: MouseEvent) => self.repoMenu(e, r)}>
									<ml-icon icon=${r.missing ? 'warning' : r.id === repo?.id ? 'check' : 'folder-simple'} size="sm"></ml-icon>
									<span class="name">${r.name}<span class="path">${r.missing ? 'Folder not found' : r.path}</span></span>
									<span class="acts">
										${r.id === repo?.id || r.missing ? '' : html`<button title="Open in a new tab" @click=${(e: Event) => (e.stopPropagation(), self.pickRepo(r, true))}><ml-icon icon="browsers" size="sm"></ml-icon></button>`}
										<button title="Remove from Melodic Studio" @click=${(e: Event) => self.ask('repo-pop', 'remove-repo', { repo: r }, e)}><ml-icon icon="x" size="sm"></ml-icon></button>
									</span>
								</div>
							`
						)}
					</div>
					<div class="foot">
						<ml-button variant="outline" size="sm" full-width @ml:click=${() => self.ask('repo-pop', 'add-repo')}><ml-icon slot="icon-start" icon="plus"></ml-icon>Add repository…</ml-button>
					</div>
				</div>
			</ml-popover>

			${repo && st
				? html`
					<ml-popover id="branch-pop" placement="bottom-start" offset="0" @ml:open=${() => self.opened('branch-pop')}>
						<button slot="trigger" class="seg" ?disabled=${busy === 'checkout'} @contextmenu=${(e: MouseEvent) => self.branchMenu(e)}>
							${busy === 'checkout' ? html`<ml-spinner size="sm"></ml-spinner>` : html`<ml-icon icon="git-branch" size="md"></ml-icon>`}
							<span class="txt"><span class="k">${st.detached ? 'Detached HEAD' : 'Current branch'}</span><span class="v">${st.branch}</span></span>
							<ml-icon icon="caret-down" size="xs"></ml-icon>
						</button>
						<div class="panel">
							<div class="filter">
								<ml-input size="sm" placeholder="Filter branches" .value=${self.branchFilter} @ml:input=${(e: CustomEvent) => (self.branchFilter = e.detail.value)}>
									<ml-icon slot="prefix" icon="magnifying-glass" size="sm"></ml-icon>
								</ml-input>
							</div>
							<div class="list">
								${local.length ? html`<div class="group">Local branches</div>` : ''}
								${local.map((b) => branchRow(self, b))}
								${remote.length ? html`<div class="group">Remote branches</div>` : ''}
								${remote.map((b) => branchRow(self, b))}
								${local.length + remote.length === 0 ? html`<div class="none">No branches match.</div>` : ''}
							</div>
							<div class="foot">
								<ml-button variant="outline" size="sm" full-width @ml:click=${() => self.ask('branch-pop', 'new-branch')}><ml-icon slot="icon-start" icon="plus"></ml-icon>New branch…</ml-button>
							</div>
						</div>
					</ml-popover>

					${sync
						? html`
							<button class="seg sync" ?disabled=${!!busy} @click=${() => store.runSync()}>
								${syncing ? html`<ml-spinner size="sm"></ml-spinner>` : html`<ml-icon icon=${sync.icon} size="md"></ml-icon>`}
								<span class="txt"><span class="v">${sync.label}</span><span class="k">${busy === 'fetch' ? 'Fetching…' : busy === 'pull' ? 'Pulling…' : busy === 'push' ? 'Pushing…' : sync.detail}</span></span>
								${st.upstream && st.ahead ? html`<span class="count">${st.ahead}<ml-icon icon="arrow-up" size="xs"></ml-icon></span>` : ''}
								${st.upstream && st.behind ? html`<span class="count">${st.behind}<ml-icon icon="arrow-down" size="xs"></ml-icon></span>` : ''}
							</button>
						`
						: ''}
				`
				: ''}

			<span class="spacer drag"></span>
			<ms-agent-board></ms-agent-board>
			${st?.host
				? html`
					<ml-popover id="host-pop" placement="bottom-end" offset="0">
						<button slot="trigger" class="tool wide" title=${`Open on ${st.host.name}`}><ml-icon icon=${hostIcon(st.host.provider)} size="md"></ml-icon><ml-icon icon="caret-down" size="xs"></ml-icon></button>
						<div class="panel narrow">
							<div class="list">
								<div class="group">${st.host.name}</div>
								<div class="item" @click=${() => self.openHost('remote')}><ml-icon icon="globe" size="sm"></ml-icon><span class="name">Repository</span></div>
								${st.host.issues ? html`<div class="item" @click=${() => self.openHost('issues')}><ml-icon icon="list-checks" size="sm"></ml-icon><span class="name">${st.host.issuesLabel}</span></div>` : ''}
								${st.host.pulls ? html`<div class="item" @click=${() => self.openHost('pulls')}><ml-icon icon="git-pull-request" size="sm"></ml-icon><span class="name">${st.host.pullsLabel}</span></div>` : ''}
								${st.host.pulls && st.upstream && !st.detached
									? html`<div class="item" @click=${() => self.openHost('new-pull')}><ml-icon icon="plus" size="sm"></ml-icon><span class="name">New ${st.host.pullsLabel.toLowerCase().replace(/s$/, '')} for ${st.branch}</span></div>`
									: ''}
								${st.host.issues || (st.host.pulls && !st.detached) ? html`<div class="group">In Melodic Studio</div>` : ''}
								${st.host.issues ? html`<div class="item" @click=${() => self.openHostDialog('issues')}><ml-icon icon="robot" size="sm"></ml-icon><span class="name">Browse ${st.host.issuesLabel.toLowerCase()}…</span></div>` : ''}
								${st.host.pulls && !st.detached
									? html`<div class="item" @click=${() => self.openHostDialog('pull-request')}><ml-icon icon="sparkle" size="sm"></ml-icon><span class="name">Create ${st.host.pullsLabel.toLowerCase().replace(/s$/, '')}…</span></div>`
									: ''}
							</div>
						</div>
					</ml-popover>
				`
				: ''}
			${repo && st ? html`<button class="tool" title="Terminal (Ctrl+\`)" style=${terminals().open() ? 'color: var(--ms-toolbar-fg)' : ''} @click=${() => terminals().toggle()}><ml-icon icon="terminal-window" size="md"></ml-icon></button>` : ''}
			<ms-update-pill></ms-update-pill>
			<button class="tool" title="Settings" @click=${() => store.ask('settings')}><ml-icon icon="gear" size="md"></ml-icon></button>
		</div>
		<div class="ctx" popover="manual" style="left: ${self.menu?.x ?? 0}px; top: ${self.menu?.y ?? 0}px" @contextmenu=${(e: Event) => e.preventDefault()}>${contextMenu(self)}</div>
	`;
}
