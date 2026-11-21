import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css } from '@melodicdev/core/template';
import { DialogService } from '@melodicdev/components/dialog';
import { AgentsStore, DRAFT_IMAGES } from '../../services/agents.store';
import { RunStore, targetTitle } from '../../services/run.store';

type DialogId = Parameters<DialogService['close']>[0];

const NONE = '\u0000none';

/**
 * Starting an investigation without a spotted error: a bug described in words, with the text
 * selected in a terminal when there was any (`AgentsStore.openInvestigate`). Either is enough.
 */
@MelodicComponent({
	selector: 'ms-investigate-start',
	template: (self: InvestigateStartComponent) => {
		const draft = self.agents.investigateDraft();
		const targets = self.run.targets() ?? [];
		const output = draft?.output ?? '';
		const options = [{ value: NONE, label: 'Let Claude work it out' }, ...targets.map((t) => ({ value: t.id, label: `${targetTitle(t)}  (${t.argv.join(' ')})` }))];
		return html`
			<ml-dialog #investigate-start style="--ml-dialog-max-width: 560px" @ml:close=${() => self.reset()}>
				<h3 slot="dialog-header">Investigate a bug</h3>
				<div class="dlg">
					<p>Claude reproduces it in a worktree of its own, records what happens on the way to the failure, and comes back with the cause, the evidence and a fix. It asks before it runs anything, and your files are not touched.</p>
					<ml-textarea label="What goes wrong?" rows="4" placeholder=${output ? 'Optional: anything the output below does not say' : 'What you did, what you expected, and what happened instead'} .value=${self.description} @ml:input=${(e: CustomEvent) => (self.description = e.detail.value)}></ml-textarea>
					<ms-attach .box=${DRAFT_IMAGES.investigate} .pick=${true}></ms-attach>
					${output ? html`<div class="out"><span class="lbl">From the terminal</span><pre>${output}</pre></div>` : ''}
					${targets.length ? html`<ml-select label="What it happens in" .options=${options} .value=${self.target} @ml:change=${(e: CustomEvent) => (self.target = e.detail.value)}></ml-select>` : ''}
				</div>
				<div slot="dialog-footer" class="foot">
					<ml-button variant="outline" @ml:click=${() => self.close()}>Cancel</ml-button>
					<ml-button variant="primary" ?disabled=${(!self.description.trim() && !output) || !!self.agents.attaching()[DRAFT_IMAGES.investigate]} ?loading=${self.agents.busy()} @ml:click=${() => self.start()}><ml-icon slot="icon-start" icon="sparkle"></ml-icon>Investigate</ml-button>
				</div>
			</ml-dialog>
		`;
	},
	styles: () => css`
		h3 {
			margin: 0;
			font-size: 16px;
			font-weight: 600;
		}
		.dlg {
			display: flex;
			flex-direction: column;
			gap: 14px;
		}
		.dlg p {
			margin: 0;
			line-height: 1.5;
			color: var(--ml-color-text-secondary);
		}
		.out {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}
		.lbl {
			font-size: 12px;
			font-weight: 500;
			color: var(--ml-color-text-secondary);
		}
		pre {
			margin: 0;
			max-height: 180px;
			padding: 8px 10px;
			border: 1px solid var(--ml-color-border);
			border-radius: 8px;
			background: var(--ml-color-surface-sunken);
			font-family: var(--ml-font-mono);
			font-size: 12px;
			line-height: 1.5;
			white-space: pre-wrap;
			overflow: auto;
			overflow-wrap: anywhere;
			user-select: text;
			-webkit-user-select: text;
		}
		.foot {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
			width: 100%;
		}
	`,
})
export class InvestigateStartComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(RunStore) readonly run!: RunStore;
	@Service(DialogService) private readonly _dialogs!: DialogService;

	description = '';
	target = NONE;

	close(): void {
		this._dialogs.close('investigate-start' as DialogId);
	}

	reset(): void {
		this.description = '';
		this.target = NONE;
		this.agents.takeAttached(DRAFT_IMAGES.investigate);
		this.agents.investigateDraft.set(null);
	}

	async start(): Promise<void> {
		const output = this.agents.investigateDraft()?.output ?? '';
		const target = (this.run.targets() ?? []).find((t) => t.id === this.target) ?? null;
		// Taken before the dialog closes: closing it empties the box.
		const request = { description: this.description, error: output ? { text: output } : null, target, command: null, exitCode: null, images: this.agents.takeAttached(DRAFT_IMAGES.investigate) };
		this.close();
		await this.agents.investigate(request);
	}
}
