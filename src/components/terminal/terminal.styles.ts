import { css } from '@melodicdev/core/template';

/* xterm's own stylesheet is adopted into this shadow root by shared/xterm.ts when xterm loads. */
export const terminalStyles = () => css`
	:host {
		flex: none;
		display: block;
		min-width: 0;
	}
	.panel {
		position: relative;
		display: flex;
		flex-direction: column;
		min-height: 120px;
		/* Whatever height was saved, the main pane above keeps some room. */
		max-height: calc(100vh - 180px);
		border-top: 1px solid var(--ml-color-border);
		background: var(--ml-color-surface);
	}
	.panel.closed {
		display: none;
	}

	/* ---- top edge, dragged to resize (the sidebar's resizer, turned on its side) ---- */
	.grip {
		position: absolute;
		top: -3px;
		left: 0;
		right: 0;
		height: 5px;
		z-index: 3;
		cursor: row-resize;
		touch-action: none;
	}
	.grip:hover,
	.dragging .grip {
		background: linear-gradient(to bottom, transparent 1px, var(--ml-color-primary) 1px, var(--ml-color-primary) 4px, transparent 4px);
	}

	/* ---- tabs ---- */
	.head {
		flex: none;
		display: flex;
		align-items: stretch;
		height: 30px;
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
	.ttab {
		flex: none;
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 200px;
		padding: 0 6px 0 10px;
		border-right: 1px solid var(--ml-color-border);
		font-size: 12px;
		color: var(--ml-color-text-muted);
		box-shadow: inset 0 2px 0 transparent;
	}
	.ttab span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.ttab:hover {
		color: var(--ml-color-text);
	}
	.ttab.on {
		background: var(--ml-color-surface);
		color: var(--ml-color-text);
		box-shadow: inset 0 2px 0 var(--ml-color-primary);
	}
	.ttab.ended span {
		text-decoration: line-through;
	}
	.ttab button {
		all: unset;
		flex: none;
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 4px;
	}
	.ttab button:hover {
		background: var(--ms-hover);
	}
	.tool {
		all: unset;
		flex: none;
		display: grid;
		place-items: center;
		width: 30px;
		color: var(--ml-color-text-muted);
	}
	.tool:hover {
		background: var(--ms-hover);
		color: var(--ml-color-text);
	}
	.tool:focus-visible,
	.ttab button:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: -2px;
	}

	/* ---- the terminals; TerminalStore moves the active one's element in here ---- */
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
	.none {
		position: absolute;
		inset: 30px 0 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		color: var(--ml-color-text-muted);
	}
`;
