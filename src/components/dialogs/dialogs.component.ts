import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { RepoStore } from '../../services/repo.store';
import { InitService } from '../init/init-repo.component';
import type { ResetMode } from '../../services/backend.service';
import { savedTheme, setTheme, type ThemeMode } from '../../shared/theme';
import { dialogsTemplate } from './dialogs.template';
import { dialogsStyles } from './dialogs.styles';

export type AddTab = 'add' | 'clone' | 'create';

/** Every dialog in the app. They are opened by id through `RepoStore.ask()`. */
@MelodicComponent({
	selector: 'ms-dialogs',
	template: dialogsTemplate,
	styles: dialogsStyles,
})
export class DialogsComponent {
	@Service(RepoStore) readonly store!: RepoStore;
	@Service(InitService) private readonly _init!: InitService;

	addTab: AddTab = 'add';
	addPath = '';
	cloneUrl = '';
	cloneParent = '';
	createName = '';
	createParent = '';

	branchName = '';
	/** Git refused a safe delete; the next click forces it. */
	unmerged = false;
	tagName = '';
	tagPush = false;
	resetMode: ResetMode = 'mixed';
	remoteUrl = '';
	editor = '';
	theme: ThemeMode = savedTheme();

	get branch(): string {
		return this.store.prompt().branch ?? '';
	}

	// ---- add / clone / create ----

	openedAdd(): void {
		this.addTab = this.store.prompt().tab ?? 'add';
		this.addPath = '';
		this.cloneUrl = '';
		this.createName = '';
	}

	async browse(field: 'addPath' | 'cloneParent' | 'createParent'): Promise<void> {
		const picked = await this.store.pickFolder();
		if (picked) {
			this[field] = picked;
		}
	}

	get canAdd(): boolean {
		switch (this.addTab) {
			case 'add':
				return !!this.addPath.trim();
			case 'clone':
				return !!this.cloneUrl.trim() && !!this.cloneParent.trim();
			default:
				return !!this.createName.trim() && !!this.createParent.trim();
		}
	}

	async submitAdd(): Promise<void> {
		if (!this.canAdd) {
			return;
		}
		// A folder that is not a repository yet (or a brand new one) goes through the setup wizard.
		const parent = this.createParent.trim().replace(/[\\/]+$/, '');
		const ok =
			this.addTab === 'add'
				? await this._init.open(this.addPath.trim())
				: this.addTab === 'clone'
					? await this.store.cloneRepo(this.cloneUrl.trim(), this.cloneParent.trim())
					: await this._init.open(`${parent}${parent.includes('\\') ? '\\' : '/'}${this.createName.trim()}`);
		if (ok) {
			this.store.closeDialog('add-repo');
		}
	}

	// ---- branches ----

	openedBranch(prefill: string): void {
		this.branchName = prefill;
		this.unmerged = false;
	}

	/** Git branch names cannot hold spaces; turn them into dashes as GitHub Desktop does. */
	setBranchName(value: string): void {
		this.branchName = value.replace(/\s+/g, '-');
	}

	async createBranch(): Promise<void> {
		if (this.branchName && (await this.store.createBranch(this.branchName, this.store.prompt().commit?.hash ?? null))) {
			this.store.closeDialog('new-branch');
		}
	}

	async renameBranch(): Promise<void> {
		if (this.branchName && this.branchName !== this.branch && (await this.store.renameBranch(this.branch, this.branchName))) {
			this.store.closeDialog('rename-branch');
		}
	}

	async deleteBranch(): Promise<void> {
		if (this.store.prompt().remote) {
			if (await this.store.deleteRemoteBranch(this.branch)) {
				this.store.closeDialog('delete-branch');
			}
			return;
		}
		const result = await this.store.deleteBranch(this.branch, this.unmerged);
		if (result === 'unmerged') {
			this.unmerged = true;
		} else if (result === 'ok') {
			this.store.closeDialog('delete-branch');
		}
	}

	async merge(): Promise<void> {
		this.store.closeDialog('merge-branch');
		if (this.store.prompt().rebase) {
			await this.store.rebaseOnto(this.branch);
		} else {
			await this.store.merge(this.branch);
		}
	}

	setTagName(value: string): void {
		this.tagName = value.replace(/\s+/g, '-');
	}

	async createTag(): Promise<void> {
		const commit = this.store.prompt().commit;
		if (commit && this.tagName && (await this.store.createTag(this.tagName, commit.hash, this.tagPush))) {
			this.store.closeDialog('new-tag');
		}
	}

	async reset(): Promise<void> {
		const commit = this.store.prompt().commit;
		this.store.closeDialog('reset');
		if (commit) {
			await this.store.resetTo(commit.hash, this.resetMode);
		}
	}

	async forcePush(): Promise<void> {
		this.store.closeDialog('force-push');
		await this.store.forcePush();
	}

	// ---- everything else ----

	async publish(): Promise<void> {
		if (this.remoteUrl.trim() && (await this.store.publish(this.remoteUrl.trim()))) {
			this.store.closeDialog('publish');
		}
	}

	async discard(): Promise<void> {
		const files = this.store.prompt().files ?? [];
		this.store.closeDialog('discard');
		await this.store.discard(files);
	}

	async removeRepo(): Promise<void> {
		const repo = this.store.prompt().repo;
		this.store.closeDialog('remove-repo');
		if (repo) {
			await this.store.removeRepo(repo.id);
		}
	}

	openedSettings(): void {
		this.editor = this.store.app()?.editor ?? 'code';
		this.theme = savedTheme();
	}

	pickTheme(mode: ThemeMode): void {
		this.theme = mode;
		setTheme(mode);
	}

	saveEditor(): void {
		if (this.editor.trim() !== (this.store.app()?.editor ?? '')) {
			void this.store.setEditor(this.editor);
		}
	}
}
