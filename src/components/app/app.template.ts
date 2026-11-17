import { html } from '@melodicdev/core/template';
import type { AppComponent } from './app.component';
import type { FileChange } from '../../services/backend.service';
import { dirName, fileName, longTime, plural, statusMark } from '../../shared/format';
import type { ParsedDiff } from '../../shared/diff';
import { aiSidePanel, explainButton, fileAction, proposalPane, reviewCard, reviewPane } from '../ai/ai-entry';

function fileHead(file: FileChange, diff: ParsedDiff | null, action: unknown = '') {
	const mark = statusMark(file.status);
	return html`
		<div class="filehead">
			<span class="mark ${mark.tone}" title=${mark.label}>${mark.letter}</span>
			<span class="path">${file.oldPath ? html`<span class="dir">${file.oldPath} → </span>` : ''}<span class="dir">${dirName(file.path)}</span><span class="file">${fileName(file.path)}</span></span>
			${diff && !diff.binary && (diff.added || diff.removed)
				? html`<span class="stat add">+${diff.added}</span><span class="stat del">−${diff.removed}</span>`
				: ''}
			${action}
		</div>
	`;
}

function emptyText(file: FileChange): string {
	if (file.status === 'added' || file.status === 'untracked') {
		return 'This file is empty.';
	}
	if (file.status === 'renamed') {
		return 'Renamed without changes.';
	}
	return 'No content changes.';
}

function welcome(self: AppComponent) {
	const store = self.store;
	return html`
		<div class="welcome">
			<ml-icon icon="git-branch" size="xl"></ml-icon>
			<h1>Welcome to Melodic Studio</h1>
			<p>Commit, branch and sync your git repositories. Add one to get started.</p>
			${store.app()?.gitVersion ? '' : html`<p class="warn">Git was not found on this computer. Install git, then restart Melodic Studio.</p>`}
			<div class="cards">
				<button class="card" @click=${() => store.ask('add-repo', { tab: 'add' })}>
					<ml-icon icon="folder-simple-plus" size="md"></ml-icon><span><b>Add an existing repository</b><small>One that is already on this computer</small></span>
				</button>
				<button class="card" @click=${() => store.ask('add-repo', { tab: 'clone' })}>
					<ml-icon icon="cloud-arrow-down" size="md"></ml-icon><span><b>Clone a repository</b><small>From GitHub or any other git host</small></span>
				</button>
				<button class="card" @click=${() => store.ask('add-repo', { tab: 'create' })}>
					<ml-icon icon="plus-circle" size="md"></ml-icon><span><b>Create a new repository</b><small>Start a fresh project</small></span>
				</button>
			</div>
		</div>
	`;
}

function noChanges(self: AppComponent) {
	const store = self.store;
	const st = store.status();
	const sync = store.sync();
	const busy = store.busy();
	return html`
		<div class="empty">
			<h2>No local changes</h2>
			<p>There is nothing uncommitted in this repository. Here is what you might do next.</p>
			<div class="cards">
				${sync && sync.kind !== 'fetch'
					? html`
						<button class="card primary" ?disabled=${!!busy} @click=${() => store.runSync()}>
							<ml-icon icon=${sync.icon} size="md"></ml-icon>
							<span>
								<b>${sync.label}</b>
								<small>
									${sync.kind === 'push'
										? `${plural(st?.ahead ?? 0, 'commit')} waiting to be pushed`
										: sync.kind === 'pull'
											? `${plural(st?.behind ?? 0, 'commit')} to bring in`
											: sync.detail}
								</small>
							</span>
						</button>
					`
					: ''}
				${reviewCard()}
				<button class="card" @click=${() => store.openIn('editor')}>
					<ml-icon icon="code" size="md"></ml-icon><span><b>Open in your editor</b><small>${store.app()?.editor ?? 'code'}</small></span>
				</button>
				<button class="card" @click=${() => store.openIn('finder')}>
					<ml-icon icon="folder-open" size="md"></ml-icon><span><b>Show in file manager</b><small>${store.repo()?.path ?? ''}</small></span>
				</button>
				<button class="card" @click=${() => store.openIn('terminal')}>
					<ml-icon icon="terminal-window" size="md"></ml-icon><span><b>Open in terminal</b><small>For everything Melodic Studio does not do</small></span>
				</button>
				${st?.host
					? html`
						<button class="card" @click=${() => store.openIn('remote')}>
							<ml-icon icon="globe" size="md"></ml-icon><span><b>View on ${st.host.provider === 'other' ? 'the web' : st.host.name}</b><small>${st.host.web}</small></span>
						</button>
						${st.host.issues
							? html`
								<button class="card" @click=${() => store.openIn('issues')}>
									<ml-icon icon="list-checks" size="md"></ml-icon><span><b>Open ${st.host.issuesLabel.toLowerCase()}</b><small>See what is waiting on ${st.host.name}</small></span>
								</button>
							`
							: ''}
						${st.host.pulls && st.upstream && !st.detached
							? html`
								<button class="card" @click=${() => store.openIn('new-pull')}>
									<ml-icon icon="git-pull-request" size="md"></ml-icon><span><b>Create a ${st.host.pullsLabel.toLowerCase().replace(/s$/, '')}</b><small>From ${st.branch}</small></span>
								</button>
							`
							: ''}
					`
					: ''}
			</div>
		</div>
	`;
}

function changesPane(self: AppComponent) {
	const store = self.store;
	const finding = reviewPane();
	if (finding) {
		return finding;
	}
	const file = store.selectedFile();
	if (!file) {
		return noChanges(self);
	}
	const diff = store.diff();
	const pinned = store.openTabs();
	// The file picked in the list shows as a preview tab until it is pinned.
	const tabs = pinned.length && !pinned.includes(file.path) ? [...pinned, file.path] : pinned;
	return html`
		${tabs.length
			? html`
				<div class="filetabs">
					${tabs.map(
						(path) => html`
							<div class="filetab ${path === file.path ? 'on' : ''} ${pinned.includes(path) ? '' : 'preview'}" title=${path} @click=${() => store.selectFile(path)} @dblclick=${() => store.openTab(path)}>
								<span>${fileName(path)}</span>
								${pinned.includes(path) ? html`<button title="Close tab" @click=${(e: Event) => (e.stopPropagation(), store.closeTab(path))}><ml-icon icon="x" size="xs"></ml-icon></button>` : ''}
							</div>
						`
					)}
				</div>
			`
			: ''}
		${fileHead(file, diff, fileAction(file))}${proposalPane(file) ?? html`<ms-diff .diff=${diff} .emptyText=${emptyText(file)}></ms-diff>`}
	`;
}

function historyPane(self: AppComponent) {
	const store = self.store;
	const finding = reviewPane();
	if (finding) {
		return finding;
	}
	const commit = store.selectedCommit();
	if (!commit) {
		return html`<div class="empty"><h2>${store.historyLoaded() ? 'No commits yet' : ''}</h2></div>`;
	}
	const files = store.commitFiles();
	const selected = store.selectedCommitPath();
	const file = store.selectedCommitFile();
	const diff = store.commitDiff();
	const refs = commit.refs.map((r) => r.replace(/^HEAD -> /, '')).filter((r) => r !== 'HEAD');
	return html`
		<div class="commithead">
			<h2>${commit.summary}</h2>
			${commit.body ? html`<pre>${commit.body}</pre>` : ''}
			<div class="meta">
				<span><ml-icon icon="user" size="sm"></ml-icon>${commit.authorName}</span>
				<span class="hash" title="Copy the full hash" @click=${() => self.copyHash(commit.hash)}><ml-icon icon="git-commit" size="sm"></ml-icon>${commit.shortHash}</span>
				<span title=${longTime(commit.date)}><ml-icon icon="clock" size="sm"></ml-icon>${longTime(commit.date)}</span>
				<span><ml-icon icon="files" size="sm"></ml-icon>${plural(files.length, 'changed file')}</span>
				${commit.unpushed ? html`<ml-badge size="xs" variant="warning">Not pushed</ml-badge>` : ''}
				${refs.map((r) => html`<ml-badge size="xs" variant=${r.startsWith('tag: ') ? 'primary' : 'default'}>${r.replace(/^tag: /, '')}</ml-badge>`)}
				${explainButton({ kind: 'commit', commit }, 'margin: -4px 0 -4px auto')}
			</div>
		</div>
		<div class="split">
			<div class="files list">
				${files.map((f) => {
					const mark = statusMark(f.status);
					return html`
						<div class="row ${f.path === selected ? 'sel' : ''}" title=${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} @click=${() => store.selectCommitFile(f.path)}>
							<span class="path"><span class="dir">${dirName(f.path)}</span><span class="file">${fileName(f.path)}</span></span>
							<span class="mark ${mark.tone}" title=${mark.label}>${mark.letter}</span>
						</div>
					`;
				})}
			</div>
			<div class="diffcol">
				${file ? html`${fileHead(file, diff)}<ms-diff .diff=${diff} .emptyText=${emptyText(file)}></ms-diff>` : files.length || !diff ? html`<ms-diff .diff=${null}></ms-diff>` : html`<div class="empty"><p>This commit changed no files.</p></div>`}
			</div>
		</div>
	`;
}

export function appTemplate(self: AppComponent) {
	const store = self.store;
	const repo = store.repo();
	const st = store.status();
	const tab = store.tab();
	const error = store.statusError();
	const count = st?.files.length ?? 0;

	return html`
		<ms-toolbar></ms-toolbar>
		${!store.ready()
			? html`<div class="center"><ml-spinner size="lg"></ml-spinner></div>`
			: !repo
				? welcome(self)
				: error
					? html`
						<div class="empty">
							<h2>Cannot open ${repo.name}</h2>
							<p class="selectable">${error}</p>
							<div class="actions">
								<ml-button variant="outline" @ml:click=${() => store.refresh()}>Try again</ml-button>
								<ml-button variant="danger" @ml:click=${() => store.ask('remove-repo', { repo })}>Remove from Melodic Studio</ml-button>
							</div>
						</div>
					`
					: !st
						? html`<div class="center"><ml-spinner size="lg"></ml-spinner></div>`
						: html`
							<ms-worktree-banner></ms-worktree-banner>
							<div class="work ${self.resizing ? 'resizing' : ''}">
								<aside style="width: ${self.sidebarWidth}px">
									<div class="tabs">
										<button class="tab ${tab === 'changes' ? 'on' : ''}" @click=${() => store.setTab('changes')}>Changes${count ? html`<span class="count">${count}</span>` : ''}</button>
										<button class="tab ${tab === 'history' ? 'on' : ''}" @click=${() => store.setTab('history')}>History</button>
										<button class="tab ${tab === 'files' ? 'on' : ''}" @click=${() => store.setTab('files')}>Files</button>
										<button class="tab ${tab === 'agents' ? 'on' : ''}" @click=${() => store.setTab('agents')}>Agents</button>
									</div>
									${tab === 'changes' ? html`<ms-changes></ms-changes>` : tab === 'history' ? html`<ms-history></ms-history>` : tab === 'agents' ? html`<ms-agents></ms-agents>` : html`<ms-explorer></ms-explorer>`}
								</aside>
								<div class="resizer" @pointerdown=${self.startResize} @dblclick=${() => self.resetWidth()}></div>
								<main>${tab === 'changes' ? changesPane(self) : tab === 'history' ? historyPane(self) : tab === 'agents' ? html`<ms-agent-session></ms-agent-session>` : html`<ms-editor></ms-editor>`}</main>
								${aiSidePanel()}
							</div>
						`}
		<ms-dialogs></ms-dialogs>
	`;
}
