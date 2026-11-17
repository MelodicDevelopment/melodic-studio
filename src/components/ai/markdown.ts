/**
 * A small renderer for the markdown-ish text Claude answers with: headings, paragraphs,
 * lists, inline code, bold, italic and fenced code blocks. Every piece of the answer
 * reaches the page as a text node through `html` bindings; nothing is ever parsed as
 * HTML, so an answer cannot inject markup. Links are shown as text, not made clickable.
 */
import { html } from '@melodicdev/core/template';

export type MdBlock =
	| { kind: 'heading'; level: number; text: string }
	| { kind: 'para'; text: string }
	| { kind: 'list'; ordered: boolean; items: { text: string; depth: number; mark: string }[] }
	| { kind: 'code'; text: string }
	| { kind: 'rule' };

const FENCE = /^\s*(```+|~~~+)/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;

/** Split an answer into blocks. Works on unfinished text too (an open code fence runs to the end). */
export function markdownBlocks(source: string): MdBlock[] {
	const blocks: MdBlock[] = [];
	const lines = source.replace(/\r/g, '').split('\n');
	let para: string[] = [];
	const flush = (): void => {
		if (para.length) {
			blocks.push({ kind: 'para', text: para.join(' ') });
			para = [];
		}
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fence = FENCE.exec(line);
		if (fence) {
			flush();
			const code: string[] = [];
			for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) {
				code.push(lines[i]);
			}
			blocks.push({ kind: 'code', text: code.join('\n') });
			continue;
		}
		const heading = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
		if (heading) {
			flush();
			blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			flush();
			blocks.push({ kind: 'rule' });
			continue;
		}
		const bullet = BULLET.exec(line);
		const numbered = bullet ? null : NUMBERED.exec(line);
		if (bullet || numbered) {
			flush();
			const ordered = !!numbered;
			const indent = (bullet ?? numbered)![1].replace(/\t/g, '  ').length;
			const item = { text: bullet ? bullet[2] : numbered![3], depth: Math.min(3, Math.floor(indent / 2)), mark: numbered ? `${numbered[2]}.` : '•' };
			const last = blocks[blocks.length - 1];
			if (last?.kind === 'list' && (last.ordered === ordered || item.depth > 0)) {
				last.items.push(item);
			} else {
				blocks.push({ kind: 'list', ordered, items: [item] });
			}
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		const last = blocks[blocks.length - 1];
		if (!para.length && last?.kind === 'list' && /^\s+\S/.test(line) && lines[i - 1]?.trim()) {
			// An indented line right under a list item continues it.
			last.items[last.items.length - 1].text += ` ${line.trim()}`;
			continue;
		}
		para.push(line.trim().replace(/^>\s?/, ''));
	}
	flush();
	return blocks;
}

const INLINE = /(`+)([^`]+?)\1|\*\*([^\s*](?:[^*]*?[^\s*])?)\*\*|__([^\s_](?:[^_]*?[^\s_])?)__|\*([^\s*](?:[^*]*?[^\s*])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** Inline markup as a list of text and elements. */
function inline(text: string): unknown[] {
	const out: unknown[] = [];
	let at = 0;
	for (const m of text.matchAll(INLINE)) {
		if (m.index > at) {
			out.push(text.slice(at, m.index));
		}
		if (m[2] !== undefined) {
			out.push(html`<code>${m[2]}</code>`);
		} else if (m[3] !== undefined || m[4] !== undefined) {
			out.push(html`<strong>${inline(m[3] ?? m[4])}</strong>`);
		} else if (m[5] !== undefined) {
			out.push(html`<em>${inline(m[5])}</em>`);
		} else {
			out.push(html`<span class="link" title=${m[7]}>${m[6]}</span>`);
		}
		at = m.index + m[0].length;
	}
	if (at < text.length) {
		out.push(text.slice(at));
	}
	return out;
}

function block(b: MdBlock) {
	switch (b.kind) {
		case 'heading':
			return html`<div class="md-h ${b.level <= 1 ? 'md-h1' : ''}">${inline(b.text)}</div>`;
		case 'para':
			return html`<p>${inline(b.text)}</p>`;
		case 'list':
			return html`<div class="md-list">${b.items.map((it) => html`<div class="md-li md-d${it.depth}"><span class="md-mark">${it.mark}</span><span class="md-item">${inline(it.text)}</span></div>`)}</div>`;
		case 'code':
			return html`<pre><code>${b.text}</code></pre>`;
		default:
			return html`<div class="md-rule"></div>`;
	}
}

export function renderMarkdown(source: string) {
	return html`<div class="md">${markdownBlocks(source).map(block)}</div>`;
}

/** Styles for `renderMarkdown` output. Plain text, to interpolate into a component's css template. */
export const markdownStyles = `
	.md {
		line-height: 1.55;
		overflow-wrap: anywhere;
		user-select: text;
		-webkit-user-select: text;
		cursor: text;
	}
	.md p {
		margin: 0 0 9px;
	}
	.md-h {
		margin: 14px 0 6px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--ml-color-text-muted);
	}
	.md-h:first-child {
		margin-top: 0;
	}
	.md-h1 {
		font-size: 13px;
		color: var(--ml-color-text);
	}
	.md-list {
		margin: 0 0 9px;
	}
	.md-li {
		display: flex;
		gap: 7px;
		margin: 0 0 5px;
	}
	.md-d1 {
		margin-left: 16px;
	}
	.md-d2 {
		margin-left: 32px;
	}
	.md-d3 {
		margin-left: 48px;
	}
	.md-mark {
		flex: none;
		min-width: 9px;
		color: var(--ml-color-text-muted);
	}
	.md-item {
		min-width: 0;
	}
	.md code {
		padding: 1px 4px;
		border-radius: 4px;
		background: var(--ms-hover);
		font-family: var(--ml-font-mono);
		font-size: 0.92em;
	}
	.md pre {
		margin: 0 0 9px;
		padding: 8px 10px;
		overflow-x: auto;
		border: 1px solid var(--ml-color-border-muted);
		border-radius: 6px;
		background: var(--ml-color-background);
		tab-size: 4;
	}
	.md pre code {
		padding: 0;
		background: none;
		font-size: 12px;
		line-height: 1.5;
		white-space: pre;
	}
	.md strong {
		font-weight: 600;
	}
	.md .link {
		text-decoration: underline;
		text-decoration-color: var(--ml-color-border-strong);
	}
	.md-rule {
		height: 1px;
		margin: 10px 0;
		background: var(--ml-color-border);
	}
`;
