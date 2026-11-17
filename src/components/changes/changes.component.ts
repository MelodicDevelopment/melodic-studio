import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html } from '@melodicdev/core/template';
import { ToastService } from '@melodicdev/components/toast';
import { RepoStore } from '../../services/repo.store';
import type { FileChange, Operation } from '../../services/backend.service';
import { dirName, fileName, plural, statusMark } from '../../shared/format';
import { changesStyles } from './changes.styles';
import { proposeMenuItem } from '../ai/ai-entry';

/** Sidebar "Changes" tab: the checked file list and the commit form under it. */
@MelodicComponent({
	selector: 'ms-changes',
	template: changesTemplate,
	styles: changesStyles,
})
export class ChangesComponent {
	@Service(RepoStore) readonly store!: RepoStore;
	@Service(ToastService) private readonly _toast!: ToastService;

	/** Right-click menu on a file row. */
	menu: { file: FileChange; x: number; y: number } | null = null;

	private readonly _dismiss = (): void => {
		this.menu = null;
	};

	onCreate(): void {
		window.addEventListener('click', this._dismiss);
		window.addEventListener('blur', this._dismiss);
	}

	onDestroy(): void {
		window.removeEventListener('click', this._dismiss);
		window.removeEventListener('blur', this._dismiss);
	}

	openMenu(ev: MouseEvent, file: FileChange): void {
		ev.preventDefault();
		this.store.selectFile(file.path);
		this.menu = { file, x: Math.min(ev.clientX, window.innerWidth - 220), y: Math.min(ev.clientY, window.innerHeight - 250) };
	}

	async copyPath(file: FileChange): Promise<void> {
		try {
			await navigator.clipboard.writeText(file.path);
			this._toast.success('Path copied');
		} catch {
			this._toast.error('Could not copy the path');
		}
	}

	/** Cmd/Ctrl+Enter in the message fields commits. */
	readonly keydown = (e: KeyboardEvent): void => {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void this.store.commit();
		}
	};
}

const OP_LABEL: Record<Operation, string> = {
	merge: 'Merge',
	rebase: 'Rebase',
	'cherry-pick': 'Cherry-pick',
	revert: 'Revert',
	squash: 'Squash merge',
};

function changesTemplate(self: ChangesComponent) {
	const store = self.store;
	const st = store.status();
	const files = st?.files ?? [];
	const excluded = store.excluded();
	const included = files.length - excluded.size;
	const selected = store.selectedPath();
	const busy = store.busy();
	const placeholder = store.defaultSummary();
	const amend = store.amend();
	const canCommit = (included > 0 || amend) && !!(store.summary().trim() || placeholder) && !busy;
	const conflicts = files.filter((f) => f.status === 'conflicted').length;
	const op = st?.operation ?? null;
	const stash = st?.stashes[0] ?? null;
	const m = self.menu?.file ?? null;

	return html`
		<div class="head">
			<span class="check"><ml-checkbox size="sm" .checked=${files.length > 0 && included === files.length} .indeterminate=${included > 0 && included < files.length} ?disabled=${files.length === 0} @ml:change=${(e: CustomEvent) => store.toggleAll(e.detail.checked)}></ml-checkbox></span>
			<span class="grow">${plural(files.length, 'changed file')}</span>
			${files.length && !op ? html`<button class="icon" title="Stash all changes" ?disabled=${!!busy} @click=${() => store.stash()}><ml-icon icon="archive" size="sm"></ml-icon></button>` : ''}
			${files.length ? html`<button class="icon" title="Discard all changes…" @click=${() => store.ask('discard', { files })}><ml-icon icon="arrow-counter-clockwise" size="sm"></ml-icon></button>` : ''}
		</div>

		<div class="list">
			${files.map((f) => {
				const mark = statusMark(f.status);
				return html`
					<div class="row ${f.path === selected ? 'sel' : ''}" title=${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} @click=${() => store.selectFile(f.path)} @contextmenu=${(e: MouseEvent) => self.openMenu(e, f)}>
						<span class="check" @click=${(e: Event) => e.stopPropagation()}><ml-checkbox size="sm" .checked=${!excluded.has(f.path)} @ml:change=${(e: CustomEvent) => store.toggleFile(f.path, e.detail.checked)}></ml-checkbox></span>
						<span class="path"><span class="dir">${dirName(f.path)}</span><span class="file">${fileName(f.path)}</span></span>
						<span class="mark ${mark.tone}" title=${mark.label}>${mark.letter}</span>
					</div>
				`;
			})}
		</div>

		${stash
			? html`
				<div class="banner plain">
					<ml-icon icon="archive" size="sm"></ml-icon>
					<span class="grow" title=${stash.message}>Stashed changes${st!.stashes.length > 1 ? ` (${st!.stashes.length})` : ''}</span>
					<a @click=${() => store.stashPop(stash.name)}>Restore</a>
					<a @click=${() => store.stashDrop(stash.name)}>Discard</a>
				</div>
			`
			: ''}

		${op
			? html`
				<div class="banner">
					<ml-icon icon="git-merge" size="sm"></ml-icon>
					<span class="grow">${conflicts ? `${OP_LABEL[op]} stopped: ${plural(conflicts, 'conflicted file')} to resolve.` : `${OP_LABEL[op]} in progress.`}</span>
					<a @click=${() => store.continueOperation()}>Continue</a>
					<a @click=${() => store.abortOperation()}>Abort</a>
				</div>
			`
			: ''}

		<ms-ai-commit-suggestion></ms-ai-commit-suggestion>
		<div class="commit" @keydown=${self.keydown}>
			<ml-input size="sm" placeholder=${placeholder || 'Summary (required)'} .value=${store.summary()} @ml:input=${(e: CustomEvent) => store.summary.set(e.detail.value)}><ms-ai-commit-button slot="suffix"></ms-ai-commit-button></ml-input>
			<ml-textarea size="sm" rows="3" placeholder="Description" .value=${store.description()} @ml:input=${(e: CustomEvent) => store.description.set(e.detail.value)}></ml-textarea>
			<ml-button variant="primary" full-width ?disabled=${!canCommit} ?loading=${busy === 'commit'} @ml:click=${() => store.commit()}>
				${amend ? 'Amend last commit' : included ? html`Commit ${plural(included, 'file')} to <b>${st?.branch ?? ''}</b>` : 'Select files to commit'}
			</ml-button>
			${st?.undo ? html`<ml-checkbox size="sm" label="Amend last commit" .checked=${amend} @ml:change=${(e: CustomEvent) => store.setAmend(e.detail.checked)}></ml-checkbox>` : ''}
		</div>

		<ms-ai-review-banner></ms-ai-review-banner>
		${st?.undo
			? html`
				<div class="undo">
					<span class="grow"><span class="k">Last commit, not pushed yet</span><span class="v">${st.undo.summary}</span></span>
					<ml-button variant="outline" size="sm" ?disabled=${!!busy} ?loading=${busy === 'undo'} @ml:click=${() => store.undoCommit()}>Undo</ml-button>
				</div>
			`
			: ''}

		${m
			? html`
				<div class="ctx" style="left: ${self.menu!.x}px; top: ${self.menu!.y}px">
					<div class="ctx-item" @click=${() => store.openTab(m.path)}><ml-icon icon="browsers" size="sm"></ml-icon>Open in new tab</div>
					${m.status === 'conflicted'
						? html`
							<div class="ctx-item" @click=${() => store.resolveFile(m.path, 'mine')}><ml-icon icon="user" size="sm"></ml-icon>Resolve using my version</div>
							<div class="ctx-item" @click=${() => store.resolveFile(m.path, 'theirs')}><ml-icon icon="users" size="sm"></ml-icon>Resolve using their version</div>
							${proposeMenuItem(m)}
						`
						: ''}
					<div class="ctx-sep"></div>
					<div class="ctx-item danger" @click=${() => store.ask('discard', { files: [m] })}><ml-icon icon="arrow-counter-clockwise" size="sm"></ml-icon>Discard changes…</div>
					${m.status === 'untracked' ? html`<div class="ctx-item" @click=${() => store.ignoreFile(m.path)}><ml-icon icon="eye-slash" size="sm"></ml-icon>Ignore file (add to .gitignore)</div>` : ''}
					<div class="ctx-item" @click=${() => self.copyPath(m)}><ml-icon icon="copy" size="sm"></ml-icon>Copy file path</div>
				</div>
			`
			: ''}
	`;
}
