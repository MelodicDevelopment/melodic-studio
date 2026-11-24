import { afterEach, describe, expect, test, vi } from 'vitest';
import { settle, world } from '../test/world';
import type { EditorSettings, EditorSettingsStore } from './editor-settings.store';

const KEY = 'studio.editor';
const ZOOM_KEY = 'studio.zoom';

/** The desktop window's own zoom (Tauri's webview), as far as the store uses it. */
const webview = vi.hoisted(() => ({ zooms: [] as number[], broken: false }));
vi.mock('@tauri-apps/api/webview', () => ({
	getCurrentWebview: () => ({
		setZoom: async (zoom: number) => {
			if (webview.broken) {
				throw new Error('the webview does not zoom');
			}
			webview.zooms.push(zoom);
		},
	}),
}));

let store: EditorSettingsStore;
let DEFAULTS: EditorSettings;

/** The store as the app makes it at startup; `before` runs once storage is empty and before the store exists. */
async function start(before: () => void = () => undefined): Promise<EditorSettingsStore> {
	const w = await world();
	before();
	const module = await import('./editor-settings.store');
	DEFAULTS = module.EDITOR_DEFAULTS;
	store = w.get(module.EditorSettingsStore);
	return store;
}

const saved = (): Partial<EditorSettings> => JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<EditorSettings>;
const css = (name: string): string => document.documentElement.style.getPropertyValue(name);
const pageZoom = (): string => (document.documentElement.style as unknown as { zoom?: string }).zoom ?? '';

/** Storage that refuses every write, as a private window's can. */
function blockStorage(): void {
	vi.stubGlobal('localStorage', {
		getItem: () => null,
		setItem: () => {
			throw new Error('blocked');
		},
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
	document.documentElement.removeAttribute('style');
	webview.zooms = [];
	webview.broken = false;
});

describe('at startup', () => {
	test('with nothing saved, the settings are the defaults and nothing is written', async () => {
		await start();
		expect(store.settings()).toEqual(DEFAULTS);
		expect(store.zoom()).toBe(1);
		expect(localStorage.getItem(KEY)).toBeNull();
		expect(localStorage.getItem(ZOOM_KEY)).toBeNull();
	});

	test('what was saved is what is used', async () => {
		await start(() => localStorage.setItem(KEY, JSON.stringify({ fontSize: 15, wordWrap: true, tabSize: 4, whitespace: 'all', autoSave: 'focus', rulers: '80, 120', fontFamily: 'Fira Code' })));
		expect(store.settings()).toEqual({ ...DEFAULTS, fontSize: 15, wordWrap: true, tabSize: 4, whitespace: 'all', autoSave: 'focus', rulers: '80, 120', fontFamily: 'Fira Code' });
	});

	test('a setting added since the save has its default', async () => {
		await start(() => localStorage.setItem(KEY, JSON.stringify({ fontSize: 14 })));
		expect(store.settings().editorconfig).toBe(true);
		expect(store.settings().formatOnSave).toBe(false);
		expect(store.settings().fontSize).toBe(14);
	});

	test('saved text that is not JSON gives the defaults', async () => {
		await start(() => localStorage.setItem(KEY, '{"fontSize": 1'));
		expect(store.settings()).toEqual(DEFAULTS);
	});

	test('a saved `null` gives the defaults', async () => {
		await start(() => localStorage.setItem(KEY, 'null'));
		expect(store.settings()).toEqual(DEFAULTS);
	});

	test('saved values that make no sense are put right, one by one', async () => {
		await start(() =>
			localStorage.setItem(
				KEY,
				JSON.stringify({ fontFamily: 42, fontSize: 'huge', terminalFontSize: 400, lineHeight: 9, tabSize: 3, whitespace: 'sometimes', rulers: [80], autoSave: 'always', minimap: false })
			)
		);
		expect(store.settings()).toEqual({ ...DEFAULTS, fontFamily: '', fontSize: 12, terminalFontSize: 32, lineHeight: 1.65, tabSize: 0, whitespace: 'selection', rulers: '', autoSave: 'off', minimap: false });
	});

	test('the code font, size and line height are put on the page for the components that draw code themselves', async () => {
		await start(() => localStorage.setItem(KEY, JSON.stringify({ fontSize: 14, lineHeight: 1.5, fontFamily: 'Fira Code' })));
		expect(css('--ms-code-size')).toBe('14px');
		expect(css('--ms-code-line')).toBe('21px');
		expect(css('--ms-code-font')).toBe(store.font());
		expect(css('--ms-code-font')).toMatch(/^"Fira Code", /);
	});
});

describe('changing a setting', () => {
	test('changes it, keeps the others and saves all of them', async () => {
		await start();
		store.set('wordWrap', true);
		store.set('tabSize', 2);
		expect(store.settings()).toEqual({ ...DEFAULTS, wordWrap: true, tabSize: 2 });
		expect(saved()).toEqual({ ...DEFAULTS, wordWrap: true, tabSize: 2 });
	});

	test('a font size is kept between 8 and 32, in whole points', async () => {
		await start();
		store.set('fontSize', 3);
		expect(store.settings().fontSize).toBe(8);
		store.set('fontSize', 80);
		expect(store.settings().fontSize).toBe(32);
		store.set('fontSize', 13.6);
		expect(store.settings().fontSize).toBe(14);
		store.set('terminalFontSize', 7);
		expect(store.settings().terminalFontSize).toBe(8);
		expect(saved().fontSize).toBe(14);
	});

	test('a size that is not a number falls back to the default', async () => {
		await start();
		store.set('fontSize', 20);
		store.set('fontSize', Number.NaN);
		expect(store.settings().fontSize).toBe(12);
	});

	test('a line height outside 1 to 2.5 falls back to the default', async () => {
		await start();
		store.set('lineHeight', 2.5);
		expect(store.settings().lineHeight).toBe(2.5);
		store.set('lineHeight', 0.8);
		expect(store.settings().lineHeight).toBe(1.65);
		store.set('lineHeight', 1);
		expect(store.settings().lineHeight).toBe(1);
		store.set('lineHeight', 3);
		expect(store.settings().lineHeight).toBe(1.65);
	});

	test('a font name is trimmed', async () => {
		await start();
		store.set('fontFamily', '  Fira Code  ');
		expect(store.settings().fontFamily).toBe('Fira Code');
	});

	test('the page follows at once', async () => {
		await start();
		store.set('fontSize', 16);
		expect(css('--ms-code-size')).toBe('16px');
		expect(css('--ms-code-line')).toBe('26px');
		store.set('lineHeight', 2);
		expect(css('--ms-code-line')).toBe('32px');
		store.set('fontFamily', 'Menlo');
		expect(css('--ms-code-font')).toMatch(/^"Menlo", /);
	});

	test('storage that cannot be written does not stop the change', async () => {
		await start();
		blockStorage();
		store.set('fontSize', 18);
		store.setZoom(1.5);
		expect(store.settings().fontSize).toBe(18);
		expect(css('--ms-code-size')).toBe('18px');
		expect(store.zoom()).toBe(1.5);
	});

	test('"Reset" goes back to the defaults and saves them', async () => {
		await start();
		store.set('fontSize', 20);
		store.set('minimap', false);
		store.set('rulers', '80');
		store.reset();
		expect(store.settings()).toEqual(DEFAULTS);
		expect(saved()).toEqual(DEFAULTS);
		expect(css('--ms-code-size')).toBe('12px');
	});

	test('the editor\'s own zoom keys change the font size a point at a time, and back to the default', async () => {
		await start();
		store.nudgeFont(1);
		store.nudgeFont(1);
		expect(store.settings().fontSize).toBe(14);
		store.nudgeFont(-1);
		expect(store.settings().fontSize).toBe(13);
		store.nudgeFont(0);
		expect(store.settings().fontSize).toBe(12);
		store.set('fontSize', 32);
		store.nudgeFont(1);
		expect(store.settings().fontSize).toBe(32);
		store.set('fontSize', 8);
		store.nudgeFont(-1);
		expect(store.settings().fontSize).toBe(8);
	});
});

describe('what the editor reads', () => {
	test('the font is the chosen one first, then the app\'s own', async () => {
		await start();
		document.documentElement.style.setProperty('--ml-font-mono', 'JetBrains Mono Variable, monospace');
		expect(store.font()).toBe('JetBrains Mono Variable, monospace');
		store.set('fontFamily', 'Fira Code');
		expect(store.font()).toBe('"Fira Code", JetBrains Mono Variable, monospace');
	});

	test('a list of fonts, or a name already quoted, is used as typed', async () => {
		await start();
		document.documentElement.style.setProperty('--ml-font-mono', 'monospace');
		store.set('fontFamily', 'Fira Code, Menlo');
		expect(store.font()).toBe('Fira Code, Menlo, monospace');
		store.set('fontFamily', '\'Cascadia Code\'');
		expect(store.font()).toBe('\'Cascadia Code\', monospace');
	});

	test('without the app\'s font on the page, the system\'s monospace fonts stand in', async () => {
		await start();
		expect(store.font()).toBe('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace');
	});

	test('the rulers are the columns typed, in order, each once', async () => {
		await start();
		expect(store.rulers()).toEqual([]);
		store.set('rulers', '120, 80  100,80');
		expect(store.rulers()).toEqual([80, 100, 120]);
	});

	test('what is not a column is left out', async () => {
		await start();
		store.set('rulers', '80, wide, -4, 0, 12.5, 1000, 999');
		expect(store.rulers()).toEqual([80, 999]);
	});

	test('an .editorconfig line length is one more ruler', async () => {
		await start();
		store.set('rulers', '80');
		expect(store.rulers(100)).toEqual([80, 100]);
		expect(store.rulers(80)).toEqual([80]);
		expect(store.rulers(0)).toEqual([80]);
	});

	test('the line height in pixels is the font size times the multiple, rounded', async () => {
		await start();
		expect(store.lineHeightPx()).toBe(20); // 12 × 1.65 = 19.8
		store.set('fontSize', 13);
		store.set('lineHeight', 1.5);
		expect(store.lineHeightPx()).toBe(20); // 19.5
		store.set('fontSize', 11);
		store.set('lineHeight', 1.4);
		expect(store.lineHeightPx()).toBe(15); // 15.4
	});
});

describe('the window\'s zoom', () => {
	test('a saved zoom is used when it is one of the steps', async () => {
		await start(() => localStorage.setItem(ZOOM_KEY, '1.25'));
		expect(store.zoom()).toBe(1.25);
	});

	test('a saved zoom that is not one of the steps, or not a number, is 100%', async () => {
		await start(() => localStorage.setItem(ZOOM_KEY, '1.3'));
		expect(store.zoom()).toBe(1);
		await start(() => localStorage.setItem(ZOOM_KEY, 'big'));
		expect(store.zoom()).toBe(1);
		await start(() => localStorage.setItem(ZOOM_KEY, '0'));
		expect(store.zoom()).toBe(1);
	});

	test('one step bigger or smaller follows the browser\'s steps, and is saved', async () => {
		await start();
		store.stepZoom(1);
		expect(store.zoom()).toBe(1.1);
		store.stepZoom(1);
		expect(store.zoom()).toBe(1.25);
		expect(localStorage.getItem(ZOOM_KEY)).toBe('1.25');
		store.stepZoom(-1);
		store.stepZoom(-1);
		store.stepZoom(-1);
		expect(store.zoom()).toBe(0.9);
		expect(localStorage.getItem(ZOOM_KEY)).toBe('0.9');
	});

	test('it stops at 50% and at 200%', async () => {
		await start();
		for (let i = 0; i < 20; i++) {
			store.stepZoom(1);
		}
		expect(store.zoom()).toBe(2);
		for (let i = 0; i < 30; i++) {
			store.stepZoom(-1);
		}
		expect(store.zoom()).toBe(0.5);
	});

	test('"Actual size" is 100% from anywhere', async () => {
		await start(() => localStorage.setItem(ZOOM_KEY, '1.75'));
		store.stepZoom(0);
		expect(store.zoom()).toBe(1);
		expect(localStorage.getItem(ZOOM_KEY)).toBe('1');
	});

	test('a zoom that is not one of the steps is taken as 100%', async () => {
		await start();
		store.setZoom(1.5);
		store.setZoom(1.3);
		expect(store.zoom()).toBe(1);
	});

	test('in the browser preview the page itself is zoomed, and 100% leaves it alone', async () => {
		await start();
		store.setZoom(1.5);
		await settle();
		expect(pageZoom()).toBe('1.5');
		store.setZoom(1);
		await settle();
		expect(pageZoom()).toBe('');
		expect(webview.zooms).toEqual([]);
	});

	test('the saved zoom is put on the window when asked at startup', async () => {
		await start(() => localStorage.setItem(ZOOM_KEY, '0.8'));
		expect(pageZoom()).toBe('');
		await store.applyZoom();
		expect(pageZoom()).toBe('0.8');
	});

	test('in the desktop app the window\'s own zoom is used, not the page\'s', async () => {
		await start();
		(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
		store.setZoom(1.25);
		await settle();
		expect(webview.zooms).toEqual([1.25]);
		expect(pageZoom()).toBe('');
	});

	test('a desktop window that cannot zoom falls back to zooming the page', async () => {
		await start();
		(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
		webview.broken = true;
		store.setZoom(1.25);
		await settle();
		expect(pageZoom()).toBe('1.25');
	});
});
