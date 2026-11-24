import { beforeEach, describe, expect, test, vi } from 'vitest';
import { settle, world } from '../../test/world';
import { all, click, find, mount, text } from '../../test/dom';
import type { DiffNote, ParsedDiff } from '../../shared/diff';

// Monaco cannot run in happy-dom, and the language services reach for it as soon as they are loaded.
vi.mock('../../shared/monaco', () => ({ loadMonaco: () => new Promise(() => {}), setBuiltInTypeScript: () => {}, adoptMonacoStyles: async () => {}, releaseMonacoStyles: () => {} }));

let parseDiff: (raw: string, tooLarge?: boolean) => ParsedDiff;

type DiffElement = HTMLElement & { diff: ParsedDiff | null; notes: DiffNote[]; focusLine: number | null; emptyText: string };

const RAW = `diff --git a/src/greet.ts b/src/greet.ts
index 1111111..2222222 100644
--- a/src/greet.ts
+++ b/src/greet.ts
@@ -10,4 +10,5 @@ export function greet(name: string) {
 	const who = name.trim();
-	return 'Hello ' + who;
+	const hello = \`Hello \${who}\`;
+	return hello;
 }
\\ No newline at end of file
`;

/**
 * happy-dom keeps its custom elements across `vi.resetModules()` and Melodic defines a tag only once, so
 * without this every test after the first would mount the first test's classes.
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
	await world();
	forgetElements();
	await import('../../components');
	parseDiff = (await import('../../shared/diff')).parseDiff;
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
	return out.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
}

/** Each row as [old number, new number, sign, code]. */
function rows(el: Element): string[][] {
	return all(el, '.row').map((r) => [...r.children].map((c) => c.textContent ?? ''));
}

function note(change: Partial<DiffNote> = {}): DiffNote {
	return { line: 11, tone: 'bug', label: 'Bug', title: 'Greeting loses the comma', detail: 'The old text had one.', ...change };
}

describe('what is shown', () => {
	test('a spinner while the diff loads', async () => {
		const el = await mount<DiffElement>('ms-diff');
		expect(find(el, 'ml-spinner')).not.toBeNull();
		expect(all(el, '.row')).toEqual([]);
	});

	test('each line with its numbers on both sides and its sign', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff(RAW) });
		expect(rows(el)).toEqual([
			['', '', '', '@@ -10,4 +10,5 @@ export function greet(name: string) {'],
			['10', '10', '', '\tconst who = name.trim();'],
			['11', '', '−', "\treturn 'Hello ' + who;"],
			['', '11', '+', '\tconst hello = `Hello ${who}`;'],
			['', '12', '+', '\treturn hello;'],
			['12', '13', '', '}'],
			['', '', '', 'No newline at end of file'],
		]);
	});

	test('a diff that arrives later replaces the spinner', async () => {
		const el = await mount<DiffElement>('ms-diff');
		el.diff = parseDiff(RAW);
		await settle();
		expect(find(el, 'ml-spinner')).toBeNull();
		expect(all(el, '.row.add').length).toBe(2);
		expect(all(el, '.row.del').length).toBe(1);
	});

	test('a diff that is too large says so', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff('', true) });
		expect(words(el)).toBe('This diff is too large to show here.');
	});

	test('a binary file says so', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff('diff --git a/cover.png b/cover.png\nBinary files a/cover.png and b/cover.png differ\n') });
		expect(words(el)).toBe('Binary file. There is no text diff to show.');
	});

	test('nothing changed: the words it was given, or its own', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff('') });
		expect(words(el)).toBe('No content changes.');
		el.emptyText = 'This file is empty.';
		await settle();
		expect(words(el)).toBe('This file is empty.');
	});

	test('a diff cut short says the rest is missing', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: { ...parseDiff(RAW), truncated: true } });
		expect(text(el)).toContain('Diff truncated. Open the file in your editor to see the rest.');
	});
});

describe('text only', () => {
	test('markup in a line is shown as it was written, not made into elements', async () => {
		const raw = '@@ -1,1 +1,2 @@\n-<b>old</b>\n+<script>window.pwned = true</script>\n+<img src=x onerror="window.pwned = true">\n';
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff(raw) });
		expect(all(el, '.code').map((c) => c.textContent)).toEqual(['@@ -1,1 +1,2 @@', '<b>old</b>', '<script>window.pwned = true</script>', '<img src=x onerror="window.pwned = true">']);
		expect(all(el, '.rows script, .rows img, .rows b')).toEqual([]);
		expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
	});

	test('markup in a note is text as well', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff(RAW), notes: [note({ title: '<i>title</i>', detail: '<script>window.pwned = true</script>' })] });
		expect(find(el, '.fnote b')!.textContent).toBe('<i>title</i>');
		expect(find(el, '.fnote p')!.textContent).toBe('<script>window.pwned = true</script>');
		expect(all(el, '.fnote i, .fnote script')).toEqual([]);
	});
});

describe('notes', () => {
	test('a note sits under the new-file line it names', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff(RAW), notes: [note()] });
		const shown = find(el, '.fnote')!;
		expect(words(shown)).toBe('Bug Greeting loses the comma line 11 The old text had one.');
		const before = shown.previousElementSibling!;
		expect(before.children[1].textContent).toBe('11');
		expect(before.children[3].textContent).toBe('\tconst hello = `Hello ${who}`;');
	});

	test('a removed line with the same number on the old side does not take the note', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff(RAW), notes: [note()] });
		expect(all(el, '.fnote').length).toBe(1);
		expect(find(el, '.row.del')!.nextElementSibling!.classList.contains('fnote')).toBe(false);
	});

	test('a note about a line the diff does not show goes above the diff', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff(RAW), notes: [note({ line: 240, title: 'Far away' })] });
		const first = find(el, '.rows')!.firstElementChild!;
		expect(words(first)).toContain('Far away');
		expect(words(first)).toContain('line 240');
	});

	test('a note about the file as a whole goes above the diff, with no line', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff(RAW), notes: [note({ line: null, title: 'Whole file' })] });
		const first = find(el, '.rows')!.firstElementChild!;
		expect(words(first)).toBe('Bug Whole file The old text had one.');
	});

	test('two notes on one line both show, in order', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff(RAW), notes: [note({ title: 'First' }), note({ title: 'Second', tone: 'risk', label: 'Risk' })] });
		expect(all(el, '.fnote b').map((b) => b.textContent)).toEqual(['First', 'Second']);
	});

	test('a note without detail has no empty paragraph', async () => {
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff(RAW), notes: [note({ detail: '' })] });
		expect(find(el, '.fnote p')).toBeNull();
	});

	test('a note\'s button runs its action', async () => {
		const run = vi.fn();
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff(RAW), notes: [note({ action: { label: 'Ask Claude to fix', title: 'Sends the finding', disabled: false, run } })] });
		const button = find(el, '.fnote ml-button')!;
		expect(words(button)).toBe('Ask Claude to fix');
		await click(find(button, 'button'));
		expect(run).toHaveBeenCalledTimes(1);
	});

	test('a note\'s button that is off does nothing', async () => {
		const run = vi.fn();
		const el = await mount<DiffElement>('ms-diff', { diff: parseDiff(RAW), notes: [note({ action: { label: 'Ask Claude to fix', title: 'Claude is not installed', disabled: true, run } })] });
		const button = find<HTMLButtonElement>(find(el, '.fnote ml-button')!, 'button')!;
		expect(button.disabled).toBe(true);
		await click(button);
		expect(run).not.toHaveBeenCalled();
	});

	test('the note to look at is brought into view', async () => {
		const scrolled: Element[] = [];
		const was = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function (this: Element) {
			scrolled.push(this);
		};
		try {
			await mount<DiffElement>('ms-diff', { diff: parseDiff(RAW), notes: [note(), note({ line: 13, title: 'Other' })], focusLine: 13 });
			expect(scrolled.map((n) => find(n, 'b')!.textContent)).toEqual(['Other']);
		} finally {
			Element.prototype.scrollIntoView = was;
		}
	});
});
