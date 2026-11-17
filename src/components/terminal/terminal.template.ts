import { html } from '@melodicdev/core/template';
import type { TerminalComponent } from './terminal.component';

export function terminalTemplate(self: TerminalComponent) {
	const store = self.terminals;
	const tabs = store.tabs();
	const active = store.active();

	return html`
		<div class="panel ${store.open() ? '' : 'closed'} ${self.dragging ? 'dragging' : ''}" style="height: ${store.height()}px">
			<div class="grip" title="Drag to resize" @pointerdown=${self.startDrag} @pointermove=${self.moveDrag} @pointerup=${self.endDrag} @pointercancel=${self.endDrag} @dblclick=${() => store.resetHeight()}></div>
			<div class="head">
				<div class="tabs">
					${tabs.map(
						(t) => html`
							<div class="ttab ${t.id === active ? 'on' : ''} ${t.ended ? 'ended' : ''}" title=${t.cwd} @click=${() => store.select(t.id)} @auxclick=${(e: MouseEvent) => self.closeOnMiddleClick(e, t.id)}>
								<ml-icon icon="terminal-window" size="xs"></ml-icon>
								<span>${t.title}</span>
								<button title="Close terminal" @click=${(e: Event) => (e.stopPropagation(), store.close(t.id))}><ml-icon icon="x" size="xs"></ml-icon></button>
							</div>
						`
					)}
					<button class="tool" title="New terminal (Ctrl+Shift+\`)" @click=${() => store.add()}><ml-icon icon="plus" size="sm"></ml-icon></button>
				</div>
				<button class="tool" title="Hide terminal (Ctrl+\`)" @click=${() => store.hide()}><ml-icon icon="caret-down" size="sm"></ml-icon></button>
			</div>
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
