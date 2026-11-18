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
	.tabs {
		flex: 1;
		min-width: 0;
		display: flex;
		overflow-x: auto;
		scrollbar-width: none;
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
	${convStateStyles}
	${buttons}
	.bar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
		height: 34px;
		padding: 0 4px 0 12px;
		background: var(--ms-sidebar-bg);
		border-bottom: 1px solid var(--ml-color-border);
		font-size: 12px;
	}
	.bar .tool {
		height: 28px;
		border-radius: 4px;
	}
	.bar h2 {
		margin: 0;
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ml-color-text);
	}
	.bar h2 ml-icon {
		color: var(--ml-color-primary);
	}
	.summary {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--ml-color-text-muted);
		padding-left: 8px;
	}
	.summary b {
		color: var(--ms-mod);
	}
	.newwt {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.newwt input {
		width: 180px;
		height: 24px;
		padding: 0 8px;
		border: 1px solid var(--ml-color-border);
		border-radius: 4px;
		background: var(--ml-color-surface);
		color: var(--ml-color-text);
		font: inherit;
	}
	.newwt input:focus {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: -1px;
	}
	.label {
		all: unset;
		display: flex;
		align-items: center;
		gap: 5px;
		height: 26px;
		padding: 0 8px;
		border-radius: 4px;
		color: var(--ml-color-text-muted);
	}
	.label:hover {
		background: var(--ms-hover);
		color: var(--ml-color-text);
	}
	.label.primary {
		color: var(--ml-color-primary);
		font-weight: 600;
	}
	.label .count {
		min-width: 16px;
		padding: 0 4px;
		box-sizing: border-box;
		border-radius: 999px;
		background: var(--ms-mod);
		color: var(--ml-color-text-inverse);
		font-size: 10px;
		font-weight: 700;
		line-height: 16px;
		text-align: center;
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

	/* ---- overview ---- */
	.overview {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 16px;
	}
	.overview h3 {
		margin: 18px 0 8px;
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--ml-color-text-muted);
	}
	.overview h3:first-child {
		margin-top: 0;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
		gap: 10px;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
		padding: 12px;
		border: 1px solid var(--ml-color-border);
		border-radius: 8px;
		background: var(--ml-color-surface);
		cursor: default;
	}
	.card:hover {
		border-color: var(--ml-color-primary);
	}
	.card.waiting {
		border-color: var(--ms-mod);
		box-shadow: 0 0 0 1px var(--ms-mod);
	}
	.card .line {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}
	.card .title {
		flex: 1;
		min-width: 0;
		font-weight: 600;
		font-size: 13px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.card .new {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--ml-color-primary);
	}
	.card .meta {
		font-size: 11px;
		color: var(--ml-color-text-muted);
	}
	.card .meta span {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.card .when {
		margin-left: auto;
		flex: none;
	}
	.card .said {
		margin: 0;
		font-size: 12px;
		line-height: 1.45;
		color: var(--ml-color-text);
		display: -webkit-box;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		overflow-wrap: anywhere;
	}
	.card .said.ask {
		color: var(--ms-mod);
		font-weight: 600;
	}
	.subs {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 6px 8px;
		border-radius: 6px;
		background: var(--ms-hover);
		font-size: 11px;
	}
	.sub {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		color: var(--ml-color-text-muted);
	}
	.sub.running {
		color: var(--ml-color-text);
	}
	.sub span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sub .type {
		flex: none;
		opacity: 0.7;
	}
	.card .x {
		all: unset;
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		border-radius: 4px;
		color: var(--ml-color-text-muted);
	}
	.card .x:hover {
		background: var(--ms-hover);
		color: var(--ml-color-text);
	}
	.none {
		padding: 40px 16px;
		text-align: center;
		color: var(--ml-color-text-muted);
	}
`;
