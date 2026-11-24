import { afterEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../test/world';
import type { MenuService } from './menu.service';
import type { EditorSettingsStore } from './editor-settings.store';

// The desktop app's own event and zoom calls, for the tests that pretend to be it.
const desktop = vi.hoisted(() => ({ listening: [] as string[], zooms: [] as number[] }));
vi.mock('@tauri-apps/api/event', () => ({
	listen: async (event: string) => {
		desktop.listening.push(event);
		return () => undefined;
	},
}));
vi.mock('@tauri-apps/api/webview', () => ({
	getCurrentWebview: () => ({ setZoom: async (zoom: number) => void desktop.zooms.push(zoom) }),
}));

type Where = 'preview' | 'mac' | 'windows' | 'linux';

let w: World;
let menu: MenuService;
let settings: EditorSettingsStore;
/** Every dialog asked for, with what it was told. */
let asked: unknown[][];
let checks: number;
/** What the app hooked onto the window in this test, unhooked after it: the window outlives the test. */
const hooked: [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];
const hook = window.addEventListener.bind(window);

/** `preview`: the browser preview. The others: the desktop app on that system. `before` runs once storage is empty. */
async function start(where: Where = 'preview', before: () => void = () => undefined): Promise<void> {
	w = await world();
	before();
	vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
		hooked.push([type, listener, options]);
		hook(type, listener, options);
	});
	if (where !== 'preview') {
		(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
		vi.stubGlobal('navigator', { platform: where === 'mac' ? 'MacIntel' : where === 'windows' ? 'Win32' : 'Linux x86_64', userAgent: '' });
	}
	const { RepoStore } = await import('./repo.store');
	const { UpdatesService } = await import('./updates.service');
	asked = [];
	checks = 0;
	// The dialogs themselves are not on the page here: what matters is which one is asked for.
	vi.spyOn(w.get(RepoStore), 'ask').mockImplementation((...args: unknown[]) => void asked.push(args));
	vi.spyOn(w.get(UpdatesService), 'check').mockImplementation(async () => void checks++);
	settings = w.get((await import('./editor-settings.store')).EditorSettingsStore);
	menu = w.get((await import('./menu.service')).MenuService);
}

interface Key {
	key: string;
	ctrl?: boolean;
	meta?: boolean;
	shift?: boolean;
	alt?: boolean;
}

/** A key pressed somewhere in the window. Answers whether the app took it for itself. */
function press(k: Key): { taken: boolean; reached: boolean } {
	let reached = false;
	const later = (): void => void (reached = true);
	document.addEventListener('keydown', later);
	const event = new KeyboardEvent('keydown', { key: k.key, ctrlKey: !!k.ctrl, metaKey: !!k.meta, shiftKey: !!k.shift, altKey: !!k.alt, bubbles: true, cancelable: true });
	document.body.dispatchEvent(event);
	document.removeEventListener('keydown', later);
	return { taken: event.defaultPrevented, reached };
}

afterEach(() => {
	hooked.forEach(([type, listener, options]) => window.removeEventListener(type, listener, options));
	hooked.length = 0;
	vi.unstubAllGlobals();
	delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
	document.documentElement.removeAttribute('style');
	desktop.listening = [];
	desktop.zooms = [];
});

describe('the menu bar\'s items', () => {
	test('New Project, Add Repository, Clone Repository and Settings each open their dialog', async () => {
		await start();
		menu.run('new-project');
		menu.run('add-repo');
		menu.run('clone-repo');
		menu.run('settings');
		expect(asked).toEqual([['new-project'], ['add-repo', { tab: 'add' }], ['add-repo', { tab: 'clone' }], ['settings']]);
		expect(checks).toBe(0);
	});

	test('Check for Updates opens Settings, where the answer shows, and checks', async () => {
		await start();
		menu.run('check-updates');
		expect(asked).toEqual([['settings']]);
		expect(checks).toBe(1);
	});

	test('Zoom In, Zoom Out and Actual Size change the window\'s zoom and open nothing', async () => {
		await start();
		menu.run('zoom-in');
		menu.run('zoom-in');
		expect(settings.zoom()).toBe(1.25);
		menu.run('zoom-out');
		expect(settings.zoom()).toBe(1.1);
		menu.run('zoom-out');
		menu.run('zoom-out');
		expect(settings.zoom()).toBe(0.9);
		menu.run('zoom-reset');
		expect(settings.zoom()).toBe(1);
		expect(asked).toEqual([]);
	});

	test('an item this version does not know does nothing', async () => {
		await start();
		menu.run('print' as never);
		expect(asked).toEqual([]);
		expect(settings.zoom()).toBe(1);
	});
});

describe('once started', () => {
	test('an item picked in the OS menu bar arrives as a `menu` event and runs', async () => {
		await start();
		menu.start();
		await settle();
		w.emit('menu', 'clone-repo');
		w.emit('menu', 'zoom-in');
		expect(asked).toEqual([['add-repo', { tab: 'clone' }]]);
		expect(settings.zoom()).toBe(1.1);
	});

	test('before it is started nothing listens', async () => {
		await start();
		w.emit('menu', 'settings');
		expect(press({ key: ',', ctrl: true }).taken).toBe(false);
		expect(asked).toEqual([]);
	});

	test('started twice, an item still runs once', async () => {
		await start();
		menu.start();
		menu.start();
		await settle();
		w.emit('menu', 'settings');
		press({ key: '=', ctrl: true });
		expect(asked).toEqual([['settings']]);
		expect(settings.zoom()).toBe(1.1);
	});

	test('the zoom saved last time is put on the window', async () => {
		await start('preview', () => localStorage.setItem('studio.zoom', '1.25'));
		menu.start();
		await settle();
		expect((document.documentElement.style as unknown as { zoom: string }).zoom).toBe('1.25');
	});

	test('in the desktop app the events are the native side\'s and the zoom is the window\'s own', async () => {
		await start('windows', () => localStorage.setItem('studio.zoom', '1.5'));
		menu.start();
		await settle();
		expect(desktop.listening).toEqual(['menu']);
		expect(desktop.zooms).toEqual([1.5]);
	});
});

describe('the same shortcuts as keys, where the menu bar does not take them', () => {
	const KEYS: [string, Key, unknown[] | 'zoom-in' | 'zoom-out' | 'zoom-reset'][] = [
		['Ctrl+, opens Settings', { key: ',', ctrl: true }, ['settings']],
		['Ctrl+Shift+N starts a new project', { key: 'N', ctrl: true, shift: true }, ['new-project']],
		['Ctrl+O adds a repository', { key: 'o', ctrl: true }, ['add-repo', { tab: 'add' }]],
		['Ctrl+= zooms in', { key: '=', ctrl: true }, 'zoom-in'],
		['Ctrl+Shift+= (a plus) zooms in', { key: '+', ctrl: true, shift: true }, 'zoom-in'],
		['Ctrl+- zooms out', { key: '-', ctrl: true }, 'zoom-out'],
		['Ctrl+Shift+- (an underscore) zooms out', { key: '_', ctrl: true, shift: true }, 'zoom-out'],
		['Ctrl+0 goes back to 100%', { key: '0', ctrl: true }, 'zoom-reset'],
	];

	test.each(KEYS)('%s', async (_name, key, does) => {
		await start();
		menu.start();
		settings.setZoom(1.5);
		const pressed = press(key);
		expect(pressed).toEqual({ taken: true, reached: false });
		if (typeof does === 'string') {
			expect(settings.zoom()).toBe(does === 'zoom-in' ? 1.75 : does === 'zoom-out' ? 1.25 : 1);
			expect(asked).toEqual([]);
		} else {
			expect(asked).toEqual([does]);
			expect(settings.zoom()).toBe(1.5);
		}
	});

	test('Cmd works as Ctrl does', async () => {
		await start();
		menu.start();
		expect(press({ key: ',', meta: true }).taken).toBe(true);
		expect(press({ key: 'O', meta: true }).taken).toBe(true);
		expect(asked).toEqual([['settings'], ['add-repo', { tab: 'add' }]]);
	});

	test('keys that are not ours are left for whoever wants them', async () => {
		await start();
		menu.start();
		const others: Key[] = [
			{ key: ',' }, // no Ctrl or Cmd: typing
			{ key: 'o' },
			{ key: '=', shift: true },
			{ key: ',', ctrl: true, alt: true }, // AltGr combinations type characters on some keyboards
			{ key: '=', ctrl: true, alt: true },
			{ key: '<', ctrl: true, shift: true }, // Shift+, is something else
			{ key: 'n', ctrl: true }, // New Project needs Shift
			{ key: 'O', ctrl: true, shift: true },
			{ key: ')', ctrl: true, shift: true },
			{ key: 's', ctrl: true },
			{ key: 'p', meta: true },
		];
		for (const key of others) {
			expect(press(key)).toEqual({ taken: false, reached: true });
		}
		expect(asked).toEqual([]);
		expect(settings.zoom()).toBe(1);
	});

	test('a dialog already open keeps the keyboard, except for zooming', async () => {
		await start();
		menu.start();
		const dialog = document.createElement('ml-dialog');
		dialog.setAttribute('open', '');
		document.body.append(dialog);
		expect(press({ key: ',', ctrl: true })).toEqual({ taken: false, reached: true });
		expect(press({ key: 'o', ctrl: true }).taken).toBe(false);
		expect(press({ key: 'N', ctrl: true, shift: true }).taken).toBe(false);
		expect(asked).toEqual([]);
		expect(press({ key: '=', ctrl: true }).taken).toBe(true);
		expect(settings.zoom()).toBe(1.1);
		dialog.removeAttribute('open');
		expect(press({ key: ',', ctrl: true }).taken).toBe(true);
		expect(asked).toEqual([['settings']]);
	});

	test('the desktop app on Windows and Linux catches them here', async () => {
		for (const where of ['windows', 'linux'] as const) {
			await start(where);
			menu.start();
			expect(press({ key: ',', ctrl: true }).taken).toBe(true);
			expect(asked).toEqual([['settings']]);
			hooked.forEach(([type, listener, options]) => window.removeEventListener(type, listener, options));
		}
	});

	test('the desktop app on macOS leaves them to the menu bar, or each would run twice', async () => {
		await start('mac');
		menu.start();
		await settle();
		expect(press({ key: ',', meta: true })).toEqual({ taken: false, reached: true });
		expect(press({ key: '=', meta: true }).taken).toBe(false);
		expect(asked).toEqual([]);
		expect(settings.zoom()).toBe(1);
		// The menu bar's own items still arrive.
		w.emit('menu', 'settings');
		expect(asked).toEqual([['settings']]);
	});
});
