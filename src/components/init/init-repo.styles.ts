import { css } from '@melodicdev/core/template';

export const initRepoStyles = () => css`
	h3 {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
	}
	.dlg {
		display: flex;
		flex-direction: column;
		gap: 14px;
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
	code {
		font-family: var(--ml-font-mono);
		font-size: 12px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.label {
		font-size: 13px;
		font-weight: 500;
		color: var(--ml-color-text-secondary);
	}
	.chips {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px 16px;
	}
	.hint {
		font-size: 12px;
		color: var(--ml-color-text-muted);
	}
	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
	}
	.pair.end {
		grid-template-columns: 1fr max-content;
		align-items: end;
	}
	.hosts {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
	}
	.host {
		all: unset;
		box-sizing: border-box;
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 10px 12px;
		border: 1px solid var(--ml-color-border);
		border-radius: 10px;
		color: var(--ml-color-text);
	}
	.host:hover {
		border-color: var(--ml-color-border-strong);
		background: var(--ms-hover);
	}
	.host:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: 2px;
	}
	.host.on {
		border-color: var(--ml-color-primary);
		background: var(--ml-color-primary-subtle);
	}
	.host ml-icon {
		flex: none;
		color: var(--ml-color-primary);
	}
	.warn {
		display: flex;
		gap: 8px;
		padding: 9px 11px;
		border-radius: 8px;
		background: var(--ml-color-warning-subtle);
		color: var(--ml-color-text);
	}
	.warn ml-icon {
		flex: none;
		margin-top: 1px;
		color: var(--ml-color-warning);
	}
	.warn.bad {
		background: var(--ms-diff-del-bg);
	}
	.warn.bad ml-icon {
		color: var(--ms-del);
	}
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		width: 100%;
	}
`;
