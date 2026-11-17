import { html } from '@melodicdev/core/template';
import type { AddTab, DialogsComponent } from './dialogs.component';
import type { ThemeMode } from '../../shared/theme';
import { plural } from '../../shared/format';
import { isWindows } from '../../services/backend.service';

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

function folderField(self: DialogsComponent, label: string, field: 'addPath' | 'cloneParent' | 'createParent', placeholder: string) {
	return html`
		<div class="pathrow">
			<ml-input label=${label} placeholder=${placeholder} .value=${self[field]} @ml:input=${(e: CustomEvent) => (self[field] = e.detail.value)}></ml-input>
			<ml-button variant="outline" @ml:click=${() => self.browse(field)}>Choose…</ml-button>
		</div>
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
		<ml-dialog #add-repo style="--ml-dialog-max-width: 520px" @ml:open=${() => self.openedAdd()}>
			<h3 slot="dialog-header">Add a repository</h3>
			<div class="dlg">
				<ml-tabs size="sm" variant="pills" value=${self.addTab} @ml:change=${(e: CustomEvent) => (self.addTab = e.detail.value as AddTab)}>
					<ml-tab slot="tab" value="add" label="Add existing"></ml-tab>
					<ml-tab slot="tab" value="clone" label="Clone"></ml-tab>
					<ml-tab slot="tab" value="create" label="Create new"></ml-tab>
				</ml-tabs>
				${self.addTab === 'add'
					? html`
						<p>Point Melodic Studio at a git repository that is already on this computer.</p>
						${folderField(self, 'Local path', 'addPath', isWindows() ? 'C:\\path\\to\\repository' : '/path/to/repository')}
					`
					: self.addTab === 'clone'
						? html`
							<p>Clone uses your own git setup, so SSH keys and credential helpers work as they do in a terminal.</p>
							<ml-input label="Repository URL" placeholder="git@github.com:owner/repo.git" .value=${self.cloneUrl} @ml:input=${(e: CustomEvent) => (self.cloneUrl = e.detail.value)}></ml-input>
							${folderField(self, 'Clone into', 'cloneParent', isWindows() ? 'C:\\path\\to\\parent\\folder' : '/path/to/parent/folder')}
						`
						: html`
							<ml-input label="Name" placeholder="my-project" .value=${self.createName} @ml:input=${(e: CustomEvent) => (self.createName = e.detail.value)}></ml-input>
							${folderField(self, 'Create in', 'createParent', isWindows() ? 'C:\\path\\to\\parent\\folder' : '/path/to/parent/folder')}
							<ml-checkbox label="Start with a README and an initial commit" .checked=${self.createReadme} @ml:change=${(e: CustomEvent) => (self.createReadme = e.detail.checked)}></ml-checkbox>
						`}
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('add-repo')}>Cancel</ml-button>
				<ml-button variant="primary" ?disabled=${!self.canAdd} ?loading=${busy === 'repo'} @ml:click=${() => self.submitAdd()}>
					${self.addTab === 'add' ? 'Add repository' : self.addTab === 'clone' ? 'Clone' : 'Create repository'}
				</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #new-branch style="--ml-dialog-max-width: 420px" @ml:open=${() => self.openedBranch('')}>
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

		<ml-dialog #rename-branch style="--ml-dialog-max-width: 420px" @ml:open=${() => self.openedBranch(self.branch)}>
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

		<ml-dialog #delete-branch style="--ml-dialog-max-width: 420px" @ml:open=${() => self.openedBranch('')}>
			<h3 slot="dialog-header">Delete branch</h3>
			<div class="dlg">
				${prompt.remote
					? html`<p>Delete <b>${self.branch}</b> on the remote? Everyone who uses that remote loses the branch. Local branches are left alone.</p>`
					: html`<p>Delete the local branch <b>${self.branch}</b>? The remote copy, if there is one, is left alone.</p>
						${store.status()?.branch === self.branch && !store.status()?.detached ? html`<p>It is checked out, so Melodic Studio switches to <b>${store.fallbackBranch(self.branch) ?? 'another branch'}</b> first.</p>` : ''}`}
				${self.unmerged ? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>This branch has commits that are not merged anywhere. Deleting it loses them.</span></p>` : ''}
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('delete-branch')}>Cancel</ml-button>
				<ml-button variant="danger" ?loading=${busy === 'branch'} @ml:click=${() => self.deleteBranch()}>${self.unmerged ? 'Delete anyway' : 'Delete'}</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #merge-branch style="--ml-dialog-max-width: 420px">
			<h3 slot="dialog-header">${prompt.rebase ? 'Rebase branch' : 'Merge branch'}</h3>
			<div class="dlg">
				${prompt.rebase
					? html`<p>Replay the commits of <b>${st?.branch ?? ''}</b> on top of <b>${self.branch}</b>? This rewrites them, so a branch that is already pushed will need a force push afterwards.</p>`
					: html`<p>Merge <b>${self.branch}</b> into <b>${st?.branch ?? ''}</b>?</p>`}
				${st?.files.length ? html`<p class="warn"><ml-icon icon="warning" size="sm"></ml-icon><span>You have uncommitted changes. Git may refuse until they are committed or stashed.</span></p>` : ''}
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="outline" @ml:click=${() => store.closeDialog('merge-branch')}>Cancel</ml-button>
				<ml-button variant="primary" @ml:click=${() => self.merge()}>${prompt.rebase ? 'Rebase' : 'Merge'}</ml-button>
			</div>
		</ml-dialog>

		<ml-dialog #new-tag style="--ml-dialog-max-width: 420px" @ml:open=${() => ((self.tagName = ''), (self.tagPush = false))}>
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

		<ml-dialog #reset style="--ml-dialog-max-width: 480px" @ml:open=${() => (self.resetMode = 'mixed')}>
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

		<ml-dialog #publish style="--ml-dialog-max-width: 480px" @ml:open=${() => (self.remoteUrl = '')}>
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

		<ml-dialog #settings style="--ml-dialog-max-width: 480px" @ml:open=${() => self.openedSettings()}>
			<h3 slot="dialog-header">Settings</h3>
			<div class="dlg">
				<ml-select label="Appearance" .options=${THEMES} .value=${self.theme} @ml:change=${(e: CustomEvent) => self.pickTheme(e.detail.value as ThemeMode)}></ml-select>
				<ml-input label="Editor command" hint="Run with the repository folder, for example: code, cursor, zed, subl" .value=${self.editor} @ml:input=${(e: CustomEvent) => (self.editor = e.detail.value)} @ml:blur=${() => self.saveEditor()}></ml-input>
				<dl>
					<dt>Commits as</dt>
					<dd>${app?.authorName ? `${app.authorName} <${app.authorEmail}>` : 'No git identity set. Run git config --global user.name and user.email.'}</dd>
					<dt>Git</dt>
					<dd>${app?.gitVersion ?? 'Not found on this computer'}</dd>
					<dt>Melodic Studio</dt>
					<dd>${app?.appVersion ?? ''}</dd>
				</dl>
			</div>
			<div slot="dialog-footer" class="foot">
				<ml-button variant="primary" @ml:click=${() => (self.saveEditor(), store.closeDialog('settings'))}>Done</ml-button>
			</div>
		</ml-dialog>
	`;
}
