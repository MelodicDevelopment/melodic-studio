/**
 * Monaco's TypeScript language features, which the package ships without types. Only what
 * `shared/monaco.ts` uses to register the built-in providers itself (so they can be switched off).
 * The constructor arguments are the ones Monaco's own `setupMode` passes in tsMode.js.
 */
declare module 'monaco-editor/languages/features/typescript/tsMode.js' {
	import type * as Monaco from 'monaco-editor';

	type Worker = (...uris: Monaco.Uri[]) => Promise<Monaco.typescript.TypeScriptWorker>;

	export class LibFiles {
		constructor(worker: Worker);
	}
	export class SuggestAdapter implements Monaco.languages.CompletionItemProvider {
		constructor(worker: Worker);
		readonly triggerCharacters: string[];
		provideCompletionItems(model: Monaco.editor.ITextModel, position: Monaco.Position, context: Monaco.languages.CompletionContext, token: Monaco.CancellationToken): Monaco.languages.ProviderResult<Monaco.languages.CompletionList>;
		resolveCompletionItem(item: Monaco.languages.CompletionItem, token: Monaco.CancellationToken): Monaco.languages.ProviderResult<Monaco.languages.CompletionItem>;
	}
	export class SignatureHelpAdapter implements Monaco.languages.SignatureHelpProvider {
		constructor(worker: Worker);
		signatureHelpTriggerCharacters: string[];
		provideSignatureHelp(model: Monaco.editor.ITextModel, position: Monaco.Position, token: Monaco.CancellationToken, context: Monaco.languages.SignatureHelpContext): Monaco.languages.ProviderResult<Monaco.languages.SignatureHelpResult>;
	}
	export class DocumentHighlightAdapter implements Monaco.languages.DocumentHighlightProvider {
		constructor(worker: Worker);
		provideDocumentHighlights(model: Monaco.editor.ITextModel, position: Monaco.Position, token: Monaco.CancellationToken): Monaco.languages.ProviderResult<Monaco.languages.DocumentHighlight[]>;
	}
	export class QuickInfoAdapter implements Monaco.languages.HoverProvider {
		constructor(worker: Worker);
		provideHover(model: Monaco.editor.ITextModel, position: Monaco.Position, token: Monaco.CancellationToken): Monaco.languages.ProviderResult<Monaco.languages.Hover>;
	}
	export class DefinitionAdapter implements Monaco.languages.DefinitionProvider {
		constructor(libFiles: LibFiles, worker: Worker);
		provideDefinition(model: Monaco.editor.ITextModel, position: Monaco.Position, token: Monaco.CancellationToken): Monaco.languages.ProviderResult<Monaco.languages.Definition>;
	}
	export class ReferenceAdapter implements Monaco.languages.ReferenceProvider {
		constructor(libFiles: LibFiles, worker: Worker);
		provideReferences(model: Monaco.editor.ITextModel, position: Monaco.Position, context: Monaco.languages.ReferenceContext, token: Monaco.CancellationToken): Monaco.languages.ProviderResult<Monaco.languages.Location[]>;
	}
	export class OutlineAdapter implements Monaco.languages.DocumentSymbolProvider {
		constructor(worker: Worker);
		provideDocumentSymbols(model: Monaco.editor.ITextModel, token: Monaco.CancellationToken): Monaco.languages.ProviderResult<Monaco.languages.DocumentSymbol[]>;
	}
	export class RenameAdapter implements Monaco.languages.RenameProvider {
		constructor(libFiles: LibFiles, worker: Worker);
		provideRenameEdits(model: Monaco.editor.ITextModel, position: Monaco.Position, newName: string, token: Monaco.CancellationToken): Monaco.languages.ProviderResult<Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection>;
	}
	export class FormatAdapter implements Monaco.languages.DocumentRangeFormattingEditProvider {
		constructor(worker: Worker);
		provideDocumentRangeFormattingEdits(model: Monaco.editor.ITextModel, range: Monaco.Range, options: Monaco.languages.FormattingOptions, token: Monaco.CancellationToken): Monaco.languages.ProviderResult<Monaco.languages.TextEdit[]>;
	}
	export class CodeActionAdaptor implements Monaco.languages.CodeActionProvider {
		constructor(worker: Worker);
		provideCodeActions(model: Monaco.editor.ITextModel, range: Monaco.Range, context: Monaco.languages.CodeActionContext, token: Monaco.CancellationToken): Monaco.languages.ProviderResult<Monaco.languages.CodeActionList>;
	}
	export class InlayHintsAdapter implements Monaco.languages.InlayHintsProvider {
		constructor(worker: Worker);
		provideInlayHints(model: Monaco.editor.ITextModel, range: Monaco.Range, token: Monaco.CancellationToken): Monaco.languages.ProviderResult<Monaco.languages.InlayHintList>;
	}
	export class DiagnosticsAdapter implements Monaco.IDisposable {
		constructor(libFiles: LibFiles, defaults: Monaco.typescript.LanguageServiceDefaults, selector: string, worker: Worker);
		dispose(): void;
	}
}
