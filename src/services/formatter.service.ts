/**
 * Formatting with the project's own formatter (step 8 of docs/daily-driver.md).
 *
 * A file whose project brings Prettier (its own `node_modules`, and a Prettier config that
 * applies to the file: src-tauri/src/format.rs decides) is formatted by it, both for Format
 * Document and for format on save. Everything else is formatted as before: by its language
 * server, else by the editor. Nothing is installed and nothing global is used.
 *
 * Monaco formats with one provider: the best match for the file, and among equal matches the
 * one registered last. So each such file gets a provider of its own, by its exact path (which
 * matches as well as a language does), and it is registered again whenever the file is shown
 * or about to be formatted, so that it is the last one. A file the project's formatter turns
 * out not to know (a `.rs` in a project with Prettier) is handed on to its language server.
 */
import type * as Monaco from 'monaco-editor';
import { Injectable, Injector } from '@melodicdev/core/injection';
import { effect } from '@melodicdev/core/signals';
import { ToastService } from '@melodicdev/components/toast';
import { BackendService, type FormatTool } from './backend.service';
import { RepoStore } from './repo.store';
import { LspService } from './lsp.service';
import { loadMonaco, type MonacoApi } from '../shared/monaco';
import { fileName, relativeTo } from '../shared/paths';

/** The same complaint about the same file is not said again within this long (format on save would repeat it at every save). */
const SAME_COMPLAINT_MS = 30_000;

@Injectable()
export class FormatterService {
	private _monaco: MonacoApi | null = null;
	private _attached: Promise<void> | null = null;
	/** The files that format with their project's formatter, by address, with the provider that makes them. */
	private readonly _with = new Map<string, { tool: FormatTool; registration: Monaco.IDisposable }>();
	/** Looks under way, so two of them for one file do not both register. */
	private readonly _looking = new Map<string, Promise<void>>();
	private _said: { what: string; at: number } | null = null;

	constructor() {
		effect(() => {
			if (this.repos.tab() === 'files') {
				void this.attach();
			}
		});
	}

	private get backend(): BackendService {
		return Injector.get(BackendService);
	}
	private get repos(): RepoStore {
		return Injector.get(RepoStore);
	}

	private attach(): Promise<void> {
		return (this._attached ??= this.wire());
	}

	private async wire(): Promise<void> {
		const monaco = (this._monaco = await loadMonaco());
		monaco.editor.onDidCreateModel((model) => {
			void this.look(model);
			// A language's own formatter can register a moment after its first file opens: look again once it has.
			setTimeout(() => void this.look(model), 2000);
		});
		monaco.editor.onWillDisposeModel((model) => this.forget(model.uri.toString()));
		const shown = (editor: Monaco.editor.ICodeEditor): void => {
			const model = editor.getModel();
			if (model) {
				void this.look(model);
			}
		};
		monaco.editor.onDidCreateEditor((editor) => editor.onDidChangeModel(() => shown(editor)));
		monaco.editor.getEditors().forEach((editor) => editor.onDidChangeModel(() => shown(editor)));
		// A project gains its formatter with an `npm install`, and can lose it again.
		window.addEventListener('focus', () => monaco.editor.getModels().forEach((model) => void this.look(model)));
		monaco.editor.getModels().forEach((model) => void this.look(model));
	}

	/** Where a model's file is: the checkout on screen and its path in it. Null for anything else. */
	private where(model: Monaco.editor.ITextModel): { id: string; root: string; path: string } | null {
		const repo = this.repos.repo();
		if (!repo || model.uri.scheme !== 'file') {
			return null;
		}
		const root = repo.worktree ?? repo.path;
		const path = relativeTo(root, model.uri.fsPath);
		return path ? { id: repo.id, root, path } : null;
	}

	private forget(key: string): void {
		this._with.get(key)?.registration.dispose();
		this._with.delete(key);
	}

	/**
	 * See whether the file's project brings a formatter, and if it does, make that the file's
	 * formatter: registered now, so after whatever else formats its language.
	 */
	private look(model: Monaco.editor.ITextModel): Promise<void> {
		const key = model.uri.toString();
		const running = this._looking.get(key);
		if (running) {
			return running;
		}
		const look = (async () => {
			const monaco = this._monaco;
			const at = this.where(model);
			const tool = monaco && at ? await this.backend.formatTool(at.id, at.path).catch(() => null) : null;
			this.forget(key);
			if (!monaco || !tool || model.isDisposed()) {
				return;
			}
			const registration = monaco.languages.registerDocumentFormattingEditProvider(
				{ scheme: 'file', pattern: model.uri.fsPath },
				{ displayName: tool.name, provideDocumentFormattingEdits: (m, options, token) => this.format(m, options, token) }
			);
			this._with.set(key, { tool, registration });
		})().finally(() => this._looking.delete(key));
		this._looking.set(key, look);
		return look;
	}

	/**
	 * Called right before a file is formatted on save: its project's formatter, if it has one, is
	 * the one that formats it. Resolves to the formatter's name, or null when the project has none.
	 */
	async ready(model: Monaco.editor.ITextModel): Promise<string | null> {
		await this.attach();
		await this.look(model);
		return this._with.get(model.uri.toString())?.tool.name ?? null;
	}

	/** The formatter a file's project brings, by name ("Prettier"), if it is known to bring one. */
	toolFor(model: Monaco.editor.ITextModel | null): string | null {
		return (model && this._with.get(model.uri.toString())?.tool.name) ?? null;
	}

	/** The whole file as the project's formatter writes it; what it does not know goes to the language server. */
	private async format(model: Monaco.editor.ITextModel, options: Monaco.languages.FormattingOptions, token: Monaco.CancellationToken): Promise<Monaco.languages.TextEdit[]> {
		const at = this.where(model);
		const tool = this._with.get(model.uri.toString())?.tool.name ?? 'The formatter';
		if (!at) {
			return [];
		}
		const text = model.getValue();
		let formatted: string | null;
		try {
			formatted = await this.backend.formatFile(at.id, at.root, at.path, text);
		} catch (e) {
			// A syntax error, a broken config: said in the formatter's words, and nothing else formats in its place.
			this.complain(`${tool} could not format ${fileName(at.path)}`, e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e));
			return [];
		}
		if (token.isCancellationRequested || model.isDisposed() || model.getValue() !== text) {
			return []; // typed in meanwhile: the answer is for text that is gone
		}
		if (formatted === null) {
			return Injector.get(LspService).format(model, options, token);
		}
		// One edit of the whole text; the editor reduces it to what really differs, so the cursor stays put.
		return formatted === text ? [] : [{ range: model.getFullModelRange(), text: formatted }];
	}

	private complain(title: string, message: string): void {
		const what = `${title}\n${message}`;
		if (this._said?.what === what && Date.now() - this._said.at < SAME_COMPLAINT_MS) {
			return;
		}
		this._said = { what, at: Date.now() };
		Injector.get(ToastService).warning(title, message);
	}
}
