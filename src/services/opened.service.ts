/**
 * Folders the system asks the app to open (macOS, `src-tauri/src/recent.rs`): a repository picked from the
 * Dock icon's recent list, a folder dropped on the icon, Finder's "Open With". A repository the app has goes
 * to a tab of its own, so what is on screen stays; anything else takes the one way a folder is opened
 * (`InitService.open`), which adds a repository or starts the setup wizard.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { BackendService, isDesktop } from './backend.service';
import { RepoStore } from './repo.store';
import { InitService } from '../components/init/init-repo.component';
import { samePath } from '../shared/paths';

@Injectable()
export class OpenedService {
	private _started = false;
	/** One folder at a time, in the order they came. */
	private _queue: Promise<void> = Promise.resolve();

	/** Start listening, and take what came before the page was there. Call once the repositories are loaded. */
	async start(): Promise<void> {
		if (this._started || !isDesktop()) {
			return;
		}
		this._started = true;
		await Injector.get(BackendService).listen<void>('opened', () => this.take());
		this.take();
	}

	private take(): void {
		this._queue = this._queue
			.then(async () => {
				for (const path of await Injector.get(BackendService).takeOpened()) {
					await this.open(path);
				}
			})
			.catch((e) => Injector.get(RepoStore).fail(e));
	}

	private async open(path: string): Promise<void> {
		const store = Injector.get(RepoStore);
		const known = store.app()?.repos.find((r) => samePath(r.path, path));
		if (known) {
			await store.openRepoTab(known.id);
		} else {
			await Injector.get(InitService).open(path);
		}
	}
}
