import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { EditorSettingsStore } from '../../services/editor-settings.store';

// Monaco and xterm cannot run in happy-dom; nothing here needs either to arrive.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));
vi.mock('../../shared/xterm', () => ({ loadXterm: () => new Promise(() => {}), adoptXtermStyles: () => {}, xtermTheme: () => ({}) }));

let store: EditorSettingsStore;
const platform = Object.getOwnPropertyDescriptor(navigator, 'platform');

/**
 * happy-dom keeps its custom elements across `vi.resetModules()` and Melodic defines a tag only once, so
 * without this every test after the first would mount the first test's classes, bound to its stores.
 */
function forgetElements(): void {
	const registry = customElements as unknown as Record<symbol, unknown>;
	for (const key of Object.getOwnPropertySymbols(registry)) {
		const value = registry[key];
		if (value instanceof Map) {
			value.clear();
		}
	}
}

/** happy-dom has no Popover API (an `ml-select` closes its list through it). */
function popovers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, (this: HTMLElement) => void>;
	proto.showPopover = proto.hidePopover = proto.togglePopover = function () {};
}

/**
 * What a person reads under `root`, through shadow roots: the text as it is written, a space where an element
 * starts or ends, and no icons (an `ml-icon` draws a private-use character of its font).
 */
function words(root: Node): string {
	let out = '';
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			out += node.textContent ?? '';
			return;
		}
		if (node instanceof Element) {
			if (node.tagName === 'STYLE' || node.tagName === 'SCRIPT') {
				return;
			}
			if (node.shadowRoot) {
				walk(node.shadowRoot);
			}
		}
		out += ' ';
		node.childNodes.forEach(walk);
		out += ' ';
	};
	walk(root);
	return out.replace(/[-]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The app on this platform (`navigator.platform` is what `isMac()` reads), the section on screen. `seed` puts
 * what an earlier run would have left in storage, before the store reads it.
 */
async function start(on = 'MacIntel', seed: () => void = () => {}): Promise<HTMLElement> {
	Object.defineProperty(navigator, 'platform', { value: on, configurable: true });
	const w = await world();
	seed();
	forgetElements();
	popovers();
	await import('../../components');
	store = w.get((await import('../../services/editor-settings.store')).EditorSettingsStore);
	return mount('ms-editor-settings');
}

afterEach(() => {
	if (platform) {
		Object.defineProperty(navigator, 'platform', platform);
	}
});

function field(el: Element, label: string): HTMLElement {
	return all(el, 'ml-input, ml-select').find((f) => f.getAttribute('label') === label)!;
}

/** Types into an `ml-input`; with `leave`, also leaves it (which is when a number field takes its value). */
async function type(input: Element, value: string, leave = false): Promise<void> {
	const inner = find<HTMLInputElement>(input, 'input')!;
	inner.value = value;
	inner.dispatchEvent(new Event('input', { bubbles: true }));
	if (leave) {
		inner.dispatchEvent(new Event('change', { bubbles: true }));
	}
	await settle();
}

async function choose(select: Element, label: string): Promise<void> {
	await click(all(select, '.ml-select__option').find((o) => words(o) === label)!);
}

function saved(): Record<string, unknown> {
	return JSON.parse(localStorage.getItem('studio.editor') ?? '{}');
}

describe('the font', () => {
	let el: HTMLElement;
	beforeEach(async () => {
		el = await start();
	});

	test('a font typed by name is used for the preview and remembered', async () => {
		await type(field(el, 'Font'), 'Fira Code');
		expect(store.settings().fontFamily).toBe('Fira Code');
		expect(saved().fontFamily).toBe('Fira Code');
		expect(find(el, '.preview')!.style.fontFamily).toContain('Fira Code');
	});

	test('the size is taken when the field is left, and kept between 8 and 32', async () => {
		await type(field(el, 'Size'), '15', true);
		expect(store.settings().fontSize).toBe(15);
		expect(find(el, '.preview')!.style.fontSize).toBe('15px');
		await type(field(el, 'Size'), '90', true);
		expect(store.settings().fontSize).toBe(32);
		await type(field(el, 'Size'), '2', true);
		expect(store.settings().fontSize).toBe(8);
	});

	test('line spacing changes the preview\'s line height', async () => {
		expect(find(el, '.preview')!.style.lineHeight).toBe('20px');
		await choose(field(el, 'Line spacing'), 'Relaxed');
		expect(store.settings().lineHeight).toBe(1.9);
		expect(find(el, '.preview')!.style.lineHeight).toBe('23px');
	});

	test('the terminal has a text size of its own', async () => {
		await type(field(el, 'Terminal text size'), '14', true);
		expect(store.settings().terminalFontSize).toBe(14);
		expect(store.settings().fontSize).toBe(12);
	});
});

describe('the choices', () => {
	let el: HTMLElement;
	beforeEach(async () => {
		el = await start();
	});

	test.each([
		['Tab size', '4 spaces', 'tabSize', 4],
		['Tab size', 'From the file', 'tabSize', 0],
		['Show spaces and tabs', 'Always', 'whitespace', 'all'],
		['Auto-save', 'A second after typing stops', 'autoSave', 'delay'],
		['Auto-save', 'When the window loses focus', 'autoSave', 'focus'],
	] as const)('%s: "%s" is kept', async (label, option, key, value) => {
		await choose(field(el, label), option);
		expect(store.settings()[key]).toBe(value);
		expect(saved()[key]).toBe(value);
	});

	test('the rulers are columns to draw a guide at', async () => {
		await type(field(el, 'Rulers'), '80, 120');
		expect(store.rulers()).toEqual([80, 120]);
	});

	test('the window zoom is kept apart from the editor\'s settings', async () => {
		await choose(field(el, 'Window zoom'), '125%');
		expect(store.zoom()).toBe(1.25);
		expect(localStorage.getItem('studio.zoom')).toBe('1.25');
		expect(saved().zoom).toBeUndefined();
	});

	test('"Restore defaults" puts every setting back', async () => {
		await type(field(el, 'Font'), 'Fira Code');
		await choose(field(el, 'Tab size'), '8 spaces');
		await click(find(find(el, '.end ml-button')!, 'button'));
		expect(store.settings()).toMatchObject({ fontFamily: '', tabSize: 0, fontSize: 12, autoSave: 'off', formatOnSave: false, editorconfig: true });
		expect(find<HTMLInputElement>(field(el, 'Font'), 'input')!.value).toBe('');
	});

	test('what was chosen before is what the section opens with', async () => {
		const again = await start('MacIntel', () => localStorage.setItem('studio.editor', JSON.stringify({ fontSize: 16, autoSave: 'focus' })));
		expect(find<HTMLInputElement>(field(again, 'Size'), 'input')!.value).toBe('16');
		expect(words(find(field(again, 'Auto-save'), '.ml-select__value')!)).toBe('When the window loses focus');
	});
});

describe('the switches', () => {
	// A bug until 2026-11-23: every on/off setting here is an `<ml-toggle>` (editor-settings.component.ts, `toggle`), and nothing
	// registers that element: src/components.ts imports no `@melodicdev/components/toggle`. An element nobody defined
	// draws nothing, so none of the eleven switches (wrap, minimap, line numbers, sticky scroll, bracket colours,
	// ligatures, cursor, format on save, trim, final newline, .editorconfig) is on screen. What holds now: a switch that
	// shows the setting and changes it. Before the fix: no switch, and Format on save cannot be turned on from Settings.
	test('"Format on save" has a switch, off to begin with, that turns it on', async () => {
		const el = await start();
		const toggle = all(el, 'ml-toggle').find((t) => t.getAttribute('label') === 'Format on save')!;
		const input = find<HTMLInputElement>(toggle, 'input')!;
		expect(input.checked).toBe(false);
		input.checked = true;
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(store.settings().formatOnSave).toBe(true);
	});

	test('there is one for each on/off setting, showing how it stands', async () => {
		const el = await start();
		expect(all<HTMLElement & { checked: boolean }>(el, 'ml-toggle').map((t) => [t.getAttribute('label'), t.checked])).toEqual([
			['Wrap long lines', false],
			['Minimap', true],
			['Line numbers', true],
			['Sticky scroll', false],
			['Colour matching brackets', true],
			['Colour names by what they are', true],
			['Code lens', true],
			['Font ligatures', false],
			['Blinking cursor', true],
			['Format on save', false],
			['Trim trailing spaces on save', false],
			['End files with a newline on save', false],
			["Follow the repository's .editorconfig", true],
		]);
	});
});

describe('how the shortcuts are written', () => {
	function shown(el: Element): { save: string; zoom: string; size: string; format: string } {
		return {
			save: words(all(field(el, 'Auto-save'), '.ml-select__option')[0]),
			zoom: words(all(el, 'small').at(-1)!),
			size: words(all(el, 'small')[0]),
			format: all(el, 'ml-toggle').find((t) => t.getAttribute('label') === 'Format on save')!.getAttribute('hint')!,
		};
	}

	test('with ⌘ on a Mac', async () => {
		const s = shown(await start('MacIntel'));
		expect(s.save).toBe('Off: save with ⌘S');
		expect(s.zoom).toBe('Zoom scales the whole window: ⌘+ and ⌘− (⌘0 for 100%).');
		expect(s.size).toContain('⌘⌥= and ⌘⌥− change the size from the editor.');
		expect(s.format).toMatch(/^⌘S formats the file first/);
	});

	test.each(['Win32', 'Linux x86_64'])('with Ctrl+ on %s', async (system) => {
		const s = shown(await start(system));
		expect(s.save).toBe('Off: save with Ctrl+S');
		expect(s.zoom).toBe('Zoom scales the whole window: Ctrl++ and Ctrl+− (Ctrl+0 for 100%).');
		expect(s.format).toMatch(/^Ctrl\+S formats the file first/);
	});
});
