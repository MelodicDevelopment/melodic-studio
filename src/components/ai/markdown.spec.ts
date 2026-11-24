import { beforeEach, describe, expect, test } from 'vitest';
// No store behind this module: it is the parser and its templates, so it is imported as it is.
import { render } from '@melodicdev/core/template';
import { markdownBlocks, renderMarkdown } from './markdown';

beforeEach(() => {
	document.body.replaceChildren();
});

/** One of Claude's answers, on the page as the side panel shows it. */
function show(source: string): HTMLElement {
	const box = document.createElement('div');
	document.body.append(box);
	render(renderMarkdown(source), box);
	return box;
}

const words = (box: HTMLElement): string => (box.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('an answer is never HTML', () => {
	test('a script tag is shown as the text it is', () => {
		const box = show('Fine. <script>window.pwned = true</script>');
		expect(box.querySelector('script')).toBeNull();
		expect(words(box)).toBe('Fine. <script>window.pwned = true</script>');
		expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
	});

	test('an image with an error handler makes no element', () => {
		const box = show('<img src=x onerror="window.pwned = true">');
		expect(box.querySelector('img, [onerror]')).toBeNull();
		expect(words(box)).toBe('<img src=x onerror="window.pwned = true">');
	});

	test('markup in headings, list items, bold, italic and code stays text', () => {
		const box = show(['# <b>Head</b>', '- <i>item</i>', '', '**<u>bold</u>** and *<s>slanted</s>* and `<em>code</em>`', '', '```', '<iframe src="x"></iframe>', '```'].join('\n'));
		expect(box.querySelector('b, i, u, s, iframe, code em')).toBeNull();
		for (const raw of ['<b>Head</b>', '<i>item</i>', '<u>bold</u>', '<s>slanted</s>', '<em>code</em>', '<iframe src="x"></iframe>']) {
			expect(words(box)).toContain(raw);
		}
	});

	test('a link is shown as its label and cannot be clicked through', () => {
		const box = show('See [the docs](https://example.com/docs) and [this](javascript:alert(1))');
		expect(box.querySelector('a')).toBeNull();
		expect(box.querySelector('[href]')).toBeNull();
		const labels = [...box.querySelectorAll('.link')];
		expect(labels.map((l) => l.textContent)).toEqual(['the docs', 'this']);
		// Where it would have gone is only a tooltip.
		expect(labels[0].getAttribute('title')).toBe('https://example.com/docs');
	});

	test('a bare web address stays plain text', () => {
		const box = show('Look at https://example.com/x');
		expect(box.querySelector('a, .link')).toBeNull();
		expect(words(box)).toBe('Look at https://example.com/x');
	});
});

describe('what is rendered', () => {
	test('headings, paragraphs and inline marks', () => {
		const box = show('## What changed\n\nThe **queue** now *wraps*, see `next()`.');
		expect(box.querySelector('.md-h')?.textContent).toBe('What changed');
		expect(box.querySelector('p strong')?.textContent).toBe('queue');
		expect(box.querySelector('p em')?.textContent).toBe('wraps');
		expect(box.querySelector('p code')?.textContent).toBe('next()');
	});

	test('a bulleted and a numbered list, with the numbers as written', () => {
		const box = show('- one\n- two\n\n3. three\n4. four');
		const lists = [...box.querySelectorAll('.md-list')];
		expect(lists.length).toBe(2);
		expect([...lists[0].querySelectorAll('.md-item')].map((i) => i.textContent)).toEqual(['one', 'two']);
		expect([...lists[1].querySelectorAll('.md-mark')].map((i) => i.textContent)).toEqual(['3.', '4.']);
	});

	test('a fenced block is code, as written', () => {
		const box = show('Before\n\n```ts\nthis._cursor = -1;\n  return **x**;\n```\n\nAfter');
		expect(box.querySelector('pre code')?.textContent).toBe('this._cursor = -1;\n  return **x**;');
		expect(box.querySelector('pre strong')).toBeNull();
		expect([...box.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Before', 'After']);
	});
});

describe('reading an answer into blocks', () => {
	test('an unfinished answer still reads: an open fence runs to the end', () => {
		expect(markdownBlocks('Intro\n```\nhalf a block')).toEqual([
			{ kind: 'para', text: 'Intro' },
			{ kind: 'code', text: 'half a block' },
		]);
	});

	test('lines of one paragraph are joined, a blank line ends it', () => {
		expect(markdownBlocks('one\ntwo\n\nthree')).toEqual([
			{ kind: 'para', text: 'one two' },
			{ kind: 'para', text: 'three' },
		]);
	});

	test('an indented item is nested under the one above, at most three deep', () => {
		const [list] = markdownBlocks('- top\n  - under\n          - far under');
		expect(list).toEqual({
			kind: 'list',
			ordered: false,
			items: [
				{ text: 'top', depth: 0, mark: '•' },
				{ text: 'under', depth: 1, mark: '•' },
				{ text: 'far under', depth: 3, mark: '•' },
			],
		});
	});

	test('an indented line right under an item continues that item', () => {
		const [list] = markdownBlocks('- first line\n  carries on\n- second');
		expect(list).toMatchObject({ kind: 'list', items: [{ text: 'first line carries on' }, { text: 'second' }] });
	});

	test('a heading drops its closing marks, and a row of dashes is a rule', () => {
		expect(markdownBlocks('### Title ###\n\n---')).toEqual([{ kind: 'heading', level: 3, text: 'Title' }, { kind: 'rule' }]);
	});

	test('a quote mark is dropped and its text kept', () => {
		expect(markdownBlocks('> quoted')).toEqual([{ kind: 'para', text: 'quoted' }]);
	});

	test('Windows line endings read the same', () => {
		expect(markdownBlocks('a\r\n\r\n- b\r\n')).toEqual([
			{ kind: 'para', text: 'a' },
			{ kind: 'list', ordered: false, items: [{ text: 'b', depth: 0, mark: '•' }] },
		]);
	});
});
