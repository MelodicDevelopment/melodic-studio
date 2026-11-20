import { css } from '@melodicdev/core/template';
import { listStyles } from '../changes/changes.styles';

export const appStyles = () => css`
	:host {
		display: flex;
		flex-direction: column;
		height: 100vh;
		background: var(--ml-color-background);
		color: var(--ml-color-text);
	}
	${listStyles}
	.center {
		flex: 1;
		display: grid;
		place-items: center;
		color: var(--ml-color-text-muted);
	}
	.work {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.work.resizing {
		cursor: col-resize;
	}
	.work.resizing main {
		pointer-events: none;
	}
	aside {
		flex: none;
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--ms-sidebar-bg);
		container-type: inline-size;
	}
	.resizer {
		flex: none;
		width: 5px;
		margin: 0 -2px;
		z-index: 2;
		cursor: col-resize;
		background: linear-gradient(to right, transparent 2px, var(--ml-color-border) 2px, var(--ml-color-border) 3px, transparent 3px);
	}
	.resizer:hover,
	.resizing .resizer {
		background: linear-gradient(to right, transparent 1px, var(--ml-color-primary) 1px, var(--ml-color-primary) 4px, transparent 4px);
	}
	main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		background: var(--ml-color-surface);
	}
	ms-diff {
		flex: 1;
		height: auto;
	}
	/* The main pane with the terminal panel docked under it; the sidebar keeps the full height. */
	.maincol {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.maincol > main {
		min-height: 0;
	}

	/* ---- main pane and Claude workspace side by side ---- */
	.upper {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.upper > main {
		min-height: 0;
	}
	.upper.full > main,
	.upper.full > .wsresizer {
		display: none;
	}
	.upper ms-workspace {
		flex: none;
		/* Its width comes from WorkspaceStore.width, which leaves the main pane its floor. */
		min-width: 0;
	}
	.upper.full ms-workspace {
		flex: 1;
		max-width: none;
	}
	/* What is left of the Claude pane while it is hidden: the arrow that brings it back, where the one that hid it was. */
	.wsrail {
		all: unset;
		flex: none;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		box-sizing: border-box;
		width: 28px;
		padding-top: 8px;
		border-left: 1px solid var(--ml-color-border);
		background: var(--ms-sidebar-bg);
		color: var(--ml-color-text-muted);
	}
	.wsrail:hover {
		background: var(--ms-hover);
		color: var(--ml-color-text);
	}
	.wsrail:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: -2px;
	}
	.wsresizer {
		flex: none;
		width: 1px;
		position: relative;
		z-index: 3;
		background: var(--ml-color-border);
		cursor: col-resize;
		touch-action: none;
	}
	.wsresizer::after {
		content: '';
		position: absolute;
		inset: 0 -3px;
	}
	.wsresizer:hover,
	.upper.resizing .wsresizer {
		background: var(--ml-color-primary);
	}
	.upper.resizing {
		cursor: col-resize;
		user-select: none;
	}
	.upper.resizing main {
		pointer-events: none;
	}

	/* ---- sidebar tabs ---- */
	.tabs {
		flex: none;
		display: flex;
		gap: 2px;
		margin: 10px 10px 6px;
		padding: 3px;
		border-radius: 10px;
		background: var(--ml-color-surface-sunken);
	}
	/* Each tab is as wide as its label plus padding, and the spare width is shared out: equal widths would
	   squeeze "Changes 12" against the pill's edges while "Files" has room to spare. */
	.tab {
		all: unset;
		flex: 1 1 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 5px;
		padding: 0 10px;
		white-space: nowrap;
		height: 30px;
		border-radius: 8px;
		font-size: 12px;
		font-weight: 500;
		color: var(--ml-color-text-muted);
		transition: background-color 0.12s, color 0.12s;
	}
	.tab:hover {
		color: var(--ml-color-text);
	}
	.tab.on {
		color: var(--ml-color-text);
		font-weight: 600;
		background: var(--ms-seg-on);
		box-shadow: var(--ms-seg-shadow);
	}
	.tab:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: -2px;
	}
	/* Near the sidebar's minimum width (220px) the four labels only fit with tighter spacing. */
	@container (max-width: 270px) {
		.tabs {
			gap: 1px;
			margin: 8px 8px 6px;
			padding: 2px;
		}
		.tab {
			gap: 4px;
			padding: 0 4px;
			font-size: 11.5px;
		}
		.count {
			padding: 0 4px;
		}
	}
	.count {
		padding: 0 6px;
		border-radius: 6px;
		background: var(--ml-color-primary-subtle);
		color: var(--ml-color-text-link);
		font-size: 11px;
		font-weight: 600;
		line-height: 17px;
	}

	/* ---- open file tabs ---- */
	.filetabs {
		flex: none;
		display: flex;
		overflow-x: auto;
		background: var(--ms-sidebar-bg);
		border-bottom: 1px solid var(--ml-color-border);
		scrollbar-width: none;
	}
	.filetab {
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 220px;
		height: 32px;
		padding: 0 8px 0 12px;
		border-right: 1px solid var(--ml-color-border);
		color: var(--ml-color-text-muted);
		box-shadow: inset 0 2px 0 transparent;
	}
	.filetab span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.filetab:hover {
		color: var(--ml-color-text);
	}
	.filetab.on {
		background: var(--ml-color-surface);
		color: var(--ml-color-text);
		box-shadow: inset 0 2px 0 var(--ml-color-primary);
	}
	.filetab.preview {
		padding-right: 12px;
		font-style: italic;
	}
	.filetab button {
		all: unset;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 4px;
	}
	.filetab button:hover {
		background: var(--ms-hover);
	}

	/* ---- diff header ---- */
	.filehead {
		flex: none;
		display: flex;
		align-items: center;
		gap: 9px;
		height: 36px;
		padding: 0 14px;
		border-bottom: 1px solid var(--ml-color-border);
	}
	.filehead .file {
		font-weight: 600;
	}
	.stat {
		flex: none;
		font-family: var(--ml-font-mono);
		font-size: 12px;
		font-weight: 600;
	}
	.stat.add {
		color: var(--ms-add);
	}
	.stat.del {
		color: var(--ms-del);
	}

	/* ---- commit detail ---- */
	.commithead {
		flex: none;
		padding: 14px 16px 12px;
		border-bottom: 1px solid var(--ml-color-border);
	}
	.commithead h2 {
		margin: 0;
		font-family: var(--ms-font-display);
		font-size: 19px;
		line-height: 1.2;
		letter-spacing: -0.01em;
		font-weight: 600;
		user-select: text;
		-webkit-user-select: text;
	}
	.commithead pre {
		margin: 8px 0 0;
		max-height: 120px;
		overflow: auto;
		font-family: inherit;
		white-space: pre-wrap;
		color: var(--ml-color-text-secondary);
		user-select: text;
		-webkit-user-select: text;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 14px;
		margin-top: 10px;
		font-size: 12px;
		color: var(--ml-color-text-muted);
	}
	.meta span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.hash {
		font-family: var(--ml-font-mono);
		color: var(--ms-hash);
		cursor: pointer;
	}
	.hash:hover {
		color: var(--ml-color-text);
	}
	.split {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.files {
		flex: none;
		width: 260px;
		border-right: 1px solid var(--ml-color-border);
		background: var(--ms-sidebar-bg);
	}
	.diffcol {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	/* ---- empty states ---- */
	.empty,
	.welcome {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 32px;
		text-align: center;
	}
	.welcome > ml-icon {
		color: var(--ml-color-primary);
	}
	h1 {
		margin: 6px 0 0;
		font-family: var(--ms-font-display);
		font-size: 28px;
		letter-spacing: -0.02em;
		font-weight: 600;
	}
	.empty h2 {
		margin: 0;
		font-family: var(--ms-font-display);
		letter-spacing: -0.01em;
		font-size: 22px;
		font-weight: 600;
	}
	.empty p,
	.welcome p {
		margin: 0;
		max-width: 460px;
		color: var(--ml-color-text-muted);
	}
	.welcome .warn {
		color: var(--ml-color-danger);
	}
	.selectable {
		user-select: text;
		-webkit-user-select: text;
		overflow-wrap: anywhere;
	}
	.actions {
		display: flex;
		gap: 8px;
		margin-top: 10px;
	}
	.cards {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: min(460px, 100%);
		margin-top: 14px;
	}
	.card {
		all: unset;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 11px 14px;
		border: 1px solid var(--ml-color-border);
		border-radius: 12px;
		background: var(--ml-color-surface);
		text-align: left;
	}
	.card:hover:not([disabled]) {
		border-color: var(--ml-color-border-strong);
		background: var(--ms-hover);
	}
	.card:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: 2px;
	}
	.card[disabled] {
		opacity: 0.6;
	}
	.card.primary {
		border-color: var(--ml-color-primary);
		background: var(--ml-color-primary-subtle);
	}
	.card ml-icon {
		flex: none;
		color: var(--ml-color-primary);
	}
	.card span {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.card b {
		font-weight: 600;
	}
	.card small {
		font-size: 12px;
		color: var(--ml-color-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
`;
