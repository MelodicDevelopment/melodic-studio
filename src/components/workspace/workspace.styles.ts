import { css } from '@melodicdev/core/template';
import { convStateStyles } from './conversation-state';

const buttons = `
	.tool {
		all: unset;
		flex: none;
		display: grid;
		place-items: center;
		width: 28px;
		color: var(--ml-color-text-muted);
		cursor: default;
	}
	.tool:hover {
		background: var(--ms-hover);
		color: var(--ml-color-text);
	}
	.tool.on {
		color: var(--ml-color-primary);
	}
	.tool:focus-visible,
	button:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: -2px;
	}
`;

/* xterm's own stylesheet is adopted into the pane's shadow root by shared/xterm.ts when a screen first opens there. */
export const paneStyles = () => css`
	:host {
		display: block;
		width: 100%;
		height: 100%;
		min-width: 0;
		min-height: 0;
	}
	${convStateStyles}
	${buttons}
	.pane {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--ml-color-surface);
		box-shadow: inset 0 0 0 1px transparent;
	}
	.pane.focused .head {
		box-shadow: inset 0 -1px 0 var(--ml-color-primary);
	}
	.head {
		flex: none;
		display: flex;
		align-items: stretch;
		height: 32px;
		background: var(--ms-sidebar-bg);
		border-bottom: 1px solid var(--ml-color-border);
	}
	/* The tabs take what they need and shrink first; the buttons after them stay whole. */
	.tabs {
		flex: 0 1 auto;
		min-width: 0;
		display: flex;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.grow {
		flex: 1;
		min-width: 4px;
	}
	/* New conversation: the pane's one main action, so it is the magenta one. The plus alone; the title says what it does. */
	.tool.add {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		color: var(--ml-color-primary);
	}
	.tool.add:hover {
		color: var(--ml-color-primary);
	}
	.tool.more {
		width: 16px;
		/* The popover wraps its trigger, so there is no height to stretch to. */
		height: 31px;
	}
	ml-popover {
		display: flex;
		--ml-popover-padding-x: 0;
		--ml-popover-padding-y: 0;
		--ml-popover-radius: 10px;
	}
	.menu {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 290px;
		box-sizing: border-box;
		padding: 6px;
		font-size: 13px;
		color: var(--ml-color-text);
	}
	.newwt {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 6px 8px 10px;
		margin-bottom: 4px;
		border-bottom: 1px solid var(--ml-color-border);
	}
	.newwt label {
		font-weight: 600;
	}
	.newwt .row {
		display: flex;
		gap: 6px;
	}
	.newwt input {
		flex: 1;
		min-width: 0;
		height: 28px;
		box-sizing: border-box;
		padding: 0 8px;
		border: 1px solid var(--ml-color-border-strong);
		border-radius: 6px;
		background: var(--ml-color-input-bg);
		color: var(--ml-color-text);
		font: inherit;
		font-family: var(--ml-font-mono);
		font-size: 12px;
	}
	.newwt input:focus {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: -1px;
	}
	.newwt small {
		color: var(--ml-color-text-muted);
	}
	.go {
		all: unset;
		flex: none;
		display: grid;
		place-items: center;
		height: 28px;
		padding: 0 12px;
		border-radius: 6px;
		background: var(--ml-color-primary);
		color: var(--ml-color-text-inverse);
		font-weight: 600;
	}
	.go[disabled] {
		opacity: 0.5;
	}
	.mitem {
		all: unset;
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 7px 8px;
		border-radius: 6px;
	}
	.mitem:hover {
		background: var(--ms-hover);
	}
	.mitem ml-icon {
		color: var(--ml-color-text-muted);
	}
	.ptab {
		flex: none;
		display: flex;
		align-items: center;
		gap: 7px;
		max-width: 220px;
		padding: 0 6px 0 10px;
		border-right: 1px solid var(--ml-color-border);
		font-size: 12px;
		color: var(--ml-color-text-muted);
		box-shadow: inset 0 2px 0 transparent;
		user-select: none;
		touch-action: none;
	}
	.ptab .name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ptab:hover {
		color: var(--ml-color-text);
	}
	.ptab.on {
		background: var(--ml-color-surface);
		color: var(--ml-color-text);
		box-shadow: inset 0 2px 0 var(--ml-color-primary);
	}
	.ptab.unread .name {
		font-weight: 600;
		color: var(--ml-color-text);
	}
	.ptab.ended .name {
		text-decoration: line-through;
	}
	.ptab button {
		all: unset;
		flex: none;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 4px;
	}
	.ptab button:hover {
		background: var(--ms-hover);
	}
	.asking {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 12px;
		font-size: 12px;
		color: var(--ml-color-text);
		background: color-mix(in srgb, var(--ms-mod) 16%, var(--ml-color-surface));
		border-bottom: 1px solid var(--ml-color-border);
	}
	.asking ml-icon {
		color: var(--ms-mod);
	}

	/* ---- screens: WorkspaceStore moves the active one's element in here ---- */
	.screens {
		flex: 1;
		min-height: 0;
		position: relative;
		overflow: hidden;
	}
	.screen {
		position: absolute;
		inset: 6px 0 4px 10px;
	}
	.screen[hidden] {
		display: none;
	}

	/* ---- empty pane / saved conversation ---- */
	.start {
		position: absolute;
		inset: 32px 0 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 24px;
		background: var(--ml-color-surface);
		text-align: center;
	}
	.big {
		all: unset;
		display: flex;
		align-items: center;
		gap: 12px;
		width: min(320px, 100%);
		box-sizing: border-box;
		padding: 12px 14px;
		border: 1px solid var(--ml-color-border);
		border-radius: 8px;
		text-align: left;
		color: var(--ml-color-text);
	}
	.big:hover {
		background: var(--ms-hover);
		border-color: var(--ml-color-primary);
	}
	.big ml-icon {
		color: var(--ml-color-primary);
	}
	.big span {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.big small {
		color: var(--ml-color-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.hint {
		margin: 6px 0 0;
		font-size: 12px;
		color: var(--ml-color-text-muted);
		max-width: 360px;
		overflow-wrap: anywhere;
	}
	.resume {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		max-width: 460px;
		color: var(--ml-color-text-muted);
	}
	.resume h3 {
		margin: 0;
		font-size: 15px;
		line-height: 1.45;
		text-align: center;
		color: var(--ml-color-text);
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.outside {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		margin: 0;
		font-size: 12px;
		line-height: 1.5;
		text-align: left;
		color: var(--ml-color-text-muted);
	}
	.outside ml-icon {
		flex: none;
		margin-top: 1px;
	}
	.outside.warn {
		padding: 8px 10px;
		border-radius: 8px;
		color: var(--ms-mod);
		background: color-mix(in srgb, var(--ms-mod) 12%, transparent);
	}
	.said {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
		display: -webkit-box;
		-webkit-line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	/* ---- where a dragged tab would land ---- */
	.drop {
		position: absolute;
		z-index: 5;
		pointer-events: none;
		background: color-mix(in srgb, var(--ml-color-primary) 18%, transparent);
		border: 2px solid var(--ml-color-primary);
		border-radius: 4px;
		box-sizing: border-box;
	}
	.drop.center {
		inset: 32px 0 0;
	}
	.drop.left {
		inset: 32px 50% 0 0;
	}
	.drop.right {
		inset: 32px 0 0 50%;
	}
	.drop.top {
		inset: 32px 0 50% 0;
	}
	.drop.bottom {
		inset: calc(50% + 16px) 0 0 0;
	}
`;

export const workspaceStyles = () => css`
	:host {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		background: var(--ml-color-surface);
	}
	/* ---- the split tree ---- */
	.root {
		flex: 1;
		min-height: 0;
		display: flex;
	}
	.split {
		flex: 1;
		min-width: 0;
		min-height: 0;
		display: flex;
	}
	.split.column {
		flex-direction: column;
	}
	.cell {
		position: relative;
		display: flex;
		min-width: 80px;
		min-height: 60px;
		flex-basis: 0;
	}
	.divider {
		flex: none;
		position: relative;
		z-index: 2;
		background: var(--ml-color-border);
		touch-action: none;
	}
	.row > .divider {
		width: 1px;
		cursor: col-resize;
	}
	.column > .divider {
		height: 1px;
		cursor: row-resize;
	}
	.divider::after {
		content: '';
		position: absolute;
		inset: -3px;
	}
	.row > .divider::after {
		inset: 0 -3px;
	}
	.column > .divider::after {
		inset: -3px 0;
	}
	.divider:hover,
	.divider.moving {
		background: var(--ml-color-primary);
	}
	.root.resizing {
		user-select: none;
	}

`;
