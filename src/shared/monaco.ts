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

const THEME = 'repoman';
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

	applyMonacoTheme(monaco);
	new MutationObserver(() => applyMonacoTheme(monaco)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
	return monaco;
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
		'editorLineNumber.foreground': '--rm-diff-gutter-fg',
		'editorLineNumber.activeForeground': '--ml-color-text-secondary',
		'editor.lineHighlightBackground': '--rm-hover',
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

/** The app's monospace stack, resolved for Monaco (it measures glyphs, so it needs real names). */
export function monoFont(): string {
	return getComputedStyle(document.documentElement).getPropertyValue('--ml-font-mono').trim() || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
}
