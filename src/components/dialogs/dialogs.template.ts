import { html } from '@melodicdev/core/template';
import type { AddTab, DialogsComponent, SettingsTab } from './dialogs.component';
import type { ThemeMode } from '../../shared/theme';
import { plural } from '../../shared/format';
import { isWindows, type ScanHit } from '../../services/backend.service';
import { hostIcon } from '../../shared/repo-groups';

const RESET_MODES = [
	{ value: 'soft', label: 'Soft: keep the later changes staged' },
	{ value: 'mixed', label: 'Mixed: keep the later changes as uncommitted edits' },
	{ value: 'hard', label: 'Hard: throw the later changes away' },
];

const THEMES = [
	{ value: 'system', label: 'Match system' },
	{ value: 'light', label: 'Light' },
	{ value: 'dark', label: 'Dark' },
];

function folderField(self: DialogsComponent, label: string, field: 'addPath' | 'cloneParent' | 'createParent' | 'scanRoot', placeholder: string) {
	return html`
		<div class="pathrow">
			<ml-input label=${label} placeholder=${placeholder} .value=${self[field]} @ml:input=${(e: CustomEvent) => (self[field] = e.detail.value)}></ml-input>
			<ml-button variant="outline" @ml:click=${() => self.browse(field)}>Choose…</ml-button>
		</div>
	`;
}

function groupBox(self: DialogsComponent, items: ScanHit[], label: string) {
	const st = self.pickedState(items);
	return html`<ml-checkbox size="sm" label=${label} .checked=${st.checked} .indeterminate=${st.mixed} ?disabled=${st.disabled} @ml:change=${(e: CustomEvent) => self.pick(items, e.detail.checked)}></ml-checkbox>`;
}

function scanTab(self: DialogsComponent) {
	const result = self.scanResult;
	const fresh = self.scanNew;
	return html`
		<p>Choose a folder and Melodic Studio looks through it for git repositories. Nothing is added until you tick the ones you want.</p>
		<div class="pathrow">
			<ml-input label="Folder" placeholder=${isWindows() ? 'C:\\Users\\me\\Source' : '~/Source'} .value=${self.scanRoot} @ml:input=${(e: CustomEvent) => (self.scanRoot = e.detail.value)} @keydown=${(e: KeyboardEvent) => e.key === 'Enter' && self.scan()}></ml-input>
			<ml-button variant="outline" @ml:click=${() => self.browse('scanRoot')}>Choose…</ml-button>
			<ml-button variant="outline" ?disabled=${!self.scanRoot.trim()} ?loading=${self.scanning} @ml:click=${() => self.scan()}><ml-icon slot="icon-start" icon="magnifying-glass"></ml-icon>Scan</ml-button>
		</div>
		${!result
			? ''
			: result.repos.length === 0
				? html`<p class="scan-none">No repositories in that folder.</p>`
				: html`
					<div class="scan-head">
						${groupBox(self, result.repos, `${result.repos.length} found${fresh.length < result.repos.length ? `, ${result.repos.length - fresh.length} already added` : ''}`)}
						<span class="scan-count">${self.scanPicked.size} selected</span>
					</div>
					${result.truncated ? html`<div class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>The folder is large, so the scan stopped early. Scan a folder closer to your repositories to see the rest.</span></div>` : ''}
					<div class="scan-list">
						${self.scanGroups.map(
							(g) => html`
								<div class="scan-host"><ml-icon icon=${hostIcon(g.provider)} size="sm"></ml-icon>${groupBox(self, g.owners.flatMap((o) => o.items), `${g.label} (${g.count})`)}</div>
								${g.owners.map(
									(o) => html`
										${o.owner ? html`<div class="scan-owner">${groupBox(self, o.items, o.owner)}</div>` : ''}
										${o.items.map(
											(r) => html`
												<div class="scan-row ${r.added ? 'added' : ''} ${o.owner ? 'deep' : ''}" title=${r.path}>
													<ml-checkbox size="sm" .checked=${r.added || self.scanPicked.has(r.path)} ?disabled=${r.added} @ml:change=${(e: CustomEvent) => self.pick([r], e.detail.checked)}></ml-checkbox>
													<span class="scan-name">${r.name}<span class="scan-path">${r.path}</span></span>
													${r.added ? html`<span class="scan-tag">Added</span>` : ''}
												</div>
											`
										)}
									`
								)}
							`
						)}
					</div>
				`}
	`;
}

export function dialogsTemplate(self: DialogsComponent) {
	const store = self.store;
	const busy = store.busy();
	const prompt = store.prompt();
	const st = store.status();
	const app = store.app();
	const files = prompt.files ?? [];

	return html`
		<ml-dialog #add-repo style=${`--ml-dialog-max-width: ${self.addTab === 'scan' ? 600 : 520}px`} @ml:open=${(e: Event) => e.target === e.currentTarget && self.openedAdd()}>
			<h3 slot="dialog-header">Add a repository</h3>
			<div class="dlg">
				<ml-tabs size="sm" variant="pills" value=${self.addTab} @ml:change=${(e: CustomEvent) => (self.addTab = e.detail.value as AddTab)}>
					<ml-tab slot="tab" value="add" label="Open a folder"></ml-tab>
					<ml-tab slot="tab" value="scan" label="Scan a folder"></ml-tab>
					<ml-tab slot="tab" value="clone" label="Clone"></ml-tab>
					<ml-tab slot="tab" value="create" label="Create new"></ml-tab>
				</ml-tabs>
				${self.addTab === 'add'
					? html`
						<p>Pick any folder on this computer. If it is not a git repository yet, Melodic Studio sets one up there.</p>
						${folderField(self, 'Local path', 'addPath', isWindows() ? 'C:\\path\\to\\folder' : '/path/to/folder')}
					`
					: self.addTab === 'scan'
						? scanTab(self)
					: self.addTab === 'clone'
						? html`
							<p>Clone uses your own git setup, so SSH keys and credential helpers work as they do in a terminal.</p>
							<ml-input label="Repository URL" placeholder="git@github.com:owner/repo.git" .value=${self.cloneUrl} @ml:input=${(e: CustomEvent) => (self.cloneUrl = e.detail.value)}></ml-input>
							${folderField(self, 'Clone into', 'cloneParent', isWindows() ? 'C:\\path\\to\\parent\\folder' : '/path/to/parent/folder')}
						`
						: html`
							<ml-input label="Name" placeholder="my-project" .value=${self.createName} @ml:input=${(e: CustomEvent) => (self.createName = e.detail.value)}></ml-input>
							${folderField(self, 'Create in', 'createParent', isWindows() ? 'C:\\path\\to\\parent\\folder' : '/path/to/parent/folder')}
						`}
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('add-repo')}>Cancel</ml-button>
				<ml-button variant="primary" ?disabled=${!self.canAdd} ?loading=${busy === 'repo'} @ml:click=${() => self.submitAdd()}>
					${self.addTab === 'add' ? 'Open folder' : self.addTab === 'scan' ? (self.scanPicked.size ? `Add ${self.scanPicked.size}` : 'Add') : self.addTab === 'clone' ? 'Clone' : 'Continue'}
				</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #new-branch style="--ml-dialog-max-width: 420px" @ml:open=${(e: Event) => e.target === e.currentTarget && self.openedBranch('')}>
			<h3 slot="dialog-header">New branch</h3>
			<div class="dlg">
				<ml-input label="Name" placeholder="feature/my-change" .value=${self.branchName} @ml:input=${(e: CustomEvent) => self.setBranchName(e.detail.value)}></ml-input>
				<p>Starts from <b>${prompt.commit ? `${prompt.commit.shortHash} ${prompt.commit.summary}` : st?.branch ?? ''}</b>${st?.files.length ? ' and brings your uncommitted changes along' : ''}.</p>
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('new-branch')}>Cancel</ml-button>
				<ml-button variant="primary" ?disabled=${!self.branchName} ?loading=${busy === 'branch'} @ml:click=${() => self.createBranch()}>Create branch</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #rename-branch style="--ml-dialog-max-width: 420px" @ml:open=${(e: Event) => e.target === e.currentTarget && self.openedBranch(self.branch)}>
			<h3 slot="dialog-header">Rename branch</h3>
			<div class="dlg">
				<ml-input label="Name" .value=${self.branchName} @ml:input=${(e: CustomEvent) => self.setBranchName(e.detail.value)}></ml-input>
				<p>Only the local branch is renamed. A branch already pushed keeps its old name on the remote.</p>
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('rename-branch')}>Cancel</ml-button>
				<ml-button variant="primary" ?disabled=${!self.branchName || self.branchName === self.branch} ?loading=${busy === 'branch'} @ml:click=${() => self.renameBranch()}>Rename</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #delete-branch style="--ml-dialog-max-width: 420px" @ml:open=${(e: Event) => e.target === e.currentTarget && self.openedBranch('')}>
			<h3 slot="dialog-header">Delete branch</h3>
			<div class="dlg">
				${prompt.remote
					? html`<p>Delete <b>${self.branch}</b> on the remote? Everyone who uses that remote loses the branch. Local branches are left alone.</p>`
					: html`${self.published
							? html`<p>Delete the branch <b>${self.branch}</b>?</p>
								<ml-checkbox label=${`Also delete ${self.published} on the remote`} .checked=${self.alsoRemote} @ml:change=${(e: CustomEvent) => (self.alsoRemote = e.detail.checked)}></ml-checkbox>
								${self.alsoRemote ? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>Everyone who uses that remote loses the branch.</span></p>` : ''}`
							: html`<p>Delete the local branch <b>${self.branch}</b>? It has no copy on a remote.</p>`}
						${store.status()?.branch === self.branch && !store.status()?.detached ? html`<p>It is checked out, so Melodic Studio switches to <b>${store.fallbackBranch(self.branch) ?? 'another branch'}</b> first.</p>` : ''}
						${self.branchHolder?.isMain
							? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>It is checked out in the main checkout. Switch that to another branch first.</span></p>`
							: self.branchHolder
								? html`<p title=${self.branchHolder.path}>It is checked out in a worktree, which is removed too.</p>
									${self.branchHolder.changes
										? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>That worktree has ${self.branchHolder.changes === 1 ? '1 uncommitted change' : `${self.branchHolder.changes} uncommitted changes`}. They are lost.</span></p>`
										: ''}`
								: ''}`}
				${self.unmerged ? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>This branch has commits that are not merged anywhere${!prompt.remote && self.alsoRemote && self.published ? ' else' : ''}. Deleting it loses them.</span></p>` : ''}
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('delete-branch')}>Cancel</ml-button>
				<ml-button variant="danger" ?disabled=${!prompt.remote && !!self.branchHolder?.isMain} ?loading=${busy === 'branch'} @ml:click=${() => self.deleteBranch()}>${self.unmerged ? 'Delete anyway' : !prompt.remote && self.branchHolder ? 'Delete branch and worktree' : !prompt.remote && self.alsoRemote && self.published ? 'Delete here and on the remote' : 'Delete'}</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #new-tag style="--ml-dialog-max-width: 420px" @ml:open=${(e: Event) => e.target === e.currentTarget && ((self.tagName = ''), (self.tagPush = false))}>
			<h3 slot="dialog-header">Create tag</h3>
			<div class="dlg">
				<ml-input label="Name" placeholder="v1.0.0" .value=${self.tagName} @ml:input=${(e: CustomEvent) => self.setTagName(e.detail.value)}></ml-input>
				<p>Tags <b>${prompt.commit ? `${prompt.commit.shortHash} ${prompt.commit.summary}` : ''}</b>.</p>
				${st?.remote ? html`<ml-checkbox label=${`Push the tag to ${st.remote}`} .checked=${self.tagPush} @ml:change=${(e: CustomEvent) => (self.tagPush = e.detail.checked)}></ml-checkbox>` : ''}
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('new-tag')}>Cancel</ml-button>
				<ml-button variant="primary" ?disabled=${!self.tagName} ?loading=${busy === 'history'} @ml:click=${() => self.createTag()}>Create tag</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #reset style="--ml-dialog-max-width: 480px" @ml:open=${(e: Event) => e.target === e.currentTarget && (self.resetMode = 'mixed')}>
			<h3 slot="dialog-header">Reset branch</h3>
			<div class="dlg">
				<p>Move <b>${st?.branch ?? ''}</b> back to <b>${prompt.commit ? `${prompt.commit.shortHash} ${prompt.commit.summary}` : ''}</b>. Every commit after it leaves the branch.</p>
				<ml-select label="What happens to their changes" .options=${RESET_MODES} .value=${self.resetMode} @ml:change=${(e: CustomEvent) => (self.resetMode = e.detail.value)}></ml-select>
				${self.resetMode === 'hard' ? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>A hard reset also discards your uncommitted changes. This cannot be undone from Melodic Studio.</span></p>` : ''}
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('reset')}>Cancel</ml-button>
				<ml-button variant="danger" @ml:click=${() => self.reset()}>Reset</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #force-push style="--ml-dialog-max-width: 460px">
			<h3 slot="dialog-header">Push was rejected</h3>
			<div class="dlg">
				<p>The remote has commits that <b>${st?.branch ?? ''}</b> does not. If someone else pushed, cancel and pull first.</p>
				<p>If you amended, rebased or reset commits that were already pushed, a force push replaces the remote branch with yours. It uses <b>--force-with-lease</b>, so it still refuses if the remote changed since your last fetch.</p>
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('force-push')}>Cancel</ml-button>
				<ml-button variant="danger" @ml:click=${() => self.forcePush()}>Force push</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #publish style="--ml-dialog-max-width: 480px" @ml:open=${(e: Event) => e.target === e.currentTarget && (self.remoteUrl = '')}>
			<h3 slot="dialog-header">Publish repository</h3>
			<div class="dlg">
				<p>Create an empty repository on your git host, then paste its URL. Melodic Studio sets it as <b>origin</b> and pushes <b>${st?.branch ?? ''}</b>.</p>
				<ml-input label="Remote URL" placeholder="git@github.com:owner/repo.git" .value=${self.remoteUrl} @ml:input=${(e: CustomEvent) => (self.remoteUrl = e.detail.value)}></ml-input>
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('publish')}>Cancel</ml-button>
				<ml-button variant="primary" ?disabled=${!self.remoteUrl.trim()} ?loading=${busy === 'push'} @ml:click=${() => self.publish()}>Publish</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #discard style="--ml-dialog-max-width: 440px">
			<h3 slot="dialog-header">Discard changes</h3>
			<div class="dlg">
				<p>${files.length === 1 ? html`Discard all changes to <b>${files[0].path}</b>?` : html`Discard changes to <b>${plural(files.length, 'file')}</b>?`}</p>
				<p>Edits to tracked files cannot be recovered. New files are moved to the trash.</p>
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('discard')}>Cancel</ml-button>
				<ml-button variant="danger" @ml:click=${() => self.discard()}>Discard</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #remove-repo style="--ml-dialog-max-width: 440px">
			<h3 slot="dialog-header">Remove repository</h3>
			<div class="dlg">
				<p>Remove <b>${prompt.repo?.name ?? ''}</b> from Melodic Studio? Nothing on disk is touched.</p>
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('remove-repo')}>Cancel</ml-button>
				<ml-button variant="danger" @ml:click=${() => self.removeRepo()}>Remove</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #settings style="--ml-dialog-max-width: 560px" @ml:open=${(e: Event) => e.target === e.currentTarget && self.openedSettings()}>
			<h3 slot="dialog-header">Settings</h3>
			<div class="dlg settings">
				<ml-tabs size="sm" variant="pills" value=${self.settingsTab} @ml:change=${(e: CustomEvent) => (self.settingsTab = e.detail.value as SettingsTab)}>
					<ml-tab slot="tab" value="general" label="General"></ml-tab>
					<ml-tab slot="tab" value="editor" label="Editor"></ml-tab>
					<ml-tab slot="tab" value="accounts" label="Accounts"></ml-tab>
					<ml-tab slot="tab" value="language-servers" label="Language servers"></ml-tab>
				</ml-tabs>
				<div class="pane" style=${self.settingsTab === 'general' ? '' : 'display: none'}>
					<ml-select label="Appearance" .options=${THEMES} .value=${self.theme} @ml:change=${(e: CustomEvent) => self.pickTheme(e.detail.value as ThemeMode)}></ml-select>
					<section class="who">
						<h4>Commits as</h4>
						<div class="pair">
							<ml-input label="Name" .value=${self.globalName} @ml:input=${(e: CustomEvent) => (self.globalName = e.detail.value)}></ml-input>
							<ml-input label="Email" type="email" .value=${self.globalEmail} @ml:input=${(e: CustomEvent) => (self.globalEmail = e.detail.value)}></ml-input>
						</div>
						<small>Every repository, through git's global config.</small>
						${store.repo()
							? html`
								<ml-checkbox label=${`Use a different name and email in ${store.repo()!.name}`} .checked=${self.override} @ml:change=${(e: CustomEvent) => self.toggleOverride(e.detail.checked)}></ml-checkbox>
								${self.override
									? html`
										<div class="pair">
											<ml-input label="Name" .value=${self.repoName} @ml:input=${(e: CustomEvent) => (self.repoName = e.detail.value)}></ml-input>
											<ml-input label="Email" type="email" .value=${self.repoEmail} @ml:input=${(e: CustomEvent) => (self.repoEmail = e.detail.value)}></ml-input>
										</div>
									`
									: ''}
							`
							: ''}
					</section>
					<section class="who">
						<ml-checkbox label="Fetch in the background" .checked=${store.autoFetch()} @ml:change=${(e: CustomEvent) => store.setAutoFetch(e.detail.checked)}></ml-checkbox>
						<small>Every 5 minutes while the window is showing, so the toolbar knows what there is to pull. It never asks for a password.</small>
					</section>
					<dl>
						<dt>Git</dt>
						<dd>${app?.gitVersion ?? 'Not found on this computer'}</dd>
						<dt>Melodic Studio</dt>
						<dd>${app?.appVersion ?? ''}</dd>
					</dl>
					<ms-update-status></ms-update-status>
				</div>
				<div class="pane" style=${self.settingsTab === 'editor' ? '' : 'display: none'}><ms-editor-settings></ms-editor-settings></div>
				<div class="pane" style=${self.settingsTab === 'accounts' ? '' : 'display: none'}><ms-accounts .active=${self.settingsTab === 'accounts'}></ms-accounts></div>
				<div class="pane" style=${self.settingsTab === 'language-servers' ? '' : 'display: none'}><ms-language-servers></ms-language-servers></div>
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="primary" @ml:click=${() => void self.doneSettings()}>Done</ml-button>
			</div>
		</ml-dialog>
	`;
}
