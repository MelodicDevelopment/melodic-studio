/**
 * In-app updates (tauri-plugin-updater). Each GitHub release carries a signed
 * `latest.json`; the plugin checks it, verifies the download against the public
 * key in tauri.conf.json, and stages the new version. The user then chooses
 * when to restart into it. Nothing here can block or break startup: every
 * failure ends as "no update".
 *
 * Tauri plugin modules are imported lazily so the browser preview never loads them.
 */
import { Injectable, Injector } from '@melodicdev/core/injection';
import { signal } from '@melodicdev/core/signals';
import { BackendService, isDesktop } from './backend.service';

export interface StagedUpdate {
	currentVersion: string;
	version: string;
	notes: string;
}

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'failed' | 'restarting';

const FIRST_CHECK_MS = 8_000;
const RECHECK_MS = 4 * 60 * 60 * 1000;

@Injectable()
export class UpdatesService {
	readonly state = signal<UpdateState>('idle');
	/** A newer version, downloaded and waiting for a restart. */
	readonly staged = signal<StagedUpdate | null>(null);
	/** Why the last check or install failed, for the Settings row. */
	readonly error = signal('');

	private _update: { install(): Promise<void> } | null = null;
	private _started = false;

	/** True where updates can happen at all: a packaged desktop build. */
	get supported(): boolean {
		return isDesktop() && !import.meta.env.DEV;
	}

	/** Check shortly after launch and every few hours after that. Safe to call more than once. */
	start(): void {
		if (this._started || !this.supported) {
			return;
		}
		this._started = true;
		setTimeout(() => void this.check(), FIRST_CHECK_MS);
		setInterval(() => void this.check(), RECHECK_MS);
	}

	/** Look for a newer version and download it in the background. */
	async check(): Promise<void> {
		const state = this.state();
		if (!this.supported || state === 'checking' || state === 'downloading' || state === 'ready' || state === 'restarting') {
			return;
		}
		this.state.set('checking');
		this.error.set('');
		try {
			const { check } = await import('@tauri-apps/plugin-updater');
			const update = await check();
			if (!update) {
				this.state.set('current');
				return;
			}
			this.state.set('downloading');
			await update.download();
			this._update = update;
			this.staged.set({ currentVersion: update.currentVersion, version: update.version, notes: update.body ?? '' });
			this.state.set('ready');
		} catch (e) {
			this.error.set(e instanceof Error ? e.message : String(e));
			this.state.set('failed');
		}
	}

	/**
	 * Install the staged update and relaunch. On Windows the installer quits the app itself, so relaunch may not return.
	 * Relaunching is `app_relaunch`, not the process plugin: on macOS that one starts the new copy with `open -n`
	 * while this one is still running, and the Dock gives the new copy a second icon.
	 */
	async restart(): Promise<void> {
		if (!this._update) {
			return;
		}
		this.state.set('restarting');
		try {
			await this._update.install();
			await Injector.get(BackendService).relaunch();
		} catch (e) {
			this.error.set(e instanceof Error ? e.message : String(e));
			this.state.set('ready');
		}
	}
}
