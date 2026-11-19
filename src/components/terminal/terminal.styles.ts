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
	.ttab.shell.ended span {
		text-decoration: line-through;
	}
	/* A program Studio started keeps its name when it ends: the tab is still where its output is read. */
	.ttab.run.ended,
	.ttab.investigation.ended {
		color: var(--ml-color-text-subtle);
	}
	.ttab .ai,
	.tool.ai {
		color: var(--ms-ai);
	}
	.ttab .errs {
		flex: none;
		padding: 0 7px;
		border-radius: 10px;
		background: var(--ml-color-danger-subtle);
		color: var(--ml-color-danger);
		font-size: 11px;
		font-style: normal;
		line-height: 16px;
	}
	/* The equalizer bars of the Melodic mark: this tab's program is running. */
	.eq {
		flex: none;
		display: inline-flex;
		align-items: flex-end;
		gap: 2px;
		height: 10px;
		color: var(--ms-run);
	}
	.eq b {
		width: 2px;
		height: 100%;
		background: currentColor;
		transform-origin: bottom;
		animation: ms-eq 1s ease-in-out infinite;
	}
	.eq b:nth-child(2) {
		animation-delay: 0.2s;
	}
	.eq b:nth-child(3) {
		animation-delay: 0.4s;
	}
	@keyframes ms-eq {
		0%,
		100% {
			transform: scaleY(0.4);
		}
		50% {
			transform: scaleY(1);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.eq b {
			animation: none;
		}
	}
	.cmd {
		flex: 0 1 auto;
		min-width: 0;
		align-self: center;
		padding: 0 12px;
		font-family: var(--ml-font-mono);
		font-size: 11px;
		color: var(--ml-color-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* ---- "Error spotted": over the output of the run it was found in ---- */
	.spotted {
		flex: none;
		margin: 8px 10px 2px;
		border: 1px solid color-mix(in srgb, var(--ml-color-danger) 32%, transparent);
		border-radius: 8px;
		background: color-mix(in srgb, var(--ml-color-danger) 9%, transparent);
		overflow: hidden;
	}
	.spotted .row {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding: 6px 8px 6px 12px;
	}
	.spotted .row > ml-icon {
		flex: none;
		color: var(--ml-color-danger);
	}
	.spotted b {
		flex: none;
		font-weight: 600;
	}
	.sum {
		flex: 1;
		min-width: 0;
		color: var(--ml-color-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		user-select: text;
		-webkit-user-select: text;
	}
	.when,
	.pager {
		flex: none;
		font-size: 11px;
		color: var(--ml-color-text-muted);
	}
	.pager {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.spotted button {
		all: unset;
		box-sizing: border-box;
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		height: 30px;
		padding: 0 12px;
		border-radius: 7px;
		font-size: 12px;
	}
	.pager button {
		height: 22px;
		padding: 0 3px;
	}
	.pager button[disabled] {
		opacity: 0.35;
	}
	.spotted .plain {
		border: 1px solid var(--ml-color-border-strong);
		color: var(--ml-color-text-secondary);
	}
	/* Purple: this hands the error to Claude. */
	.spotted .ask {
		border: 1px solid var(--ms-ai-border);
		background: var(--ms-ai-subtle);
		font-weight: 600;
	}
	.spotted .ask ml-icon {
		color: var(--ms-ai);
	}
	.spotted button:hover:not([disabled]) {
		background: var(--ms-hover);
	}
	.spotted .ask:hover {
		background: color-mix(in srgb, var(--ms-ai) 18%, transparent);
	}
	.spotted button:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: 1px;
	}
	.frames {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		padding: 0 12px 8px 38px;
		font-family: var(--ml-font-mono);
		font-size: 12px;
	}
	.frames a {
		color: var(--ml-color-text-link);
		text-decoration: none;
	}
	.frames a:hover {
		text-decoration: underline;
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
