import { MelodicComponent } from '@melodicdev/core/components';
import { html, css } from '@melodicdev/core/template';
import type { ParsedDiff, DiffLine } from '../../shared/diff';

const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '−', ctx: '', hunk: '', note: '' };

function message(icon: string, text: string) {
	return html`<div class="state"><ml-icon icon=${icon} size="lg"></ml-icon><div>${text}</div></div>`;
}

/** Renders one parsed unified diff. `.diff` is null while it loads. */
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
		return html`
			<div class="scroll">
				<div class="rows">
					${d.lines.map((l) =>
						l.kind === 'hunk'
							? html`<div class="row hunk"><span class="no"></span><span class="no"></span><span class="sign"></span><span class="code">${l.text}</span></div>`
							: html`<div class="row ${l.kind}"><span class="no">${l.oldNo ?? ''}</span><span class="no">${l.newNo ?? ''}</span><span class="sign">${SIGN[l.kind]}</span><span class="code">${l.text}</span></div>`
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
			font-family: var(--ml-font-mono);
			font-size: 12px;
			line-height: 20px;
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
	`,
})
export class DiffViewComponent {
	diff: ParsedDiff | null = null;
	emptyText = 'No content changes.';
}
