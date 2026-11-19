import { css } from '@melodicdev/core/template';
import { ctxStyles } from '../changes/changes.styles';

export const toolbarStyles = () => css`
	:host {
		display: block;
		flex: none;
	}
	.bar {
		position: relative;
		display: flex;
		align-items: center;
		gap: 6px;
		height: 56px;
		padding: 0 10px;
		background: var(--ms-toolbar-bg);
		color: var(--ms-toolbar-fg);
	}
	.bar.mac {
		padding-left: 84px;
	}
	/* The signal line: the brand gradient under the toolbar. It flows while git is busy (a spinner shows). */
	.bar::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 2px;
		background: var(--ms-signal);
		background-size: 200% 100%;
		pointer-events: none;
	}
	.bar:has(ml-spinner)::after {
		animation: ms-signal 2.4s linear infinite;
	}
	@keyframes ms-signal {
		from {
			background-position: 0% 50%;
		}
		to {
			background-position: 200% 50%;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bar:has(ml-spinner)::after {
			animation: none;
		}
	}
	ml-popover {
		display: flex;
		--ml-popover-padding-x: 0;
		--ml-popover-padding-y: 0;
		--ml-popover-content-overflow: hidden;
		--ml-popover-radius: 12px;
	}
	.seg {
		all: unset;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 9px;
		min-width: 150px;
		max-width: 280px;
		height: 38px;
		padding: 0 12px;
		border: 1px solid var(--ms-toolbar-border);
		border-radius: 10px;
		background: var(--ms-toolbar-raised);
		color: var(--ms-toolbar-fg);
		cursor: default;
		transition: background-color 0.12s, border-color 0.12s;
	}
	.seg:hover:not([disabled]) {
		background: var(--ms-toolbar-hover);
	}
	/* Repository and branch read as names, not as labelled fields. */
	.seg:not(.sync) .k {
		display: none;
	}
	#repo-pop .v {
		font-family: var(--ms-font-display);
		font-size: 15px;
		letter-spacing: -0.01em;
	}
	#branch-pop .v {
		font-family: var(--ml-font-mono);
		font-size: 12.5px;
		font-weight: 500;
	}
	#branch-pop .seg > ml-icon:first-child {
		color: var(--ms-run);
	}
	/* Something to send or bring in: the sync button becomes the toolbar's one magenta action. */
	.seg.sync:has(> ml-icon[icon='arrow-up'], > ml-icon[icon='arrow-down'], > ml-icon[icon='cloud-arrow-up']) {
		background: var(--ms-you);
		border-color: transparent;
		color: #ffffff;
	}
	.seg.sync:has(> ml-icon[icon='arrow-up'], > ml-icon[icon='arrow-down'], > ml-icon[icon='cloud-arrow-up']):hover:not([disabled]) {
		background: var(--ml-color-primary-hover);
	}
	.seg.sync:has(> ml-icon[icon='arrow-up'], > ml-icon[icon='arrow-down'], > ml-icon[icon='cloud-arrow-up']) :is(.k, ml-icon) {
		color: rgba(255, 255, 255, 0.82);
	}
	.seg.sync:has(> ml-icon[icon='arrow-up'], > ml-icon[icon='arrow-down'], > ml-icon[icon='cloud-arrow-up']) .count {
		background: rgba(0, 0, 0, 0.22);
		border-color: transparent;
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
		color: var(--ms-toolbar-muted);
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
		color: var(--ms-toolbar-muted);
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
		background: var(--ms-toolbar-hover);
		border: 1px solid var(--ms-toolbar-border);
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
		width: 38px;
		height: 38px;
		border-radius: 10px;
		color: var(--ms-toolbar-muted);
	}
	.tool.wide {
		width: auto;
		height: 38px;
		padding: 0 10px;
		display: flex;
		align-items: center;
		gap: 5px;
	}
	.panel.narrow {
		width: 260px;
	}
	.tool:hover {
		background: var(--ms-toolbar-hover);
		color: var(--ms-toolbar-fg);
	}
	.tool:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: -2px;
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
	.grp {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 14px 4px 10px;
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ml-color-text-muted);
		cursor: pointer;
		user-select: none;
	}
	.grp:hover {
		color: var(--ml-color-text);
	}
	.grp.owner {
		padding: 4px 14px 2px 24px;
		text-transform: none;
		letter-spacing: 0;
		font-size: 12px;
	}
	.grp-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.grp-count {
		font-weight: 400;
	}
	.item.deep {
		padding-left: 28px;
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
		background: var(--ms-hover);
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
	/* "Also on the remote" mark of a local branch. */
	.item > ml-icon.pub {
		color: var(--ml-color-text-muted);
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
		background: var(--ms-hover);
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
