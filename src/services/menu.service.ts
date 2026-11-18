/**
 * The OS menu bar's own items (`src-tauri/src/menu.rs`) arrive here as `menu` events. Their shortcuts are
 * taken by the menu bar on macOS only; elsewhere (and in the browser preview) the same keys are caught here.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { BackendService, isDesktop, isMac } from './backend.service';
import { RepoStore } from './repo.store';
import { UpdatesService } from './updates.service';

export type MenuAction = 'new-project' | 'add-repo' | 'clone-repo' | 'settings' | 'check-updates';

@Injectable()
export class MenuService {
	private _started = false;

	private get repo(): RepoStore {
		return Injector.get(RepoStore);
	}

	/** Start listening. Safe to call more than once. */
	start(): void {
		if (this._started) {
			return;
		}
		this._started = true;
		void Injector.get(BackendService).listen<string>('menu', (id) => this.run(id as MenuAction));
		if (!isDesktop() || !isMac()) {
			window.addEventListener('keydown', this._keys, true);
		}
	}

	run(action: MenuAction): void {
		switch (action) {
			case 'new-project':
				this.repo.ask('new-project');
				break;
			case 'add-repo':
				this.repo.ask('add-repo', { tab: 'add' });
				break;
			case 'clone-repo':
				this.repo.ask('add-repo', { tab: 'clone' });
				break;
			case 'settings':
				this.repo.ask('settings');
				break;
			case 'check-updates':
				this.repo.ask('settings');
				void Injector.get(UpdatesService).check();
				break;
		}
	}

	private readonly _keys = (e: KeyboardEvent): void => {
		if (!(e.metaKey || e.ctrlKey) || e.altKey || document.querySelector('ml-dialog[open]')) {
			return;
		}
		const action: MenuAction | null = e.key === ',' && !e.shiftKey ? 'settings' : e.key.toLowerCase() === 'n' && e.shiftKey ? 'new-project' : e.key.toLowerCase() === 'o' && !e.shiftKey ? 'add-repo' : null;
		if (action) {
			e.preventDefault();
			e.stopPropagation();
			this.run(action);
		}
	};
}
