import { html } from '@melodicdev/core/template';
import { STATE_LABELS, stateOf, type AgentSession } from '../../services/agents.store';

/** How a session stands, as a small labelled pill: Working, Finished, Failed, Needs review, Stopped. */
export function stateChip(s: AgentSession) {
	const state = stateOf(s);
	return html`<span class="chip ${state}">${state === 'working' ? html`<span class="eq" aria-hidden="true"><b></b><b></b><b></b></span>` : html`<i></i>`}${STATE_LABELS[state]}</span>`;
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
	/* Working: azure, with the three equalizer bars of the Melodic mark instead of a spinner. */
	.chip.working {
		color: var(--ms-run-text);
		background: color-mix(in srgb, var(--ms-run) 14%, transparent);
		border-color: transparent;
	}
	.eq {
		display: inline-flex;
		align-items: flex-end;
		gap: 1.5px;
		height: 9px;
	}
	.eq b {
		width: 2px;
		height: 100%;
		border-radius: 1px;
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
	.chip.finished {
		color: var(--ms-add);
	}
	.chip.failed {
		color: var(--ms-del);
		background: var(--ms-diff-del-bg);
	}
	/* Needs review is waiting on the user: magenta. */
	.chip.review {
		color: var(--ml-color-text-link);
		background: var(--ml-color-primary-subtle);
		border-color: transparent;
	}
`;
