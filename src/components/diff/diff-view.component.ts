import { MelodicComponent } from '@melodicdev/core/components';
import { html, css } from '@melodicdev/core/template';
import type { ParsedDiff, DiffLine, DiffNote } from '../../shared/diff';

const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '−', ctx: '', hunk: '', note: '' };

function message(icon: string, text: string) {
	return html`<div class="state"><ml-icon icon=${icon} size="lg"></ml-icon><div>${text}</div></div>`;
}

/** A note in place: under its line, or above the diff when its line is not shown. */
function noteRow(n: DiffNote, focus: number | null) {
	return html`
		<div class="fnote ${n.tone} ${n.line !== null && n.line === focus ? 'focus' : ''}" data-line=${n.line ?? ''}>
			<div><span class="sev">${n.label}</span><b>${n.title}</b>${n.line !== null ? html`<span class="at">line ${n.line}</span>` : ''}</div>
			${n.detail ? html`<p>${n.detail}</p>` : ''}
			${n.action ? html`<div class="act"><ml-button variant="outline" size="xs" title=${n.action.title} ?disabled=${n.action.disabled} @ml:click=${n.action.run}><ml-icon slot="icon-start" icon="sparkle" size="sm"></ml-icon>${n.action.label}</ml-button></div>` : ''}
		</div>
	`;
}

/** Renders one parsed unified diff. `.diff` is null while it loads. `.notes` are shown under the new-file lines they name. */
@MelodicComponent({
	selector: 'ms-diff',
	template: (self: DiffViewComponent) => {
		const d = self.diff;
		if (!d) {
			return html`<div class="state"><ml-spinner size="md"></ml-spinner></div>`;
		}
		if (d.tooLarge) {
			return message('file-dashed', 'This diff is too large to show here.');
		}
		if (d.binary) {
			return message('file-image', 'Binary file. There is no text diff to show.');
		}
		if (!d.lines.length) {
			return message('file', self.emptyText);
		}
		const shown = new Set(d.lines.map((l) => l.newNo));
		const notesAt = (no: number | null) => (no === null || !self.notes.length ? [] : self.notes.filter((n) => n.line === no));
		return html`
			<div class="scroll">
				<div class="rows">
					${self.notes.filter((n) => n.line === null || !shown.has(n.line)).map((n) => noteRow(n, self.focusLine))}
					${d.lines.map((l) =>
						l.kind === 'hunk'
							? html`<div class="row hunk"><span class="no"></span><span class="no"></span><span class="sign"></span><span class="code">${l.text}</span></div>`
							: html`<div class="row ${l.kind}"><span class="no">${l.oldNo ?? ''}</span><span class="no">${l.newNo ?? ''}</span><span class="sign">${SIGN[l.kind]}</span><span class="code">${l.text}</span></div>${notesAt(l.newNo).map((n) => noteRow(n, self.focusLine))}`
					)}
					${d.truncated ? html`<div class="row note"><span class="no"></span><span class="no"></span><span class="sign"></span><span class="code">Diff truncated. Open the file in your editor to see the rest.</span></div>` : ''}
				</div>
			</div>
		`;
	},
	styles: () => css`
		:host {
			display: block;
			height: 100%;
			min-height: 0;
			background: var(--ml-color-surface);
		}
		.state {
			height: 100%;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 10px;
			color: var(--ml-color-text-muted);
		}
		.scroll {
			height: 100%;
			overflow: auto;
		}
		.rows {
			display: inline-block;
			min-width: 100%;
			padding-bottom: 24px;
			font-family: var(--ms-code-font, var(--ml-font-mono));
			font-size: var(--ms-code-size, 12px);
			line-height: var(--ms-code-line, 20px);
		}
		.row {
			display: flex;
			white-space: pre;
			tab-size: 4;
		}
		.no {
			flex: none;
			width: 46px;
			padding: 0 8px;
			text-align: right;
			color: var(--ms-diff-gutter-fg);
			border-right: 1px solid var(--ml-color-border-muted);
		}
		.sign {
			flex: none;
			width: 22px;
			text-align: center;
			color: var(--ml-color-text-muted);
		}
		.code {
			flex: 1;
			padding-right: 24px;
			user-select: text;
			-webkit-user-select: text;
			cursor: text;
		}
		.add {
			background: var(--ms-diff-add-bg);
		}
		.add .no {
			background: var(--ms-diff-add-gutter);
			border-right-color: transparent;
		}
		.add .sign {
			color: var(--ms-add);
		}
		.del {
			background: var(--ms-diff-del-bg);
		}
		.del .no {
			background: var(--ms-diff-del-gutter);
			border-right-color: transparent;
		}
		.del .sign {
			color: var(--ms-del);
		}
		.hunk {
			background: var(--ms-diff-hunk-bg);
			color: var(--ms-diff-hunk-fg);
		}
		.hunk .no {
			border-right-color: transparent;
		}
		.note {
			color: var(--ml-color-text-muted);
			font-style: italic;
		}
		/* ---- notes (review findings) ---- */
		.scroll {
			container-type: inline-size;
		}
		.fnote {
			position: sticky;
			left: 0;
			box-sizing: border-box;
			width: 620px;
			width: min(calc(100cqw - 24px), 760px);
			margin: 6px 12px 8px;
			padding: 9px 14px 10px;
			border: 1px solid var(--ms-ai-border);
			border-radius: 10px;
			background: var(--ml-color-surface-raised);
			font-family: var(--ml-font-sans);
			font-size: 12.5px;
			line-height: 1.45;
			white-space: normal;
			user-select: text;
			-webkit-user-select: text;
		}
		.fnote.bug {
			border-color: color-mix(in srgb, var(--ms-del) 55%, transparent);
		}
		.fnote.risk {
			border-color: color-mix(in srgb, var(--ms-mod) 55%, transparent);
		}
		.fnote.focus {
			background: var(--ms-ai-subtle);
		}
		.fnote .sev {
			margin-right: 8px;
			font-size: 10px;
			font-weight: 700;
			letter-spacing: 0.05em;
			text-transform: uppercase;
			color: var(--ms-ai);
		}
		.fnote.bug .sev {
			color: var(--ms-del);
		}
		.fnote.risk .sev {
			color: var(--ms-mod);
		}
		.fnote b {
			font-weight: 600;
		}
		.fnote .at {
			margin-left: 8px;
			color: var(--ml-color-text-muted);
			font-size: 11px;
		}
		.fnote p {
			margin: 3px 0 0;
			color: var(--ml-color-text-secondary);
		}
		.fnote .act {
			display: flex;
			margin-top: 8px;
		}
	`,
})
export class DiffViewComponent {
	diff: ParsedDiff | null = null;
	emptyText = 'No content changes.';
	/** Remarks to show inside the diff, keyed by new-file line number. */
	notes: DiffNote[] = [];
	/** The note line to bring into view (once, each time it or the diff changes). */
	focusLine: number | null = null;
	elementRef!: HTMLElement;
	private _focused = '';

	onRender(): void {
		const key = this.diff && this.focusLine !== null ? `${this.focusLine}:${this.diff.raw.length}` : '';
		if (key !== this._focused) {
			// The note may be set a render after the diff: only count the scroll as done once it is there.
			const note = key ? this.elementRef.shadowRoot?.querySelector(`.fnote[data-line="${this.focusLine}"]`) : null;
			if (note || !key) {
				this._focused = key;
				note?.scrollIntoView({ block: 'center' });
			}
		}
	}
}
