/**
 * What an agent wrote, rendered readably: paragraphs, headings, lists, quotes,
 * tables, inline code and code blocks. The Markdown is parsed here into a small
 * tree and rendered through Melodic templates, so nothing the model wrote is
 * ever treated as HTML. The only links are the ones made here: file references
 * (`src/a.ts:42`), commit hashes and http(s) addresses.
 */
import { html } from '@melodicdev/core/template';
import { repoRelative } from '../../services/agent-paths';
import type { AgentRef } from '../../services/agents.store';

export type Ref = AgentRef;

export type Inline =
	| { t: 'text'; text: string }
	| { t: 'br' }
	| { t: 'code'; text: string; ref: Ref | null }
	| { t: 'strong' | 'em' | 'del'; children: Inline[] }
	| { t: 'link'; ref: Ref; children: Inline[] };

export type Block =
	| { t: 'p'; inline: Inline[] }
	| { t: 'h'; level: number; inline: Inline[] }
	| { t: 'code'; lang: string; text: string }
	| { t: 'list'; ordered: boolean; start: number; items: Block[][] }
	| { t: 'quote'; blocks: Block[] }
	| { t: 'table'; head: Inline[][]; rows: Inline[][][] }
	| { t: 'rule' };

export interface RichOptions {
	/** Turn file references into links. */
	files: boolean;
	/** Turn commit hashes into links. */
	commits: boolean;
	/** The checkout the text is about, so absolute paths inside it can be made relative. */
	root: string | null;
}

/** What a click on each kind of link does. */
export type RefHandler = (ref: Ref) => void;

// ---- references -------------------------------------------------------------

/** Extensions that make a bare `name.ext` (no folder, no line) believable as a file rather than `object.property`. */
const EXTENSIONS = new Set(
	'ts tsx mts cts js jsx mjs cjs json jsonc json5 md mdx txt rs toml lock yml yaml xml html htm css scss sass less vue svelte astro py pyi rb go java kt kts swift c h cc cpp cxx hpp hh cs fs php pl lua sh bash zsh fish ps1 bat cmd sql graphql gql proto ini cfg conf env gradle properties plist tf hcl ex exs erl hs ml clj scala dart r jl zig nim tex csv svg ipynb'.split(' ')
);
const BARE_NAMES = new Set(['Makefile', 'Dockerfile', 'LICENSE', 'Gemfile', 'Rakefile', 'Procfile', 'Justfile', 'Jenkinsfile']);
const SEGMENT = /^[\w@.+~$()[\]-]+$/;

/**
 * Read `src/a.ts`, `src/a.ts:42`, `src/a.ts:42:7`, `src/a.ts:42-50` or `src/a.ts#L42` as a file
 * reference. Strict on purpose: prose is full of things with dots and slashes (`e.g.`, `and/or`,
 * `Node.js`, `self.store.status`), and a link that opens nothing is worse than no link.
 * `inCode` is true for text the model put in backticks, where a bare file name is believable.
 */
export function fileRef(raw: string, inCode: boolean, root: string | null): Extract<Ref, { kind: 'file' }> | null {
	let text = raw.trim();
	let line: number | null = null;
	let column: number | null = null;
	const at = /^(.+?)(?::(\d+)(?::(\d+)|-\d+)?|#L(\d+)(?:-L?\d+)?)$/.exec(text);
	if (at) {
		text = at[1];
		line = Number(at[2] ?? at[4]);
		column = at[3] ? Number(at[3]) : null;
	}
	const path = repoRelative(text, root);
	if (!path || path.length > 400) {
		return null;
	}
	const segments = path.split('/');
	if (!segments.every((s) => SEGMENT.test(s) && s !== '.')) {
		return null;
	}
	const name = segments[segments.length - 1];
	const inFolder = segments.length > 1;
	const ext = /\.([A-Za-z][A-Za-z0-9]{0,9})$/.exec(name)?.[1].toLowerCase() ?? null;
	const known = (!!ext && EXTENSIONS.has(ext)) || BARE_NAMES.has(name);
	const dotfile = /^\.[A-Za-z][\w.-]*$/.test(name);
	// In a folder: a name with an extension, or any name with a line. Bare: a file name people would recognise.
	const ok = inFolder ? !!ext || known || (line !== null && /[A-Za-z]/.test(name)) : known || (inCode && dotfile);
	// In prose a bare `Node.js` is a product and `github.com/owner/repo.git` is an address.
	const proseTrap = !inCode && ((!inFolder && line === null) || /\.(com|org|net|io|dev|ai|app|co)$/i.test(segments[0]));
	if (!ok || proseTrap) {
		return null;
	}
	return { kind: 'file', path, line: line && line > 0 ? line : null, column };
}

function commitRef(text: string, inCode: boolean): Ref | null {
	if (!/^[0-9a-f]{7,40}$/.test(text)) {
		return null;
	}
	// In prose a run of hex digits has to look like a hash, not a number or a word.
	return inCode || (/\d/.test(text) && /[a-f]/.test(text)) ? { kind: 'commit', hash: text } : null;
}

function urlRef(text: string): Ref | null {
	return /^https?:\/\/[^\s<>"'`]+$/i.test(text) ? { kind: 'url', url: text } : null;
}

// ---- inline -----------------------------------------------------------------

/** Plain prose: find the web addresses, file references and commit hashes in it. */
function prose(text: string, o: RichOptions): Inline[] {
	const out: Inline[] = [];
	let from = 0;
	const push = (to: number): void => {
		if (to > from) {
			out.push({ t: 'text', text: text.slice(from, to) });
		}
	};
	// A web address runs to the next space; anything else is cut at brackets and punctuation first.
	const word = /(https?:\/\/[^\s<>"'`]+)|[^\s<>"'`()[\]{},;=|]+/gi;
	for (let m = word.exec(text); m; m = word.exec(text)) {
		// "see src/a.ts:42." ends a sentence, not the reference.
		const token = m[0].replace(m[1] ? /[.,;:!?)\]]+$/ : /[.:!?]+$/, '');
		if (token.length < 3) {
			continue;
		}
		const start = m.index;
		const ref = m[1] ? urlRef(token) : ((o.files ? fileRef(token, false, o.root) : null) ?? (o.commits && text[start - 1] !== '#' ? commitRef(token, false) : null));
		if (ref) {
			push(start);
			out.push({ t: 'link', ref, children: [{ t: 'text', text: token }] });
			from = start + token.length;
		}
	}
	push(text.length);
	return out;
}

const WORD = /[A-Za-z0-9]/;

/** Where the emphasis opened with `mark` closes, or -1. `**` does not close `*`, and `snake_case` closes nothing. */
function closer(text: string, from: number, mark: string): number {
	const ch = mark[0];
	for (let j = text.indexOf(ch, from); j >= 0; j = text.indexOf(ch, j)) {
		let run = 1;
		while (text[j + run] === ch) {
			run++;
		}
		const fits = mark.length === 2 ? run >= 2 : run === 1 || run === 3;
		const at = j + run - mark.length;
		if (fits && !/\s/.test(text[j - 1]) && !(ch === '_' && WORD.test(text[j + run] ?? ' '))) {
			return at;
		}
		j += run;
	}
	return -1;
}

export function parseInline(text: string, o: RichOptions): Inline[] {
	const out: Inline[] = [];
	let buf = '';
	const flush = (): void => {
		if (buf) {
			out.push(...prose(buf, o));
			buf = '';
		}
	};
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const rest = text.slice(i);
		if (ch === '\\' && /[\\`*_{}[\]()#+\-.!|>~]/.test(text[i + 1] ?? '')) {
			buf += text[i + 1];
			i += 2;
			continue;
		}
		if (ch === '\n') {
			flush();
			out.push({ t: 'br' });
			i++;
			continue;
		}
		if (ch === '`') {
			const ticks = /^`+/.exec(rest)![0];
			// The closing run has to be exactly as long as the opening one.
			let end = -1;
			for (let j = i + ticks.length; j < text.length; j++) {
				if (text[j] === '`') {
					const run = /^`+/.exec(text.slice(j))![0];
					if (run.length === ticks.length) {
						end = j;
						break;
					}
					j += run.length - 1;
				}
			}
			if (end > 0) {
				const code = text.slice(i + ticks.length, end).replace(/\n/g, ' ').replace(/^ (.*) $/, '$1');
				flush();
				out.push({ t: 'code', text: code, ref: (o.files ? fileRef(code, true, o.root) : null) ?? (o.commits ? commitRef(code, true) : null) });
				i = end + ticks.length;
				continue;
			}
		}
		if (ch === '*' || ch === '_' || (ch === '~' && rest.startsWith('~~'))) {
			const mark = ch === '~' ? '~~' : rest.startsWith(ch + ch) ? ch + ch : ch;
			const before = text[i - 1] ?? ' ';
			// `snake_case` and `2 * 3` are not emphasis.
			const opens = !/\s/.test(text[i + mark.length] ?? ' ') && (ch !== '_' || !WORD.test(before));
			const end = opens ? closer(text, i + mark.length + 1, mark) : -1;
			if (end > 0 && !text.slice(i + mark.length, end).includes('\n\n')) {
				flush();
				out.push({ t: mark === '~~' ? 'del' : mark.length === 2 ? 'strong' : 'em', children: parseInline(text.slice(i + mark.length, end), o) });
				i = end + mark.length;
				continue;
			}
		}
		if (ch === '[') {
			const link = /^\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
			if (link) {
				const ref = urlRef(link[2]) ?? (o.files ? fileRef(decode(link[2]), true, o.root) : null);
				flush();
				// The label is the model's; where it goes is decided here. A target that is neither a web address nor a file is dropped.
				const label = parseInline(link[1], { ...o, files: false, commits: false });
				if (ref) {
					out.push({ t: 'link', ref, children: label });
				} else {
					out.push(...label);
				}
				i += link[0].length;
				continue;
			}
		}
		if (ch === '<') {
			const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(rest);
			if (auto) {
				flush();
				out.push({ t: 'link', ref: { kind: 'url', url: auto[1] }, children: [{ t: 'text', text: auto[1] }] });
				i += auto[0].length;
				continue;
			}
		}
		buf += ch;
		i++;
	}
	flush();
	return out;
}

function decode(target: string): string {
	try {
		return decodeURIComponent(target);
	} catch {
		return target;
	}
}

// ---- blocks -----------------------------------------------------------------

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Columns of leading whitespace, a tab counting as four. */
function indentOf(line: string): number {
	let n = 0;
	for (const ch of line) {
		if (ch === ' ') {
			n++;
		} else if (ch === '\t') {
			n += 4;
		} else {
			break;
		}
	}
	return n;
}

/** Drop up to `columns` of leading whitespace. */
function dedent(line: string, columns: number): string {
	let n = 0;
	let i = 0;
	while (i < line.length && n < columns && (line[i] === ' ' || line[i] === '\t')) {
		n += line[i] === '\t' ? 4 : 1;
		i++;
	}
	return line.slice(i);
}

/** The cells of one table row. A `|` inside backticks or after a backslash is not a column break. */
function cells(row: string): string[] {
	const out: string[] = [];
	let cell = '';
	let code = false;
	const text = row.trim().replace(/^\|/, '');
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '\\' && text[i + 1] === '|') {
			cell += '|';
			i++;
		} else if (ch === '|' && !code) {
			out.push(cell.trim());
			cell = '';
		} else {
			code = ch === '`' ? !code : code;
			cell += ch;
		}
	}
	if (cell.trim()) {
		out.push(cell.trim());
	}
	return out;
}

function startsBlock(lines: string[], i: number): boolean {
	const line = lines[i];
	return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-'));
}

export function parseBlocks(lines: string[], o: RichOptions): Block[] {
	const out: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			const close = new RegExp(`^\\s{0,3}\\${fence[1][0]}{${fence[1].length},}\\s*$`);
			const indent = indentOf(line);
			const body: string[] = [];
			i++;
			while (i < lines.length && !close.test(lines[i])) {
				body.push(dedent(lines[i++], indent));
			}
			i++;
			out.push({ t: 'code', lang: fence[2], text: body.join('\n') });
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			out.push({ t: 'h', level: heading[1].length, inline: parseInline(heading[2], o) });
			i++;
			continue;
		}
		if (RULE.test(line)) {
			out.push({ t: 'rule' });
			i++;
			continue;
		}
		if (QUOTE.test(line)) {
			const body: string[] = [];
			for (let q = QUOTE.exec(lines[i] ?? ''); q; q = QUOTE.exec(lines[i] ?? '')) {
				body.push(q[1]);
				i++;
			}
			out.push({ t: 'quote', blocks: parseBlocks(body, o) });
			continue;
		}
		if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '') && lines[i + 1].includes('-')) {
			const head = cells(line).map((c) => parseInline(c, o));
			const rows: Inline[][][] = [];
			i += 2;
			while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
				const row = cells(lines[i++]).map((c) => parseInline(c, o));
				// Short rows are padded and long ones cut, so the columns stay lined up.
				rows.push(head.map((_, n) => row[n] ?? []));
			}
			out.push({ t: 'table', head, rows });
			continue;
		}
		const first = ITEM.exec(line);
		if (first) {
			const base = indentOf(line);
			const ordered = /\d/.test(first[2]);
			const items: Block[][] = [];
			while (i < lines.length) {
				const item = ITEM.exec(lines[i]);
				if (!item || indentOf(lines[i]) > base + 1 || /\d/.test(item[2]) !== ordered) {
					break;
				}
				// Everything indented past the marker belongs to this item, as do lines that simply run on.
				const content = base + item[2].length + 1;
				const body = [item[3]];
				i++;
				while (i < lines.length) {
					const next = lines[i];
					if (!next.trim()) {
						// A blank line stays in the item only if indented text follows it.
						let j = i;
						while (j < lines.length && !lines[j].trim()) {
							j++;
						}
						if (j < lines.length && indentOf(lines[j]) > base + 1) {
							body.push('');
							i++;
							continue;
						}
						break;
					}
					if (indentOf(next) > base + 1) {
						body.push(dedent(next, content));
					} else if (!startsBlock(lines, i) && body[body.length - 1] !== '') {
						body.push(next.trim());
					} else {
						break;
					}
					i++;
				}
				items.push(parseBlocks(body, o));
				while (i < lines.length && !lines[i].trim() && ITEM.test(lines[i + 1] ?? '') && indentOf(lines[i + 1]) <= base + 1) {
					i++; // a loose list: blank lines between its items
				}
			}
			out.push({ t: 'list', ordered, start: ordered ? Number(/\d+/.exec(first[2])![0]) : 1, items });
			continue;
		}
		const text = [line.trim()];
		i++;
		while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
			text.push(lines[i++].trim());
		}
		out.push({ t: 'p', inline: parseInline(text.join('\n'), o) });
	}
	return out;
}

const CACHE = new Map<string, Block[]>();
const CACHE_SIZE = 400;

/** Parse once per distinct text: a transcript re-renders on every event, and its old messages do not change. */
export function parse(text: string, o: RichOptions): Block[] {
	const key = `${o.files ? 'f' : ''}${o.commits ? 'c' : ''}\n${o.root ?? ''}\n${text}`;
	let blocks = CACHE.get(key);
	if (!blocks) {
		blocks = parseBlocks(text.replace(/\r\n?/g, '\n').split('\n'), o);
		if (CACHE.size >= CACHE_SIZE) {
			CACHE.delete(CACHE.keys().next().value as string);
		}
		CACHE.set(key, blocks);
	}
	return blocks;
}

// ---- rendering --------------------------------------------------------------

function refTitle(ref: Ref): string {
	switch (ref.kind) {
		case 'file':
			return ref.line ? `Open ${ref.path} at line ${ref.line}` : `Open ${ref.path}`;
		case 'commit':
			return `Show commit ${ref.hash.slice(0, 10)} in History`;
		default:
			return `Open ${ref.url} in your browser`;
	}
}

function anchor(ref: Ref, on: RefHandler, content: unknown) {
	const go = (e: Event): void => {
		e.preventDefault();
		on(ref);
	};
	const key = (e: KeyboardEvent): void => {
		if (e.key === 'Enter') {
			go(e);
		}
	};
	return html`<a class="ref ${ref.kind}" role="link" tabindex="0" title=${refTitle(ref)} @click=${go} @keydown=${key}>${content}</a>`;
}

/** A flat list of strings and templates, which is what a template slot takes. */
function inline(nodes: Inline[], on: RefHandler): unknown[] {
	return nodes.map((n) => {
		switch (n.t) {
			case 'text':
				return n.text;
			case 'br':
				return html`<br />`;
			case 'code':
				return n.ref ? anchor(n.ref, on, html`<code>${n.text}</code>`) : html`<code>${n.text}</code>`;
			case 'strong':
				return html`<strong>${inline(n.children, on)}</strong>`;
			case 'em':
				return html`<em>${inline(n.children, on)}</em>`;
			case 'del':
				return html`<del>${inline(n.children, on)}</del>`;
			default:
				return anchor(n.ref, on, html`<span>${inline(n.children, on)}</span>`);
		}
	});
}

function item(blocks: Block[], on: RefHandler) {
	// The usual case, one line of text, needs no paragraph inside the bullet.
	const [first, ...rest] = blocks;
	if (first?.t === 'p') {
		return html`<li>${inline(first.inline, on)}${rest.length ? html`${rest.map((b) => block(b, on))}` : ''}</li>`;
	}
	return html`<li>${blocks.map((b) => block(b, on))}</li>`;
}

function block(b: Block, on: RefHandler): unknown {
	switch (b.t) {
		case 'p':
			return html`<p>${inline(b.inline, on)}</p>`;
		case 'h':
			return html`<div class="h h${Math.min(b.level, 4)}" role="heading" aria-level=${String(b.level)}>${inline(b.inline, on)}</div>`;
		case 'code':
			return html`<pre>${b.lang ? html`<span class="lang">${b.lang}</span>` : ''}<code>${b.text}</code></pre>`;
		case 'list': {
			const items = b.items.map((blocks) => item(blocks, on));
			return b.ordered ? html`<ol start=${String(b.start)}>${items}</ol>` : html`<ul>${items}</ul>`;
		}
		case 'quote':
			return html`<blockquote>${b.blocks.map((x) => block(x, on))}</blockquote>`;
		case 'table':
			return html`
				<div class="tablewrap">
					<table>
						<thead>
							<tr>${b.head.map((c) => html`<th>${inline(c, on)}</th>`)}</tr>
						</thead>
						<tbody>
							${b.rows.map((r) => html`<tr>${r.map((c) => html`<td>${inline(c, on)}</td>`)}</tr>`)}
						</tbody>
					</table>
				</div>
			`;
		default:
			return html`<hr />`;
	}
}

/** Render an agent's message. `on` is called when one of the links made here is clicked. */
export function richText(text: string, options: RichOptions, on: RefHandler) {
	return html`<div class="rich">${parse(text, options).map((b) => block(b, on))}</div>`;
}

/** Plain text, to interpolate into a component's css template (as `listStyles` is). */
export const richTextStyles = `
	.rich {
		line-height: 1.55;
		overflow-wrap: anywhere;
	}
	.rich > :first-child {
		margin-top: 0;
	}
	.rich > :last-child {
		margin-bottom: 0;
	}
	.rich p {
		margin: 0 0 9px;
	}
	.rich .h {
		margin: 16px 0 6px;
		font-weight: 600;
	}
	.rich .h1 {
		font-size: 17px;
	}
	.rich .h2 {
		font-size: 15px;
	}
	.rich ul,
	.rich ol {
		margin: 0 0 9px;
		padding-left: 22px;
	}
	.rich li {
		margin: 3px 0;
	}
	.rich li > ul,
	.rich li > ol,
	.rich li > p,
	.rich li > pre {
		margin: 4px 0 0;
	}
	.rich code {
		padding: 1px 5px;
		border-radius: 4px;
		background: var(--ms-hover);
		font-family: var(--ml-font-mono);
		font-size: 12px;
	}
	.rich pre {
		position: relative;
		margin: 0 0 9px;
		padding: 10px 12px;
		border: 1px solid var(--ml-color-border);
		border-radius: 8px;
		background: var(--ms-sidebar-bg);
		overflow-x: auto;
		white-space: pre;
		tab-size: 4;
		line-height: 1.5;
	}
	.rich pre code {
		padding: 0;
		background: none;
	}
	.rich .lang {
		position: absolute;
		top: 4px;
		right: 8px;
		font-size: 10px;
		color: var(--ml-color-text-muted);
		user-select: none;
		-webkit-user-select: none;
	}
	.rich blockquote {
		margin: 0 0 9px;
		padding: 1px 0 1px 12px;
		border-left: 3px solid var(--ml-color-border-strong, var(--ml-color-border));
		color: var(--ml-color-text-secondary);
	}
	.rich .tablewrap {
		margin: 0 0 9px;
		overflow-x: auto;
	}
	.rich table {
		border-collapse: collapse;
	}
	.rich th,
	.rich td {
		padding: 4px 10px;
		border: 1px solid var(--ml-color-border);
		text-align: left;
		vertical-align: top;
		overflow-wrap: normal;
	}
	.rich th {
		background: var(--ms-hover);
		font-weight: 600;
	}
	.rich hr {
		margin: 12px 0;
		border: 0;
		border-top: 1px solid var(--ml-color-border);
	}
	.rich a.ref {
		color: var(--ml-color-primary);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}
	.rich a.ref code {
		color: inherit;
	}
	.rich a.ref:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: 1px;
		border-radius: 3px;
	}
`;
