import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { effect, untracked } from '@melodicdev/core/signals';
import { html, css } from '@melodicdev/core/template';
import { ToastService } from '@melodicdev/components/toast';
import { RepoStore } from '../../services/repo.store';
import { ExplorerStore } from '../../services/explorer.store';
import type { FileStatus, TreeEntry } from '../../services/backend.service';
import { statusMark } from '../../shared/format';
import { ctxStyles, listStyles } from '../changes/changes.styles';

const INDENT = 14;

const ICONS: Record<string, string> = {
	png: 'file-image',
	jpg: 'file-image',
	jpeg: 'file-image',
	gif: 'file-image',
	webp: 'file-image',
	svg: 'file-image',
	ico: 'file-image',
	md: 'file-text',
	txt: 'file-text',
	log: 'file-text',
	ts: 'file-code',
	tsx: 'file-code',
	js: 'file-code',
	jsx: 'file-code',
	mjs: 'file-code',
	cjs: 'file-code',
	rs: 'file-code',
	py: 'file-code',
	go: 'file-code',
	java: 'file-code',
	cs: 'file-code',
	c: 'file-code',
	h: 'file-code',
	cpp: 'file-code',
	rb: 'file-code',
	php: 'file-code',
	swift: 'file-code',
	kt: 'file-code',
	sh: 'file-code',
	html: 'file-code',
	css: 'file-code',
	scss: 'file-code',
	json: 'file-code',
	yml: 'file-code',
	yaml: 'file-code',
	toml: 'file-code',
	xml: 'file-code',
	sql: 'file-code',
};

function fileIcon(name: string): string {
	return ICONS[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'file';
}

/** Sidebar "Files" tab: the working tree as folders and files. Clicking a file opens it in the editor. */
@MelodicComponent({
	selector: 'ms-explorer',
	template: explorerTemplate,
	styles: () => css`
		:host {
			display: flex;
			flex-direction: column;
			flex: 1;
			min-height: 0;
		}
		${listStyles}
		.head {
			flex: none;
			display: flex;
			align-items: center;
			gap: 4px;
			height: 34px;
			padding: 0 6px 0 10px;
			border-bottom: 1px solid var(--ml-color-border);
			color: var(--ml-color-text-secondary);
			font-weight: 500;
		}
		.head .grow {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.icon {
			all: unset;
			display: grid;
			place-items: center;
			width: 26px;
			height: 26px;
			border-radius: 5px;
			color: var(--ml-color-text-muted);
		}
		.icon:hover {
			background: var(--ms-hover);
			color: var(--ml-color-text);
		}
		.list {
			padding: 4px 0;
		}
		.row {
			gap: 5px;
			min-height: 24px;
			padding-right: 10px;
			border-bottom: 0;
		}
		.row ml-icon {
			flex: none;
			color: var(--ml-color-text-muted);
		}
		.row.sel ml-icon {
			color: inherit;
		}
		.caret {
			flex: none;
			display: grid;
			place-items: center;
			width: 14px;
		}
		.name {
			flex: 1;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.row.ignored .name,
		.row.ignored ml-icon {
			opacity: 0.5;
		}
		.row.add:not(.sel) .name {
			color: var(--ms-add);
		}
		.row.mod:not(.sel) .name {
			color: var(--ms-mod);
		}
		.row.ren:not(.sel) .name {
			color: var(--ms-ren);
		}
		.row.con:not(.sel) .name {
			color: var(--ms-del);
		}
		.dot {
			flex: none;
			width: 7px;
			height: 7px;
			margin-right: 4px;
			border-radius: 50%;
			background: var(--ms-mod);
		}
		.note {
			padding: 14px 12px;
			color: var(--ml-color-text-muted);
		}
		${ctxStyles}
	`,
})
export class ExplorerComponent {
	@Service(RepoStore) readonly store!: RepoStore;
	@Service(ExplorerStore) readonly explorer!: ExplorerStore;
	@Service(ToastService) private readonly _toast!: ToastService;

	/** Right-click menu on a row. */
	menu: { entry: TreeEntry; x: number; y: number } | null = null;

	private readonly _dismiss = (): void => {
		this.menu = null;
	};
	private readonly _focus = (): void => this.explorer.sync();

	onCreate(): void {
		// Anything that changes the working tree (a save, a checkout, a pull) shows up as a new status.
		effect(() => {
			this.store.repo();
			this.store.status();
			untracked(() => this.explorer.sync());
		});
		window.addEventListener('focus', this._focus);
		window.addEventListener('click', this._dismiss);
		window.addEventListener('blur', this._dismiss);
	}

	onDestroy(): void {
		window.removeEventListener('focus', this._focus);
		window.removeEventListener('click', this._dismiss);
		window.removeEventListener('blur', this._dismiss);
	}

	click(entry: TreeEntry, keep = false): void {
		if (!entry.isDir) {
			this.explorer.open(entry.path, keep);
		} else if (!keep) {
			this.explorer.toggle(entry.path);
		}
	}

	openMenu(ev: MouseEvent, entry: TreeEntry): void {
		ev.preventDefault();
		this.menu = { entry, x: Math.min(ev.clientX, window.innerWidth - 220), y: Math.min(ev.clientY, window.innerHeight - 120) };
	}

	async copyPath(path: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(path);
			this._toast.success('Path copied');
		} catch {
			this._toast.error('Could not copy the path');
		}
	}

	/** Jump to this file's diff in the Changes tab. */
	showChanges(path: string): void {
		this.store.setTab('changes');
		this.store.selectFile(path);
	}
}

function explorerTemplate(self: ExplorerComponent) {
	const store = self.store;
	const explorer = self.explorer;
	const children = explorer.children();
	const expanded = explorer.expanded();
	const active = explorer.active();
	const root = children.get('');

	// What git says about each file, and which folders hold a change somewhere below them.
	const changed = new Map<string, FileStatus>();
	const touched = new Set<string>();
	for (const f of store.status()?.files ?? []) {
		if (f.status === 'deleted') {
			continue; // not in the tree
		}
		changed.set(f.path, f.status);
		for (let i = f.path.indexOf('/'); i > 0; i = f.path.indexOf('/', i + 1)) {
			touched.add(f.path.slice(0, i));
		}
	}

	const rows = (dir: string, depth: number): unknown[] =>
		(children.get(dir) ?? []).flatMap((e) => {
			const open = e.isDir && expanded.has(e.path);
			const status = e.isDir ? undefined : changed.get(e.path);
			const mark = status ? statusMark(status) : null;
			const row = html`
				<div
					class="row ${e.path === active ? 'sel' : ''} ${e.ignored ? 'ignored' : ''} ${mark?.tone ?? ''}"
					style="padding-left: ${8 + depth * INDENT}px"
					title=${e.path}
					@click=${() => self.click(e)}
					@dblclick=${() => self.click(e, true)}
					@contextmenu=${(ev: MouseEvent) => self.openMenu(ev, e)}
				>
					<span class="caret">${e.isDir ? html`<ml-icon icon=${open ? 'caret-down' : 'caret-right'} size="xs"></ml-icon>` : ''}</span>
					<ml-icon icon=${e.isDir ? (open ? 'folder-open' : 'folder') : fileIcon(e.name)} size="sm"></ml-icon>
					<span class="name">${e.name}</span>
					${mark ? html`<span class="mark ${mark.tone}" title=${mark.label}>${mark.letter}</span>` : e.isDir && touched.has(e.path) ? html`<span class="dot" title="Contains changes"></span>` : ''}
				</div>
			`;
			return open ? [row, ...rows(e.path, depth + 1)] : [row];
		});

	const m = self.menu?.entry ?? null;
	return html`
		<div class="head">
			<span class="grow">${store.repo()?.name ?? ''}</span>
			<ms-ask-button .scope=${'code'}></ms-ask-button>
			<button class="icon" title="Collapse all folders" @click=${() => explorer.collapseAll()}><ml-icon icon="arrows-in-line-vertical" size="sm"></ml-icon></button>
			<button class="icon" title="Refresh" @click=${() => explorer.rescan()}><ml-icon icon="arrows-clockwise" size="sm"></ml-icon></button>
		</div>
		<div class="list">${!root ? '' : root.length ? rows('', 0) : html`<div class="note">This repository has no files yet.</div>`}</div>
		${m
			? html`
				<div class="ctx" style="left: ${self.menu!.x}px; top: ${self.menu!.y}px">
					${m.isDir
						? html`<div class="ctx-item" @click=${() => explorer.toggle(m.path)}><ml-icon icon=${expanded.has(m.path) ? 'folder' : 'folder-open'} size="sm"></ml-icon>${expanded.has(m.path) ? 'Collapse' : 'Expand'}</div>`
						: html`<div class="ctx-item" @click=${() => explorer.open(m.path, true)}><ml-icon icon="browsers" size="sm"></ml-icon>Open in new tab</div>`}
					${changed.has(m.path) ? html`<div class="ctx-item" @click=${() => self.showChanges(m.path)}><ml-icon icon="git-diff" size="sm"></ml-icon>View changes</div>` : ''}
					<div class="ctx-sep"></div>
					<div class="ctx-item" @click=${() => self.copyPath(m.path)}><ml-icon icon="copy" size="sm"></ml-icon>Copy path</div>
				</div>
			`
			: ''}
	`;
}
