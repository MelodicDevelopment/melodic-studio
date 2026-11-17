import { html } from '@melodicdev/core/template';
import { STATE_LABELS, stateOf, type AgentSession } from '../../services/agents.store';

/** How a session stands, as a small labelled pill: Working, Finished, Failed, Needs review, Stopped. */
export function stateChip(s: AgentSession) {
	const state = stateOf(s);
	return html`<span class="chip ${state}">${state === 'working' ? html`<ml-spinner size="xs"></ml-spinner>` : html`<i></i>`}${STATE_LABELS[state]}</span>`;
}

/** Plain text, to interpolate into a component's css template (as `listStyles` is). */
export const stateStyles = `
	.chip {
		flex: none;
		display: inline-flex;
		align-items: center;
		gap: 5px;
		padding: 1px 8px 1px 7px;
		border: 1px solid currentColor;
		border-radius: 999px;
		font-size: 11px;
		font-weight: 600;
		line-height: 17px;
		white-space: nowrap;
		color: var(--ml-color-text-muted);
	}
	.chip i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
	}
	.chip.working {
		color: var(--ml-color-primary);
		background: var(--ml-color-primary-subtle);
		border-color: transparent;
	}
	.chip.finished {
		color: var(--ms-add);
	}
	.chip.failed {
		color: var(--ms-del);
		background: var(--ms-diff-del-bg);
	}
	.chip.review {
		color: var(--ms-mod);
	}
`;
