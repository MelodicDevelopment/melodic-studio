import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { html, repeat, type TemplateResult } from '@melodicdev/core/template';
import { WorkspaceStore, panesOf, type Conversation, type LayoutNode } from '../../services/workspace.store';
import { RepoStore } from '../../services/repo.store';
import { isMac } from '../../services/backend.service';
import { relativeTime } from '../../shared/format';
import { workspaceStyles } from './workspace.styles';
import { stateChip } from './conversation-state';
import './pane.component';

/** The least share of a split one side can be dragged down to. */
const MIN_SHARE = 0.08;

function tree(self: WorkspaceComponent, node: LayoutNode): TemplateResult {
	if (node.type === 'pane') {
		return html`<ms-ws-pane .paneId=${node.id}></ms-ws-pane>`;
	}
	return html`
		<div class="split ${node.dir}" data-split=${node.id}>
			${node.children.map(
				(child, i): TemplateResult => html`
					${i ? html`<div class="divider" @pointerdown=${(e: PointerEvent) => self.startResize(e, node.id, i, node.sizes)} @pointermove=${self.moveResize} @pointerup=${self.endResize} @pointercancel=${self.endResize}></div>` : ''}
					<div class="cell" style="flex: ${node.sizes[i] ?? 1} 1 0">${tree(self, child)}</div>
				`,
			)}
		</div>
	`;
}

function card(self: WorkspaceComponent, c: Conversation, showRepo: boolean) {
	const store = self.store;
	const repo = self.repos.app()?.repos.find((r) => r.id === c.repoId);
	const running = c.subagents.filter((s) => s.running);
	const done = c.subagents.filter((s) => !s.running).slice(-3);
	const said = c.state === 'waiting' ? c.waitingFor : c.lastSaid;
	return html`
		<div class="card ${c.state}" title="Open this conversation" @click=${() => store.open(c.id)}>
			<div class="line">
				${stateChip(c)}
				<span class="title">${c.title}</span>
				${c.unread ? html`<span class="new" title="Something happened since you last looked"></span>` : ''}
				<button
					class="x"
					title=${c.state === 'saved' ? 'Forget this conversation (Claude Code keeps its transcript)' : 'End and forget this conversation'}
					@click=${(e: Event) => (e.stopPropagation(), store.close(c.id, true))}
				>
					<ml-icon icon="x" size="xs"></ml-icon>
				</button>
			</div>
			<div class="line meta">
				${showRepo && repo ? html`<span><ml-icon icon="folder-simple" size="xs"></ml-icon>${repo.name}</span>` : ''}
				<span><ml-icon icon="git-branch" size="xs"></ml-icon>${c.branch ?? 'detached'}</span>
				<span class="when">${relativeTime(c.updated)}</span>
			</div>
			${said ? html`<p class="said ${c.state === 'waiting' ? 'ask' : ''}">${said}</p>` : ''}
			${running.length || done.length
				? html`
					<div class="subs">
						${[...running, ...done].map(
							(s) => html`
								<div class="sub ${s.running ? 'running' : ''}">
									${s.running ? html`<ml-spinner size="xs"></ml-spinner>` : html`<ml-icon icon="check" size="xs"></ml-icon>`}
									<span>${s.description}</span>
									${s.type ? html`<span class="type">${s.type}</span>` : ''}
								</div>
							`,
						)}
					</div>
				`
				: ''}
		</div>
	`;
}

function overview(self: WorkspaceComponent) {
	const all = self.store.conversations().filter((c) => c.kind === 'claude');
	if (!all.length) {
		return html`<div class="overview"><div class="none">No conversations yet. Start one with <b>New conversation</b>.</div></div>`;
	}
	const repos = new Set(all.map((c) => c.repoId));
	const byNewest = (a: Conversation, b: Conversation) => b.updated - a.updated;
	const groups: [string, Conversation[]][] = [
		['Needs you', all.filter((c) => c.state === 'waiting')],
		['Working', all.filter((c) => c.state === 'working' || c.state === 'starting')],
		['Ready', all.filter((c) => c.state === 'idle' || c.state === 'ended')],
		['Saved', all.filter((c) => c.state === 'saved')],
	];
	return html`
		<div class="overview">
			${groups
				.filter(([, list]) => list.length)
				.map(
					([label, list]) => html`
						<h3>${label} · ${list.length}</h3>
						<div class="grid">
							${repeat(
								list.sort(byNewest),
								(c) => c.id,
								(c) => card(self, c, repos.size > 1),
							)}
						</div>
					`,
				)}
		</div>
	`;
}

function bar(self: WorkspaceComponent) {
	const store = self.store;
	const waiting = store.waiting().length;
	const working = store.working();
	const full = store.view() === 'full';
	const parts = [waiting ? html`<b>${waiting} need${waiting === 1 ? 's' : ''} you</b>` : '', working ? `${working} working` : ''].filter(Boolean);
	return html`
		<div class="bar">
			<h2><ml-icon icon="sparkle" size="sm"></ml-icon>Claude</h2>
			<span class="summary">${parts.map((p, i) => html`${i ? ' · ' : ''}${p}`)}</span>
			${self.worktreeForm
				? html`
					<form class="newwt" @submit=${(e: Event) => self.startInWorktree(e)}>
						<input placeholder="New branch for the worktree" .value=${self.branch} @input=${(e: Event) => (self.branch = (e.target as HTMLInputElement).value.replace(/\s+/g, '-'))} @keydown=${(e: KeyboardEvent) => e.key === 'Escape' && self.toggleWorktreeForm()} />
						<button class="label primary" type="submit" ?disabled=${!self.branch.trim()}>Start</button>
						<button class="tool" type="button" title="Cancel" @click=${() => self.toggleWorktreeForm()}><ml-icon icon="x" size="sm"></ml-icon></button>
					</form>
				`
				: html`
					<button class="label primary" title="New Claude conversation in ${store.checkoutName()}" @click=${() => store.newClaude()}><ml-icon icon="plus" size="sm"></ml-icon>New conversation</button>
					<button class="tool" title="New conversation in a new worktree (its own branch and folder)" @click=${() => self.toggleWorktreeForm()}><ml-icon icon="git-fork" size="sm"></ml-icon></button>
					<button class="tool" title="New terminal" @click=${() => store.newShell()}><ml-icon icon="terminal-window" size="sm"></ml-icon></button>
				`}
			<button class="label ${store.overview() ? 'primary' : ''}" title="Every conversation, in every repository" @click=${() => store.showOverview(!store.overview())}>
				<ml-icon icon="squares-four" size="sm"></ml-icon>Overview${waiting ? html`<span class="count">${waiting}</span>` : ''}
			</button>
			<button class="tool" title=${full ? 'Show the files beside it' : 'Fill the window'} @click=${() => store.setView(full ? 'side' : 'full')}><ml-icon icon=${full ? 'arrows-in-simple' : 'arrows-out-simple'} size="sm"></ml-icon></button>
			<button class="tool" title=${`Hide (${isMac() ? '⌘' : 'Ctrl+'}Shift+K). Conversations keep running.`} @click=${() => store.setView('hidden')}><ml-icon icon="caret-right" size="sm"></ml-icon></button>
		</div>
	`;
}

/**
 * The Claude workspace: Claude Code conversations and terminals in split panes
 * (one layout per repository), or an overview of every conversation.
 */
@MelodicComponent({
	selector: 'ms-workspace',
	template: (self: WorkspaceComponent) => {
		const store = self.store;
		const layout = store.layout() ?? store.ensureLayout();
		return html`
			${bar(self)}
			${store.overview() ? overview(self) : html`<div class="root ${self.resizing ? 'resizing' : ''}">${layout ? tree(self, layout) : ''}</div>`}
		`;
	},
	styles: workspaceStyles,
})
export class WorkspaceComponent {
	@Service(WorkspaceStore) readonly store!: WorkspaceStore;
	@Service(RepoStore) readonly repos!: RepoStore;

	elementRef!: HTMLElement;
	worktreeForm = false;
	branch = '';
	resizing = false;
	private _resize: { split: string; at: number; start: number[]; origin: number; length: number; row: boolean } | null = null;

	onCreate(): void {
		window.addEventListener('keydown', this.onKey, true);
	}

	onDestroy(): void {
		window.removeEventListener('keydown', this.onKey, true);
	}

	/** Cmd/Ctrl+\ splits the focused pane. Caught first, or a focused terminal would take it. */
	private readonly onKey = (e: KeyboardEvent): void => {
		if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key !== '\\' || this.store.overview()) {
			return;
		}
		const layout = this.store.layout();
		const pane = layout && (panesOf(layout).find((p) => p.id === this.store.focusedPane()) ?? panesOf(layout)[0]);
		if (pane) {
			e.preventDefault();
			e.stopPropagation();
			this.store.split(pane.id, 'row');
		}
	};

	toggleWorktreeForm(): void {
		this.worktreeForm = !this.worktreeForm;
		this.branch = '';
		if (this.worktreeForm) {
			requestAnimationFrame(() => this.elementRef.shadowRoot?.querySelector<HTMLInputElement>('.newwt input')?.focus());
		}
	}

	startInWorktree(e: Event): void {
		e.preventDefault();
		const branch = this.branch.trim();
		if (!branch) {
			return;
		}
		this.worktreeForm = false;
		this.branch = '';
		void this.store.newClaude({ branch });
	}

	// ---- dragging a divider ----

	readonly startResize = (e: PointerEvent, split: string, at: number, sizes: number[]): void => {
		const el = (e.currentTarget as HTMLElement).parentElement;
		if (!el) {
			return;
		}
		e.preventDefault();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		(e.currentTarget as HTMLElement).classList.add('moving');
		const row = el.classList.contains('row');
		const rect = el.getBoundingClientRect();
		const total = sizes.reduce((a, b) => a + b, 0) || 1;
		this._resize = { split, at, start: sizes.map((s) => s / total), origin: row ? e.clientX : e.clientY, length: row ? rect.width : rect.height, row };
		this.resizing = true;
	};

	readonly moveResize = (e: PointerEvent): void => {
		const r = this._resize;
		if (!r || !r.length) {
			return;
		}
		const delta = ((r.row ? e.clientX : e.clientY) - r.origin) / r.length;
		const sizes = [...r.start];
		const pair = sizes[r.at - 1] + sizes[r.at];
		const before = Math.min(pair - MIN_SHARE, Math.max(MIN_SHARE, sizes[r.at - 1] + delta));
		sizes[r.at - 1] = before;
		sizes[r.at] = pair - before;
		this.store.resize(r.split, sizes);
	};

	readonly endResize = (e: PointerEvent): void => {
		(e.currentTarget as HTMLElement).classList.remove('moving');
		if (this._resize) {
			this._resize = null;
			this.resizing = false;
			this.store.saveLayouts();
		}
	};
}
