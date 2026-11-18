/**
 * The OS menu bar's own items (`src-tauri/src/menu.rs`) arrive here as `menu` events. Their shortcuts are
 * taken by the menu bar on macOS only; elsewhere (and in the browser preview) the same keys are caught here.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { BackendService, isDesktop, isMac } from './backend.service';
import { RepoStore } from './repo.store';
import { UpdatesService } from './updates.service';
import { EditorSettingsStore } from './editor-settings.store';

export type MenuAction = 'new-project' | 'add-repo' | 'clone-repo' | 'settings' | 'check-updates' | 'zoom-in' | 'zoom-out' | 'zoom-reset';

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
		void Injector.get(EditorSettingsStore).applyZoom();
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
			case 'zoom-in':
			case 'zoom-out':
			case 'zoom-reset':
				Injector.get(EditorSettingsStore).stepZoom(action === 'zoom-in' ? 1 : action === 'zoom-out' ? -1 : 0);
				break;
			case 'check-updates':
				this.repo.ask('settings');
				void Injector.get(UpdatesService).check();
				break;
		}
	}

	private readonly _keys = (e: KeyboardEvent): void => {
		if (!(e.metaKey || e.ctrlKey) || e.altKey) {
			return;
		}
		const key = e.key.toLowerCase();
		const action: MenuAction | null =
			key === ',' && !e.shiftKey
				? 'settings'
				: key === 'n' && e.shiftKey
					? 'new-project'
					: key === 'o' && !e.shiftKey
						? 'add-repo'
						: key === '=' || key === '+'
							? 'zoom-in'
							: key === '-' || key === '_'
								? 'zoom-out'
								: key === '0' && !e.shiftKey
									? 'zoom-reset'
									: null;
		// A dialog already open keeps the keyboard, except for zooming.
		if (action && (action.startsWith('zoom') || !document.querySelector('ml-dialog[open]'))) {
			e.preventDefault();
			e.stopPropagation();
			this.run(action);
		}
	};
}
