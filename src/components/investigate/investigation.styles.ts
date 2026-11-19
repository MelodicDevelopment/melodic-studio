import { css } from '@melodicdev/core/template';
import { richTextStyles } from '../agents/rich-text';

/* Colour roles (styles/global.css): magenta is waiting on the user, azure is running, purple is Claude. */
export const investigationStyles = () => css`
	:host {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		min-width: 0;
		container-type: inline-size;
	}
	ms-replay {
		flex: 1;
		min-height: 0;
	}
	.pane {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 20px;
		padding: 26px 32px 18px;
		background: var(--ml-color-surface);
	}
	.grow {
		flex: 1;
		min-width: 0;
	}
	.mono {
		font-family: var(--ml-font-mono);
	}
	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
	}
	h1 {
		margin: 0;
		font-family: var(--ms-font-display);
		font-size: 24px;
		font-weight: 600;
		line-height: 1.25;
	}
	h2 {
		margin: 0;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ml-color-text-muted);
	}
	.top {
		flex: none;
		display: flex;
		align-items: flex-start;
		gap: 14px;
	}
	.sub {
		margin-top: 6px;
		font-size: 14px;
		color: var(--ml-color-text-secondary);
		user-select: text;
		-webkit-user-select: text;
	}
	.tile {
		flex: none;
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border: 1px solid var(--ms-ai-border);
		border-radius: 12px;
		background: var(--ms-ai-subtle);
		color: var(--ms-ai);
	}
	.tile.idle {
		border-color: var(--ml-color-border-strong);
		background: var(--ml-color-surface-raised);
		color: var(--ml-color-text-muted);
	}
	/* The equalizer bars of the Melodic mark, in purple: Claude is at work. */
	.eq {
		display: inline-flex;
		align-items: flex-end;
		gap: 3px;
		height: 16px;
	}
	.eq b {
		width: 3px;
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
	.eq b:nth-child(4) {
		animation-delay: 0.1s;
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
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 10px;
	}
	.chip {
		padding: 3px 9px;
		border-radius: 6px;
		background: var(--ml-color-surface-raised);
		color: var(--ml-color-text-secondary);
		font-size: 11px;
		white-space: nowrap;
	}
	.chip.run {
		background: var(--ml-color-info-subtle);
		color: var(--ms-run-text);
	}

	/* ---- while it runs: the checklist, and what waits on the user beside it ---- */
	.cols {
		flex: 1;
		min-height: 0;
		display: flex;
		gap: 28px;
		overflow-y: auto;
	}
	.steps {
		flex: 1;
		min-width: 240px;
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.steps li {
		display: flex;
		gap: 14px;
	}
	.steps li > div {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}
	.mark {
		flex: none;
		box-sizing: border-box;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border: 2px solid var(--ml-color-border-strong);
		border-radius: 50%;
	}
	.stitle {
		font-size: 14px;
		font-weight: 500;
		line-height: 24px;
		color: var(--ml-color-text-muted);
	}
	.sdetail {
		color: var(--ml-color-text-muted);
		overflow-wrap: anywhere;
		user-select: text;
		-webkit-user-select: text;
	}
	.done .mark {
		border-color: transparent;
		background: var(--ml-color-success-subtle);
		color: var(--ml-color-success);
	}
	.done .stitle,
	.now .stitle {
		font-weight: 600;
		color: var(--ml-color-text);
	}
	.now .mark {
		border-color: var(--ms-run);
		background: var(--ml-color-info-subtle);
	}
	.waiting .mark {
		border-color: var(--ms-you);
		background: var(--ml-color-primary-subtle);
	}
	.waiting .stitle {
		font-weight: 600;
		color: var(--ml-color-text-link);
	}
	.waiting .sdetail {
		color: var(--ml-color-text-secondary);
	}
	.side {
		flex: none;
		width: min(480px, 46%);
		display: flex;
		flex-direction: column;
		gap: 16px;
	}
	.card {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 16px 18px;
		border: 1px solid var(--ml-color-border);
		border-radius: 12px;
		background: var(--ml-color-surface-raised);
		line-height: 1.55;
		user-select: text;
		-webkit-user-select: text;
	}
	.card p {
		margin: 0;
		color: var(--ml-color-text-secondary);
	}
	/* Magenta: this one waits on the user. */
	.card.you {
		border-color: color-mix(in srgb, var(--ms-you) 50%, transparent);
		background: var(--ml-color-primary-subtle);
	}
	.card.ai {
		gap: 8px;
		border-color: var(--ms-ai-border);
		background: var(--ms-ai-subtle);
	}
	.card.bad {
		border-color: color-mix(in srgb, var(--ml-color-danger) 40%, transparent);
		background: var(--ms-diff-del-bg);
		color: var(--ms-del);
	}
	.ctitle {
		font-size: 15px;
		font-weight: 600;
	}
	.clabel {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		font-weight: 600;
		color: var(--ms-ai);
	}
	.cmd {
		margin: 0;
		padding: 8px 10px;
		border-radius: 8px;
		background: var(--ml-color-surface-sunken);
		font-family: var(--ml-font-mono);
		font-size: 12px;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		max-height: 160px;
		overflow-y: auto;
	}
	.card .touches {
		color: var(--ml-color-text);
	}
	.btns {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	/* ---- the report ---- */
	.verdict {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 8px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.verdict.found {
		color: var(--ml-color-success);
	}
	.verdict.open {
		color: var(--ml-color-warning);
	}
	.cause {
		max-width: 900px;
		font-size: 24px;
		user-select: text;
		-webkit-user-select: text;
	}
	.scroll {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 22px;
		overflow-y: auto;
		padding-right: 4px;
	}
	section {
		display: flex;
		flex-direction: column;
		gap: 10px;
		min-width: 0;
	}
	.shead {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.shead h2 {
		flex: 1;
	}
	button {
		font: inherit;
	}
	/* Azure: Replay plays back something that ran. */
	.replay {
		all: unset;
		box-sizing: border-box;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 32px;
		padding: 0 14px;
		border: 1px solid color-mix(in srgb, var(--ms-run) 45%, transparent);
		border-radius: 8px;
		background: var(--ml-color-info-subtle);
		font-size: 13px;
		font-weight: 600;
	}
	.replay ml-icon {
		color: var(--ms-run);
	}
	.replay:hover {
		border-color: var(--ms-run);
	}
	.replay:focus-visible,
	.follow button:focus-visible {
		outline: 2px solid var(--ml-color-primary);
		outline-offset: 2px;
	}
	.path {
		display: flex;
		align-items: stretch;
		overflow-x: auto;
		padding-bottom: 4px;
	}
	.arrow {
		flex: none;
		align-self: center;
		margin: 0 6px;
		color: var(--ml-color-text-subtle);
	}
	.pcard {
		flex: 1 0 150px;
		max-width: 260px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 14px;
		border: 1px solid var(--ml-color-border);
		border-radius: 10px;
		background: var(--ml-color-surface-raised);
		font-family: var(--ml-font-mono);
		user-select: text;
		-webkit-user-select: text;
	}
	.pcard .fn {
		font-size: 12px;
		font-weight: 500;
		color: var(--ml-color-text);
		text-decoration: none;
		overflow-wrap: anywhere;
	}
	.pcard a.fn:hover {
		text-decoration: underline;
	}
	.where {
		font-size: 11px;
		color: var(--ml-color-text-muted);
	}
	.vals {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: 11px;
		color: var(--ml-color-text-secondary);
		overflow-wrap: anywhere;
	}
	.role {
		font-family: var(--ml-font-sans);
		font-size: 11px;
		font-weight: 600;
	}
	.pcard.cause {
		border-color: var(--ms-ai-border);
		background: var(--ms-ai-subtle);
	}
	.pcard.cause .role {
		color: var(--ms-ai);
	}
	.pcard.crash {
		border-color: color-mix(in srgb, var(--ml-color-danger) 45%, transparent);
		background: var(--ms-diff-del-bg);
	}
	.pcard.crash .vals,
	.pcard.crash .role {
		color: var(--ml-color-danger);
	}
	.two {
		display: flex;
		gap: 24px;
		align-items: flex-start;
	}
	.evidence {
		flex: 1;
	}
	.fix {
		flex: none;
		width: min(560px, 50%);
	}
	.erow {
		display: flex;
		gap: 12px;
		padding: 12px 14px;
		border: 1px solid var(--ml-color-border);
		border-radius: 10px;
		background: var(--ml-color-surface-raised);
		user-select: text;
		-webkit-user-select: text;
	}
	.erow.confirmed {
		border-color: color-mix(in srgb, var(--ml-color-success) 40%, transparent);
	}
	.tag {
		flex: none;
		align-self: flex-start;
		padding: 0 8px;
		border-radius: 6px;
		background: var(--ml-color-surface-sunken);
		color: var(--ml-color-text-muted);
		font-size: 11px;
		font-weight: 600;
		line-height: 22px;
		text-transform: uppercase;
		white-space: nowrap;
	}
	.confirmed .tag {
		background: var(--ml-color-success-subtle);
		color: var(--ml-color-success);
	}
	.also-found .tag {
		background: var(--ml-color-warning-subtle);
		color: var(--ml-color-warning);
	}
	.ebody {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
		color: var(--ml-color-text-secondary);
	}
	.etitle {
		font-weight: 600;
		color: var(--ml-color-text);
	}
	.refs {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 12px;
		font-family: var(--ml-font-mono);
		font-size: 12px;
	}
	.refs a {
		color: var(--ml-color-text-link);
		text-decoration: none;
	}
	.refs a:hover {
		text-decoration: underline;
	}
	.dfile {
		border: 1px solid var(--ml-color-border);
		border-radius: 10px;
		background: var(--ml-color-surface-sunken);
		overflow: hidden;
	}
	.dhead {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--ml-color-border);
		font-size: 12px;
		color: var(--ml-color-text-secondary);
	}
	.dhead .mono {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.add {
		color: var(--ms-add);
	}
	.del {
		color: var(--ms-del);
	}
	ms-diff {
		display: block;
		max-height: 320px;
		overflow: auto;
	}
	.test {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		color: var(--ml-color-text-secondary);
	}
	.test ml-icon {
		flex: none;
		color: var(--ml-color-success);
	}
	.test ml-icon[icon='warning'] {
		color: var(--ml-color-warning);
	}
	.test .mono {
		font-size: 11px;
		color: var(--ml-color-text);
	}
	.foot {
		margin: 0;
		font-size: 12px;
		color: var(--ml-color-text-muted);
	}
	.warn {
		display: flex;
		gap: 8px;
		margin: 0;
		padding: 9px 11px;
		border-radius: 8px;
		background: var(--ml-color-warning-subtle);
	}
	.warn ml-icon {
		flex: none;
		margin-top: 1px;
		color: var(--ml-color-warning);
	}
	.none {
		padding: 14px;
		border: 1px dashed var(--ml-color-border);
		border-radius: 10px;
		color: var(--ml-color-text-muted);
	}

	/* ---- the follow-up box: purple, it asks Claude ---- */
	.follow {
		flex: none;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 6px 6px 6px 14px;
		border: 1px solid var(--ms-ai-border);
		border-radius: 10px;
		background: var(--ms-ai-subtle);
	}
	.follow > ml-icon {
		flex: none;
		color: var(--ms-ai);
	}
	.follow input {
		flex: 1;
		min-width: 0;
		height: 34px;
		border: none;
		outline: none;
		background: transparent;
		color: var(--ml-color-text);
		font: inherit;
	}
	.follow input::placeholder {
		color: var(--ml-color-text-muted);
	}
	.follow button {
		all: unset;
		box-sizing: border-box;
		height: 34px;
		padding: 0 14px;
		border: 1px solid var(--ms-ai-border);
		border-radius: 8px;
		background: color-mix(in srgb, var(--ms-ai) 14%, transparent);
		font-size: 13px;
		font-weight: 600;
	}
	.follow button[disabled] {
		opacity: 0.5;
	}

	/* ---- the transcript, for when the report is not the whole story ---- */
	.log {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
		user-select: text;
		-webkit-user-select: text;
	}
	.msg {
		max-width: 820px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		line-height: 1.55;
	}
	.msg.text {
		white-space: normal;
	}
	.msg.user {
		align-self: flex-end;
		padding: 8px 12px;
		border-radius: 10px;
		background: var(--ml-color-primary-subtle);
	}
	.msg.error {
		padding: 8px 12px;
		border-radius: 8px;
		background: var(--ms-diff-del-bg);
		color: var(--ms-del);
	}
	.json {
		margin: 0;
		padding: 10px 12px;
		border-radius: 8px;
		background: var(--ml-color-surface-sunken);
		font-family: var(--ml-font-mono);
		font-size: 12px;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.tool {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 12px;
		color: var(--ml-color-text-muted);
	}
	.tool ml-icon {
		flex: none;
	}
	.tool b {
		flex: none;
		font-weight: 600;
		color: var(--ml-color-text-secondary);
	}
	.tool span {
		min-width: 0;
		font-family: var(--ml-font-mono);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	${richTextStyles}

	/* Narrow panes (the Claude workspace open beside it): one column. */
	@container (max-width: 760px) {
		.cols,
		.two {
			flex-direction: column;
		}
		.side,
		.fix {
			width: auto;
		}
		/* What waits on the user comes first, not under the checklist. */
		.side {
			order: -1;
		}
	}
`;
