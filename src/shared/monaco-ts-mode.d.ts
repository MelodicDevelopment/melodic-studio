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
	export class DiagnosticsAdapter implements Monaco.IDisposable {
		constructor(libFiles: LibFiles, defaults: Monaco.typescript.LanguageServiceDefaults, selector: string, worker: Worker);
		dispose(): void;
	}
}
