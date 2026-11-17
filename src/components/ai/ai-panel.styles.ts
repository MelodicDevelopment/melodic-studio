import { css } from '@melodicdev/core/template';
import { markdownStyles } from './markdown';

export const aiPanelStyles = () => css`
	:host {
		position: relative;
		flex: none;
		display: flex;
		flex-direction: column;
		min-height: 0;
		width: 380px;
		border-left: 1px solid var(--ml-color-border);
		background: var(--ms-sidebar-bg);
	}
	.grip {
		position: absolute;
		top: 0;
		bottom: 0;
		left: -3px;
		width: 6px;
		z-index: 2;
		cursor: col-resize;
	}
	.grip:hover {
		background: var(--ml-color-primary);
		opacity: 0.5;
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.head {
		flex: none;
		display: flex;
		align-items: stretch;
		height: 36px;
		padding-right: 6px;
		border-bottom: 1px solid var(--ml-color-border);
	}
	.name {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 0 12px;
		font-size: 12px;
		font-weight: 600;
	}
	.name ml-icon {
		color: var(--ml-color-primary);
	}
	.tab {
		all: unset;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 12px;
		font-size: 12px;
		font-weight: 500;
		color: var(--ml-color-text-muted);
		box-shadow: inset 0 -2px 0 transparent;
	}
	.tab:hover {
		color: var(--ml-color-text);
	}
	.tab.on {
		color: var(--ml-color-text);
		box-shadow: inset 0 -2px 0 var(--ml-color-primary);
	}
	.tab:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: -2px;
	}
	.count {
		padding: 0 6px;
		border-radius: 999px;
		background: var(--ml-color-primary-subtle);
		color: var(--ml-color-primary);
		font-size: 11px;
		font-weight: 600;
		line-height: 16px;
	}
	.icon {
		all: unset;
		align-self: center;
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 5px;
		color: var(--ml-color-text-muted);
	}
	.icon:hover {
		background: var(--ms-hover);
		color: var(--ml-color-text);
	}
	.sub {
		flex: none;
		padding: 10px 14px 9px;
		border-bottom: 1px solid var(--ml-color-border-muted);
	}
	.sub .t {
		font-weight: 600;
	}
	.sub .d {
		margin-top: 1px;
		font-size: 12px;
		color: var(--ml-color-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 12px 14px 16px;
	}
	.foot {
		flex: none;
		display: flex;
		gap: 6px;
		padding: 8px 10px;
		border-top: 1px solid var(--ml-color-border);
	}
	.wait {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		color: var(--ml-color-text-secondary);
	}
	.wait ml-spinner {
		flex: none;
		margin-top: 1px;
	}
	.wait.small {
		margin-top: 6px;
		font-size: 12px;
		color: var(--ml-color-text-muted);
	}
	.progress {
		margin: 10px 0 0 25px;
		font-size: 12px;
		font-style: italic;
		color: var(--ml-color-text-muted);
		overflow-wrap: anywhere;
	}
	.notice {
		margin-top: 10px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--ms-hover);
		font-size: 12px;
		color: var(--ml-color-text-secondary);
		overflow-wrap: anywhere;
		user-select: text;
		-webkit-user-select: text;
	}
	.notice:first-child {
		margin-top: 0;
	}
	.notice.error {
		background: var(--ms-diff-del-bg);
		color: var(--ml-color-text);
	}
	.raw {
		margin-top: 10px;
		padding-top: 10px;
		border-top: 1px solid var(--ml-color-border-muted);
		font-size: 12px;
		color: var(--ml-color-text-secondary);
	}

	/* ---- review ---- */
	.summary {
		margin: 0 0 10px;
		user-select: text;
		-webkit-user-select: text;
	}
	.counts {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 4px;
	}
	.chip {
		padding: 1px 8px;
		border: 1px solid currentColor;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
		color: var(--ml-color-text-muted);
	}
	.chip.bug,
	.bug .sev {
		color: var(--ms-del);
	}
	.chip.risk,
	.risk .sev {
		color: var(--ms-mod);
	}
	.group {
		display: flex;
		margin: 14px -14px 0;
		padding: 5px 14px;
		border-top: 1px solid var(--ml-color-border-muted);
		border-bottom: 1px solid var(--ml-color-border-muted);
		background: var(--ml-color-background);
		font-size: 12px;
		white-space: nowrap;
	}
	.group .dir {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--ml-color-text-muted);
	}
	.group .file {
		flex: none;
		font-weight: 600;
	}
	.finding {
		margin: 0 -14px;
		padding: 9px 14px 9px 11px;
		border-left: 3px solid var(--ml-color-border-strong);
		border-bottom: 1px solid var(--ml-color-border-muted);
		cursor: pointer;
	}
	.finding.bug {
		border-left-color: var(--ms-del);
	}
	.finding.risk {
		border-left-color: var(--ms-mod);
	}
	.finding:hover {
		background: var(--ms-hover);
	}
	.finding.open {
		background: var(--ms-selected);
	}
	.ft {
		display: flex;
		align-items: baseline;
		gap: 8px;
	}
	.sev {
		flex: none;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--ml-color-text-muted);
	}
	.title {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.fd {
		margin-top: 3px;
		font-size: 12px;
		color: var(--ml-color-text-secondary);
	}
	.fd .md {
		cursor: pointer;
	}
	.fd .md p:last-child {
		margin-bottom: 0;
	}
	.fl {
		margin-top: 4px;
		font-size: 11px;
		color: var(--ml-color-text-muted);
	}
	.clean {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 28px 10px;
		text-align: center;
		color: var(--ml-color-text-muted);
	}
	.clean ml-icon {
		color: var(--ms-add);
	}
	.clean b {
		font-size: 14px;
		font-weight: 600;
		color: var(--ml-color-text);
	}
	${markdownStyles}
`;
