import type * as Monaco from 'monaco-editor';
import { MelodicComponent } from '@melodicdev/core/components';
import { Service } from '@melodicdev/core/injection';
import { effect, untracked } from '@melodicdev/core/signals';
import { EditorSettingsStore } from '../../services/editor-settings.store';
import { html, css } from '@melodicdev/core/template';
import { RepoStore } from '../../services/repo.store';
import { ExplorerStore, type OpenFile } from '../../services/explorer.store';
import { isMac } from '../../services/backend.service';
import { dirName, fileName, relativeTime } from '../../shared/format';
import { RunStore } from '../../services/run.store';
import { adoptMonacoStyles, loadMonaco, releaseMonacoStyles } from '../../shared/monaco';

function message(icon: string, text: string) {
	return html`<div class="state"><ml-icon icon=${icon} size="lg"></ml-icon><div>${text}</div></div>`;
}

function stateOf(self: EditorComponent, tab: OpenFile | null) {
	if (!tab) {
		return message('files', 'Pick a file on the left to view or edit it.');
	}
	switch (tab.kind) {
		case 'binary':
			return message('file-image', 'Binary file. There is nothing to show as text.');
		case 'large':
			return message('file-dashed', 'This file is too large to open here.');
		case 'missing':
			return message('file-x', 'This file no longer exists.');
		case 'loading':
			return html`<div class="state"><ml-spinner size="md"></ml-spinner></div>`;
		default:
			return self.ready ? '' : html`<div class="state"><ml-spinner size="md"></ml-spinner></div>`;
	}
}

/** The main pane of the Files tab: open files as tabs over one Monaco editor. */
@MelodicComponent({
	selector: 'ms-editor',
	template: (self: EditorComponent) => {
		const explorer = self.explorer;
		const tabs = explorer.tabs();
		const tab = explorer.activeTab();
		const preview = explorer.preview();
		const notice = explorer.notice();
		const saving = explorer.saving();
		const changed = !!tab && !!self.store.status()?.files.some((f) => f.path === tab.path);
		return html`
			${tabs.length
				? html`
					<div class="filetabs">
						${tabs.map(
							(t) => html`
								<div class="filetab ${t === tab ? 'on' : ''} ${t.path === preview ? 'preview' : ''} ${t.dirty ? 'dirty' : ''}" title=${explorer.absolutePath(t.path) ?? t.path} @click=${() => explorer.open(t.path)} @dblclick=${() => explorer.open(t.path, true)}>
									<span>${fileName(t.path)}</span>
									<button title=${t.dirty ? 'Close (unsaved changes)' : 'Close tab'} @click=${(e: Event) => (e.stopPropagation(), explorer.close(t.path))}>
										<ml-icon class="x" icon="x" size="xs"></ml-icon><i class="dot"></i>
									</button>
								</div>
							`
						)}
					</div>
				`
				: ''}
			${tab
				? html`
					<div class="filehead">
						<span class="path"><span class="dir">${dirName(tab.path)}</span><span class="file">${fileName(tab.path)}</span></span>
						<ms-lsp-status></ms-lsp-status>
						${tab.dirty ? html`<span class="hint">Unsaved · ${isMac() ? '⌘S' : 'Ctrl+S'}</span>` : ''}
						${changed ? html`<ml-button variant="ghost" size="sm" @ml:click=${() => self.showChanges(tab.path)}>View changes</ml-button>` : ''}
						${tab.dirty ? html`<ml-button variant="outline" size="sm" ?loading=${saving === tab.path} @ml:click=${() => explorer.save(tab.path)}>Save</ml-button>` : ''}
					</div>
				`
				: ''}
			${notice
				? html`
					<div class="notice">
						<ml-icon icon="warning" size="sm"></ml-icon>
						${notice.kind === 'close'
							? html`
								<span class="grow"><b>${fileName(notice.path)}</b> has unsaved changes.</span>
								<ml-button variant="primary" size="sm" ?loading=${saving === notice.path} @ml:click=${() => explorer.saveAndClose(notice.path)}>Save</ml-button>
								<ml-button variant="outline" size="sm" @ml:click=${() => explorer.close(notice.path, true)}>Don't save</ml-button>
							`
							: html`
								<span class="grow"><b>${fileName(notice.path)}</b> changed on disk since you opened it.</span>
								<ml-button variant="primary" size="sm" ?loading=${saving === notice.path} @ml:click=${() => explorer.save(notice.path, true)}>Overwrite</ml-button>
								<ml-button variant="outline" size="sm" @ml:click=${() => explorer.revert(notice.path)}>Reload from disk</ml-button>
							`}
						<ml-button variant="ghost" size="sm" @ml:click=${() => explorer.dismissNotice()}>Cancel</ml-button>
					</div>
				`
				: ''}
			<div class="body">
				<!-- monaco-component: with fixedOverflowWidgets the context menu is attached here, outside .monaco-editor,
				     and Monaco defines its theme colours (--vscode-*) only on those two classes. -->
				<div class="host monaco-component ${tab?.kind === 'text' && self.ready ? '' : 'off'}"></div>
				${stateOf(self, tab)}
			</div>
		`;
	},
	styles: () => css`
		:host {
			flex: 1;
			min-width: 0;
			min-height: 0;
			display: flex;
			flex-direction: column;
			background: var(--ml-color-surface);
		}
		.grow {
			flex: 1;
			min-width: 0;
		}

		/* ---- open file tabs (as in the Changes pane) ---- */
		.filetabs {
			flex: none;
			display: flex;
			overflow-x: auto;
			background: var(--ms-sidebar-bg);
			border-bottom: 1px solid var(--ml-color-border);
			scrollbar-width: none;
		}
		.filetab {
			flex: none;
			display: flex;
			align-items: center;
			gap: 6px;
			max-width: 220px;
			height: 32px;
			padding: 0 8px 0 12px;
			border-right: 1px solid var(--ml-color-border);
			color: var(--ml-color-text-muted);
			box-shadow: inset 0 -2px 0 transparent;
		}
		.filetab span {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.filetab:hover {
			color: var(--ml-color-text);
		}
		.filetab.on {
			background: var(--ml-color-surface);
			color: var(--ml-color-text);
			box-shadow: inset 0 -2px 0 var(--ml-color-primary);
		}
		.filetab.preview span {
			font-style: italic;
		}
		.filetab button {
			all: unset;
			flex: none;
			display: grid;
			place-items: center;
			width: 18px;
			height: 18px;
			border-radius: 4px;
		}
		.filetab button:hover {
			background: var(--ms-hover);
		}
		.filetab .dot {
			display: none;
			width: 8px;
			height: 8px;
			border-radius: 50%;
			background: currentColor;
		}
		/* Unsaved: a dot where the close button is, until the pointer is over it. */
		.filetab.dirty button:not(:hover) .x {
			display: none;
		}
		.filetab.dirty button:not(:hover) .dot {
			display: block;
		}

		.filehead {
			flex: none;
			display: flex;
			align-items: center;
			gap: 9px;
			height: 36px;
			padding: 0 8px 0 14px;
			border-bottom: 1px solid var(--ml-color-border);
		}
		.path {
			flex: 1;
			min-width: 0;
			display: flex;
			white-space: nowrap;
		}
		.dir {
			flex: 0 1 auto;
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			color: var(--ml-color-text-muted);
		}
		.file {
			flex: none;
			font-weight: 600;
		}
		.hint {
			flex: none;
			font-size: 12px;
			color: var(--ml-color-text-muted);
		}

		.notice {
			flex: none;
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 6px 8px 6px 14px;
			border-bottom: 1px solid var(--ml-color-border);
			background: var(--ml-color-warning-subtle);
		}
		.notice .grow {
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		.body {
			flex: 1;
			min-height: 0;
			position: relative;
		}
		.host {
			position: absolute;
			inset: 0;
			/* Monaco's menus, hovers and suggestions size their corners, borders and shadows with these,
			   and only VS Code itself defines them: the standalone editor leaves them unset. */
			--vscode-cornerRadius-small: var(--ml-radius-xs);
			--vscode-cornerRadius-medium: var(--ml-radius-sm);
			--vscode-cornerRadius-large: var(--ml-radius-md);
			--vscode-cornerRadius-xLarge: var(--ml-radius-lg);
			--vscode-cornerRadius-circle: var(--ml-radius-full);
			--vscode-strokeThickness: 1px;
			--vscode-shadow-md: var(--ml-shadow-md);
			--vscode-shadow-lg: var(--ml-shadow-lg);
			--vscode-shadow-xl: var(--ml-shadow-xl);
		}
		.host.off {
			visibility: hidden;
		}
		/* Where a run crashed (RunStore.crashes): a red line, a bar in the margin and a note after the code. */
		.ms-crash-line {
			background: var(--ms-diff-del-bg);
		}
		.ms-crash-gutter {
			margin-left: 4px;
			width: 3px !important;
			background: var(--ml-color-danger);
		}
		.ms-crash-note {
			margin-left: 28px;
			font-family: var(--ml-font-sans);
			font-size: 12px;
			color: var(--ml-color-danger);
		}
		.state {
			position: absolute;
			inset: 0;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 10px;
			color: var(--ml-color-text-muted);
		}
	`,
})
export class EditorComponent {
	@Service(RepoStore) readonly store!: RepoStore;
	@Service(ExplorerStore) readonly explorer!: ExplorerStore;
	@Service(EditorSettingsStore) private readonly _settings!: EditorSettingsStore;
	@Service(RunStore) private readonly _runs!: RunStore;

	elementRef!: HTMLElement;
	/** Monaco is loaded and mounted. */
	ready = false;

	private _editor: Monaco.editor.IStandaloneCodeEditor | null = null;
	/** The path whose model the editor holds. */
	private _shown: string | null = null;
	private _token = 0;
	private _gone = false;
	private _crashMarks: Monaco.editor.IEditorDecorationsCollection | null = null;
	private _crashClock = 0;

	onCreate(): void {
		this.explorer.sync();
		void this.mount();
		// A run crashing (or its error being dismissed) marks the file on screen at once.
		effect(() => {
			this._runs.crashes();
			untracked(() => this.markCrashes());
		});
		// "2 min ago" keeps up with the clock.
		this._crashClock = window.setInterval(() => this.markCrashes(), 60_000);
		// Settings changes apply to the open editor at once.
		effect(() => {
			this._settings.settings();
			untracked(() => this.applySettings());
		});
	}

	/** The editor options that Settings > Editor controls. */
	private options(): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions {
		const s = this._settings.settings();
		return {
			fontFamily: this._settings.font(),
			fontSize: s.fontSize,
			lineHeight: this._settings.lineHeightPx(),
			fontLigatures: s.ligatures,
			wordWrap: s.wordWrap ? 'on' : 'off',
			minimap: { enabled: s.minimap },
			lineNumbers: s.lineNumbers ? 'on' : 'off',
			stickyScroll: { enabled: s.stickyScroll },
			bracketPairColorization: { enabled: s.bracketColors },
			guides: { bracketPairs: s.bracketColors ? 'active' : false, indentation: true },
			renderWhitespace: s.whitespace,
			cursorBlinking: s.cursorBlink ? 'blink' : 'solid',
			detectIndentation: s.tabSize === 0,
			...(s.tabSize ? { tabSize: s.tabSize } : {}),
			rulers: this._settings.rulers(this._shown ? this.explorer.configFor(this._shown).maxLineLength : undefined),
		};
	}

	/** Indentation for the file on screen: `.editorconfig` first, then Settings' tab size, else what Monaco detected. */
	private indent(model: Monaco.editor.ITextModel | null, path: string | null): void {
		if (!model || !path) {
			return;
		}
		const ec = this.explorer.configFor(path);
		const size = ec.indentSize ?? ec.tabWidth ?? (this._settings.settings().tabSize || undefined);
		model.updateOptions({ ...(size ? { tabSize: size, indentSize: size } : {}), ...(ec.indentStyle ? { insertSpaces: ec.indentStyle === 'space' } : {}) });
	}

	/** Cmd/Ctrl+S: format first when Settings asks (the language server's formatter, or Monaco's own), then save. */
	private async saveShown(): Promise<void> {
		const path = this._shown;
		const editor = this._editor;
		if (!path || !editor) {
			return;
		}
		if (this._settings.settings().formatOnSave) {
			try {
				await editor.getAction('editor.action.formatDocument')?.run();
			} catch {
				/* no formatter for this language */
			}
		}
		if (this._shown === path) {
			await this.explorer.save(path);
		}
	}

	private applySettings(): void {
		this._editor?.updateOptions(this.options());
		this.indent(this._editor?.getModel() ?? null, this._shown);
	}

	onRender(): void {
		void this.show();
	}

	/** The line a run crashed on gets a red marker and a "Crashed here" note, in the file on screen. */
	private markCrashes(): void {
		const editor = this._editor;
		const model = editor?.getModel();
		if (!editor || !model) {
			this._crashMarks?.clear();
			return;
		}
		const marks = this._runs.crashes().filter((c) => c.path === this._shown && c.line >= 1 && c.line <= model.getLineCount());
		const decorations = marks.map<Monaco.editor.IModelDeltaDecoration>((c) => ({
			range: { startLineNumber: c.line, startColumn: 1, endLineNumber: c.line, endColumn: model.getLineMaxColumn(c.line) },
			options: {
				isWholeLine: true,
				className: 'ms-crash-line',
				linesDecorationsClassName: 'ms-crash-gutter',
				// Program output decides the type's name: it is shown as text, cut short.
				after: { content: `Crashed here${c.type ? ` · ${c.type.slice(0, 60)}` : ''} · ${relativeTime(c.at)}`, inlineClassName: 'ms-crash-note' },
				hoverMessage: { value: c.summary.replace(/[\\`*_{}[\]()#+!<>|-]/g, '\\$&') },
			},
		}));
		if (this._crashMarks) {
			this._crashMarks.set(decorations);
		} else {
			this._crashMarks = editor.createDecorationsCollection(decorations);
		}
	}

	onDestroy(): void {
		this._gone = true;
		window.clearInterval(this._crashClock);
		this._crashMarks = null;
		if (this._shown && this._editor) {
			this.explorer.saveView(this._shown, this._editor.saveViewState());
		}
		// Models belong to the store and outlive the editor; only the view goes.
		this._editor?.setModel(null);
		this._editor?.dispose();
		this._editor = null;
		if (this.elementRef?.shadowRoot) {
			releaseMonacoStyles(this.elementRef.shadowRoot);
		}
	}

	private async mount(): Promise<void> {
		let monaco: Awaited<ReturnType<typeof loadMonaco>>;
		try {
			monaco = await loadMonaco();
		} catch (e) {
			this.store.fail(e);
			return;
		}
		const root = this.elementRef?.shadowRoot;
		if (this._gone || !root) {
			return;
		}
		await adoptMonacoStyles(root);
		const host = root.querySelector<HTMLElement>('.host');
		if (this._gone || !host) {
			return;
		}
		const editor = monaco.editor.create(host, {
			model: null,
			automaticLayout: true,
			padding: { top: 6 },
			scrollBeyondLastLine: false,
			smoothScrolling: true,
			fixedOverflowWidgets: true,
			...this.options(),
		});
		// Cmd/Ctrl + = / - / 0: the editor's text size alone (the window's zoom is the View menu's).
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Equal, () => this._settings.nudgeFont(1));
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Minus, () => this._settings.nudgeFont(-1));
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Digit0, () => this._settings.nudgeFont(0));
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void this.saveShown());
		this._editor = editor;
		this.ready = true;
		void this.show();
	}

	/** Point the editor at the active file, keeping each file's scroll position and selection. */
	private async show(): Promise<void> {
		const editor = this._editor;
		if (!editor) {
			return;
		}
		const tab = this.explorer.activeTab();
		const path = tab?.kind === 'text' ? tab.path : null;
		if (path === this._shown) {
			return;
		}
		if (this._shown) {
			this.explorer.saveView(this._shown, editor.saveViewState());
		}
		this._shown = path;
		const token = ++this._token;
		const model = path ? await this.explorer.model(path) : null;
		if (token !== this._token || this._gone) {
			return;
		}
		editor.setModel(model);
		this.indent(model, path);
		editor.updateOptions({ rulers: this.options().rulers });
		const view = path ? this.explorer.view(path) : null;
		if (view) {
			editor.restoreViewState(view);
		}
		this.markCrashes();
	}

	showChanges(path: string): void {
		this.store.setTab('changes');
		this.store.selectFile(path);
	}
}
