import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, css, repeat } from '@melodicdev/core/template';
import { DialogService } from '@melodicdev/components/dialog';
import { AgentsStore, lastSaid, type AgentSession } from '../../services/agents.store';
import { asAppError, type ChangedFile, type WorktreeDiff } from '../../services/backend.service';
import { parseDiff, type ParsedDiff } from '../../shared/diff';
import { dirName, fileName, plural, statusMark } from '../../shared/format';
import { listStyles } from '../changes/changes.styles';
import { stateChip, stateStyles } from './agent-state';

type DialogId = Parameters<DialogService['close']>[0];

/** What one attempt has changed since the commit it started from. */
interface Loaded {
	loading: boolean;
	error: string | null;
	data: WorktreeDiff | null;
	/** One parsed diff per file in `data.files`. */
	parsed: ParsedDiff[];
	/** Cheap fingerprint of `data`, to leave the screen alone when a refresh finds nothing new. */
	mark: string;
}

function emptyText(file: ChangedFile, tooLarge: boolean): string {
	if (tooLarge && !file.diff) {
		return 'Left out: this comparison is too large to show in full.';
	}
	if (file.status === 'added' || file.status === 'untracked') {
		return 'This file is empty.';
	}
	return file.status === 'renamed' ? 'Renamed without changes.' : 'No content changes.';
}

function column(self: AttemptsComponent, s: AgentSession, count: Map<string, number>, total: number) {
	const agents = self.agents;
	const running = s.status === 'running';
	const l = self.loaded.get(s.id);
	const files = l?.data?.files ?? [];
	const added = l?.parsed.reduce((n, d) => n + d.added, 0) ?? 0;
	const removed = l?.parsed.reduce((n, d) => n + d.removed, 0) ?? 0;
	const said = lastSaid(s);
	return html`
		<section class="col">
			<header>
				<div class="top">
					<span class="name">Attempt ${s.attempt}</span>
					${stateChip(s)}
					<span class="grow"></span>
					${files.length ? html`<span class="dim">${plural(files.length, 'file')}</span><span class="stat add">+${added}</span><span class="stat del">−${removed}</span>` : ''}
					${s.cost ? html`<span class="dim">$${s.cost.toFixed(2)}</span>` : ''}
				</div>
				<div class="branch" title=${s.cwd}><ml-icon icon="git-branch" size="sm"></ml-icon><span>${s.branch ?? 'detached'}</span></div>
				<p class="said" title=${said}>${said || (running ? 'Working…' : 'It has not said anything yet.')}</p>
				<div class="acts">
					<ml-button variant="outline" size="xs" @ml:click=${() => agents.select(s.id)}>Transcript</ml-button>
					<ml-button variant="outline" size="xs" ?disabled=${running} title="Switch the app to this attempt's worktree" @ml:click=${() => agents.review(s)}>Review changes</ml-button>
					<span class="grow"></span>
					<ml-button variant="primary" size="xs" ?disabled=${agents.busy()} @ml:click=${() => self.askKeep(s)}><ml-icon slot="icon-start" icon="check"></ml-icon>Keep this one</ml-button>
				</div>
			</header>
			${!l || (l.loading && !l.data && !l.error)
				? html`<div class="state"><ml-spinner size="md"></ml-spinner></div>`
				: l.error
					? html`<div class="state bad"><ml-icon icon="warning" size="lg"></ml-icon><div>${l.error}</div></div>`
					: !files.length
						? html`<div class="state"><ml-icon icon="files" size="lg"></ml-icon><div>${running ? 'No changes yet.' : 'This attempt changed nothing.'}</div></div>`
						: html`
							<div class="files">
								${files.map((f) => {
									const mark = statusMark(f.status);
									return html`
										<div class="row ${f.path === self.path ? 'sel' : ''}" title=${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} @click=${() => self.show(f.path)}>
											<span class="path"><span class="dir">${dirName(f.path)}</span><span class="file">${fileName(f.path)}</span></span>
											${total > 1 && count.get(f.path) === 1 ? html`<span class="only" title="No other attempt touched this file">only here</span>` : ''}
											<span class="mark ${mark.tone}" title=${mark.label}>${mark.letter}</span>
										</div>
									`;
								})}
							</div>
							<div class="diffs">
								${l.data?.tooLarge ? html`<div class="toolarge">This attempt changed a lot: some diffs are left out. Review its worktree to see everything.</div>` : ''}
								${files.map((f, i) => {
									const diff = l.parsed[i];
									return html`
										<div class="filediff" data-path=${f.path}>
											<div class="fhead">
												<span class="path">${f.oldPath ? html`<span class="dir">${f.oldPath} → </span>` : ''}<span class="dir">${dirName(f.path)}</span><span class="file">${fileName(f.path)}</span></span>
												${diff && !diff.binary && (diff.added || diff.removed) ? html`<span class="stat add">+${diff.added}</span><span class="stat del">−${diff.removed}</span>` : ''}
											</div>
											<ms-diff .diff=${diff} .emptyText=${emptyText(f, !!l.data?.tooLarge)}></ms-diff>
										</div>
									`;
								})}
							</div>
						`}
		</section>
	`;
}

/**
 * Main pane of the Agents tab while a group of parallel attempts is being compared: one column
 * per attempt with its status, the files it changed and its whole diff against the commit it
 * started from (uncommitted and untracked work included), and "Keep this one".
 */
@MelodicComponent({
	selector: 'ms-attempts',
	template: (self: AttemptsComponent) => {
		const agents = self.agents;
		const sessions = self.sessions();
		const keeping = self.keeping;
		const others = keeping ? sessions.filter((s) => s.id !== keeping.id) : [];
		// How many attempts touched each file, to point out what only one of them did.
		const count = new Map<string, number>();
		let loaded = 0;
		for (const s of sessions) {
			const data = self.loaded.get(s.id)?.data;
			loaded += data ? 1 : 0;
			for (const f of data?.files ?? []) {
				count.set(f.path, (count.get(f.path) ?? 0) + 1);
			}
		}
		const base = sessions[0]?.base;
		return html`
			<div class="bar">
				<ml-icon icon="columns" size="md"></ml-icon>
				<div class="grow">
					<h2>${sessions[0]?.title ?? ''}</h2>
					<div class="sub">${sessions.length} attempts at the same task, each in its own worktree${base ? html`, compared with where they started (<code>${base.slice(0, 7)}</code>)` : ''}. Uncommitted and untracked work is included.</div>
				</div>
				<ml-button variant="ghost" size="sm" @ml:click=${() => self.reload()}><ml-icon slot="icon-start" icon="arrows-clockwise"></ml-icon>Refresh</ml-button>
				<ml-button variant="outline" size="sm" @ml:click=${() => agents.select(agents.selectedId() ?? sessions[0]?.id ?? null)}>Close</ml-button>
			</div>
			<div class="cols">
				${repeat(
					sessions,
					(s) => s.id,
					(s) => column(self, s, count, loaded)
				)}
			</div>

			<ml-dialog #keep-attempt style="--ml-dialog-max-width: 480px">
				<h3 slot="dialog-header">Keep attempt ${keeping?.attempt ?? ''}?</h3>
				<div class="dlg">
					<p><b>${keeping?.branch ?? ''}</b> stays, with its worktree and its conversation.</p>
					<p>
						${others.length === 1 ? 'The other attempt is' : `The other ${others.length} attempts are`} removed for good: the ${others.length === 1 ? 'worktree and branch' : 'worktrees and branches'}
						<b>${others.map((o) => o.branch).join(', ')}</b> are deleted, along with any work in them, committed or not${others.some((o) => o.status === 'running') ? '. Attempts still working are stopped first' : ''}.
					</p>
				</div>
				<div slot="dialog-footer" class="foot">
					<ml-button variant="outline" @ml:click=${() => self.close()}>Cancel</ml-button>
					<ml-button variant="danger" ?loading=${agents.busy()} @ml:click=${() => self.confirmKeep()}>Keep attempt ${keeping?.attempt ?? ''}, delete the rest</ml-button>
				</div>
			</ml-dialog>
		`;
	},
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
		}
		${listStyles}
		${stateStyles}
		.bar {
			flex: none;
			display: flex;
			align-items: center;
			gap: 10px;
			padding: 12px 16px;
			border-bottom: 1px solid var(--ml-color-border);
		}
		.bar > ml-icon {
			flex: none;
			color: var(--ml-color-primary);
		}
		h2 {
			margin: 0;
			font-size: 15px;
			font-weight: 600;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.sub {
			margin-top: 3px;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		code {
			font-family: var(--ml-font-mono);
		}
		.cols {
			flex: 1;
			min-height: 0;
			display: flex;
			overflow-x: auto;
		}
		.col {
			flex: 1 1 0;
			min-width: 340px;
			min-height: 0;
			display: flex;
			flex-direction: column;
		}
		.col + .col {
			border-left: 1px solid var(--ml-color-border);
		}
		header {
			flex: none;
			display: flex;
			flex-direction: column;
			gap: 6px;
			padding: 10px 12px;
			border-bottom: 1px solid var(--ml-color-border);
			background: var(--ms-sidebar-bg);
		}
		.top,
		.branch,
		.acts {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.name {
			font-weight: 600;
		}
		.dim {
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.branch {
			gap: 5px;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}
		.branch span {
			min-width: 0;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.said {
			margin: 0;
			min-height: 36px;
			font-size: 12px;
			line-height: 18px;
			color: var(--ml-color-text-secondary);
			display: -webkit-box;
			-webkit-line-clamp: 2;
			-webkit-box-orient: vertical;
			overflow: hidden;
		}
		.stat {
			flex: none;
			font-family: var(--ml-font-mono);
			font-size: 12px;
			font-weight: 600;
		}
		.stat.add {
			color: var(--ms-add);
		}
		.stat.del {
			color: var(--ms-del);
		}
		.state {
			flex: 1;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 10px;
			padding: 24px;
			text-align: center;
			color: var(--ml-color-text-muted);
		}
		.state.bad {
			color: var(--ms-del);
			user-select: text;
			-webkit-user-select: text;
			overflow-wrap: anywhere;
		}
		.files {
			flex: none;
			max-height: 28%;
			overflow-y: auto;
			border-bottom: 1px solid var(--ml-color-border);
			background: var(--ms-sidebar-bg);
		}
		.only {
			flex: none;
			padding: 0 6px;
			border-radius: 999px;
			background: var(--ml-color-primary-subtle);
			color: var(--ml-color-primary);
			font-size: 10px;
			font-weight: 600;
			line-height: 16px;
		}
		.row.sel .only {
			background: none;
			color: inherit;
		}
		.diffs {
			flex: 1;
			min-height: 0;
			overflow-y: auto;
		}
		.toolarge {
			padding: 8px 12px;
			background: var(--ml-color-warning-subtle);
			font-size: 12px;
		}
		.fhead {
			position: sticky;
			top: 0;
			z-index: 1;
			display: flex;
			align-items: center;
			gap: 9px;
			height: 30px;
			padding: 0 12px;
			border-bottom: 1px solid var(--ml-color-border);
			background: var(--ml-color-surface);
			font-size: 12px;
		}
		.filediff + .filediff .fhead {
			border-top: 1px solid var(--ml-color-border);
		}
		.fhead .file {
			font-weight: 600;
		}
		/* Each file's diff is as tall as its lines here; the column scrolls, not the diff. */
		ms-diff {
			height: auto;
			min-height: 30px;
		}
		h3 {
			margin: 0;
			font-size: 16px;
			font-weight: 600;
		}
		.dlg {
			display: flex;
			flex-direction: column;
			gap: 12px;
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
		.foot {
			display: flex;
			justify-content: flex-end;
			gap: 8px;
			width: 100%;
		}
	`,
})
export class AttemptsComponent {
	@Service(AgentsStore) readonly agents!: AgentsStore;
	@Service(DialogService) private readonly _dialogs!: DialogService;
	elementRef!: HTMLElement;

	/** What each attempt has changed, by session id. */
	loaded: ReadonlyMap<string, Loaded> = new Map();
	/** The file picked in any column; every column that has it scrolls to it. */
	path: string | null = null;
	/** The attempt the "Keep this one" dialog is about. */
	keeping: AgentSession | null = null;

	private _signature = '';
	private _poll: ReturnType<typeof setInterval> | null = null;
	private _gone = false;

	sessions(): AgentSession[] {
		const group = this.agents.comparing();
		return group ? this.agents.attempts(group) : [];
	}

	onCreate(): void {
		// While an attempt is still working its diff keeps growing.
		this._poll = setInterval(() => {
			if (document.visibilityState === 'visible' && this.sessions().some((s) => s.status === 'running')) {
				void this.reload(true);
			}
		}, 5000);
	}

	onDestroy(): void {
		this._gone = true;
		if (this._poll) {
			clearInterval(this._poll);
		}
	}

	/** Read the diffs again whenever the group changes or one of its attempts starts or stops. */
	onRender(): void {
		const signature = this.sessions()
			.map((s) => `${s.id}:${s.status}`)
			.join('|');
		if (signature !== this._signature) {
			this._signature = signature;
			queueMicrotask(() => void this.reload(this.loaded.size > 0));
		}
	}

	/** `quiet` keeps what is on screen until the new diff is in, and leaves it alone if nothing changed. */
	async reload(quiet = false): Promise<void> {
		const sessions = this.sessions();
		const blank: Loaded = { loading: true, error: null, data: null, parsed: [], mark: '' };
		this.loaded = new Map(sessions.map((s) => [s.id, quiet ? (this.loaded.get(s.id) ?? blank) : { ...(this.loaded.get(s.id) ?? blank), loading: true, error: null }]));
		await Promise.all(
			sessions.map(async (s) => {
				let next: Loaded;
				try {
					const data = await this.agents.changes(s);
					const mark = `${data.base} ${data.head} ${data.tooLarge} ${data.files.map((f) => `${f.path}:${f.status}:${f.diff.length}`).join(' ')}`;
					const before = this.loaded.get(s.id);
					if (before?.data && before.mark === mark && !before.loading) {
						return;
					}
					next = { loading: false, error: null, data, parsed: before?.mark === mark ? before.parsed : data.files.map((f) => parseDiff(f.diff)), mark };
				} catch (e) {
					next = { loading: false, error: asAppError(e).message, data: null, parsed: [], mark: '' };
				}
				if (!this._gone && this.loaded.has(s.id)) {
					this.loaded = new Map(this.loaded).set(s.id, next);
				}
			})
		);
	}

	/** Bring one file's diff to the top of every column that has it. */
	show(path: string): void {
		this.path = path;
		requestAnimationFrame(() => {
			this.elementRef.shadowRoot?.querySelectorAll<HTMLElement>('.filediff').forEach((el) => {
				if (el.dataset.path === path) {
					el.scrollIntoView({ block: 'start' });
				}
			});
		});
	}

	askKeep(session: AgentSession): void {
		this.keeping = session;
		this._dialogs.open('keep-attempt' as DialogId);
	}

	close(): void {
		this._dialogs.close('keep-attempt' as DialogId);
	}

	async confirmKeep(): Promise<void> {
		const session = this.keeping;
		if (!session) {
			return;
		}
		// Closed first: keeping an attempt ends the comparison, and this dialog goes with it.
		this.close();
		await this.agents.keep(session);
	}
}
