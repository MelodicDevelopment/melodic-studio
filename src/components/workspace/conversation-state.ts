import { html } from '@melodicdev/core/template';
import type { Conversation, ConvState } from '../../services/workspace.store';

export const CONV_STATE_LABELS: Record<ConvState, string> = {
	starting: 'Starting',
	working: 'Working',
	waiting: 'Needs you',
	idle: 'Ready',
	ended: 'Ended',
	saved: 'Saved',
};

/** A conversation's state as a small dot (tabs) with the state as its tooltip. */
export function stateDot(c: Conversation) {
	return html`<span class="dot ${c.state}" title=${CONV_STATE_LABELS[c.state]}></span>`;
}

/** The state as a labelled pill (overview cards). */
export function stateChip(c: Conversation) {
	return html`<span class="chip ${c.state}">${c.state === 'working' || c.state === 'starting' ? html`<ml-spinner size="xs"></ml-spinner>` : html`<i></i>`}${CONV_STATE_LABELS[c.state]}</span>`;
}

/** Plain text, to interpolate into a component's css template. */
export const convStateStyles = `
	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		box-sizing: border-box;
		background: var(--ml-color-text-muted);
	}
	.dot.idle {
		background: transparent;
		border: 1.5px solid var(--ms-add);
	}
	.dot.working,
	.dot.starting {
		background: var(--ml-color-primary);
		animation: ms-pulse 1.2s ease-in-out infinite;
	}
	.dot.waiting {
		background: var(--ms-mod);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--ms-mod) 30%, transparent);
	}
	.dot.saved {
		background: transparent;
		border: 1.5px solid var(--ml-color-text-muted);
	}
	@keyframes ms-pulse {
		50% {
			opacity: 0.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.dot.working,
		.dot.starting {
			animation: none;
		}
	}
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
	.chip.working,
	.chip.starting {
		color: var(--ml-color-primary);
		background: var(--ml-color-primary-subtle);
		border-color: transparent;
	}
	.chip.waiting {
		color: var(--ms-mod);
	}
	.chip.idle {
		color: var(--ms-add);
	}
`;
