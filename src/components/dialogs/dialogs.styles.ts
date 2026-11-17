import { css } from '@melodicdev/core/template';

export const dialogsStyles = () => css`
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
	.pathrow {
		display: flex;
		align-items: flex-end;
		gap: 8px;
	}
	.pathrow ml-input {
		flex: 1;
		min-width: 0;
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
	.foot {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		width: 100%;
	}
	.who {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.who h4 {
		margin: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--ml-color-text);
	}
	.who small {
		margin-top: -2px;
		font-size: 12px;
		color: var(--ml-color-text-muted);
	}
	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.pair ml-input {
		min-width: 0;
	}
	dl {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 6px 16px;
		margin: 0;
		padding-top: 12px;
		border-top: 1px solid var(--ml-color-border);
		font-size: 12px;
	}
	dt {
		color: var(--ml-color-text-muted);
	}
	dd {
		margin: 0;
		color: var(--ml-color-text);
		user-select: text;
		-webkit-user-select: text;
		overflow-wrap: anywhere;
	}
`;
