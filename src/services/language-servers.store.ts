/**
 * State behind Settings' "Language servers": which servers are on this computer,
 * and the installs and removals in flight. Kept here rather than in the component
 * so an install carries on, and its outcome is still there, if the dialog is closed.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal } from '@melodicdev/core/signals';
import { asAppError, BackendService, type LanguageServer } from './backend.service';
import { RepoStore } from './repo.store';
import { LspService } from './lsp.service';

export type ServerJob = 'install' | 'remove';

@Injectable()
export class LanguageServersStore {
	/** Null until first looked up. */
	readonly servers = signal<LanguageServer[] | null>(null);
	/** What is being done to which server, by name. */
	readonly busy = signal<Record<string, ServerJob>>({});
	/** Why the last install or removal of a server failed, by name. */
	readonly errors = signal<Record<string, string>>({});

	private _lookup = 0;

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}

	/** Look again: the project's copy, the app's own, PATH, and whether what was found really runs. */
	async load(): Promise<void> {
		const lookup = ++this._lookup;
		let servers: LanguageServer[];
		try {
			servers = await this.backend.lspServers(Injector.get(RepoStore).repo()?.id ?? null);
		} catch {
			servers = this.servers() ?? [];
		}
		if (lookup === this._lookup) {
			this.servers.set(servers);
		}
	}

	install(name: string): Promise<void> {
		return this.run(name, 'install', () => this.backend.lspInstall(name));
	}

	remove(name: string): Promise<void> {
		return this.run(name, 'remove', () => this.backend.lspUninstall(name));
	}

	/** Start servers that stopped or would not start, for the files that are open. */
	async restart(): Promise<void> {
		await Injector.get(LspService).refresh();
		await this.load();
	}

	private async run(name: string, job: ServerJob, work: () => Promise<void>): Promise<void> {
		if (this.busy()[name]) {
			return;
		}
		this.busy.set({ ...this.busy(), [name]: job });
		const { [name]: _cleared, ...errors } = this.errors();
		this.errors.set(errors);
		try {
			await work();
		} catch (e) {
			this.errors.set({ ...this.errors(), [name]: asAppError(e).message });
		}
		const { [name]: _done, ...busy } = this.busy();
		this.busy.set(busy);
		await this.load();
		// Open files pick up the server that just arrived, or let go of the one that left.
		await Injector.get(LspService).refresh();
	}
}
