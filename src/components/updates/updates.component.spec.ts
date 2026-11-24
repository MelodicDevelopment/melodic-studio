import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world } from '../../test/world';
import { click, find, mount } from '../../test/dom';
import type { UpdateState, UpdatesService } from '../../services/updates.service';

// Monaco cannot run in happy-dom, and the language services reach for it as soon as they are loaded.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));

let updates: UpdatesService;

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

beforeEach(async () => {
	const w = await world();
	forgetElements();
	await import('../../components');
	updates = w.get((await import('../../services/updates.service')).UpdatesService);
});

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

/** A newer version, downloaded and waiting. */
function staged(): void {
	updates.staged.set({ currentVersion: '0.5.2', version: '0.6.0', notes: '' });
	updates.state.set('ready');
}

/** The installed app, where updates happen: a test runs as the browser preview, where they do not. */
function installed(): void {
	vi.spyOn(updates, 'supported', 'get').mockReturnValue(true);
}

describe('the toolbar pill', () => {
	test('is not there while no update is waiting', async () => {
		const el = await mount('ms-update-pill');
		expect(find(el, '.pill')).toBeNull();
		expect(words(el)).toBe('');
	});

	test('appears once a version is downloaded, saying which and what to do', async () => {
		const el = await mount('ms-update-pill');
		staged();
		await settle();
		const pill = find<HTMLButtonElement>(el, '.pill')!;
		expect(words(pill)).toBe('Version 0.6.0 is ready Restart to update');
		expect(pill.title).toBe('You have 0.5.2. Restart to finish updating.');
		expect(pill.disabled).toBe(false);
	});

	test('one click restarts into the new version', async () => {
		const restart = vi.spyOn(updates, 'restart').mockResolvedValue();
		staged();
		const el = await mount('ms-update-pill');
		await click(find(el, '.pill'));
		expect(restart).toHaveBeenCalledTimes(1);
	});

	test('while restarting it says so and cannot be clicked again', async () => {
		staged();
		updates.state.set('restarting');
		const el = await mount('ms-update-pill');
		const pill = find<HTMLButtonElement>(el, '.pill')!;
		expect(pill.disabled).toBe(true);
		expect(find(pill, 'span')!.textContent).toBe('Restarting…');
		expect(find(pill, 'b')).toBeNull();
	});

	test('a development build never looks for updates by itself', async () => {
		const check = vi.spyOn(updates, 'check');
		const timers = vi.spyOn(globalThis, 'setInterval');
		await mount('ms-update-pill');
		expect(check).not.toHaveBeenCalled();
		expect(timers).not.toHaveBeenCalled();
	});
});

describe('the row in Settings', () => {
	function button(el: Element): HTMLButtonElement {
		return find<HTMLButtonElement>(find(el, 'ml-button')!, 'button')!;
	}

	test('in a development build it says updates belong to the installed app, and cannot check', async () => {
		const el = await mount('ms-update-status');
		expect(find(el, '.text')!.textContent).toBe('Updates are checked in the installed app, not in a development build.');
		expect(words(find(el, 'ml-button')!)).toBe('Check now');
		expect(button(el).disabled).toBe(true);
	});

	test.each([
		['idle', 'Melodic Studio checks for updates by itself and downloads them in the background.'],
		['checking', 'Checking for updates…'],
		['downloading', 'Downloading the new version…'],
		['current', 'You have the latest version.'],
	] as [UpdateState, string][])('in the installed app, while %s, it says so', async (state, text) => {
		installed();
		updates.state.set(state);
		const el = await mount('ms-update-status');
		expect(find(el, '.text')!.textContent).toBe(text);
	});

	test('"Check now" looks for a newer version', async () => {
		installed();
		const check = vi.spyOn(updates, 'check').mockResolvedValue();
		const el = await mount('ms-update-status');
		expect(button(el).disabled).toBe(false);
		await click(button(el));
		expect(check).toHaveBeenCalledTimes(1);
	});

	test('a check that failed says why', async () => {
		installed();
		updates.error.set('Could not reach github.com');
		updates.state.set('failed');
		const el = await mount('ms-update-status');
		expect(find(el, '.text')!.textContent).toBe('Could not check for updates: Could not reach github.com');
		expect(find(el, '.text')!.classList.contains('bad')).toBe(true);
		expect(words(find(el, 'ml-button')!)).toBe('Check now');
	});

	test('a downloaded version is named, and the button restarts into it', async () => {
		installed();
		const restart = vi.spyOn(updates, 'restart').mockResolvedValue();
		staged();
		const el = await mount('ms-update-status');
		expect(find(el, '.text')!.textContent).toBe('Version 0.6.0 is downloaded and ready.');
		expect(words(find(el, 'ml-button')!)).toBe('Restart to update');
		await click(button(el));
		expect(restart).toHaveBeenCalledTimes(1);
	});

	test('it follows the updater as it goes', async () => {
		installed();
		const el = await mount('ms-update-status');
		updates.state.set('checking');
		await settle();
		expect(find(el, '.text')!.textContent).toBe('Checking for updates…');
		staged();
		await settle();
		expect(find(el, '.text')!.textContent).toBe('Version 0.6.0 is downloaded and ready.');
	});
});
