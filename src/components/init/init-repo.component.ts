import { MelodicComponent } from '@melodicdev/core/components';
import { Injectable, Injector, Service } from '@melodicdev/core/injection';
import { signal } from '@melodicdev/core/signals';
import { DialogService } from '@melodicdev/components/dialog';
import { ToastService } from '@melodicdev/components/toast';
import { BackendService, asAppError, type RepoSummary } from '../../services/backend.service';
import { RepoStore } from '../../services/repo.store';
import { initRepoTemplate } from './init-repo.template';
import { initRepoStyles } from './init-repo.styles';

type DialogId = Parameters<DialogService['close']>[0];

/** What `folder_inspect` reports (src-tauri/src/init.rs). */
export interface FolderInfo {
	path: string;
	name: string;
	exists: boolean;
	isRepo: boolean;
	entries: number;
	hasReadme: boolean;
	hasGitignore: boolean;
	detected: string[];
	templates: [string, string][];
	defaultBranch: string;
	authorName: string;
	authorEmail: string;
}
/** A host's command-line tool, as `host_clis` reports it. */
export interface HostCli {
	provider: 'github' | 'azure' | 'gitlab';
	name: string;
	cli: string;
	installed: boolean;
	signedIn: boolean;
	account: string | null;
	hint: string | null;
}
export interface HostOwner {
	id: string;
	label: string;
}

export type Where = 'local' | 'github' | 'azure' | 'gitlab' | 'bitbucket' | 'other';

/** The host (and owner, Azure DevOps organization) last chosen for a new project, offered first next time. */
const LAST_HOST = 'studio.new-project.host';
interface LastHost {
	where: Where;
	owner: string;
	org: string;
}
function lastHost(): LastHost {
	try {
		const v = JSON.parse(localStorage.getItem(LAST_HOST) ?? 'null') as LastHost | null;
		if (v && typeof v.where === 'string') {
			return { where: v.where, owner: String(v.owner ?? ''), org: String(v.org ?? '') };
		}
	} catch {
		/* per-viewer convenience only */
	}
	return { where: 'github', owner: '', org: '' };
}

export const HOSTS: { id: Where; label: string; icon: string; createPage?: string }[] = [
	{ id: 'local', label: 'This computer only', icon: 'desktop' },
	{ id: 'github', label: 'GitHub', icon: 'github-logo', createPage: 'https://github.com/new' },
	{ id: 'azure', label: 'Azure DevOps', icon: 'windows-logo', createPage: 'https://dev.azure.com/' },
	{ id: 'gitlab', label: 'GitLab', icon: 'gitlab-logo', createPage: 'https://gitlab.com/projects/new' },
	{ id: 'bitbucket', label: 'Bitbucket', icon: 'cloud', createPage: 'https://bitbucket.org/repo/create' },
	{ id: 'other', label: 'Another host', icon: 'link' },
];

/**
 * Opening a folder: a repository is simply added; anything else starts the
 * setup wizard. Kept as a service so any part of the app can hand it a path.
 */
@Injectable()
export class InitService {
	/** The folder the wizard is setting up; null when it is closed. */
	readonly folder = signal<FolderInfo | null>(null);
	/** A project just made by New Project: the wizard offers a host (the last one used, GitHub at first). */
	readonly fresh = signal(false);

	/**
	 * Returns true when the path was dealt with (added, or the wizard took over),
	 * false when the caller should carry on as before (browser preview without demo data, errors).
	 */
	async open(path: string, fresh = false): Promise<boolean> {
		const backend = Injector.get(BackendService);
		const repos = Injector.get(RepoStore);
		let info: FolderInfo | null | undefined;
		try {
			info = await backend.call<FolderInfo | undefined>('folder_inspect', { path });
		} catch (e) {
			repos.fail(e);
			return false;
		}
		if (!info) {
			return repos.addRepo(path);
		}
		if (info.isRepo) {
			return repos.addRepo(info.path);
		}
		this.fresh.set(fresh);
		this.folder.set(info);
		Injector.get(DialogService).open('init-repo' as DialogId);
		return true;
	}
}

/** The setup wizard: git init with a few questions, then where the repository should live. */
@MelodicComponent({
	selector: 'ms-init-repo',
	template: initRepoTemplate,
	styles: initRepoStyles,
})
export class InitRepoComponent {
	@Service(InitService) readonly init!: InitService;
	@Service(RepoStore) readonly repos!: RepoStore;
	@Service(BackendService) private readonly _backend!: BackendService;
	@Service(DialogService) private readonly _dialogs!: DialogService;
	@Service(ToastService) private readonly _toast!: ToastService;

	step: 'setup' | 'remote' = 'setup';
	busy = false;
	error = '';

	// ---- step 1: set up ----
	branch = 'main';
	templates: string[] = [];
	readme = true;
	commit = true;
	message = 'Initial commit';
	authorName = '';
	authorEmail = '';

	// ---- step 2: where it lives ----
	where: Where = 'local';
	clis: HostCli[] = [];
	owners: HostOwner[] = [];
	owner = '';
	repoName = '';

	/**
	 * The name as typed, spaces made dashes. The field is given the result itself: when a dash is typed over with
	 * a space the name is what it was, nothing is drawn again, and the field would go on showing the space.
	 */
	setRepoName(e: CustomEvent<{ value: string }>): void {
		const name = e.detail.value.replace(/\s+/g, '-');
		this.repoName = name;
		const field = e.currentTarget as (HTMLElement & { value?: string }) | null;
		if (field && field.value !== name) {
			field.value = name;
		}
		const inner = field?.shadowRoot?.querySelector('input');
		if (inner && inner.value !== name) {
			inner.value = name;
		}
	}
	isPrivate = true;
	/** Azure DevOps organization (name or URL). */
	org = '';
	url = '';

	get info(): FolderInfo | null {
		return this.init.folder();
	}

	/** The command-line tool for the chosen host, when that host has one we can use. */
	get cli(): HostCli | null {
		return this.clis.find((c) => c.provider === this.where) ?? null;
	}

	get usable(): boolean {
		return !!this.cli?.installed && !!this.cli.signedIn;
	}

	get needsIdentity(): boolean {
		return this.commit && !!this.info && !this.info.authorName;
	}

	/** Runs every time the dialog opens: start from what the folder looks like. */
	opened(): void {
		const info = this.info;
		if (!info) {
			return;
		}
		this.step = 'setup';
		this.busy = false;
		this.error = '';
		this.branch = info.defaultBranch;
		this.templates = info.detected;
		this.readme = !info.hasReadme;
		this.commit = true;
		this.message = 'Initial commit';
		this.authorName = '';
		this.authorEmail = '';
		this.where = 'local';
		this.repoName = info.name;
		this.url = '';
		this.owners = [];
		this.owner = '';
	}

	toggleTemplate(id: string, on: boolean): void {
		this.templates = on ? [...this.templates, id] : this.templates.filter((t) => t !== id);
	}

	close(): void {
		this._dialogs.close('init-repo' as DialogId);
		this.init.folder.set(null);
		this.init.fresh.set(false);
	}

	/** Step 1: create the repository, then move on to where it should live. */
	async initialize(): Promise<void> {
		const info = this.info;
		if (!info || this.busy || !this.branch.trim() || (this.needsIdentity && !(this.authorName.trim() && this.authorEmail.trim()))) {
			return;
		}
		this.busy = true;
		const options = {
			branch: this.branch.trim(),
			gitignore: this.templates,
			readme: this.readme,
			commit: this.commit,
			message: this.message,
			authorName: this.authorName.trim() || null,
			authorEmail: this.authorEmail.trim() || null,
		};
		const ok = await this.repos.openRepo(() => this._backend.call<RepoSummary>('repo_init', { path: info.path, options }));
		this.busy = false;
		if (!ok) {
			return;
		}
		this.step = 'remote';
		try {
			this.clis = (await this._backend.call<HostCli[] | undefined>('host_clis')) ?? [];
		} catch {
			this.clis = [];
		}
		if (this.init.fresh()) {
			const last = lastHost();
			this.org = last.org;
			await this.pick(last.where);
			if (last.where === 'azure' && last.org && this.usable) {
				await this.loadOwners();
			}
			if (last.owner && this.owners.some((o) => o.id === last.owner)) {
				this.owner = last.owner;
			}
		}
	}

	async pick(where: Where): Promise<void> {
		this.where = where;
		this.error = '';
		this.owners = [];
		this.owner = '';
		if (this.usable && where !== 'azure') {
			await this.loadOwners();
		}
	}

	/** GitHub and GitLab: accounts and organizations. Azure DevOps: the projects of the organization typed in. */
	async loadOwners(): Promise<void> {
		const provider = this.where;
		try {
			const owners = (await this._backend.call<HostOwner[] | undefined>('host_owners', { provider, org: this.org.trim() || null })) ?? [];
			if (provider === this.where) {
				this.owners = owners;
				this.owner = owners[0]?.id ?? '';
			}
		} catch (e) {
			this.error = asAppError(e).message;
		}
	}

	openCreatePage(page: string): void {
		void this._backend.call('open_url', { url: page }).catch((e) => this.repos.fail(e));
	}

	get canFinish(): boolean {
		if (this.busy) {
			return false;
		}
		if (this.where === 'local') {
			return true;
		}
		if (this.usable) {
			return !!this.repoName.trim() && (this.where !== 'azure' || (!!this.org.trim() && !!this.owner));
		}
		return !!this.url.trim();
	}

	/** Step 2: create the remote when we can, point `origin` at it, and push what there is. */
	async finish(): Promise<void> {
		if (!this.canFinish) {
			return;
		}
		if (this.init.fresh()) {
			try {
				localStorage.setItem(LAST_HOST, JSON.stringify({ where: this.where, owner: this.owner, org: this.org.trim() } satisfies LastHost));
			} catch {
				/* per-viewer convenience only */
			}
		}
		if (this.where === 'local') {
			this.close();
			return;
		}
		this.busy = true;
		this.error = '';
		try {
			let remote = this.url.trim();
			if (this.usable) {
				const created = await this._backend.call<{ webUrl: string; remoteUrl: string }>('host_repo_create', {
					provider: this.where,
					name: this.repoName.trim(),
					owner: this.owner || null,
					private: this.isPrivate,
					org: this.org.trim() || null,
				});
				remote = created.remoteUrl;
			}
			const id = this.repos.repo()?.id;
			if (!id || !remote) {
				throw new Error('No repository URL to use.');
			}
			if (this.repos.status()?.hasCommits) {
				// publish() reports its own failures (authentication, rejected push) and leaves origin set.
				if (!(await this.repos.publish(remote))) {
					this.error = 'The remote was set as origin, but the first push did not go through. You can push again from the toolbar.';
					return;
				}
			} else {
				await this._backend.setRemote(id, remote);
				await this.repos.refresh();
				this._toast.success('Remote added', 'Push after your first commit.');
			}
			this.close();
		} catch (e) {
			this.error = asAppError(e).message;
		} finally {
			this.busy = false;
		}
	}
}
