import { afterEach, describe, expect, test, vi } from 'vitest';
import { world, type World } from '../test/world';
import type { UpdatesService } from './updates.service';

/** A release the updater plugin found, as far as the service uses it. */
interface Release {
	currentVersion: string;
	version: string;
	body?: string;
	download(): Promise<void>;
	install(): Promise<void>;
}

/** The updater plugin: what `check()` answers next, and how often it was asked. */
const plugin = vi.hoisted(() => ({ checks: 0, check: (): Promise<unknown> => Promise.resolve(null) }));

vi.mock('@tauri-apps/plugin-updater', () => ({
	check: () => {
		plugin.checks++;
		return plugin.check();
	},
}));

let w: World;
let updates: UpdatesService;
/** What happened to the release, in order: `download`, `install`. */
let steps: string[];

function release(over: Partial<Release> = {}): Release {
	return {
		currentVersion: '0.5.1',
		version: '0.5.2',
		body: 'Fixes the Claude pane vanishing in narrow windows.',
		download: async () => void steps.push('download'),
		install: async () => void steps.push('install'),
		...over,
	};
}

/** An answer that waits until the test lets it go. */
function gate<T = void>(): { wait: Promise<T>; open: (value: T) => void; fail: (reason: unknown) => void } {
	let open!: (value: T) => void;
	let fail!: (reason: unknown) => void;
	const wait = new Promise<T>((resolve, reject) => {
		open = resolve;
		fail = reject;
	});
	return { wait, open, fail };
}

/** `packaged`: the installed desktop app. Otherwise the browser preview (`desktop: false`) or a dev build. */
async function start(where: { desktop: boolean; dev: boolean } = { desktop: true, dev: false }): Promise<void> {
	w = await world();
	if (where.desktop) {
		(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
	}
	vi.stubEnv('DEV', where.dev);
	steps = [];
	plugin.checks = 0;
	plugin.check = () => Promise.resolve(null);
	// The demo's relaunch reloads the page; here it is only noted.
	w.on('app_relaunch', () => void steps.push('relaunch'));
	updates = w.get((await import('./updates.service')).UpdatesService);
}

afterEach(() => {
	delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe('where updates can happen', () => {
	test('in the packaged desktop app', async () => {
		await start();
		expect(updates.supported).toBe(true);
	});

	test('not in the browser preview: nothing is checked, now or later', async () => {
		vi.useFakeTimers();
		await start({ desktop: false, dev: false });
		expect(updates.supported).toBe(false);
		await updates.check();
		updates.start();
		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
		expect(plugin.checks).toBe(0);
		expect(updates.state()).toBe('idle');
	});

	test('not in a development build of the desktop app', async () => {
		vi.useFakeTimers();
		await start({ desktop: true, dev: true });
		expect(updates.supported).toBe(false);
		await updates.check();
		updates.start();
		await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
		expect(plugin.checks).toBe(0);
		expect(updates.state()).toBe('idle');
	});
});

describe('checking', () => {
	test('with nothing newer, the app is current', async () => {
		await start();
		await updates.check();
		expect(updates.state()).toBe('current');
		expect(updates.staged()).toBeNull();
		expect(updates.error()).toBe('');
	});

	test('a newer version is downloaded in the background and then waits for a restart', async () => {
		await start();
		const found = gate<Release>();
		const downloaded = gate();
		plugin.check = () => found.wait;
		const checking = updates.check();
		expect(updates.state()).toBe('checking');
		found.open(release({ download: () => downloaded.wait }));
		await vi.waitFor(() => expect(updates.state()).toBe('downloading'));
		expect(updates.staged()).toBeNull();
		downloaded.open();
		await checking;
		expect(updates.state()).toBe('ready');
		expect(updates.staged()).toEqual({ currentVersion: '0.5.1', version: '0.5.2', notes: 'Fixes the Claude pane vanishing in narrow windows.' });
		// Downloaded, not installed: the user chooses when.
		expect(steps).not.toContain('install');
		expect(w.sent('app_relaunch')).toEqual([]);
	});

	test('a release without notes has empty notes', async () => {
		await start();
		plugin.check = () => Promise.resolve(release({ body: undefined }));
		await updates.check();
		expect(updates.staged()!.notes).toBe('');
	});

	test('a check that fails ends as "failed" with the reason, never as an exception', async () => {
		await start();
		plugin.check = () => Promise.reject(new Error('Could not fetch a valid release JSON from the remote'));
		await expect(updates.check()).resolves.toBeUndefined();
		expect(updates.state()).toBe('failed');
		expect(updates.error()).toBe('Could not fetch a valid release JSON from the remote');
		expect(updates.staged()).toBeNull();
	});

	test('a download that fails ends the same way, with nothing staged', async () => {
		await start();
		plugin.check = () => Promise.resolve(release({ download: () => Promise.reject('signature did not verify') }));
		await updates.check();
		expect(updates.state()).toBe('failed');
		expect(updates.error()).toBe('signature did not verify');
		expect(updates.staged()).toBeNull();
		// Nothing staged, so there is nothing to restart into.
		await updates.restart();
		expect(steps).toEqual([]);
		expect(updates.state()).toBe('failed');
	});

	test('after a failure the next check tries again and clears the reason', async () => {
		await start();
		plugin.check = () => Promise.reject(new Error('offline'));
		await updates.check();
		plugin.check = () => Promise.resolve(null);
		await updates.check();
		expect(plugin.checks).toBe(2);
		expect(updates.state()).toBe('current');
		expect(updates.error()).toBe('');
	});

	test('a check while one is under way is not a second check', async () => {
		await start();
		const found = gate<Release | null>();
		plugin.check = () => found.wait;
		const first = updates.check();
		await updates.check();
		expect(updates.state()).toBe('checking');
		found.open(null);
		await first;
		expect(plugin.checks).toBe(1);
		expect(updates.state()).toBe('current');
	});

	test('a check while a download is under way is not a second check', async () => {
		await start();
		const downloaded = gate();
		plugin.check = () => Promise.resolve(release({ download: () => downloaded.wait }));
		const first = updates.check();
		await vi.waitFor(() => expect(updates.state()).toBe('downloading'));
		await updates.check();
		expect(plugin.checks).toBe(1);
		downloaded.open();
		await first;
	});

	test('once an update waits for a restart, nothing more is checked', async () => {
		await start();
		plugin.check = () => Promise.resolve(release());
		await updates.check();
		await updates.check();
		expect(plugin.checks).toBe(1);
		expect(updates.state()).toBe('ready');
	});

	test('when the app is current, a later check looks again', async () => {
		await start();
		await updates.check();
		plugin.check = () => Promise.resolve(release());
		await updates.check();
		expect(plugin.checks).toBe(2);
		expect(updates.state()).toBe('ready');
	});
});

describe('restarting into the update', () => {
	test('installs what was downloaded, then relaunches the app through the native side', async () => {
		await start();
		plugin.check = () => Promise.resolve(release());
		await updates.check();
		expect(steps).toEqual(['download']);
		await updates.restart();
		expect(steps).toEqual(['download', 'install', 'relaunch']);
		expect(w.sent('app_relaunch').length).toBe(1);
		expect(updates.state()).toBe('restarting');
	});

	test('with nothing downloaded there is nothing to restart into', async () => {
		await start();
		await updates.restart();
		await updates.check();
		await updates.restart();
		expect(w.sent('app_relaunch')).toEqual([]);
		expect(updates.state()).toBe('current');
	});

	test('says "restarting" while the install runs, and nothing is checked meanwhile', async () => {
		await start();
		const installed = gate();
		plugin.check = () => Promise.resolve(release({ install: () => installed.wait }));
		await updates.check();
		const restarting = updates.restart();
		expect(updates.state()).toBe('restarting');
		await updates.check();
		expect(plugin.checks).toBe(1);
		expect(w.sent('app_relaunch')).toEqual([]);
		installed.open();
		await restarting;
		expect(w.sent('app_relaunch').length).toBe(1);
	});

	test('an install that fails says why, does not relaunch, and the update still waits to be tried again', async () => {
		await start();
		let attempts = 0;
		plugin.check = () =>
			Promise.resolve(
				release({
					install: async () => {
						if (attempts++ === 0) {
							throw new Error('The installer could not be started');
						}
						steps.push('install');
					},
				})
			);
		await updates.check();
		await updates.restart();
		expect(updates.state()).toBe('ready');
		expect(updates.error()).toBe('The installer could not be started');
		expect(steps).toEqual(['download']);
		expect(updates.staged()!.version).toBe('0.5.2');
		await updates.restart();
		expect(steps).toEqual(['download', 'install', 'relaunch']);
	});

	test('a relaunch the native side refuses is said too', async () => {
		await start();
		w.on('app_relaunch', () => Promise.reject('The app could not be started again'));
		plugin.check = () => Promise.resolve(release());
		await updates.check();
		await expect(updates.restart()).resolves.toBeUndefined();
		expect(updates.state()).toBe('ready');
		expect(updates.error()).toBe('The app could not be started again');
	});
});

describe('checking by itself', () => {
	test('first a few seconds after launch, then every four hours', async () => {
		vi.useFakeTimers();
		await start();
		updates.start();
		await vi.advanceTimersByTimeAsync(7_000);
		expect(plugin.checks).toBe(0);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(plugin.checks).toBe(1);
		expect(updates.state()).toBe('current');
		await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
		expect(plugin.checks).toBe(2);
		await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
		expect(plugin.checks).toBe(3);
	});

	test('started twice, it still checks once each time', async () => {
		vi.useFakeTimers();
		await start();
		updates.start();
		updates.start();
		await vi.advanceTimersByTimeAsync(8_000);
		expect(plugin.checks).toBe(1);
		await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
		expect(plugin.checks).toBe(2);
	});

	test('a failed check does not stop the later ones, and startup is never broken by it', async () => {
		vi.useFakeTimers();
		await start();
		plugin.check = () => Promise.reject(new Error('offline'));
		updates.start();
		await vi.advanceTimersByTimeAsync(8_000);
		expect(updates.state()).toBe('failed');
		plugin.check = () => Promise.resolve(release());
		await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
		expect(updates.state()).toBe('ready');
	});

	test('once an update waits for a restart, the later rounds leave it alone', async () => {
		vi.useFakeTimers();
		await start();
		plugin.check = () => Promise.resolve(release());
		updates.start();
		await vi.advanceTimersByTimeAsync(8_000);
		await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
		expect(plugin.checks).toBe(1);
		expect(updates.staged()!.version).toBe('0.5.2');
		// Downloaded once, and never installed behind the user's back.
		expect(steps).toEqual(['download']);
	});
});
