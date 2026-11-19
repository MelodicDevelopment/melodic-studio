/**
 * Monaco (the editor from VS Code), loaded the first time a file is opened so
 * it costs nothing at startup. Also bridges two things Monaco does not know
 * about: the app theme, and the shadow root the editor is mounted in.
 */
import type * as Monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker';
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker';
import { getResolvedTheme } from '@melodicdev/components/theme';

export type MonacoApi = typeof Monaco;

const THEME = 'melodic-studio';
const STYLE_NODES = 'style, link[rel="stylesheet"]';

let _loading: Promise<MonacoApi> | null = null;
/** The <style>/<link> nodes Monaco put in <head>; shadow roots need their own copies. */
const _styles: Element[] = [];
const _roots = new Set<ShadowRoot>();

function createWorker(label: string): Worker {
	switch (label) {
		case 'json':
			return new JsonWorker();
		case 'css':
		case 'scss':
		case 'less':
			return new CssWorker();
		case 'html':
		case 'handlebars':
		case 'razor':
			return new HtmlWorker();
		case 'typescript':
		case 'javascript':
			return new TsWorker();
		default:
			return new EditorWorker();
	}
}

export function loadMonaco(): Promise<MonacoApi> {
	return (_loading ??= load());
}

async function load(): Promise<MonacoApi> {
	(self as unknown as { MonacoEnvironment: Monaco.Environment }).MonacoEnvironment = { getWorker: (_id, label) => createWorker(label) };

	const before = new Set(document.head.querySelectorAll(STYLE_NODES));
	const monaco = await import('monaco-editor');
	_styles.push(...[...document.head.querySelectorAll(STYLE_NODES)].filter((n) => !before.has(n)));
	// Anything Monaco adds later (or Vite re-injects in dev) follows into the open editors.
	new MutationObserver((records) => {
		for (const node of records.flatMap((r) => [...r.addedNodes])) {
			if (node instanceof Element && node.matches(STYLE_NODES)) {
				_styles.push(node);
				_roots.forEach((root) => root.appendChild(node.cloneNode(true)));
			}
		}
	}).observe(document.head, { childList: true });

	// One file at a time, with no project around it: imports cannot resolve, so only syntax is checked.
	const diagnostics = { noSemanticValidation: true, noSyntaxValidation: false };
	monaco.typescript.typescriptDefaults.setDiagnosticsOptions(diagnostics);
	monaco.typescript.javascriptDefaults.setDiagnosticsOptions(diagnostics);
	ownTypeScriptFeatures(monaco);

	applyMonacoTheme(monaco);
	new MutationObserver(() => applyMonacoTheme(monaco)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
	return monaco;
}

// ---- built-in TypeScript features, switchable --------------------------------------

/** The features a language server also provides; with both answering, every suggestion, hover and definition shows twice. */
const SWITCHED = {
	completionItems: false,
	signatureHelp: false,
	hovers: false,
	documentHighlights: false,
	definitions: false,
	references: false,
	documentSymbols: false,
	rename: false,
	documentRangeFormattingEdits: false,
	codeActions: false,
	inlayHints: false,
	diagnostics: false,
};

type Scripted = 'typescript' | 'javascript';

let _builtIn = true;
/** The languages a file has been opened in; Monaco has a worker for these. */
const _inUse = new Set<Scripted>();
/** Per language: undo the registrations made by `registerBuiltIn`. */
const _registered = new Map<string, Monaco.IDisposable[]>();
let _registerBuiltIn: ((language: Scripted) => Promise<void>) | null = null;
/** Stops Monaco's TypeScript and JavaScript workers; they start again by themselves when something asks them. */
let _stopWorkers: (() => void) | null = null;
/**
 * The built-in features are parked: no TypeScript or JavaScript file has been on screen for
 * `REST_AFTER_MS`, so the providers are taken down and the workers stopped until one is again.
 * Monaco never stops this worker by itself, and it holds about 160 MB (measured, docs/daily-driver.md step 5).
 */
let _resting = false;
const REST_AFTER_MS = 2 * 60_000;

function takeDownBuiltIn(): void {
	_registered.forEach((handles) => handles.forEach((handle) => handle.dispose()));
	_registered.clear();
	// After the providers: one of them asking the worker something would start it again.
	_stopWorkers?.();
}

/**
 * Monaco registers its TypeScript and JavaScript providers once, when the first such file is opened,
 * and `setModeConfiguration` after that changes nothing. So the switchable ones are taken out of its
 * hands here, before any file is open, and registered by us instead (they are Monaco's own classes),
 * which leaves us holding the handles to turn them off and on.
 */
function ownTypeScriptFeatures(monaco: MonacoApi): void {
	const sides = {
		typescript: { defaults: monaco.typescript.typescriptDefaults, worker: monaco.typescript.getTypeScriptWorker },
		javascript: { defaults: monaco.typescript.javascriptDefaults, worker: monaco.typescript.getJavaScriptWorker },
	};
	_registerBuiltIn = async (language) => {
		const { defaults, worker: getWorker } = sides[language];
		const mode = await import('monaco-editor/languages/features/typescript/tsMode.js');
		if (!_builtIn || _resting || _registered.has(language)) {
			return;
		}
		// The worker exists a moment after the language is first used; ask again until it does.
		const worker = async (...uris: Monaco.Uri[]): Promise<Monaco.typescript.TypeScriptWorker> => {
			for (let tries = 0; ; tries++) {
				try {
					return await (await getWorker())(...uris);
				} catch (e) {
					if (tries >= 40) {
						throw e;
					}
					await new Promise((done) => setTimeout(done, 50));
				}
			}
		};
		const libFiles = new mode.LibFiles(worker);
		_registered.set(language, [
			monaco.languages.registerCompletionItemProvider(language, new mode.SuggestAdapter(worker)),
			monaco.languages.registerSignatureHelpProvider(language, new mode.SignatureHelpAdapter(worker)),
			monaco.languages.registerHoverProvider(language, new mode.QuickInfoAdapter(worker)),
			monaco.languages.registerDocumentHighlightProvider(language, new mode.DocumentHighlightAdapter(worker)),
			monaco.languages.registerDefinitionProvider(language, new mode.DefinitionAdapter(libFiles, worker)),
			monaco.languages.registerReferenceProvider(language, new mode.ReferenceAdapter(libFiles, worker)),
			monaco.languages.registerDocumentSymbolProvider(language, new mode.OutlineAdapter(worker)),
			monaco.languages.registerRenameProvider(language, new mode.RenameAdapter(libFiles, worker)),
			monaco.languages.registerDocumentRangeFormattingEditProvider(language, new mode.FormatAdapter(worker)),
			monaco.languages.registerCodeActionProvider(language, new mode.CodeActionAdaptor(worker)),
			monaco.languages.registerInlayHintsProvider(language, new mode.InlayHintsAdapter(worker)),
			new mode.DiagnosticsAdapter(libFiles, defaults, language, worker),
		]);
	};
	// A check that was under way when the built-in diagnostics were switched off still writes its result
	// when it comes back (Monaco's adapter does not look whether it was disposed in the meantime), and
	// nothing would ever take that down again: the same error would stay beside the server's, fixed or not.
	monaco.editor.onDidChangeMarkers((uris) => {
		if (_builtIn) {
			return;
		}
		for (const uri of uris) {
			const model = monaco.editor.getModel(uri);
			for (const owner of ['typescript', 'javascript']) {
				if (model && monaco.editor.getModelMarkers({ resource: uri, owner }).length) {
					monaco.editor.setModelMarkers(model, owner, []);
				}
			}
		}
	});
	// Monaco's worker manager stops its worker whenever the language's settings change, which is the
	// only way in from outside: setting the compiler options to what they are does that and nothing else.
	_stopWorkers = () => Object.values(sides).forEach(({ defaults }) => defaults.setCompilerOptions(defaults.getCompilerOptions()));
	const scripted = (): boolean =>
		monaco.editor.getEditors().some((editor) => {
			const language = editor.getModel()?.getLanguageId();
			return language === 'typescript' || language === 'javascript';
		});
	let lastSeen = Date.now();
	const look = (): void => {
		if (scripted()) {
			lastSeen = Date.now();
			if (_resting) {
				_resting = false;
				if (_builtIn) {
					_inUse.forEach((language) => void _registerBuiltIn?.(language));
				}
			}
		} else if (!_resting && Date.now() - lastSeen > REST_AFTER_MS) {
			_resting = true;
			takeDownBuiltIn();
		}
	};
	// Back at once when such a file is shown; the timer only notices that none has been for a while.
	monaco.editor.onDidCreateEditor((editor) => editor.onDidChangeModel(() => queueMicrotask(look)));
	window.setInterval(look, 20_000);
	for (const language of ['typescript', 'javascript'] as const) {
		const { defaults } = sides[language];
		defaults.setModeConfiguration({ ...defaults.modeConfiguration, ...SWITCHED });
		// Not before the language is in use: Monaco starts its worker then, and our providers need it.
		monaco.languages.onLanguage(language, () => {
			_inUse.add(language);
			void _registerBuiltIn?.(language);
		});
	}
}

/**
 * Turn Monaco's own TypeScript/JavaScript features on or off (everything in `SWITCHED`: completion,
 * signature help, hover, highlights, definition, references, outline, rename, formatting, quick
 * fixes, inlay hints and diagnostics). Off while a TypeScript language server answers for the
 * checkout on screen; on otherwise. Only typing-time formatting stays Monaco's either way.
 */
export function setBuiltInTypeScript(on: boolean): void {
	if (on === _builtIn) {
		return;
	}
	_builtIn = on;
	if (!on) {
		// A language server answers from here on. The worker that answered until it came up is not needed again.
		takeDownBuiltIn();
		return;
	}
	// A language not in use yet is registered when its first file opens.
	_inUse.forEach((language) => void _registerBuiltIn?.(language));
}

/**
 * Monaco's CSS lands in <head>, which does not reach into a shadow root. Copy
 * it in, and resolve once the copies have loaded so the editor never paints unstyled.
 */
export async function adoptMonacoStyles(root: ShadowRoot): Promise<void> {
	if (_roots.has(root)) {
		return;
	}
	_roots.add(root);
	const pending: Promise<void>[] = [];
	for (const node of _styles) {
		const copy = node.cloneNode(true) as Element;
		if (copy instanceof HTMLLinkElement) {
			pending.push(
				new Promise((done) => {
					copy.addEventListener('load', () => done());
					copy.addEventListener('error', () => done());
				})
			);
		}
		root.appendChild(copy);
	}
	await Promise.all(pending);
}

export function releaseMonacoStyles(root: ShadowRoot): void {
	_roots.delete(root);
}

// ---- theme ------------------------------------------------------------------

let _ctx: CanvasRenderingContext2D | null = null;

/** A theme token as the `#rrggbb[aa]` Monaco wants, whatever notation the CSS used. */
function token(name: string): string | null {
	const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	_ctx ??= document.createElement('canvas').getContext('2d');
	if (!value || !_ctx) {
		return null;
	}
	_ctx.fillStyle = '#000000';
	_ctx.fillStyle = value;
	const out = String(_ctx.fillStyle);
	if (out.startsWith('#')) {
		return out;
	}
	const m = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(out);
	if (!m) {
		return null;
	}
	const hex = (n: number): string => Math.round(n).toString(16).padStart(2, '0');
	return `#${hex(+m[1])}${hex(+m[2])}${hex(+m[3])}${m[4] === undefined ? '' : hex(+m[4] * 255)}`;
}

/** The editor wears the app's surface, borders and accents; syntax colours stay VS Code's. */
function applyMonacoTheme(monaco: MonacoApi): void {
	const wanted: Record<string, string> = {
		'editor.background': '--ml-color-surface',
		'editorGutter.background': '--ml-color-surface',
		'minimap.background': '--ml-color-surface',
		'editorStickyScroll.background': '--ml-color-surface',
		'editor.foreground': '--ml-color-text',
		'editorLineNumber.foreground': '--ms-diff-gutter-fg',
		'editorLineNumber.activeForeground': '--ml-color-text-secondary',
		'editor.lineHighlightBackground': '--ms-hover',
		'editorCursor.foreground': '--ml-color-primary',
		'editorWidget.background': '--ml-color-surface-raised',
		'editorWidget.border': '--ml-color-border',
		'editorHoverWidget.background': '--ml-color-surface-raised',
		'editorHoverWidget.border': '--ml-color-border',
		'editorSuggestWidget.background': '--ml-color-surface-raised',
		'editorSuggestWidget.border': '--ml-color-border',
		'menu.background': '--ml-color-surface-raised',
		'menu.border': '--ml-color-border',
		'input.background': '--ml-color-input-bg',
		'input.border': '--ml-color-border',
		focusBorder: '--ml-color-primary',
		'scrollbarSlider.background': '--ml-color-border-strong',
	};
	const colors: Record<string, string> = { 'editor.lineHighlightBorder': '#00000000', 'scrollbar.shadow': '#00000000' };
	for (const [key, name] of Object.entries(wanted)) {
		const value = token(name);
		if (value) {
			colors[key] = value;
		}
	}
	// Syntax colours follow the surface actually on screen, whichever way the theme got set.
	const surface = /^#(..)(..)(..)/.exec(colors['editor.background'] ?? '');
	const dark = surface ? 0.299 * parseInt(surface[1], 16) + 0.587 * parseInt(surface[2], 16) + 0.114 * parseInt(surface[3], 16) < 128 : getResolvedTheme() === 'dark';
	monaco.editor.defineTheme(THEME, { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors });
	monaco.editor.setTheme(THEME);
}
