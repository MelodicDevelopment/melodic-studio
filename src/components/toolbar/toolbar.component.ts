import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { ToastService } from '@melodicdev/components/toast';
import { RepoStore } from '../../services/repo.store';
import { isDesktop, isMac, type Branch, type OpenTarget, type RepoSummary } from '../../services/backend.service';
import { toolbarTemplate } from './toolbar.template';
import { toolbarStyles } from './toolbar.styles';

type PopoverId = 'repo-pop' | 'branch-pop' | 'host-pop';
export type ToolbarMenu = ({ kind: 'repo'; repo: RepoSummary } | { kind: 'branch'; branch: Branch }) & { x: number; y: number };

@MelodicComponent({
	selector: 'ms-toolbar',
	template: toolbarTemplate,
	styles: toolbarStyles,
})
export class ToolbarComponent {
	@Service(RepoStore) readonly store!: RepoStore;
	@Service(ToastService) private readonly _toast!: ToastService;
	elementRef!: HTMLElement;

	/** Right-click menu on a repository or a branch: the toolbar button or a row in its list. */
	menu: ToolbarMenu | null = null;

	repoFilter = '';
	branchFilter = '';
	/** Leave room for the traffic lights the overlay title bar draws over us. */
	readonly mac = isDesktop() && isMac();

	get repos(): RepoSummary[] {
		const q = this.repoFilter.trim().toLowerCase();
		const repos = this.store.app()?.repos ?? [];
		return q ? repos.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : repos;
	}

	private filteredBranches(remote: boolean): Branch[] {
		const q = this.branchFilter.trim().toLowerCase();
		const all = this.store.branches();
		const tracked = new Set(all.filter((b) => !b.isRemote && b.upstream).map((b) => b.upstream));
		return all.filter((b) => b.isRemote === remote && (!remote || !tracked.has(b.name)) && (!q || b.name.toLowerCase().includes(q)));
	}

	get localBranches(): Branch[] {
		return this.filteredBranches(false);
	}

	/** Remote branches nothing local tracks yet; checking one out creates the local branch. */
	get remoteBranches(): Branch[] {
		return this.filteredBranches(true);
	}

	private get ctxEl(): HTMLElement | null {
		return this.elementRef.shadowRoot?.querySelector('.ctx') ?? null;
	}

	private readonly _dismiss = (): void => {
		if (this.menu) {
			this.menu = null;
			this.ctxEl?.hidePopover();
		}
	};

	private readonly _escape = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') {
			this._dismiss();
		}
	};

	onCreate(): void {
		window.addEventListener('click', this._dismiss);
		window.addEventListener('blur', this._dismiss);
		window.addEventListener('keydown', this._escape);
	}

	onDestroy(): void {
		window.removeEventListener('click', this._dismiss);
		window.removeEventListener('blur', this._dismiss);
		window.removeEventListener('keydown', this._escape);
	}

	private showMenu(ev: MouseEvent, menu: { kind: 'repo'; repo: RepoSummary } | { kind: 'branch'; branch: Branch }): void {
		this.menu = { ...menu, x: Math.max(4, Math.min(ev.clientX, window.innerWidth - 250)), y: Math.max(4, Math.min(ev.clientY, window.innerHeight - 290)) };
		const el = this.ctxEl;
		// Re-show so it lands on top of a dropdown that opened after it.
		el?.hidePopover();
		el?.showPopover();
	}

	/** `repo` is a row in the list; without it the menu is for the current repository. */
	repoMenu(ev: MouseEvent, repo: RepoSummary | null = this.store.repo()): void {
		ev.preventDefault();
		if (repo) {
			this.showMenu(ev, { kind: 'repo', repo });
		}
	}

	/** `branch` is a row in the list; without it the menu is for the checked-out branch. */
	branchMenu(ev: MouseEvent, branch?: Branch): void {
		ev.preventDefault();
		const st = this.store.status();
		const b = branch ?? (st && !st.detached ? (this.store.branches().find((x) => x.isCurrent && !x.isRemote) ?? { name: st.branch, isRemote: false, isCurrent: true, upstream: st.upstream, date: '' }) : null);
		if (b) {
			this.showMenu(ev, { kind: 'branch', branch: b });
		}
	}

	/** The branch's name on the remote, or null when it only exists locally. */
	remoteName(b: Branch): string | null {
		const full = b.isRemote ? b.name : b.upstream;
		return full ? full.slice(full.indexOf('/') + 1) : null;
	}

	async copy(text: string, what: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			this._toast.success(`${what} copied`);
		} catch {
			this._toast.error(`Could not copy the ${what.toLowerCase()}`);
		}
	}

	/** Open a dialog from the right-click menu, closing whichever dropdown it was opened over. */
	menuAsk(dialog: Parameters<RepoStore['ask']>[0], prompt: Parameters<RepoStore['ask']>[1] = {}): void {
		this.close('repo-pop');
		this.close('branch-pop');
		this.store.ask(dialog, prompt);
	}

	private popover(id: PopoverId): { close(): void } | undefined {
		const el = this.elementRef.shadowRoot?.querySelector(`#${id}`) as (HTMLElement & { component?: { close(): void } }) | null;
		return el?.component;
	}

	close(id: PopoverId): void {
		this.popover(id)?.close();
	}

	/** Put the cursor in the filter box as a list opens. */
	opened(id: PopoverId): void {
		if (id === 'branch-pop') {
			void this.store.loadBranches();
		}
		const input = this.elementRef.shadowRoot?.querySelector(`#${id} ml-input`);
		requestAnimationFrame(() => (input?.shadowRoot?.querySelector('input') as HTMLInputElement | null)?.focus());
	}

	pickRepo(repo: RepoSummary): void {
		this.close('repo-pop');
		this.repoFilter = '';
		void this.store.selectRepo(repo.id);
	}

	pickBranch(branch: Branch): void {
		this.close('branch-pop');
		this.branchFilter = '';
		if (!branch.isCurrent) {
			void this.store.checkout(branch);
		}
	}

	openHost(target: OpenTarget): void {
		this.close('host-pop');
		void this.store.openIn(target);
	}

	/** Open a dialog from inside a popover: the popover has to go first or it sits on top. */
	ask(id: PopoverId, dialog: Parameters<RepoStore['ask']>[0], prompt: Parameters<RepoStore['ask']>[1] = {}, ev?: Event): void {
		ev?.stopPropagation();
		this.close(id);
		this.store.ask(dialog, prompt);
	}

	readonly drag = (e: MouseEvent): void => {
		if (e.button !== 0 || !isDesktop() || !(e.target as HTMLElement).classList?.contains('drag')) {
			return;
		}
		void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => (e.detail === 2 ? getCurrentWindow().toggleMaximize() : getCurrentWindow().startDragging()));
	};
}
