import { css } from '@melodicdev/core/template';
import { ctxStyles } from '../changes/changes.styles';

export const toolbarStyles = () => css`
	:host {
		display: block;
		flex: none;
	}
	.bar {
		display: flex;
		align-items: stretch;
		height: 50px;
		background: var(--rm-toolbar-bg);
		color: var(--rm-toolbar-fg);
		border-bottom: 1px solid var(--rm-toolbar-border);
	}
	.bar.mac {
		padding-left: 84px;
	}
	.bar.mac ml-popover:first-of-type .seg {
		border-left: 1px solid var(--rm-toolbar-border);
	}
	ml-popover {
		display: flex;
		--ml-popover-padding-x: 0;
		--ml-popover-padding-y: 0;
		--ml-popover-content-overflow: hidden;
		--ml-popover-radius: 0 0 10px 10px;
	}
	.seg {
		all: unset;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 10px;
		width: 236px;
		height: 49px;
		padding: 0 14px;
		border-right: 1px solid var(--rm-toolbar-border);
		color: var(--rm-toolbar-fg);
		cursor: default;
	}
	.seg:hover:not([disabled]) {
		background: var(--rm-toolbar-hover);
	}
	.seg:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: -2px;
	}
	.seg[disabled] {
		opacity: 0.6;
	}
	.seg > ml-icon:first-child,
	.seg > ml-spinner {
		flex: none;
		color: var(--rm-toolbar-muted);
	}
	.txt {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		line-height: 1.25;
	}
	.k {
		font-size: 11px;
		color: var(--rm-toolbar-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.v {
		font-size: 13px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.count {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 1px 7px;
		border-radius: 999px;
		background: var(--rm-toolbar-hover);
		border: 1px solid var(--rm-toolbar-border);
		font-size: 11px;
		font-weight: 600;
	}
	.spacer {
		flex: 1;
	}
	.tool {
		all: unset;
		display: grid;
		place-items: center;
		width: 48px;
		color: var(--rm-toolbar-muted);
	}
	.tool.wide {
		width: auto;
		height: 49px;
		padding: 0 12px;
		display: flex;
		align-items: center;
		gap: 5px;
	}
	.panel.narrow {
		width: 260px;
	}
	.tool:hover {
		background: var(--rm-toolbar-hover);
		color: var(--rm-toolbar-fg);
	}

	/* ---- dropdown panels ---- */
	.panel {
		width: 340px;
		max-height: min(70vh, 560px);
		display: flex;
		flex-direction: column;
		color: var(--ml-color-text);
	}
	.filter {
		padding: 10px;
		border-bottom: 1px solid var(--ml-color-border);
	}
	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 6px 0;
	}
	.group {
		padding: 8px 14px 4px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ml-color-text-muted);
	}
	.none {
		padding: 18px 14px;
		text-align: center;
		color: var(--ml-color-text-muted);
	}
	.item {
		display: flex;
		align-items: center;
		gap: 9px;
		min-height: 32px;
		padding: 4px 10px 4px 14px;
	}
	.item:hover {
		background: var(--rm-hover);
	}
	.item > ml-icon {
		flex: none;
		color: var(--ml-color-text-muted);
	}
	.item.current {
		font-weight: 600;
	}
	.item.current > ml-icon {
		color: var(--ml-color-primary);
	}
	.name {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.path {
		display: block;
		font-size: 11px;
		font-weight: 400;
		color: var(--ml-color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.when {
		flex: none;
		font-size: 11px;
		font-weight: 400;
		color: var(--ml-color-text-muted);
	}
	.acts {
		display: none;
		flex: none;
		gap: 2px;
	}
	.item:hover .acts {
		display: inline-flex;
	}
	.item:hover .when {
		display: none;
	}
	.acts button {
		all: unset;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 5px;
		color: var(--ml-color-text-muted);
	}
	.acts button:hover {
		background: var(--rm-hover);
		color: var(--ml-color-text);
	}
	.foot {
		padding: 10px;
		border-top: 1px solid var(--ml-color-border);
	}

	/* ---- right-click menu: a popover so it stacks above an open dropdown ---- */
	${ctxStyles}
	.ctx[popover] {
		inset: auto;
		margin: 0;
		overflow: visible;
		color: var(--ml-color-text);
		font-size: 13px;
	}
`;
