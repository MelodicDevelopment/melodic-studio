import { css } from '@melodicdev/core/template';

/** Rows shared by the changes list and the commit file list. Plain text, so it can be interpolated into a css template. */
export const listStyles = `
	.grow {
		flex: 1;
		min-width: 0;
	}
	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 29px;
		padding: 0 10px;
		border-bottom: 1px solid var(--ml-color-border-muted);
	}
	.row:hover {
		background: var(--ms-hover);
	}
	.row.sel {
		background: var(--ms-selected);
		color: var(--ms-selected-fg);
	}
	.path {
		flex: 1;
		min-width: 0;
		display: flex;
		white-space: nowrap;
	}
	.dir {
		flex: 0 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--ml-color-text-muted);
	}
	.row.sel .dir {
		color: inherit;
		opacity: 0.7;
	}
	.file {
		flex: none;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.mark {
		flex: none;
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		border-radius: 4px;
		border: 1px solid currentColor;
		font-size: 12px;
		font-weight: 700;
		line-height: 1;
	}
	.mark.add {
		color: var(--ms-add);
	}
	.mark.del {
		color: var(--ms-del);
	}
	.mark.mod {
		color: var(--ms-mod);
	}
	.mark.ren {
		color: var(--ms-ren);
	}
	.mark.con {
		color: var(--ms-del);
		background: var(--ms-diff-del-bg);
	}
`;

/** The right-click menu, shared with the history list. */
export const ctxStyles = `
	.ctx {
		position: fixed;
		z-index: 50;
		min-width: 200px;
		padding: 5px;
		border: 1px solid var(--ml-color-border);
		border-radius: 8px;
		background: var(--ml-color-surface-raised, var(--ml-color-surface));
		box-shadow: var(--ml-shadow-lg);
	}
	.ctx-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 9px;
		border-radius: 5px;
	}
	.ctx-item:hover {
		background: var(--ms-hover);
	}
	.ctx-sep {
		height: 1px;
		margin: 4px 0;
		background: var(--ml-color-border);
	}
	.ctx-item.danger {
		color: var(--ml-color-danger);
	}
`;

export const changesStyles = () => css`
	:host {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
	}
	${listStyles}
	.head {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		height: 34px;
		padding: 0 6px 0 10px;
		border-bottom: 1px solid var(--ml-color-border);
		color: var(--ml-color-text-secondary);
		font-weight: 500;
	}
	.check {
		flex: none;
		display: inline-flex;
	}
	.icon {
		all: unset;
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 5px;
		color: var(--ml-color-text-muted);
	}
	.icon:hover {
		background: var(--ms-hover);
		color: var(--ml-color-text);
	}
	.banner {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-top: 1px solid var(--ml-color-border);
		background: var(--ml-color-warning-subtle);
		color: var(--ml-color-text);
		font-size: 12px;
	}
	.banner.plain {
		background: transparent;
		color: var(--ml-color-text-secondary);
	}
	.banner .grow {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.icon[disabled] {
		opacity: 0.5;
	}
	.banner a {
		color: var(--ml-color-text-link, var(--ml-color-primary));
		text-decoration: underline;
		cursor: pointer;
	}
	.commit {
		flex: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border-top: 1px solid var(--ml-color-border);
	}
	.commit b {
		font-weight: 700;
		margin-left: 0.25em;
	}
	.undo {
		flex: none;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 8px 10px;
		border-top: 1px solid var(--ml-color-border);
	}
	.undo .k {
		display: block;
		font-size: 11px;
		color: var(--ml-color-text-muted);
	}
	.undo .v {
		display: block;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	${ctxStyles}
`;
