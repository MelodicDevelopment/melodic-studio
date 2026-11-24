import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world, type World } from '../../test/world';
import { all, click, find, mount } from '../../test/dom';
import type { AgentsStore } from '../../services/agents.store';
import type { Attachment } from '../../services/agent-images';

// The app starts on the Files tab, which makes LspService load Monaco as soon as it exists; happy-dom cannot run it.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => undefined), setBuiltInTypeScript: () => undefined, adoptMonacoStyles: async () => undefined, releaseMonacoStyles: () => undefined }));

let w: World;
let agents: AgentsStore;

/**
 * happy-dom keeps one registry of custom elements for the whole file and Melodic never defines a name
 * twice, so without this the elements of a later test would still be the first test's classes, tied
 * to the first test's stores.
 */
function forgetElements(): void {
	const registry = customElements as unknown as Record<symbol, unknown>;
	for (const key of Object.getOwnPropertySymbols(registry)) {
		const held = registry[key];
		if (held instanceof Map) {
			held.clear();
		}
	}
}

beforeEach(async () => {
	forgetElements();
	w = await world();
	await import('../../components');
	await w.get((await import('../../services/repo.store')).RepoStore).init();
	agents = w.get((await import('../../services/agents.store')).AgentsStore);
	await agents.init();
});

/** Tags that mark words inside a sentence: nothing is read between them and the words around them. */
const INLINE = new Set(['B', 'I', 'EM', 'STRONG', 'CODE', 'U']);

/**
 * What a person reads under `root`, through shadow roots: text that stands together stays together,
 * the icons' glyphs are left out, and so is a dialog that is not open.
 */
function read(root: Element | ShadowRoot): string {
	const parts: string[] = [];
	const walk = (node: Node): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			parts.push(node.textContent ?? '');
		} else if (node instanceof Element) {
			const closed = node.tagName === 'ML-DIALOG' && !node.shadowRoot?.querySelector('dialog')?.open;
			if (node.tagName !== 'STYLE' && node.tagName !== 'SCRIPT' && !closed) {
				const gap = INLINE.has(node.tagName) ? '' : ' ';
				parts.push(gap);
				if (node.shadowRoot) {
					walk(node.shadowRoot);
				}
				node.childNodes.forEach(walk);
				parts.push(gap);
			}
		} else {
			node.childNodes.forEach(walk);
		}
	};
	walk(root);
	return parts
		.join('')
		.replace(/[\uE000-\uF8FF]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The first bytes of a PNG, which is how an image is known (not by its name). */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const png = (name = 'shot.png'): File => new File([PNG], name, { type: 'image/png' });
const waiting = (name: string): Attachment => ({ name, mediaType: 'image/png', data: 'AAAA', url: 'data:image/png;base64,AAAA' });

/** A composer: the zone, a text box in it, and `ms-attach` for `box`. */
async function composer(props: Record<string, unknown> = {}): Promise<{ zone: HTMLElement; field: HTMLElement; el: HTMLElement }> {
	const zone = document.createElement('div');
	const field = document.createElement('textarea');
	const el = document.createElement('ms-attach');
	Object.assign(el, { box: 's1', ...props });
	zone.append(el, field);
	document.body.append(zone);
	await settle();
	return { zone, field, el };
}

/** What `AgentsStore.attach` was asked to take, instead of decoding it (happy-dom draws no images). */
function taken(): { box: string; names: string[] }[] {
	const calls: { box: string; names: string[] }[] = [];
	agents.attach = async (box: string, files: Blob[]) => void calls.push({ box, names: files.map((f) => (f as File).name) });
	return calls;
}

function paste(target: Element, files: File[], text = ''): Event {
	const e = new Event('paste', { bubbles: true, composed: true, cancelable: true });
	Object.defineProperty(e, 'clipboardData', { value: { files, items: [], getData: () => text } });
	target.dispatchEvent(e);
	return e;
}

function drag(kind: 'dragover' | 'drop' | 'dragleave', target: Element | Document, files: File[], related: Element | null = null): Event {
	const e = new Event(kind, { bubbles: true, composed: true, cancelable: true });
	Object.defineProperty(e, 'dataTransfer', { value: { files, items: [], types: files.length ? ['Files'] : ['text/plain'] } });
	Object.defineProperty(e, 'relatedTarget', { value: related });
	target.dispatchEvent(e);
	return e;
}

describe('images waiting to go with a message', () => {
	test('with none it takes no room at all', async () => {
		const { el } = await composer();
		expect(el.hasAttribute('hidden')).toBe(true);
		expect(all(el, 'img')).toEqual([]);
	});

	test('one that arrives after an empty first look is shown as a thumbnail', async () => {
		const { el } = await composer();
		agents.attached.set({ s1: [waiting('a.png')] });
		await settle();
		expect(el.hasAttribute('hidden')).toBe(false);
		expect(all<HTMLImageElement>(el, 'img').map((i) => i.getAttribute('src'))).toEqual(['data:image/png;base64,AAAA']);
	});

	test('shows only its own box\u2019s images', async () => {
		agents.attached.set({ s1: [waiting('a.png'), waiting('b.png')], other: [waiting('c.png')] });
		const { el } = await composer();
		expect(all(el, 'img').length).toBe(2);
	});

	test('each thumbnail can be taken out again', async () => {
		agents.attached.set({ s1: [waiting('a.png'), waiting('b.png')] });
		const { el } = await composer();
		await click(all(el, 'button[aria-label="Remove this image"]')[0]);
		expect(agents.attached().s1.map((a) => a.name)).toEqual(['b.png']);
		expect(all(el, 'img').length).toBe(1);
		await click(find(el, 'button[aria-label="Remove this image"]'));
		expect(el.hasAttribute('hidden')).toBe(true);
	});

	test('shows that one is still being made ready', async () => {
		const { el } = await composer();
		agents.attaching.set({ s1: 1 });
		await settle();
		expect(el.hasAttribute('hidden')).toBe(false);
		expect(find(el, 'ml-spinner')).not.toBeNull();
		agents.attaching.set({ s1: 0 });
		await settle();
		expect(el.hasAttribute('hidden')).toBe(true);
	});

	test('with `pick` it also has the Image button and says how else an image gets in', async () => {
		const { el } = await composer({ pick: true });
		expect(el.hasAttribute('hidden')).toBe(false);
		expect(read(el)).toBe('Image or paste a screenshot, or drop an image here');
	});
});

describe('a paste', () => {
	test('of an image in the box\u2019s zone goes with the message, and is not also pasted as text', async () => {
		const got = taken();
		const { field } = await composer();
		const e = paste(field, [png()]);
		expect(got).toEqual([{ box: 's1', names: ['shot.png'] }]);
		expect(e.defaultPrevented).toBe(true);
	});

	test('of text is left to the text box', async () => {
		const got = taken();
		const { field } = await composer();
		const e = paste(field, [], 'just words');
		expect(got).toEqual([]);
		expect(e.defaultPrevented).toBe(false);
	});

	test('of a file that is not an image is left alone', async () => {
		const got = taken();
		const { field } = await composer();
		const e = paste(field, [new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' })]);
		expect(got).toEqual([]);
		expect(e.defaultPrevented).toBe(false);
	});

	test('somewhere else on the page is not this box\u2019s', async () => {
		const got = taken();
		await composer();
		const elsewhere = document.createElement('textarea');
		document.body.append(elsewhere);
		const e = paste(elsewhere, [png()]);
		expect(got).toEqual([]);
		expect(e.defaultPrevented).toBe(false);
	});

	test('counts anywhere in a zone that was given, such as a whole session pane', async () => {
		const got = taken();
		const pane = document.createElement('section');
		const far = document.createElement('p');
		pane.append(far);
		document.body.append(pane);
		await composer({ zone: pane });
		paste(far, [png()]);
		expect(got).toEqual([{ box: 's1', names: ['shot.png'] }]);
	});

	test('counts when it comes from inside another component in the zone (a text box in its own shadow root)', async () => {
		const got = taken();
		const { zone } = await composer();
		const area = document.createElement('ml-textarea');
		zone.append(area);
		await settle();
		paste(find(area, 'textarea')!, [png()]);
		expect(got).toEqual([{ box: 's1', names: ['shot.png'] }]);
	});

	test('goes to the one box whose zone it was in, when two are on the page', async () => {
		const got = taken();
		const first = await composer({ box: 's1' });
		await composer({ box: 'draft:task' });
		paste(first.field, [png()]);
		expect(got).toEqual([{ box: 's1', names: ['shot.png'] }]);
	});

	test('is ignored by a box that has no name yet', async () => {
		const got = taken();
		const { field } = await composer({ box: '' });
		paste(field, [png()]);
		expect(got).toEqual([]);
	});

	test('is no longer taken once the box is gone', async () => {
		const got = taken();
		const { field, el } = await composer();
		el.remove();
		await settle();
		paste(field, [png()]);
		expect(got).toEqual([]);
	});

	test('of a real PNG ends as a thumbnail, under a name of ours and not the file\u2019s', async () => {
		// happy-dom decodes no images: the size comes from here, the bytes are read for real.
		vi.stubGlobal('createImageBitmap', async () => ({ width: 40, height: 30, close: () => undefined }));
		try {
			const { field, el } = await composer();
			paste(field, [png('Screenshot 2026-11-20 at 10.14.03.png')]);
			await vi.waitFor(() => expect(agents.attached().s1?.length).toBe(1));
			await settle();
			const [image] = agents.attached().s1;
			expect(image.mediaType).toBe('image/png');
			expect(image.name).toMatch(/^[0-9a-f-]{36}\.png$/);
			expect(image.url.startsWith('data:image/png;base64,')).toBe(true);
			expect(all(el, 'img').length).toBe(1);
			expect(agents.attaching().s1).toBe(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	test('of something that only claims to be an image is refused in words', async () => {
		vi.stubGlobal('createImageBitmap', async () => {
			throw new Error('cannot decode');
		});
		try {
			const { field, el } = await composer();
			paste(field, [new File(['not an image at all'], 'fake.png', { type: 'image/png' })]);
			await vi.waitFor(() => expect(w.toasts.length).toBe(1));
			expect(w.toasts[0]).toMatchObject({ kind: 'error', title: 'That image was not added' });
			expect(agents.attached().s1 ?? []).toEqual([]);
			await settle();
			expect(all(el, 'img')).toEqual([]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('a drop in the browser preview', () => {
	test('files dragged over the zone show where to drop, and leaving the window takes that away', async () => {
		const { field, el } = await composer();
		const over = drag('dragover', field, [png()]);
		await settle();
		expect(over.defaultPrevented).toBe(true);
		expect(read(el)).toBe('Drop the image here');
		drag('dragleave', document, [png()]);
		await settle();
		expect(el.hasAttribute('hidden')).toBe(true);
	});

	test('text dragged over it is none of its business', async () => {
		const { field, el } = await composer();
		const over = drag('dragover', field, []);
		await settle();
		expect(over.defaultPrevented).toBe(false);
		expect(el.hasAttribute('hidden')).toBe(true);
	});

	test('an image dropped in the zone goes with the message; other files dropped with it do not', async () => {
		const got = taken();
		const { field, el } = await composer();
		drag('dragover', field, [png()]);
		const drop = drag('drop', field, [png('a.png'), new File(['x'], 'notes.txt', { type: 'text/plain' })]);
		await settle();
		expect(drop.defaultPrevented).toBe(true);
		expect(got).toEqual([{ box: 's1', names: ['a.png'] }]);
		expect(read(el)).not.toContain('Drop the image here');
	});

	test('a drop outside the zone is not taken', async () => {
		const got = taken();
		await composer();
		const drop = drag('drop', document.body, [png()]);
		expect(got).toEqual([]);
		expect(drop.defaultPrevented).toBe(false);
	});
});

describe('the Image button', () => {
	test('opens the file picker, which offers the four kinds Claude reads', async () => {
		const el = await mount('ms-attach-button', { box: 's1' });
		const input = find<HTMLInputElement>(el, 'input[type=file]')!;
		expect(input.accept).toBe('image/png,image/jpeg,image/gif,image/webp');
		expect(input.multiple).toBe(true);
		let opened = 0;
		input.click = () => void opened++;
		await click(find(find(el, 'ml-button')!, 'button'));
		expect(opened).toBe(1);
	});

	test('what is picked goes to its box, and the same file can be picked again', async () => {
		const got = taken();
		const el = await mount('ms-attach-button', { box: 'draft:ask' });
		const input = find<HTMLInputElement>(el, 'input[type=file]')!;
		let value = 'C:\\fakepath\\a.png';
		Object.defineProperty(input, 'files', { value: [png('a.png'), png('b.png')], configurable: true });
		Object.defineProperty(input, 'value', { get: () => value, set: (v: string) => void (value = v), configurable: true });
		input.dispatchEvent(new Event('change', { bubbles: true }));
		expect(got).toEqual([{ box: 'draft:ask', names: ['a.png', 'b.png'] }]);
		expect(value).toBe('');
	});
});
