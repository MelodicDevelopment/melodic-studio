import { css } from '@melodicdev/core/template';
import { dialogsStyles } from './dialogs.styles';

export const gitOpsStyles = () => css`
	${dialogsStyles()}
	.note {
		font-size: 12px;
		color: var(--ml-color-text-muted);
	}
	.note a {
		color: var(--ml-color-primary);
		cursor: pointer;
	}
	.note a:hover {
		text-decoration: underline;
	}
	.loading {
		display: grid;
		place-items: center;
		padding: 24px;
	}
	code {
		flex: none;
		font-family: var(--ml-font-mono, ui-monospace, monospace);
		font-size: 11px;
		color: var(--ml-color-text-muted);
	}

	/* merge: the three ways */
	.modes {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.mode {
		all: unset;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 9px 11px;
		border: 1px solid var(--ml-color-border);
		border-radius: 8px;
		cursor: default;
	}
	.mode:hover {
		background: var(--ms-hover);
	}
	.mode:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: 1px;
	}
	.mode.on {
		border-color: var(--ml-color-primary);
	}
	.dot {
		flex: none;
		width: 12px;
		height: 12px;
		margin-top: 2px;
		border: 1.5px solid var(--ml-color-border-strong, var(--ml-color-border));
		border-radius: 50%;
	}
	.mode.on .dot {
		border: 4px solid var(--ml-color-primary);
		width: 6px;
		height: 6px;
	}
	.mode .text {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.mode small {
		font-size: 12px;
		line-height: 1.4;
		color: var(--ml-color-text-muted);
	}
	.squash-msg {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	/* cherry-pick: a checklist */
	.picklist,
	.rebase {
		max-height: 46vh;
		overflow-y: auto;
		border: 1px solid var(--ml-color-border);
		border-radius: 8px;
	}
	.pickrow {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		border-bottom: 1px solid var(--ml-color-border-muted);
		color: var(--ml-color-text);
	}
	.pickrow:last-child {
		border-bottom: none;
	}
	.pickrow:hover {
		background: var(--ms-hover);
	}
	.pickrow.head {
		position: sticky;
		top: 0;
		z-index: 1;
		background: var(--ml-color-surface);
		font-size: 11px;
		color: var(--ml-color-text-muted);
	}
	.pickrow input {
		flex: none;
		margin: 0;
		accent-color: var(--ml-color-primary);
	}
	.sum {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--ml-color-text);
	}
	.pickrow small {
		flex: none;
		font-size: 11px;
		color: var(--ml-color-text-muted);
	}

	/* interactive rebase */
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px 4px 4px;
		border-bottom: 1px solid var(--ml-color-border-muted);
		background: var(--ml-color-surface);
	}
	.row.dragging {
		background: var(--ms-selected);
	}
	.row.squash,
	.row.fixup {
		padding-left: 22px;
	}
	.row.drop .sum,
	.row.drop code {
		text-decoration: line-through;
		color: var(--ml-color-text-muted);
	}
	.grip {
		flex: none;
		display: grid;
		place-items: center;
		width: 18px;
		height: 24px;
		color: var(--ml-color-text-muted);
		cursor: grab;
		touch-action: none;
	}
	.row.dragging .grip {
		cursor: grabbing;
	}
	.act {
		flex: none;
		width: 104px;
	}
	.into {
		flex: none;
		font-size: 11px;
		color: var(--ml-color-text-muted);
	}
	.pushed {
		flex: none;
		color: var(--ml-color-text-muted);
	}
	.moves {
		flex: none;
		display: flex;
	}
	.moves button {
		all: unset;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 4px;
		color: var(--ml-color-text-muted);
	}
	.moves button:hover:not([disabled]) {
		background: var(--ms-hover);
		color: var(--ml-color-text);
	}
	.moves button[disabled] {
		opacity: 0.35;
	}
	.msg {
		padding: 4px 10px 8px 34px;
		border-bottom: 1px solid var(--ml-color-border-muted);
		background: var(--ml-color-surface);
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 14px;
		font-size: 11px;
		color: var(--ml-color-text-muted);
	}
	.legend b {
		font-weight: 600;
		color: var(--ml-color-text-secondary);
	}
`;
