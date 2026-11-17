import { css } from '@melodicdev/core/template';

export const hostDialogsStyles = () => css`
	h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
	}
	.dlg {
		display: flex;
		flex-direction: column;
		gap: 12px;
		color: var(--ml-color-text-secondary);
	}
	.dlg p {
		margin: 0;
		line-height: 1.5;
	}
	.dlg b {
		color: var(--ml-color-text);
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.dim {
		color: var(--ml-color-text-muted);
		font-size: 12px;
	}
	.selectable {
		user-select: text;
		-webkit-user-select: text;
	}
	code {
		padding: 1px 5px;
		border-radius: 4px;
		background: var(--ms-hover);
		color: var(--ml-color-text);
		font-family: var(--ml-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
		font-size: 12px;
	}
	.foot {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
	}

	/* ---- the tool is missing, or the work is done ---- */
	.setup {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		padding: 34px 24px;
		text-align: center;
	}
	.setup > ml-icon {
		color: var(--ml-color-text-muted);
	}
	.setup.done > ml-icon {
		color: var(--ms-add);
	}
	.setup p {
		max-width: 520px;
	}
	.link {
		color: var(--ml-color-primary);
		overflow-wrap: anywhere;
	}

	/* ---- issues: list on the left, the chosen one on the right ---- */
	.browse {
		display: flex;
		height: min(60vh, 540px);
		border: 1px solid var(--ml-color-border);
		border-radius: 10px;
		overflow: hidden;
	}
	.side {
		flex: none;
		width: 340px;
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-right: 1px solid var(--ml-color-border);
		background: var(--ms-sidebar-bg);
	}
	.search {
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px;
		border-bottom: 1px solid var(--ml-color-border);
	}
	.search ml-input {
		flex: 1;
		min-width: 0;
	}
	.icon {
		all: unset;
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		color: var(--ml-color-text-muted);
	}
	.icon:hover:not([disabled]) {
		background: var(--ms-hover);
		color: var(--ml-color-text);
	}
	.icon:focus-visible {
		outline: 2px solid var(--ml-color-primary);
	}
	.rows {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
	.none {
		padding: 22px 16px;
		text-align: center;
		color: var(--ml-color-text-muted);
		line-height: 1.5;
	}
	.issue {
		padding: 8px 12px;
		border-bottom: 1px solid var(--ml-color-border-muted);
	}
	.issue:hover {
		background: var(--ms-hover);
	}
	.issue.sel {
		background: var(--ms-selected);
		color: var(--ms-selected-fg);
	}
	.line {
		display: flex;
		gap: 6px;
		color: var(--ml-color-text);
	}
	.sel .line {
		color: inherit;
	}
	.num {
		flex: none;
		color: var(--ml-color-text-muted);
		font-variant-numeric: tabular-nums;
	}
	.sel .num {
		color: inherit;
		opacity: 0.75;
	}
	.title {
		flex: 1;
		min-width: 0;
		font-weight: 500;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.meta {
		display: flex;
		align-items: center;
		gap: 5px;
		margin-top: 4px;
		font-size: 11px;
		color: var(--ml-color-text-muted);
		white-space: nowrap;
		overflow: hidden;
	}
	.sel .meta {
		color: inherit;
		opacity: 0.8;
	}
	.label {
		flex: none;
		max-width: 110px;
		padding: 0 7px;
		border: 1px solid var(--ml-color-border);
		border-radius: 999px;
		font-size: 11px;
		line-height: 17px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sel .label {
		border-color: currentColor;
	}
	.detail {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 16px 18px;
		overflow-y: auto;
		background: var(--ml-color-surface);
	}
	.detail.form {
		gap: 12px;
	}
	h4 {
		margin: 0;
		font-size: 15px;
		font-weight: 600;
		line-height: 1.35;
		color: var(--ml-color-text);
		overflow-wrap: anywhere;
	}
	.facts {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 12px;
		font-size: 12px;
		color: var(--ml-color-text-muted);
	}
	.facts span {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.labels {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}
	.labels .label {
		max-width: 220px;
	}
	.body {
		padding-top: 10px;
		border-top: 1px solid var(--ml-color-border);
		color: var(--ml-color-text);
		font-size: 13px;
		line-height: 1.55;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.body.none {
		color: var(--ml-color-text-muted);
		text-align: left;
		padding: 10px 0 0;
	}

	/* ---- pull request ---- */
	.route {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.route > ml-icon {
		flex: none;
		color: var(--ml-color-text-muted);
	}
	.route ml-select {
		width: 220px;
	}
	.branch {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 260px;
		padding: 5px 10px;
		border: 1px solid var(--ml-color-border);
		border-radius: 8px;
		color: var(--ml-color-text);
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.note {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 9px 11px;
		border-radius: 8px;
		background: var(--ms-hover);
		color: var(--ml-color-text);
	}
	.note > span {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.note > ml-icon {
		flex: none;
		margin-top: 2px;
		color: var(--ml-color-text-muted);
	}
	.note > ml-button {
		flex: none;
	}
	.note.warn {
		background: var(--ml-color-warning-subtle);
	}
	.note.warn > ml-icon {
		color: var(--ml-color-warning);
	}
	.note.bad {
		background: var(--ml-color-danger-subtle, var(--ml-color-warning-subtle));
	}
	.note.bad > ml-icon {
		color: var(--ms-del);
	}
	.under {
		display: flex;
		align-items: center;
		gap: 10px;
	}
`;
