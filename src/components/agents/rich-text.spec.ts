import { beforeEach, describe, expect, test } from 'vitest';
// No store behind this module: it is the parser and its templates, so it is imported as it is.
import { render } from '@melodicdev/core/template';
import { fileRef, parse, richText, type Block, type Inline, type Ref, type RichOptions } from './rich-text';

let followed: Ref[];

beforeEach(() => {
	followed = [];
	document.body.replaceChildren();
});

/** What an agent wrote, on the page as a session shows it. */
function show(text: string, options: Partial<RichOptions> = {}): HTMLElement {
	const box = document.createElement('div');
	document.body.append(box);
	render(
		richText(text, { files: true, commits: false, root: null, ...options }, (ref) => followed.push(ref)),
		box
	);
	return box;
}

const links = (box: HTMLElement): HTMLElement[] => [...box.querySelectorAll<HTMLElement>('a')];
const linkTexts = (box: HTMLElement): string[] => links(box).map((a) => a.textContent ?? '');
const words = (box: HTMLElement): string => (box.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Every link in a parsed text, wherever it sits. */
function refs(text: string, options: Partial<RichOptions> = {}): Ref[] {
	const out: Ref[] = [];
	const inline = (nodes: Inline[]): void => {
		for (const n of nodes) {
			if (n.t === 'link') {
				out.push(n.ref);
				inline(n.children);
			} else if (n.t === 'code' && n.ref) {
				out.push(n.ref);
			} else if (n.t === 'strong' || n.t === 'em' || n.t === 'del') {
				inline(n.children);
			}
		}
	};
	const blocks = (list: Block[]): void => {
		for (const b of list) {
			if (b.t === 'p' || b.t === 'h') {
				inline(b.inline);
			} else if (b.t === 'list') {
				b.items.forEach(blocks);
			} else if (b.t === 'quote') {
				blocks(b.blocks);
			} else if (b.t === 'table') {
				b.head.forEach(inline);
				b.rows.forEach((r) => r.forEach(inline));
			}
		}
	};
	blocks(parse(text, { files: true, commits: false, root: null, ...options }));
	return out;
}

describe('what an agent wrote is never HTML', () => {
	test('a script tag is shown as the text it is', () => {
		const box = show('Done. <script>window.pwned = true</script> and more');
		expect(box.querySelector('script')).toBeNull();
		expect(words(box)).toBe('Done. <script>window.pwned = true</script> and more');
		expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
	});

	test('an image with an error handler is shown as text and makes no element', () => {
		const box = show('<img src=x onerror="window.pwned = true"> look');
		expect(box.querySelector('img')).toBeNull();
		expect(box.querySelector('[onerror]')).toBeNull();
		expect(words(box)).toBe('<img src=x onerror="window.pwned = true"> look');
	});

	test('markup inside emphasis, headings, lists, quotes and tables stays text', () => {
		const box = show(['# <b>Title</b>', '', '**<i>bold</i>**', '', '- <u>item</u>', '', '> <s>quote</s>', '', '| <em>a</em> | b |', '| --- | --- |', '| <a href="x">c</a> | d |'].join('\n'));
		expect(box.querySelector('b, i, u, s, table a')).toBeNull();
		const shown = words(box);
		for (const raw of ['<b>Title</b>', '<i>bold</i>', '<u>item</u>', '<s>quote</s>', '<em>a</em>', '<a href="x">c</a>']) {
			expect(shown).toContain(raw);
		}
	});

	test('a code block keeps markup as written', () => {
		const box = show('```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```');
		expect(box.querySelector('script, img')).toBeNull();
		expect(box.querySelector('pre code')?.textContent).toBe('<script>alert(1)</script>\n<img src=x onerror=alert(1)>');
	});

	test('inline code keeps markup as written', () => {
		const box = show('Use `<div onclick="x()">` here');
		expect(box.querySelector('div[onclick]')).toBeNull();
		expect(box.querySelector('code')?.textContent).toBe('<div onclick="x()">');
	});

	test('an HTML entity is not decoded into markup', () => {
		const box = show('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(box.querySelector('script')).toBeNull();
		expect(words(box)).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
	});
});

describe('the only links are the ones made here', () => {
	test('a Markdown link to a web address opens that address', () => {
		const box = show('Read [the docs](https://example.com/docs?a=1) first');
		expect(linkTexts(box)).toEqual(['the docs']);
		links(box)[0].click();
		expect(followed).toEqual([{ kind: 'url', url: 'https://example.com/docs?a=1' }]);
	});

	test('a link never carries an address of its own: the click is handled here', () => {
		const box = show('[the docs](https://example.com) and https://example.org and `src/a.ts:3`');
		expect(links(box).length).toBe(3);
		for (const a of links(box)) {
			expect(a.getAttribute('href')).toBeNull();
		}
	});

	test('a javascript: link is dropped and its label stays as text', () => {
		const box = show('[click me](javascript:alert(1))');
		expect(links(box)).toEqual([]);
		expect(words(box)).toContain('click me');
	});

	test('data:, file: and vbscript: targets make no link', () => {
		expect(refs('[a](data:text/html,<script>1</script>) [b](file:///etc/passwd) [c](vbscript:msgbox)')).toEqual([]);
	});

	test('a bare web address in prose is a link, without the sentence that ends after it', () => {
		const box = show('See https://example.com/a/b. Then (https://example.org/x) too.');
		expect(linkTexts(box)).toEqual(['https://example.com/a/b', 'https://example.org/x']);
	});

	test('an address in angle brackets is a link', () => {
		expect(refs('<https://example.com/x>')).toEqual([{ kind: 'url', url: 'https://example.com/x' }]);
	});

	test('other schemes in prose are not links', () => {
		expect(refs('ftp://example.com/file and mailto:someone@example.com and javascript:alert(1)')).toEqual([]);
	});

	test('a web address ends at a quote, so nothing can be added to it', () => {
		expect(refs('https://example.com/"onmouseover="alert(1)')).toEqual([{ kind: 'url', url: 'https://example.com/' }]);
	});

	test('a Markdown link whose target is a file in the repository opens the file', () => {
		const box = show('[the queue](src/player/queue.ts#L42)');
		links(box)[0].click();
		expect(followed).toEqual([{ kind: 'file', path: 'src/player/queue.ts', line: 42, column: null }]);
	});

	test('a Markdown link that points out of the checkout is dropped', () => {
		expect(refs('[x](../../etc/passwd) [y](/etc/passwd) [z](C:/Windows/system.ini)')).toEqual([]);
	});

	test('a target that climbs out of the checkout in percent-encoding is dropped too', () => {
		expect(refs('[x](src/%2e%2e/%2e%2e/secrets.ts) [y](%2Fetc%2Fpasswd) [z](..%2F..%2Fa.ts)')).toEqual([]);
	});

	test('Enter on a link follows it, as a click does', () => {
		const box = show('`src/a.ts:7`');
		links(box)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		expect(followed).toEqual([{ kind: 'file', path: 'src/a.ts', line: 7, column: null }]);
	});

	test('a link says in its tooltip what a click will do', () => {
		const box = show('`src/a.ts:7` and https://example.com', { commits: true });
		expect(links(box).map((a) => a.title)).toEqual(['Open src/a.ts at line 7', 'Open https://example.com in your browser']);
	});
});

describe('file references', () => {
	test('path:line in backticks opens the file at the line', () => {
		expect(refs('It is in `src/services/auth.ts:42`.')).toEqual([{ kind: 'file', path: 'src/services/auth.ts', line: 42, column: null }]);
	});

	test('line and column, a line range and #L are all read', () => {
		expect(fileRef('src/a.ts:42:7', true, null)).toEqual({ kind: 'file', path: 'src/a.ts', line: 42, column: 7 });
		expect(fileRef('src/a.ts:42-50', true, null)).toEqual({ kind: 'file', path: 'src/a.ts', line: 42, column: null });
		expect(fileRef('src/a.ts#L42', true, null)).toEqual({ kind: 'file', path: 'src/a.ts', line: 42, column: null });
		expect(fileRef('src/a.ts#L42-L50', true, null)).toEqual({ kind: 'file', path: 'src/a.ts', line: 42, column: null });
	});

	test('a path in a folder is a link in prose too, and the full stop after it is not part of it', () => {
		const box = show('The change is in src/player/queue.ts:17.');
		expect(linkTexts(box)).toEqual(['src/player/queue.ts:17']);
		expect(words(box)).toBe('The change is in src/player/queue.ts:17.');
	});

	test('things in prose that only look like files are left alone', () => {
		for (const prose of ['Use Node.js for this, e.g. with and/or without it.', 'It reads self.store.status and object.property.', 'Cloned from github.com/owner/repo.git yesterday.', 'On 10/12/2024 version 1.2.3 shipped over TCP/IP.', 'See example.org/docs/page.html for more.']) {
			expect(refs(prose), prose).toEqual([]);
		}
	});

	test('a bare file name counts in backticks, where the model meant a file', () => {
		expect(refs('`queue.ts` and `package.json` and `Makefile` and `.gitignore`').map((r) => (r.kind === 'file' ? r.path : r))).toEqual(['queue.ts', 'package.json', 'Makefile', '.gitignore']);
	});

	test('a bare name in backticks that is not a file name is not a link', () => {
		expect(refs('`object.property` and `this.items` and `v1.2` and `README`')).toEqual([]);
	});

	test('a bare file name with a line is a link in prose', () => {
		expect(refs('It fails at main.ts:12 every time')).toEqual([{ kind: 'file', path: 'main.ts', line: 12, column: null }]);
	});

	test('an absolute path inside the checkout becomes repository-relative', () => {
		expect(fileRef('/Users/me/proj/src/a.ts:3', true, '/Users/me/proj')).toEqual({ kind: 'file', path: 'src/a.ts', line: 3, column: null });
		expect(fileRef('C:\\Users\\me\\proj\\src\\a.ts:3', true, 'C:\\Users\\me\\proj')).toEqual({ kind: 'file', path: 'src/a.ts', line: 3, column: null });
		expect(fileRef('c:/users/me/proj/src/a.ts', true, 'C:\\Users\\me\\proj')).toEqual({ kind: 'file', path: 'src/a.ts', line: null, column: null });
	});

	test('a path outside the checkout, or one that climbs out of it, is not a link', () => {
		expect(fileRef('/etc/passwd', true, '/Users/me/proj')).toBeNull();
		expect(fileRef('/Users/me/project-two/src/a.ts', true, '/Users/me/proj')).toBeNull();
		expect(fileRef('../secrets/key.pem', true, '/Users/me/proj')).toBeNull();
		expect(fileRef('src/../../a.ts', true, '/Users/me/proj')).toBeNull();
		expect(fileRef('C:\\Windows\\system.ini', true, '/Users/me/proj')).toBeNull();
	});

	test('./ in front of a path is dropped', () => {
		expect(fileRef('./src/a.ts', true, null)?.path).toBe('src/a.ts');
	});

	test('a path with characters no file reference has is refused', () => {
		for (const odd of ['src/a b.ts', 'src/<x>.ts', 'src/a.ts?x=1', 'src/"a".ts', 'src//a.ts']) {
			expect(fileRef(odd, true, null), odd).toBeNull();
		}
	});

	test('line 0 is no line', () => {
		expect(fileRef('src/a.ts:0', true, null)).toEqual({ kind: 'file', path: 'src/a.ts', line: null, column: null });
	});

	test('nothing is a file link where files are off (a task seen from another checkout)', () => {
		const box = show('It is in `src/a.ts:42` and src/b.ts:3 and [here](src/c.ts)', { files: false });
		expect(links(box)).toEqual([]);
		expect(words(box)).toBe('It is in src/a.ts:42 and src/b.ts:3 and here');
	});
});

describe('commit hashes', () => {
	test('are links only in a session about the history', () => {
		expect(refs('Changed in `a1b2c3d`.')).toEqual([]);
		expect(refs('Changed in `a1b2c3d`.', { commits: true })).toEqual([{ kind: 'commit', hash: 'a1b2c3d' }]);
	});

	test('in prose a hash has to look like one: digits and letters, 7 to 40 of them', () => {
		expect(refs('a1b2c3d fixed it, as did 0123456789abcdef0123456789abcdef01234567', { commits: true })).toEqual([
			{ kind: 'commit', hash: 'a1b2c3d' },
			{ kind: 'commit', hash: '0123456789abcdef0123456789abcdef01234567' },
		]);
		expect(refs('In 1234567 cases the facade was defaced, see a1b2c3 and #a1b2c3d and A1B2C3D', { commits: true })).toEqual([]);
	});

	test('a click hands the hash over', () => {
		const box = show('See `a1b2c3d4e5`', { commits: true });
		expect(links(box)[0].title).toBe('Show commit a1b2c3d4e5 in History');
		links(box)[0].click();
		expect(followed).toEqual([{ kind: 'commit', hash: 'a1b2c3d4e5' }]);
	});
});

describe('Markdown', () => {
	test('headings, paragraphs, bold, italic and struck text', () => {
		const box = show('## What changed\n\nThe **queue** now *wraps* and ~~stops~~.');
		const heading = box.querySelector('[role=heading]')!;
		expect(heading.textContent).toBe('What changed');
		expect(heading.getAttribute('aria-level')).toBe('2');
		expect(box.querySelector('strong')?.textContent).toBe('queue');
		expect(box.querySelector('em')?.textContent).toBe('wraps');
		expect(box.querySelector('del')?.textContent).toBe('stops');
	});

	test('snake_case and arithmetic are not emphasis', () => {
		const box = show('Call next_repeat_mode with 2 * 3 * 4');
		expect(box.querySelector('em, strong')).toBeNull();
		expect(words(box)).toBe('Call next_repeat_mode with 2 * 3 * 4');
	});

	test('a numbered list starts where it says, and a nested list sits in its item', () => {
		const box = show('3. three\n4. four\n   - inside four\n5. five');
		const list = box.querySelector('ol')!;
		expect(list.getAttribute('start')).toBe('3');
		expect(list.querySelectorAll(':scope > li').length).toBe(3);
		expect(list.querySelector('li ul li')?.textContent).toBe('inside four');
	});

	test('a table keeps its columns lined up when a row is short or long', () => {
		const box = show('| File | Lines |\n| --- | --- |\n| `src/a.ts` | 10 |\n| only one |\n| x | y | z |');
		const rows = [...box.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
		expect([...box.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['File', 'Lines']);
		expect(rows).toEqual([
			['src/a.ts', '10'],
			['only one', ''],
			['x', 'y'],
		]);
		expect(linkTexts(box)).toEqual(['src/a.ts']);
	});

	test('a fenced block is code with its language named, and nothing in it is a link', () => {
		const box = show('```ts\nimport x from "src/a.ts";\n// https://example.com\n```');
		expect(box.querySelector('pre .lang')?.textContent).toBe('ts');
		expect(box.querySelector('pre code')?.textContent).toBe('import x from "src/a.ts";\n// https://example.com');
		expect(links(box)).toEqual([]);
	});

	test('a fence left open runs to the end instead of swallowing nothing', () => {
		const box = show('Before\n\n```\nstill code\n**not bold**');
		expect(box.querySelector('pre code')?.textContent).toBe('still code\n**not bold**');
		expect(box.querySelector('strong')).toBeNull();
	});

	test('a quote and a rule', () => {
		const box = show('> quoted line\n> second\n\n---\n\nafter');
		expect(box.querySelector('blockquote')?.textContent).toContain('quoted line');
		expect(box.querySelector('hr')).not.toBeNull();
	});

	test('a backslash keeps a mark as the character it is', () => {
		const box = show('\\*not emphasis\\* and \\`not code\\`');
		expect(box.querySelector('em, code')).toBeNull();
		expect(words(box)).toBe('*not emphasis* and `not code`');
	});

	test('Windows line endings read the same', () => {
		const box = show('one\r\n\r\n- a\r\n- b');
		expect(box.querySelectorAll('li').length).toBe(2);
		expect(box.querySelector('p')?.textContent).toBe('one');
	});
});
