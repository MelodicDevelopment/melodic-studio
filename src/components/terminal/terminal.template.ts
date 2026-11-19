import { html } from '@melodicdev/core/template';
import type { TerminalComponent } from './terminal.component';
import type { TermTab } from '../../services/terminal.store';
import type { Run, RunError } from '../../services/run.store';
import { relativeTime } from '../../shared/format';
import { fileName } from '../../shared/paths';

/** A tab's mark: a shell, a run (bars while it runs), or the app an investigation started. */
function tabIcon(t: TermTab, run: Run | null) {
	if (t.kind === 'investigation') {
		return html`<ml-icon class="ai" icon="sparkle" size="xs"></ml-icon>`;
	}
	if (t.kind === 'run') {
		return run?.state === 'running' ? html`<span class="eq" aria-hidden="true"><b></b><b></b><b></b></span>` : html`<ml-icon icon="play" size="xs"></ml-icon>`;
	}
	return html`<ml-icon icon="terminal-window" size="xs"></ml-icon>`;
}

/** "Error spotted": the newest error of the run on screen that has not been dismissed, with the others one click away. */
function errorBar(self: TerminalComponent, run: Run, open: RunError[]) {
	const at = Math.min(self.errorAt, open.length - 1);
	const e = open[open.length - 1 - at];
	// The frames inside the checkout are links into the Files tab; the rest are not files Studio can open.
	const frames = e.frames.filter((f) => self.inCheckout(run, f.file)).slice(0, 4);
	return html`
		<div class="spotted" role="status">
			<div class="row">
				<ml-icon icon="warning-circle" size="sm"></ml-icon>
				<b>${e.kind === 'test' ? 'Test failed' : 'Error spotted'}</b>
				<span class="sum" title=${e.summary}>${e.summary}</span>
				${open.length > 1
					? html`
						<span class="pager">
							<button title="Newer error" ?disabled=${at === 0} @click=${() => (self.errorAt = at - 1)}><ml-icon icon="caret-left" size="xs"></ml-icon></button>
							${at + 1} of ${open.length}
							<button title="Older error" ?disabled=${at >= open.length - 1} @click=${() => (self.errorAt = at + 1)}><ml-icon icon="caret-right" size="xs"></ml-icon></button>
						</span>
					`
					: ''}
				<span class="when">${relativeTime(e.at)}</span>
				<button class="plain" @click=${() => self.dismiss(run, e)}>Dismiss</button>
				<button class="ask" title="Claude reproduces it in a worktree of its own, finds the cause and proposes a fix. Your files are not touched." @click=${() => self.investigate(run, e)}>
					<ml-icon icon="sparkle" size="sm"></ml-icon>Investigate
				</button>
			</div>
			${frames.length
				? html`
					<div class="frames">
						${frames.map(
							(f) => html`<a href="#" title=${f.fn ?? f.file} @click=${(ev: Event) => (ev.preventDefault(), self.openFrame(run, f.file, f.line, f.column))}>${fileName(f.file)}:${f.line}</a>`
						)}
					</div>
				`
				: ''}
		</div>
	`;
}

export function terminalTemplate(self: TerminalComponent) {
	const store = self.terminals;
	const tabs = store.tabs();
	const active = store.active();
	const shown = tabs.find((t) => t.id === active) ?? null;
	const run = self.runs.run(active);
	const open = run?.errors.filter((e) => !e.dismissed) ?? [];

	return html`
		<div class="panel ${store.open() ? '' : 'closed'} ${self.dragging ? 'dragging' : ''}" style="height: ${store.height()}px">
			<div class="grip" title="Drag to resize" @pointerdown=${self.startDrag} @pointermove=${self.moveDrag} @pointerup=${self.endDrag} @pointercancel=${self.endDrag} @dblclick=${() => store.resetHeight()}></div>
			<div class="head">
				<div class="tabs">
					${tabs.map((t) => {
						const r = self.runs.run(t.id);
						const errors = r?.errors.filter((e) => !e.dismissed).length ?? 0;
						return html`
							<div class="ttab ${t.id === active ? 'on' : ''} ${t.ended ? 'ended' : ''} ${t.kind}" title=${t.command ? `${t.command}\n${t.cwd}` : t.cwd} @click=${() => store.select(t.id)} @auxclick=${(e: MouseEvent) => self.closeOnMiddleClick(e, t.id)}>
								${tabIcon(t, r)}
								<span>${t.title}</span>
								${errors ? html`<i class="errs">${errors} ${errors === 1 ? 'error' : 'errors'}</i>` : ''}
								<button title=${t.kind === 'shell' ? 'Close terminal' : 'Close (stops it if it is running)'} @click=${(e: Event) => (e.stopPropagation(), store.close(t.id))}><ml-icon icon="x" size="xs"></ml-icon></button>
							</div>
						`;
					})}
					<button class="tool" title="New terminal (Ctrl+Shift+\`)" @click=${() => store.add()}><ml-icon icon="plus" size="sm"></ml-icon></button>
				</div>
				${shown?.command ? html`<span class="cmd" title=${shown.command}>${shown.command}</span>` : ''}
				<button class="tool ai" title="Investigate: hand Claude the text selected in this terminal, or describe a bug" @click=${() => self.investigateSelection()}><ml-icon icon="sparkle" size="sm"></ml-icon></button>
				<button class="tool" title="Hide terminal (Ctrl+\`)" @click=${() => store.hide()}><ml-icon icon="caret-down" size="sm"></ml-icon></button>
			</div>
			${run && open.length ? errorBar(self, run, open) : ''}
			<div class="screens"></div>
			${tabs.length || store.starting()
				? ''
				: html`
					<div class="none">
						<span>No terminal is open.</span>
						<ml-button variant="outline" size="sm" @ml:click=${() => store.add()}><ml-icon slot="icon-start" icon="plus"></ml-icon>New terminal</ml-button>
					</div>
				`}
		</div>
	`;
}
